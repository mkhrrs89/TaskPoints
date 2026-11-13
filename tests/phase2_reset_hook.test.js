const test = require('node:test');
const assert = require('node:assert/strict');

async function flushDeferredRemovalAndResetMirror() {
  // The data-loss guard now keeps taskpoints_v1 physically present for one
  // microtask so a synchronous safe remove→set replacement can be validated
  // before the previous authoritative raw is deleted. Once a direct removal is
  // confirmed, the original Phase 2 reset hook schedules the shadow reset in a
  // following microtask.
  await Promise.resolve();
  await Promise.resolve();
}

test('confirmed removal mirrors an empty state but temporary safe-replace removal does not', async () => {
  const rows = new Map();
  const queued = [];
  global.window = global;
  global.Storage = undefined;
  global.localStorage = {
    getItem: (key) => rows.has(String(key)) ? rows.get(String(key)) : null,
    setItem: (key, value) => { rows.set(String(key), String(value)); },
    removeItem: (key) => { rows.delete(String(key)); }
  };
  global.TaskPointsCore = {
    STORAGE_KEY: 'taskpoints_v1',
    queueShadowDualWrite: (state, options) => {
      queued.push({ state, options });
      return Promise.resolve({ status: 'passed_verification' });
    }
  };
  delete global.__taskPointsPhase2ResetHookInstalled;
  delete require.cache[require.resolve('../phase2_reset_hook.js')];
  require('../phase2_reset_hook.js');

  localStorage.setItem('taskpoints_v1', '{"old":true}');
  localStorage.removeItem('taskpoints_v1');
  await flushDeferredRemovalAndResetMirror();
  assert.deepEqual(queued, [{ state: {}, options: { reset: true } }]);

  queued.length = 0;
  localStorage.setItem('taskpoints_v1', '{"old":true}');
  localStorage.removeItem('taskpoints_v1');
  localStorage.setItem('taskpoints_v1', '{"new":true}');
  await flushDeferredRemovalAndResetMirror();
  assert.deepEqual(queued, []);
  assert.equal(localStorage.getItem('taskpoints_v1'), '{"new":true}');
});


test('reset mirror retains its recovery copy when Task journal deletion throws', async () => {
  const rows = new Map();
  const mirrored = [];
  global.window = global;
  global.Storage = undefined;
  global.localStorage = {
    getItem: key => rows.has(String(key)) ? rows.get(String(key)) : null,
    setItem: (key, value) => { rows.set(String(key), String(value)); },
    removeItem: key => { rows.delete(String(key)); }
  };
  const pending = '{"schemaVersion":1,"tasks":[{"id":"t1","title":"Not yet safely cleared"}],"completionUpserts":[],"completionDeletes":[]}';
  let clearAttempts = 0;
  global.TaskPointsCore = {
    STORAGE_KEY: 'taskpoints_v1',
    clearPendingTaskMutations() {
      clearAttempts += 1;
      throw Error('simulated Task journal denied remove');
    },
    queueShadowDualWrite(state, options) {
      mirrored.push({ state, options });
      return Promise.resolve({ status: 'passed_verification' });
    }
  };
  delete global.__taskPointsPhase2ResetHookInstalled;
  delete require.cache[require.resolve('../phase2_reset_hook.js')];
  require('../phase2_reset_hook.js');
  localStorage.setItem('taskpoints_pending_task_mutations_v1', pending);
  localStorage.setItem('taskpoints_v1', '{"tasks":[],"completions":[]}');
  localStorage.removeItem('taskpoints_v1');
  await flushDeferredRemovalAndResetMirror();
  assert.equal(clearAttempts, 1);
  assert.deepEqual(mirrored, [], 'failed cleanup must not destroy the shadow recovery copy');
  assert.equal(localStorage.getItem('taskpoints_pending_task_mutations_v1'), pending,
    'the original pending Task bytes must remain available');
});

test('reset mirror requires positive Task cleanup verification and can resume on a later valid reset', async () => {
  const rows = new Map();
  const mirrored = [];
  global.window = global;
  global.Storage = undefined;
  global.localStorage = {
    getItem: key => rows.has(String(key)) ? rows.get(String(key)) : null,
    setItem: (key, value) => { rows.set(String(key), String(value)); },
    removeItem: key => { rows.delete(String(key)); }
  };
  let cleanupVerified = false;
  let attempts = 0;
  global.TaskPointsCore = {
    STORAGE_KEY: 'taskpoints_v1',
    clearPendingTaskMutations() {
      attempts += 1;
      if (!cleanupVerified) return false;
      localStorage.removeItem('taskpoints_pending_task_mutations_v1');
      return localStorage.getItem('taskpoints_pending_task_mutations_v1') === null;
    },
    queueShadowDualWrite(state, options) {
      mirrored.push({ state, options });
      return Promise.resolve({ status: 'passed_verification' });
    }
  };
  delete global.__taskPointsPhase2ResetHookInstalled;
  delete require.cache[require.resolve('../phase2_reset_hook.js')];
  require('../phase2_reset_hook.js');
  const pending = '{"schemaVersion":1,"tasks":[{"id":"t1"}],"completionUpserts":[],"completionDeletes":[]}';
  localStorage.setItem('taskpoints_pending_task_mutations_v1', pending);
  localStorage.setItem('taskpoints_v1', '{"tasks":[],"completions":[]}');
  localStorage.removeItem('taskpoints_v1');
  await flushDeferredRemovalAndResetMirror();
  assert.equal(attempts, 1);
  assert.deepEqual(mirrored, []);
  assert.equal(localStorage.getItem('taskpoints_pending_task_mutations_v1'), pending);
  cleanupVerified = true;
  localStorage.setItem('taskpoints_v1', '{"tasks":[],"completions":[]}');
  localStorage.removeItem('taskpoints_v1');
  await flushDeferredRemovalAndResetMirror();
  assert.equal(attempts, 2);
  assert.deepEqual(mirrored, [{ state: {}, options: { reset: true } }],
    'verified reset continues to mirror exactly as before');
  assert.equal(localStorage.getItem('taskpoints_pending_task_mutations_v1'), null);
});
