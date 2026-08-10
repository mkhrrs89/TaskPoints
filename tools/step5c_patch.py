from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 target, found {count}')
    p.write_text(s.replace(old, new, 1))

# Strengthen journal preflight so recovery/malformed protection is checked before UI state mutates.
replace_once(
    'task_mutation_journal.js',
    """  function invalidateReadCaches() {\n    try { core.clearStateHotCache?.(); } catch (_) {}\n  }\n\n  function writeRecord(record) {""",
    """  function invalidateReadCaches() {\n    try { core.clearStateHotCache?.(); } catch (_) {}\n  }\n\n  function assertJournalWritable() {\n    if (!recoveryWriteAllowed()) {\n      const error = new Error('TaskPoints paused task changes while recovery protection is active.');\n      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_WRITE_LOCKED';\n      throw error;\n    }\n    const current = readRecord();\n    if (current.malformed) {\n      const error = new Error('Pending task mutation journal is malformed and was preserved.');\n      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED';\n      throw error;\n    }\n    return current;\n  }\n\n  function writeRecord(record) {""",
    'journal preflight helper'
)
replace_once(
    'task_mutation_journal.js',
    """  function journalMutation(mutation = {}) {\n    const current = readRecord();\n    if (current.malformed) {\n      const error = new Error('Pending task mutation journal is malformed and was preserved.');\n      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED';\n      throw error;\n    }\n    let record = current.record;""",
    """  function journalMutation(mutation = {}) {\n    const current = assertJournalWritable();\n    let record = current.record;""",
    'journal mutation preflight'
)
replace_once(
    'task_mutation_journal.js',
    """  core.readPendingTaskMutations = () => readRecord();\n  core.applyPendingTaskMutations = applyRecord;\n  core.journalTaskMutation = journalMutation;""",
    """  core.readPendingTaskMutations = () => readRecord();\n  core.applyPendingTaskMutations = applyRecord;\n  core.assertTaskMutationJournalWritable = assertJournalWritable;\n  core.journalTaskMutation = journalMutation;""",
    'journal export preflight'
)

# Home ordinary task completion: create the completion object once, journal exact task + completion,
# and do not synchronously recompress the full state on the completion callback.
replace_once(
    'index.html',
    """      addCompletion({\n        id: crypto.randomUUID(),\n        taskId: id,\n        title: liveTask.title,\n        points: liveTask.points,\n        completedAtISO: now\n      });""",
    """      try { TaskPointsCore?.assertTaskMutationJournalWritable?.(); }\n      catch (error) {\n        console.warn('Task completion paused because its durable journal is unavailable.', error);\n        try { alert(error?.message || 'Task completion is temporarily unavailable.'); } catch (_) {}\n        return;\n      }\n\n      const completion = {\n        id: crypto.randomUUID(),\n        taskId: id,\n        title: liveTask.title,\n        points: liveTask.points,\n        completedAtISO: now\n      };\n      addCompletion(completion);""",
    'home completion object'
)
replace_once(
    'index.html',
    """      liveTask.updatedAtISO = now;\n      removeTaskFromTodayView(id, completedDayKey);\n      save();\n      window.updateCriticalTasksIsland?.();""",
    """      liveTask.updatedAtISO = now;\n      removeTaskFromTodayView(id, completedDayKey);\n      if (TaskPointsCore?.journalTaskMutation) {\n        TaskPointsCore.journalTaskMutation({ task: liveTask, completionUpsert: completion });\n      } else {\n        save();\n      }\n      window.updateCriticalTasksIsland?.();""",
    'home task journal save'
)

