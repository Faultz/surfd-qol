import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomId} from '../src/private-rooms/ids.js';
import {createRoomFilter, decodeControl} from '../src/private-rooms/protocol.js';
import {MAX_OWNER_PAINT, MAX_ROOM_PAINT, acceptedPaint, createRoomPaint, erasePaint} from '../src/private-rooms/room-paint.js';

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(data)})); }
  close(code, reason) { this.closed = {code, reason}; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  messages(type) { return this.sent.filter(message => message.type === type); }
}
const dot = (x, extra = []) => [x, 0, 0, 0, 0, 1, 4, 0xff0000, ...extra];
function fixture() {
  let time = 0;
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maps: [{id: 'one'}, {id: 'two'}], now: () => time});
  const connect = (host = false, browserId = crypto.randomUUID(), name = 'Surfer') => {
    const socket = new Socket();
    room.addClient(socket, {guest: false, browserId, name}, {host});
    return socket;
  };
  const paint = (socket, dots, context = {}) => socket.receive({type: 'paint-add', mapId: room.state.mapId, epoch: room.state.epoch, dots, ...context});
  return {room, connect, paint, advance: (ms = 1000) => { time += ms; }};
}

describe('room paint authority', () => {
  test('shares each stroke with everyone and syncs late joiners', () => {
    const {room, connect, paint} = fixture();
    try {
      const painter = connect(), peer = connect();
      const ownerId = painter.messages('paint-init')[0].ownerId;
      paint(painter, [dot(1), dot(20)]);
      const added = {type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots: [dot(1), dot(20)]};
      expect(peer.messages('paint-add')).toEqual([added]);
      expect(painter.messages('paint-add')).toEqual([added]);
      painter.close(1000, 'Left');
      const late = connect();
      expect(late.messages('paint-init')).toHaveLength(1);
      expect(late.messages('paint-add')).toEqual([added]);
    } finally { room.close(); }
  });

  test('lets owners erase only their own dots, and the host clear the room', () => {
    const {room, connect, paint} = fixture();
    try {
      const host = connect(true), painter = connect(), other = connect();
      paint(painter, [dot(0), dot(100)]);
      paint(other, [dot(2)]);
      const erase = {type: 'paint-erase', mapId: 'one', epoch: 1, point: [0, 0, 0], radius: 8};
      painter.receive(erase);
      expect(other.messages('paint-erase')).toEqual([{...erase, ownerId: painter.messages('paint-init')[0].ownerId}]);
      other.receive({type: 'paint-clear', mapId: 'one', epoch: 1});
      expect(host.messages('paint-clear').at(-1).ownerId).toBe(other.messages('paint-init')[0].ownerId);
      host.receive({type: 'paint-clear', mapId: 'one', epoch: 1});
      expect(painter.messages('paint-clear').at(-1).ownerId).toBeNull();
      expect(connect().messages('paint-add')).toEqual([]);
    } finally { room.close(); }
  });

  test('kicking a player removes their paint, and a map change clears it all', () => {
    const {room, connect, paint} = fixture();
    try {
      const host = connect(true), painter = connect(), peer = connect();
      paint(painter, [dot(0)]);
      paint(peer, [dot(50)]);
      const painterId = painter.messages('paint-init')[0].ownerId;
      host.receive({type: 'moderate', playerId: painter.messages('welcome')[0].player.id, action: 'kick'});
      expect(peer.messages('paint-clear')).toEqual([{type: 'paint-clear', mapId: 'one', epoch: 1, ownerId: painterId}]);
      host.receive({type: 'change-map', mapId: 'two'});
      expect(peer.messages('paint-init').at(-1)).toMatchObject({mapId: 'two', epoch: 2});
      expect(connect().messages('paint-add')).toEqual([]);
    } finally { room.close(); }
  });

  test('drops stale, malformed and too-fast paint', () => {
    const {room, connect, paint} = fixture();
    try {
      const painter = connect(), peer = connect();
      paint(painter, [dot(0)], {epoch: 9});
      paint(painter, [dot(0)], {mapId: 'two'});
      expect(peer.messages('paint-add')).toEqual([]);
      for (let i = 0; i < 20; i++) paint(painter, [dot(i)]);
      expect(peer.messages('paint-add')).toHaveLength(10);
      const bad = connect();
      paint(bad, [[0, 0, 0, 0, 0, 5, 4, 0]]);
      expect(bad.closed?.code).toBe(4002);
    } finally { room.close(); }
  });

  test('caps paint per owner and per room', () => {
    expect(acceptedPaint(0, 0, 32)).toBe(32);
    expect(acceptedPaint(0, MAX_ROOM_PAINT - 5, 32)).toBe(5);
    expect(acceptedPaint(MAX_OWNER_PAINT, MAX_ROOM_PAINT, 32)).toBe(32);
    expect(acceptedPaint(MAX_OWNER_PAINT - 2, MAX_ROOM_PAINT, 32)).toBe(0);
    expect(erasePaint([dot(0), dot(13), dot(30)], [0, 0, 0], 8).map(row => row[0])).toEqual([13, 30]);
  });
});

