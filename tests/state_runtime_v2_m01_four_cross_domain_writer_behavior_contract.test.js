'use strict';
// M01: four *existing* V1 writer routes run in isolated Node VMs.
// These behavior witnesses are not a certified V2 owner, writer fence, or
// permission to promote the dark preview into production.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
function install(file, extra = {}) {
  const ctx = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    Date, JSON, Number, String, Math, Map, Set, WeakSet, Object,
    Array, Boolean, Promise, structuredClone: clone,
    setTimeout() { return 1; }, clearTimeout() {}, ...extra
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
  return ctx;
}
function goldFixture() {
  return {
    goldEconomy: { version: 1 },
    goldLedger: [
      { id: 'existing-you', playerId: 'YOU', amount: 12.5, balanceAfter: 12.5 },
      { id: 'existing-opponent', playerId: 'npc', amount: 9, balanceAfter: 9 }
    ],
    players: [{ id: 'npc', name: 'NPC' }],
    tasks: [{ id: 'task-kept', status: 'active' }],
    customUnknownField: { neverDelete: true }
  };
}
function goldHarness({ reject = false, fakePersist = false } = {}) {
  const values = new Map([['taskpoints_v1', JSON.stringify(goldFixture())]]);
  const saves = [];
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, v) { values.set(key, String(v)); },
    removeItem(key) { values.delete(key); }
  };
  const core = {
    loadAppState() { return { state: JSON.parse(storage.getItem('taskpoints_v1')) }; },
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    saveValidatedSnapshot(state, options) {
      saves.push({ state: clone(state), options });
      if (reject) return { blockedByQuotaCircuit: true };
      if (!fakePersist) storage.setItem('taskpoints_v1', JSON.stringify(state));
      return { state };
    }
  };
  let nextId = 0;
  const ctx = install('gold_manual_adjustment.js', {
    TaskPointsCore: core, localStorage: storage, crypto: {
      randomUUID() { return 'test-' + (++nextId); }
    }
  });
  return { api: ctx.TaskPointsManualGoldAdjustment, storage, saves,
    saved: () => JSON.parse(storage.getItem('taskpoints_v1')) };
}
test('manual Gold writer requires a fresh confirmation and preserves all existing ledger rows', () => {
  const h = goldHarness();
  const request = { playerId: 'YOU', mode: 'add', amount: '3.4', note: 'audit proof' };
  const confirmed = h.api.preview(request);
  const result = h.api.commit(request, confirmed);
  assert.equal(result.balance, 15.9);
  assert.equal(result.transaction.meta.source, 'gold_ledger_manual_adjustment');
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].options.immediateWrite, true);
  assert.equal(h.saves[0].options.savePath, 'gold-manual-adjustment');
  assert.equal(h.saved().goldLedger.length, 3);
  assert.deepEqual(h.saved().goldLedger.slice(0,2), goldFixture().goldLedger);
  assert.equal(h.saved().tasks[0].id, 'task-kept');
  assert.equal(h.saved().customUnknownField.neverDelete, true);
  assert.equal(h.api.planBalance, undefined, 'only the existing supported API is exposed');
});
test('Gold writer refuses stale confirmation, recovery hold, declined save and false success', () => {
  const req = { playerId: 'YOU', mode: 'subtract', amount: '2.0' };
  const stale = goldHarness();
  const previous = stale.api.preview(req);
  const newer = stale.saved(); newer.tasks.push({ id: 'changed' });
  stale.storage.setItem('taskpoints_v1', JSON.stringify(newer));
  assert.throws(() => stale.api.commit(req, previous), /changed since the confirmation/);
  assert.equal(stale.saves.length, 0);
  const held = goldHarness();
  held.storage.setItem('taskpoints_emergency_recovery_hold_v1', '{malformed');
  assert.throws(() => held.api.preview(req), /Emergency Recovery/);
  assert.equal(held.saves.length, 0);
  const blocked = goldHarness({ reject: true });
  const before = blocked.saved(); const confirmed = blocked.api.preview(req);
  assert.throws(() => blocked.api.commit(req, confirmed), /protected save was declined/);
  assert.deepEqual(blocked.saved(), before);
  const unverified = goldHarness({ fakePersist: true });
  const preview = unverified.api.preview(req);
  assert.throws(() => unverified.api.commit(req, preview), /could not be verified|not fully verified/);
  assert.equal(unverified.saved().goldLedger.length, 2);
});

