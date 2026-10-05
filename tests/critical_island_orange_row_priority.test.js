const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar.js'), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end);
}

test('orange reminder alert prevents Critical Tasks from stacking under Today island', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /querySelectorAll\('\.tp-reminder-island'\)/);
  assert.match(body, /const shouldStackUnderToday = todayVisible && !visibleOrangeAlert/);
  assert.match(body, /classList\.toggle\('stack-under-today', shouldStackUnderToday\)/);
  assert.match(body, /TaskPointsFloatingAlertIslandAlignment\?\.scheduleAlign\?\.\(\)/);
});

test('Today-island collision fallback is preserved when orange alert is absent', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /if \(shouldStackUnderToday\)/);
  assert.match(body, /todayIsland\.getBoundingClientRect\(\)\.height/);
  assert.match(body, /--tp-today-island-h/);
});
