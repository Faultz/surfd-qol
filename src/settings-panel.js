// Settings panel: markup, live preview and control binding. Opened only from
// menus; every change is saved through onSettings immediately.
import {hudMarkup, createHudView} from './hud-view.js';
import {buildMeter} from './hud-model.js';
import {startStrafePreview} from './strafe-preview-ui.js';

const swatch = tone => `<i class="sw ${tone}" aria-hidden="true"></i>`;
const hint = text => text ? `<span class="hint">${text}</span>` : '';
const text = (label, help, id = '') => `<span class="row-text"><span class="row-label"${id ? ` id="${id}"` : ''}>${label}</span>${hint(help)}</span>`;
const toggle = (key, label, help = '', extra = '') =>
  `<label class="row${extra}">${text(label, help)}<input class="switch" type="checkbox" data-setting="${key}"></label>`;
const choice = (key, label, options, help = '', extra = '') =>
  `<div class="row${extra}" role="radiogroup" aria-labelledby="label-${key}" data-group="${key}">${text(label, help, `label-${key}`)}<span class="seg">${
    options.map(([value, name]) => `<label><input type="radio" name="qol-${key}" value="${value}" data-setting="${key}"><span>${name}</span></label>`).join('')
  }</span></div>`;
const range = (key, label, min, max, step, help = '') =>
  `<label class="row">${text(label, help)}<span class="range"><input type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}"><output data-output="${key}"></output></span></label>`;
const number = (key, label, min, max, step, unit, help = '', extra = '') =>
  `<label class="row${extra}">${text(label, help)}<span class="num"><input type="number" min="${min}"${max ? ` max="${max}"` : ''} step="${step}" data-setting="${key}"><span class="unit">${unit}</span></span></label>`;
const cutoff = (key, label, step, unit) =>
  `<input type="number" min="0" step="${step}" data-setting="${key}" aria-label="${label}"><span class="unit">${unit}</span>`;
const color = (key, label) =>
  `<label class="color"><input type="color" data-setting="${key}"><span>${label}</span></label>`;
const references = [['fixed', 'Fixed'], ['pb', 'PB'], ['wr', 'WR']];

// Zen: a mode switch, not a panel, so it is a pressed/unpressed pill.
export const zenMarkup = `<button id="zen" class="launcher zen" type="button" aria-pressed="false" aria-label="Zen mode" title="Zen mode: only the speed, plus your start speed and height" hidden><span class="zen-mark" aria-hidden="true"></span>Zen</button>`;

export const launcherMarkup = `<button id="open" class="launcher" type="button" aria-expanded="false" aria-controls="panel" hidden><span class="mark" aria-hidden="true"></span>QoL</button>`;

