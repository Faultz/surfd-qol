import {describe, expect, test} from 'bun:test';
import {createNoclip, flyTick, heldCommand, noclipVelocity} from '../src/noclip.js';
import {applySettings, defaults} from '../src/settings.js';

const close = (value, expected) => { for (const key of ['x', 'y', 'z']) expect(value[key]).toBeCloseTo(expected[key]); };

// A stand-in for the game: step() moves by velocity and falls; practice restores flag the session.
function game({practiceWorks = true} = {}) {
  class Session {
    constructor() {
      this.state = {position: {x: 0, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}, grounded: true, groundId: 3, yaw: 0, pitch: 0, tick: 10};
      this.previous = {position: {x: 0, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}, tick: 9};
      this.config = {dt: 0.01};
      this.practice = false;
      this.steps = 0;
      this.restores = [];
    }
    step() { this.steps++; this.state.velocity.z -= 8; this.state.position.z += this.state.velocity.z * 0.01; return ['tick']; }
    capturePractice() { return {key: 'k', state: structuredClone(this.state), timer: {}}; }
    practiceKey() { return 'k'; }
    restorePractice(snapshot) {
      this.restores.push(snapshot);
      if (!practiceWorks) return false;
      this.practice = true;
      this.state = structuredClone(snapshot.state);
      return true;
    }
  }
  const session = new Session(), notices = [], listeners = {};
  let view = {yaw: 0, pitch: 0}, replay = null;
  const adapter = {Session, getSession: () => session, getInput: () => ({locked: true, suppressed: false}), getView: () => ({target: null, view: null}),
    previewView: {get: () => view}, replay: {playback: () => ({replay})}, notice: text => notices.push(text)};
  const settings = applySettings({...defaults}, {noclip: true});
  const events = {addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; }};
  const noclip = createNoclip({getAdapter: () => adapter, settings, events, defer: fn => fn()});
  return {Session, session, adapter, settings, notices, noclip,
    press: code => { listeners.keydown?.({code, repeat: false}); listeners.keyup?.({code}); },
    key: (type, code) => listeners[type]?.({code, repeat: false}),
    look: next => { view = next; }, watch: value => { replay = value; }, original: Session.prototype.step};
}

