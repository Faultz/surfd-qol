import { describe, expect, test } from 'bun:test';
import { MAX_DOTS, decode, dotCorners, encode, eyeRay, hexToInt, shouldPlace } from '../src/paint.js';
import { erasePaint } from '../src/private-rooms/room-paint.js';
import { applySettings, defaults } from '../src/settings.js';

const dot = (x, y, z, { nx = 0, ny = 0, nz = 1, size = 4, color = 0xff0000 } = {}) => [x, y, z, nx, ny, nz, size, color];

describe('world paint', () => {
  test('reads the camera eye and forward in game coordinates', () => {
    // A Three camera at scene (10, 64, -20) looking down scene -Z, which is game +Y.
    const elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 64, -20, 1];
    const ray = eyeRay({ matrixWorld: { elements } });
    expect(ray.from).toEqual({ x: 10, y: 20, z: 64 });
    expect(ray.dir.x).toBeCloseTo(0);
    expect(ray.dir.y).toBeCloseTo(1);
    expect(ray.dir.z).toBeCloseTo(0);
    expect(eyeRay(null)).toBeNull();
  });

  test('places a dot flat on its surface, lifted along the normal', () => {
    const floor = dotCorners(dot(100, 200, 50));
    // Scene Y is game Z: every corner sits just above the floor.
    for (let i = 0; i < 4; i++) expect(floor[i * 3 + 1]).toBeCloseTo(50.35);
    const xs = [0, 1, 2, 3].map(i => floor[i * 3]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8);
    const wall = dotCorners(dot(0, 0, 0, { nx: 1, nz: 0 }));
    for (let i = 0; i < 4; i++) expect(wall[i * 3]).toBeCloseTo(0.35);
    // A sloped ramp: every corner is the same distance off the surface plane.
    const s = Math.SQRT1_2, ramp = dotCorners(dot(0, 0, 0, { ny: s, nz: s }));
    for (let i = 0; i < 4; i++) expect(-ramp[i * 3 + 2] * s + ramp[i * 3 + 1] * s).toBeCloseTo(0.35);
  });

  test('faces each dot along its normal, so one side per dot is enough', () => {
    for (const n of [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0, Math.SQRT1_2, Math.SQRT1_2]]) {
      const p = dotCorners(dot(0, 0, 0, { nx: n[0], ny: n[1], nz: n[2] }));
      const a = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], b = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
      const face = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      // The scene normal of game n is (nx, nz, -ny).
      expect(face[0] * n[0] + face[1] * n[2] - face[2] * n[1]).toBeGreaterThan(0);
    }
  });

  test('spaces dots while held and erases near the aim', () => {
    expect(shouldPlace(null, { x: 0, y: 0, z: 0 }, 4)).toBe(true);
    expect(shouldPlace({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 4)).toBe(false);
    expect(shouldPlace({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 4)).toBe(true);
    const rows = [dot(0, 0, 0), dot(10, 0, 0), dot(100, 0, 0)];
    expect(erasePaint(rows, [0, 0, 0], 8).map(row => row[0])).toEqual([100]);
    // Nothing in reach hands back the same array, so nothing redraws.
    expect(erasePaint(rows, [500, 0, 0], 8)).toBe(rows);
  });

  test('round-trips saved paint and rejects bad rows', () => {
    const rows = [dot(1.234, -5.5, 7, { color: 0x00ff00 })];
    expect(decode(encode(rows))).toEqual([dot(1.23, -5.5, 7, { color: 0x00ff00 })]);
    expect(decode('not json')).toEqual([]);
    expect(decode('[[1,2,3],[1,2,3,0,0,1,4,"red"]]')).toEqual([]);
    const many = JSON.stringify(Array.from({ length: MAX_DOTS + 5 }, (_, i) => [i, 0, 0, 0, 0, 1, 4, 0]));
    const loaded = decode(many);
    expect(loaded.length).toBe(MAX_DOTS);
    expect(loaded[0][0]).toBe(5);
  });

  test('settings keep paint values in range', () => {
    expect(hexToInt('#ff4d4d')).toBe(0xff4d4d);
    expect(hexToInt('red')).toBe(0xffffff);
    const settings = applySettings({ ...defaults }, { paintSize: 99, paintColor: 'red', paintKey: 'Escape' });
    expect(settings.paint).toBe(false);
    expect(settings.paintShowRoom).toBe(false);
    expect(settings.paintSize).toBe(32);
    expect(settings.paintColor).toBe(defaults.paintColor);
    expect(settings.paintKey).toBe(defaults.paintKey);
  });
});
