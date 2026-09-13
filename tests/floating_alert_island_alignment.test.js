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
  assert.match(moduleSource, /centerFixedElementOnDocumentY\(orange, centerY/);
});

test('red island moves inward while orange island stays on the right tray edge', () => {
  assert.match(moduleSource, /const RED_LEFT = '3rem'/);
  assert.match(moduleSource, /const ORANGE_RIGHT = '0\.75rem'/);
  assert.match(moduleSource, /red\.style\.left = RED_LEFT/);
  assert.match(moduleSource, /orange\.style\.right = ORANGE_RIGHT/);
});

test('alignment does not attach a scroll listener or alter floating transforms', () => {
  assert.doesNotMatch(moduleSource, /addEventListener\?*\('scroll'/);
  assert.doesNotMatch(moduleSource, /style\.transform/);
  assert.doesNotMatch(moduleSource, /position\s*=/);
  assert.match(moduleSource, /addEventListener\?*\('resize', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('orientationchange', scheduleAlign/);
  assert.match(moduleSource, /addEventListener\?*\('pageshow', scheduleAlign/);
});

test('shared production loader includes floating island alignment module', () => {
  assert.match(loaderSource, /floating_alert_island_alignment\.js\?v=20260913-1/);
  assert.match(loaderSource, /data-taskpoints-floating-alert-alignment/);
});
