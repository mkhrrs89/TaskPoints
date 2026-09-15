const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    dump(key) { return map.get(String(key)) ?? null; }
  };
}

function makeHarness({ pendingJournal = null } = {}) {
  const JOURNAL_KEY = 'taskpoints_pending_inbox_state_v1';
  const localStorage = makeStorage(pendingJournal ? {
    [JOURNAL_KEY]: JSON.stringify({ schemaVersion: 1, ...pendingJournal })
  } : {});
  const timers = [];
  const perfMarks = [];
  let canonical = {
    inboxMessages: [{ id: 'old' }],
    inboxProcessedEventIds: { 'old-event': true },
    inboxStartedDateKey: '2026-08-20',
    tasks: [{ id: 'task-1' }]
  };
  let heavySaves = 0;
  let quietMs = 0;

  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    loadAppState() {
      return { state: structuredClone(canonical) };
    },
    readTaskPointsStoredState() {
      return structuredClone(canonical);
    },
    mergeAndSaveState(nextState, options = {}) {
      heavySaves += 1;
      canonical = { ...canonical, ...structuredClone(nextState) };
      return { state: structuredClone(canonical), options: { ...options } };
    },
    getStorageMaintenanceIdleStatus() {
      return {
        lastInteractionAgoMs: quietMs,
        navigationQuietForMs: 0,
        pageLeaving: false,
        activeEditor: false
      };
    },
    clearStateHotCache() {}
  };

  const context = {
    TaskPointsCore: core,
    TaskPointsStateRevision: { bump() {} },
    TaskPointsPerf: { mark(name, detail) { perfMarks.push({ name, detail }); } },
    localStorage,
    document: null,
    performance: { now: () => 0 },
    structuredClone,
    Date,
    Error,
    Promise,
    JSON,
    console,
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout() {},
    queueMicrotask() {}
  };
  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'task_create_fast_path.js' });

  return {
    context,
    core,
    localStorage,
    perfMarks,
    JOURNAL_KEY,
    get heavySaves() { return heavySaves; },
    setQuietMs(value) { quietMs = value; },
    runNextTimer() {
      const timer = timers.shift();
      if (!timer) return false;
      timer.fn();
      return true;
    }
  };
}

test('Inbox auto-populate journals only the three Inbox fields instead of running a full save', () => {
  const h = makeHarness();
  const patch = {
    inboxMessages: [{ id: 'new-1' }, { id: 'new-2' }],
    inboxProcessedEventIds: { 'event-1': true, 'event-2': true },
    inboxStartedDateKey: '2026-08-24'
  };

  const result = h.core.mergeAndSaveState(patch, {
    savePath: 'inbox-auto-populate',
    immediateWrite: true,
    assumeNormalized: true
  });

  assert.equal(h.heavySaves, 0);
  assert.equal(result.inboxJournalFastPath, true);
  assert.equal(result.deferredFullSnapshot, true);
  assert.equal(result.encoding, 'inbox-journal-v2');

  const stored = JSON.parse(h.localStorage.dump(h.JOURNAL_KEY));
  assert.deepEqual(stored.inboxMessages, patch.inboxMessages);
  assert.deepEqual(stored.inboxProcessedEventIds, patch.inboxProcessedEventIds);
  assert.equal(stored.inboxStartedDateKey, patch.inboxStartedDateKey);
  assert.ok(h.perfMarks.some((entry) => entry.name === 'inbox.populate.journalSave'));
});

test('pending Inbox journal overlays both stored-state reads and loadAppState', () => {
  const pending = {
    inboxMessages: [{ id: 'pending' }],
    inboxProcessedEventIds: { 'pending-event': true },
    inboxStartedDateKey: '2026-08-24',
    updatedAtISO: '2026-08-24T18:00:00.000Z'
  };
  const h = makeHarness({ pendingJournal: pending });

  const stored = h.core.readTaskPointsStoredState();
  const loaded = h.core.loadAppState();

  assert.deepEqual(stored.inboxMessages, pending.inboxMessages);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.inboxProcessedEventIds)), { 'old-event': true, 'pending-event': true });
  assert.equal(stored.inboxStartedDateKey, pending.inboxStartedDateKey);
  assert.deepEqual(loaded.state.inboxMessages, pending.inboxMessages);
  assert.equal(loaded.pendingInboxJournal, true);
});

test('unrelated mergeAndSaveState calls still use the original full save path', () => {
  const h = makeHarness();

  h.core.mergeAndSaveState({ tasks: [{ id: 'changed' }] }, { savePath: 'unrelated-save' });

  assert.equal(h.heavySaves, 1);
  assert.equal(h.localStorage.dump(h.JOURNAL_KEY), null);
});