export const panelMarkup = `
<section id="panel" role="dialog" aria-labelledby="panel-title" hidden>
  <header class="head">
    <h2 id="panel-title"><span class="mark" aria-hidden="true"></span>Surfd QoL</h2>
    <span class="saved">Changes save automatically</span>
    <button id="close" class="close" type="button" aria-label="Close settings"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
  </header>
  <div class="preview" aria-hidden="true">
    <svg class="scene" viewBox="0 0 560 160" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="pv-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2430"/><stop offset=".55" stop-color="#4a566a"/><stop offset="1" stop-color="#b8a09c"/></linearGradient>
        <radialGradient id="pv-glow" cx=".8" cy=".12" r=".45"><stop offset="0" stop-color="#ffd9c8" stop-opacity=".55"/><stop offset="1" stop-color="#ffd9c8" stop-opacity="0"/></radialGradient>
        <linearGradient id="pv-lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfd1d6"/><stop offset=".6" stop-color="#9097a0"/><stop offset="1" stop-color="#5d646d"/></linearGradient>
        <linearGradient id="pv-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c5560"/><stop offset="1" stop-color="#262c33"/></linearGradient>
      </defs>
      <rect width="560" height="160" fill="url(#pv-sky)"/><rect width="560" height="160" fill="url(#pv-glow)"/>
      <path d="M0 118 L70 104 L132 112 L214 96 L290 109 L362 100 L440 111 L512 99 L560 106 V160 H0Z" fill="#2a323d"/>
      <path d="M-30 160 L118 42 L470 124 L420 160Z" fill="url(#pv-lit)"/>
      <path d="M420 160 L470 124 L500 122 L560 142 V160Z" fill="url(#pv-shade)"/>
    </svg>
    <div class="hud preview-hud">${hudMarkup}</div>
    <div class="history-preview" id="history-preview"></div>
  </div>
  <nav class="tabs" role="tablist" aria-label="Settings sections">
    <button id="tab-display" type="button" role="tab" aria-selected="true" aria-controls="page-display" data-page="display">Display</button>
    <button id="tab-feedback" type="button" role="tab" aria-selected="false" aria-controls="page-feedback" data-page="feedback" tabindex="-1">Feedback</button>
    <button id="tab-compare" type="button" role="tab" aria-selected="false" aria-controls="page-compare" data-page="compare" tabindex="-1">Compare</button>
    <button id="tab-controls" type="button" role="tab" aria-selected="false" aria-controls="page-controls" data-page="controls" tabindex="-1">Controls</button>
    <button id="tab-paint" type="button" role="tab" aria-selected="false" aria-controls="page-paint" data-page="paint" tabindex="-1">Paint</button>
    <button id="tab-history" type="button" role="tab" aria-selected="false" aria-controls="page-history" data-page="history" tabindex="-1">History</button>
  </nav>
  <div class="body">
    <section id="page-display" role="tabpanel" aria-labelledby="tab-display" tabindex="0">
      <div class="group">
        ${toggle('hud', 'Custom HUD', 'Off brings back the game’s own speed and timer.')}
        ${toggle('zen', 'Zen mode', 'Only the speed, plus your start speed and height.')}
        ${choice('surfHud', 'While surfing', [['compact', 'Compact'], ['full', 'Full']], 'Compact keeps the speed, the air and ramp loss under it, and checkpoint deltas. Replays and spectating always show everything.')}
        ${toggle('compactTimer', 'Timer', 'Show the timer above the speed in the compact HUD.', ' sub')}
        ${toggle('compactLabels', 'Value labels', 'Name the values under the speed in the compact HUD.', ' sub')}
        ${toggle('rampBar', 'Ramp bar', 'The bar under the speed: your last flight and ramp, in the order they happened. Off keeps just the values.')}
      </div>
      <h3>Layout</h3>
      <div class="group">
        ${range('y', 'Height on screen', 10, 90, 1)}
        ${range('scale', 'Size', 0.6, 1.6, 0.05)}
        ${range('opacity', 'Opacity', 0.25, 1, 0.05)}
        <div class="actions"><span class="note">Always centered horizontally.</span><button id="reset-layout" class="ghost" type="button">Reset layout</button></div>
      </div>
      <h3>Colors</h3>
      <div class="group">
        <div class="colors">
          ${color('speedColor', 'Speed')}
          ${color('goodColor', 'Better')}
          ${color('warnColor', 'Near')}
          ${color('badColor', 'Worse')}
        </div>
        <div class="actions"><span class="note">Unavailable values stay gray.</span><button id="reset-colors" class="ghost" type="button">Reset colors</button></div>
      </div>
      <h3>Refresh rate</h3>
      <div class="group">
        ${number('speedFps', 'Speed', 1, 1000, 1, 'fps')}
        ${number('timerFps', 'Timer', 1, 1000, 1, 'fps', 'Counters only. The game itself is not affected.')}
      </div>
    </section>

    <section id="page-feedback" role="tabpanel" aria-labelledby="tab-feedback" tabindex="0" hidden>
      <h3>Values</h3>
      <div class="group">
        ${toggle('showBoard', 'Touch', 'Full 3D speed clipped as you touch a ramp, not just horizontal speed.')}
        ${toggle('showSurf', 'Ramp', 'Full 3D speed deficit against gravity-only height conversion on the last ramp.')}
        ${choice('rampResult', 'Show as', [['split', 'Down + Up'], ['total', 'Net Surf']], 'Split into the way down and the way up, or one net value. Both include the touch.', ' sub')}
        ${toggle('showAir', 'Air', 'Horizontal input braking and missed strafe gain over your last flight, not net energy loss.')}
        ${choice('airMetric', 'Count', [['missed', 'Missed gain'], ['braking', 'Braking'], ['combined', 'Both']], '<span id="air-explain"></span>', ' sub')}
        ${toggle('showSync', 'Strafe sync')}
        ${toggle('showStart', 'Start speed and height', 'Shown for a moment as you leave the start.')}
      </div>
      <h3>Speed tint</h3>
      <div class="group">
        ${toggle('speedEnergyColor', 'Tint speed by energy', `${swatch('energy')}while mechanical energy falls: full 3D velocity plus height. Gravity-only conversion and airborne crouch shifts don’t count.`)}
        ${toggle('speedEnergyRamps', 'Include ramps', `Also count ramp collision and friction losses.`, ' sub')}
        ${toggle('speedEnergyLive', 'Instant', 'No averaging or fade between sampled ticks. Frame rate can skip ticks; skipped crouch transitions reset the baseline because their height shift is ambiguous.', ' sub')}
      </div>
      <h3>Live mode</h3>
      <div class="group">
        ${toggle('continuousFeedback', 'Live feedback', 'Values update continuously instead of holding each result.')}
        ${range('strafeLookbackSeconds', 'Live window', 0.05, 0.5, 0.05, 'How much recent movement each live value covers.')}
      </div>
    </section>

    <section id="page-compare" role="tabpanel" aria-labelledby="tab-compare" tabindex="0" hidden>
      <h3>Checkpoints</h3>
      <div class="group">
        ${choice('checkpointReference', 'Compare with', [['pb', 'PB'], ['wr', 'WR'], ['both', 'Both']])}
        ${choice('wrSource', 'World record', [['ksf', 'KSF route'], ['leaderboard', 'Surfd #1']], 'KSF is the map’s record route; Surfd #1 is the leaderboard’s top run. Also used for WR colors.')}
        <p class="explain">Checkpoint speed is horizontal only, not an energy comparison. Start speed and platform height are independent targets, not an overall grade.</p>
      </div>
      <h3>Grade colors against</h3>
      <div class="group">
        ${choice('boardColorReference', 'Touch', references)}
        ${choice('surfColorReference', 'Ramp', references, 'Down, Up and Surf.')}
        ${choice('airColorReference', 'Air', references, 'The same flight, using the Air measurement selected in Feedback.')}
        ${choice('startColorReference', 'Start', references)}
        ${number('referenceLossTolerance', 'Near margin', 0, 0, 0.1, 'u/s', 'How much worse than PB or WR still counts as near. Start has no near band.')}
        <div class="legend" aria-label="Color key">
          <span>${swatch('good')}Equal or better</span><span>${swatch('warn')}Within the margin</span><span>${swatch('loss')}Worse</span><span>${swatch('muted')}No data</span>
        </div>
      </div>
      <details class="group">
        <summary><span class="row-label">Fixed cutoffs</span><span class="hint">Used wherever Fixed is picked above.</span></summary>
        <div class="cutoffs" role="table" aria-label="Fixed cutoffs">
          <span role="columnheader"></span><span role="columnheader">${swatch('good')}below</span><span role="columnheader">${swatch('warn')}below</span>
          <span role="rowheader">Start height</span><span class="num">${cutoff('startHeightAmazing', 'Start height, better below', 0.1, 'u')}</span><span class="num">${cutoff('startHeightGood', 'Start height, near below', 0.1, 'u')}</span>
          <span role="rowheader">Start speed short of cap</span><span class="num">${cutoff('startDeficitAmazing', 'Start speed shortfall, better below', 0.1, 'u/s')}</span><span class="num">${cutoff('startDeficitGood', 'Start speed shortfall, near below', 0.1, 'u/s')}</span>
          <span role="rowheader">Touch loss</span><span class="num">${cutoff('boardLossAmazing', 'Touch loss, better below', 0.5, 'u/s')}</span><span class="num">${cutoff('boardLossGood', 'Touch loss, near below', 0.5, 'u/s')}</span>
          <span role="rowheader">Air and ramp loss</span><span class="num">${cutoff('airLossAmazing', 'Air and ramp loss, better below', 0.5, 'u/s')}</span><span class="num">${cutoff('airLossGood', 'Air and ramp loss, near below', 0.5, 'u/s')}</span>
        </div>
        <p class="explain">Anything else is ${swatch('loss')}worse. Sync uses the game’s own steps: ${swatch('good')}95% ${swatch('warn')}85% ${swatch('loss')}below.</p>
      </details>
    </section>

    <section id="page-controls" role="tabpanel" aria-labelledby="tab-controls" tabindex="0" hidden>
      <h3>Crouch-jump</h3>
      <div class="group">
        ${toggle('crouchJump', 'Crouch-jump', 'Adds a one-tick crouch to every jump.')}
        <div class="row"><span class="row-text"><span class="row-label" id="key-label">Jump key</span><span class="hint" id="key-help" role="status"></span></span><button id="key" class="keycap" type="button" aria-labelledby="key-label key" aria-describedby="key-help"></button></div>
      </div>
      <h3>Null binds</h3>
      <div class="group">
        ${toggle('nullAD', 'Left / Right', 'Uses your movement bindings in Surfd’s settings.')}
        ${toggle('nullWSpace', 'Forward / Jump', 'Uses your bindings, including extra keys. Latest press wins; release it to resume the other action.')}
      </div>
      <h3>Noclip</h3>
      <div class="group">
        ${toggle('noclip', 'Noclip', 'Press the noclip key to fly through walls, like KSF’s noclip. It puts you in practice first, so the run never counts, and leaves you in practice where you stop.')}
        <div class="row sub"><span class="row-text"><span class="row-label" id="noclip-key-label">Noclip key</span><span class="hint" id="noclip-key-help" role="status"></span></span><button id="noclip-key" class="keycap" type="button" data-capture="noclipKey" data-gate="noclip" data-help="noclip-key-help" data-name="noclip" aria-labelledby="noclip-key-label noclip-key" aria-describedby="noclip-key-help"></button></div>
        ${range('noclipSpeed', 'Fly speed', 100, 3000, 50, 'Your movement keys fly where you look; jump rises and crouch sinks.')}
      </div>
      <div id="strafe-preview-settings">
        <h3>Strafe preview</h3>
        <div class="group">
          ${number('strafePreviewUnits', 'Speed', 1, 5000, 1, 'u/s')}
          ${choice('strafePreviewMode', 'Strafe', [['ground', 'Ground'], ['air', 'Air']], 'Ground is the prestrafe in the start zone.')}
          <div class="row"><span class="row-text"><span class="row-label" id="preview-label">Preview</span><span class="hint" id="preview-help" role="status"></span></span><button id="preview-start" class="ghost" type="button" aria-labelledby="preview-start preview-label" aria-describedby="preview-help">Start</button></div>
        </div>
      </div>
    </section>

    <section id="page-paint" role="tabpanel" aria-labelledby="tab-paint" tabindex="0" hidden>
      <div class="group">
        ${toggle('paint', 'World paint', 'Hold the paint key to mark the surface you aim at, like KSF’s !paint. In a private room everyone there sees it; alone, it’s saved per map for you.')}
      </div>
      <h3>Keys</h3>
      <div class="group">
        <div class="row"><span class="row-text"><span class="row-label" id="paint-key-label">Paint</span><span class="hint" id="paint-key-help" role="status"></span></span><button id="paint-key" class="keycap" type="button" data-capture="paintKey" data-gate="paint" data-help="paint-key-help" data-name="the paint key" aria-labelledby="paint-key-label paint-key" aria-describedby="paint-key-help"></button></div>
        <div class="row"><span class="row-text"><span class="row-label" id="paint-erase-label">Erase</span><span class="hint" id="paint-erase-help" role="status"></span></span><button id="paint-erase-key" class="keycap" type="button" data-capture="paintEraseKey" data-gate="paint" data-help="paint-erase-help" data-name="the erase key" aria-labelledby="paint-erase-label paint-erase-key" aria-describedby="paint-erase-help"></button></div>
      </div>
      <h3>Look</h3>
      <div class="group">
        <label class="row">${text('Color', '')}<input class="paint-color" type="color" data-setting="paintColor"></label>
        ${range('paintSize', 'Dot size', 1, 32, 1, 'Radius in map units.')}
      </div>
      <h3>Private rooms</h3>
      <div class="group">
        ${toggle('paintShowRoom', 'Show room paint', 'Everyone’s paint in a private room, yours included. Off hides it all. Room paint clears when the map changes or the room closes.')}
      </div>
      <h3>This map</h3>
      <div class="group">
        <div class="actions"><span class="note" id="paint-note" role="status"></span>
          <span class="clear-buttons"><button id="paint-clear" class="ghost" type="button">Clear this map</button><button id="paint-clear-all" class="ghost" type="button" hidden>Remove all paint</button></span></div>
      </div>
    </section>

    <section id="page-history" role="tabpanel" aria-labelledby="tab-history" tabindex="0" hidden>
      <div class="group">
        ${toggle('keepHistory', 'Record runs', 'Keeps your attempts and their replays in this browser.')}
        ${number('historyRunsPerMap', 'Runs kept per map', 3, 100, 1, 'runs', '', ' sub')}
        ${number('historyMinSeconds', 'Skip short resets', 0, 300, 1, 's', '', ' sub')}
      </div>
      <p id="history-rule" class="hist-rule" role="status"></p>
      <h3>Playback</h3>
      <div class="group">
        ${toggle('customReplayUi', 'Custom replay bar', 'Surfd QoL’s timeline with ramp touches, savelocs and Runs. Turn off to use Surfd’s own bar.')}
      </div>
      <h3>Storage</h3>
      <div class="group hist-store">
        <div class="hist-total"><b id="size-total"></b><span id="size-where">in this browser only</span></div>
        <div class="actions clear-row"><span class="note" id="clear-note" role="status"></span>
          <span class="clear-buttons"><button id="clear-cancel" class="ghost" type="button" hidden>Cancel</button><button id="clear-history" class="ghost" type="button">Clear all</button></span></div>
      </div>
    </section>
  </div>
  <p id="status" class="status" role="status"></p>
</section>`;

