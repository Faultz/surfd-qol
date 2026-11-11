// Paint performance: what each update costs, by structure (dots written, bytes
// marked for upload, buffer growth) and by time. Timings use medians over many
// runs with generous budgets, so they catch regressions without flaking.
import {describe, expect, test} from 'bun:test';
import {createPaintMesh, dotCorners, writeDot} from '../src/paint.js';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomId} from '../src/private-rooms/ids.js';
import {MAX_OWNER_PAINT, MAX_ROOM_PAINT, createRoomPaint, erasePaint} from '../src/private-rooms/room-paint.js';

// Like the game's ghost attributes may be: Three's Float32BufferAttribute copies the array it's given.
class Attribute {
  constructor(array, itemSize) { this.array = new Float32Array(array); this.itemSize = itemSize; this.ranges = []; this.needsUpdate = false; }
  addUpdateRange(start, count) { this.ranges.push([start, count]); }
}
class Geometry {
  static created = 0;
  constructor() { Geometry.created++; this.attributes = {}; this.drawRange = {start: 0, count: Infinity}; this.disposed = false; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; }
  // As Three does: a plain array becomes 16-bit indices while they fit, anything else is used as given.
  setIndex(index) {
    this.index = Array.isArray(index) ? {array: Math.max(...index.slice(-6)) < 65535 ? Uint16Array.from(index) : Uint32Array.from(index)} : index;
  }
  setDrawRange(start, count) { this.drawRange = {start, count}; }
  dispose() { this.disposed = true; }
}
class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; } }
const three = {Mesh, Geometry, Attribute};
// Marks the renderer would upload, then forgets, as Three does after a draw.
const upload = mesh => {
  let floats = 0;
  for (const attribute of Object.values(mesh.geometry.attributes)) {
    for (const [, count] of attribute.ranges) floats += count;
    attribute.ranges = []; attribute.needsUpdate = false;
  }
  return floats;
};

const row = (i, owner = 0) => [i % 997 * 3, owner * 50 + (i * 7) % 211, 64, 0, 0, 1, 4, 0x3366ff];
const rows = (count, owner = 0) => Array.from({length: count}, (_, i) => row(i, owner));
function median(fn, runs = 41) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn(i);
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[runs >> 1];
}

// The renderer before this change: every change rebuilt every dot into fresh
// arrays and a new geometry, and drew each dot with both windings.
function fullRebuild(dots) {
  const count = dots.length, position = new Float32Array(count * 12), corner = new Float32Array(count * 8);
  const tint = new Float32Array(count * 12), index = [];
  for (let i = 0; i < count; i++) {
    position.set(dotCorners(dots[i]), i * 12);
    corner.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
    const color = dots[i][7], r = (color >> 16 & 255) / 255, g = (color >> 8 & 255) / 255, b = (color & 255) / 255;
    for (let k = 0; k < 4; k++) tint.set([r, g, b], i * 12 + k * 3);
    const v = i * 4;
    index.push(v, v + 1, v + 2, v, v + 2, v + 3, v, v + 2, v + 1, v, v + 3, v + 2);
  }
  const geometry = new Geometry();
  geometry.setAttribute('position', new Attribute(position, 3));
  geometry.setAttribute('corner', new Attribute(corner, 2));
  geometry.setAttribute('tint', new Attribute(tint, 3));
  geometry.setIndex(Uint32Array.from(index));
  return geometry;
}

