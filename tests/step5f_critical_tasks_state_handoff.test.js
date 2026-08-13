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

test('critical task list accepts a task-bearing state, overlays pending task mutations, and preserves stored-state fallback', () => {
  const body = between(toolbar, 'function getCriticalDueList', 'function updateCriticalTasksIsland');
  assert.match(body, /Array\.isArray\(stateInput\.tasks\)/);
  assert.match(body, /TaskPointsCore\?\.applyPendingTaskMutations/);
  assert.match(body, /applyPendingTaskMutations\(stateInput\)/);
  assert.match(body, /loadRawStateFallback\(\)/);
  assert.match(body, /criticalTasksIsland\.stateResolved/);
  assert.match(body, /provided-state\+journal/);
  assert.match(body, /stored-state/);
});

test('critical island forwards only validated optional state to its list builder', () => {
  const body = between(toolbar, 'function updateCriticalTasksIsland', 'window.tpUpdateCriticalIsland');
  assert.match(body, /function updateCriticalTasksIsland\(stateInput = null\)/);
  assert.match(body, /getCriticalDueList\(stateInput\)/);
});

test('Edit Save hands current Home state to the critical island', () => {
  const body = between(home, 'function saveTaskEdit', 'function hideTask');
  assert.match(body, /persistTaskActionMutation\(t, 'edit-save'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});

test('+1 Day hands current Home state to the critical island', () => {
  const body = between(home, 'function bumpTaskOneDay', 'function applyPostponeToTask');
  assert.match(body, /persistTaskActionMutation\(t, 'bump-one-day'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});

test("Won't Do hands current Home state to the critical island", () => {
  const body = between(home, 'function wontDoMain', 'function prefersReducedTaskMotion');
  assert.match(body, /persistTaskActionMutation\(t, 'wont-do'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});
