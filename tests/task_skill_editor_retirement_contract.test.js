const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function section(start, end) {
  const from = home.indexOf(start);
  assert.ok(from >= 0, 'Missing section start: ' + start);
  const to = home.indexOf(end, from + start.length);
  assert.ok(to > from, 'Missing section end: ' + end);
  return home.slice(from, to);
}

test('Add Task keeps its standard fields, but no longer displays Skills inputs', () => {
  const form = section('id="addTaskModal"', 'id="taskActionSheet"');
  assert.match(form, /id="titleInput"/);
  assert.match(form, /id="pointsInput"/);
  assert.match(form, /id="tagsInput"/);
  assert.match(form, /id="addBtn"/);
  assert.doesNotMatch(form, /Skills|createTaskSkills|data-task-skill/i);
  const creation = section('function addTask(){', 'function setDueToday(){');
  assert.match(creation, /skills:\s*\[\]/, 'New tasks keep a compatible empty skills array');
  assert.doesNotMatch(creation, /readCreateTaskSkills/);
});

test('Edit Task keeps its standard fields, but no longer displays Skills inputs', () => {
  const edit = section('if (editingTaskId === t.id) {', 'body.appendChild(card);');
  for (const field of ['title', 'points', 'due', 'importance', 'repeat', 'tags']) {
    assert.ok(edit.includes('data-field="' + field + '"'), 'Missing editor field: ' + field);
  }
  assert.match(edit, /data-task-action="task-save"/);
  assert.doesNotMatch(edit, /Skills|data-task-skill|skillRows|wireTaskSkillEditor/i);
});

test('Saving a normal task edit retains existing historical Skills data', () => {
  const task = {
    id: 't1', title: 'Before', points: 1, importance: 'Medium',
    dueDateISO: '2026-10-27', recurrence: { mode: 'none' }, tags: ['old'],
    skills: [{ skill: 'Sketching', pts: '5' }]
  };
  let persisted = false;
  let rendered = false;
  const scope = {
    state: { tasks: [task] },
    editingTaskId: 't1',
    assertTaskActionMutationWritable: () => true,
    trackDueDatePush: () => {},
    persistTaskActionMutation(updated, action) {
      assert.equal(updated, task);
      assert.equal(action, 'edit-save');
      persisted = true;
    },
    renderTasks() { rendered = true; }
  };
  const fnSource = section('function saveTaskEdit(id,card){', 'function hideTask(id){');
  const saveTaskEdit = vm.runInNewContext(fnSource + '\nsaveTaskEdit;', scope);
  const fields = {
    'input[data-field="title"]': { value: 'After' },
    'input[data-field="points"]': { value: '6' },
    'input[data-field="due"]': { value: '2026-10-29' },
    'select[data-field="importance"]': { value: 'High' },
    'select[data-field="repeat"]': { value: 'none' },
    'input[data-field="tags"]': { value: 'work, errands' }
  };
  saveTaskEdit('t1', { querySelector(selector) { return fields[selector] || null; } });
  assert.equal(task.title, 'After');
  assert.equal(task.points, 6);
  assert.equal(task.dueDateISO, '2026-10-29');
  assert.equal(task.importance, 'High');
  assert.deepEqual(Array.from(task.tags), ['work', 'errands']);
  assert.deepEqual(task.skills, [{ skill: 'Sketching', pts: '5' }]);
  assert.ok(persisted && rendered, 'Normal save and render still run');
});
