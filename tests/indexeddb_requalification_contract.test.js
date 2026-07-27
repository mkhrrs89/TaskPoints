const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const guardSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_guard.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const statusPage = fs.readFileSync(path.join(ROOT, 'phase4_storage_status.html'), 'utf8');
const alwaysLoadedGuard = fs.readFileSync(path.join(ROOT, 'phase4_cache_guard.js'), 'utf8');

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows).map(([key, value]) => [key, String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function hash(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function install(rows = {}) {
  const localStorage = new FakeStorage(rows);
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
    PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
    getPhase4StorageMode() { return localStorage.getItem('taskpoints_phase4_storage_mode_v1') || 'off'; },
    setPhase4StorageMode(mode) { localStorage.setItem('taskpoints_phase4_storage_mode_v1', mode); return mode; }
  };
  const context = { TaskPointsCore: core, localStorage, JSON, String, Number, Boolean, Object, Array, Set, Date, Math, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guardSource, context, { filename: 'indexeddb_requalification_guard.js' });
  return { core, localStorage };
}

test('guard blocks faster modes until the safety-check record allows them', () => {
  const raw = '{"tasks":[1]}';
  const harness = install({
    taskpoints_v1: raw,
    taskpoints_phase4_storage_mode_v1: 'indexeddb_primary',
    taskpoints_emergency_recovery_hold_v1: '{}'
  });
  assert.equal(harness.core.getPhase4StorageMode(), 'off');
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'off');

  harness.localStorage.removeItem('taskpoints_emergency_recovery_hold_v1');
  harness.localStorage.setItem('taskpoints_indexeddb_requalification_v1', JSON.stringify({
    status: 'authorizing_test_mode', authorizedRawHash: hash(raw)
  }));
  assert.equal(harness.core.setPhase4StorageMode('verify_primary_writes'), 'verify_primary_writes');
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'off');

  harness.localStorage.setItem('taskpoints_indexeddb_requalification_v1', JSON.stringify({
    status: 'ready_for_fast_mode', lastVerifiedRawHash: hash(raw)
  }));
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
});

test('short test may survive an expected edit and enabled fast mode may survive later saves', () => {
  const firstRaw = '{"tasks":[1]}';
  const secondRaw = '{"tasks":[1,2]}';
  const harness = install({
    taskpoints_v1: firstRaw,
    taskpoints_phase4_storage_mode_v1: 'verify_primary_writes',
    taskpoints_indexeddb_requalification_v1: JSON.stringify({ status: 'awaiting_smoke_test', baselineRawHash: hash(firstRaw) })
  });
  harness.localStorage.setItem('taskpoints_v1', secondRaw);
  assert.equal(harness.core.setPhase4StorageMode('verify_primary_writes'), 'verify_primary_writes');

  harness.localStorage.setItem('taskpoints_indexeddb_requalification_v1', JSON.stringify({ status: 'fast_mode_enabled' }));
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
});

test('setup page uses the two-step plain-language flow and restores the safety hold after a failed start', () => {
  assert.doesNotThrow(() => new vm.Script(guardSource));
  assert.doesNotThrow(() => new vm.Script(runtimeSource));
  assert.match(page, /Faster Storage Setup/);
  assert.match(page, /Start short test/);
  assert.match(page, /Finish test and turn on faster mode/);
  assert.match(page, /current working copy/);
  assert.match(page, /player photos/);
  assert.match(page, /indexeddb_requalification_guard\.js/);
  assert.ok(page.indexOf('phase4_cache_guard.js') < page.indexOf('indexeddb_requalification.js'));
  assert.match(runtimeSource, /status: 'authorizing_test_mode'/);
  assert.match(runtimeSource, /remove\(HOLD_KEY\)/);
  assert.match(runtimeSource, /setPhase4StorageMode\?\.\('verify_primary_writes'\)/);
  assert.match(runtimeSource, /if \(hadRecoveryHold && previousHoldRaw != null\) set\(HOLD_KEY, previousHoldRaw\)/);
  assert.match(runtimeSource, /const resuming = before\.gate\.status === 'authorizing_test_mode'/);
  assert.match(runtimeSource, /previousRecoveryHoldRaw: previousHoldRaw/);
  assert.match(runtimeSource, /status: 'ready_for_fast_mode'/);
  assert.match(runtimeSource, /setPhase4StorageMode\?\.\('indexeddb_primary'\)/);
  assert.match(runtimeSource, /status: 'fast_mode_enabled'/);
});

test('the faster-mode guard is included in the always-loaded Phase 4 bundle', () => {
  assert.match(alwaysLoadedGuard, /installTaskPointsIndexedDbRequalificationGuard/);
  assert.match(alwaysLoadedGuard, /core\.__indexedDbRequalificationGuardInstalled = true/);
  assert.match(alwaysLoadedGuard, /core\.__indexedDbRestartWitnessInstalled = true/);
});


test('selecting Off during the short test leaves a visible restart path', () => {
  assert.match(runtimeSource, /'awaiting_smoke_test', 'ready_for_fast_mode'/);
  assert.match(runtimeSource, /const freshStart = report\.mode === 'off'/);
});

test('reopen proof comes from a new normal app session rather than the checklist page', () => {
  assert.match(alwaysLoadedGuard, /const SESSION_KEY = 'taskpoints_indexeddb_browser_session_v1'/);
  assert.match(alwaysLoadedGuard, /EXCLUDED_PAGES\.has\(pageName\)/);
  assert.match(alwaysLoadedGuard, /!sessionStorageAvailable \|\| !broadcastSupported \|\| !sessionWasNew/);
  assert.match(alwaysLoadedGuard, /navigationType === 'reload'/);
  assert.match(alwaysLoadedGuard, /freshAppSessionId: sessionId/);
  assert.match(alwaysLoadedGuard, /journalCount\(HABIT_JOURNAL_KEY\) > 0/);
  assert.match(alwaysLoadedGuard, /new global\.BroadcastChannel\(CHANNEL_NAME\)/);
  assert.match(alwaysLoadedGuard, /findOtherOpenSessions/);
  assert.match(alwaysLoadedGuard, /otherSessions\.size > 0/);
  assert.match(alwaysLoadedGuard, /attempt < 11/);
  assert.doesNotMatch(runtimeSource, /restorePhase4CommittedPrimary\?\.\(\)/);
  assert.match(runtimeSource, /restartCheckerReady/);
});

test('resuming preparation preserves the original safety baselines', () => {
  assert.match(runtimeSource, /resuming \? before\.gate\.baselineVerificationFailures/);
  assert.match(runtimeSource, /resuming \? before\.gate\.baselineBlockedWrites/);
  assert.match(runtimeSource, /resuming \? before\.gate\.baselineRawHash/);
  assert.match(runtimeSource, /resuming \? before\.gate\.preparedBrowserSessionId/);
});

test('historical blocked writes are displayed but do not permanently block the checklist', () => {
  assert.doesNotMatch(runtimeSource, /blockedWrites === 0/);
  assert.match(runtimeSource, /baselineBlockedWrites/);
  assert.match(runtimeSource, /noNewBlockedWrites/);
});

test('old storage buttons cannot skip the safety checklist', () => {
  assert.match(statusPage, /href="indexeddb_requalification\.html"/);
  assert.match(statusPage, /if \(button\.dataset\.mode !== 'off'\)/);
  assert.match(statusPage, /window\.location\.href = 'indexeddb_requalification\.html'/);
  assert.doesNotMatch(statusPage, /setPhase4StorageMode\?\.\(button\.dataset\.mode\)/);
});
