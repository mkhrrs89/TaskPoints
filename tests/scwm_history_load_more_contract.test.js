const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scwm_history_load_more.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'phase4_diagnostics.js'), 'utf8');

test('SCWM history starts at 10 days and reveals five more at a time', () => {
  assert.match(source, /const INITIAL_DAYS = 10;/);
  assert.match(source, /const STEP_DAYS = 5;/);
  assert.match(source, /const MAX_DAYS = 30;/);
  assert.match(source, /button\.textContent = 'Load 5 more';/);
  assert.match(source, /visibleDays = Math\.min\(maximum, visibleDays \+ STEP_DAYS\);/);
});

test('SCWM older history reuses the existing renderer and preserves it', () => {
  assert.match(source, /originalRender = candidate\.__taskPointsScwmHistoryLoadMoreOriginal \|\| candidate;/);
  assert.match(source, /originalRender\(\);/);
  assert.match(source, /global\.Date = shiftedDateConstructor\(offsetDays\);/);
  assert.match(source, /finally \{\s*global\.Date = RealDate;/);
  assert.match(source, /wrappedRender\.__taskPointsScwmHistoryLoadMoreOriginal = originalRender;/);
});

test('Home runtime loads the SCWM history feature without changing index markup', () => {
  assert.match(loaderSource, /scwm_history_load_more\.js\?v=20260820-1/);
  assert.match(loaderSource, /data-taskpoints-scwm-history-load-more/);
});
