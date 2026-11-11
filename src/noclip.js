// Noclip, like KSF's: a key toggles flying through walls. It only ever runs in
// the game's own practice mode, so a noclipped run can't be submitted, saved
// as a best or recorded. While flying, the live session's tick is replaced:
// no collision, gravity, zones, timer or recorded commands.
const RAD = Math.PI / 180;
const ZERO = Object.freeze({x: 0, y: 0, z: 0});

// Your movement keys fly along the view (Z up, pitch positive looking down);
// jump rises and crouch sinks. Diagonals are no faster.
export function noclipVelocity(command, view, speed) {
  const yaw = (view?.yaw ?? 0) * RAD, pitch = (view?.pitch ?? 0) * RAD;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f = Math.sign(command?.forward || 0), s = Math.sign(command?.side || 0), u = (command?.jump ? 1 : 0) - (command?.duck ? 1 : 0);
  const x = cy * cp * f + sy * s, y = sy * cp * f - cy * s, z = -sp * f + u;
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return {...ZERO};
  return {x: x / length * speed, y: y / length * speed, z: z / length * speed};
}

// The keys you physically hold, by your Surfd bindings, so every direction
// combines. Neither the game's command nor its held-key set will do: null binds
// drop the losing one of forward and jump from both.
export function heldCommand(keys, bindings, fallback) {
  if (!(keys instanceof Set) || !bindings || typeof bindings !== 'object') return fallback;
  const held = action => Array.isArray(bindings[action]) && bindings[action].some(code => keys.has(code)) ? 1 : 0;
  return {forward: held('forward') - held('back'), side: held('right') - held('left'), jump: !!held('jump'), duck: !!held('duck')};
}

// The game draws between previous and state, so previous takes this tick's start.
function copyState(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && 'x' in value) {
      if (target[key] && typeof target[key] === 'object' && target[key] !== value) Object.assign(target[key], value);
      else if (target[key] !== value) target[key] = {...value};
    } else if (typeof value !== 'object' || value === null) target[key] = value;
  }
}

export function flyTick(session, command, view, speed) {
  const state = session.state, dt = session.config?.dt > 0 ? session.config.dt : 0.015;
  if (session.previous && session.previous !== state) copyState(session.previous, state);
  const velocity = noclipVelocity(command, view, speed);
  state.position.x += velocity.x * dt;
  state.position.y += velocity.y * dt;
  state.position.z += velocity.z * dt;
  Object.assign(state.velocity, velocity);
  state.grounded = false;
  if ('groundId' in state) state.groundId = null;
  if (Number.isFinite(view?.yaw)) state.yaw = view.yaw;
  if (Number.isFinite(view?.pitch)) state.pitch = view.pitch;
  if (Number.isFinite(state.tick)) state.tick++;
  return [];
}

export function createNoclip({getAdapter, settings, events = globalThis, defer = queueMicrotask}) {
  let active = null, installed = null, destroyed = false;
  // Physical keys and mouse buttons, named as Surfd's bindings name them.
  const pressed = new Set();
  const notice = text => { try { getAdapter()?.notice?.(text); } catch { /* notices are optional */ } };
  const live = adapter => {
    const session = adapter?.getSession?.(), input = adapter?.getInput?.(), view = adapter?.getView?.();
    if (!session?.state?.position || typeof session.capturePractice !== 'function' || typeof session.restorePractice !== 'function'
      || typeof session.practiceKey !== 'function') return null;
    if (!input?.locked || input.suppressed || view?.target || view?.view || adapter.replay?.playback?.()?.replay) return null;
    return session;
  };
  const restore = (session, snapshot) => session.restorePractice({...snapshot, key: session.practiceKey(), startPosition: session.startPosition ?? null});

  function install(adapter) {
    if (installed?.adapter === adapter) return;
    uninstall();
    const prototype = adapter.Session.prototype, original = prototype.step;
    if (typeof original !== 'function') throw new Error('Unsupported Surfd build: session step');
    const wrapper = function (command) {
      if (!active || this !== active.session) return original.apply(this, arguments);
      if (getAdapter() !== adapter || adapter.getSession() !== this) { active = null; return original.apply(this, arguments); }
      // Turning the setting off lands you where you are, once this tick is done.
      if (settings.noclip !== true) { defer(stop); return original.apply(this, arguments); }
      try {
        const keys = heldCommand(pressed, adapter.getBindings?.(), command);
        return flyTick(this, keys, adapter.previewView?.get?.() ?? this.state, settings.noclipSpeed);
      }
      catch (error) {
        active = null;
        console.warn('[Surfd QoL] Noclip stopped:', error);
        return original.apply(this, arguments);
      }
    };
    prototype.step = wrapper;
    installed = {adapter, restore: () => { if (prototype.step === wrapper) prototype.step = original; }};
  }
  function uninstall() { installed?.restore(); installed = null; }

  function start() {
    const adapter = getAdapter(), session = live(adapter);
    if (!session) return false;
    try {
      install(adapter);
      // Practice first: a run that never counts is the only kind noclip touches.
      if (session.practice !== true) {
        const result = restore(session, session.capturePractice());
        if (result === false || session.practice !== true) { notice('Noclip needs practice mode, which couldn’t start here.'); return false; }
      }
    } catch (error) {
      console.warn('[Surfd QoL] Noclip unavailable:', error);
      notice('Noclip isn’t available in this version of Surfd.');
      return false;
    }
    active = {session};
    notice('Noclip on.');
    return true;
  }
  // Leaving restores practice where you are, at rest, so the game's movement picks up cleanly.
  function stop() {
    if (!active) return;
    const {session} = active;
    active = null;
    if (getAdapter()?.getSession?.() !== session) return;
    try {
      const snapshot = session.capturePractice();
      if (snapshot?.state) restore(session, {...snapshot, state: {...snapshot.state, velocity: {...ZERO}, grounded: false}});
      else Object.assign(session.state.velocity, ZERO);
    } catch { Object.assign(session.state.velocity, ZERO); }
    notice('Noclip off.');
  }
  const toggle = () => (active ? (stop(), false) : start());
  const keydown = event => {
    if (event.code) pressed.add(event.code);
    if (event.repeat || event.code !== settings.noclipKey || settings.noclip !== true) return;
    toggle();
  };
  const keyup = event => { pressed.delete(event.code); };
  const buttonDown = event => { pressed.add(`Mouse${event.button}`); };
  const buttonUp = event => { pressed.delete(`Mouse${event.button}`); };
  const release = () => pressed.clear();
  const listeners = [['keydown', keydown], ['keyup', keyup], ['mousedown', buttonDown], ['mouseup', buttonUp], ['blur', release]];
  for (const [type, listener] of listeners) events.addEventListener?.(type, listener, true);
  events.document?.addEventListener?.('pointerlockchange', release);
  return {
    get active() { return !!active; },
    toggle,
    stop,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [type, listener] of listeners) events.removeEventListener?.(type, listener, true);
      events.document?.removeEventListener?.('pointerlockchange', release);
      active = null;
      uninstall();
    },
  };
}
