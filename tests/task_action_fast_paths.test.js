const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

function between(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return html.slice(start, end);
}

test('Edit-open exposes dedicated device timing without changing render behavior', () => {
  const body = between('function editTask(id)', 'function saveTaskEdit');
  assert.match(body, /renderTasks\(\)/);
  assert.match(body, /taskAction\.editOpenComplete/);
});

test('Edit Save preflights the durable journal and avoids synchronous full save', () => {
  const body = between('function saveTaskEdit', 'function hideTask');
  assert.match(body, /assertTaskActionMutationWritable\(\)/);
  assert.match(body, /persistTaskActionMutation\(t, 'edit-save'\)/);
  assert.doesNotMatch(body, /save\(\);\s*renderTasks\(\)/);
});

test('+1 Day preflights and journals the changed task only', () => {
  const body = between('function bumpTaskOneDay', 'function applyPostponeToTask');
  assert.match(body, /assertTaskActionMutationWritable\(\)/);
  assert.match(body, /persistTaskActionMutation\(t, 'bump-one-day'\)/);
  assert.doesNotMatch(body, /\bsave\(\)/);
});

test("Won't Do preserves confirmation while journaling the resulting task only", () => {
  const body = between('function wontDoMain', 'function prefersReducedTaskMotion');
  assert.match(body, /assertTaskActionMutationWritable\(\)/);
  assert.match(body, /confirm\('Won’t do this task\? It will be removed\.'\)/);
  assert.match(body, /persistTaskActionMutation\(t, 'wont-do'\)/);
  assert.doesNotMatch(body, /\bsave\(\)/);
});

test('task action helper keeps the full-save fallback when journal support is absent', () => {
  const body = between('function persistTaskActionMutation', 'function bumpTaskOneDay');
  assert.match(body, /TaskPointsCore\?\.journalTaskMutation/);
  assert.match(body, /TaskPointsCore\.journalTaskMutation\(\{ task \}\)/);
  assert.match(body, /else\s*\{\s*save\(\)/);
});

test('journal preflight blocks mutation when journal writes are unavailable', () => {
  const body = between('function assertTaskActionMutationWritable', 'function persistTaskActionMutation');
  assert.match(body, /assertTaskMutationJournalWritable/);
  assert.match(body, /return false/);
});