const AIR_EXPLAIN = {
  missed: 'Speed a better strafe could have added. Chasing every gain can lengthen your line.',
  braking: 'Speed your own input took away. Tight turns can need some.',
  combined: 'Missed gain plus braking. Tight turns can need some braking.',
};
const KEY_HELP = 'Click, then press the new key. Esc cancels.';
const PREVIEW_HELP = 'Turns your view like a good strafe at that speed, with the key to hold. Stand still in the start zone; any key or mouse movement stops it.';

// The preview HUD follows the palette and feedback options but shows sample
// measurements, never real ones: a flight, then a finished ramp.
const PREVIEW_METRICS = {air: {available: true, loss: 3.2, brakingLoss: 1.4, missedGain: 1.8, tick: 10},
  board: {available: true, loss: 2.6, tick: 20}, surf: {available: true, loss: 52.7, downLoss: 14.6, upLoss: 38.1, tick: 30}};
const PREVIEW_REFERENCE = {board: {status: 'ready', loss: 3.1}, surf: {status: 'ready', loss: 46.6},
  down: {status: 'ready', loss: 15.2}, up: {status: 'ready', loss: 31.4}};
const PREVIEW_AIR_REFERENCE = {loss: 2.8, brakingLoss: 1.2, missedGain: 1.6};

