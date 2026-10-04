const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;

const storage = new Map();
global.localStorage = {
  getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
  setItem(key, value) { storage.set(String(key), String(value)); },
  removeItem(key) { storage.delete(String(key)); },
  key(index) { return Array.from(storage.keys())[index] || null; },
  get length() { return storage.size; }
};

require('../scoring_core.js');
require('../season_bracket_builder_core.js');
require('../season_bracket_builder_fixes.js');
const rollover = require('../season3_tournament_rollover.js');

const core = global.TaskPointsCore;

function makeState(count = 80) {
  return core.normalizeState({
    youName: 'You',
    players: Array.from({ length: count - 1 }, (_, index) => ({
      id: `P${String(index + 1).padStart(2, '0')}`,
      name: `Player ${String(index + 1).padStart(2, '0')}`,
      active: true
    })),
    matchups: [],
    gameHistory: [],
    completions: [],
    seasonHistory: []
  });
}

test('Season 3 does not roll over before October 1', () => {
  const state = makeState();
  const result = rollover.ensureSeasonThreeTournamentRollover(state, {
    effectiveDateKey: '2026-09-30',
    nowISO: '2026-09-30T23:00:00.000Z',
    materialize: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'before_tournament_start');
  assert.equal(result.state.currentSeason, null);
});

test('October 1 creates and locks Season 3 to exactly the top 60 with 12 Play-In series', () => {
  const state = makeState();
  const result = rollover.ensureSeasonThreeTournamentRollover(state, {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T12:00:00.000Z',
    materialize: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'season3_created_and_locked');
  assert.equal(result.season.id, 'season_3_october_2026');
  assert.equal(result.season.status, 'locked');
  assert.equal(result.season.seedRankingScope, 'season3');
  assert.equal(result.season.seeds.length, 60);
  assert.equal(result.season.meta.seasonMatchupControlEnabled, true);
  assert.equal(result.season.meta.season3AutoRollover, true);
  assert.equal(result.season.bracketConfig.presetId, 'season3_60_october_2026');

  const playIns = Object.values(result.season.series)
    .filter((series) => series.roundId === 'play_in')
    .sort((a, b) => a.seriesIndex - b.seriesIndex);
  assert.equal(playIns.length, 12);
  assert.deepEqual(playIns.map((series) => [series.playerASeed, series.playerBSeed]), [
    [37, 60], [38, 59], [39, 58], [40, 57], [41, 56], [42, 55],
    [43, 54], [44, 53], [45, 52], [46, 51], [47, 50], [48, 49]
  ]);
});

test('Season 3 rollover preserves manual pool exclusions before choosing the top 60', () => {
  const state = makeState();
  const active = core.getActiveSeasonPlayerPool(state);
  const included = active.slice(0, 65);
  state.currentSeason = core.createEmptySeasonDraft({
    id: 'season_3_october_2026',
    name: 'Season 3',
    label: 'October 2026 TaskPoints Championship',
    monthKey: '2026-10',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    status: 'preview',
    seedMode: 'auto',
    seedRankingScope: 'season3',
    playerPool: included
  });

  const excludedIds = new Set(active.slice(65).map((player) => player.id || player.playerId));
  const result = rollover.ensureSeasonThreeTournamentRollover(state, {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T12:00:00.000Z',
    materialize: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.season.seeds.length, 60);
  assert.equal(result.season.playerPool.length, 65);
  assert.equal(result.season.seeds.some((seed) => excludedIds.has(seed.playerId)), false);
});

test('Season 3 rollover is idempotent once the official bracket is locked', () => {
  const first = rollover.ensureSeasonThreeTournamentRollover(makeState(), {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T12:00:00.000Z',
    materialize: false
  });
  const snapshot = JSON.stringify(first.state.currentSeason);

  const second = rollover.ensureSeasonThreeTournamentRollover(first.state, {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T13:00:00.000Z',
    materialize: false
  });

  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'season3_already_official');
  assert.equal(JSON.stringify(second.state.currentSeason), snapshot);
});

test('a champion-crowned prior Season is archived before Season 3 starts', () => {
  const state = makeState();
  state.currentSeason = core.createEmptySeasonDraft({
    id: 'season_2_august_2026',
    name: 'Season 2',
    label: 'August 2026 TaskPoints Championship',
    monthKey: '2026-08',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    status: 'champion_crowned',
    championSummary: {
      championId: 'P01',
      championName: 'Player 01',
      runnerUpId: 'P02',
      runnerUpName: 'Player 02',
      finalsResult: 'Player 01 defeats Player 02, 4–2'
    }
  });

  const result = rollover.ensureSeasonThreeTournamentRollover(state, {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T12:00:00.000Z',
    materialize: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'prior_season_archived_and_season3_started');
  assert.equal(result.state.currentSeason.id, 'season_3_october_2026');
  assert.equal(result.state.currentSeason.status, 'locked');
  assert.equal(result.state.currentSeason.seeds.length, 60);

  const archivedSeasonTwo = result.state.seasonHistory.find((season) => season.id === 'season_2_august_2026');
  assert.ok(archivedSeasonTwo);
  assert.equal(archivedSeasonTwo.status, 'finalized');
});

test('a different current Season is never overwritten by Season 3 rollover', () => {
  const state = makeState();
  state.currentSeason = core.createEmptySeasonDraft({
    id: 'other-season',
    name: 'Other Season',
    monthKey: '2026-09',
    status: 'active'
  });

  const result = rollover.ensureSeasonThreeTournamentRollover(state, {
    effectiveDateKey: '2026-10-01',
    nowISO: '2026-10-01T12:00:00.000Z',
    materialize: false
  });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'different_current_season');
  assert.equal(result.state.currentSeason.id, 'other-season');
});

test('shared core bundle includes the dynamic builder, fixes, and automatic Season 3 rollover', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  const builderAt = worker.indexOf("'/season_bracket_builder_core.js'");
  const fixesAt = worker.indexOf("'/season_bracket_builder_fixes.js'");
  const rolloverAt = worker.indexOf("'/season3_tournament_rollover.js'");

  assert.ok(builderAt > 0);
  assert.ok(fixesAt > builderAt);
  assert.ok(rolloverAt > fixesAt);
});
