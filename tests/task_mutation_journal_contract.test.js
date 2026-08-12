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

function makeHarness(storageRows = {}, options = {}) {
  const baseline = {
    tasks: [{ id: 't1', title: 'Task', status: 'active', counts: 0 }],
    completions: [{ id: 'old', taskId: 't1', title: 'Old', points: 1, completedAtISO: '2026-08-09T12:00:00.000Z' }]
  };
  const storage = new FakeStorage({ [STORAGE_KEY]: JSON.stringify(baseline), ...storageRows });
  const timers = [];
  const quietRuns = [];
  let saveCalls = 0;
  let maintenanceQuiet = true;
  let lastInteractionAgoMs = 10000;
  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readTaskPointsStoredState() { return JSON.parse(storage.getItem(STORAGE_KEY)); },
    loadAppState() { return { state: JSON.parse(storage.getItem(STORAGE_KEY)) }; },
    saveStateSnapshot(candidate) {
      saveCalls += 1;
      const committed = typeof options.saveTransform === 'function'
        ? options.saveTransform(clone(candidate))
        : clone(candidate);
      storage.setItem(STORAGE_KEY, JSON.stringify(committed));
      const returnedState = typeof options.returnedStateTransform === 'function'
        ? options.returnedStateTransform(clone(committed), clone(candidate))
        : clone(committed);
      return { state: returnedState };
    },
    whenStorageMaintenanceQuiet(run) { quietRuns.push(run); return Promise.resolve(run()); },
    isStorageMaintenanceQuiet() { return maintenanceQuiet; },
    getStorageMaintenanceIdleStatus() { return { lastInteractionAgoMs }; },
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
  return {
    context, core, storage, timers, quietRuns,
    getSaveCalls: () => saveCalls,
    setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); },
    setLastInteractionAgoMs(value) { lastInteractionAgoMs = Number(value) || 0; }
  };
}

async function runNextTimer(harness) {
  const callback = harness.timers.shift();
  assert.ok(callback, 'expected a scheduled timer');
  callback();
  await Promise.resolve();
  await Promise.resolve();
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


test('scheduled compaction waits until at least seven seconds since the latest interaction', async () => {
  const h = makeHarness();
  h.setLastInteractionAgoMs(1400);
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup-replay timer; compaction is already scheduled
  await runNextTimer(h); // shared quiet gate -> remaining time to seven seconds idle
  assert.equal(h.getSaveCalls(), 0, 'shared quiet alone must not start full-state compression');
  assert.ok(h.timers.length >= 1, 'the sustained-idle timer should be pending');

  h.setLastInteractionAgoMs(7000);
  await runNextTimer(h); // seven seconds idle -> idle callback -> compaction
  await Promise.resolve();
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.core.getTaskMutationJournalStatus().minIdleBeforeCompactionMs, 7000);
});

test('a user interaction during the extra grace period defers compaction instead of entering compression', async () => {
  const h = makeHarness();
  h.setLastInteractionAgoMs(1400);
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup-replay timer
  await runNextTimer(h); // shared gate passes; sustained-idle timer is now pending
  h.setLastInteractionAgoMs(200);
  h.setMaintenanceQuiet(false);
  await runNextTimer(h); // wait expires after a newer interaction
  await Promise.resolve();

  assert.equal(h.getSaveCalls(), 0, 'full-state save must yield when quiet was broken');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'durable journal must remain pending');
  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);
});


test('a newer journal mutation invalidates an older startup preflight countdown', async () => {
  const h = makeHarness();
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup timer cannot replace the already scheduled mutation run
  await runNextTimer(h); // existing run passes shared quiet and begins extra grace

  h.core.journalTaskMutation({ task: { id: 't1', title: 'Task', status: 'trashed', counts: 0 } });
  await runNextTimer(h); // old grace expires; generation mismatch must abort it
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.getSaveCalls(), 0, 'an older preflight must not compact a newer mutation');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'newer mutation must remain durable in the journal');
  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration, 2);
});

test('verification accepts the save pipeline normalized task row and clears the journal', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) delete task.deletedAt; // representative legacy alias stripped by normalization
      return candidate;
    }
  });
  const task = {
    id: 't1', title: 'Task', status: 'trashed', counts: 0,
    deletedAtISO: '2026-08-11T12:00:00.000Z',
    deletedAt: '2026-08-11T12:00:00.000Z',
    completedAtISO: null,
    hidden: false
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'verified normalized persistence should not retry forever');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].status, 'trashed');
  assert.equal(persisted.tasks[0].deletedAtISO, task.deletedAtISO);
  assert.equal('deletedAt' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});


test('verification accepts canonical task defaults omitted by compact localStorage', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (!task) return candidate;
      if (task.originalDueDateISO === task.dueDateISO) delete task.originalDueDateISO;
      if (task.recurrence?.mode === 'none' && Object.keys(task.recurrence).length === 1) delete task.recurrence;
      if (Array.isArray(task.tags) && task.tags.length === 0) delete task.tags;
      if (Array.isArray(task.skipDates) && task.skipDates.length === 0) delete task.skipDates;
      if (Array.isArray(task.skills) && task.skills.length === 2 && task.skills.every((slot) => slot?.skill === '' && slot?.pts === '')) delete task.skills;
      if (task.hidden === false) delete task.hidden;
      ['deletedAt', 'deletedFrom', 'prevStatus', 'completedAtISO'].forEach((key) => {
        if (task[key] == null) delete task[key];
      });
      if (Number(task.postponedDays) === 0) delete task.postponedDays;
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  const task = {
    id: 't1',
    title: 'Task',
    status: 'active',
    counts: 0,
    dueDateISO: '2026-08-12',
    originalDueDateISO: '2026-08-12',
    recurrence: { mode: 'none' },
    tags: [],
    skipDates: [],
    skills: [{ skill: '', pts: '' }, { skill: '', pts: '' }],
    hidden: false,
    deletedAt: null,
    deletedAtISO: null,
    deletedFrom: null,
    prevStatus: null,
    completedAtISO: null,
    postponedDays: 0
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'canonical compact omissions must verify and clear the journal');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.__storageCompactVersion, 1);
  assert.equal(persisted.tasks[0].dueDateISO, task.dueDateISO);
  assert.equal('originalDueDateISO' in persisted.tasks[0], false);
  assert.equal('hidden' in persisted.tasks[0], false);
  assert.equal('postponedDays' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});

test('compact task verification still rejects substantive field corruption', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) task.status = 'trashed';
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  h.core.journalTaskMutation({
    task: { id: 't1', title: 'Task', status: 'active', counts: 0 },
    completionDeleteId: 'old'
  });

  assert.equal(h.core.flushPendingTaskMutations(), false);
  assert.equal(h.getSaveCalls(), 1);
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'journal must remain durable after substantive verification failure');
});
