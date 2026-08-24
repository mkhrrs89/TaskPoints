const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');

function makeHarness() {
  const loadCalls = [];
  const saveCalls = [];
  const perfMarks = [];
  const microtasks = [];
  let clock = 0;

  const core = {
    loadAppState(options = {}) {
      loadCalls.push({ ...options });
      clock += 25;
      return { state: { inboxMessages: [] } };
    },
    mergeAndSaveState(nextState, options = {}) {
      saveCalls.push({ nextState, options: { ...options } });
      clock += 10;
      return { state: nextState };
    }
  };
  const originalMergeAndSaveState = core.mergeAndSaveState;

  const context = {
    TaskPointsCore: core,
    document: null,
    performance: { now: () => clock },
    Date,
    Error,
    Promise,
    console,
    advance(ms) { clock += Number(ms) || 0; },
    queueMicrotask(fn) { microtasks.push(fn); },
    TaskPointsPerf: {
      mark(name, detail) {
        perfMarks.push({ name, detail });
      }
    }
  };
  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'task_create_fast_path.js' });

  return {
    context,
    core,
    loadCalls,
    saveCalls,
    perfMarks,
    originalMergeAndSaveState,
    flushMicrotasks() {
      while (microtasks.length) microtasks.shift()();
    }
  };
}

test('toolbar background Inbox population converts derived load into read-only load', () => {
  const h = makeHarness();

  vm.runInContext(`
    function autoPopulateTaskPointsInbox() {
      const loaded = TaskPointsCore.loadAppState({ syncDerived: true, persistSync: false, caller: 'toolbar' });
      advance(15);
      TaskPointsCore.mergeAndSaveState({ inboxMessages: [{ id: 'new' }] }, {
        savePath: 'inbox-auto-populate',
        immediateWrite: true,
        assumeNormalized: true
      });
      return loaded;
    }
    function runTaskPointsToolbarMaintenance() {
      return autoPopulateTaskPointsInbox();
    }
    runTaskPointsToolbarMaintenance();
  `, h.context);

  assert.equal(h.loadCalls.length, 1);
  assert.deepEqual(h.loadCalls[0], {
    syncDerived: false,
    persistSync: false,
    caller: 'toolbar'
  });
  assert.equal(h.saveCalls.length, 1);

  const loadMark = h.perfMarks.find((entry) => entry.name === 'inbox.populate.fastLoad');
  assert.ok(loadMark);
  assert.equal(loadMark.detail.source, 'toolbar-background');
  assert.equal(loadMark.detail.durationMs, 25);

  const saveMark = h.perfMarks.find((entry) => entry.name === 'inbox.populate.generateAndSave');
  assert.ok(saveMark);
  assert.equal(saveMark.detail.source, 'toolbar-background');
  assert.equal(saveMark.detail.generationMs, 15);
  assert.equal(saveMark.detail.saveMs, 10);

  h.flushMicrotasks();
  const totalMark = h.perfMarks.find((entry) => entry.name === 'inbox.populate.fastPath');
  assert.ok(totalMark);
  assert.equal(totalMark.detail.source, 'toolbar-background');
  assert.equal(h.core.mergeAndSaveState, h.originalMergeAndSaveState);
  assert.equal(h.core.getInboxPopulationFastPathStatus().backgroundLoads, 1);
});

test('direct Inbox population also gets the fast read even when persistSync was requested', () => {
  const h = makeHarness();

  vm.runInContext(`
    function autoPopulateTaskPointsInbox() {
      return TaskPointsCore.loadAppState({ syncDerived: true, persistSync: true, caller: 'inbox-page' });
    }
    autoPopulateTaskPointsInbox();
  `, h.context);

  assert.deepEqual(h.loadCalls[0], {
    syncDerived: false,
    persistSync: false,
    caller: 'inbox-page'
  });
  assert.equal(h.core.getInboxPopulationFastPathStatus().pageLoads, 1);
  h.flushMicrotasks();
});

test('unrelated derived state loads are unchanged', () => {
  const h = makeHarness();

  h.core.loadAppState({ syncDerived: true, persistSync: false, outsideInbox: true });
  h.core.loadAppState({ syncDerived: false, persistSync: false, readOnly: true });

  assert.deepEqual(h.loadCalls, [
    { syncDerived: true, persistSync: false, outsideInbox: true },
    { syncDerived: false, persistSync: false, readOnly: true }
  ]);
  assert.equal(h.core.getInboxPopulationFastPathStatus().fastLoads, 0);
});

test('Inbox timing wrapper delegates unrelated saves and restores after the population task', () => {
  const h = makeHarness();

  vm.runInContext(`
    function autoPopulateTaskPointsInbox() {
      TaskPointsCore.loadAppState({ syncDerived: true, persistSync: true });
      TaskPointsCore.mergeAndSaveState({ tasks: [] }, { savePath: 'some-other-save' });
    }
    autoPopulateTaskPointsInbox();
  `, h.context);

  assert.equal(h.saveCalls.length, 1);
  assert.equal(h.saveCalls[0].options.savePath, 'some-other-save');
  assert.equal(h.perfMarks.some((entry) => entry.name === 'inbox.populate.generateAndSave'), false);
  assert.notEqual(h.core.mergeAndSaveState, h.originalMergeAndSaveState);

  h.flushMicrotasks();
  assert.equal(h.core.mergeAndSaveState, h.originalMergeAndSaveState);
});