test('journal compacts into canonical state only after sustained quiet and then clears itself', () => {
  const pending = {
    inboxMessages: [{ id: 'pending' }],
    inboxProcessedEventIds: { 'pending-event': true },
    inboxStartedDateKey: '2026-08-24',
    updatedAtISO: '2026-08-24T18:00:00.000Z'
  };
  const h = makeHarness({ pendingJournal: pending });

  h.setQuietMs(1000);
  assert.equal(h.runNextTimer(), true);
  assert.equal(h.heavySaves, 0);
  assert.notEqual(h.localStorage.dump(h.JOURNAL_KEY), null);

  h.setQuietMs(9000);
  assert.equal(h.runNextTimer(), true);
  assert.equal(h.heavySaves, 1);
  assert.equal(h.localStorage.dump(h.JOURNAL_KEY), null);
  assert.ok(h.perfMarks.some((entry) => entry.name === 'inbox.journal.compactionComplete'));
});


test('notification Inbox save paths share the small journal and preserve processed-event object maps', () => {
  const h = makeHarness();

  const seasonPatch = {
    inboxMessages: [{ id: 'season-message' }],
    inboxProcessedEventIds: { 'old-event': true, 'season-event': true },
    inboxStartedDateKey: '2026-08-24'
  };
  const seasonResult = h.core.mergeAndSaveState(seasonPatch, {
    savePath: 'season-series-upset-inbox',
    immediateWrite: true,
    assumeNormalized: true
  });
  assert.equal(h.heavySaves, 0);
  assert.equal(seasonResult.inboxJournalFastPath, true);
  assert.equal(seasonResult.journalSavePath, 'season-series-upset-inbox');

  let stored = JSON.parse(h.localStorage.dump(h.JOURNAL_KEY));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.inboxProcessedEventIds, seasonPatch.inboxProcessedEventIds);

  const stateAfterSeason = h.core.readTaskPointsStoredState();
  const goldPatch = {
    inboxMessages: [...stateAfterSeason.inboxMessages, { id: 'gold-message' }],
    inboxProcessedEventIds: {
      ...stateAfterSeason.inboxProcessedEventIds,
      'gold-event': true
    },
    goldTheftTop50InboxStartedDateKey: '2026-09-10'
  };
  const goldResult = h.core.mergeAndSaveState(goldPatch, {
    savePath: 'gold-theft-top50-inbox',
    immediateWrite: true,
    assumeNormalized: true
  });
  assert.equal(h.heavySaves, 0);
  assert.equal(goldResult.inboxJournalFastPath, true);

  stored = JSON.parse(h.localStorage.dump(h.JOURNAL_KEY));
  assert.equal(stored.inboxStartedDateKey, '2026-08-24', 'gold save must preserve generic Inbox rollout date');
  assert.equal(stored.goldTheftTop50InboxStartedDateKey, '2026-09-10');
  assert.deepEqual(stored.inboxProcessedEventIds, {
    'old-event': true,
    'season-event': true,
    'gold-event': true
  });

  const stateAfterGold = h.core.loadAppState().state;
  h.core.mergeAndSaveState({
    inboxMessages: [...stateAfterGold.inboxMessages, { id: 'generic-message' }],
    inboxProcessedEventIds: {
      ...stateAfterGold.inboxProcessedEventIds,
      'generic-event': true
    },
    inboxStartedDateKey: '2026-08-25'
  }, {
    savePath: 'inbox-auto-populate',
    immediateWrite: true,
    assumeNormalized: true
  });

  assert.equal(h.heavySaves, 0, 'all three background Inbox producers must remain journal-only before idle');
  stored = JSON.parse(h.localStorage.dump(h.JOURNAL_KEY));
  assert.equal(stored.goldTheftTop50InboxStartedDateKey, '2026-09-10', 'generic Inbox save must preserve Gold rollout date');
  assert.deepEqual(stored.inboxProcessedEventIds, {
    'old-event': true,
    'season-event': true,
    'gold-event': true,
    'generic-event': true
  });

  h.setQuietMs(9000);
  assert.equal(h.runNextTimer(), true);
  assert.equal(h.heavySaves, 1, 'the shared Inbox journal should compact once after sustained idle');
  assert.equal(h.localStorage.dump(h.JOURNAL_KEY), null);

  const canonical = h.core.readTaskPointsStoredState();
  assert.equal(canonical.inboxStartedDateKey, '2026-08-25');
  assert.equal(canonical.goldTheftTop50InboxStartedDateKey, '2026-09-10');
  assert.deepEqual(canonical.inboxProcessedEventIds, {
    'old-event': true,
    'season-event': true,
    'gold-event': true,
    'generic-event': true
  });
});

test('legacy v1 array journals cannot wipe canonical processed-event IDs during upgrade or compaction', () => {
  const h = makeHarness({
    pendingJournal: {
      inboxMessages: [{ id: 'pending' }],
      inboxProcessedEventIds: [],
      inboxStartedDateKey: '2026-08-24',
      updatedAtISO: '2026-08-24T18:00:00.000Z'
    }
  });

  const effective = h.core.readTaskPointsStoredState();
  assert.deepEqual(JSON.parse(JSON.stringify(effective.inboxProcessedEventIds)), { 'old-event': true });

  h.setQuietMs(9000);
  assert.equal(h.runNextTimer(), true);
  assert.equal(h.heavySaves, 1);
  assert.equal(h.localStorage.dump(h.JOURNAL_KEY), null);
  assert.deepEqual(JSON.parse(JSON.stringify(h.core.readTaskPointsStoredState().inboxProcessedEventIds)), { 'old-event': true });
});
