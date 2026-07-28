const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_readonly_guard.js'), 'utf8');

class FakeButton {
  constructor() { this.listeners = []; }
  addEventListener(type, listener) { this.listeners.push({ type, listener }); }
  click() {
    const entry = this.listeners.find((item) => item.type === 'click');
    return entry?.listener?.call(this, { type: 'click' });
  }
}

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
}

function installModeHarness() {
  const localStorage = new FakeStorage({
    taskpoints_phase4_storage_mode_v1: 'verify_primary_writes',
    taskpoints_indexeddb_requalification_v1: JSON.stringify({ status: 'ready_for_fast_mode' })
  });
  const core = {
    PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
    getPhase4StorageMode() { return localStorage.getItem(this.PHASE4_STORAGE_MODE_KEY) || 'off'; },
    setPhase4StorageMode(mode) {
      localStorage.setItem(this.PHASE4_STORAGE_MODE_KEY, String(mode || 'off'));
      return String(mode || 'off');
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    document: { getElementById: () => null },
    Promise,
    JSON,
    Date,
    Math,
    String,
    Boolean,
    setTimeout,
    clearTimeout
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guard, context, { filename: 'indexeddb_requalification_readonly_guard.js' });
  return { core, localStorage };
}

test('initial checklist load cannot initialize any full storage module', () => {
  assert.doesNotMatch(page, /<script src="scoring_core\.js"/);
  assert.doesNotMatch(page, /<script src="phase4_cache_guard\.js"/);
  assert.doesNotMatch(page, /<script src="indexeddb_requalification_readonly_guard\.js"/);
  assert.doesNotMatch(page, /<script src="indexeddb_requalification\.js"/);
  assert.match(page, /indexeddb_requalification_loader\.js/);
  assert.match(loader, /async function runExplicitAction\(buttonId\)/);
  assert.match(loader, /await loadRuntime\(\)/);
});

test('the runtime keeps ordinary refreshes read-only after an explicit action loads it', () => {
  assert.doesNotThrow(() => new vm.Script(guard));
  assert.match(loader, /'indexeddb_requalification_readonly_guard\.js'/);
  assert.ok(loader.indexOf("'indexeddb_requalification_readonly_guard.js'") < loader.indexOf("'indexeddb_requalification.js'"));
  assert.match(guard, /flushPhase5CVerifiedSecondaryWrites/);
  assert.match(guard, /flushPhase4PrimaryWrites/);
  assert.match(guard, /flushPhase5ANativeSnapshotWrites/);
  assert.match(guard, /if \(!activeActionToken \|\| permittedCalls <= 0\) return Promise\.resolve\(false\)/);
  assert.match(guard, /scopeNextRuntimeClickListener/);
  assert.match(guard, /Promise\.resolve\(result\)\.finally\(\(\) => revokeExplicitAction\(token\)\)/);
  assert.doesNotMatch(guard, /refreshBtn/);
});

test('an aborted Start or Finish handler immediately revokes every unused flush permission', async () => {
  const startButton = new FakeButton();
  const finishButton = new FakeButton();
  let flushes = 0;
  const core = {
    flushPhase5CVerifiedSecondaryWrites: async () => { flushes += 1; return true; },
    flushPhase4PrimaryWrites: async () => { flushes += 1; return true; },
    flushPhase5ANativeSnapshotWrites: async () => { flushes += 1; return true; }
  };
  const context = {
    TaskPointsCore: core,
    document: { getElementById: (id) => id === 'startTestBtn' ? startButton : finishButton },
    Promise,
    JSON,
    Date,
    Math,
    String,
    Boolean,
    setTimeout,
    clearTimeout
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guard, context, { filename: 'indexeddb_requalification_readonly_guard.js' });

  startButton.addEventListener('click', async () => {
    await core.flushPhase4PrimaryWrites();
    throw new Error('simulated safety abort');
  });

  await assert.rejects(Promise.resolve(startButton.click()), /simulated safety abort/);
  assert.equal(flushes, 1);
  assert.equal(core.getIndexedDbRequalificationReadOnlyStatus().actionActive, false);
  assert.equal(core.getIndexedDbRequalificationReadOnlyStatus().explicitCallsRemaining, 0);
  assert.equal(await core.flushPhase5CVerifiedSecondaryWrites(), false);
  assert.equal(flushes, 1);
});

test('rollback preserves an explicit Off selected after activation succeeded', () => {
  const harness = installModeHarness();
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
  harness.localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off');
  assert.equal(harness.core.setPhase4StorageMode('verify_primary_writes'), 'off');
  assert.equal(harness.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'off');
});

test('rollback still returns to test mode after an ordinary activation failure', () => {
  const harness = installModeHarness();
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
  assert.equal(harness.core.setPhase4StorageMode('verify_primary_writes'), 'verify_primary_writes');
  assert.equal(harness.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'verify_primary_writes');
});