export function previewModel(settings) {
  const live = settings.continuousFeedback === true;
  const split = settings.rampResult !== 'total';
  const ramp = settings.showSurf !== false, air = settings.showAir !== false;
  const value = (hidden, label, text, tone) => ({hidden, label, text, tone, title: '', stale: false});
  const result = live
    ? value(!air && !ramp, air ? 'STRAFE' : 'INPUT', '−0.4', 'good')
    : ramp ? value(false, split ? 'DOWN' : 'SURF', split ? '−14.6' : '−52.7', 'warn')
      : value(!air, settings.airMetric === 'missed' ? 'MISSED' : settings.airMetric === 'braking' ? 'BRAKE' : 'AIR', '−9.8', 'warn');
  const board = value(settings.showBoard === false, 'TOUCH', '−3.2', 'good');
  const up = value(live || !ramp || !split, 'UP', '−38.1', 'loss');
  const zen = settings.zen === true;
  const layout = zen ? 'zen' : settings.surfHud === 'full' ? 'full' : 'surf';
  const timer = layout !== 'surf' || settings.compactTimer === true;
  const airField = settings.airMetric === 'braking' ? 'brakingLoss' : settings.airMetric === 'missed' ? 'missedGain' : 'loss';
  const refs = {...PREVIEW_REFERENCE, air: {status: 'ready', loss: PREVIEW_AIR_REFERENCE[airField]}};
  return {
    zen, layout, compactLabels: settings.compactLabels !== false, clock: {hidden: zen || !timer}, time: {hidden: !timer},
    sync: {hidden: zen || layout === 'surf' || settings.showSync === false, text: '96.4%', tone: 'good'},
    runState: {text: '', title: ''},
    feedback: {hidden: zen || !live || (result.hidden && board.hidden && up.hidden), result, board, up},
    meter: zen || live ? {hidden: true} : buildMeter(PREVIEW_METRICS, refs, settings),
    start: {hidden: true},
    startSync: {hidden: true},
    checkpoint: {hidden: true},
  };
}

