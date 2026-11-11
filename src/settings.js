export const storageKey = 'surfd-qol.settings.v1';
export const defaults = {
  hud: true, scale: 1, y: 82, speedColor: '#ebbcba', opacity: 1,
  // Zen: only the speed, plus the start speed and height after leaving the start.
  zen: false,
  // While surfing: the compact HUD, or the full one replays and spectating use.
  surfHud: 'compact', compactTimer: false, compactLabels: true,
  // The bar under the speed; off keeps just the values under it.
  rampBar: true,
  speedFps: 60, timerFps: 30,
  goodColor: '#9ccfd8', warnColor: '#f6c177', badColor: '#eb6f92',
  showSync: true, showBoard: true, showAir: true, showStart: true, showSurf: true,
  rampResult: 'total', speedEnergyColor: true, speedEnergyRamps: false, speedEnergyLive: true,
  checkpointReference: 'both', wrSource: 'ksf', continuousFeedback: false, airMetric: 'combined',
  boardColorReference: 'fixed', startColorReference: 'fixed', surfColorReference: 'wr', airColorReference: 'wr',
  startHeightAmazing: 7.5, startHeightGood: 15,
  startDeficitAmazing: 10, startDeficitGood: 17.5, strafeLookbackSeconds: 0.2,
  boardLossAmazing: 5, boardLossGood: 15, airLossAmazing: 5, airLossGood: 20,
  referenceLossTolerance: 2,
  // Binds change what the game receives, so each one is opt-in.
  crouchJump: false, crouchJumpKey: 'Space',
  nullAD: false, nullWSpace: false,
  // Noclip: a key toggles flying through walls, always in practice. Speed in u/s.
  noclip: false, noclipKey: 'KeyV', noclipSpeed: 800,
  // World paint: hold to mark surfaces, saved per map. Size is the dot radius in units.
  paint: false, paintKey: 'KeyF', paintEraseKey: 'KeyG', paintColor: '#ff4d4d', paintSize: 4,
  // In a private room, any paint shows only while this is on.
  paintShowRoom: false,
  // Strafe preview: the speed it starts from and whether it strafes on the ground (prestrafe) or in the air.
  strafePreviewUnits: 300, strafePreviewMode: 'ground',
  // Both replay bars drive Surfd's own player.
  customReplayUi: true,
  // What the Runs panel's Ramps view shows for every ramp.
  rampMetric: 'surf',
  // Run history: the newest runs per map (each with its replay) plus every
  // map's bests, which are never pruned.
  keepHistory: true, historyRunsPerMap: 10, historyMinSeconds: 10,
};
// Changing any of these prunes stored history and replays.
export const storageLimitKeys = ['historyRunsPerMap', 'historyMinSeconds'];
export const colorKeys = ['speedColor', 'goodColor', 'warnColor', 'badColor'];
const choices = {
  checkpointReference: ['pb', 'wr', 'both'],
  wrSource: ['ksf', 'leaderboard'],
  airMetric: ['missed', 'braking', 'combined'],
  rampResult: ['split', 'total'],
  surfHud: ['compact', 'full'],
  boardColorReference: ['fixed', 'pb', 'wr'],
  startColorReference: ['fixed', 'pb', 'wr'],
  surfColorReference: ['fixed', 'pb', 'wr'],
  airColorReference: ['fixed', 'pb', 'wr'],
  strafePreviewMode: ['ground', 'air'],  rampMetric: ['surf', 'board', 'angle', 'down', 'up', 'speedIn', 'speedOut'],
};

// Unknown keys and wrong types are ignored; every accepted value is clamped
// so the HUD and metrics never see an out-of-range setting.
export function applySettings(settings, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in defaults) || typeof value !== typeof defaults[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    settings[key] = value;
  }
  settings.y = Math.max(10, Math.min(90, settings.y));
  settings.scale = Math.max(0.6, Math.min(1.6, settings.scale));
  settings.opacity = Math.max(0.25, Math.min(1, settings.opacity));
  settings.speedFps = Math.round(Math.max(1, Math.min(1000, settings.speedFps)));
  settings.timerFps = Math.round(Math.max(1, Math.min(1000, settings.timerFps)));
  settings.startHeightAmazing = Math.max(0, settings.startHeightAmazing);
  settings.startHeightGood = Math.max(settings.startHeightAmazing, Math.max(0, settings.startHeightGood));
  settings.startDeficitAmazing = Math.max(0, settings.startDeficitAmazing);
  settings.startDeficitGood = Math.max(settings.startDeficitAmazing, Math.max(0, settings.startDeficitGood));
  settings.boardLossAmazing = Math.max(0, settings.boardLossAmazing);
  settings.boardLossGood = Math.max(settings.boardLossAmazing, settings.boardLossGood);
  settings.airLossAmazing = Math.max(0, settings.airLossAmazing);
  settings.airLossGood = Math.max(settings.airLossAmazing, settings.airLossGood);
  settings.referenceLossTolerance = Math.max(0, settings.referenceLossTolerance);
  settings.strafeLookbackSeconds = Math.max(0.05, Math.min(0.5, settings.strafeLookbackSeconds));
  settings.historyRunsPerMap = Math.round(Math.max(3, Math.min(100, settings.historyRunsPerMap)));
  settings.historyMinSeconds = Math.max(0, Math.min(300, settings.historyMinSeconds));
  settings.strafePreviewUnits = Math.max(1, Math.min(5000, settings.strafePreviewUnits));
  settings.paintSize = Math.max(1, Math.min(32, settings.paintSize));  for (const key of [...colorKeys, 'paintColor']) if (!/^#[a-f\d]{6}$/i.test(settings[key])) settings[key] = defaults[key];
  settings.noclipSpeed = Math.max(100, Math.min(3000, settings.noclipSpeed));
  for (const key of ['paintKey', 'paintEraseKey', 'noclipKey']) if (!settings[key] || settings[key] === 'Escape') settings[key] = defaults[key];
  for (const [key, allowed] of Object.entries(choices)) if (!allowed.includes(settings[key])) settings[key] = defaults[key];
  return settings;
}
