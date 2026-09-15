const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PHASE2_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase2_reset_hook.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const INCIDENT_KEY = 'taskpoints_storage_guard_incident_v1';

class FakeStorage {
  constructor(initial = {}, options = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
    this.options = options;
    this.physicalRemovals = 0;
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    if (normalizedKey === STORAGE_KEY
      && this.options.failRestoreWhenMissing === normalizedValue
      && !this.rows.has(STORAGE_KEY)) {
      const error = new Error('simulated iOS restore failure');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.rows.set(normalizedKey, normalizedValue);
  }
  removeItem(key) {
    const normalizedKey = String(key);
    if (normalizedKey === STORAGE_KEY) this.physicalRemovals += 1;
    this.rows.delete(normalizedKey);
  }
}

function normalize(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    completions: Array.isArray(source.completions) ? source.completions : [],
    habits: Array.isArray(source.habits) ? source.habits : [],
    players: Array.isArray(source.players) ? source.players : [],
    flexActions: Array.isArray(source.flexActions) ? source.flexActions : [],
    gameHistory: Array.isArray(source.gameHistory) ? source.gameHistory : [],
    matchups: Array.isArray(source.matchups) ? source.matchups : [],
    schedule: Array.isArray(source.schedule) ? source.schedule : [],
    seasonHistory: Array.isArray(source.seasonHistory) ? source.seasonHistory : [],
    reminders: Array.isArray(source.reminders) ? source.reminders : []
  };
}

function populated(label = 'live') {
  return normalize({
    tasks: Array.from({ length: 40 }, (_, i) => ({ id: `${label}-t${i}` })),
    completions: Array.from({ length: 160 }, (_, i) => ({ id: `${label}-c${i}` })),
    habits: Array.from({ length: 20 }, (_, i) => ({ id: `${label}-h${i}` })),
    players: Array.from({ length: 30 }, (_, i) => ({ id: `${label}-p${i}` })),
    gameHistory: Array.from({ length: 140 }, (_, i) => ({ id: `${label}-g${i}` })),
    matchups: Array.from({ length: 140 }, (_, i) => ({ id: `${label}-m${i}` })),
    seasonHistory: Array.from({ length: 4 }, (_, i) => ({ id: `${label}-s${i}` }))
  });
}

function emptyState() { return normalize({}); }

function install({ initialRaw = JSON.stringify(populated()), extraStorage = {}, storageOptions = {} } = {}) {
  const initial = { ...extraStorage };
  if (initialRaw !== null) initial[STORAGE_KEY] = initialRaw;
  const localStorage = new FakeStorage(initial, storageOptions);
  const alerts = [];

  function safeReplace(raw) {
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous !== null && String(raw).length < previous.length) {
      localStorage.removeItem(STORAGE_KEY);
      try { localStorage.setItem(STORAGE_KEY, raw); }
      catch (error) {
        try { localStorage.setItem(STORAGE_KEY, previous); } catch (_) {}
        throw error;
      }
    } else localStorage.setItem(STORAGE_KEY, raw);
  }

  const core = {
    STORAGE_KEY,
    queueShadowDualWrite: () => Promise.resolve({ status: 'passed_verification' }),
    clearPendingTaskMutations() {},
    parseTaskPointsStorageJson: (raw, fallback) => { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    normalizeState: normalize,
    shadowCanonicalJson: (value) => JSON.stringify(value || {}),
    shadowSourceSummary: (value) => ({ hashes: { state: JSON.stringify(value || {}) } }),
    writeTaskPointsStoredState(next) { safeReplace(JSON.stringify(normalize(next))); return localStorage.getItem(STORAGE_KEY); },
    saveStateSnapshot(next, options = {}) { safeReplace(JSON.stringify(normalize(next))); return { state: normalize(next), options }; },
    saveValidatedSnapshot(next, options = {}) { safeReplace(JSON.stringify(normalize(next))); return { state: normalize(next), options }; }
  };

  const context = {
    TaskPointsCore: core,
    localStorage,
    Storage: undefined,
    indexedDB: undefined,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Set,
    Map,
    console,
    Date,
    alert: (message) => alerts.push(String(message))
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(PHASE2_SOURCE, context, { filename: 'phase2_reset_hook.js' });
  return { core, localStorage, alerts, context };
}

test('dangerous remove-then-set replacement is rejected before the old raw is physically removed', async () => {
  const oldRaw = JSON.stringify(populated('old'));
  const harness = install({
    initialRaw: oldRaw,
    storageOptions: { failRestoreWhenMissing: oldRaw }
  });

  assert.throws(
    () => harness.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }),
    /blocked a suspicious destructive state overwrite/i
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.localStorage.getItem(STORAGE_KEY), oldRaw);
  assert.equal(harness.localStorage.physicalRemovals, 0, 'the authoritative raw must never be deleted before candidate validation');
  const incident = JSON.parse(harness.localStorage.getItem(INCIDENT_KEY));
  assert.equal(incident.active, true);
  assert.equal(incident.previousRawHash != null, true);
});

