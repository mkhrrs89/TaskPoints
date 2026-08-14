const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const toolbar = fs.readFileSync('toolbar.js', 'utf8');
const home = fs.readFileSync('index.html', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('critical task list overlays pending mutations on provided state and preserves stored-state fallback', () => {
  const body = between(toolbar, 'function getCriticalDueList', 'function updateCriticalTasksIsland');
  assert.match(body, /Array\.isArray\(stateInput\.tasks\)/);
  assert.match(body, /window\.TaskPointsCore\?\.applyPendingTaskMutations/);
  assert.match(body, /applyPendingTaskMutations\(stateInput\)/);
  assert.match(body, /state = loadRawStateFallback\(\)/);
  assert.match(body, /provided-state\+journal/);
  assert.match(body, /provided-state/);
  assert.match(body, /stored-state/);
  assert.match(body, /criticalTasksIsland\.stateResolved/);
});

test('renderTasks forwards optional state to its existing Critical Tasks refresh', () => {
  const body = between(home, 'function renderTasks', 'function formatHomeStreakBonusValue');
  assert.match(body, /function renderTasks\(stateInput = null\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(stateInput\)/);
});

test('critical island forwards optional state to its list builder', () => {
  const body = between(toolbar, 'function updateCriticalTasksIsland', 'window.tpUpdateCriticalIsland');
  assert.match(body, /function updateCriticalTasksIsland\(stateInput = null\)/);
  assert.match(body, /getCriticalDueList\(stateInput\)/);
});

for (const [label, startNeedle, endNeedle, action] of [
  ['Edit Save', 'function saveTaskEdit', 'function hideTask', 'edit-save'],
  ['+1 Day', 'function bumpTaskOneDay', 'function applyPostponeToTask', 'bump-one-day'],
  ["Won't Do", 'function wontDoMain', 'function prefersReducedTaskMotion', 'wont-do']
]) {
  test(`${label} renders once with current Home state and does not separately refresh the island`, () => {
    const body = between(home, startNeedle, endNeedle);
    assert.match(body, new RegExp(`persistTaskActionMutation\\(t, '${action}'\\)`));
    assert.match(body, /renderTasks\(state\)/);
    assert.doesNotMatch(body, /updateCriticalTasksIsland\?\.\(state\)/);
  });
}