# Log ordinary task/flex completion deletion: preserve native confirmation semantics,
# then journal the exact deletion and any linked task mutation instead of recompressing immediately.
replace_once(
    'log.html',
    """  const nowISO = new Date().toISOString();\n\n  if (c.taskId) {""",
    """  try { TaskPointsCore?.assertTaskMutationJournalWritable?.(); }\n  catch (error) {\n    console.warn('Log deletion paused because its durable journal is unavailable.', error);\n    try { alert(error?.message || 'Deletion is temporarily unavailable.'); } catch (_) {}\n    return;\n  }\n\n  const nowISO = new Date().toISOString();\n\n  if (c.taskId) {""",
    'log deletion journal preflight'
)
replace_once(
    'log.html',
    """  state.completions.splice(idx, 1);\n  save();\n  render();\n}\n\n\nfunction editCompletionDate(id){""",
    """  state.completions.splice(idx, 1);\n  if (TaskPointsCore?.journalTaskMutation) {\n    const linkedTask = c.taskId\n      ? (state.tasks || []).find(task => task && task.id === c.taskId) || null\n      : null;\n    TaskPointsCore.journalTaskMutation({\n      ...(linkedTask ? { task: linkedTask } : {}),\n      completionDeleteId: c.id || key\n    });\n  } else {\n    save();\n  }\n  render();\n}\n\n\nfunction editCompletionDate(id){""",
    'log deletion journal save'
)

# A real Reset All leaves taskpoints_v1 absent after the safe-replace microtask. Clear the task
# journal only in that confirmed-reset case; never during safeReplace's temporary remove/set pair.
replace_once(
    'phase2_reset_hook.js',
    """        if (storage.getItem(key) === null) {\n          const operation = core.queueShadowDualWrite({}, { reset: true });""",
    """        if (storage.getItem(key) === null) {\n          try { core.clearPendingTaskMutations?.(); } catch (_) {}\n          const operation = core.queueShadowDualWrite({}, { reset: true });""",
    'reset journal cleanup'
)

# Bundle the journal after the existing core/fast-path layers but before the hot cache so cached reads
# always include pending mutations.
replace_once(
    '_worker.js',
    """  '/season_series_upset_notifications.js',\n  '/state_hot_cache.js',""",
    """  '/season_series_upset_notifications.js',\n  '/task_mutation_journal.js',\n  '/state_hot_cache.js',""",
    'worker fingerprint asset'
)
replace_once(
    '_worker.js',
    """  const [perfSource, aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource, seasonSeriesUpsetSource, stateHotCacheSource, storageIdleSource] = await Promise.all([""",
    """  const [perfSource, aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource, seasonSeriesUpsetSource, taskMutationJournalSource, stateHotCacheSource, storageIdleSource] = await Promise.all([""",
    'worker source variables'
)
replace_once(
    '_worker.js',
    """    readAssetSource(env, request, '/season_series_upset_notifications.js'),\n    readAssetSource(env, request, '/state_hot_cache.js'),""",
    """    readAssetSource(env, request, '/season_series_upset_notifications.js'),\n    readAssetSource(env, request, '/task_mutation_journal.js'),\n    readAssetSource(env, request, '/state_hot_cache.js'),""",
    'worker source read'
)
replace_once(
    '_worker.js',
    """  const additions = [aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource, seasonSeriesUpsetSource, stateHotCacheSource, storageIdleSource].filter(Boolean);""",
    """  const additions = [aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource, seasonSeriesUpsetSource, taskMutationJournalSource, stateHotCacheSource, storageIdleSource].filter(Boolean);""",
    'worker additions'
)
replace_once(
    '_worker.js',
    """    'x-taskpoints-season-series-upsets': seasonSeriesUpsetSource ? 'included' : 'missing',\n    'x-taskpoints-state-hot-cache': stateHotCacheSource ? 'included' : 'missing',""",
    """    'x-taskpoints-season-series-upsets': seasonSeriesUpsetSource ? 'included' : 'missing',\n    'x-taskpoints-task-mutation-journal': taskMutationJournalSource ? 'included' : 'missing',\n    'x-taskpoints-state-hot-cache': stateHotCacheSource ? 'included' : 'missing',""",
    'worker response header'
)

# Contract tests exercise replay, deletion, verified compaction, malformed protection, reset cleanup,
# and the two page integration points.
Path('tests/task_mutation_journal_contract.test.js').write_text(r'''const test = require('node:test');
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
''')
