const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

test('shared scoring loader requests score alias consistency exactly once', () => {
  const appended = [];
  const storage = new Map();
  const document = {
    head: {
      appendChild(node) {
        appended.push(node);
      }
    },
    createElement() {
      return { dataset: {} };
    },
    querySelector(selector) {
      if (selector === 'script[data-taskpoints-champion-gold]') {
        return appended.find((node) => node.dataset?.taskpointsChampionGold === 'true') || null;
      }
      if (selector === 'script[data-taskpoints-score-alias-consistency]') {
        return appended.find((node) => node.dataset?.taskpointsScoreAliasConsistency === 'true') || null;
      }
      return null;
    }
  };
  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Set,
    Object,
    document,
    localStorage: {
      getItem: (key) => storage.get(String(key)) || null,
      setItem: (key, value) => storage.set(String(key), String(value)),
      removeItem: (key) => storage.delete(String(key))
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
      setPhase4StorageMode: (mode) => mode,
      getPhase4StorageMode: () => 'off'
    }
  });
  context.window = context;
  context.globalThis = context;

  vm.runInContext(source, context);
  vm.runInContext(source, context);

  const aliasScripts = appended.filter((node) => node.dataset?.taskpointsScoreAliasConsistency === 'true');
  assert.equal(aliasScripts.length, 1);
  assert.equal(aliasScripts[0].src, 'score_alias_consistency.js');
  assert.equal(aliasScripts[0].defer, true);
});
