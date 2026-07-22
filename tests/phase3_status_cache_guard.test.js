const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_status_cache_guard.js'), 'utf8');

for (const disabledMode of ['off', 'compare']) {
  test(`status observation in ${disabledMode} mode clears both cache layers before re-enable`, () => {
    let mode = 'verified_indexeddb';
    let clearCalls = 0;
    let underlyingCacheReady = true;
    let originalStatusCalls = 0;

    const core = {
      __phase3NavigationCacheInstalled: true,
      PHASE3_READ_MODE_KEY: 'taskpoints_phase3_read_mode_v1',
      getPhase3ReadMode() { return mode; },
      clearPhase3ReadCache() {
        clearCalls += 1;
        underlyingCacheReady = false;
        return true;
      },
      getPhase3ReadStatus() {
        originalStatusCalls += 1;
        return {
          configuredMode: mode,
          cacheReadyThisPage: underlyingCacheReady,
          currentRawMatchesCache: underlyingCacheReady
        };
      }
    };

    const context = { TaskPointsCore: core };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(SOURCE, context, { filename: 'phase3_status_cache_guard.js' });

    mode = disabledMode;
    const disabledStatus = core.getPhase3ReadStatus();
    assert.equal(clearCalls, 1);
    assert.equal(disabledStatus.cacheReadyThisPage, false);

    mode = 'verified_indexeddb';
    const reenabledStatus = core.getPhase3ReadStatus();
    assert.equal(reenabledStatus.cacheReadyThisPage, false);
    assert.equal(clearCalls, 1);
    assert.equal(originalStatusCalls, 2);
  });
}

for (const eventValue of ['off', 'compare', 'verified_indexeddb']) {
  test(`cross-tab mode event ${eventValue} clears both cache layers`, () => {
    let clearCalls = 0;
    const listeners = new Map();
    const localStorage = {};
    const core = {
      __phase3NavigationCacheInstalled: true,
      PHASE3_READ_MODE_KEY: 'taskpoints_phase3_read_mode_v1',
      getPhase3ReadMode: () => 'verified_indexeddb',
      getPhase3ReadStatus: () => ({ status: 'ready' }),
      clearPhase3ReadCache() { clearCalls += 1; return true; }
    };
    const context = {
      TaskPointsCore: core,
      localStorage,
      addEventListener(type, callback) {
        const rows = listeners.get(type) || [];
        rows.push(callback);
        listeners.set(type, rows);
      }
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(SOURCE, context, { filename: 'phase3_status_cache_guard.js' });

    for (const callback of listeners.get('storage') || []) {
      callback({
        key: 'taskpoints_phase3_read_mode_v1',
        newValue: eventValue,
        storageArea: localStorage
      });
    }
    assert.equal(clearCalls, 1);
  });
}

test('unrelated storage events do not clear caches', () => {
  let clearCalls = 0;
  const listeners = new Map();
  const localStorage = {};
  const core = {
    __phase3NavigationCacheInstalled: true,
    PHASE3_READ_MODE_KEY: 'taskpoints_phase3_read_mode_v1',
    getPhase3ReadMode: () => 'verified_indexeddb',
    getPhase3ReadStatus: () => ({ status: 'ready' }),
    clearPhase3ReadCache() { clearCalls += 1; return true; }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    addEventListener(type, callback) {
      const rows = listeners.get(type) || [];
      rows.push(callback);
      listeners.set(type, rows);
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase3_status_cache_guard.js' });
  for (const callback of listeners.get('storage') || []) {
    callback({ key: 'other_key', newValue: 'off', storageArea: localStorage });
  }
  assert.equal(clearCalls, 0);
});

test('guard does not install without the navigation cache layer', () => {
  const core = {
    getPhase3ReadMode: () => 'off',
    getPhase3ReadStatus: () => ({ status: 'off' }),
    clearPhase3ReadCache: () => true
  };
  const original = core.getPhase3ReadStatus;
  const context = { TaskPointsCore: core };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase3_status_cache_guard.js' });
  assert.equal(core.getPhase3ReadStatus, original);
});
