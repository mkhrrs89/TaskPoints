const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');

function makeHarness({ title = 'Custom task', journalThrows = false } = {}) {
  const listeners = new Map();
  let originalSaveCalls = 0;
  const journaled = [];
  const addBtn = { disabled: false };
  const titleInput = { value: title };
  const microtasks = [];

  const document = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    getElementById(id) {
      if (id === 'titleInput') return titleInput;
      if (id === 'addBtn') return addBtn;
      return null;
    }
  };

  const core = {
    saveStateSnapshot(state) {
      originalSaveCalls += 1;
      return { state, originalSave: true };
    },
    assertTaskMutationJournalWritable() {
      if (journalThrows) throw new Error('journal locked');
    },
    journalTaskMutation(mutation) {
      if (journalThrows) throw new Error('journal locked');
      journaled.push(mutation);
    },
    clearStateHotCache() {}
  };

  const context = {
    TaskPointsCore: core,
    document,
    queueMicrotask(fn) { microtasks.push(fn); },
    Promise,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'task_create_fast_path.js' });

  return {
    core,
    journaled,
    clickAdd() {
      listeners.get('click')?.({
        target: { closest(selector) { return selector === '#addBtn' ? addBtn : null; } }
      });
    },
    flushMicrotasks() {
      while (microtasks.length) microtasks.shift()();
    },
    getOriginalSaveCalls: () => originalSaveCalls
  };
}

test('worker bundles task create fast path immediately after task mutation journal', () => {
  const journalAt = workerSource.indexOf("'/task_mutation_journal.js'");
  const createAt = workerSource.indexOf("'/task_create_fast_path.js'");
  const hotCacheAt = workerSource.indexOf("'/state_hot_cache.js'");
  assert.ok(journalAt >= 0 && createAt > journalAt && hotCacheAt > createAt);
  assert.match(workerSource, /taskCreateFastPathSource/);
  assert.match(workerSource, /x-taskpoints-task-create-fast-path/);
});

test('Add Task journals the newly unshifted custom-schedule task without a full snapshot save', () => {
  const h = makeHarness();
  h.clickAdd();
  const task = {
    id: 'new-task',
    title: 'Custom task',
    points: 12,
    recurrence: { mode: 'custom', every: 2, unit: 'weeks', weekdays: [1, 4] }
  };
  const state = { tasks: [task, { id: 'old-task', title: 'Old task' }] };

  const result = h.core.saveStateSnapshot(state, { userInitiated: true });

  assert.equal(result.taskCreateFastPath, true);
  assert.equal(result.deferredFullSnapshot, true);
  assert.equal(result.state, state);
  assert.equal(h.getOriginalSaveCalls(), 0);
  assert.equal(h.journaled.length, 1);
  assert.deepEqual(h.journaled[0].task, task);
  assert.equal(h.core.getTaskCreateFastPathStatus().fastPathHits, 1);
});

test('one-shot arm expires after the click turn so unrelated later saves remain full saves', () => {
  const h = makeHarness();
  h.clickAdd();
  h.flushMicrotasks();

  const result = h.core.saveStateSnapshot({ tasks: [{ id: 'later', title: 'Custom task' }] });

  assert.equal(result.originalSave, true);
  assert.equal(h.getOriginalSaveCalls(), 1);
  assert.equal(h.journaled.length, 0);
});

test('journal protection failure falls back to the unchanged full snapshot save path', () => {
  const h = makeHarness({ journalThrows: true });
  h.clickAdd();

  const result = h.core.saveStateSnapshot({ tasks: [{ id: 'new-task', title: 'Custom task' }] });

  assert.equal(result.originalSave, true);
  assert.equal(h.getOriginalSaveCalls(), 1);
  assert.equal(h.core.getTaskCreateFastPathStatus().fallbackSaves, 1);
});

test('blank-title validation never arms the fast path', () => {
  const h = makeHarness({ title: '' });
  h.clickAdd();

  const result = h.core.saveStateSnapshot({ tasks: [{ id: 'other', title: 'Other' }] });

  assert.equal(result.originalSave, true);
  assert.equal(h.getOriginalSaveCalls(), 1);
  assert.equal(h.journaled.length, 0);
});