function seasonTwoFixture() {
  return {
    gold: 11, tasks: [{ id: 'keep' }],
    matchups: [{
      id: 'source-game', dateKey: '2026-08-01', playerAId: 'a',
      playerBId: 'b', scoreA: 18, scoreB: 11
    }],
    currentSeason: {
      id: 'season_2_august_2026', status: 'locked',
      bracketConfig: { presetId: 'season2_60_august_2026' },
      dateWindows: [{ id: 'play_in', startDate: '2026-08-01',
        endDate: '2026-08-01', bestOf: 1 }],
      series: { 'series-play-in': {
        id: 'series-play-in', roundId: 'play_in', seriesIndex: 0,
        playerAId: 'a', playerBId: 'b', status: 'pending', gameResults: []
      } }
    }
  };
}
function seasonTwoHarness({ failure = false, omitScores = false } = {}) {
  let state = seasonTwoFixture();
  if (omitScores) state.matchups = [];
  const saves = [];
  const core = {
    loadAppState() { return { state: clone(state) }; },
    normalizeState: clone,
    prepareSeasonForDailySlate(season) { return { season: clone(season) }; },
    recordSeasonSeriesGameResult(season, seriesId, game) {
      const next = clone(season);
      const series = next.series[seriesId];
      const winnerId = game.scoreA > game.scoreB ? series.playerAId : series.playerBId;
      series.gameResults = [clone(game)];
      series.winnerId = winnerId;
      series.status = 'complete';
      return { ok: true, season: next, series };
    },
    advanceSeasonSeriesWinner(season) { return { ok: true, season: clone(season) }; },
    saveStateSnapshot(candidate, options) {
      saves.push({ candidate: clone(candidate), options });
      if (failure) throw Error('storage blocked');
      state = clone(candidate);
      return { state: clone(state) };
    }
  };
  const ctx = install('season2_missed_playin_recovery.js', { TaskPointsCore: core });
  return { api: ctx.TaskPointsSeasonTwoRecovery, saves,
    get state() { return clone(state); },
    set state(next) { state = clone(next); } };
}
test('Season 2 Play-In recovery persists only missing recorded series once', () => {
  const h = seasonTwoHarness();
  const result = h.api.runAutomaticRecovery({
    effectiveDateKey: '2026-08-02', nowISO: '2026-08-02T10:00:00Z'
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(Array.from(result.recoveredSeriesIds), ['series-play-in']);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].options.savePath, 'season2-missed-play-in-recovery');
  assert.equal(h.saves[0].options.immediateWrite, true);
  assert.equal(h.saves[0].options.userInitiated, false);
  assert.equal(h.state.currentSeason.series['series-play-in'].winnerId, 'a');
  assert.equal(h.state.currentSeason.meta.season2MissedPlayInRecoveredSeriesIds[0], 'series-play-in');
  assert.equal(h.state.gold, 11);
  assert.equal(h.state.tasks[0].id, 'keep');
  const again = h.api.runAutomaticRecovery({ effectiveDateKey: '2026-08-03' });
  assert.equal(again.changed, false);
  assert.equal(h.saves.length, 1);
});
test('Season 2 recovery does not write missing scores, unfinished day or failed snapshot', () => {
  const missing = seasonTwoHarness({ omitScores: true });
  const result = missing.api.runAutomaticRecovery({ effectiveDateKey: '2026-08-02' });
  assert.equal(result.reason, 'missing_play_in_scores');
  assert.equal(missing.saves.length, 0);
  const early = seasonTwoHarness();
  assert.equal(early.api.runAutomaticRecovery({ effectiveDateKey: '2026-08-01' }).changed, false);
  assert.equal(early.saves.length, 0);
  const rejected = seasonTwoHarness({ failure: true });
  const before = rejected.state;
  const failed = rejected.api.runAutomaticRecovery({ effectiveDateKey: '2026-08-02' });
  assert.equal(failed.reason, 'save_failed');
  assert.equal(failed.ok, false);
  assert.deepEqual(rejected.state, before);
});