// Sizes for the Storage row: KB below a megabyte, then MB.
export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
// The History tab's preview, in the HUD preview's place: what one map keeps,
// as slanted bars. The best finish, the newest runs (short resets fall away)
// and the latest attempt.
export function historyPreview(settings) {
  const off = settings.keepHistory === false, runs = settings.historyRunsPerMap, short = settings.historyMinSeconds > 0;
  const shown = Math.min(runs, 20), heights = [22, 30, 18, 26, 34, 20, 28, 24, 31, 19, 27, 23, 33, 21, 29, 25, 17, 30, 22, 26];
  const bars = [];
  for (let i = 0; i < shown; i++) {
    // A skipped short reset now and then, faded out of the row.
    if (short && (i === 2 || i === 7 || i === 13)) bars.push('<i class="skip"></i>');
    bars.push(`<i style="height:${heights[i]}px"></i>`);
  }
  return `<div class="hp${off ? ' off' : ''}">
    <div class="hp-group"><div class="hp-bars"><i class="best" style="height:30px"></i></div><span>best finish</span></div>
    <div class="hp-group"><div class="hp-bars">${bars.join('')}${runs > shown ? `<b>+${runs - shown}</b>` : ''}</div><span>${runs} newest runs</span></div>
    <div class="hp-group"><div class="hp-bars"><i class="latest" style="height:12px"></i></div><span>latest</span></div>
  </div><p class="hp-note">${off ? 'Recording is off' : short ? `resets under ${settings.historyMinSeconds} s are skipped` : 'every reset counts'}</p>`;
}
// What the History settings keep, said as one plain sentence (HTML).
export function historyRule(settings) {
  if (settings.keepHistory === false) return 'Recording is off. Nothing new is added, and what you already have stays until you clear it.';
  const runs = settings.historyRunsPerMap, short = settings.historyMinSeconds;
  return `Each map keeps <b>your ${runs} newest runs</b> with their replays, plus <b>your best finish</b>.${
    short > 0 ? ` Resets under ${short} s are skipped, except your latest run.` : ''} Best checkpoint, ramp and start-speed values stay for good.`;
}

