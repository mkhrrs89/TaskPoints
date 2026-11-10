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

const realJournalSource = fs.readFileSync(path.join(__dirname, '..',
  'task_mutation_journal.js'), 'utf8');

function realJournalHarness({ quotaJournal = false } = {}) {
  const snapshot = { tasks: [{ id: 'task-1', title: 'Before', status: 'active' }],
    completions: [{ id: 'c1', taskId: 'task-1', points: 3 }] };
  const storageRows = new Map([['taskpoints_v1', JSON.stringify(snapshot)]]);
  let fullSaves = 0;
  const storage = {
    getItem(key) { return storageRows.get(String(key)) ?? null; },
    setItem(key, value) {
      if (quotaJournal && key === 'taskpoints_pending_task_mutations_v1')
        throw new Error('QuotaExceededError');
      storageRows.set(String(key), String(value));
    },
    removeItem(key) { storageRows.delete(String(key)); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    readTaskPointsStoredState() { return JSON.parse(storage.getItem('taskpoints_v1')); },
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    loadAppState() { return { state: this.readTaskPointsStoredState() }; },
    saveStateSnapshot(state) {
      fullSaves += 1;
      storage.setItem('taskpoints_v1', JSON.stringify(state));
      return { state };
    },
    getStorageMaintenanceIdleStatus() { return { lastInteractionAgoMs: 0 }; },
    clearStateHotCache() {}
  };
  const document = { addEventListener() {} };
  const context = {
    TaskPointsCore: core, localStorage: storage, document, structuredClone,
    setTimeout() { return 1; }, clearTimeout() {}, queueMicrotask() {},
    console, Promise, Date
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(realJournalSource, context, { filename: 'task_mutation_journal.js' });
  vm.runInContext(source, context, { filename: 'task_delete_fast_path.js' });
  return {
    core, storage,
    get fullSaves() { return fullSaves; }
  };
}

test('actual Task journal implementation persists a delete, overlays reads and compacts safely', () => {
  const h = realJournalHarness();
  const deletedState = taskState();
  h.core.armTaskDeleteFastPath('task-1');
  const routed = h.core.saveStateSnapshot(deletedState);
  assert.equal(routed.taskDeleteFastPath, true);
  assert.equal(h.fullSaves, 0);
  const journal = JSON.parse(h.storage.getItem('taskpoints_pending_task_mutations_v1'));
  assert.deepEqual(journal.tasks.map(t => t.id), ['task-1']);
  assert.equal(journal.tasks[0].status, 'trashed');
  assert.equal(h.core.readTaskPointsStoredState().tasks.find(t => t.id === 'task-1').status, 'trashed');
  assert.equal(h.core.getTaskMutationJournalStatus().tasks, 1);
  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.storage.getItem('taskpoints_pending_task_mutations_v1'), null);
  const saved = JSON.parse(h.storage.getItem('taskpoints_v1'));
  assert.equal(saved.tasks.find(t => t.id === 'task-1').status, 'trashed');
  assert.equal(saved.completions[0].id, 'c1');
});

test('actual Task journal quota rejection falls back to full V1 save without false fast-path acknowledgment', () => {
  const h = realJournalHarness({ quotaJournal: true });
  const deletedState = taskState();
  h.core.armTaskDeleteFastPath('task-1');
  const result = h.core.saveStateSnapshot(deletedState, { immediateWrite: true });
  assert.equal(result.taskDeleteFastPath, undefined);
  assert.equal(h.fullSaves, 1);
  assert.equal(h.storage.getItem('taskpoints_pending_task_mutations_v1'), null);
  const saved = JSON.parse(h.storage.getItem('taskpoints_v1'));
  assert.equal(saved.tasks.find(t => t.id === 'task-1').status, 'trashed');
  assert.equal(saved.completions[0].id, 'c1');
});

test('M01 Task-delete witness is explicitly non-production and tied to one writer path', () => {
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..',
    'docs/state-runtime-v2-storage-source-inventory.json'), 'utf8'));
  const witnesses = inv.writerBehaviorWitnesses || [];
  const taskDelete = witnesses.filter(row => row.path === 'task_delete_fast_path.js');
  assert.equal(taskDelete.length, 1,
    'Task-delete ownership must retain exactly one explicit behavior witness');
  const witness = taskDelete[0];
  assert.equal(witness.path, 'task_delete_fast_path.js');
  assert.equal(witness.testPath, 'tests/state_runtime_v2_m01_task_delete_behavior_contract.test.js');
  assert.ok(inv.writerPathEvidence.some(row =>
    row.path === witness.path && row.anchor === witness.anchor));
  assert.ok(witness.observedBehaviors.length >= 5);
  assert.equal(witness.productionOwnerVerified, false);
  assert.equal(witness.productionFenceVerified, false);
  assert.equal(witness.cutoverPermission, false);
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes, witnesses.length);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments, 0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced, false);
  assert.equal(inv.writerOwnershipAudit.status, 'incomplete');
});
