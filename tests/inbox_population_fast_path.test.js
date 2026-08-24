const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');

function makeHarness() {
  const loadCalls = [];
  const perfMarks = [];
  let clock = 0;

  const core = {
    loadAppState(options = {}) {
      loadCalls.push({ ...options });
      clock += 25;
      return { state: { inboxMessages: [] } };
    }
  };

  const context = {
    TaskPointsCore: core,
    document: null,
    performance: { now: () => clock },
    Date,
    console,
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

  return { context, core, loadCalls, perfMarks };
}

test('Inbox population converts only its derive+persist state load into a read-only load', () => {
  const h = makeHarness();
  const generate = () => 'generate';
  const revealDayKey = () => '2026-08-23';

  h.context.TaskPointsInbox = {
    populate() {
      const loaded = h.core.loadAppState({ syncDerived: true, persistSync: true, caller: 'inbox' });
      return { changed: true, state: loaded.state };
    },
    generate,
    revealDayKey
  };

  const result = h.context.TaskPointsInbox.populate();

  assert.equal(result.changed, true);
  assert.equal(h.loadCalls.length, 1);
  assert.deepEqual(h.loadCalls[0], {
    syncDerived: false,
    persistSync: false,
    caller: 'inbox'
  });
  assert.equal(h.context.TaskPointsInbox.generate, generate);
  assert.equal(h.context.TaskPointsInbox.revealDayKey, revealDayKey);
  assert.equal(h.core.getInboxPopulationFastPathStatus().fastLoads, 1);
  assert.equal(h.core.getInboxPopulationFastPathStatus().populateCalls, 1);
  assert.ok(h.perfMarks.some((entry) => entry.name === 'inbox.populate.fastLoad'));
  assert.ok(h.perfMarks.some((entry) => entry.name === 'inbox.populate.fastPath'));
});

test('the loadAppState override is one-shot and cannot leak into later app loads', () => {
  const h = makeHarness();

  h.context.TaskPointsInbox = {
    populate() {
      h.core.loadAppState({ syncDerived: true, persistSync: true });
      h.core.loadAppState({ syncDerived: true, persistSync: true, second: true });
      return { changed: false };
    }
  };

  h.context.TaskPointsInbox.populate();
  h.core.loadAppState({ syncDerived: true, persistSync: true, outsideInbox: true });

  assert.equal(h.loadCalls.length, 3);
  assert.deepEqual(h.loadCalls[0], { syncDerived: false, persistSync: false });
  assert.deepEqual(h.loadCalls[1], { syncDerived: true, persistSync: true, second: true });
  assert.deepEqual(h.loadCalls[2], { syncDerived: true, persistSync: true, outsideInbox: true });
});

test('an Inbox populate that skips before loading state leaves loadAppState untouched', () => {
  const h = makeHarness();
  const originalLoad = h.core.loadAppState;

  h.context.TaskPointsInbox = {
    populate() {
      return { changed: false, skipped: true, reason: 'unchanged-source' };
    }
  };

  const result = h.context.TaskPointsInbox.populate();

  assert.equal(result.skipped, true);
  assert.equal(h.loadCalls.length, 0);
  assert.equal(h.core.loadAppState, originalLoad);
  assert.equal(h.core.getInboxPopulationFastPathStatus().fastLoads, 0);
});
