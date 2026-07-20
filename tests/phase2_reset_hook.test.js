const test = require('node:test');
const assert = require('node:assert/strict');

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
  await Promise.resolve();
  assert.deepEqual(queued, [{ state: {}, options: { reset: true } }]);

  queued.length = 0;
  localStorage.setItem('taskpoints_v1', '{"old":true}');
  localStorage.removeItem('taskpoints_v1');
  localStorage.setItem('taskpoints_v1', '{"new":true}');
  await Promise.resolve();
  assert.deepEqual(queued, []);
  assert.equal(localStorage.getItem('taskpoints_v1'), '{"new":true}');
});
