const test = require('node:test');
const assert = require('node:assert/strict');

test('an absent authoritative key never falls back to a stale captured save', async () => {
  const rows = new Map();
  const parsedInputs = [];
  global.window = global;
  global.Storage = undefined;
  global.indexedDB = null;
  global.localStorage = {
    getItem: (key) => rows.has(String(key)) ? rows.get(String(key)) : null,
    setItem: (key, value) => { rows.set(String(key), String(value)); },
    removeItem: (key) => { rows.delete(String(key)); }
  };
  global.TaskPointsCore = {
    STORAGE_KEY: 'taskpoints_v1',
    SHADOW_MIGRATION_DB_NAME: 'taskpoints_shadow_state_v1',
    SHADOW_MIGRATION_DB_VERSION: 1,
    SHADOW_MIGRATION_SCHEMA_VERSION: 1,
    parseTaskPointsStorageJson: (raw) => {
      parsedInputs.push(raw);
      return JSON.parse(raw);
    }
  };
  delete global.__taskPointsPhase2StorageHookInstalled;
  delete require.cache[require.resolve('../phase2_dual_write.js')];
  require('../phase2_dual_write.js');

  // setItem queues the captured payload, but the authoritative key is removed
  // synchronously before that queued operation begins.
  localStorage.setItem('taskpoints_v1', '{"stale":true}');
  localStorage.removeItem('taskpoints_v1');
  await TaskPointsCore.flushShadowDualWrites();

  assert.equal(localStorage.getItem('taskpoints_v1'), null);
  assert.deepEqual(parsedInputs, []);
});
