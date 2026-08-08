const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(index) { return Array.from(values.keys())[index] || null; },
    get length() { return values.size; }
  };
}

function installHarness() {
  const modulePath = path.resolve(__dirname, '../state_hot_cache.js');
  delete require.cache[modulePath];

  const storage = makeStorage({
    taskpoints_v1: JSON.stringify({ players: [{ id: 'p1', name: 'Alpha' }], completions: [{ id: 'c1', points: 1 }] }),
    taskpoints_state_revision_v1: 'rev-1',
    other_state: JSON.stringify({ value: 1 })
  });
  let readCalls = 0;
  const readsByKey = new Map();

  global.window = global;
  global.localStorage = storage;
  global.addEventListener = () => {};
  global.TaskPointsCore = {
    STORAGE_KEY: 'taskpoints_v1',
    PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
    readTaskPointsStoredState(storageKey = 'taskpoints_v1', fallback = {}) {
      readCalls += 1;
      readsByKey.set(storageKey, (readsByKey.get(storageKey) || 0) + 1);
      const raw = storage.getItem(storageKey);
      if (!raw) return fallback;
      try { return JSON.parse(raw); }
      catch (_) { return fallback; }
    },
    loadAppState(options = {}) {
      return {
        state: this.readTaskPointsStoredState('taskpoints_v1', {}),
        options: { ...options }
      };
    }
  };

  require(modulePath);
  return {
    core: global.TaskPointsCore,
    storage,
    get readCalls() { return readCalls; },
    readsFor(key) { return readsByKey.get(key) || 0; }
  };
}

test('repeated authoritative reads reuse one parse but return independent objects', () => {
  const harness = installHarness();
  const first = harness.core.readTaskPointsStoredState('taskpoints_v1', {});
  first.players[0].name = 'Mutated by caller';
  first.completions.push({ id: 'caller-only' });

  const second = harness.core.readTaskPointsStoredState('taskpoints_v1', {});
  assert.equal(harness.readsFor('taskpoints_v1'), 1);
  assert.equal(second.players[0].name, 'Alpha');
  assert.equal(second.completions.length, 1);
  assert.notEqual(second, first);
  assert.equal(harness.core.getStateHotCacheStatus().storedStateHits, 1);
  assert.equal(harness.core.getStateHotCacheStatus().storedStateMisses, 1);
});

test('authoritative writes and removes invalidate the cached state immediately', () => {
  const harness = installHarness();
  assert.equal(harness.core.readTaskPointsStoredState('taskpoints_v1', {}).players[0].name, 'Alpha');
  harness.storage.setItem('taskpoints_v1', JSON.stringify({ players: [{ id: 'p1', name: 'Beta' }] }));
  assert.equal(harness.core.readTaskPointsStoredState('taskpoints_v1', {}).players[0].name, 'Beta');
  assert.equal(harness.readsFor('taskpoints_v1'), 2);

  harness.storage.removeItem('taskpoints_v1');
  const firstFallback = { players: [{ id: 'fallback-a' }] };
  const secondFallback = { players: [{ id: 'fallback-b' }] };
  assert.deepEqual(harness.core.readTaskPointsStoredState('taskpoints_v1', firstFallback), firstFallback);
  assert.deepEqual(harness.core.readTaskPointsStoredState('taskpoints_v1', secondFallback), secondFallback);
  assert.equal(harness.readsFor('taskpoints_v1'), 4);
});

test('revision-token changes force a fresh authoritative read even without a tracked-key write', () => {
  const harness = installHarness();
  harness.core.readTaskPointsStoredState('taskpoints_v1', {});
  harness.storage.setItem('taskpoints_state_revision_v1', 'rev-2');
  harness.core.readTaskPointsStoredState('taskpoints_v1', {});
  assert.equal(harness.readsFor('taskpoints_v1'), 2);
});

test('non-authoritative storage keys always bypass the hot cache', () => {
  const harness = installHarness();
  assert.deepEqual(harness.core.readTaskPointsStoredState('other_state', {}), { value: 1 });
  assert.deepEqual(harness.core.readTaskPointsStoredState('other_state', {}), { value: 1 });
  assert.equal(harness.readsFor('other_state'), 2);
});

test('existing read-only loadAppState cache remains isolated from caller mutation', () => {
  const harness = installHarness();
  const first = harness.core.loadAppState({ syncDerived: false, persistSync: false });
  first.state.players[0].name = 'Changed';
  const second = harness.core.loadAppState({ syncDerived: false, persistSync: false });
  assert.equal(second.state.players[0].name, 'Alpha');
  assert.equal(harness.core.getStateHotCacheStatus().readOnlyHits, 1);
});