describe('noclip flight', () => {
  test('flies along the view, with jump and crouch for up and down', () => {
    close(noclipVelocity({forward: 400}, {yaw: 0, pitch: 0}, 800), {x: 800, y: 0, z: 0});
    // Positive side is right; yaw 90 faces +y.
    close(noclipVelocity({side: 400}, {yaw: 0, pitch: 0}, 800), {x: 0, y: -800, z: 0});
    close(noclipVelocity({forward: 400}, {yaw: 90, pitch: 0}, 800), {x: 0, y: 800, z: 0});
    // Pitch positive looks down.
    close(noclipVelocity({forward: 400}, {yaw: 0, pitch: 90}, 800), {x: 0, y: 0, z: -800});
    close(noclipVelocity({jump: true}, {yaw: 0, pitch: 0}, 500), {x: 0, y: 0, z: 500});
    close(noclipVelocity({duck: true}, {yaw: 0, pitch: 0}, 500), {x: 0, y: 0, z: -500});
    const diagonal = noclipVelocity({forward: 400, side: -400}, {yaw: 0, pitch: 0}, 800);
    expect(Math.hypot(diagonal.x, diagonal.y, diagonal.z)).toBeCloseTo(800);
    expect(noclipVelocity({}, {yaw: 0, pitch: 0}, 800)).toEqual({x: 0, y: 0, z: 0});
  });

  test('reads held keys by your bindings, so rising never cancels forward', () => {
    const bindings = {forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'], jump: ['Space', 'WheelDown'], duck: ['ControlLeft']};
    const keys = new Set(['KeyW', 'Space', 'KeyD']);
    // The game's command after a null bind: jump won, forward is gone.
    const nulled = {forward: 0, side: 400, jump: true, duck: false};
    const command = heldCommand(keys, bindings, nulled);
    expect(command).toEqual({forward: 1, side: 1, jump: true, duck: false});
    const velocity = noclipVelocity(command, {yaw: 0, pitch: 0}, 900);
    expect(velocity.x).toBeGreaterThan(0);
    expect(velocity.z).toBeGreaterThan(0);
    expect(velocity.y).toBeLessThan(0);
    expect(heldCommand(new Set(['KeyW', 'KeyS']), bindings, nulled).forward).toBe(0);
    expect(heldCommand(new Set(['Mouse3']), {...bindings, jump: ['Mouse3']}, nulled).jump).toBe(true);
    // Without bindings, the game's command is used.
    expect(heldCommand(keys, null, nulled)).toBe(nulled);
  });

  test('a flying tick moves without gravity and keeps the drawn interpolation', () => {
    const {session} = game();
    session.state.position = {x: 5, y: 0, z: 0};
    expect(flyTick(session, {forward: 400}, {yaw: 0, pitch: 0}, 1000)).toEqual([]);
    expect(session.state.position).toEqual({x: 15, y: 0, z: 0});
    expect(session.previous.position).toEqual({x: 5, y: 0, z: 0});
    expect(session.previous.tick).toBe(10);
    expect(session.state.tick).toBe(11);
    expect(session.state.grounded).toBe(false);
    expect(session.state.groundId).toBeNull();
    expect(session.state.velocity).toEqual({x: 1000, y: 0, z: 0});
  });
});

describe('noclip toggle', () => {
  test('enters practice first, flies through the session’s step, and lands at rest', () => {
    const {session, Session, noclip, press, key, notices, original, adapter} = game();
    press('KeyV');
    expect(noclip.active).toBe(true);
    expect(session.practice).toBe(true);
    expect(notices).toEqual(['Noclip on.']);
    const steps = session.steps;
    for (let i = 0; i < 10; i++) session.step({forward: 400});
    expect(session.state.position.x).toBeCloseTo(80);
    // Holding forward and jump together climbs and moves forward, even when a
    // null bind has dropped one from both the game's command and its key set.
    adapter.getInput = () => ({locked: true, suppressed: false, keys: new Set(['KeyW'])});
    adapter.getBindings = () => ({forward: ['KeyW'], jump: ['Space']});
    key('keydown', 'KeyW'); key('keydown', 'Space');
    session.step({forward: 400, jump: false});
    expect(session.state.position.x).toBeGreaterThan(80);
    expect(session.state.position.z).toBeGreaterThan(0);
    key('keyup', 'KeyW'); key('keyup', 'Space');
    const resting = {...session.state.position};
    session.step({forward: 400});
    expect(session.state.position).toEqual(resting);
    session.state.position = {x: 80, y: 0, z: 0};
    // The game's own step, with its gravity and zones, never ran.
    expect(session.steps).toBe(steps);
    expect(session.state.position.x).toBeCloseTo(80);
    expect(session.state.position.z).toBe(0);
    press('KeyV');
    expect(noclip.active).toBe(false);
    expect(session.restores.at(-1).state.velocity).toEqual({x: 0, y: 0, z: 0});
    expect(session.state.position.x).toBeCloseTo(80);
    session.step({});
    expect(session.steps).toBe(steps + 1);
    noclip.destroy();
    expect(Session.prototype.step).toBe(original);
  });

  test('refuses when practice can’t start, so a counting run is never noclipped', () => {
    const {session, noclip, press, notices} = game({practiceWorks: false});
    press('KeyV');
    expect(noclip.active).toBe(false);
    session.step({forward: 400});
    expect(session.steps).toBe(1);
    expect(notices.at(-1)).toMatch(/practice/);
  });

  test('ignores the key when off, in replays, while spectating or in menus', () => {
    const off = game();
    off.settings.noclip = false;
    off.press('KeyV');
    expect(off.noclip.active).toBe(false);
    const watching = game();
    watching.watch({});
    watching.press('KeyV');
    expect(watching.noclip.active).toBe(false);
    const menus = game();
    menus.adapter.getInput = () => ({locked: false});
    menus.press('KeyV');
    expect(menus.noclip.active).toBe(false);
    const spectating = game();
    spectating.adapter.getView = () => ({target: 2, view: null});
    spectating.press('KeyV');
    expect(spectating.noclip.active).toBe(false);
  });

  test('ends when the setting goes off or the session changes', () => {
    const {session, noclip, press, settings, adapter, Session} = game();
    press('KeyV');
    settings.noclip = false;
    session.step({forward: 400});
    expect(noclip.active).toBe(false);
    settings.noclip = true;
    press('KeyV');
    const next = new Session();
    adapter.getSession = () => next;
    session.step({forward: 400});
    expect(noclip.active).toBe(false);
  });

  test('other sessions, like replays simulated alongside, always run normally', () => {
    const {Session, noclip, press} = game();
    press('KeyV');
    const shadow = new Session();
    shadow.step({forward: 400});
    expect(shadow.steps).toBe(1);
    expect(noclip.active).toBe(true);
  });

  test('settings keep the noclip key and speed in range', () => {
    expect(defaults.noclip).toBe(false);
    const settings = applySettings({...defaults}, {noclipSpeed: 99999, noclipKey: 'Escape'});
    expect(settings.noclipSpeed).toBe(3000);
    expect(settings.noclipKey).toBe('KeyV');
  });
});
