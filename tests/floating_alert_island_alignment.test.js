const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'floating_alert_island_alignment.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

test('mobile floating alert islands align to the former header-nav row', () => {
  assert.match(moduleSource, /HEADER_ROW_SELECTOR = '\.header-nav'/);
  assert.match(moduleSource, /documentRowCenterY\(row\)/);
  assert.match(moduleSource, /rect\.top \+ scrollY \+ \(rect\.height \/ 2\)/);
  assert.match(moduleSource, /centerFixedElementOnDocumentY\(red, centerY/);
  assert.match(moduleSource, /centerFixedElementOnDocumentY\(\s*orange,/);
});

test('orange island gets only a slight downward nudge', () => {
  assert.match(moduleSource, /const ORANGE_VERTICAL_NUDGE_PX = 4/);
  assert.match(moduleSource, /centerY \+ ORANGE_VERTICAL_NUDGE_PX/);
  assert.match(moduleSource, /const ORANGE_RIGHT = '0\.75rem'/);
  assert.match(moduleSource, /orange\.style\.right = ORANGE_RIGHT/);
});

test('red island is slightly smaller and horizontally mirrors the orange island', () => {
  assert.match(moduleSource, /const RED_SIZE_PX = 52/);
  assert.match(moduleSource, /function sizeRedIsland\(red\)/);
  assert.match(moduleSource, /red\.style\.width = size/);
  assert.match(moduleSource, /red\.style\.height = size/);
  assert.match(moduleSource, /function mirrorRedToOrange\(red, orange\)/);
  assert.match(moduleSource, /const orangeCenterX = orangeRect\.left \+ \(orangeRect\.width \/ 2\)/);
  assert.match(moduleSource, /const mirroredCenterX = viewportWidth - orangeCenterX/);
  assert.match(moduleSource, /red\.style\.left = `\$\{Math\.round\(mirroredCenterX - \(redRect\.width \/ 2\)\)\}px`/);
});

test('alignment does not attach a scroll listener or alter floating transforms', () => {
  assert.doesNotMatch(moduleSource, /addEventListener\?*\('scroll'/);
  assert.doesNotMatch(moduleSource, /style\.transform/);
  assert.doesNotMatch(moduleSource, /position\s*=/);
  assert.match(moduleSource, /addEventListener\?*\('resize', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('orientationchange', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('pageshow', scheduleAlign/);
});

test('shared production loader includes cache-busted floating island alignment module', () => {
  assert.match(loaderSource, /floating_alert_island_alignment\.js\?v=20260913-2/);
  assert.match(loaderSource, /data-taskpoints-floating-alert-alignment/);
});
