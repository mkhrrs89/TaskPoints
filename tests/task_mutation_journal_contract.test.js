const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_mutation_journal.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
const homeSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const logSource = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');
const resetSource = fs.readFileSync(path.join(__dirname, '..', 'phase2_reset_hook.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_task_mutations_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows)); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function makeHarness(storageRows = {}) {
  const baseline = {
    tasks: [{ id: 't1', title: 'Task', status: 'active', counts: 0 }],
    completions: [{ id: 'old', taskId: 't1', title: 'Old', points: 1, completedAtISO: '2026-08-09T12:00:00.000Z' }]
  };
  const storage = new FakeStorage({ [STORAGE_KEY]: JSON.stringify(baseline), ...storageRows });
  const timers = [];
  const quietRuns = [];
  let saveCalls = 0;
  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readTaskPointsStoredState() { return JSON.parse(storage.getItem(STORAGE_KEY)); },
    loadAppState() { return { state: JSON.parse(storage.getItem(STORAGE_KEY)) }; },
    saveStateSnapshot(candidate) {
      saveCalls += 1;
      storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      return { state: clone(candidate) };
    },
    whenStorageMaintenanceQuiet(run) { quietRuns.push(run); return Promise.resolve(false); },
    noteStorageUserInteraction() {},
    clearStateHotCache() {}
  };
  const context = {
    console,
    TaskPointsCore: core,
    localStorage: storage,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestIdleCallback(fn) { fn(); return 1; },
    structuredClone: clone,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    Math,
    Promise
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'task_mutation_journal.js' });
  return { context, core, storage, timers, quietRuns, getSaveCalls: () => saveCalls };
}

test('worker bundles the task mutation journal before state hot cache', () => {
  const journalAt = workerSource.indexOf("'/task_mutation_journal.js'");
  const hotCacheAt = workerSource.indexOf("'/state_hot_cache.js'");
  assert.ok(journalAt >= 0 && hotCacheAt > journalAt);
  assert.match(workerSource, /taskMutationJournalSource/);
});

test('task completion mutation is durable immediately and replays without a full snapshot save', () => {
  const h = makeHarness();
  const task = { id: 't1', title: 'Task', status: 'completed', counts: 1 };
  const completion = { id: 'c1', taskId: 't1', title: 'Task', points: 5, completedAtISO: '2026-08-10T12:00:00.000Z' };
  h.core.journalTaskMutation({ task, completionUpsert: completion });
  assert.equal(h.getSaveCalls(), 0);
  const journal = JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.equal(journal.tasks.length, 1);
  assert.equal(journal.completionUpserts.length, 1);
  const loaded = h.core.loadAppState().state;
  assert.equal(loaded.tasks[0].status, 'completed');
  assert.equal(loaded.completions[0].id, 'c1');
});

test('task completion deletion replays and verified compaction clears the journal', () => {
  const h = makeHarness();
  const task = { id: 't1', title: 'Task', status: 'trashed', counts: 0 };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });
  let loaded = h.core.readTaskPointsStoredState();
  assert.equal(loaded.tasks[0].status, 'trashed');
  assert.equal(loaded.completions.length, 0);
  assert.equal(h.getSaveCalls(), 0);

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  loaded = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(loaded.tasks[0].status, 'trashed');
  assert.equal(loaded.completions.length, 0);
});

test('malformed journal is preserved and blocks a new journal mutation', () => {
  const h = makeHarness({ [JOURNAL_KEY]: '{bad-json' });
  assert.throws(() => h.core.assertTaskMutationJournalWritable(), /malformed and was preserved/);
  assert.throws(() => h.core.journalTaskMutation({ completionDeleteId: 'old' }), /malformed and was preserved/);
  assert.equal(h.storage.getItem(JOURNAL_KEY), '{bad-json');
  assert.equal(h.getSaveCalls(), 0);
});

test('full saves automatically include pending mutations before verification clears them', () => {
  const h = makeHarness();
  h.core.journalTaskMutation({ completionDeleteId: 'old' });
  const stale = JSON.parse(h.storage.getItem(STORAGE_KEY));
  h.core.saveStateSnapshot(stale, { savePath: 'unrelated-save' });
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.length, 0);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});

test('Home and Log use the tiny journal instead of immediate full-state saves for targeted interactions', () => {
  assert.match(homeSource, /journalTaskMutation\(\{ task: liveTask, completionUpsert: completion \}\)/);
  assert.match(logSource, /completionDeleteId: c\.id \|\| key/);
  assert.match(resetSource, /clearPendingTaskMutations\?\.\(\)/);
});
