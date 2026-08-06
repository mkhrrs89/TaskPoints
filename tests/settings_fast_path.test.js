import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../mobile_boot_gate.js', import.meta.url), 'utf8');

test('Settings route uses the deferred runtime transform', () => {
  assert.match(source, /clean === '\/settings\.html'/);
  assert.match(source, /clean === '\/settings'/);
  assert.match(source, /isSettingsPage/);
});

test('Settings receives two paint opportunities before heavy runtime replay', () => {
  assert.match(source, /nextFrame\(\)\.then\(nextFrame\)\.then\(starter\)/);
  assert.match(source, /data-tp-boot-deferred=\\"runtime\\"/);
});

test('collapsed Settings panels initialize only when opened', () => {
  for (const id of [
    'shadowMigrationSection',
    'storageHealthSection',
    'healthDataManagerSection',
    'habitCalendarReportSection',
    'missingScoresSection',
    'scoringSettingsSection',
    'habitTagColorsSection'
  ]) {
    assert.match(source, new RegExp(`lazySection\\(\\"${id}\\"`));
  }
  assert.match(source, /section\.addEventListener\(\\"toggle\\"/);
});

test('repeat actions remain available after first lazy initialization', () => {
  assert.match(source, /window\[functionName\] = function\(\.\.\.args\)/);
  assert.doesNotMatch(source, /initialized && !args\.length/);
});

test('Home prefetches Settings for faster navigation', () => {
  assert.match(source, /rel=\\"prefetch\\" href=\\"\/settings\.html\\"/);
});

test('every Settings card except Navigation Shortcuts is collapsed', () => {
  assert.match(source, /heading\.textContent\.trim\(\) === \\"Navigation Shortcuts\\"/);
  assert.match(source, /if \(card === navigationCard\) continue/);
  assert.match(source, /document\.createElement\(\\"details\\"\)/);
  assert.match(source, /card\.removeAttribute\(\\"open\\"\)/);
  assert.match(source, /child !== navigationCard && child\.tagName === \\"DETAILS\\"/);
});

test('Settings collapse conversion runs before the deferred runtime', () => {
  assert.match(source, /SETTINGS_COLLAPSE_SCRIPT \+ RUNTIME_LOADER_SCRIPT/);
  assert.match(source, /tp-settings-collapsing/);
  assert.match(source, /finally \{\s*finish\(\);\s*\}/);
});
