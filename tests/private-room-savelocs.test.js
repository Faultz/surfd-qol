import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomId} from '../src/private-rooms/ids.js';
import {CLOSE, createRoomFilter, decodeControl} from '../src/private-rooms/protocol.js';
import {sanitizeSaveloc} from '../src/private-rooms/saveloc-validation.js';
import {createSharedSavelocs} from '../src/private-rooms/shared-savelocs.js';

const spawn = {position: {x: 0, y: 0, z: 32}, yaw: 0, pitch: 0};
const start = {id: 'start', kind: 'start', min: {x: -64, y: -64, z: 0}, max: {x: 64, y: 64, z: 128}};
const map = {id: 'one', version: 'bsp-test-v1', spawn, zones: [start, {id: 'cp1', kind: 'checkpoint', order: 1}],
  stages: [{spawn, start}, {spawn: {...spawn, position: {x: 100, y: 0, z: 32}}, start: {...start, id: 'stage2'}}],
  teleportZones: [{velocity: 'stage', stage: 2}, {velocity: 'stage', stage: 1}],
  playerOutputZones: [{id: 'output', onStart: [{property: 'targetname', value: 'allowed'},
    {property: 'velocity', value: {x: 100, y: 0, z: 0}}], onEnd: []}]};
// Pending outputs with long accented names: about 430 UTF-8 bytes each.
const outputs = count => ({contacts: [], accepted: [], targetname: '',
  pending: Array.from({length: count}, (_, index) => ({tick: 100 + index, targetname: 'é'.repeat(200)}))});
function snapshot() {
  return {key: JSON.stringify([map.id, map.version, JSON.stringify({dt: 0.015, gravity: 800}), 8]),
    state: {position: {x: 20, y: 30, z: 40}, velocity: {x: 1000, y: 20, z: -30}, grounded: false,
      groundId: null, ducked: false, duckFraction: 0, eyeHeight: 64, jumpHeld: false, surfaceFriction: 1,
      yaw: 90, pitch: -30, tick: 100, stage: 1},
    timer: {state: {phase: 'running', startTick: 10.5, endTick: null, splits: [], invalidReason: null, elapsed: 1.3425},
      armed: true, prehops: 0}, checkpointSpeeds: [], startPosition: null,
    startJumps: 0, startGroundTime: 0, startHopWarned: false, startRegion: '', rawJumpHeld: false, stageStartRecovery: false};
}
class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  closed = null;
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(data)})); }
  close(code, reason) { this.closed = {code, reason}; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  messages(type) { return this.sent.filter(message => message.type === type); }
}
function fixture(options = {}) {
  let time = 0;
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maps: [{id: 'one'}, {id: 'two'}],
    now: () => time, getMap: () => ({...map, id: room.state.mapId}), ...options});
  const connect = (host = false, browserId = crypto.randomUUID(), name = 'Surfer') => {
    const socket = new Socket();
    room.addClient(socket, {guest: false, browserId, name}, {host});
    return socket;
  };
  const save = (socket, value = snapshot(), context = {}) => socket.receive({type: 'saveloc-save',
    mapId: room.state.mapId, epoch: room.state.epoch, snapshot: value, ...context});
  const remove = (socket, id, context = {}) => socket.receive({type: 'saveloc-delete', mapId: room.state.mapId,
    epoch: room.state.epoch, id, ...context});
  return {room, connect, save, remove, advance: (ms = 1000) => { time += ms; }};
}

