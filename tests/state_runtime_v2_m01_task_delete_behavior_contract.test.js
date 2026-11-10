'use strict';
// M01 behavior witness for the CURRENT V1 Task-delete writer. This only
// validates the old journal/fallback routing in a synthetic environment.
// It does NOT fence paused tabs, migrate Task authority, or grant V2 cutover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'task_delete_fast_path.js'), 'utf8');

function harness({ journalAvailable = true, rejectJournal = false, rejectAdmission = false } = {}) {
  const saved = [], journaled = [], marks = [], microtasks = [];
  let clickListener, cacheClears = 0;
  const core = {
    saveStateSnapshot(state, options = {}) {
      saved.push({ state, options, thisValue: this });
      return { state, oldSnapshotSave: true };
    },
    assertTaskMutationJournalWritable() {
      if (rejectAdmission) throw new Error('journal not writable');
    },
    clearStateHotCache() { cacheClears++; }
  };
  if (journalAvailable) {
    core.journalTaskMutation = function (payload) {
      if (rejectJournal) throw new Error('quota exceeded');
      journaled.push(payload);
    };
  }
  const document = {
    addEventListener(type, fn, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      clickListener = fn;
    }
  };
  const context = {
    TaskPointsCore: core,
    TaskPointsPerf: { mark(name, detail) { marks.push({ name, detail }); } },
    document,
    queueMicrotask(fn) { microtasks.push(fn); },
    console,
    Promise
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'task_delete_fast_path.js' });
  return {
    core, saved, journaled, marks,
    get cacheClears() { return cacheClears; },
    clickDelete(id, { disabled = false } = {}) {
      assert.equal(typeof clickListener, 'function');
      clickListener({
        target: {
          closest() {
            return {
              disabled,
              getAttribute(name) { return name === 'data-task-id' ? id : null; }
            };
          }
        }
      });
    },
    drainMicrotasks() {
      for (const fn of microtasks.splice(0)) fn();
    }
  };
}

const trashed = { id: 'task-1', title: 'Preserve details', status: 'trashed', deletedAtISO: '2026-11-10T12:00:00Z' };
const taskState = () => ({ tasks: [{ id: 'other', status: 'active' }, { ...trashed }], completions: [{ id: 'c1' }] });

test('confirmed Task deletion uses its existing synchronous journal before any full snapshot', () => {
  const h = harness();
  h.clickDelete('task-1');
  const state = taskState();
  const result = h.core.saveStateSnapshot(state, { savePath: 'task-delete' });
  assert.equal(h.saved.length, 0, 'no full-state save after successful Task journal');
  assert.equal(h.journaled.length, 1, 'exactly one journal mutation');
  assert.deepEqual(h.journaled[0].task, trashed);
  assert.equal(result.state, state);
  assert.equal(result.taskDeleteFastPath, true);
  assert.equal(result.deferredFullSnapshot, true);
  assert.equal(h.cacheClears, 1);
  assert.equal(h.core.getTaskDeleteFastPathStatus().fastPathHits, 1);
  assert.ok(h.marks.some(m => m.name === 'taskDelete.journaled'));
});

test('unrelated full-state save and premature/nontrashed Task change retain original writer', () => {
  const h = harness();
  const state = taskState();
  const options = { storageKey: 'taskpoints_v1', immediateWrite: true };
  h.core.saveStateSnapshot(state, options);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].thisValue, h.core);
  assert.equal(h.saved[0].options, options);
  assert.equal(h.journaled.length, 0);
  h.clickDelete('task-1');
  const active = { tasks: [{ id: 'task-1', status: 'active' }] };
  const fallback = h.core.saveStateSnapshot(active, options);
  assert.equal(fallback.oldSnapshotSave, true);
  assert.equal(h.saved.length, 2);
  assert.equal(h.journaled.length, 0);
  assert.equal(h.core.getTaskDeleteFastPathStatus().fallbackSaves, 1);
});

test('failed or missing Task journal never acknowledges an unsaved fast-path mutation', () => {
  for (const options of [
    { rejectJournal: true },
    { rejectAdmission: true },
    { journalAvailable: false }
  ]) {
    const h = harness(options);
    h.core.armTaskDeleteFastPath('task-1');
    const state = taskState();
    const result = h.core.saveStateSnapshot(state, { savePath: 'trash', immediateWrite: true });
    assert.equal(h.saved.length, 1, 'original V1 writer must run on journal failure');
    assert.equal(h.journaled.length, 0);
    assert.equal(result.oldSnapshotSave, true);
    assert.notEqual(result.taskDeleteFastPath, true);
    assert.equal(h.core.getTaskDeleteFastPathStatus().fallbackSaves, 1);
    assert.equal(h.core.getTaskDeleteFastPathStatus().armed, false);
  }
});

test('unconsumed click arm expires in a microtask; disabled click cannot arm', () => {
  const h = harness();
  h.clickDelete('task-1', { disabled: true });
  assert.equal(h.core.getTaskDeleteFastPathStatus().armed, false);
  h.clickDelete('task-1');
  assert.equal(h.core.getTaskDeleteFastPathStatus().armed, true);
  h.drainMicrotasks();
  assert.equal(h.core.getTaskDeleteFastPathStatus().armed, false);
  const result = h.core.saveStateSnapshot(taskState());
  assert.equal(result.oldSnapshotSave, true);
  assert.equal(h.saved.length, 1);
  assert.equal(h.journaled.length, 0);
});
