const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'season_result_integrity_guard.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function result({ id, seriesId, dateKey, gameNumber, playerAId, playerBId, winnerId, extra = {} }) {
  return {
    id,
    matchupId: id,
    seriesId,
    seasonSeriesId: seriesId,
    seasonId: 'season_2_august_2026',
    matchupType: 'tournament',
    dateKey,
    gameNumber,
    seriesGameNumber: gameNumber,
    playerAId,
    playerBId,
    winnerId,
    loserId: winnerId === playerAId ? playerBId : playerAId,
    playerAScore: winnerId === playerAId ? 50 : 40,
    playerBScore: winnerId === playerBId ? 50 : 40,
    source: 'matchup',
    ...extra
  };
}

function series({ id, roundId, playerAId, playerBId, bestOf = 3, gameResults = [] }) {
  const winsNeeded = Math.floor(bestOf / 2) + 1;
  const winsA = gameResults.filter((row) => row.winnerId === playerAId).length;
  const winsB = gameResults.filter((row) => row.winnerId === playerBId).length;
  const winnerId = winsA >= winsNeeded && winsA > winsB
    ? playerAId
    : (winsB >= winsNeeded && winsB > winsA ? playerBId : '');
  return {
    id,
    seasonId: 'season_2_august_2026',
    roundId,
    playerAId,
    playerBId,
    bestOf,
    winsNeeded,
    winsA,
    winsB,
    winnerId,
    loserId: winnerId ? (winnerId === playerAId ? playerBId : playerAId) : '',
    status: winnerId ? 'complete' : (playerAId && playerBId ? 'active' : 'pending'),
    gameResults
  };
}

function makeAugustFixture() {
  const ids = {
    YOU: 'YOU', BAVITZ: 'bavitz', KEVIN: 'kevin', X: 'player-x',
    A: 'player-a', B: 'player-b', C: 'player-c', D: 'player-d', BAD_WINNER: 'bad-winner'
  };
  const userSeriesId = 'season_2_august_2026_opening_round_5';
  const badSeriesId = 'season_2_august_2026_round_of_32_9';
  const r16Id = 'season_2_august_2026_round_of_16_5';
  const aug2User = result({
    id: '2026-08-02_season_2_august_2026_opening_round_5_g1',
    seriesId: userSeriesId,
    dateKey: '2026-08-02',
    gameNumber: 1,
    playerAId: ids.YOU,
    playerBId: ids.BAVITZ,
    winnerId: ids.YOU
  });
  const aug3User = result({
    id: '2026-08-03_season_2_august_2026_opening_round_5_g2',
    seriesId: userSeriesId,
    dateKey: '2026-08-03',
    gameNumber: 2,
    playerAId: ids.YOU,
    playerBId: ids.BAVITZ,
    winnerId: ids.BAVITZ
  });
  const juneCatchups = [1, 2, 3].map((gameNumber) => result({
    id: `${badSeriesId}_catch_up_${gameNumber}`,
    seriesId: badSeriesId,
    dateKey: `2026-06-0${gameNumber + 3}`,
    gameNumber,
    playerAId: ids.BAD_WINNER,
    playerBId: ids.B,
    winnerId: ids.BAD_WINNER,
    extra: { source: 'admin_catch_up', manualResult: true, catchUpResult: true, lateBoundSeriesCatchUp: true }
  }));
  return {
    ids, userSeriesId, badSeriesId, r16Id,
    state: {
      matchups: [
        { id: 'aug1-legit-a', dateKey: '2026-08-01', playerAId: ids.YOU, playerBId: ids.A },
        { id: 'aug1-legit-b', dateKey: '2026-08-01', playerAId: ids.BAVITZ, playerBId: ids.B },
        { id: 'legacy-kevin', dateKey: '2026-08-02', playerAId: ids.YOU, playerBId: ids.KEVIN, result: 'W' },
        { id: 'legacy-other', dateKey: '2026-08-02', playerAId: ids.BAVITZ, playerBId: ids.X },
        { id: 'legacy-third', dateKey: '2026-08-02', playerAId: ids.A, playerBId: ids.C },
        { id: 'legacy-fourth', dateKey: '2026-08-02', playerAId: ids.B, playerBId: ids.D },
        { ...aug2User, result: 'W' },
        { id: 'aug2-exhibition', matchupType: 'exhibition', dateKey: '2026-08-02', playerAId: ids.KEVIN, playerBId: ids.X },
        { id: 'aug2-exhibition-third', matchupType: 'exhibition', dateKey: '2026-08-02', playerAId: ids.A, playerBId: ids.B },
        { id: 'aug2-exhibition-fourth', matchupType: 'exhibition', dateKey: '2026-08-02', playerAId: ids.C, playerBId: ids.D },
        aug3User
      ],
      gameHistory: [],
      schedule: [
        { dateKey: '2026-08-03', matchups: [aug3User] },
        { dateKey: '2026-08-04', matchups: [{ id: 'future-preview', matchupType: 'tournament', playerAId: ids.YOU, playerBId: ids.BAVITZ }] }
      ],
      currentSeason: {
        id: 'season_2_august_2026', monthKey: '2026-08', status: 'active',
        meta: { seasonMatchupControlEnabled: true },
        series: {
          [userSeriesId]: series({ id: userSeriesId, roundId: 'opening_round', playerAId: ids.YOU, playerBId: ids.BAVITZ, gameResults: [aug2User, aug3User] }),
          [badSeriesId]: series({ id: badSeriesId, roundId: 'round_of_32', playerAId: ids.BAD_WINNER, playerBId: ids.B, bestOf: 5, gameResults: juneCatchups }),
          [r16Id]: series({ id: r16Id, roundId: 'round_of_16', playerAId: ids.BAD_WINNER, playerBId: '', bestOf: 5, gameResults: [] })
        }
      }
    }
  };
}

