'use strict';
// M01 real-V1 Flex journal witness: no live V2 admission and no cutover rights.
// Exercises unmodified Flex code against disposable fake browser storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');
const MAIN = 'taskpoints_v1';
const COMPLETIONS = 'taskpoints_pending_flex_completions_v1';
const ORDER = 'taskpoints_pending_flex_order_v1';
const completion = {
  id: 'flex-completion-1', flexId: 'a', taskId: null, source: 'flex',
  title: '[Flex] Walk', completedAtISO: '2026-11-10T12:00:00.000Z', points: 3
};
const initial = () => ({
  tasks: [{ id: 'keep-task', status: 'active' }],
  completions: [{ id: 'keep-completion', source: 'task', points: 2 }],
  flexActions: [{ id: 'a', name: 'Walk', order: 1 }, { id: 'b', name: 'Study', order: 2 }]
});
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function boot({ initialKeys = {}, rejectMain = false, rejectOrder = false,
  failSave = false, skipped = false, recoveryHold = false } = {}) {
  const map = new Map([[MAIN, JSON.stringify(initial())], ...Object.entries(initialKeys)]);
  const seen = { writes: [], removes: [], saves: 0, reads: [] };
  const flags = { rejectMain, rejectOrder, failSave, skipped };
  const storage = {
    getItem(key) { seen.reads.push(String(key)); return map.get(String(key)) ?? null; },
    setItem(key, value) {
      if (flags.rejectOrder && key === ORDER) throw Error('order quota full');
      if (flags.rejectMain && key === MAIN) throw Error('V1 snapshot quota full');
      seen.writes.push(String(key));
      map.set(String(key), String(value));
    },
    removeItem(key) {
      seen.removes.push(String(key));
      map.delete(String(key));
    }
  };
  const core = {
    STORAGE_KEY: MAIN,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    loadAppState() { return { state: JSON.parse(storage.getItem(MAIN)) }; },
    saveStateSnapshot(state, options = {}) {
      seen.saves += 1;
      if (flags.failSave) throw Error('V1 save failure');
      if (flags.skipped) return { state: clone(state), skipped: true };
      storage.setItem(MAIN, JSON.stringify(state));
      return { state: clone(state), options };
    }
  };
  const ctx = {
    TaskPointsCore: core, localStorage: storage, document: null,
    addEventListener() {}, console: { warn() {}, error() {}, log() {} },
    setTimeout() { return 1; }, clearTimeout() {}, structuredClone,
    Date, JSON, Map, Set, Number, String, Boolean, Object, Array, Promise
  };
  if (recoveryHold) ctx.TaskPointsRecoveryJournalWriteLockGuard = {
    readLock() { return { active: true }; }, pageMayWrite() { return false; }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'flex_action_fast_path.js' });
  const api = ctx.TaskPointsFlexActionFastPath;
  assert.ok(api && core.PENDING_FLEX_COMPLETIONS_KEY === COMPLETIONS);
  assert.equal(core.PENDING_FLEX_ORDER_KEY, ORDER);
  return { ctx, core, api, storage, flags, seen, map,
    raw(key) { return storage.getItem(key); },
    saved() { return JSON.parse(storage.getItem(MAIN)); } };
}

test('real Flex order journal immediately overlays reads without rewriting V1 snapshot', () => {
  const h = boot();
  const record = h.api.writeOrderJournal(['b', 'a', 'b']);
  assert.deepEqual(Array.from(record.orderedIds), ['b', 'a']);
  assert.deepEqual(Array.from(h.api.readOrderJournal().orderedIds), ['b', 'a']);
  assert.equal(h.seen.saves, 0);
  assert.deepEqual(h.saved().flexActions.map(x => x.order), [1, 2]);
  const effective = h.core.loadAppState().state.flexActions;
  assert.deepEqual(Array.from(effective, x => x.order), [2, 1]);
  assert.equal(h.raw(ORDER) !== null, true);
  assert.equal(h.raw(COMPLETIONS), null);
});

test('real Flex completion and order journals overlay together and clear only after a verified V1 save', () => {
  const h = boot({ initialKeys: { [COMPLETIONS]: JSON.stringify([completion]) } });
  h.api.writeOrderJournal(['b', 'a']);
  const loaded = h.core.loadAppState();
  assert.equal(loaded.pendingFlexCompletions, 1);
  assert.equal(loaded.pendingFlexOrder, true);
  assert.equal(loaded.state.completions[0].id, completion.id);
  assert.deepEqual(Array.from(loaded.state.flexActions, x => x.order), [2, 1]);
  const result = h.core.saveStateSnapshot(initial(), { savePath: 'manual-full-snapshot' });
  assert.equal(result.skipped, undefined);
  assert.equal(h.seen.saves, 1);
  assert.equal(h.raw(COMPLETIONS), null);
  assert.equal(h.raw(ORDER), null);
  assert.equal(h.saved().completions.find(x => x.id === completion.id).flexId, 'a');
  assert.deepEqual(h.saved().flexActions.map(x => x.order), [2, 1]);
  assert.equal(h.saved().tasks[0].id, 'keep-task');
});

