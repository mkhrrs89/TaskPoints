'use strict';
// M01: existing Inbox journal writer/compactor behavior evidence only.
// These tests run production source in disposable memory. They do NOT prove
// production writer ownership, multi-tab fencing, or V2 authority.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');
const KEY = 'taskpoints_pending_inbox_state_v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function scenario(initialJournal = null) {
  const rows = new Map();
  if (initialJournal !== null) rows.set(KEY,
    typeof initialJournal === 'string' ? initialJournal : JSON.stringify(initialJournal));
  let canonical = {
    inboxMessages: [{ id: 'old' }],
    inboxProcessedEventIds: { oldEvent: true },
    inboxStartedDateKey: '2026-08-20',
    tasks: [{ id: 'task-keep', status: 'active' }]
  };
  const flags = { rejectJournal: false, rejectSnapshot: false, skippedSnapshot: false,
    fakeSnapshot: false, beforeSave: null, quietMs: 9000, activeEditor: false, leaving: false };
  const scheduled = [], history = [], marks = [];
  let fullSaves = 0, journalWrites = 0, journalRemoves = 0;
  const storage = {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) {
      if (key === KEY) {
        if (flags.rejectJournal) throw new Error('QuotaExceededError');
        journalWrites += 1;
      }
      rows.set(String(key), String(value));
    },
    removeItem(key) {
      if (key === KEY) journalRemoves += 1;
      rows.delete(String(key));
    }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    loadAppState() { return { state: clone(canonical) }; },
    readTaskPointsStoredState() { return clone(canonical); },
    mergeAndSaveState(next, options = {}) {
      fullSaves += 1;
      history.push({ patch: clone(next), options: clone(options) });
      if (typeof flags.beforeSave === 'function') flags.beforeSave();
      if (flags.rejectSnapshot) throw new Error('snapshot write rejected');
      if (flags.skippedSnapshot) return { state: clone(canonical), skipped: true };
      if (!flags.fakeSnapshot) canonical = { ...canonical, ...clone(next) };
      return { state: clone(flags.fakeSnapshot ? { ...canonical, ...next } : canonical) };
    },
    getStorageMaintenanceIdleStatus() {
      return { lastInteractionAgoMs: flags.quietMs, navigationQuietForMs: 0,
        pageLeaving: flags.leaving, activeEditor: flags.activeEditor };
    },
    clearStateHotCache() {}
  };
  const ctx = {
    TaskPointsCore: core, TaskPointsPerf: { mark(name) { marks.push(name); } },
    localStorage: storage, document: null, structuredClone, Date, JSON, Promise,
    console, performance: { now: () => 0 },
    setTimeout(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout() {}, queueMicrotask() {}
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'task_create_fast_path.js' });
  return {
    core, storage, flags, history, marks,
    get canonical() { return clone(canonical); },
    get fullSaves() { return fullSaves; },
    get journalWrites() { return journalWrites; },
    get journalRemoves() { return journalRemoves; },
    get pendingTimers() { return scheduled.length; },
    readJournal() { const raw = storage.getItem(KEY); return raw && JSON.parse(raw); },
    runTimer() { const timer = scheduled.shift(); assert.ok(timer, 'expected scheduled compaction'); timer.fn(); }
  };
}

function saveInbox(h, messageId = 'next', savePath = 'inbox-auto-populate') {
  return h.core.mergeAndSaveState({
    inboxMessages: [{ id: messageId }],
    inboxProcessedEventIds: { [messageId + '-event']: true }
  }, { savePath, immediateWrite: true });
}

test('real Inbox writer is synchronous and overlays journal without touching unrelated V1 rows', () => {
  const h = scenario();
  const result = saveInbox(h, 'journaled', 'season-series-upset-inbox');
  assert.equal(result.inboxJournalFastPath, true);
  assert.equal(result.deferredFullSnapshot, true);
  assert.equal(h.fullSaves, 0);
  assert.equal(h.journalWrites, 1);
  assert.equal(h.core.readTaskPointsStoredState().inboxMessages[0].id, 'journaled');
  assert.equal(h.core.loadAppState().pendingInboxJournal, true);
  assert.equal(h.canonical.inboxMessages[0].id, 'old');
  assert.equal(h.canonical.tasks[0].id, 'task-keep');
  assert.equal(h.readJournal().schemaVersion, 2);
});

test('Inbox journal quota failure uses original full-state writer without a false durable journal ack', () => {
  const h = scenario();
  h.flags.rejectJournal = true;
  const result = saveInbox(h, 'fallback', 'gold-theft-top50-inbox');
  assert.equal(result.inboxJournalFastPath, undefined);
  assert.equal(h.fullSaves, 1);
  assert.equal(h.journalWrites, 0);
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.canonical.inboxMessages[0].id, 'fallback');
  assert.equal(h.core.getInboxMutationJournalStatus().fallbackSaves, 1);
  assert.ok(h.marks.includes('inbox.populate.journalFallback'));
});

test('malformed existing Inbox journal is preserved while old writer handles new Inbox save', () => {
  const corrupt = '{bad-json-that-must-survive';
  const h = scenario(corrupt);
  const result = saveInbox(h, 'recovery-fallback');
  assert.equal(result.inboxJournalFastPath, undefined);
  assert.equal(h.fullSaves, 1);
  assert.equal(h.storage.getItem(KEY), corrupt, 'never discard malformed recovery evidence');
  assert.equal(h.core.getInboxMutationJournalStatus().malformed, true);
  assert.equal(h.canonical.inboxMessages[0].id, 'recovery-fallback');
});

