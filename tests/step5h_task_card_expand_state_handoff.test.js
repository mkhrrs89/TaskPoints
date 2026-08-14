const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const toolbar = fs.readFileSync('toolbar.js', 'utf8');

function between(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return html.slice(start, end);
}

test('task-card body expansion reuses current Home state only while its canonical revision is current', () => {
  const helper = between('function getTaskCardLayoutStateInput()', 'function initTaskListDelegation()');
  assert.match(helper, /const currentRevision = readHomeStateRevision\(\);/);
  assert.match(helper, /currentRevision && currentRevision !== loadedStateRevision/);
  assert.doesNotMatch(helper, /currentRevision && loadedStateRevision && currentRevision !== loadedStateRevision/);
  assert.match(helper, /return null;/);
  assert.match(helper, /return state;/);

  const body = between('function initTaskListDelegation()', 'function saveSleepScore');
  const bodyExpansionPattern = /const bodyTarget = e\.target\.closest\('\[data-task-card-body\]'\);[\s\S]*?expandedTaskId = expandedTaskId === id \? null : id;\s*renderTasks\(getTaskCardLayoutStateInput\(\)\);/g;
  const matches = body.match(bodyExpansionPattern) || [];
  assert.equal(matches.length, 2);
});

test('an initialized current revision with an empty Home baseline uses the safe stored-state fallback', () => {
  const helper = between('function getTaskCardLayoutStateInput()', 'function initTaskListDelegation()');
  const vm = require('node:vm');
  const context = {
    readHomeStateRevision: () => 'revision-current',
    loadedStateRevision: '',
    state: { tasks: [{ id: 'stale-home' }] },
    result: undefined,
  };
  vm.runInNewContext(`${helper}\nresult = getTaskCardLayoutStateInput();`, context);
  assert.equal(context.result, null);
});

test('task mutation journal does not invalidate the canonical Home revision guard', () => {
  const revisionInstaller = toolbar.slice(
    toolbar.indexOf('(function installTaskPointsStateRevision(global) {'),
    toolbar.indexOf('})(window);') + '})(window);'.length
  );
  assert.match(revisionInstaller, /taskpoints_v1/);
  assert.doesNotMatch(revisionInstaller, /taskpoints_pending_task_mutations_v1/);
});

test('opening the task action sheet itself remains layout-only and does not refresh Critical Tasks', () => {
  const body = between('function openTaskActionSheet', 'function closeTaskActionSheet');
  assert.doesNotMatch(body, /updateCriticalTasksIsland|readTaskPointsStoredState|renderTasks\(/);
});
