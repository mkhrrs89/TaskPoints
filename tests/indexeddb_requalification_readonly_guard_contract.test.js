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