describe('shared saveloc authority', () => {
  test('shares canonical native captures and stable private ownership, retaining departed saves for late joins', () => {
    const {room, connect, save} = fixture();
    try {
      const browserId = crypto.randomUUID(), owner = connect(false, browserId, 'Owner'), peer = connect();
      const ownerId = owner.messages('saveloc-init')[0].ownerId;
      expect(ownerId).not.toBe(browserId);
      save(owner);
      const entry = peer.messages('saveloc-add')[0].entry;
      expect(entry).toEqual({id: 1, ownerId, name: 'Owner', snapshot: snapshot()});
      expect(owner.messages('saveloc-add')[0].entry).toEqual(entry);
      owner.close(1000, 'Left');
      const late = connect();
      expect(late.sent.map(message => message.type)).toEqual(['welcome', 'saveloc-init', 'saveloc-add', 'paint-init']);
      expect(late.messages('saveloc-init')[0].count).toBe(1);
      expect(late.messages('saveloc-add')[0].entry).toEqual(entry);
      expect(connect(false, browserId).messages('saveloc-init')[0].ownerId).toBe(ownerId);
      expect(JSON.stringify(peer.sent)).not.toContain(browserId);
    } finally { room.close(); }
  });

  test('keeps the newest twenty per owner and broadcasts eviction before replacement', () => {
    const {room, connect, save, advance} = fixture();
    try {
      const owner = connect(), other = connect();
      save(other);
      for (let index = 0; index < 21; index++) { save(owner); advance(); }
      const late = connect();
      expect(late.messages('saveloc-add').map(message => message.entry.id)).toEqual([1, ...Array.from({length: 20}, (_, i) => i + 3)]);
      const eviction = owner.sent.findIndex(message => message.type === 'saveloc-remove');
      expect(owner.sent[eviction]).toMatchObject({id: 2});
      expect(owner.sent[eviction + 1]).toMatchObject({type: 'saveloc-add', entry: {id: 22}});
    } finally { room.close(); }
  });

  test('allows only owner deletion including rejoin; ignores stale and remote delete claims', () => {
    const {room, connect, save, remove} = fixture();
    try {
      const browserId = crypto.randomUUID(), owner = connect(false, browserId), peer = connect();
      save(owner);
      remove(peer, 1);
      remove(owner, 1, {epoch: 99});
      remove(owner, 1, {mapId: 'two'});
      expect(peer.messages('saveloc-remove')).toEqual([]);
      owner.close(1000, 'Left');
      remove(connect(false, browserId), 1);
      expect(peer.messages('saveloc-remove')).toEqual([{type: 'saveloc-remove', mapId: 'one', epoch: 1, id: 1}]);
      expect(connect().messages('saveloc-add')).toEqual([]);
    } finally { room.close(); }
  });

  test('clears map entries after state and keeps globally monotonic IDs', () => {
    const {room, connect, save} = fixture();
    try {
      const host = connect(true), peer = connect();
      save(peer);
      host.receive({type: 'change-map', mapId: 'two'});
      const stateAt = peer.sent.findIndex(message => message.type === 'state');
      expect(peer.sent[stateAt + 1]).toMatchObject({type: 'saveloc-init', mapId: 'two', epoch: 2, count: 0});
      save(peer, snapshot(), {mapId: 'one', epoch: 1});
      expect(peer.messages('saveloc-add')).toHaveLength(1);
      const next = snapshot(); next.key = JSON.stringify(['two', map.version, JSON.stringify({dt: 0.015}), 8]);
      save(peer, next);
      expect(peer.messages('saveloc-add').at(-1)).toMatchObject({mapId: 'two', epoch: 2, entry: {id: 2}});
      expect(connect().messages('saveloc-add').map(message => message.entry.id)).toEqual([2]);
    } finally { room.close(); }
  });

  test('a late joiner applies 200 retained saves through its filter with one redraw', () => {
    const {room, connect, save, advance} = fixture();
    try {
      const owners = Array.from({length: 10}, () => connect());
      for (let round = 0; round < 20; round++) {
        for (const socket of owners) save(socket);
        advance();
      }
      const late = connect(), filter = createRoomFilter({roomId: room.state.roomId, maps: [{id: 'one'}, {id: 'two'}]});
      let redraws = 0, handlers = null;
      const controller = createSharedSavelocs({send() {}, invalid() { throw new Error('Invalid room data'); },
        practice: {shared(value) { handlers = value; return () => {}; }, refresh() { redraws++; },
          destination: () => ({map, mapId: map.id, mapVersion: map.version})}});
      for (const frame of late.sent) {
        const message = filter(frame);
        if (message?.type === 'welcome') controller.state(message.state);
        else if (message?.type.startsWith('saveloc-')) controller.receive(message);
      }
      expect(late.messages('saveloc-add')).toHaveLength(200);
      expect(handlers.entries({map})).toHaveLength(200);
      expect(redraws).toBe(1);
      controller.close();
    } finally { room.close(); }
  });

  test('allows a burst of three and one per second, sharing rate budgets across connections and rejoin', () => {
    const {room, connect, save, advance} = fixture();
    try {
      const browserId = crypto.randomUUID(), owner = connect(false, browserId), second = connect(false, browserId);
      for (let index = 0; index < 4; index++) save(owner);
      save(second);
      expect(second.messages('saveloc-add')).toHaveLength(3);
      owner.close(1000, 'Left');
      const rejoined = connect(false, browserId);
      save(rejoined); advance(999); save(rejoined);
      expect(second.messages('saveloc-add')).toHaveLength(3);
      advance(1); save(rejoined);
      expect(second.messages('saveloc-add')).toHaveLength(4);
    } finally { room.close(); }
  });

  test('does not authorize saves without the full loaded map', () => {
    for (const getMap of [() => null, () => ({...map, id: 'two'})]) {
      const {room, connect, save} = fixture({getMap});
      try { const peer = connect(); save(peer); expect(peer.messages('saveloc-add')).toEqual([]); }
      finally { room.close(); }
    }
  });

  test('closes on malformed save claims without forwarding them', () => {
    for (const mutate of [value => { value.key = JSON.stringify(['one', map.version, '{}', 8]); },
      value => { value.state.position.x = 1e100; }, value => { value.timer.state.phase = 'finished'; },
      value => { value.state.injected = {payload: true}; }, value => { value.state.mapOutputState = outputs(100); }]) {
      const {room, connect, save} = fixture();
      try {
        const peer = connect(), observer = connect(), value = snapshot(); mutate(value); save(peer, value);
        expect(peer.closed?.code).toBe(CLOSE.invalid);
        expect(observer.messages('saveloc-add')).toEqual([]);
      } finally { room.close(); }
    }
  });

  test('drops claims the loaded map refutes, such as another map version, without closing', () => {
    for (const mutate of [value => { value.state.pendingStageTeleport = 999; }, value => { value.state.stage = 3; },
      value => { value.key = JSON.stringify(['one', 'bsp-test-v2', JSON.stringify({dt: 0.015}), 8]); },
      value => { value.startRegion = '1:missing'; }]) {
      const {room, connect, save} = fixture();
      try {
        const peer = connect(), observer = connect(), value = snapshot(); mutate(value); save(peer, value);
        expect(peer.closed).toBe(null);
        expect(observer.messages('saveloc-add')).toEqual([]);
        save(peer);
        expect(observer.messages('saveloc-add').map(message => message.entry.id)).toEqual([1]);
      } finally { room.close(); }
    }
  });

  test('a full room replaces the oldest save of a player who left, never a present one', () => {
    const {room, connect, save, advance} = fixture({maxPlayers: 64});
    try {
      const host = connect(true), departed = connect();
      save(host);
      for (let round = 0; round < 20; round++) { save(departed); advance(); }
      departed.close(1000, 'Left');
      const players = [host, ...Array.from({length: 62}, () => connect())];
      for (let round = 0; round < 20; round++) {
        for (const socket of players) if (socket !== host || round) save(socket);
        advance();
      }
      expect(host.messages('saveloc-add')).toHaveLength(1280);
      expect(host.messages('saveloc-remove')).toEqual([]);
      const newest = connect();
      save(newest);
      expect(host.messages('saveloc-remove')).toEqual([{type: 'saveloc-remove', mapId: 'one', epoch: 1, id: 2}]);
      expect(host.messages('saveloc-add').at(-1).entry.id).toBe(1281);
      newest.close(1000, 'Left');
      expect(connect().messages('saveloc-add')).toHaveLength(1280);
    } finally { room.close(); }
  });
});