const PAINT_KEY_HELP = 'Click, then press a key. Esc cancels.';

export function createSettingsPanel({root, settings, onSettings, onResetColors, onResetLayout, bindings, host, onChange, onOpen, storage, strafePreview = null, paint = null, keyConflict = null}) {
  const node = id => root.getElementById(id);
  const panel = node('panel'), opener = node('open'), close = node('close'), keyButton = node('key'), keyHelp = node('key-help');
  const body = panel.querySelector('.body');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const controls = [...panel.querySelectorAll('[data-setting]')];
  const outputs = Object.fromEntries([...panel.querySelectorAll('[data-output]')].map(output => [output.dataset.output, output]));
  const previewElement = panel.querySelector('.preview-hud'), zenButton = node('zen');
  let historyShown = '';
  const preview = createHudView(previewElement);
  let capturing = false, available = false;
  const paintCaps = [...panel.querySelectorAll('[data-capture]')];
  const paintProblem = {};
  const write = (element, value) => { if (element.textContent !== value) element.textContent = value; };

  function format(key, value) {
    if (key === 'strafeLookbackSeconds') return `${value.toFixed(2)} s`;
    if (key === 'paintSize') return `${value} u`;
    if (key === 'noclipSpeed') return `${value} u/s`;    if (key === 'y' || key === 'scale' || key === 'opacity') return `${Math.round(value * (key === 'y' ? 1 : 100))}%`;
    return String(value);
  }
  function sync() {
    for (const control of controls) {
      const key = control.dataset.setting, value = settings[key];
      if (control.type === 'checkbox') control.checked = value !== false;
      else if (control.type === 'radio') control.checked = value === control.value;
      else control.value = value;
      if (control.type === 'range') {
        const min = Number(control.min), max = Number(control.max);
        control.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
      }
      if (outputs[key]) write(outputs[key], format(key, value));
    }
    const live = settings.continuousFeedback === true;
    setDisabled('strafeLookbackSeconds', !live);
    setDisabled('speedEnergyRamps', settings.speedEnergyColor !== true);
    setDisabled('speedEnergyLive', settings.speedEnergyColor !== true);
    setDisabled('rampResult', live || settings.showSurf === false);
    setDisabled('airMetric', live || settings.showAir === false);
    const recording = settings.keepHistory !== false;
    setDisabled('historyRunsPerMap', !recording);
    setDisabled('historyMinSeconds', !recording);
    showUsage();
    write(node('air-explain'), AIR_EXPLAIN[settings.airMetric] ?? AIR_EXPLAIN.combined);
    if (capturing !== 'crouchJumpKey') write(keyButton, keyName(settings.crouchJumpKey));
    syncPaint();
    panel.style.setProperty('--opacity', settings.opacity);
    previewElement.classList.toggle('energy', settings.speedEnergyColor === true);
    preview.setSpeed('2950');
    preview.setTime('00:41.233');
    preview.render(previewModel(settings));
    const history = historyPreview(settings);
    if (history !== historyShown) { historyShown = history; node('history-preview').innerHTML = history; }
    setDisabled('zen', settings.hud === false);
    setDisabled('compactTimer', settings.hud === false || settings.zen === true || settings.surfHud === 'full');
    setDisabled('compactLabels', settings.hud === false || settings.zen === true || settings.surfHud === 'full');
    setDisabled('rampBar', settings.hud === false || settings.zen === true || settings.continuousFeedback === true);
    zenButton.setAttribute('aria-pressed', String(settings.zen === true));
  }
  zenButton.addEventListener('click', () => patch({zen: settings.zen !== true}));
  // Storage: what history and replays take in this browser, and Clear all,
  // which asks once before deleting.
  let clearState = 'idle';
  const clearButton = node('clear-history'), cancelButton = node('clear-cancel');
  let ruleShown = '';
  function showUsage() {
    let usage = null;
    try { usage = storage?.usage(); } catch { /* unavailable */ }
    const runs = usage?.history, saved = usage?.replays;
    const all = (runs?.bytes ?? 0) + (saved?.bytes ?? 0);
    write(node('size-total'), usage ? formatBytes(all) : 'Unavailable');
    const rule = historyRule(settings);
    if (rule !== ruleShown) { ruleShown = rule; node('history-rule').innerHTML = rule; }
    node('history-rule').classList.toggle('off', settings.keepHistory === false);
    const empty = !runs?.runs && !runs?.maps && !saved?.count;
    clearButton.hidden = !storage;
    const asking = clearState === 'confirm' || clearState === 'clearing';
    clearButton.disabled = clearState === 'clearing' || (!asking && empty);
    cancelButton.hidden = clearState !== 'confirm';
    write(clearButton, clearState === 'clearing' ? 'Clearing…' : 'Clear all');
    clearButton.classList.toggle('danger', asking);
    write(node('clear-note'), clearState === 'confirm' ? 'Clear all recorded runs and bests on every map? This can’t be undone.'
      : clearState === 'done' ? 'Cleared.' : clearState === 'failed' ? 'Couldn’t clear. Try again.' : '');
    node('clear-note').classList.toggle('warn', clearState === 'confirm' || clearState === 'failed');
  }
  function setClear(next) { clearState = next; showUsage(); }
  clearButton.addEventListener('click', () => {
    if (clearState === 'idle' || clearState === 'done' || clearState === 'failed') { setClear('confirm'); cancelButton.focus(); return; }
    if (clearState !== 'confirm') return;
    setClear('clearing');
    Promise.resolve().then(() => storage?.clear()).then(() => setClear('done'), () => setClear('failed')).then(() => clearButton.focus());
  });
  cancelButton.addEventListener('click', () => { setClear('idle'); clearButton.focus(); });
  function setDisabled(key, disabled) {
    for (const control of controls) {
      if (control.dataset.setting !== key) continue;
      control.disabled = disabled;
      control.closest('.row')?.classList.toggle('off', disabled);
    }
  }
  // Paint and noclip keys: each keycap shows its key, or a warning when Surfd or another of these keys already uses it.
  function syncPaint() {
    const off = settings.paint !== true;
    for (const cap of paintCaps) {
      const key = cap.dataset.capture, code = settings[key], gated = settings[cap.dataset.gate] !== true;
      if (capturing !== key) write(cap, keyName(code));
      cap.disabled = gated;
      cap.closest('.row').classList.toggle('off', gated);
      const twin = paintCaps.find(other => other !== cap && settings[other.dataset.capture] === code);
      const action = keyConflict?.(code);
      const problem = paintProblem[key] ?? (capturing === key ? 'Press any key. Esc cancels.'
        : twin ? `Same key as ${twin.dataset.name}.`
          : action ? `Also ${action} in Surfd; both happen.` : PAINT_KEY_HELP);
      const help = node(cap.dataset.help);
      write(help, problem);
      help.classList.toggle('warn', problem !== PAINT_KEY_HELP && capturing !== key);
    }
    setDisabled('paintColor', off);
    setDisabled('paintSize', off);
    setDisabled('noclipSpeed', settings.noclip !== true);
    const clear = node('paint-clear'), clearAll = node('paint-clear-all');
    const count = paint?.count ?? 0, room = paint?.room === true, host = paint?.host === true;
    const dots = value => `${value} dot${value === 1 ? '' : 's'}`;
    clear.hidden = !paint;
    clear.disabled = room ? !paint.ownCount : !count;
    write(clear, room ? 'Remove my paint' : 'Clear this map');
    clearAll.hidden = !room || !host;
    clearAll.disabled = !count;
    write(node('paint-note'), !paint ? '' : room ? count ? `${dots(count)} in this room` : 'Nothing painted in this room'
      : count ? `${dots(count)} on this map` : 'Nothing painted on this map');
  }
  for (const cap of paintCaps) cap.addEventListener('click', () => {
    if (capturing) cancelCapture();
    capturing = cap.dataset.capture;
    delete paintProblem[capturing];
    cap.classList.add('listening');
    write(cap, 'Press a key');
    syncPaint();
  });
  node('paint-clear').addEventListener('click', () => { paint?.clear(); syncPaint(); });
  node('paint-clear-all').addEventListener('click', () => { paint?.clearAll(); syncPaint(); });
  function keyName(code) {
    const value = code || 'Space';
    return value.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '').replace(/^Arrow/, '').replace(/(Left|Right)$/, ' $1');
  }
  // Strafe preview: hidden without one. Why it can't start replaces the help until the next change, like the jump key's.
  const previewHelp = node('preview-help');
  node('strafe-preview-settings').hidden = !strafePreview;
  const previewNote = (problem = '') => write(previewHelp, problem || PREVIEW_HELP);
  previewNote();
  // Keys held when Start is pressed from the keyboard; the preview waits for
  // their release, which would otherwise stop it at once.
  const held = new Set();
  let previewQueued = false;
  async function startPreview() {
    previewQueued = false;
    const problem = await startStrafePreview(strafePreview, settings);
    previewNote(problem);
    if (!problem) closePanel(true);
  }
  node('preview-start').addEventListener('click', event => {
    if (!strafePreview) return;
    if (event.detail === 0 && held.size) previewQueued = true;
    else startPreview();
  });
  function patch(value) {
    onSettings(value);
    previewNote();
    sync();
    onChange?.();
  }
  for (const control of controls) {
    control.addEventListener(control.type === 'number' ? 'change' : 'input', () => {
      const key = control.dataset.setting;
      if (control.type === 'radio' && !control.checked) return;
      const value = control.type === 'checkbox' ? control.checked
        : control.type === 'number' ? control.valueAsNumber
          : control.type === 'range' ? Number(control.value) : control.value;
      if (key === 'crouchJump') bindings?.release?.();
      if (control.type === 'number' && !Number.isFinite(value)) { sync(); return; }
      patch({[key]: value});
    });
  }

  function cancelCapture() {
    const was = capturing;
    capturing = false;
    keyButton.classList.remove('listening');
    for (const cap of paintCaps) cap.classList.remove('listening');
    write(keyButton, keyName(settings.crouchJumpKey));
    if (was === 'crouchJumpKey' || !was) write(keyHelp, KEY_HELP);
    syncPaint();
  }
  function selectPage(tab) {
    cancelCapture();
    previewNote();
    if (clearState !== 'clearing') setClear('idle');
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      node(`page-${item.dataset.page}`).hidden = !selected;
    }
    body.scrollTop = 0;
  }
  for (const tab of tabs) tab.addEventListener('click', () => selectPage(tab));
  function closePanel(focus = false) {
    cancelCapture();
    held.clear(); previewQueued = false;
    if (clearState !== 'clearing') clearState = 'idle';
    panel.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    if (focus && available) opener.focus();
  }
  opener.addEventListener('click', () => {
    if (!available) return;
    if (!panel.hidden) { closePanel(true); return; }
    onOpen?.();
    bindings?.release?.();
    panel.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    sync();
    close.focus();
  });
  close.addEventListener('click', () => closePanel(true));
  keyButton.addEventListener('click', () => {
    if (capturing) cancelCapture();
    capturing = 'crouchJumpKey';
    bindings?.release?.();
    keyButton.classList.add('listening');
    write(keyButton, 'Press a key');
    write(keyHelp, 'Any physical key. Esc cancels; nothing reaches the game.');
  });
  node('reset-layout').addEventListener('click', () => { onResetLayout(); sync(); onChange?.(); });
  node('reset-colors').addEventListener('click', () => { onResetColors(); sync(); onChange?.(); });
  write(keyHelp, KEY_HELP);

  function handleKey(event) {
    if (panel.hidden || !available) return;
    if (event.type === 'keydown') held.add(event.code);
    else if (event.type === 'keyup' && held.delete(event.code) && !held.size && previewQueued) startPreview();
    const inside = event.composedPath().includes(host);
    if (capturing) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'keydown' || event.repeat) return;
      if (event.code === 'Escape') { cancelCapture(); return; }
      if (capturing !== 'crouchJumpKey') {
        const key = capturing;
        if (!event.code || event.code === 'Unidentified') { paintProblem[key] = 'That key has no physical code. Try another.'; syncPaint(); return; }
        capturing = false;
        for (const cap of paintCaps) cap.classList.remove('listening');
        patch({[key]: event.code});
        return;
      }
      if (!event.code || event.code === 'Unidentified') { write(keyHelp, 'That key has no physical code. Try another.'); return; }
      const accepted = bindings?.setKey?.(event.code);
      if (accepted === false) { write(keyHelp, 'That key can’t be used for crouch-jump. Try a letter, digit or modifier.'); return; }
      capturing = false;
      keyButton.classList.remove('listening');
      patch({crouchJumpKey: event.code});
      write(keyHelp, `Bound to ${keyName(event.code)}.`);
      return;
    }
    if (event.type === 'keydown' && event.code === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closePanel(true); return;
    }
    const tabIndex = tabs.indexOf(event.composedPath()[0]);
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (event.type === 'keydown' && tabIndex !== -1 && keys.includes(event.code)) {
      event.preventDefault();
      const step = event.code === 'ArrowRight' || event.code === 'ArrowDown' ? 1 : -1;
      const index = event.code === 'Home' ? 0 : event.code === 'End' ? tabs.length - 1 : (tabIndex + step + tabs.length) % tabs.length;
      selectPage(tabs[index]);
      tabs[index].focus();
    }
    // Keep settings keystrokes out of the game's global keyboard handlers.
    if (inside) event.stopPropagation();
  }

  return {
    sync,
    handleKey,
    close: closePanel,
    get open() { return !panel.hidden; },
    // Settings are reachable only outside a run (menus).
    setAvailable(next) {
      available = next;
      if (opener.hidden === next) opener.hidden = !next;
      if (zenButton.hidden === next) zenButton.hidden = !next;
      if (!next && !panel.hidden) closePanel();
    },
    setStatus(value) { write(node('status'), value); },
    show(page) {
      available = true;
      opener.hidden = false;
      zenButton.hidden = false;
      panel.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      if (page) selectPage(tabs.find(tab => tab.dataset.page === page) ?? tabs[0]);
      sync();
    },
  };
}
