const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scwm_interaction_fast_path.js'), 'utf8');

function createHarness() {
  const calls = { saves: 0, fullRenders: 0, workRenders: 0, liveRefreshes: 0 };
  const listeners = new Map();
  let timerId = 0;
  const timers = new Map();
  const document = {
    readyState: 'complete',
    hidden: false,
    addEventListener(name, callback) { listeners.set(name, callback); }
  };
  const context = {
    console,
    Date,
    Promise,
    Array,
    Object,
    Set,
    Map,
    Number,
    String,
    Math,
    performance: { now: () => 100 },
    document,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { callback(); return 1; },
    requestIdleCallback(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancelIdleCallback(id) { timers.delete(id); },
    addEventListener(name, callback) { listeners.set(name, callback); },
    TaskPointsHomeTargetedRenderControl: {
      refreshLiveScorePanels() { calls.liveRefreshes += 1; return true; },
      scheduleCanonicalStatsRefresh() {}
    },
    save() { calls.saves += 1; return { ok: true }; },
    scheduleRender(callback) { callback(); },
    renderAll() { calls.fullRenders += 1; },
    renderStats() {},
    renderWorkHistory() { calls.workRenders += 1; }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext('saveWorkScore = function(){ save(); scheduleRender(renderAll); };', context);
  vm.runInContext(source, context, { filename: 'scwm_interaction_fast_path.js' });

  const installEntry = [...timers.entries()][0];
  assert.ok(installEntry, 'module should schedule installation after page setup');
  timers.delete(installEntry[0]);
  installEntry[1]();
  return { context, calls, listeners };
}

test('SCWM saves yield before persistence and use a targeted card refresh', () => {
  const { context, calls } = createHarness();
  context.saveWorkScore();
  assert.equal(calls.saves, 0, 'persistence should wait until after the interaction paint');
  assert.equal(calls.fullRenders, 0, 'the full Home renderer should not run');
  assert.equal(calls.workRenders, 1, 'the edited Work card should update immediately');
  assert.equal(calls.liveRefreshes, 1, 'live score panels should update immediately');
  assert.equal(context.TaskPointsScwmInteractionFastPath.getStatus().pendingSave, true);

  context.TaskPointsScwmInteractionFastPath.flush();
  assert.equal(calls.saves, 1, 'the deferred state write must still be persisted');
});

test('ordinary non-SCWM saves and renders retain their existing behavior', () => {
  const { context, calls } = createHarness();
  context.save();
  context.scheduleRender(context.renderAll);
  assert.equal(calls.saves, 1);
  assert.equal(calls.fullRenders, 1);
});

test('pagehide flushes a pending SCWM write so navigation cannot lose an edit', () => {
  const { context, calls, listeners } = createHarness();
  context.saveWorkScore();
  assert.equal(calls.saves, 0);
  listeners.get('pagehide')?.();
  assert.equal(calls.saves, 1);
});