describe('native shared snapshot safety', () => {
  test('preserves native fields and safe optional physics and stage transitions without retaining input references', () => {
    const value = snapshot();
    value.state.pendingStageTeleport = 2;
    value.state.baseVelocity = {x: 1, y: 2, z: 0};
    value.state.pendingMapPush = {x: 5, y: 6, z: 7};
    value.state.mapGroundCheck = 'teleport';
    value.state.lastMapTeleportTick = 99;
    value.state.mapOutputState = {contacts: ['output'], accepted: ['output'], targetname: 'allowed',
      pending: [{tick: 110, targetname: ''}], pendingVelocity: [{tick: 111, value: {x: 100, y: 0, z: 0}}]};
    value.startPosition = structuredClone(spawn);
    value.startRegion = '1:start';
    value.timer.state.splits = [0.5];
    value.checkpointSpeeds = [1000];
    const result = sanitizeSaveloc(value, map);
    expect(result).toEqual(value);
    value.state.position.x = 999;
    expect(result.state.position.x).toBe(20);
    value.state.stage = 2; value.state.pendingStageTeleport = 1;
    expect(sanitizeSaveloc(value, map).state.pendingStageTeleport).toBe(1);
  });

  test('caps a snapshot at 32,768 UTF-8 bytes, under one control frame', () => {
    const value = snapshot();
    value.state.mapOutputState = outputs(60);
    expect(() => sanitizeSaveloc(value)).not.toThrow();
    value.state.mapOutputState = outputs(100);
    expect(JSON.stringify(value).length).toBeLessThan(32768);
    expect(() => sanitizeSaveloc(value)).toThrow();
  });

  test('accepts native ready and unstaged snapshots', () => {
    const value = snapshot();
    delete value.state.stage;
    value.state.tick = 0;
    value.timer.state = {phase: 'ready', startTick: null, endTick: null, splits: [], invalidReason: 'Practice mode', elapsed: 0};
    expect(sanitizeSaveloc(value, {...map, stages: undefined})).toEqual(value);
  });

  test('rejects unknown, malformed, nonfinite, oversized and map-inconsistent fields', () => {
    const attacks = [
      value => { value.extra = true; }, value => { value.state.position.extra = true; },
      value => { value.state.position.x = NaN; }, value => { value.state.velocity.z = Infinity; },
      value => { value.state.duckFraction = 2; }, value => { value.state.eyeHeight = -1; },
      value => { value.state.tick = 1.5; }, value => { value.state.groundId = {}; },
      value => { value.state.stage = 3; }, value => { value.state.pendingStageTeleport = 0; },
      value => { value.timer.state.startTick = 101; }, value => { value.timer.state.splits = [0.5, 0.6]; },
      value => { value.timer.state.splits = [-1]; }, value => { value.timer.state.endTick = 10; },
      value => { value.timer.state.phase = 'finished'; }, value => { value.timer.state.invalidReason = 'x'.repeat(257); },
      value => { value.timer.armed = 1; }, value => { value.startPosition = {position: spawn.position, yaw: 0}; },
      value => { value.startRegion = '1:missing'; }, value => { value.checkpointSpeeds = [1, 2]; },
      value => { value.state.mapGroundCheck = 'unknown'; }, value => { value.state.mapOutputState = {contacts: [], accepted: [], targetname: 'forged'}; },
      value => { value.key = JSON.stringify(['two', map.version, '{"dt":0.015}', 8]); },
      value => { value.key = JSON.stringify(['one', 'wrong', '{"dt":0.015}', 8]); },
      value => { value.key = 'x'.repeat(8193); }, value => { value.timer.state.splits = Array(1025).fill(0); },
    ];
    for (const mutate of attacks) { const value = snapshot(); mutate(value); expect(() => sanitizeSaveloc(value, map)).toThrow(); }
    const value = snapshot(); value.state.pendingStageTeleport = 2;
    expect(() => sanitizeSaveloc(value, {...map, teleportZones: []})).toThrow();
  });

  test('the guest filter strips extra fields from saveloc messages and rejects hostile host snapshots', () => {
    const {room, connect} = fixture();
    try {
      const peer = connect(), filter = createRoomFilter({roomId: room.state.roomId, maps: [{id: 'one'}, {id: 'two'}]});
      filter(peer.messages('welcome')[0]);
      const init = peer.messages('saveloc-init')[0];
      expect(filter({...init, browserId: 'hidden'})).toEqual(init);
      const message = {type: 'saveloc-add', mapId: 'one', epoch: 1,
        entry: {id: 1, ownerId: init.ownerId, name: 'Surfer', snapshot: snapshot()}};
      expect(filter({...message, injected: true, entry: {...message.entry, browserId: 'hidden'}})).toEqual(message);
      expect(filter({...message, epoch: 2})).toBeNull();
      expect(filter({...message, mapId: 'two'})).toBeNull();
      for (const patch of [{id: 0}, {id: Number.MAX_SAFE_INTEGER + 1}, {ownerId: 'forged'}, {name: '<img>'}])
        expect(() => filter({...message, entry: {...message.entry, ...patch}})).toThrow();
      for (const mutate of [value => { value.state.position.x = Infinity; }, value => { value.timer.state.phase = 'finished'; },
        value => { value.startPosition = {position: spawn.position, yaw: 0, pitch: 0, injected: true}; },
        value => { value.state.constructor = {prototype: {}}; }, value => { value.state.pendingStageTeleport = 1025; }]) {
        const value = snapshot(); mutate(value);
        expect(() => filter({...message, entry: {...message.entry, snapshot: value}})).toThrow();
      }
      const decoded = decodeControl(JSON.stringify({type: 'saveloc-save', mapId: 'one', epoch: 1, snapshot: snapshot(), ownerId: 'spoof'}));
      expect(decoded).toEqual({type: 'saveloc-save', mapId: 'one', epoch: 1, snapshot: snapshot()});
    } finally { room.close(); }
  });
});