test('skipped canonical save leaves both Flex journals and the old snapshot untouched', () => {
  const h = boot({ skipped: true, initialKeys: {
    [COMPLETIONS]: JSON.stringify([completion])
  } });
  h.api.writeOrderJournal(['b', 'a']);
  const pendingOrder = h.raw(ORDER), pendingCompletion = h.raw(COMPLETIONS);
  const before = h.raw(MAIN);
  const result = h.core.saveStateSnapshot(initial(), { savePath: 'manual-full-snapshot' });
  assert.equal(result.skipped, true);
  assert.equal(h.raw(MAIN), before);
  assert.equal(h.raw(ORDER), pendingOrder);
  assert.equal(h.raw(COMPLETIONS), pendingCompletion);
  assert.equal(h.seen.removes.includes(ORDER), false);
  assert.equal(h.seen.removes.includes(COMPLETIONS), false);
});

test('quota failure retains both Flex journals; later retry saves exactly once', () => {
  const h = boot({ rejectMain: true, initialKeys: {
    [COMPLETIONS]: JSON.stringify([completion])
  } });
  h.api.writeOrderJournal(['b', 'a']);
  const main = h.raw(MAIN), order = h.raw(ORDER), completions = h.raw(COMPLETIONS);
  assert.throws(() => h.core.saveStateSnapshot(initial()), /snapshot quota full/);
  assert.equal(h.raw(MAIN), main);
  assert.equal(h.raw(ORDER), order);
  assert.equal(h.raw(COMPLETIONS), completions);
  h.flags.rejectMain = false;
  h.core.saveStateSnapshot(initial());
  assert.equal(h.raw(ORDER), null);
  assert.equal(h.raw(COMPLETIONS), null);
  assert.deepEqual(h.saved().flexActions.map(x => x.order), [2, 1]);
  assert.ok(h.saved().completions.some(x => x.id === completion.id));
});

test('malformed Flex order journal is preserved and does not pretend to be drained', () => {
  const bad = '{broken-order';
  const h = boot({ initialKeys: { [ORDER]: bad } });
  assert.equal(h.api.readOrderJournalRecord().malformed, true);
  assert.throws(() => h.api.writeOrderJournal(['a', 'b']), /malformed/);
  assert.equal(h.raw(ORDER), bad);
  assert.equal(h.api.readOrderJournal(), null);
});

test('locked recovery denies new reorder and preserves existing journal evidence', () => {
  const prior = JSON.stringify({ version: 1, orderedIds: ['b', 'a'] });
  const h = boot({ recoveryHold: true, initialKeys: { [ORDER]: prior } });
  assert.throws(() => h.api.writeOrderJournal(['a', 'b']), /recovery protection/);
  assert.equal(h.raw(ORDER), prior);
  assert.equal(h.seen.saves, 0);
});

test('failed reorder journal write cannot erase an older durable order', () => {
  const prior = JSON.stringify({ version: 1, orderedIds: ['b', 'a'] });
  const h = boot({ rejectOrder: true, initialKeys: { [ORDER]: prior } });
  assert.throws(() => h.api.writeOrderJournal(['a', 'b']), /quota/);
  assert.equal(h.raw(ORDER), prior);
  assert.equal(h.seen.removes.includes(ORDER), false);
});

test('drained delayed Flex fast save must never resurrect stale in-memory state', () => {
  const h = boot();
  const newer = initial();
  newer.tasks[0].status = 'completed';
  h.storage.setItem(MAIN, JSON.stringify(newer));
  const stale = initial();
  const res = h.core.saveStateSnapshot(stale, { savePath: 'flex-completion-fast-path' });
  assert.equal(res.skipped, true);
  assert.equal(res.skipReason, 'pending_flex_journal_already_drained');
  assert.equal(h.seen.saves, 0);
  assert.equal(res.state.tasks[0].status, 'completed');
  assert.equal(h.saved().tasks[0].status, 'completed');
  assert.equal(h.raw(COMPLETIONS), null);
  assert.equal(h.raw(ORDER), null);
});

test('M01 Flex witnesses remain V1 behavior only, with no production handoff', () => {
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..',
    'docs/state-runtime-v2-storage-source-inventory.json'), 'utf8'));
  const rows = inv.writerBehaviorWitnesses.filter(row => row.path === 'flex_action_fast_path.js');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.testPath, 'tests/state_runtime_v2_m01_flex_journal_behavior_contract.test.js');
    assert.ok(row.observedBehaviors.length >= 4);
    assert.ok(inv.writerPathEvidence.some(writer =>
      writer.path === row.path && writer.anchor === row.anchor));
    assert.equal(row.productionOwnerVerified, false);
    assert.equal(row.productionFenceVerified, false);
    assert.equal(row.cutoverPermission, false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,34);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments, 0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced, false);
  assert.equal(inv.writerOwnershipAudit.flexReadOnlyCutoverGate.allowsCutover, false);
});