function upsetFixture() {
  return {
    tasks: [{ id: 'keep-task' }],
    inboxStartedDateKey: '2026-11-05',
    inboxMessages: [],
    inboxProcessedEventIds: {},
    players: [{ id: 'favorite', name: 'Favorite' }, { id: 'underdog', name: 'Underdog' }],
    currentSeason: {
      id: 'season-test',
      series: {
        'upset-one': {
          id: 'upset-one', roundId: 'finals', playerAId: 'underdog',
          playerBId: 'favorite', playerASeed: 8, playerBSeed: 1,
          winnerId: 'underdog', winsA: 1, winsB: 0, winsNeeded: 1,
          gameResults: [{ winnerId: 'underdog', gameNumber: 1,
            dateKey: '2026-11-07' }]
        }
      }
    }
  };
}
function upsetHarness({ failMerge = false } = {}) {
  let state = upsetFixture();
  const saves = [], loadOptions = [], events = [];
  const core = {
    loadAppState(options) { loadOptions.push(options); return { state: clone(state) }; },
    mergeAndSaveState(patch, options) {
      saves.push({ patch: clone(patch), options });
      if (failMerge) throw Error('quota exceeded');
      state = { ...state, ...clone(patch) };
      return { state: clone(state) };
    }
  };
  const ctx = install('season_series_upset_notifications.js', {
    TaskPointsCore: core, location: { pathname: '/records.html' },
    addEventListener() {}, dispatchEvent(event) { events.push(event); },
    CustomEvent: class CustomEvent { constructor(type, options) {
      this.type = type; this.detail = options?.detail;
    }}
  });
  return { api: ctx.TaskPointsSeasonSeriesUpsetNotifications, saves,
    loadOptions, events, get state() { return clone(state); },
    set state(next) { state = clone(next); } };
}
test('Season upset writer saves Inbox fields only and deduplicates background events', () => {
  const h = upsetHarness();
  const options = { now: new Date('2026-11-10T18:00:00.000Z') };
  const first = h.api.reconcileStored(options);
  assert.equal(first.changed, true);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].options.savePath, 'season-series-upset-inbox');
  assert.equal(h.saves[0].options.immediateWrite, true);
  assert.deepEqual(Object.keys(h.saves[0].patch).sort(), [
    'inboxMessages','inboxProcessedEventIds','inboxStartedDateKey'
  ]);
  assert.equal(h.state.inboxMessages.length, 1);
  assert.equal(h.state.inboxMessages[0].winnerSeed, 8);
  assert.equal(h.state.inboxMessages[0].loserSeed, 1);
  assert.equal(h.state.tasks[0].id, 'keep-task');
  assert.equal(h.state.inboxProcessedEventIds['season-series-seed-upset:season-test:upset-one'], true);
  h.api.reconcileStored(options);
  assert.equal(h.saves.length, 1, 'processed event must not generate a duplicate save');
  assert.equal(h.loadOptions[0].persistSync, false);
});
test('Season upset writer preserves Inbox data when the merge writer fails', () => {
  const h = upsetHarness({ failMerge: true });
  const original = h.state;
  assert.equal(h.api.reconcileStored({ now: new Date('2026-11-10T18:00:00Z') }), null);
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.state, original);
});

