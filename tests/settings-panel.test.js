import { describe, expect, test } from 'bun:test';
import { previewModel, formatBytes, panelMarkup, historyRule, historyPreview, zenMarkup } from '../src/settings-panel.js';
import { defaults } from '../src/settings.js';

const visible = model => ['board', 'result', 'up'].filter(key => !model.feedback[key].hidden);
const text = html => html.replace(/<[^>]+>/g, '');

describe('settings preview', () => {
  test('mirrors the feedback options', () => {
    const net = previewModel({ ...defaults, rampResult: 'total' });
    expect(visible(net)).toEqual(['board', 'result']);
    expect(net.feedback.result.label).toBe('SURF');
    expect(visible(previewModel({ ...defaults, showBoard: false, showSurf: false }))).toEqual(['result']);
    expect(previewModel({ ...defaults, showBoard: false, showSurf: false, airMetric: 'braking' }).feedback.result.label).toBe('BRAKE');
    const none = previewModel({ ...defaults, showBoard: false, showSurf: false, showAir: false });
    expect(none.feedback.hidden).toBe(true);
    expect(visible(previewModel({ ...defaults, continuousFeedback: true }))).toEqual(['board', 'result']);
    expect(previewModel({ ...defaults, showSync: false }).sync.hidden).toBe(true);
  });

  test('Zen leaves only the speed in the preview', () => {
    const zen = previewModel({ ...defaults, zen: true });
    expect(zen.zen).toBe(true);
    expect([zen.clock.hidden, zen.sync.hidden, zen.feedback.hidden]).toEqual([true, true, true]);
    // Compact shows no timer unless asked; Full always does.
    expect(previewModel(defaults).clock.hidden).toBe(true);
    expect(previewModel({ ...defaults, compactTimer: true }).clock.hidden).toBe(false);
    expect(previewModel({ ...defaults, surfHud: 'full' }).clock.hidden).toBe(false);
  });

  test('every setting the panel binds exists, and every default is reachable', () => {
    const bound = new Set([...panelMarkup.matchAll(/data-setting="(\w+)"/g)].map(match => match[1]));
    for (const key of bound) expect(key in defaults).toBe(true);
    // Keys are set through key-capture buttons, rampMetric in the Runs panel.
    const captured = new Set([...panelMarkup.matchAll(/data-capture="(\w+)"/g)].map(match => match[1]));
    for (const key of captured) expect(key in defaults).toBe(true);
    for (const key of Object.keys(defaults)) if (key !== 'crouchJumpKey' && key !== 'rampMetric' && !captured.has(key)) expect(bound.has(key)).toBe(true);
  });

  test('players read touch, never board, in visible text and accessible labels', () => {
    const labels = (panelMarkup.match(/aria-label="[^"]*"/g) ?? []).join(' ');
    expect(text(panelMarkup)).not.toMatch(/\bboard/i);
    expect(text(panelMarkup)).toContain('leaderboard');
    expect(labels).not.toMatch(/\bboard/i);
    expect(labels).toMatch(/touch/i);
    expect(previewModel(defaults).feedback.board.label).toBe('TOUCH');
  });

  test('the strafe preview offers ground and air modes and a start button', () => {
    expect(panelMarkup).toMatch(/<input[^>]*value="ground"[^>]*data-setting="strafePreviewMode"/);
    expect(panelMarkup).toMatch(/<input[^>]*value="air"[^>]*data-setting="strafePreviewMode"/);
    expect(panelMarkup).toContain('id="preview-start"');
  });

  test('the Zen pill is a named toggle button', () => {
    expect(zenMarkup).toContain('aria-pressed="false"');
    expect(zenMarkup).toContain('aria-label="Zen mode"');
  });
});

describe('history settings', () => {
  test('the history rule follows the settings and does not call the best finish a PB', () => {
    const rule = text(historyRule({ ...defaults, historyRunsPerMap: 25, historyMinSeconds: 7 }));
    expect(rule).toContain('25 newest runs');
    expect(rule).toContain('Resets under 7 s are skipped');
    expect(rule).not.toMatch(/\bPB\b/);
    expect(text(historyRule({ ...defaults, historyRunsPerMap: 25, historyMinSeconds: 0 }))).not.toContain('Resets under');
    expect(historyRule({ ...defaults, keepHistory: false })).toMatch(/recording is off/i);
  });

  test('the History preview draws the newest runs, capped, and the skip rule', () => {
    const bars = html => (html.match(/<i style=/g) ?? []).length;
    expect(bars(historyPreview({ ...defaults, historyRunsPerMap: 5 }))).toBe(5);
    expect(historyPreview({ ...defaults, historyMinSeconds: 10 })).toContain('class="skip"');
    const many = historyPreview({ ...defaults, historyRunsPerMap: 100, historyMinSeconds: 0 });
    expect(bars(many)).toBeLessThan(100);
    expect(many).toContain(`+${100 - bars(many)}`);
    expect(many).not.toContain('class="skip"');
    expect(historyPreview({ ...defaults, keepHistory: false })).toContain('Recording is off');
  });

  test('sizes read in KB, then MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(200)).toBe('1 KB');
    expect(formatBytes(61440)).toBe('60 KB');
    expect(formatBytes(1.6 * 1024 * 1024)).toBe('1.6 MB');
  });
});
