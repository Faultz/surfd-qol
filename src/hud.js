import {createCheckpointReferences} from './references.js';
import {createRunReferences} from './run-references.js';
import {isSurfContext} from './visibility.js';
import {createReferenceReplayStore} from './replay-store.js';
import {createHudModel, formatTime} from './hud-model.js';
import {createEnergyTrend, energySample} from './energy.js';
import {hudMarkup, createHudView, installFonts} from './hud-view.js';
import {hudStyles} from './hud-styles.js';
import {panelStyles} from './panel-styles.js';
import {launcherMarkup, zenMarkup, panelMarkup, createSettingsPanel} from './settings-panel.js';
import {runsLauncherMarkup, runsMarkup, createRunsPanel, bestFinish} from './runs-panel.js';
import {runsStyles} from './runs-styles.js';
import {replayBarMarkup, replayBarStyles} from './replay-bar.js';
import {createReplayUi, nativeExtrasMarkup, nativeExtrasStyles} from './native-replay-ui.js';
import {defaults} from './settings.js';
import {strafePreviewMarkup, strafePreviewStyles, createStrafePreviewIndicator} from './strafe-preview-ui.js';
import {cinemaMarkup, cinemaStyles, createCinemaUi} from './cinema-ui.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const hex = (value, fallback) => /^#[\da-f]{6}$/i.test(value) ? value : fallback;
const PALETTE = [['speedColor', '--accent'], ['goodColor', '--good'], ['warnColor', '--warn'], ['badColor', '--bad']];

