const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function completeTask(id){');
const end = html.indexOf('\n\n\nfunction editTask(id){', start);
assert.notEqual(start, -1, 'completeTask should exist');
assert.notEqual(end, -1, 'editTask boundary should exist');
const block = html.slice(start, end);

function pos(needle) {
  const at = block.indexOf(needle);
  assert.notEqual(at, -1, `missing ${needle}`);
  return at;
}

test('task completion becomes durable before its visual dust animation starts', () => {
  const preflight = pos('assertTaskActionMutationWritable()');
  const add = pos('addCompletion(completion)');
  const journal = pos('TaskPointsCore.journalTaskMutation({ task: liveTask, completionUpsert: completion })');
  const durableMark = pos("taskAction.completionDurable");
  const animate = pos('animateTaskCompletion(id, () => {');

  assert.ok(preflight < add, 'journal preflight must precede state mutation');
  assert.ok(add < journal, 'completion must be in final state before the atomic task/completion journal record');
  assert.ok(journal < durableMark, 'durability mark must describe an already-written journal');
  assert.ok(durableMark < animate, 'animation must not gate durable persistence');
});

test('task completion keeps recurrence, Critical Tasks refresh, animation, and full-save fallback behavior', () => {
  assert.match(block, /computeNextDueDate\(liveTask\)/);
  assert.match(block, /removeTaskFromTodayView\(id, completedDayKey\)/);
  assert.match(block, /window\.updateCriticalTasksIsland\?\.\(state\)/);
  assert.match(block, /scheduleRender\(renderAll\)/);
  assert.match(block, /else\s*\{\s*save\(\);\s*\}/);
  assert.match(block, /completionUpsert: completion/);
});
