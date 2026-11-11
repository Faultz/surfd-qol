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

  test('lets owners erase and remove only their own dots, and only the host remove everyone’s', () => {
    const {room, connect, paint} = fixture();
    try {
      const host = connect(true), painter = connect(), other = connect();
      paint(host, [dot(-50)]);
      paint(painter, [dot(0), dot(100)]);
      paint(other, [dot(2)]);
      const erase = {type: 'paint-erase', mapId: 'one', epoch: 1, point: [0, 0, 0], radius: 8};
      painter.receive(erase);
      expect(other.messages('paint-erase')).toEqual([{...erase, ownerId: painter.messages('paint-init')[0].ownerId}]);
      // A guest asking to remove everything only removes their own.
      other.receive({type: 'paint-clear', mapId: 'one', epoch: 1, all: true});
      expect(host.messages('paint-clear').at(-1).ownerId).toBe(other.messages('paint-init')[0].ownerId);
      // The host's own Remove removes the host's paint alone.
      host.receive({type: 'paint-clear', mapId: 'one', epoch: 1});
      expect(painter.messages('paint-clear').at(-1).ownerId).toBe(host.messages('paint-init')[0].ownerId);
      expect(connect().messages('paint-add').flatMap(message => message.dots)).toEqual([dot(100)]);
      host.receive({type: 'paint-clear', mapId: 'one', epoch: 1, all: true});
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
      // A burst of 50 messages, then nothing until the limit refills.
      for (let i = 0; i < 60; i++) paint(painter, [dot(i)]);
      expect(peer.messages('paint-add')).toHaveLength(50);
      // And at most 400 dots at once, however they're batched.
      const flood = connect(), seen = peer.messages('paint-add').length;
      for (let i = 0; i < 20; i++) paint(flood, Array.from({length: 32}, () => dot(i)));
      expect(peer.messages('paint-add').length - seen).toBe(12);
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

  // A guest copy with a hand-driven clock and timers.
  function guest() {
    const sent = [], timers = new Map();
    let time = 1000, next = 1;
    const paint = createRoomPaint({send: message => sent.push(message), invalid: () => sent.push('invalid'),
      timers: {setTimeout: (fn, ms) => { timers.set(next, {fn, at: time + ms}); return next++; }, clearTimeout: id => timers.delete(id)},
      now: () => time});
    const advance = ms => {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    };
    const ownerId = crypto.randomUUID();
    paint.state({mapId: 'one', epoch: 1});
    paint.receive({type: 'paint-init', mapId: 'one', epoch: 1, ownerId});
    return {paint, sent, advance, ownerId, echo: dots => paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId, dots})};
  }

  test('your own dots show and go out at once, then batch while you keep painting', () => {
    const {paint, sent, advance, echo} = guest();
    expect(paint.ready).toBe(true);
    paint.add(dot(1.234));
    // No wait for a timer or the host: on screen and sent in the same frame.
    expect(paint.rows.map(row => row[0])).toEqual([1.23]);
    expect(sent).toEqual([{type: 'paint-add', mapId: 'one', epoch: 1, dots: [dot(1.23)]}]);
    paint.add(dot(9)); paint.add(dot(17));
    expect(paint.rows.map(row => row[0])).toEqual([1.23, 9, 17]);
    expect(sent).toHaveLength(1);
    advance(50);
    expect(sent.at(-1).dots).toEqual([dot(9), dot(17)]);
    // The host's copy takes the place of each pending dot without moving any.
    const generation = paint.generation;
    echo([dot(1.23)]); echo([dot(9), dot(17)]);
    expect(paint.generation).toBe(generation);
    expect(paint.rows.map(row => row[0])).toEqual([1.23, 9, 17]);
    expect(paint.ownCount()).toBe(3);
  });

  test('mirrors the host as other players paint, erase and clear', () => {
    const {paint, sent, ownerId, echo} = guest();
    const other = crypto.randomUUID();
    paint.add(dot(0)); paint.add(dot(9));
    // Another player's dots arriving before yours are confirmed reorder the list once.
    const generation = paint.generation;
    paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: other, dots: [dot(40)]});
    expect(paint.generation).toBeGreaterThan(generation);
    expect(paint.rows.map(row => row[0])).toEqual([40, 0, 9]);
    echo([dot(0)]);
    expect(paint.rows.map(row => row[0])).toEqual([40, 0, 9]);
    // Erasing near only someone else's dots sends nothing.
    const before = sent.length;
    paint.erase({x: 40, y: 0, z: 0}, 8);
    expect(sent).toHaveLength(before);
    paint.receive({type: 'paint-erase', mapId: 'one', epoch: 1, ownerId: other, point: [40, 0, 0], radius: 8});
    expect(paint.rows.map(row => row[0])).toEqual([0, 9]);
    paint.receive({type: 'paint-clear', mapId: 'one', epoch: 1, ownerId});
    expect(paint.rows.map(row => row[0])).toEqual([9]);
    paint.receive({type: 'paint-clear', mapId: 'one', epoch: 1, ownerId: null});
    expect(paint.ready).toBe(true);
    paint.state({mapId: 'two', epoch: 2});
    expect(paint.ready).toBe(false);
    expect(paint.rows).toEqual([]);
  });

  test('erasing your own dots is instant, even ones still on their way', () => {
    const {paint, sent, advance, echo, ownerId} = guest();
    paint.add(dot(0));
    echo([dot(0)]);
    paint.add(dot(100));
    paint.add(dot(200));
    advance(50);
    paint.add(dot(300));
    // Unsent, confirmed and in flight: each gone from screen at once.
    paint.erase({x: 300, y: 0, z: 0}, 8);
    expect(paint.rows.map(row => row[0])).toEqual([0, 100, 200]);
    paint.erase({x: 0, y: 0, z: 0}, 8);
    expect(paint.rows.map(row => row[0])).toEqual([100, 200]);
    advance(125);
    paint.erase({x: 200, y: 0, z: 0}, 8);
    expect(paint.rows.map(row => row[0])).toEqual([100]);
    // The unsent dot was never sent, and the host was only asked about dots it has.
    advance(100);
    const adds = sent.filter(message => message.type === 'paint-add').flatMap(message => message.dots).map(row => row[0]);
    expect(adds).toEqual([0, 100, 200]);
    expect(sent.filter(message => message.type === 'paint-erase').map(message => message.point[0])).toEqual([0, 200]);
    // The host confirms the in-flight batch, then its erase follows: the copy ends up like the host.
    echo([dot(100), dot(200)]);
    paint.receive({type: 'paint-erase', mapId: 'one', epoch: 1, ownerId, point: [200, 0, 0], radius: 8});
    expect(paint.rows.map(row => row[0])).toEqual([100]);
    expect(paint.ownCount()).toBe(1);
  });

  test('a batch the host never confirms stops showing', () => {
    const {paint, advance} = guest();
    paint.add(dot(5));
    expect(paint.rows).toHaveLength(1);
    advance(2900);
    expect(paint.rows).toHaveLength(1);
    advance(200);
    expect(paint.rows).toHaveLength(0);
    expect(paint.ownCount()).toBe(0);
  });

  test('Remove my paint and Remove all paint clear the screen at once', () => {
    const {paint, sent, echo} = guest();
    const other = crypto.randomUUID();
    paint.add(dot(0)); echo([dot(0)]);
    paint.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: other, dots: [dot(50)]});
    paint.clear(false);
    expect(paint.rows.map(row => row[0])).toEqual([50]);
    expect(sent.at(-1)).toEqual({type: 'paint-clear', mapId: 'one', epoch: 1});
    paint.clear(true);
    expect(paint.rows).toEqual([]);
    expect(sent.at(-1)).toEqual({type: 'paint-clear', mapId: 'one', epoch: 1, all: true});
    expect(decodeControl(JSON.stringify(sent.at(-1)))).toMatchObject({all: true});
    expect(decodeControl(JSON.stringify(sent.at(-2)))).toMatchObject({all: false});
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