test('skipped and failed canonical compactions never clear an unverified pending Inbox journal', () => {
  const initial = { schemaVersion: 2, inboxMessages: [{ id: 'pending' }],
    inboxProcessedEventIds: { newEvent: true }, updatedAtISO: '2026-11-10T12:00:00Z' };
  for (const failedMode of ['skippedSnapshot', 'rejectSnapshot', 'fakeSnapshot']) {
    const h = scenario(initial);
    const raw = h.storage.getItem(KEY);
    h.flags[failedMode] = true;
    h.runTimer();
    assert.equal(h.storage.getItem(KEY), raw, 'failed compaction must keep exact journal bytes');
    assert.equal(h.journalRemoves, 0);
    assert.equal(h.core.getInboxMutationJournalStatus().compactionsCompleted, 0);
    assert.ok(h.marks.includes('inbox.journal.compactionFailed'));
    h.flags[failedMode] = false;
    h.runTimer();
    assert.equal(h.storage.getItem(KEY), null, 'successful verified retry clears journal');
    assert.equal(h.core.getInboxMutationJournalStatus().compactionsCompleted, 1);
    assert.equal(h.canonical.inboxMessages[0].id, 'pending');
    assert.equal(h.canonical.inboxProcessedEventIds.oldEvent, true);
    assert.equal(h.canonical.inboxProcessedEventIds.newEvent, true);
  }
});

test('a newer journal arriving inside compaction is not deleted by older compaction cleanup', () => {
  const initial = { schemaVersion: 2, inboxMessages: [{ id: 'first' }],
    inboxProcessedEventIds: { firstEvent: true }, updatedAtISO: '2026-11-10T12:00:00Z' };
  const h = scenario(initial);
  let injected = false;
  h.flags.beforeSave = () => {
    if (injected) return;
    injected = true;
    const appended = saveInbox(h, 'second');
    assert.equal(appended.inboxJournalFastPath, true);
  };
  h.runTimer();
  assert.equal(injected, true);
  assert.equal(h.canonical.inboxMessages[0].id, 'first');
  assert.equal(h.readJournal().inboxMessages[0].id, 'second',
    'the newer journal must survive an older writer cleanup');
  assert.equal(h.journalRemoves, 0);
  assert.equal(h.pendingTimers > 0, true, 'new mutation schedules another compaction');
  h.flags.beforeSave = null;
  h.runTimer();
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.canonical.inboxMessages[0].id, 'second');
  assert.equal(h.canonical.inboxProcessedEventIds.firstEvent, true);
  assert.equal(h.canonical.inboxProcessedEventIds['second-event'], true);
  assert.equal(h.canonical.tasks[0].id, 'task-keep');
});

test('compaction refuses active editing and page exit until quiet; no premature journal cleanup', () => {
  const h = scenario({ schemaVersion: 2, inboxMessages: [{ id: 'held' }],
    inboxProcessedEventIds: { held: true }, updatedAtISO: '2026-11-10T12:00:00Z' });
  h.flags.activeEditor = true;
  h.runTimer();
  assert.notEqual(h.storage.getItem(KEY), null);
  assert.equal(h.fullSaves, 0);
  h.flags.activeEditor = false;
  h.flags.leaving = true;
  h.runTimer();
  assert.equal(h.fullSaves, 0);
  h.flags.leaving = false;
  h.flags.quietMs = 100;
  h.runTimer();
  assert.equal(h.fullSaves, 0);
  h.flags.quietMs = 9000;
  h.runTimer();
  assert.equal(h.fullSaves, 1);
  assert.equal(h.storage.getItem(KEY), null);
  assert.ok(h.core.getInboxMutationJournalStatus().compactionDeferrals >= 3);
});

test('Inbox owner evidence remains provisional despite confirmed V1 behavior rehearsals', () => {
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..',
    'docs/state-runtime-v2-storage-source-inventory.json'), 'utf8'));
  const paths = inv.writerBehaviorWitnesses || [];
  const inbox = paths.filter(row => row.path === 'task_create_fast_path.js');
  assert.equal(inbox.length, 2, 'both journal append and cleanup must be behavior witnessed');
  for (const route of inbox) {
    assert.ok(inv.writerPathEvidence.some(row =>
      row.path === route.path && row.anchor === route.anchor));
    assert.equal(route.testPath, 'tests/state_runtime_v2_m01_inbox_journal_behavior_contract.test.js');
    assert.ok(route.observedBehaviors.length >= 4);
    assert.equal(route.productionOwnerVerified, false);
    assert.equal(route.productionFenceVerified, false);
    assert.equal(route.cutoverPermission, false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,28);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments, 0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced, false);
  assert.equal(inv.writerOwnershipAudit.status, 'incomplete');
  assert.equal(inv.writerOwnershipAudit.inboxReadOnlyCutoverGate.canGrantProductionAuthority, false);
  assert.equal(inv.writerOwnershipAudit.inboxReadOnlyCutoverGate.allowsCutover, false);
});