describe('room paint on the wire', () => {
  test('host messages are rebuilt through the room filter', () => {
    const filter = createRoomFilter({roomId: 'p-abcdefghjkmn', maps: [{id: 'one'}]});
    const state = {roomId: 'p-abcdefghjkmn', name: "Host's room", visibility: 'private', maxPlayers: 16, mapId: 'one',
      epoch: 1, startedAt: 0, endsAt: 0, untimed: true, recent: [], nominations: {}, rtv: [], vote: null, nextMap: null};
    filter({type: 'state', state, serverTime: 0});
    const ownerId = crypto.randomUUID();
    expect(filter({type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots: [dot(1)], extra: 1}))
      .toEqual({type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots: [dot(1)]});
    expect(filter({type: 'paint-add', mapId: 'one', epoch: 0 + 2, ownerId, dots: [dot(1)]})).toBeNull();
    expect(() => filter({type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots: [dot(1, [9])]})).toThrow();
    expect(filter({type: 'paint-clear', mapId: 'one', epoch: 1, ownerId: null}).ownerId).toBeNull();
    expect(() => decodeControl(JSON.stringify({type: 'paint-erase', mapId: 'one', epoch: 1, point: [0, 0], radius: 8}))).toThrow();
    expect(() => decodeControl(JSON.stringify({type: 'paint-add', mapId: 'one', epoch: 1, dots: Array(33).fill(dot(0))}))).toThrow();
  });

  test('a guest copy batches strokes and mirrors the host', () => {
    const sent = [], timers = [];
    const paint = createRoomPaint({send: message => sent.push(message), invalid: () => sent.push('invalid'),
      timers: {setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}}, now: () => 1000});
    expect(paint.ready).toBe(false);
    paint.state({mapId: 'one', epoch: 1});
    const ownerId = crypto.randomUUID(), other = crypto.randomUUID();
    paint.receive({type: 'paint-init', mapId: 'one', epoch: 1, ownerId});
    expect(paint.ready).toBe(true);
    paint.add(dot(1.234));
    paint.add(dot(9));
    timers.shift()();
    expect(sent).toEqual([{type: 'paint-add', mapId: 'one', epoch: 1, dots: [dot(1.23), dot(9)]}]);
    const generation = paint.generation;
    paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots: [dot(1.23), dot(9)]});
    paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: other, dots: [dot(40)]});
    // New paint only appends, so the renderer can draw just the new dots.
    expect(paint.generation).toBe(generation);
    expect(paint.rows.map(row => row[0])).toEqual([1.23, 9, 40]);
    expect(paint.ownCount()).toBe(2);
    // An erase only goes out when one of your own dots is in reach.
    paint.erase({x: 40, y: 0, z: 0}, 8);
    expect(sent).toHaveLength(1);
    paint.erase({x: 0, y: 0, z: 0}, 8);
    expect(sent.at(-1)).toEqual({type: 'paint-erase', mapId: 'one', epoch: 1, point: [0, 0, 0], radius: 8});
    paint.receive({type: 'paint-erase', mapId: 'one', epoch: 1, ownerId, point: [0, 0, 0], radius: 8});
    expect(paint.generation).toBeGreaterThan(generation);
    expect(paint.rows.map(row => row[0])).toEqual([40]);
    expect(paint.ownCount()).toBe(0);
    paint.receive({type: 'paint-clear', mapId: 'one', epoch: 1, ownerId: null});
    expect(paint.rows).toEqual([]);
    expect(paint.ready).toBe(true);
    paint.state({mapId: 'two', epoch: 2});
    expect(paint.ready).toBe(false);
  });

  test('a guest copy matches the host after owners pass their cap', () => {
    const {room, connect, paint, advance} = fixture();
    try {
      const a = connect(), b = connect(), watcher = connect();
      const copy = createRoomPaint({send: () => {}, invalid: () => { throw new Error('invalid'); }});
      copy.state(room.state);
      const filter = createRoomFilter({roomId: room.state.roomId, maps: [{id: 'one'}, {id: 'two'}]});
      filter({type: 'state', state: room.state, serverTime: 0});
      for (const message of watcher.sent) if (message.type.startsWith('paint-')) copy.receive(filter(message));
      let x = 0;
      for (let round = 0; round < 50; round++) {
        paint(a, Array.from({length: 32}, () => dot(x++)));
        paint(b, Array.from({length: 7}, () => dot(x++)));
        if (round % 5 === 0) a.receive({type: 'paint-erase', mapId: 'one', epoch: 1, point: [x - 40, 0, 0], radius: 30});
        advance(1000);
      }
      const seen = watcher.sent.filter(message => message.type.startsWith('paint-') && message.type !== 'paint-init');
      for (const message of seen) copy.receive(filter(message));
      const late = connect(), expected = late.messages('paint-add').flatMap(message => message.dots).map(row => row[0]).sort((p, q) => p - q);
      expect(copy.rows.map(row => row[0]).sort((p, q) => p - q)).toEqual(expected);
      expect(copy.rows.length).toBeLessThanOrEqual(MAX_OWNER_PAINT * 2);
    } finally { room.close(); }
  });

  test('a guest disconnects from a host that overfills the room', () => {
    const sent = [];
    const paint = createRoomPaint({send: () => {}, invalid: () => sent.push('invalid')});
    paint.state({mapId: 'one', epoch: 1});
    paint.receive({type: 'paint-init', mapId: 'one', epoch: 1, ownerId: crypto.randomUUID()});
    const full = Array.from({length: MAX_OWNER_PAINT}, (_, i) => dot(i));
    for (let i = 0; i <= MAX_ROOM_PAINT / MAX_OWNER_PAINT; i++) {
      paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: crypto.randomUUID(), dots: full});
    }
    expect(sent).toEqual(['invalid']);
  });
});
