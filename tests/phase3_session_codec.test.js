const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODEC_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_session_codec.js'), 'utf8');
const NAV_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_navigation_cache.js'), 'utf8');
const SESSION_KEY = 'taskpoints_phase3_verified_session_cache_v1';
const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase3_read_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase3_read_diagnostics_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];

function storageFromRows(rows = new Map(), quotaChars = Infinity) {
  return {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) {
      const normalized = String(value);
      const current = rows.get(String(key));
      let total = 0;
      for (const [storedKey, storedValue] of rows) {
        if (storedKey !== String(key)) total += storedKey.length + storedValue.length;
      }
      total += String(key).length + normalized.length;
      if (total > quotaChars) {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        if (current === undefined) rows.delete(String(key));
        throw error;
      }
      rows.set(String(key), normalized);
    },
    removeItem(key) { rows.delete(String(key)); },
    clear() { rows.clear(); },
    _rows: rows
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function layout(state) {
  const arrays = {}, collections = {}, values = {};
  for (const [field, value] of Object.entries(state || {})) {
    if (ARRAY_STORES.includes(field) && Array.isArray(value)) arrays[field] = value;
    else if (Array.isArray(value)) collections[field] = value;
    else values[field] = value;
  }
  ARRAY_STORES.forEach((field) => { if (!arrays[field]) arrays[field] = []; });
  return { arrays, collections, values };
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function summary(state) {
  const stateLayout = layout(state);
  const counts = {};
  Object.entries(stateLayout.arrays).forEach(([field, rows]) => { counts[field] = rows.length; });
  Object.entries(stateLayout.collections).forEach(([field, rows]) => { counts[field] = rows.length; });
  counts.topLevelValues = Object.keys(stateLayout.values).length;
  return { counts, hashes: { state: hashText(canonical(stateLayout)) } };
}

function largeState() {
  const tasks = [];
  for (let index = 0; index < 32000; index += 1) {
    tasks.push({
      id: `task-${index}`,
      title: 'Repeated preview task title for compression validation',
      notes: 'Repeated deterministic notes used to model a realistic large TaskPoints export.',
      points: index % 100,
      completed: index % 3 === 0
    });
  }
  return {
    completions: [], matchups: [], gameHistory: [], seasonHistory: [],
    tasks, habits: [], players: [], projects: [], schedule: [], settings: { sound: true }
  };
}

function recordFor(state) {
  const stateSummary = summary(state);
  return JSON.stringify({
    schemaVersion: 1,
    state,
    sourceHash: stateSummary.hashes.state,
    destinationHash: stateSummary.hashes.state,
    sourceCounts: stateSummary.counts,
    destinationCounts: stateSummary.counts,
    verifiedAt: '2026-07-23T15:00:00.000Z'
  });
}

function codecPage(sessionRows, quotaChars = Infinity) {
  const sessionStorage = storageFromRows(sessionRows, quotaChars);
  const core = { getPhase3ReadStatus: () => ({}) };
  const context = {
    TaskPointsCore: core, sessionStorage,
    JSON, Object, Array, String, Number, Math, Date, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(CODEC_SOURCE, context, { filename: 'phase3_session_codec.js' });
  return { core, sessionStorage };
}

function navigationPage({ state, localRows, sessionRows, quotaChars }) {
  const localStorage = storageFromRows(localRows);
  const sessionStorage = storageFromRows(sessionRows, quotaChars);
  const stateSummary = summary(state);
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE3_READ_MODE_KEY: MODE_KEY,
    PHASE3_READ_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
    shadowCanonicalJson: canonical,
    shadowSourceLayout: layout,
    shadowSourceSummary: summary,
    shadowVerificationMismatches(source, destination) {
      return source.hashes.state === destination.hashes.state ? [] : [{ type: 'hash' }];
    },
    parseTaskPointsStorageJson(raw, fallback = {}) { return raw ? JSON.parse(raw) : fallback; },
    getPendingShadowDualWriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    getPhase3ReadMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    setPhase3ReadMode(value) { localStorage.setItem(MODE_KEY, value); return value; },
    getPhase3ReadStatus() {
      let diagnostics = {};
      try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || '{}'); } catch (_) {}
      return {
        configuredMode: this.getPhase3ReadMode(),
        status: diagnostics.status || 'ready',
        effectiveSource: diagnostics.effectiveSource || 'localStorage',
        indexedDbReadsTotal: diagnostics.indexedDbReadsTotal || 0,
        fallbackReadsTotal: diagnostics.fallbackReadsTotal || 0,
        lastFallbackReason: diagnostics.lastFallbackReason || null,
        cacheReadyThisPage: false,
        currentRawMatchesCache: false
      };
    },
    refreshPhase3ReadCache: async () => ({ status: 'ready' }),
    clearPhase3ReadCache: () => true,
    testPhase3VerifiedRead: () => ({ served: false, reason: 'internal' }),
    readPhase3ShadowSnapshot: async () => ({
      state,
      currentMetadata: { status: 'passed_verification' },
      dualWriteMetadata: {
        status: 'passed_verification',
        verification: {
          source: { hashes: { state: stateSummary.hashes.state } },
          destination: { hashes: { state: stateSummary.hashes.state } }
        }
      }
    }),
    loadAppState(options = {}) {
      const raw = localStorage.getItem(STORAGE_KEY);
      localStorage.getItem(JOURNAL_KEY);
      return { state: raw ? JSON.parse(raw) : {}, options };
    }
  };
  const context = {
    TaskPointsCore: core, localStorage, sessionStorage,
    queueMicrotask() {}, addEventListener() {}, structuredClone,
    JSON, Object, Array, String, Number, Math, Date, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(CODEC_SOURCE, context, { filename: 'phase3_session_codec.js' });
  vm.runInNewContext(NAV_SOURCE, context, { filename: 'phase3_navigation_cache.js' });
  return { core, localStorage, sessionStorage };
}

test('large verified snapshot fits below quota, restores synchronously, and serves the first normal load', async () => {
  const state = largeState();
  const authoritativeRaw = JSON.stringify(state);
  assert.ok(authoritativeRaw.length >= 3_200_000);
  const localRows = new Map([[STORAGE_KEY, authoritativeRaw], [MODE_KEY, 'verified_indexeddb']]);
  const sessionRows = new Map();
  const quotaChars = 600_000;

  const firstPage = navigationPage({ state, localRows, sessionRows, quotaChars });
  assert.equal(await firstPage.core.rebuildPhase3NavigationCache(), true);
  const storedEnvelope = sessionRows.get(SESSION_KEY);
  assert.ok(storedEnvelope);
  assert.ok(recordFor(state).length > quotaChars);
  assert.ok(storedEnvelope.length < quotaChars);

  const secondPage = navigationPage({ state, localRows, sessionRows, quotaChars });
  const loaded = secondPage.core.loadAppState({ persistSync: true });
  const status = secondPage.core.getPhase3ReadStatus();
  assert.equal(loaded.state.tasks.length, state.tasks.length);
  assert.equal(loaded.options.persistSync, false);
  assert.equal(status.indexedDbReadsTotal, 1);
  assert.equal(status.fallbackReadsTotal, 0);
  assert.equal(status.navigationCacheRestoredFromSession, true);
  assert.equal(status.sessionCachePresent, true);
  assert.equal(status.sessionCacheCodec, 'lz-string-utf16-v1');
  assert.equal(status.sessionCacheOriginalChars, recordFor(state).length);
  assert.ok(status.sessionCacheStoredChars < status.sessionCacheOriginalChars);
});

for (const [name, mutate, failure] of [
  ['corrupted payload', (envelope) => { envelope.payload = `!${envelope.payload.slice(1)}`; }, null],
  ['truncated payload', (envelope) => { envelope.payload = envelope.payload.slice(0, -1); }, 'truncated_payload'],
  ['wrong original length', (envelope) => { envelope.originalChars += 1; }, 'original_length_mismatch'],
  ['unsupported codec', (envelope) => { envelope.codec = 'other'; }, 'unsupported_codec'],
  ['unsupported version', (envelope) => { envelope.schemaVersion = 999; }, 'unsupported_version']
]) {
  test(`${name} is rejected, cleared, and fails closed`, () => {
    const state = { tasks: [{ id: 'safe' }] };
    const rawRecord = recordFor(state);
    const rows = new Map();
    const first = codecPage(rows);
    first.sessionStorage.setItem(SESSION_KEY, rawRecord);
    const envelope = JSON.parse(rows.get(SESSION_KEY));
    mutate(envelope);
    rows.set(SESSION_KEY, JSON.stringify(envelope));

    const second = codecPage(rows);
    assert.equal(second.sessionStorage.getItem(SESSION_KEY), null);
    assert.equal(rows.has(SESSION_KEY), false);
    const actualFailure = second.core.getPhase3ReadStatus().sessionCachePersistFailure;
    if (failure) assert.equal(actualFailure, failure);
    else assert.ok(actualFailure);
  });
}

test('quota that is still too small remains nonfatal and exposes a safe failure code', () => {
  const rows = new Map();
  const page = codecPage(rows, 200);
  assert.throws(() => page.sessionStorage.setItem(SESSION_KEY, recordFor(largeState())), /quota/);
  assert.equal(rows.has(SESSION_KEY), false);
  const status = page.core.getPhase3ReadStatus();
  assert.equal(status.sessionCachePersistFailure, 'quota_exceeded');
  assert.equal(status.sessionCacheCodec, null);
});