describe('paint mesh updates', () => {
  test('dots land in the arrays the GPU reads, with integer indices', () => {
    const paint = createPaintMesh(three, {});
    paint.sync([[10, 20, 30, 0, 0, 1, 4, 0xff0000]], 'local', 0);
    const {position, tint, corner} = paint.mesh.geometry.attributes;
    expect(Array.from(position.array.slice(0, 12))).toEqual(Array.from(dotCorners([10, 20, 30, 0, 0, 1, 4, 0xff0000])));
    expect(Array.from(tint.array.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(corner.array.slice(0, 8))).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(Array.from(paint.mesh.geometry.index.array.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(paint.mesh.visible).toBe(true);
    // Later dots also reach the attribute's own array, past a regrowth.
    const many = rows(600);
    paint.sync(many, 'local', 1);
    paint.sync([...many, [1, 2, 3, 0, 0, 1, 4, 0x00ff00]], 'local', 1);
    expect(paint.mesh.geometry.attributes.tint.array[600 * 12 + 1]).toBe(1);
  });

  test('new paint writes and uploads only the new dots', () => {
    const paint = createPaintMesh(three, {});
    const all = rows(MAX_ROOM_PAINT - 32);
    expect(paint.sync(all, 'room', 1)).toBe(all.length);
    upload(paint.mesh);
    const created = Geometry.created;
    all.push(...rows(32, 3));
    expect(paint.sync(all, 'room', 1)).toBe(32);
    // 32 dots × (12 position + 12 tint + 8 corner) floats, and no new geometry.
    expect(upload(paint.mesh)).toBe(32 * 32);
    expect(Geometry.created).toBe(created);
    expect(paint.mesh.geometry.drawRange.count).toBe(MAX_ROOM_PAINT * 6);
    // Nothing changed: nothing is written or uploaded.
    expect(paint.sync(all, 'room', 1)).toBe(0);
    expect(upload(paint.mesh)).toBe(0);
  });

  test('erasing or switching layers rewrites in place, without new buffers', () => {
    const paint = createPaintMesh(three, {});
    const all = rows(3000);
    paint.sync(all, 'room', 1);
    upload(paint.mesh);
    const created = Geometry.created, array = paint.mesh.geometry.attributes.position.array;
    const kept = all.slice(0, 2500);
    expect(paint.sync(kept, 'room', 2)).toBe(2500);
    expect(paint.mesh.geometry.attributes.position.array).toBe(array);
    expect(paint.mesh.geometry.drawRange.count).toBe(2500 * 6);
    expect(paint.sync(rows(10), 'local', 0)).toBe(10);
    expect(Geometry.created).toBe(created);
    expect(paint.sync([], 'local', 1)).toBe(0);
    expect(paint.mesh.visible).toBe(false);
  });

  test('painting a full room dot by dot costs linear work and a handful of buffers', () => {
    const paint = createPaintMesh(three, {});
    const all = [];
    const created = Geometry.created;
    let written = 0, uploaded = 0;
    for (let i = 0; i < MAX_ROOM_PAINT; i++) {
      all.push(row(i));
      written += paint.sync(all, 'room', 1);
      uploaded += upload(paint.mesh);
    }
    // Each growth rewrites what's there once, so at most twice the dots in total.
    expect(written).toBeLessThan(MAX_ROOM_PAINT * 2);
    // Uploads follow the writes exactly: 32 floats per dot written, never the whole buffer.
    expect(uploaded).toBe(written * 32);
    // 256 → 512 → 1024 → 2048 → 4096.
    expect(Geometry.created - created).toBe(5);
    // Two triangles per dot, and 16-bit indices while they fit.
    expect(paint.mesh.geometry.index.array).toBeInstanceOf(Uint16Array);
    expect(paint.mesh.geometry.index.array.length).toBe(paint.capacity * 6);
  });

  test('is hundreds of times faster than rebuilding everything per dot', () => {
    const all = rows(MAX_ROOM_PAINT), paint = createPaintMesh(three, {});
    paint.sync(all, 'room', 1);
    const extra = rows(64, 9);
    let n = 0;
    // One new dot per frame on top of a full room.
    const append = median(() => {
      all.push(extra[n++ % 64]);
      paint.sync(all, 'room', 1);
      upload(paint.mesh);
    }, 61);
    const before = median(() => fullRebuild(all), 21);
    const full = median(i => paint.sync(all, 'room', 100 + i), 21);
    console.log(`[paint perf] ${all.length} dots: old rebuild ${before.toFixed(3)} ms, new full rewrite ${full.toFixed(3)} ms, new per-dot append ${(append * 1000).toFixed(1)} µs`);
    expect(append).toBeLessThan(0.1);
    expect(full).toBeLessThan(4);
    expect(before / Math.max(append, 0.0005)).toBeGreaterThan(100);
    expect(full).toBeLessThan(before);
  });

  test('writing a dot allocates nothing', () => {
    const position = new Float32Array(12000), corner = new Float32Array(8000), tint = new Float32Array(12000);
    const all = rows(1000);
    const time = median(() => { for (let i = 0; i < 1000; i++) writeDot(all[i], i, position, corner, tint); });
    expect(time).toBeLessThan(1.5);
  });
});

describe('room paint at full size', () => {
  test('erasing in empty space is nearly free and returns the same rows', () => {
    const all = rows(MAX_ROOM_PAINT);
    expect(erasePaint(all, [-9999, 0, 0], 64)).toBe(all);
    const time = median(() => erasePaint(all, [-9999, 0, 0], 64), 101);
    expect(time).toBeLessThan(0.3);
  });

  test('a guest copy handles a full, busy room quickly', () => {
    const copy = createRoomPaint({send: () => {}, invalid: () => { throw new Error('invalid'); }});
    copy.state({mapId: 'one', epoch: 1});
    copy.receive({type: 'paint-init', mapId: 'one', epoch: 1, ownerId: crypto.randomUUID()});
    const owners = Array.from({length: Math.floor(MAX_ROOM_PAINT / MAX_OWNER_PAINT)}, () => crypto.randomUUID());
    const start = performance.now();
    for (const [o, owner] of owners.entries()) copy.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: owner, dots: rows(MAX_OWNER_PAINT, o)});
    const load = performance.now() - start;
    const generation = copy.generation;
    // Owners at their cap keep painting: each batch replaces their oldest dots.
    const busy = median(i => copy.receive({type: 'paint-add', mapId: 'one', epoch: 1, ownerId: owners[i % owners.length], dots: rows(32, i)}), 61);
    const erase = median(i => copy.receive({type: 'paint-erase', mapId: 'one', epoch: 1, ownerId: owners[i % owners.length], point: [i * 3, 0, 64], radius: 16}), 61);
    console.log(`[paint perf] room copy: load ${load.toFixed(2)} ms, capped batch ${busy.toFixed(3)} ms, erase ${erase.toFixed(3)} ms`);
    expect(copy.rows.length).toBeLessThanOrEqual(MAX_ROOM_PAINT);
    expect(copy.generation).toBeGreaterThan(generation);
    expect(load).toBeLessThan(50);
    expect(busy).toBeLessThan(2);
    expect(erase).toBeLessThan(2);
  });

  test('a host serves 16 players painting flat out', () => {
    let time = 0;
    const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maps: [{id: 'one'}], now: () => time});
    const sockets = Array.from({length: 16}, () => {
      const socket = new EventTarget();
      Object.assign(socket, {readyState: 1, bufferedAmount: 0, sent: 0, send() { this.sent++; }, close() {}});
      room.addClient(socket, {guest: false, browserId: crypto.randomUUID(), name: 'Surfer'});
      return socket;
    });
    try {
      const batch = rows(32);
      const start = performance.now();
      // 10 seconds at 4 batches a second each: 640 batches of 32 dots, each sent to 16 players.
      for (let tick = 0; tick < 40; tick++) {
        time += 250;
        for (const socket of sockets) {
          socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({type: 'paint-add', mapId: 'one', epoch: 1, dots: batch})}));
        }
      }
      const elapsed = performance.now() - start;
      console.log(`[paint perf] host: 640 batches to 16 players in ${elapsed.toFixed(1)} ms`);
      expect(elapsed).toBeLessThan(1500);
      const late = new EventTarget(), received = [];
      Object.assign(late, {readyState: 1, bufferedAmount: 0, send: data => received.push(data), close() {}});
      room.addClient(late, {guest: false, browserId: crypto.randomUUID(), name: 'Late'});
      const dots = received.map(text => JSON.parse(text)).filter(message => message.type === 'paint-add')
        .reduce((sum, message) => sum + message.dots.length, 0);
      expect(dots).toBeLessThanOrEqual(MAX_ROOM_PAINT);
    } finally { room.close(); }
  });
});
