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

test('orange reminder alert uses a stable Today-island nudge instead of full stacking', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /querySelectorAll\('\.tp-reminder-island'\)/);
  assert.match(body, /const shouldStackUnderToday = todayVisible && !visibleOrangeAlert/);
  assert.match(body, /const shouldNudgeForToday = todayVisible && !!visibleOrangeAlert/);
  assert.match(body, /classList\.toggle\('nudge-for-today', shouldNudgeForToday\)/);
  assert.match(body, /--tp-critical-today-nudge/);
});

test('Today-island collision fallback is preserved when orange alert is absent', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /if \(shouldStackUnderToday\)/);
  assert.match(body, /todayIsland\.getBoundingClientRect\(\)\.height/);
  assert.match(body, /--tp-today-island-h/);
});


test('critical alert does not realign on every scroll frame', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /const previousMode = island\.dataset\.layoutMode/);
  assert.match(body, /if \(previousMode !== nextMode\)/);
  assert.match(body, /TaskPointsFloatingAlertIslandAlignment\?\.scheduleAlign\?\.\(\)/);
});


test('Today-island nudge is based on red fixed top and is hard-bounded after modal geometry changes', () => {
  const body = between(toolbar, 'function updateCritIslandStacking()', 'function updateCriticalTasksIsland');

  assert.match(body, /const baseTop = Number\.parseFloat\(islandStyle\?\.top/);
  assert.match(body, /const rawNudge = Number\.isFinite\(baseTop\)/);
  assert.match(body, /const nudge = Math\.min\(96, Math\.max\(18, rawNudge\)\)/);
  assert.doesNotMatch(body, /orangeTop/);
});
