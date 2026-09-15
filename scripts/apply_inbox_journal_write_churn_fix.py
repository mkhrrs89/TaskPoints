from pathlib import Path

MODULE = Path('task_create_fast_path.js')
TEST = Path('tests/inbox_mutation_journal_fast_path.test.js')

module = MODULE.read_text()
marker = "// The full TaskPoints snapshot is now too large for the generic packed\n"
start = module.find(marker)
if start < 0:
    raise SystemExit('Inbox journal block marker not found')

new_block = r'''// The full TaskPoints snapshot is now too large for background Inbox maintenance.
// Keep Inbox-related mutations crash-safe by writing only their small shared fields
// to a synchronous journal, overlaying that journal on reads, and compacting once
// after sustained idle. This also prevents independent notification reconcilers
// from repeatedly overwriting each other's processed-event state.
;(function installTaskPointsInboxMutationJournal(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__inboxMutationJournalInstalled || typeof core.mergeAndSaveState !== 'function') return;
  core.__inboxMutationJournalInstalled = true;

  const JOURNAL_KEY = 'taskpoints_pending_inbox_state_v1';
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_SCHEMA_VERSION = 2;
  const COMPACTION_QUIET_MS = 8000;
  const POLL_MS = 500;
  const JOURNALED_SAVE_PATHS = new Set([
    'inbox-auto-populate',
    'season-series-upset-inbox',
    'gold-theft-top50-inbox'
  ]);
  const TRACKED_FIELDS = [
    'inboxMessages',
    'inboxProcessedEventIds',
    'inboxStartedDateKey',
    'goldTheftTop50InboxStartedDateKey'
  ];
  const originalMergeAndSaveState = core.mergeAndSaveState.bind(core);
  const originalReadStored = typeof core.readTaskPointsStoredState === 'function'
    ? core.readTaskPointsStoredState.bind(core)
    : null;
  const originalLoadAppState = typeof core.loadAppState === 'function'
    ? core.loadAppState.bind(core)
    : null;

  let timer = 0;
  let journalSaves = 0;
  let fallbackSaves = 0;
  let compactionsStarted = 0;
  let compactionsCompleted = 0;
  let compactionDeferrals = 0;

  const mark = (name, detail = {}) => {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  };
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function processedEventMap(value) {
    if (Array.isArray(value)) {
      const map = {};
      value.forEach((eventId) => {
        const id = String(eventId || '').trim();
        if (id) map[id] = true;
      });
      return map;
    }
    if (value && typeof value === 'object') return clone(value);
    return {};
  }

  function normalizePatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const schemaVersion = Number(value.schemaVersion || 1);
    if (schemaVersion !== 1 && schemaVersion !== JOURNAL_SCHEMA_VERSION) return null;

    const record = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      updatedAtISO: typeof value.updatedAtISO === 'string' ? value.updatedAtISO : new Date().toISOString()
    };

    if (hasOwn(value, 'inboxMessages')) {
      if (!Array.isArray(value.inboxMessages)) return null;
      record.inboxMessages = clone(value.inboxMessages);
    }
    if (hasOwn(value, 'inboxProcessedEventIds')) {
      if (!Array.isArray(value.inboxProcessedEventIds)
        && (!value.inboxProcessedEventIds || typeof value.inboxProcessedEventIds !== 'object')) return null;
      record.inboxProcessedEventIds = processedEventMap(value.inboxProcessedEventIds);
    }
    if (hasOwn(value, 'inboxStartedDateKey')) {
      record.inboxStartedDateKey = value.inboxStartedDateKey == null ? null : String(value.inboxStartedDateKey);
    }
    if (hasOwn(value, 'goldTheftTop50InboxStartedDateKey')) {
      record.goldTheftTop50InboxStartedDateKey = value.goldTheftTop50InboxStartedDateKey == null
        ? null
        : String(value.goldTheftTop50InboxStartedDateKey);
    }

    return TRACKED_FIELDS.some((field) => hasOwn(record, field)) ? record : null;
  }

  function readJournal() {
    let raw = '';
    try { raw = storage.getItem(JOURNAL_KEY) || ''; }
    catch (_) { return { raw: '', malformed: true, record: null }; }
    if (!raw) return { raw: '', malformed: false, record: null };
    try {
      const record = normalizePatch(JSON.parse(raw));
      return record ? { raw, malformed: false, record } : { raw, malformed: true, record: null };
    } catch (_) {
      return { raw, malformed: true, record: null };
    }
  }

  function applyPatch(state, record) {
    if (!state || typeof state !== 'object' || !record) return state;
    const next = { ...state };
    TRACKED_FIELDS.forEach((field) => {
      if (!hasOwn(record, field)) return;
      if (field === 'inboxProcessedEventIds') {
        next[field] = {
          ...processedEventMap(state?.[field]),
          ...processedEventMap(record[field])
        };
      } else {
        next[field] = clone(record[field]);
      }
    });
    return next;
  }

  function buildCompactionPatch(record, canonicalState = null) {
    const patch = {};
    TRACKED_FIELDS.forEach((field) => {
      if (!hasOwn(record, field)) return;
      if (field === 'inboxProcessedEventIds') {
        patch[field] = {
          ...processedEventMap(canonicalState?.[field]),
          ...processedEventMap(record[field])
        };
      } else {
        patch[field] = clone(record[field]);
      }
    });
    return patch;
  }

  function patchesMatch(state, record) {
    if (!state || !record) return false;
    try {
      return TRACKED_FIELDS.every((field) => {
        if (!hasOwn(record, field)) return true;
        if (field === 'inboxProcessedEventIds') {
          const actual = processedEventMap(state[field]);
          const expected = processedEventMap(record[field]);
          return Object.keys(expected).every((key) => actual[key] === expected[key]);
        }
        return JSON.stringify(state[field] ?? null) === JSON.stringify(record[field] ?? null);
      });
    } catch (_) {
      return false;
    }
  }

  function invalidateCaches() {
    try { core.clearStateHotCache?.(); } catch (_) {}
  }

  function compactionReady() {
    let status = null;
    try { status = core.getStorageMaintenanceIdleStatus?.() || null; } catch (_) {}
    if (!status) return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= COMPACTION_QUIET_MS;
  }

  function scheduleCompaction(delayMs = POLL_MS) {
    if (timer || typeof global.setTimeout !== 'function') return;
    timer = global.setTimeout(() => {
      timer = 0;
      attemptCompaction();
    }, Math.max(POLL_MS, Number(delayMs) || POLL_MS));
  }

  function attemptCompaction() {
    const current = readJournal();
    if (!current.record || current.malformed) return false;
    if (!compactionReady()) {
      compactionDeferrals += 1;
      scheduleCompaction();
      return false;
    }

    compactionsStarted += 1;
    mark('inbox.journal.compactionStart', { journalBytes: current.raw.length });
    const rawSnapshot = current.raw;
    const record = current.record;
    try {
      // Read canonical state only once, during deep idle, so a legacy v1 journal
      // can never erase processed-event IDs that are already durable.
      const canonicalBefore = originalReadStored ? originalReadStored(STORAGE_KEY, {}) : null;
      const patch = buildCompactionPatch(record, canonicalBefore);
      const result = originalMergeAndSaveState(patch, {
        savePath: 'inbox-journal-compaction',
        immediateWrite: true,
        assumeNormalized: true
      });
      if (result?.skipped || result?.blockedByQuotaCircuit) throw new Error('Inbox journal compaction was not committed.');

      const persisted = originalReadStored
        ? originalReadStored(STORAGE_KEY, {})
        : result?.state;
      if (!patchesMatch(persisted, record)) throw new Error('Inbox journal compaction verification failed.');

      const latest = readJournal();
      if (latest.raw === rawSnapshot) storage.removeItem(JOURNAL_KEY);
      invalidateCaches();
      compactionsCompleted += 1;
      mark('inbox.journal.compactionComplete', { journalBytes: rawSnapshot.length });
      return true;
    } catch (error) {
      mark('inbox.journal.compactionFailed', { message: String(error?.message || error || 'unknown') });
      scheduleCompaction(2000);
      return false;
    }
  }

  function writeJournal(nextState, savePath = '') {
    const existing = readJournal();
    if (existing.malformed) {
      const error = new Error('Pending Inbox journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_INBOX_JOURNAL_MALFORMED';
      throw error;
    }

    const candidate = existing.record ? clone(existing.record) : { schemaVersion: JOURNAL_SCHEMA_VERSION };
    TRACKED_FIELDS.forEach((field) => {
      if (!hasOwn(nextState, field)) return;
      if (field === 'inboxProcessedEventIds') {
        candidate[field] = {
          ...processedEventMap(candidate[field]),
          ...processedEventMap(nextState[field])
        };
      } else {
        candidate[field] = clone(nextState[field]);
      }
    });
    candidate.schemaVersion = JOURNAL_SCHEMA_VERSION;
    candidate.updatedAtISO = new Date().toISOString();

    const record = normalizePatch(candidate);
    if (!record) throw new Error('Inbox journal patch was invalid.');
    const raw = JSON.stringify(record);
    storage.setItem(JOURNAL_KEY, raw);
    invalidateCaches();
    try { global.TaskPointsStateRevision?.bump?.('inbox-journal'); } catch (_) {}
    scheduleCompaction();
    journalSaves += 1;
    const processed = processedEventMap(record.inboxProcessedEventIds);
    mark('inbox.populate.journalSave', {
      savePath,
      journalBytes: raw.length,
      messageCount: Array.isArray(record.inboxMessages) ? record.inboxMessages.length : 0,
      processedEventCount: Object.keys(processed).length,
      deferredFullSnapshot: true
    });
    return record;
  }

  core.mergeAndSaveState = function inboxJournalMergeAndSaveState(nextState, options = {}) {
    const savePath = String(options?.savePath || '');
    if (!JOURNALED_SAVE_PATHS.has(savePath)) {
      return originalMergeAndSaveState(nextState, options);
    }

    try {
      const record = writeJournal(nextState, savePath);
      return {
        state: applyPatch({}, record),
        inboxJournalFastPath: true,
        journalSavePath: savePath,
        deferredFullSnapshot: true,
        deferredCompression: false,
        encoding: 'inbox-journal-v2'
      };
    } catch (error) {
      fallbackSaves += 1;
      mark('inbox.populate.journalFallback', {
        savePath,
        message: String(error?.message || error || 'journal_failed')
      });
      return originalMergeAndSaveState(nextState, options);
    }
  };

  if (originalReadStored) {
    core.readTaskPointsStoredState = function readTaskPointsStoredStateWithInboxJournal(...args) {
      const state = originalReadStored(...args);
      const current = readJournal();
      if (!state || current.malformed || !current.record) return state;
      return applyPatch(state, current.record);
    };
  }

  if (originalLoadAppState) {
    core.loadAppState = function loadAppStateWithInboxJournal(...args) {
      const result = originalLoadAppState(...args);
      const current = readJournal();
      if (!result?.state || current.malformed || !current.record) return result;
      return {
        ...result,
        state: applyPatch(result.state, current.record),
        pendingInboxJournal: true
      };
    };
  }

  const pendingAtInstall = readJournal();
  if (pendingAtInstall.record && !pendingAtInstall.malformed) scheduleCompaction();

  core.getInboxMutationJournalStatus = () => {
    const current = readJournal();
    return {
      installed: true,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      journaledSavePaths: Array.from(JOURNALED_SAVE_PATHS),
      pending: Boolean(current.record),
      malformed: current.malformed,
      journalBytes: current.raw.length,
      journalSaves,
      fallbackSaves,
      compactionsStarted,
      compactionsCompleted,
      compactionDeferrals
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
'''

MODULE.write_text(module[:start] + new_block)

test = TEST.read_text()
test = test.replace("inboxProcessedEventIds: ['old-event']", "inboxProcessedEventIds: { 'old-event': true }")
test = test.replace("inboxProcessedEventIds: ['event-1', 'event-2']", "inboxProcessedEventIds: { 'event-1': true, 'event-2': true }")
test = test.replace("inboxProcessedEventIds: ['pending-event']", "inboxProcessedEventIds: { 'pending-event': true }")

append = r'''

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
  assert.deepEqual(effective.inboxProcessedEventIds, { 'old-event': true });

  h.setQuietMs(9000);
  assert.equal(h.runNextTimer(), true);
  assert.equal(h.heavySaves, 1);
  assert.equal(h.localStorage.dump(h.JOURNAL_KEY), null);
  assert.deepEqual(h.core.readTaskPointsStoredState().inboxProcessedEventIds, { 'old-event': true });
});
'''

if "notification Inbox save paths share the small journal" not in test:
    test += append
TEST.write_text(test)
