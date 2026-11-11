// World paint, like KSF's !paint: hold a key to mark the surface you aim at
// with dots, drawn into the game's own scene. Alone, paint is kept per map in
// this browser; in a private room it is the room's, shared with everyone there.
// A dot is a row: [x, y, z, nx, ny, nz, size, color], in game coordinates.
import {cameraWorld} from './cinema-world.js';
import {mapKey} from './run-history.js';
import {erasePaint, roundRow} from './private-rooms/room-paint.js';

export const MAX_DOTS = 2000;
export const storePrefix = 'surfd-qol.paint.v1:';
const RANGE = 8192;
// Dots float just off the surface; polygon offset handles the rest of the z-fight.
const LIFT = 0.35;
const PROBE = {min: {x: -0.25, y: -0.25, z: -0.25}, max: {x: 0.25, y: 0.25, z: 0.25}};
const SAVE_DELAY = 800;
const FIRST_CAPACITY = 256;
// Three's DoubleSide: each dot is two triangles, seen from either side.
const DOUBLE_SIDE = 2;

const vertexShader = `
attribute vec2 corner;
attribute vec3 tint;
varying vec2 vCorner;
varying vec3 vTint;
void main() {
  vCorner = corner;
  vTint = tint;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const fragmentShader = `
varying vec2 vCorner;
varying vec3 vTint;
void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vTint, 1.0 - smoothstep(0.8, 1.0, d));
}`;

export const hexToInt = hex => /^#[\da-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;

// The camera's eye and forward direction in game coordinates (Z up). The scene
// is Y up: game (x, y, z) is drawn at (x, z, -y).
export function eyeRay(camera) {
  const e = camera?.matrixWorld?.elements;
  if (!e) return null;
  const dir = {x: -e[8], y: e[10], z: -e[9]}, length = Math.hypot(dir.x, dir.y, dir.z);
  if (!(length > 0)) return null;
  return {from: {x: e[12], y: -e[14], z: e[13]}, dir: {x: dir.x / length, y: dir.y / length, z: dir.z / length}};
}

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
// Writes dot i's four corners (scene coordinates, lifted along its normal) and colour into the buffers.
export function writeDot(row, i, position, corner, tint) {
  const nx = row[3], ny = row[4], nz = row[5], r = row[6], color = row[7];
  // Tangent = a × n, with a = up unless the surface is nearly flat.
  let tx, ty, tz;
  if (Math.abs(nz) < 0.9) { tx = -ny; ty = nx; tz = 0; } else { tx = 0; ty = -nz; tz = ny; }
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  const cx = row[0] + nx * LIFT, cy = row[1] + ny * LIFT, cz = row[2] + nz * LIFT;
  const red = (color >> 16 & 255) / 255, green = (color >> 8 & 255) / 255, blue = (color & 255) / 255;
  for (let k = 0; k < 4; k++) {
    const u = CORNERS[k * 2] * r, v = CORNERS[k * 2 + 1] * r, p = i * 12 + k * 3;
    position[p] = cx + tx * u + bx * v;
    position[p + 1] = cz + tz * u + bz * v;
    position[p + 2] = -(cy + ty * u + by * v);
    tint[p] = red; tint[p + 1] = green; tint[p + 2] = blue;
    corner[i * 8 + k * 2] = CORNERS[k * 2]; corner[i * 8 + k * 2 + 1] = CORNERS[k * 2 + 1];
  }
}
export function dotCorners(row) {
  const position = new Float32Array(12);
  writeDot(row, 0, position, new Float32Array(8), new Float32Array(12));
  return position;
}

// Only the changed part of a buffer goes to the GPU, whichever update API this Three has.
function markRange(attribute, start, count) {
  if (typeof attribute.addUpdateRange === 'function') attribute.addUpdateRange(start, count);
  else if (attribute.updateRange) {
    const range = attribute.updateRange;
    if (range.count > 0) {
      const end = Math.max(range.offset + range.count, start + count);
      range.offset = Math.min(range.offset, start);
      range.count = end - range.offset;
    } else { range.offset = start; range.count = count; }
  }
  attribute.needsUpdate = true;
}

// One mesh for every dot. Its buffers grow by doubling and are kept, so new
// paint writes only the new dots; anything else (erase, clear, a map) rewrites the rest.
export function createPaintMesh(three, material) {
  let capacity = 0, geometry = null, position, corner, tint, attributes = null;
  let drawnLayer = null, drawnGeneration = -1, drawnCount = 0;
  const mesh = new three.Mesh(new three.Geometry(), material);
  mesh.name = 'surfd-qol-paint';
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.visible = false;
  function grow(needed) {
    capacity = Math.max(FIRST_CAPACITY, capacity);
    while (capacity < needed) capacity *= 2;
    // A plain array lets Three pick 16- or 32-bit indices; the borrowed
    // attribute class may be a Float32 one, which would turn indices into floats.
    const index = new Array(capacity * 6);
    for (let i = 0, v = 0, j = 0; i < capacity; i++, v += 4, j += 6) {
      index[j] = v; index[j + 1] = v + 1; index[j + 2] = v + 2; index[j + 3] = v; index[j + 4] = v + 2; index[j + 5] = v + 3;
    }
    const next = new three.Geometry();
    attributes = {position: new three.Attribute(new Float32Array(capacity * 12), 3),
      corner: new three.Attribute(new Float32Array(capacity * 8), 2), tint: new three.Attribute(new Float32Array(capacity * 12), 3)};
    // Write into the attributes' own arrays: classes like Float32BufferAttribute copy what they're given.
    position = attributes.position.array; corner = attributes.corner.array; tint = attributes.tint.array;
    for (const [name, attribute] of Object.entries(attributes)) next.setAttribute(name, attribute);
    next.setIndex(index);
    mesh.geometry.dispose?.();
    mesh.geometry = geometry = next;
  }
  return {
    mesh,
    get capacity() { return capacity; },
    // Returns how many dots were written.
    sync(rows, layer, generation) {
      const count = rows.length;
      let from = layer === drawnLayer && generation === drawnGeneration && count >= drawnCount ? drawnCount : 0;
      if (count > capacity) { grow(count); from = 0; }
      for (let i = from; i < count; i++) writeDot(rows[i], i, position, corner, tint);
      if (count > from) {
        markRange(attributes.position, from * 12, (count - from) * 12);
        markRange(attributes.tint, from * 12, (count - from) * 12);
        markRange(attributes.corner, from * 8, (count - from) * 8);
      }
      drawnLayer = layer; drawnGeneration = generation; drawnCount = count;
      geometry?.setDrawRange(0, count * 6);
      mesh.visible = count > 0;
      return count - from;
    },
    dispose() { mesh.geometry.dispose?.(); },
  };
}

// While held, a new dot goes down once the aim has moved most of a dot away.
export function shouldPlace(last, point, size) {
  return !last || Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z) >= size * 0.8;
}

export const encode = rows => JSON.stringify(rows.map(roundRow));
export function decode(text) {
  try {
    const rows = JSON.parse(text ?? '[]');
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => Array.isArray(row) && row.length === 8 && row.every(Number.isFinite)).slice(-MAX_DOTS);
  } catch { return []; }
}

// The game's Three.js classes, borrowed from one of its ghosts; there is no global THREE.
function borrowThree(renderer) {
  const scene = renderer.qolScene, before = new Set(scene.children);
  const ghost = renderer.qolGhost();
  try {
    const group = scene.children.find(child => !before.has(child));
    let body = null;
    group?.traverse?.(object => { if (!body && object.isMesh && object.material?.uniforms) body = object; });
    if (!body) throw new Error('The game’s ghost changed shape.');
    // The ghost's geometry may be a subclass that builds its own attributes.
    let Geometry = body.geometry.constructor;
    while (!Object.hasOwn(Geometry.prototype, 'setAttribute') && Object.getPrototypeOf(Geometry.prototype)?.constructor) {
      Geometry = Object.getPrototypeOf(Geometry.prototype).constructor;
    }
    const three = {Mesh: body.constructor, Geometry, Attribute: body.geometry.getAttribute('position').constructor, Material: body.material.constructor};
    if (group) scene.remove(group);
    return three;
  } finally { ghost.dispose?.(); }
}

const LOCAL = 'local';

export function createPaint({getAdapter, settings, getRoom = null, isHost = null, storage = globalThis.localStorage}) {
  let map = null, mapObject = null, dots = [], generation = 0, saveTimer = 0, destroyed = false;
  let attached = null, material = null, paintMesh = null;
  const failed = new WeakSet(), held = new Set();
  let last = null, frame = 0;

  const load = key => { try { return decode(storage?.getItem(storePrefix + key)); } catch { return []; } };
  function save() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!map) return;
    try {
      if (dots.length) storage?.setItem(storePrefix + map, encode(dots));
      else storage?.removeItem(storePrefix + map);
    } catch (error) { console.warn('[Surfd QoL] Could not save paint:', error); }
  }
  function changed(appended = false) {
    if (!appended) generation++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  function attach(renderer) {
    const three = borrowThree(renderer);
    material = new three.Material({vertexShader, fragmentShader, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
    material.side = DOUBLE_SIDE;
    material.toneMapped = false;
    paintMesh = createPaintMesh(three, material);
    renderer.qolScene.add(paintMesh.mesh);
    attached = renderer;
  }
  function detach() {
    if (!attached) return;
    try { attached.qolScene.remove(paintMesh.mesh); } catch { /* unloaded with the map */ }
    paintMesh.dispose(); material?.dispose?.();
    attached = paintMesh = material = null;
  }

  // In a room, strokes go to the room and its host sends them back to everyone, you included.
  function stroke(session, room) {
    const world = cameraWorld(session), ray = eyeRay(attached.qolCamera);
    if (!world || !ray) return;
    const {from, dir} = ray;
    const hit = world.trace(from, {x: from.x + dir.x * RANGE, y: from.y + dir.y * RANGE, z: from.z + dir.z * RANGE}, PROBE);
    if (!hit || hit.startSolid || hit.allSolid || !(hit.fraction < 1) || !hit.normal || !hit.end) return;
    const point = hit.end, size = settings.paintSize, radius = Math.max(8, size * 2);
    if (held.has('erase')) {
      if (room) room.erase(point, radius);
      else {
        const kept = erasePaint(dots, [point.x, point.y, point.z], radius);
        if (kept !== dots) { dots = kept; changed(); }
      }
    }
    if (held.has('paint') && shouldPlace(last, point, size)) {
      const n = hit.normal;
      const row = [point.x, point.y, point.z, n.x, n.y, n.z, size, hexToInt(settings.paintColor)];
      last = {...point};
      if (room) room.add(row);
      else {
        dots.push(row);
        const full = dots.length > MAX_DOTS;
        if (full) dots.splice(0, dots.length - MAX_DOTS);
        changed(!full);
      }
    }
  }
  // The room's paint replaces your own while you're on the room's map, so everyone sees the same.
  function roomFor(session) {
    const room = getRoom?.() ?? null;
    return room && session?.map?.id === room.mapId ? room : null;
  }

  function loop() {
    if (destroyed) return;
    frame = requestAnimationFrame(loop);
    try {
      const adapter = getAdapter(), session = adapter?.getSession?.();
      if (session?.map && session.map !== mapObject) {
        mapObject = session.map;
        const key = mapKey(session.map);
        if (key !== map) { save(); map = key; dots = load(key); generation++; }
      }
      const room = roomFor(session);
      // Painting in a room always shows it, so you never paint blind.
      const visible = settings.paintShowRoom === true || settings.paint === true;
      const wanted = room ? visible : settings.paint === true;
      const renderer = wanted && map ? adapter?.cinema?.renderer?.() ?? null : null;
      if (renderer !== attached) {
        detach();
        if (renderer?.qolScene && renderer.qolCamera && !failed.has(renderer)) {
          try { attach(renderer); } catch (error) {
            failed.add(renderer); detach();
            console.warn('[Surfd QoL] World paint unavailable:', error);
          }
        }
      }
      if (!attached) return;
      const input = adapter.getInput?.();
      if (!input?.locked || input.suppressed || settings.paint !== true) { held.clear(); last = null; }
      else if (held.size) stroke(session, room);
      if (room) paintMesh.sync(room.rows, room, room.generation);
      else paintMesh.sync(dots, LOCAL, generation);
    } catch (error) {
      console.warn('[Surfd QoL] World paint stopped:', error);
      destroy();
    }
  }

  // The game still receives these keys; paint only listens.
  const action = code => code === settings.paintKey ? 'paint' : code === settings.paintEraseKey ? 'erase' : null;
  const down = event => { const name = action(event.code); if (name) held.add(name); };
  const up = event => {
    const name = action(event.code);
    if (name) held.delete(name);
    if (name === 'paint') last = null;
  };
  const clearHeld = () => { held.clear(); last = null; };
  addEventListener('keydown', down, true);
  addEventListener('keyup', up, true);
  addEventListener('blur', clearHeld);
  frame = requestAnimationFrame(loop);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(frame);
    save();
    detach();
    removeEventListener('keydown', down, true);
    removeEventListener('keyup', up, true);
    removeEventListener('blur', clearHeld);
  }
  const current = () => roomFor(getAdapter()?.getSession?.());
  return {
    // In a room: the dots shown there, and whether this browser hosts it (so Clear empties the room).
    get room() { return !!current(); },
    get host() { return !!current() && isHost?.() === true; },
    get count() { const room = current(); return room ? room.rows.length : dots.length; },
    get ownCount() { const room = current(); return room ? room.ownCount() : dots.length; },
    get map() { return map; },
    // Which Surfd action already uses a key, so the panel can warn about it.
    conflict(code) {
      try {
        const bound = getAdapter()?.getBindings?.() ?? {};
        return Object.entries(bound).find(([, codes]) => Array.isArray(codes) && codes.includes(code))?.[0] ?? null;
      } catch { return null; }
    },
    clear() {
      const room = current();
      if (room) room.clear();
      else { dots = []; changed(); save(); }
    },
    destroy,
  };
}
