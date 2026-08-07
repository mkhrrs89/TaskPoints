const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const IDLE = fs.readFileSync(path.join(ROOT, 'storage_maintenance_idle.js'), 'utf8');
const PHASE2 = fs.readFileSync(path.join(ROOT, 'phase2_dual_write.js'), 'utf8');
const PHASE3_READ = fs.readFileSync(path.join(ROOT, 'phase3_read_path.js'), 'utf8');
const PHASE3_NAV = fs.readFileSync(path.join(ROOT, 'phase3_navigation_cache.js'), 'utf8');
const PHASE4_READ = fs.readFileSync(path.join(ROOT, 'phase4_primary_read_path.js'), 'utf8');
const YOU_ALIAS = fs.readFileSync(path.join(ROOT, 'you_score_alias_alignment.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function basicContext(core, localStorage, overrides = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    addEventListener(name, fn) { documentListeners.set(name, fn); }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage: new FakeStorage(),
    document,
    location: { pathname: '/settings.html' },
    performance: { now: () => 500 },
    structuredClone,
    setTimeout() { return 1; },
    clearTimeout() {},
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console,
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  return { context, documentListeners, windowListeners };
}

test('Step 3E startup no-op guard skips identical bootstrap saves but never changed or interacted saves', () => {
  const storageKey = 'taskpoints_v1';
  const initial = { tasks: [{ id: 'a' }], matchups: [], currentSeason: null };
  const localStorage = new FakeStorage({ [storageKey]: JSON.stringify(initial) });
  let underlyingSaves = 0;
  const core = {
    STORAGE_KEY: storageKey,
    saveStateSnapshot(state) { underlyingSaves += 1; return { state, trimmed: false }; },
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    normalizeState(state) { return structuredClone(state || {}); },
    readPendingHabitDeltas() { return []; }
  };
  const { context, documentListeners } = basicContext(core, localStorage);
  vm.runInNewContext(IDLE, context, { filename: 'storage_maintenance_idle.js' });

  const same = core.saveStateSnapshot(structuredClone(initial), { savePath: 'bootstrap-sync' });
  assert.equal(underlyingSaves, 0, 'an identical pre-interaction bootstrap save should not reach compression/persistence');
  assert.equal(same.noOp, true);
  assert.equal(core.getStorageMaintenanceIdleStatus().startupSaveSkips, 1);

  core.saveStateSnapshot({ ...initial, tasks: [{ id: 'b' }] }, { savePath: 'bootstrap-sync' });
  assert.equal(underlyingSaves, 1, 'a real state change must still save');

  documentListeners.get('pointerdown')?.({ target: { tagName: 'BUTTON' } });
  core.saveStateSnapshot(structuredClone(initial), { savePath: 'after-user-action' });
  assert.equal(underlyingSaves, 2, 'once the user interacts, save behavior remains unchanged');
});

test('YOU alias startup repair compares normalized runtime state rather than compact storage omissions', () => {
  const storageKey = 'taskpoints_v1';
  const compact = {
    currentSeason: {
      id: 'season-1',
      series: [{ id: 'series-1', playerAId: 'YOU', playerBId: 'p2' }]
    },
    schedule: [],
    matchups: [{
      id: 'm1',
      dateKey: '2026-08-07',
      playerAId: 'YOU',
      playerBId: 'p2',
      scoreA: 40,
      scoreB: 25,
      matchupType: 'season',
      seasonId: 'season-1',
      seriesId: 'series-1'
    }]
  };
  const localStorage = new FakeStorage({ [storageKey]: JSON.stringify(compact) });
  let saves = 0;
  const normalizeState = (state) => {
    const next = structuredClone(state || {});
    next.matchups = (next.matchups || []).map((row) => ({
      ...row,
      ...(row.playerAId === 'YOU' && Number.isFinite(Number(row.scoreA)) && row.playerAScore == null
        ? { playerAScore: Number(row.scoreA) }
        : {}),
      ...(row.playerBId === 'YOU' && Number.isFinite(Number(row.scoreB)) && row.playerBScore == null
        ? { playerBScore: Number(row.scoreB) }
        : {})
    }));
    return next;
  };
  const core = {
    STORAGE_KEY: storageKey,
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    normalizeState,
    syncYouMatchups(state) { return { state, changed: false }; },
    loadAppState() { return { state: normalizeState(JSON.parse(localStorage.getItem(storageKey))) }; },
    saveStateSnapshot(state) { saves += 1; return { state }; },
    saveAppState() {},
    mergeAndSaveState(state) { return { state }; }
  };
  const { context } = basicContext(core, localStorage);
  vm.runInNewContext(YOU_ALIAS, context, { filename: 'you_score_alias_alignment.js' });

  assert.equal(saves, 0, 'omitted redundant aliases in compressed storage must not trigger a bootstrap repair save');
  assert.equal(core.YouScoreAliasAlignment.repairPersistedState().changed, false);
});

test('Phase 2/3/4 automatic cache maintenance no longer uses startup microtask bypasses', () => {
  assert.match(PHASE2, /whenStorageMaintenanceQuiet/);
  assert.match(PHASE2, /phase2_dual_write_coalesced/);
  assert.match(PHASE3_READ, /whenStorageMaintenanceQuiet/);
  assert.doesNotMatch(PHASE3_READ, /global\.queueMicrotask/);
  assert.match(PHASE3_NAV, /whenStorageMaintenanceQuiet/);
  assert.doesNotMatch(PHASE3_NAV, /global\.queueMicrotask/);
  assert.match(PHASE4_READ, /whenStorageMaintenanceQuiet/);
  assert.doesNotMatch(PHASE4_READ, /global\.queueMicrotask/);
});