function recalculateSeries(seriesInput) {
  const current = clone(seriesInput);
  const rows = current.gameResults || [];
  const winsA = rows.filter((row) => row.winnerId === current.playerAId).length;
  const winsB = rows.filter((row) => row.winnerId === current.playerBId).length;
  const winsNeeded = Number(current.winsNeeded) || Math.floor((Number(current.bestOf) || 1) / 2) + 1;
  const winnerId = winsA >= winsNeeded && winsA > winsB
    ? current.playerAId
    : (winsB >= winsNeeded && winsB > winsA ? current.playerBId : '');
  return {
    ...current, winsA, winsB, winnerId,
    loserId: winnerId ? (winnerId === current.playerAId ? current.playerBId : current.playerAId) : '',
    status: winnerId ? 'complete' : (current.playerAId && current.playerBId ? 'active' : 'pending')
  };
}

function createHarness(overrides = {}) {
  const calls = { build: [], repairSchedule: [] };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    todayKey: () => '2026-08-03',
    getSeasonRoundOrder: () => ['play_in', 'opening_round', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals'],
    recalculateSeasonSeriesFromGameResults: recalculateSeries,
    recalculateAllSeasonSeriesFromGameResults(seasonInput) {
      const next = clone(seasonInput);
      Object.keys(next.series || {}).forEach((id) => { next.series[id] = recalculateSeries(next.series[id]); });
      return { ok: true, season: next, changed: true };
    },
    loadAppState: () => ({}),
    saveStateSnapshot: (state) => ({ state }),
    saveAppState: (state) => ({ state }),
    syncCurrentSeasonSeriesFromRecordedResults: (state) => ({ state, changed: false }),
    buildSeasonDailySlate(state, targetDateKey, options) {
      calls.build.push({ state: clone(state), targetDateKey, options: clone(options || {}) });
      return { ok: true, updatedSeason: clone(state.currentSeason), warnings: [] };
    },
    materializeSeasonSlateMatchupsForDate: (state) => ({ state, changed: false, materializedCount: 0 }),
    repairSeasonControlledScheduleFromSyncedSeason(state, options) {
      calls.repairSchedule.push({ state: clone(state), options: clone(options || {}) });
      return { state, changed: false, repairedDates: [] };
    },
    backfillLateBoundSeasonSeriesResults: (state, seasonInput) => ({ state, season: seasonInput, updatedSeason: seasonInput, changed: true, backfilledCount: 3 }),
    ...overrides
  };
  const context = {
    TaskPointsCore: core,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout() { return 1; }, addEventListener() {}, structuredClone: clone,
    Date, JSON, Object, Array, Set, Map, Number, String, Math, console,
    module: { exports: {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'season_result_integrity_guard.js' });
  return { core, api: context.TaskPointsSeasonResultIntegrity, calls };
}

test('typed and legacy slates collapse while a legacy-only prior date remains', () => {
  const fixture = makeAugustFixture();
  const { api } = createHarness();
  const repaired = api.removeDuplicateLegacySlates(clone(fixture.state));
  assert.equal(repaired.changed, true);
  assert.deepEqual(Array.from(repaired.duplicateDates), ['2026-08-02']);
  assert.equal(repaired.removedMatchups, 4);
  assert.equal(repaired.state.matchups.filter((row) => row.dateKey === '2026-08-02').length, 4);
  assert.equal(repaired.state.matchups.filter((row) => row.dateKey === '2026-08-01').length, 2);
});

test('Bavitz tournament game wins over the earlier Kevin legacy row', () => {
  const fixture = makeAugustFixture();
  const { api } = createHarness();
  const rows = fixture.state.matchups.filter((row) => row.dateKey === '2026-08-02' && (row.playerAId === 'YOU' || row.playerBId === 'YOU'));
  const chosen = api.chooseCanonicalCompletedMatchup(rows, '2026-08-02');
  assert.equal(chosen.seriesId, fixture.userSeriesId);
  assert.equal(chosen.playerBId, fixture.ids.BAVITZ);
});

test('unfinalized Game 2 is removed and the user series returns to 1-0', () => {
  const fixture = makeAugustFixture();
  const { api } = createHarness();
  const repaired = api.repairState(clone(fixture.state), { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:43:00-04:00' });
  const current = repaired.state.currentSeason.series[fixture.userSeriesId];
  assert.equal(current.gameResults.length, 1);
  assert.equal(current.winsA, 1);
  assert.equal(current.winsB, 0);
  assert.equal(current.status, 'active');
  assert.equal(repaired.diagnostics.removedLiveSeasonResults, 1);
});

test('June catchups and their downstream bracket slot are rolled back', () => {
  const fixture = makeAugustFixture();
  const { api } = createHarness();
  const repaired = api.repairState(clone(fixture.state), { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:43:00-04:00' });
  const badSeries = repaired.state.currentSeason.series[fixture.badSeriesId];
  const nextRound = repaired.state.currentSeason.series[fixture.r16Id];
  assert.equal(badSeries.gameResults.length, 0);
  assert.equal(badSeries.winnerId, '');
  assert.equal(nextRound.playerAId, '');
  assert.equal(nextRound.status, 'pending');
  assert.equal(repaired.diagnostics.removedOutOfSeasonSyntheticResults, 3);
  assert.equal(repaired.diagnostics.clearedAdvancedSlots, 1);
});

test('repair is idempotent', () => {
  const fixture = makeAugustFixture();
  const { api } = createHarness();
  const first = api.repairState(clone(fixture.state), { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:43:00-04:00' });
  const second = api.repairState(first.state, { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:44:00-04:00' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
});

test('schedule repair processes only today and past and preserves future previews', () => {
  const { core, calls } = createHarness();
  const state = {
    currentSeason: { id: 's', monthKey: '2026-08', status: 'active', series: {} }, matchups: [], gameHistory: [],
    schedule: [{ dateKey: '2026-08-02', matchups: [] }, { dateKey: '2026-08-03', matchups: [] }, { dateKey: '2026-08-04', matchups: [{ id: 'future' }] }]
  };
  const result = core.repairSeasonControlledScheduleFromSyncedSeason(state, { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:43:00-04:00' });
  assert.deepEqual(calls.repairSchedule[0].state.schedule.map((day) => day.dateKey), ['2026-08-02', '2026-08-03']);
  assert.deepEqual(Array.from(result.state.schedule, (day) => day.dateKey), ['2026-08-02', '2026-08-03', '2026-08-04']);
});

test('future build receives no current-day rows and uses actual today', () => {
  const { core, calls } = createHarness();
  const state = {
    currentSeason: { id: 's', monthKey: '2026-08', status: 'active', series: {} },
    matchups: [{ id: 'past', dateKey: '2026-08-02', playerAId: 'YOU', playerBId: 'A' }, { id: 'live', dateKey: '2026-08-03', playerAId: 'YOU', playerBId: 'B' }],
    gameHistory: [], schedule: []
  };
  core.buildSeasonDailySlate(state, '2026-08-09', { actualTodayDateKey: '2026-08-03', actualNowISO: '2026-08-03T09:43:00-04:00' });
  assert.deepEqual(calls.build[0].state.matchups.map((row) => row.id), ['past']);
  assert.equal(calls.build[0].options.todayDateKey, '2026-08-03');
});

test('future materialization is blocked from the live ledger', () => {
  const { core } = createHarness();
  const result = core.materializeSeasonSlateMatchupsForDate({ currentSeason: { id: 's', monthKey: '2026-08', series: {} }, matchups: [], schedule: [] }, '2026-08-04', { actualTodayDateKey: '2026-08-03' });
  assert.equal(result.blockedFutureMaterialization, true);
  assert.equal(result.materializedCount, 0);
});

test('June-specific late-bound backfill is skipped for an August season', () => {
  const { core } = createHarness();
  const seasonState = { id: 'season_2_august_2026', monthKey: '2026-08', series: {} };
  const result = core.backfillLateBoundSeasonSeriesResults({ currentSeason: seasonState }, seasonState, {});
  assert.equal(result.changed, false);
  assert.equal(result.backfilledCount, 0);
  assert.equal(result.skippedIncompatibleSeason, true);
});
