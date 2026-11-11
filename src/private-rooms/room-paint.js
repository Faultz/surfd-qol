// Paint shared in a private room. The host keeps each player's dots and
// rebroadcasts every change; everyone applies the same rules, so all copies match.
// A dot on the wire is [x, y, z, nx, ny, nz, size, color].
export const MAX_PAINT_BATCH = 32, MAX_OWNER_PAINT = 600, MAX_ROOM_PAINT = 4000, MAX_ERASE_RADIUS = 64;
const FLUSH_MS = 250, ERASE_MS = 125, MAX_QUEUE = 128;

const finite = (value, max) => Number.isFinite(value) && Math.abs(value) <= max;
export const isPaintDot = dot => Array.isArray(dot) && dot.length === 8
  && finite(dot[0], 131072) && finite(dot[1], 131072) && finite(dot[2], 131072)
  && finite(dot[3], 1.01) && finite(dot[4], 1.01) && finite(dot[5], 1.01)
  && Math.abs(Math.hypot(dot[3], dot[4], dot[5]) - 1) < 0.05
  && Number.isFinite(dot[6]) && dot[6] >= 1 && dot[6] <= 32
  && Number.isInteger(dot[7]) && dot[7] >= 0 && dot[7] <= 0xffffff;
export const isPaintPoint = point => Array.isArray(point) && point.length === 3 && point.every(value => finite(value, 131072));
export const isEraseRadius = radius => Number.isFinite(radius) && radius > 0 && radius <= MAX_ERASE_RADIUS;

// Erasing keeps dots whose edge stays outside the radius. Squared distances,
// and the same array back when nothing is hit, since erase runs every frame it's held.
const touches = (dot, x, y, z, radius) => {
  const dx = dot[0] - x, dy = dot[1] - y, dz = dot[2] - z, reach = radius + dot[6];
  return dx * dx + dy * dy + dz * dz <= reach * reach;
};
export function erasePaint(rows, [x, y, z], radius) {
  let first = -1;
  for (let i = 0; i < rows.length; i++) if (touches(rows[i], x, y, z, radius)) { first = i; break; }
  if (first < 0) return rows;
  const kept = rows.slice(0, first);
  for (let i = first + 1; i < rows.length; i++) if (!touches(rows[i], x, y, z, radius)) kept.push(rows[i]);
  return kept;
}
// An owner's newest dots replace their oldest past the cap.
export function appendPaint(rows, dots) {
  const next = [...rows, ...dots];
  return next.length > MAX_OWNER_PAINT ? next.slice(next.length - MAX_OWNER_PAINT) : next;
}
// How many of a batch the host keeps: a full room still lets an owner at
// their own cap repaint, since each new dot then replaces one of theirs.
export function acceptedPaint(ownCount, roomCount, batch) {
  const free = MAX_ROOM_PAINT - roomCount;
  return MAX_OWNER_PAINT - ownCount <= free ? batch : Math.max(0, Math.min(batch, free));
}

const round = value => Math.round(value * 100) / 100;
export const roundRow = row => [round(row[0]), round(row[1]), round(row[2]), round(row[3]), round(row[4]), round(row[5]), round(row[6]), row[7]];

