const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const toolbar = fs.readFileSync('toolbar.js', 'utf8');
const targeted = fs.readFileSync('home_targeted_render_control.js', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('Critical Tasks queued Home refresh prefers live state and preserves stored fallback', () => {
  const body = between(toolbar, 'function ensureCriticalTasksIsland', 'function getCriticalDueList');
  assert.match(body, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(body, /updateCriticalTasksIsland\(liveState\)/);
  assert.match(body, /return updateCriticalTasksIsland\(\)/);
  assert.match(body, /updateCriticalTasksIslandFromBestState\(\)/);
});

test('targeted task refresh passes live Home state through renderTasks without a second island call', () => {
  assert.match(targeted, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(targeted, /global\.renderTasks\(liveState && typeof liveState === 'object' \? liveState : null\)/);
  const start = targeted.indexOf('function targetedScheduleRender');
  const end = targeted.indexOf('function targetedAnimateTaskCompletion', start);
  const body = targeted.slice(start, end);
  assert.doesNotMatch(body, /global\.updateCriticalTasksIsland/);
});