// `services` lets the dev harness replace reference loading with fixtures.
export function mountHud({getState, getView, getMetrics, getSession, getReferences, getAdapter, settings, onSettings, onResetColors, bindings, history, replays, replayControl, rampReference, strafePreview = null, cinema = null, paint = null, services = {}}) {
  const removeFonts = installFonts();
  const host = document.createElement('div');
  host.id = 'surfd-qol';
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = `<style>${hudStyles}${panelStyles}${runsStyles}${replayBarStyles}${nativeExtrasStyles}${strafePreviewStyles}${cinemaStyles}</style>
    <section id="overlay" class="hud" aria-label="Surf HUD" hidden>${hudMarkup}</section>${strafePreviewMarkup}
    ${replayBarMarkup}${nativeExtrasMarkup}${cinemaMarkup}
    <div class="launchers"><a id="release-notice" class="update-notice" href="https://eduardr02.github.io/surfd-qol/" target="_blank" rel="noopener noreferrer" hidden></a>${zenMarkup}${runsLauncherMarkup}${launcherMarkup}</div>
    ${panelMarkup}${runsMarkup}`;
  document.documentElement.append(host);
  const overlay = root.getElementById('overlay');
  const releaseNotice = root.getElementById('release-notice');
  let releaseVersion = null;
  const hud = createHudView(overlay);
  const previewIndicator = createStrafePreviewIndicator(root.getElementById('strafe-preview'), strafePreview);

  const nativeStyle = document.createElement('style');
  nativeStyle.textContent = '#telemetry,#center-speed-hud,#split-comparison{display:none!important}';
  document.head.append(nativeStyle);
  nativeStyle.disabled = true;
  // The game's crosshair marks first-person aim; the planned camera has none.
  const cinemaStyle = document.createElement('style');
  cinemaStyle.textContent = '#crosshair{visibility:hidden!important}';
  document.head.append(cinemaStyle);
  cinemaStyle.disabled = true;
  // Replay hull state lives inside the game's own key display, styled to match it.
  const nativeKeys = document.getElementById('keys');
  const hullState = nativeKeys ? document.createElement('span') : null;
  if (hullState) {
    hullState.className = 'surfd-qol-hull-state standing';
    hullState.hidden = true;
    hullState.textContent = 'Hull: standing';
    nativeKeys.append(hullState);
  }
  const hullStyle = document.createElement('style');
  hullStyle.textContent = '#keys .surfd-qol-hull-state{display:block;min-width:0;padding:0;margin-top:4px;font:10px Tahoma,sans-serif;text-shadow:0 1px 2px #000e}#keys .surfd-qol-hull-state[hidden]{display:none!important}#keys .surfd-qol-hull-state.crouched{color:var(--surfd-qol-good,#9ccfd8)}#keys .surfd-qol-hull-state.standing{color:#aaa5a0}';
  document.head.append(hullStyle);

  const replayStore = services.replayStore ?? createReferenceReplayStore({getAdapter});
  const references = services.references ?? createCheckpointReferences({getSession, getReferences, getAdapter, settings, replayStore});
  const runReferences = services.runReferences ?? createRunReferences({getSession, getReferences, getAdapter, settings, replayStore});
  const buildModel = (services.createModel ?? createHudModel)();
  const trend = createEnergyTrend();
  let destroyed = false, lastMotion = null, energyOn = false, energyLive = false;

  function syncSettings() {
    for (const [key, variable] of PALETTE) host.style.setProperty(variable, hex(settings[key], defaults[key]));
    hullState?.style.setProperty('--surfd-qol-good', host.style.getPropertyValue('--good'));
    const scale = clamp(settings.scale, .6, 1.6);
    // Keep the core stack on screen at the extremes of position and size;
    // with no room above for splits, they drop below the feedback instead.
    const top = 84 * scale, bottom = 112 * scale;
    // --reserve keeps the stack above the replay controls while they are up.
    overlay.style.setProperty('--y', `clamp(${top}px, ${clamp(settings.y, 10, 90)}%, calc(100% - ${bottom}px - var(--reserve, 0px)))`);
    const anchor = Math.max(top, Math.min(innerHeight * clamp(settings.y, 10, 90) / 100, innerHeight - bottom));
    overlay.classList.toggle('flip', anchor < 250 * scale);
    overlay.style.setProperty('--scale', scale);
    overlay.style.setProperty('--opacity', clamp(settings.opacity, .25, 1));
    previewIndicator.place({'--y': overlay.style.getPropertyValue('--y'), '--scale': scale, '--opacity': clamp(settings.opacity, .25, 1)});
    const nextSpeedMs = 1000 / settings.speedFps, nextTimerMs = 1000 / settings.timerFps;
    if (nextSpeedMs !== speedUpdateMs) { speedUpdateMs = nextSpeedMs; speedSample = -1; }
    if (nextTimerMs !== timerUpdateMs) { timerUpdateMs = nextTimerMs; timerSample = -1; }
    if (energyOn !== (settings.speedEnergyColor === true) || energyLive !== (settings.speedEnergyLive === true)) {
      energyOn = settings.speedEnergyColor === true;
      energyLive = settings.speedEnergyLive === true;
      trend.reset();
      hud.setEnergy('neutral', energyLive);
    }
  }
  const panel = createSettingsPanel({
    root, host, settings, bindings, onSettings, strafePreview, paint,
    onResetColors,
    onResetLayout: () => onSettings({y: defaults.y, scale: defaults.scale, opacity: defaults.opacity}),
    onChange() { syncSettings(); render(); },
    onOpen: () => runs.close(),
    storage: history ? {
      usage: () => ({history: history.usage(), replays: replays?.usage?.() ?? null}),
      clear: () => history.clear(),
    } : null,
  });
  const runs = createRunsPanel({root, host, history, replays, replayControl, rampReference, getSession, getReferences, settings, onSettings, now: services.now, onOpen: () => panel.close(),
    onOpenSettings: page => { runs.close(); panel.show(page); }});
  let cinemaUi = null;
  // The replay bar's Runs button opens the panel above the bar, on the replayed run's map.
  const replayBar = replayControl ? createReplayUi({root, host, control: replayControl, getBindings: () => getAdapter?.()?.getBindings?.(),
    getCustom: () => settings.customReplayUi === true, getCinema: () => !!cinema?.comparing && !!cinema?.camera,
    getKind: status => history?.view?.(status.run?.mapKey ?? history.currentMap)?.kind,
    onRuns: rect => runs.toggle(replayBar.status?.run?.mapKey ?? history?.currentMap, rect), held: () => runs.open || !!cinemaUi?.holding}) : null;

  // The runs a replay can have alongside it, from the loaded map's history and leaderboard.
  const ghostInputs = () => {
    const key = history?.currentMap ?? null, refs = getReferences?.() ?? null;
    let data = null;
    try { data = key ? history.view(key) : null; } catch { /* none yet */ }
    return {best: bestFinish(data, {key, session: getSession?.(), refs}), recentBest: data?.recentBest ?? null, refs, archive: replays,
      canWatch: run => { try { return !!replayControl?.canWatch?.(run); } catch { return false; } }};
  };
  cinemaUi = cinema ? createCinemaUi({root, cinema, getSources: ghostInputs, storage: (() => { try { return localStorage; } catch { return null; } })()}) : null;

  function onKey(event) { if (cinemaUi?.handleKey(event)) return; panel.handleKey(event); runs.handleKey(event); replayBar?.handleKey(event); }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  function onPointer(event) { replayBar?.handlePointer(event); }
  for (const type of ['mousedown', 'mouseup', 'wheel']) window.addEventListener(type, onPointer, {capture: true, passive: false});
  window.addEventListener('resize', syncSettings);

  const menu = document.getElementById('menu');
  const windowHost = document.getElementById('window-host');
  const loadingScreen = document.getElementById('loading-screen');
  const finishScreen = document.getElementById('finish');
  const modalDialogs = document.querySelectorAll('dialog');
  function inSurfContext(snapshot, session, view) {
    return isSurfContext(snapshot, session, view, {
      menuOpen: !!menu && !menu.hidden,
      loading: !!loadingScreen && !loadingScreen.hidden,
      finishOpen: !!finishScreen && !finishScreen.hidden,
      blockingWindowOpen: !!windowHost && !windowHost.hidden && !!windowHost.querySelector('.window:not([hidden])'),
      blockingDialogOpen: !!document.querySelector('dialog:modal'),
      pointerLocked: !!document.pointerLockElement,
    });
  }
  let replayVisible = false;
  function refreshMenu(snapshot, session, view) {
    if (arguments.length === 0) {
      snapshot = getState?.();
      session = getSession?.();
      view = getView?.(snapshot);
    }
    const currentView = view ?? snapshot?.spectator ?? null;
    const inSurf = inSurfContext(snapshot, session, currentView);
    const atFinish = !!finishScreen && !finishScreen.hidden;
    // The finish card blocks in-run HUD and menu launchers, not replay controls.
    replayVisible = inSurf || atFinish && !!replayControl?.active;
    replayControl?.setVisible(replayVisible);
    const inMenu = !inSurf && !atFinish && (!loadingScreen || loadingScreen.hidden);
    panel.setAvailable(inMenu);
    runs.setContext({menu: inMenu, replay: replayVisible && !!replayBar?.visible});
    releaseNotice.hidden = !inMenu || releaseVersion === null;
    if (inMenu) placeLauncher();
    const spectator = currentView?.target != null;
    const hasState = spectator ? !!currentView.view?.pose : !!(snapshot?.state ?? session?.state);
    // The planned camera labels its ghosts instead of showing the HUD; first person keeps both.
    setOverlayHidden(settings.hud === false || !inSurf || !hasState || !!cinema?.camera);
    cinemaStyle.disabled = !cinema?.camera;
    // Keep native in-run telemetry suppressed behind open menus while the
    // custom HUD is enabled; disabling the custom HUD restores it.
    nativeStyle.disabled = settings.hud === false || snapshot == null;
    return inSurf;
  }
  // The settings entry sits in the menu's bottom-right dock, just left of the
  // game's own buttons; without that dock it falls back to the corner.
  let dockKey = '';
  function placeLauncher() {
    const rect = document.querySelector('.dock.dock-right')?.getBoundingClientRect();
    const docked = !!rect && rect.width > 0 && rect.height > 0;
    const key = docked ? `${rect.left},${rect.right},${rect.bottom},${rect.height},${innerWidth},${innerHeight}` : '';
    if (key === dockKey) return;
    dockKey = key;
    for (const [name, value] of [['--dock-right', innerWidth - rect?.left + 10], ['--dock-edge', innerWidth - rect?.right],
      ['--dock-bottom', innerHeight - rect?.bottom], ['--dock-height', rect?.height]]) {
      if (docked) host.style.setProperty(name, `${Math.round(value)}px`);
      else host.style.removeProperty(name);
    }
  }
  function setOverlayHidden(hidden) {
    if (overlay.hidden === hidden) return;
    overlay.hidden = hidden;
    if (hidden) { trend.reset(); hud.setEnergy('neutral'); }
  }
  const menuObserver = new MutationObserver(records => {
    for (const {target} of records) {
      if (target === menu || target === windowHost || target === loadingScreen || target === finishScreen ||
        target.matches('.window, dialog')) { refreshMenu(); break; }
    }
  });
  if (menu) menuObserver.observe(menu, {attributes: true, attributeFilter: ['hidden', 'class']});
  if (windowHost) menuObserver.observe(windowHost, {attributes: true, attributeFilter: ['hidden', 'class', 'data-window'], subtree: true});
  for (const element of [loadingScreen, finishScreen]) {
    if (element) menuObserver.observe(element, {attributes: true, attributeFilter: ['hidden']});
  }
  for (const dialog of modalDialogs) menuObserver.observe(dialog, {attributes: true, attributeFilter: ['open']});
  function onPointerLockChange() { refreshMenu(); }
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // Fast path: speed and timer at their own capped rates, straight from the
  // session scalars or the spectator pose. Text is written only on change.
  let speedUpdateMs = 1000 / settings.speedFps, timerUpdateMs = 1000 / settings.timerFps;
  let liveFrame = 0, speedSample = -1, timerSample = -1;
  function renderLive(snapshot, session, view, timestamp) {
    const spectator = view?.target != null;
    const pose = spectator ? view.view?.pose : null;
    const nextSpeedSample = Math.floor(timestamp / speedUpdateMs);
    if (nextSpeedSample > speedSample) {
      speedSample = nextSpeedSample;
      const state = spectator ? pose : snapshot?.state ?? session?.state;
      const speed = spectator ? Math.hypot(pose?.vx, pose?.vy) : Math.hypot(state?.velocity?.x, state?.velocity?.y);
      hud.setSpeed(Number.isFinite(speed) ? speed.toFixed(0) : '—');
      if (energyOn) {
        const sample = energySample(state, session?.config?.dt ?? 0.015, spectator, session?.config);
        // Match the sampled native tick, not the HUD model's 67 ms cadence.
        const contacts = session?.lastResult?.contacts;
        const onRamp = contacts ? contacts.some(({normal}) => normal?.z > 0 && normal.z < session.config.groundNormal)
          : lastMotion === 'surf';
        const result = sample
          ? trend.sample(sample, session?.config?.gravity ?? 800, settings.speedEnergyRamps !== true && onRamp, energyLive)
          : trend.reset();
        hud.setEnergy(result.tone, energyLive);
      }
    }
    const nextTimerSample = Math.floor(timestamp / timerUpdateMs);
    if (nextTimerSample > timerSample) {
      timerSample = nextTimerSample;
      const timer = spectator ? null : snapshot?.run ?? session?.timer?.state;
      hud.setTime(formatTime(spectator ? pose?.seconds : timer?.elapsed));
    }
  }
  function renderLiveFrame(timestamp) {
    liveFrame = 0;
    if (destroyed || overlay.hidden) return;
    if (Math.floor(timestamp / speedUpdateMs) > speedSample || Math.floor(timestamp / timerUpdateMs) > timerSample) {
      renderLive(null, getSession?.(), getView?.() ?? null, timestamp);
    }
    liveFrame = requestAnimationFrame(renderLiveFrame);
  }

  function render() {
    if (destroyed) return;
    const snapshot = getState?.();
    const session = getSession?.();
    const view = getView?.(snapshot) ?? snapshot?.spectator ?? null;
    const spectator = view?.target != null;
    const inSurf = refreshMenu(snapshot, session, view);
    const metrics = spectator ? null : getMetrics?.();
    const active = inSurf && !spectator;
    const refs = references.update(active);
    const runRefs = runReferences.update(metrics?.board, metrics?.surf, metrics?.air, active);
    const model = buildModel({snapshot, session, view, metrics, refs, runRefs, settings, inSurf, bindingStatus: bindings?.status?.()});
    lastMotion = model.motion ?? null;
    if (!overlay.hidden && !liveFrame) {
      speedSample = timerSample = -1;
      renderLive(snapshot, session, view, performance.now());
      liveFrame = requestAnimationFrame(renderLiveFrame);
    }
    hud.render(model);
    if (hullState) {
      if (hullState.hidden !== model.hull.hidden) hullState.hidden = model.hull.hidden;
      if (!model.hull.hidden) {
        const className = `surfd-qol-hull-state ${model.hull.crouched ? 'crouched' : 'standing'}`;
        const label = model.hull.crouched ? 'Hull: crouched' : 'Hull: standing';
        if (hullState.className !== className) hullState.className = className;
        if (hullState.textContent !== label) hullState.textContent = label;
      }
    }
    panel.setStatus(model.status);
    const reserve = `${replayBar?.render(replayVisible) ?? 0}px`;
    replayBar?.setRunsOpen(runs.open);
    // Cinematic actions share the active replay tools. Geometry is measured
    // only when their layout changes, rather than polled on the HUD tick.
    if (cinemaUi && (replayVisible || cinemaUi.shown)) {
      const custom = settings.customReplayUi === true;
      cinemaUi.render({visible: replayVisible && !!replayBar?.visible, custom,
        held: runs.open, tags: !finishScreen || finishScreen.hidden});
    }
    if (overlay.style.getPropertyValue('--reserve') !== reserve) overlay.style.setProperty('--reserve', reserve);
  }

  syncSettings();
  panel.sync();
  render();
  const interval = setInterval(render, 67);
  return {
    setUpdate(update) {
      releaseVersion = typeof update?.version === 'string' && /^\d{1,5}(?:\.\d{1,5}){2,3}$/.test(update.version) ? update.version : null;
      releaseNotice.textContent = releaseVersion ? `Surfd QoL ${releaseVersion} available ↗` : '';
      releaseNotice.title = 'Open the download page for installation and update instructions.';
      refreshMenu();
    },
    observeFinish() { references.observeFinish(); },
    cinemaChanged() { render(); },
    // Dev harness hook: open the panel on a given section.
    showSettings(page) { panel.show(page); },
    // Dev harness hooks: the Runs panel (optionally on a map, with the map list
    // open) and the replay controls' lists.
    showRuns(key, {maps = false, view = 'runs'} = {}) { runs.show(key); runs.showView(view); if (maps) runs.showMaps(); },
    showReplayPopover(name) { replayBar?.showPopover(name); },
    showReplayRuns() { if (replayBar?.visible) runs.show(replayBar.status?.run?.mapKey ?? history?.currentMap, replayBar.anchor()); },
    destroy() {
      destroyed = true;
      replayControl?.setVisible(false);
      clearInterval(interval);
      cancelAnimationFrame(liveFrame);
      references.destroy();
      runReferences.destroy();
      runs.destroy();
      previewIndicator.destroy();
      replayBar?.destroy();
      cinemaUi?.destroy();
      replayStore.destroy?.();
      menuObserver.disconnect();
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      for (const type of ['mousedown', 'mouseup', 'wheel']) window.removeEventListener(type, onPointer, {capture: true});
      window.removeEventListener('resize', syncSettings);
      bindings?.release?.();
      hullState?.remove();
      hullStyle.remove();
      nativeStyle.remove();
      cinemaStyle.remove();
      host.remove();
      removeFonts();
    },
  };
}