test('bonus movement state is shared when the loaded course can produce it', () => {
  const course = {...map, ladderBrushIds: ['ladder'], waterZones: [{hulls: []}], pushZones: [{id: 'push'}],
    playerOutputZones: [{id: 'output', onStart: [{property: 'gravity', value: 0.5, delay: 1}], onEnd: [],
      onTouch: [{property: 'laggedMovement', value: 0.25, suppressJump: true}, {property: 'targetname', value: 'touched'}]}]};
  const value = snapshot();
  Object.assign(value.state, {gravityScale: Math.fround(0.5), laggedMovement: Math.fround(0.25), jumpDisabled: true,
    acceptedPushes: ['push'], ladderNormal: {x: 0, y: -1, z: 0}, waterJumpTime: 1985, waterJumpVelocity: {x: 50, y: 0, z: 0},
    mapOutputState: {contacts: ['output'], accepted: ['output'], targetname: 'touched', pendingGravity: [{tick: 120, value: 0.5}]}});
  expect(sanitizeSaveloc(value, course)).toEqual(value);
  for (const [field, wrong] of [['gravityScale', 2], ['laggedMovement', 0.5], ['acceptedPushes', ['other']], ['jumpDisabled', false]]) {
    expect(() => sanitizeSaveloc({...value, state: {...value.state, [field]: wrong}}, course)).toThrow('Invalid shared saveloc');
  }
  expect(() => sanitizeSaveloc(value, map)).toThrow('Invalid shared saveloc');
});