// One room connection's view of the paint: the room map's dots, and what this player sends.
// rows holds every owner's dots in arrival order, so new paint only ever appends;
// generation changes whenever anything else does, so the renderer knows to redraw all.
export function createRoomPaint({send, invalid, timers = globalThis, now = Date.now}) {
  let rows = [], rowOwners = [];
  const counts = new Map();
  let state = null, ownerId = null, closed = false, generation = 0;
  let queue = [], flushTimer = null, lastErase = -Infinity;
  function keep(test) {
    const nextRows = [], nextOwners = [];
    for (let i = 0; i < rows.length; i++) if (test(rows[i], rowOwners[i])) { nextRows.push(rows[i]); nextOwners.push(rowOwners[i]); }
    rows = nextRows; rowOwners = nextOwners;
    counts.clear();
    for (const owner of rowOwners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    generation++;
  }
  function flush() {
    flushTimer = null;
    if (closed || !state || !queue.length) return;
    send({type: 'paint-add', mapId: state.mapId, epoch: state.epoch, dots: queue.splice(0, MAX_PAINT_BATCH)});
    if (queue.length) flushTimer = timers.setTimeout(flush, FLUSH_MS);
  }
  function reset() {
    if (rows.length) generation++;
    rows = []; rowOwners = [];
    counts.clear();
    ownerId = null;
    queue = [];
    timers.clearTimeout(flushTimer);
    flushTimer = null;
  }
  return {
    get mapId() { return state?.mapId ?? null; },
    get rows() { return rows; },
    get generation() { return generation; },
    get ready() { return !closed && !!state && !!ownerId; },
    add(row) {
      if (!this.ready) return false;
      if (queue.length < MAX_QUEUE) queue.push(roundRow(row));
      flushTimer ??= timers.setTimeout(flush, queue.length >= MAX_PAINT_BATCH ? 0 : FLUSH_MS);
      return true;
    },
    // Only sent when one of your own dots is in reach, since that's all the host would erase.
    erase(point, radius) {
      if (!this.ready || now() - lastErase < ERASE_MS || !counts.get(ownerId)) return;
      const at = [round(point.x), round(point.y), round(point.z)], reach = Math.min(MAX_ERASE_RADIUS, radius);
      let mine = false;
      for (let i = 0; i < rows.length && !mine; i++) mine = rowOwners[i] === ownerId && touches(rows[i], at[0], at[1], at[2], reach);
      if (!mine) return;
      lastErase = now();
      send({type: 'paint-erase', mapId: state.mapId, epoch: state.epoch, point: at, radius: reach});
    },
    // The host clears the whole room; anyone else clears their own.
    clear() {
      if (this.ready) send({type: 'paint-clear', mapId: state.mapId, epoch: state.epoch});
    },
    ownCount() { return counts.get(ownerId) ?? 0; },
    state(next) {
      if (closed || state && (next.epoch < state.epoch || next.epoch === state.epoch && next.mapId === state.mapId)) return;
      state = {mapId: next.mapId, epoch: next.epoch};
      reset();
    },
    receive(message) {
      if (closed || !state || message.mapId !== state.mapId || message.epoch !== state.epoch) return;
      if (message.type === 'paint-init') {
        reset();
        ownerId = message.ownerId;
        return;
      }
      const owner = message.ownerId;
      if (message.type === 'paint-add') {
        for (const dot of message.dots) { rows.push(dot); rowOwners.push(owner); }
        const count = (counts.get(owner) ?? 0) + message.dots.length;
        counts.set(owner, count);
        // Past their cap an owner's oldest dots go, as on the host.
        if (count > MAX_OWNER_PAINT) {
          let drop = count - MAX_OWNER_PAINT;
          keep((_, by) => by !== owner || drop-- <= 0);
        }
        // The host refuses dots past the room cap, so more means it isn't playing fair.
        if (rows.length > MAX_ROOM_PAINT) { reset(); invalid(); }
      } else if (message.type === 'paint-erase') {
        if (!counts.get(owner)) return;
        const [x, y, z] = message.point, radius = message.radius;
        let hit = false;
        for (let i = 0; i < rows.length && !hit; i++) hit = rowOwners[i] === owner && touches(rows[i], x, y, z, radius);
        if (hit) keep((dot, by) => by !== owner || !touches(dot, x, y, z, radius));
      } else if (message.type === 'paint-clear') {
        if (owner === null) {
          if (!rows.length) return;
          rows = []; rowOwners = [];
          counts.clear();
          generation++;
        } else if (counts.get(owner)) keep((_, by) => by !== owner);
      }
    },
    close() {
      if (closed) return;
      reset();
      closed = true;
    },
  };
}