function integrityFixture() {
  const typed=[], legacy=[];
  const day = '2026-11-07';
  for (let i=0;i<4;i++) {
    const row = {
      id: 'game-'+i, dateKey: day, playerAId: 'p'+(i*2),
      playerBId: 'p'+(i*2+1), scoreA: 18, scoreB: 15, resultFinal: true
    };
    typed.push({ ...row, matchupType: 'tournament' });
    legacy.push({ ...row, id: 'old-'+i });
  }
  return {
    gold: 77, tasks: [{ id: 'other-task' }],
    matchups: [...typed, ...legacy],
    schedule: [{ dateKey: day, matchups: [...typed, ...legacy] }]
  };
}
function integrityHarness({ failPersist = false } = {}) {
  const stored = new Map([['taskpoints_v1', JSON.stringify(integrityFixture())]]);
  const saves = [];
  const storage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    todayKey() { return '2026-11-10'; },
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    loadAppState() { return { state: JSON.parse(storage.getItem('taskpoints_v1')) }; },
    saveStateSnapshot(candidate, options) {
      saves.push({ candidate: clone(candidate), options });
      if (failPersist) throw Error('locked snapshot');
      storage.setItem('taskpoints_v1', JSON.stringify(candidate));
      return { state: clone(candidate) };
    }
  };
  const ctx = install('season_result_integrity_guard.js', {
    TaskPointsCore: core, localStorage: storage,
    addEventListener() {}, getCompletedYouMatchupsForStats() { return []; }
  });
  return { core, saves, storage, api: ctx.TaskPointsSeasonResultIntegrity,
    saved() { return JSON.parse(storage.getItem('taskpoints_v1')); } };
}
test('startup Season integrity writer repairs duplicate slates through protected V1 save', () => {
  const h = integrityHarness();
  assert.equal(h.saves.length, 1, 'startup repair must save exactly once');
  assert.equal(h.saves[0].options.savePath, 'season-result-integrity-repair');
  assert.equal(h.saves[0].options.immediateWrite, true);
  assert.equal(h.saved().matchups.length, 4);
  assert.equal(h.saved().schedule[0].matchups.length, 4);
  assert.ok(h.saved().matchups.every(row => row.matchupType === 'tournament'));
  assert.equal(h.saved().gold, 77);
  assert.equal(h.saved().tasks[0].id, 'other-task');
  assert.equal(h.api.repairAuthoritativeStoredState({ reuseCheckedRaw: true }), false);
  assert.equal(h.saves.length, 1, 'clean repeat must not rewrite canonical state');
});
test('Season integrity repair preserves original bytes if V1 save fails', () => {
  const h = integrityHarness({ failPersist: true });
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.saved(), integrityFixture());
  assert.equal(h.api.repairAuthoritativeStoredState({ reuseCheckedRaw: true }), false);
  assert.equal(h.saves.length, 2, 'failed repair must be retried rather than marked clean');
  assert.deepEqual(h.saved(), integrityFixture());
});

test('M01 four cross-domain writer witnesses remain provisional', () => {
  const inv=JSON.parse(fs.readFileSync(path.join(root,
    'docs/state-runtime-v2-storage-source-inventory.json'),'utf8'));
  const rows=inv.writerBehaviorWitnesses.filter(row=>
    row.testPath==='tests/state_runtime_v2_m01_four_cross_domain_writer_behavior_contract.test.js');
  assert.deepEqual(rows.map(row=>row.path).sort(),[
    'gold_manual_adjustment.js',
    'season2_missed_playin_recovery.js',
    'season_result_integrity_guard.js',
    'season_series_upset_notifications.js'
  ]);
  assert.equal(rows.length,4);
  for(const row of rows) {
    assert.ok(inv.writerPathEvidence.some(x=>x.path===row.path&&x.anchor===row.anchor));
    assert.ok(row.observedBehaviors.length>=4);
    assert.equal(row.productionOwnerVerified,false);
    assert.equal(row.productionFenceVerified,false);
    assert.equal(row.cutoverPermission,false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,60);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments,0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced,false);
  assert.equal(inv.writerOwnershipAudit.status,'incomplete');
  assert.equal(inv.writerOwnershipAudit.crossDomainWriterEvidence.productionOwnerCertified,false);
  assert.equal(inv.writerOwnershipAudit.crossDomainWriterEvidence.liveCrossTabFencingVerified,false);
});
