const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'floating_alert_island_alignment.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

test('mobile floating alert islands align to the former header-nav row', () => {
  assert.match(moduleSource, /HEADER_ROW_SELECTOR = '\.header-nav'/);
  assert.match(moduleSource, /viewportRowCenterY/);
  assert.match(moduleSource, /rect\.top \+ scrollY \+ \(rect\.height \/ 2\)/);
  assert.match(moduleSource, /centerFixedElementOnDocumentY\(\s*orange,/);
});

test('orange island gets only a slight downward nudge', () => {
  assert.match(moduleSource, /const ORANGE_VERTICAL_NUDGE_PX = 4/);
  assert.match(moduleSource, /centerY \+ ORANGE_VERTICAL_NUDGE_PX/);
  assert.match(moduleSource, /const ORANGE_RIGHT = '0\.75rem'/);
  assert.match(moduleSource, /orange\.style\.right = ORANGE_RIGHT/);
});

test('red island mirrors stable orange layout metrics without following transform jitter', () => {
  assert.match(moduleSource, /const RED_FALLBACK_SIZE_PX = 60/);
  assert.match(moduleSource, /function sizeRedIsland\(red, orange\)/);
  assert.match(moduleSource, /orange\?\.offsetWidth/);
  assert.match(moduleSource, /orange\?\.offsetHeight/);
  assert.match(moduleSource, /red\.style\.width = `\$\{Math\.round\(width\)\}px`/);
  assert.match(moduleSource, /red\.style\.height = `\$\{Math\.round\(height\)\}px`/);
  assert.match(moduleSource, /stableOrangeTop/);
  assert.match(moduleSource, /red\.style\.top = stableOrangeTop/);
  assert.match(moduleSource, /const rightInset = String\(orange\?\.style\?\.right/);
  assert.match(moduleSource, /red\.style\.left = rightInset/);
  assert.doesNotMatch(moduleSource, /mirroredCenterX/);
});

test('alignment does not attach a scroll listener or alter floating transforms', () => {
  assert.doesNotMatch(moduleSource, /addEventListener\?*\('scroll'/);
  assert.doesNotMatch(moduleSource, /style\.transform/);
  assert.doesNotMatch(moduleSource, /position\s*=/);
  assert.match(moduleSource, /addEventListener\?*\('resize', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('orientationchange', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('pageshow', scheduleAlign/);
  assert.match(moduleSource, /tpRefreshCriticalIslandLayout\?\.\(\)/);
});

test('critical mark uses a fixed two-mark left anchor so extra marks only grow right', () => {
  assert.match(moduleSource, /function anchorRedMarkFromTwoMarkBaseline\(red\)/);
  assert.match(moduleSource, /probe\.textContent = '!!'/);
  assert.match(moduleSource, /const leftInset = Math\.max\(0, Math\.round\(\(islandWidth - twoMarkWidth\) \/ 2\)\)/);
  assert.match(moduleSource, /--tp-critical-mark-left-anchor/);
  assert.match(moduleSource, /anchorRedMarkFromTwoMarkBaseline\(red\)/);
});

test('shared production loader includes cache-busted floating island alignment module', () => {
  assert.match(loaderSource, /floating_alert_island_alignment\.js\?v=20261007-2/);
  assert.match(loaderSource, /data-taskpoints-floating-alert-alignment/);
});