test('a blocked incident fail-closes a missing-primary reload instead of accepting an empty startup save', () => {
  const oldRaw = JSON.stringify(populated('old'));
  const first = install({ initialRaw: oldRaw });
  assert.throws(() => first.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }));
  const incidentRaw = first.localStorage.getItem(INCIDENT_KEY);
  assert.ok(incidentRaw);

  const reopened = install({
    initialRaw: null,
    extraStorage: { [INCIDENT_KEY]: incidentRaw }
  });

  assert.throws(
    () => reopened.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }),
    (error) => error?.code === 'TASKPOINTS_STORAGE_FAIL_CLOSED'
  );
  assert.equal(reopened.localStorage.getItem(STORAGE_KEY), null);
  assert.equal(JSON.parse(reopened.localStorage.getItem(INCIDENT_KEY)).active, true);
});

test('a reload with the exact preserved primary automatically clears the incident latch', () => {
  const oldRaw = JSON.stringify(populated('old'));
  const first = install({ initialRaw: oldRaw });
  assert.throws(() => first.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }));
  const incidentRaw = first.localStorage.getItem(INCIDENT_KEY);

  const reopened = install({
    initialRaw: oldRaw,
    extraStorage: { [INCIDENT_KEY]: incidentRaw }
  });

  assert.equal(reopened.localStorage.getItem(STORAGE_KEY), oldRaw);
  assert.equal(reopened.localStorage.getItem(INCIDENT_KEY), null);
});

test('ordinary explicit removal still completes after the microtask boundary', async () => {
  const harness = install();
  assert.ok(harness.localStorage.getItem(STORAGE_KEY));
  harness.localStorage.removeItem(STORAGE_KEY);
  assert.ok(harness.localStorage.getItem(STORAGE_KEY), 'removal is deferred so a synchronous safe replacement can cancel it');
  await Promise.resolve();
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), null);
});

test('normal populated saves and explicitly authorized imports remain available', async () => {
  const harness = install();
  const normal = populated('normal');
  harness.core.saveStateSnapshot(normal, { savePath: 'task-edit' });
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'normal-t0');

  const imported = normalize({
    tasks: [{ id: 'imported-task' }],
    completions: Array.from({ length: 20 }, (_, i) => ({ id: `i-${i}` }))
  });
  harness.core.saveValidatedSnapshot(imported, {
    allowDestructiveOverwrite: true,
    source: 'settings-import'
  });
  await Promise.resolve();
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'imported-task');
});

test('storageSafetyBypass alone is no longer an unrestricted destructive-write bypass', () => {
  const harness = install();
  assert.throws(
    () => harness.core.saveStateSnapshot(emptyState(), {
      storageSafetyBypass: true,
      savePath: 'startup-derived-sync'
    }),
    /blocked a suspicious destructive state overwrite/i
  );
});
