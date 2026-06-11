const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};
require('../scoring_core.js');

const core = global.TaskPointsCore;

function makeResult(series, dateKey, gameNumber, winnerId, overrides = {}) {
  const loserId = winnerId === series.playerAId ? series.playerBId : series.playerAId;
  return {
    id: `${series.id}_${dateKey}_g${gameNumber}`,
    matchupId: `${series.id}_${dateKey}_g${gameNumber}`,
    seasonId: 'season_1_june_2026',
    seriesId: series.id,
    seasonSeriesId: series.id,
    roundId: series.roundId,
    dateKey,
    gameNumber,
    seriesGameNumber: gameNumber,
    game: gameNumber,
    matchupType: 'tournament',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    winnerId,
    loserId,
    playerAScore: winnerId === series.playerAId ? 50 : 40,
    playerBScore: winnerId === series.playerBId ? 50 : 40,
    source: 'matchup',
    ...overrides
  };
}

function makeSweet16Series(index, overrides = {}) {
  const a = `p${index * 2 + 1}`;
  const b = `p${index * 2 + 2}`;
  return {
    id: `season_1_june_2026_sweet_16_${index + 1}`,
    seasonId: 'season_1_june_2026',
    roundId: 'sweet_16',
    roundName: 'Sweet 16',
    roundIndex: 2,
    seriesIndex: index,
    bestOf: 5,
    winsNeeded: 3,
    status: 'pending',
    playerAId: a,
    playerAName: `Player ${index * 2 + 1}`,
    playerASeed: index * 2 + 1,
    playerBId: b,
    playerBName: `Player ${index * 2 + 2}`,
    playerBSeed: index * 2 + 2,
    winsA: 0,
    winsB: 0,
    winnerId: '',
    loserId: '',
    gameResults: [],
    ...overrides
  };
}

function makeSeason({ readyCount = 8, status = 'pending', meta = {} } = {}) {
  const series = {};
  for (let i = 0; i < 8; i += 1) {
    const ready = i < readyCount;
    const s = makeSweet16Series(i, {
      status,
      playerAId: ready ? `p${i * 2 + 1}` : '',
      playerAName: ready ? `Player ${i * 2 + 1}` : '',
      playerBId: ready ? `p${i * 2 + 2}` : '',
      playerBName: ready ? `Player ${i * 2 + 2}` : ''
    });
    series[s.id] = s;
  }
  return {
    id: 'season_1_june_2026',
    monthKey: '2026-06',
    startDateKey: '2026-06-01',
    endDateKey: '2026-06-30',
    status: 'active',
    meta: { seasonMatchupControlEnabled: true, ...meta },
    series
  };
}

function makeState(season, matchups = []) {
  return {
    currentSeason: season,
    players: Array.from({ length: 16 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, active: true })),
    matchups,
    completions: [],
    tasks: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    schedule: [],
    opponentDripSchedules: []
  };
}

test('round does not start partially', () => {
  const state = makeState(makeSeason({ readyCount: 6, status: 'active' }));
  const slate = core.buildSeasonDailySlate(state, '2026-06-09', { nowISO: '2026-06-09T12:00:00.000Z' });

  assert.equal(slate.tournamentMatchups.length, 0);
  assert.equal(slate.warnings.some((warning) => warning.includes('Sweet 16 is waiting for all series to be ready (6/8)')), true);
});

test('fully ready round starts together', () => {
  const slate = core.buildSeasonDailySlate(makeState(makeSeason({ readyCount: 8, status: 'pending' })), '2026-06-09', { nowISO: '2026-06-09T12:00:00.000Z' });

  assert.equal(slate.tournamentMatchups.length, 8);
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([1]));
  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-09');
});


test('already-active round infers start from existing gameResults', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  Object.values(season.series).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-10', { nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-09');
  assert.equal(slate.tournamentMatchups.length, 8);
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([2]));
});

test('already-active round infers start from linked matchups', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const matchups = Object.values(season.series).map((series) => makeResult(series, '2026-06-09', 1, series.playerAId));

  const slate = core.buildSeasonDailySlate(makeState(season, matchups), '2026-06-10', { nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-09');
  assert.equal(slate.tournamentMatchups.length, 8);
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([2]));
});

test('new fully-ready round stamps today when no prior evidence exists', () => {
  const season = makeSeason({ readyCount: 8, status: 'pending' });

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-10', { nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-10');
  assert.equal(slate.tournamentMatchups.length, 8);
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([1]));
});

test('existing round start date is preserved during slate generation', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  Object.values(season.series).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-10', { nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-09');
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([2]));
});

test('round game number calculation uses preserved start date', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });

  assert.equal(core.getRoundScheduledGameNumberForDate(season, 'sweet_16', '2026-06-10'), 2);
});

test('game number stays round-synchronized', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  Object.values(season.series).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-10', { nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(slate.tournamentMatchups.length, 8);
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([2]));
});

test('admin alignment repair removes staggered Game 1/Game 2 state', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  entries.slice(0, 2).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season), { dateKey: '2026-06-10', nowISO: '2026-06-10T12:00:00.000Z' });

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 6);
  const repaired = Object.values(repair.updatedSeason.series);
  assert.equal(repaired.every((series) => series.gameResults.length === 1), true);
  assert.equal(repaired.every((series) => core.getSeriesGameNumber(series, '2026-06-10', repair.updatedSeason) === 2), true);
  assert.equal(repair.updatedSeason.series[entries[0].id].gameResults[0].source, 'matchup');
  assert.equal(repaired.slice(2).every((series) => series.gameResults[0].source === 'admin_catch_up' && series.gameResults[0].roundAlignmentRepair === true), true);
});

test('admin alignment repair is idempotent', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  Object.values(season.series).slice(0, 2).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });
  const first = core.repairCurrentRoundSeriesGameAlignment(makeState(season), { dateKey: '2026-06-10', nowISO: '2026-06-10T12:00:00.000Z' });
  const before = JSON.stringify(first.updatedSeason.series);
  const second = core.repairCurrentRoundSeriesGameAlignment(first.state, { dateKey: '2026-06-10', nowISO: '2026-06-10T12:30:00.000Z' });

  assert.equal(second.changed, false);
  assert.equal(second.repairedCount, 0);
  assert.equal(JSON.stringify(second.updatedSeason.series), before);
});

test('completed series are not over-scheduled', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  const completed = season.series.season_1_june_2026_sweet_16_1;
  completed.gameResults = [
    makeResult(completed, '2026-06-09', 1, completed.playerAId),
    makeResult(completed, '2026-06-10', 2, completed.playerAId),
    makeResult(completed, '2026-06-11', 3, completed.playerAId)
  ];
  completed.winsA = 3;
  completed.status = 'complete';
  completed.winnerId = completed.playerAId;
  completed.loserId = completed.playerBId;

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-12', { nowISO: '2026-06-12T12:00:00.000Z' });

  assert.equal(slate.tournamentMatchups.some((matchup) => matchup.seriesId === completed.id), false);
});

test('real recorded results beat synthetic catch-up during alignment repair', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  entries.slice(0, 2).forEach((series) => {
    series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
    series.winsA = 1;
  });
  const real = makeResult(entries[2], '2026-06-09', 1, entries[2].playerBId, { id: 'real_sweet16_game1', matchupId: 'real_sweet16_game1' });

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, [real]), { dateKey: '2026-06-10', nowISO: '2026-06-10T12:00:00.000Z' });
  const repaired = repair.updatedSeason.series[entries[2].id].gameResults[0];

  assert.equal(repaired.id, 'real_sweet16_game1');
  assert.equal(repaired.source, 'matchup');
  assert.equal(repaired.catchUpResult, undefined);
  assert.equal(repaired.winnerId, entries[2].playerBId);
});

test('automatic alignment can use unlinked real prior-day matchups without inventing missing results', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  entries[0].gameResults = [makeResult(entries[0], '2026-06-09', 1, entries[0].playerAId)];
  entries[0].winsA = 1;

  const unlinkedReal = makeResult(entries[1], '2026-06-09', 1, entries[1].playerBId, {
    id: 'unlinked_real_sweet16_game1',
    matchupId: 'unlinked_real_sweet16_game1',
    seriesId: '',
    seasonSeriesId: ''
  });

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, [unlinkedReal]), {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 1);
  assert.equal(repair.updatedSeason.series[entries[1].id].winsB, 1);
  assert.equal(repair.updatedSeason.series[entries[1].id].gameResults[0].id, 'unlinked_real_sweet16_game1');
  assert.equal(repair.updatedSeason.series[entries[2].id].gameResults.length, 0);
});

test('automatic alignment infers a round start from real prior-day matchup evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  const realResults = entries.map((series) => makeResult(series, '2026-06-09', 1, series.playerAId, {
    seriesId: '',
    seasonSeriesId: ''
  }));

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, realResults), {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 8);
  assert.equal(repair.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-09');
  assert.equal(Object.values(repair.updatedSeason.series).every((series) => series.winsA === 1 && series.gameResults.length === 1), true);
});

test('current-day tournament results are not counted by default during sync', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  season.startDateKey = '2026-06-01';
  season.endDateKey = '2026-06-30';
  const [series] = Object.values(season.series);
  const currentDayResult = makeResult(series, '2026-06-10', 2, series.playerAId);

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(makeState(season, [currentDayResult]), {
    nowISO: '2026-06-10T12:00:00.000Z'
  });

  assert.equal(synced.updatedSeason.series[series.id].winsA, 0);
  assert.equal(synced.updatedSeason.series[series.id].gameResults.length, 0);
});

test('automatic alignment ignores ordinary same-pair daily matchups without season evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);

  const ordinaryDailyMatchup = {
    id: 'ordinary_daily_same_pair',
    matchupId: 'ordinary_daily_same_pair',
    dateKey: '2026-06-09',
    playerAId: entries[1].playerAId,
    playerBId: entries[1].playerBId,
    playerAScore: 50,
    playerBScore: 40,
    winnerId: entries[1].playerAId
  };

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, [ordinaryDailyMatchup]), {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, false);
  assert.equal(repair.repairedCount, 0);
  assert.equal(repair.updatedSeason.series[entries[1].id].gameResults.length, 0);
  assert.equal(repair.updatedSeason.series[entries[1].id].winsA, 0);
  assert.equal(repair.updatedSeason.series[entries[1].id].winsB, 0);
});

test('automatic alignment accepts explicit unlinked tournament evidence for the current round', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);

  const tournamentEvidence = makeResult(entries[1], '2026-06-09', 1, entries[1].playerBId, {
    id: 'explicit_tournament_sweet16_game1',
    matchupId: 'explicit_tournament_sweet16_game1',
    seriesId: '',
    seasonSeriesId: '',
    matchupType: 'tournament',
    roundId: entries[1].roundId,
    seasonId: season.id
  });

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, [tournamentEvidence]), {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 1);
  assert.equal(repair.updatedSeason.series[entries[1].id].winsB, 1);
  assert.equal(repair.updatedSeason.series[entries[1].id].gameResults[0].id, 'explicit_tournament_sweet16_game1');
});

test('automatic alignment accepts stripped prior-day result with season-controlled schedule evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  const series = entries[2];
  const stripped = {
    id: 'stripped_scheduled_sweet16_game1',
    matchupId: 'stripped_scheduled_sweet16_game1',
    dateKey: '2026-06-09',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    playerAScore: 55,
    playerBScore: 44,
    winnerId: series.playerAId
  };
  const state = makeState(season, [stripped]);
  state.schedule = [{
    dateKey: '2026-06-09',
    seasonMatchupControl: true,
    matchups: [{
      id: 'stripped_scheduled_sweet16_game1',
      matchupId: 'stripped_scheduled_sweet16_game1',
      seasonId: season.id,
      seriesId: series.id,
      seasonSeriesId: series.id,
      matchupType: 'tournament',
      playerAId: series.playerAId,
      playerBId: series.playerBId
    }]
  }];

  const repair = core.repairCurrentRoundSeriesGameAlignment(state, {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 1);
  assert.equal(repair.updatedSeason.series[series.id].winsA, 1);
  assert.equal(repair.updatedSeason.series[series.id].gameResults[0].seriesId, series.id);
});


test('Season sync accepts stripped prior-day tournament result when schedule day uses date instead of dateKey', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const series = Object.values(season.series)[0];

  const strippedResult = {
    id: 'stripped_sweet16_game1',
    dateKey: '2026-06-09',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    scoreA: 50,
    scoreB: 40
  };

  const state = makeState(season, [strippedResult]);
  state.schedule = [{
    date: '2026-06-09',
    seasonMatchupControl: true,
    matchups: [{
      id: 'scheduled_sweet16_game1',
      dateKey: '2026-06-09',
      seasonId: season.id,
      seriesId: series.id,
      seasonSeriesId: series.id,
      roundId: series.roundId,
      matchupType: 'tournament',
      playerAId: series.playerAId,
      playerBId: series.playerBId
    }]
  }];

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, {
    nowISO: '2026-06-10T12:00:00.000Z'
  });

  assert.equal(synced.changed, true);
  assert.equal(synced.updatedSeason.series[series.id].winsA, 1);
  assert.equal(synced.updatedSeason.series[series.id].winsB, 0);
  assert.equal(synced.updatedSeason.series[series.id].gameResults.length, 1);
});

test('Season sync still ignores stripped same-pair result without season-controlled schedule evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const series = Object.values(season.series)[0];

  const ordinaryResult = {
    id: 'ordinary_same_pair',
    dateKey: '2026-06-09',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    scoreA: 50,
    scoreB: 40
  };

  const state = makeState(season, [ordinaryResult]);

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, {
    nowISO: '2026-06-10T12:00:00.000Z'
  });

  assert.equal(synced.updatedSeason.series[series.id].winsA, 0);
  assert.equal(synced.updatedSeason.series[series.id].winsB, 0);
  assert.equal(synced.updatedSeason.series[series.id].gameResults.length, 0);
});

test('automatic alignment ignores stripped prior-day result without season-controlled evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  const series = entries[2];
  const stripped = {
    id: 'stripped_unscheduled_sweet16_game1',
    matchupId: 'stripped_unscheduled_sweet16_game1',
    dateKey: '2026-06-09',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    playerAScore: 55,
    playerBScore: 44,
    winnerId: series.playerAId
  };

  const repair = core.repairCurrentRoundSeriesGameAlignment(makeState(season, [stripped]), {
    dateKey: '2026-06-10',
    nowISO: '2026-06-10T12:00:00.000Z',
    requireRecordedResultForAlignment: true
  });

  assert.equal(repair.changed, false);
  assert.equal(repair.repairedCount, 0);
  assert.equal(repair.updatedSeason.series[series.id].winsA, 0);
  assert.equal(repair.updatedSeason.series[series.id].gameResults.length, 0);
});

test('current-day tournament result is accepted only when includeCurrentDayResults is true', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  const [series] = Object.values(season.series);
  const currentDayResult = makeResult(series, '2026-06-10', 2, series.playerBId);

  const defaultSync = core.syncCurrentSeasonSeriesFromRecordedResults(makeState(season, [currentDayResult]), {
    nowISO: '2026-06-10T12:00:00.000Z'
  });
  assert.equal(defaultSync.updatedSeason.series[series.id].winsB, 0);
  assert.equal(defaultSync.updatedSeason.series[series.id].gameResults.length, 0);

  const includeSync = core.syncCurrentSeasonSeriesFromRecordedResults(makeState(season, [currentDayResult]), {
    nowISO: '2026-06-10T12:00:00.000Z',
    includeCurrentDayResults: true
  });
  assert.equal(includeSync.updatedSeason.series[series.id].winsB, 1);
  assert.equal(includeSync.updatedSeason.series[series.id].gameResults.length, 1);
});

test('round start inference ignores stripped same-pair daily matchup without season evidence', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const entries = Object.values(season.series);
  const ordinaryDaily = {
    id: 'ordinary_prior_day_for_round_start',
    matchupId: 'ordinary_prior_day_for_round_start',
    dateKey: '2026-06-09',
    playerAId: entries[3].playerAId,
    playerBId: entries[3].playerBId,
    playerAScore: 51,
    playerBScore: 40,
    winnerId: entries[3].playerAId
  };

  const slate = core.buildSeasonDailySlate(makeState(season, [ordinaryDaily]), '2026-06-10', {
    nowISO: '2026-06-10T12:00:00.000Z'
  });

  assert.equal(slate.updatedSeason.meta.roundStartDateKeys.sweet_16, '2026-06-10');
  assert.deepEqual(new Set(slate.tournamentMatchups.map((matchup) => matchup.seriesGameNumber)), new Set([1]));
});

test('daily slate syncs prior-day tournament results before scheduling today', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  const [series] = Object.values(season.series);
  const priorDayResult = makeResult(series, '2026-06-10', 1, series.playerAId);

  const slate = core.buildSeasonDailySlate(makeState(season, [priorDayResult]), '2026-06-11', {
    nowISO: '2026-06-11T12:00:00.000Z'
  });

  assert.equal(slate.updatedSeason.series[series.id].winsA, 1);
  assert.equal(slate.updatedSeason.series[series.id].gameResults.length, 1);
  const matchup = slate.tournamentMatchups.find((row) => row.seriesId === series.id);
  assert.equal(matchup.seriesGameNumber, 2);
});

test('daily slate uses actual series next game instead of round calendar day', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  const [series] = Object.values(season.series);
  series.gameResults = [makeResult(series, '2026-06-09', 1, series.playerAId)];
  series.winsA = 1;

  const slate = core.buildSeasonDailySlate(makeState(season), '2026-06-11', {
    nowISO: '2026-06-11T12:00:00.000Z'
  });

  const matchup = slate.tournamentMatchups.find((row) => row.seriesId === series.id);
  assert.equal(core.getRoundScheduledGameNumberForDate(slate.updatedSeason, 'sweet_16', '2026-06-11'), 3);
  assert.equal(matchup.seriesGameNumber, 2);
  assert.equal(matchup.seasonMatchupLabel, 'Sweet 16, Game 2');
});

test('daily slate does not count current-day live tournament results during normal scheduling', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-11' } } });
  const [series] = Object.values(season.series);
  const currentDayResult = makeResult(series, '2026-06-11', 1, series.playerAId);

  const slate = core.buildSeasonDailySlate(makeState(season, [currentDayResult]), '2026-06-11', {
    nowISO: '2026-06-11T12:00:00.000Z'
  });

  assert.equal(slate.updatedSeason.series[series.id].winsA, 0);
  assert.equal(slate.updatedSeason.series[series.id].gameResults.length, 0);
  const matchup = slate.tournamentMatchups.find((row) => row.seriesId === series.id);
  assert.equal(matchup.seriesGameNumber, 1);
});

test('future stale season-controlled schedule rows rebuild after season sync changes currentSeason', () => {
  const season = makeSeason({ readyCount: 8, status: 'active', meta: { roundStartDateKeys: { sweet_16: '2026-06-09' } } });
  Object.values(season.series).forEach((item, index) => {
    const a = index === 0 ? 'YOU' : `p${index * 2}`;
    const b = `p${index * 2 + 1}`;
    item.playerAId = a;
    item.playerAName = a === 'YOU' ? 'You' : `Player ${index * 2}`;
    item.playerBId = b;
    item.playerBName = `Player ${index * 2 + 1}`;
  });
  const [series] = Object.values(season.series);
  const priorDayResult = makeResult(series, '2026-06-10', 1, series.playerAId);
  const staleFutureMatchup = {
    id: 'stale_future_game3',
    date: '2026-06-12',
    dateKey: '2026-06-12',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    seasonId: season.id,
    seriesId: series.id,
    seasonSeriesId: series.id,
    roundId: 'sweet_16',
    roundName: 'Sweet 16',
    seriesGameNumber: 3,
    matchupType: 'tournament',
    seasonMatchupLabel: 'Sweet 16, Game 3'
  };
  const state = makeState(season, [priorDayResult]);
  state.players = Array.from({ length: 15 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, active: true }));
  state.schedule = [{
    date: '2026-06-12',
    dateKey: '2026-06-12',
    matchups: [staleFutureMatchup],
    byeIds: [],
    participantSignature: 'stale',
    seasonMatchupControl: true,
    seasonScheduleSignature: 'stale-signature'
  }];

  const repaired = core.repairSeasonControlledScheduleFromSyncedSeason(state, {
    todayDateKey: '2026-06-11',
    nowISO: '2026-06-11T12:00:00.000Z'
  });

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.repairedDates, ['2026-06-12']);
  assert.equal(repaired.state.currentSeason.series[series.id].winsA, 1);
  const rebuilt = repaired.state.schedule.find((day) => day.date === '2026-06-12').matchups.find((row) => row.seriesId === series.id);
  assert.equal(rebuilt.seriesGameNumber, 2);
  assert.equal(rebuilt.seasonMatchupLabel, 'Sweet 16, Game 2');
});

test('ordinary same-pair daily matchup cannot become a Season result during scheduling preparation', () => {
  const season = makeSeason({ readyCount: 8, status: 'active' });
  const [series] = Object.values(season.series);
  const ordinaryDaily = {
    id: 'ordinary_same_pair_daily_not_season',
    dateKey: '2026-06-10',
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    scoreA: 60,
    scoreB: 40,
    winnerId: series.playerAId,
    matchupType: 'exhibition'
  };

  const prepared = core.prepareSeasonStateForScheduling(makeState(season, [ordinaryDaily]), '2026-06-11', {
    nowISO: '2026-06-11T12:00:00.000Z'
  });

  assert.equal(prepared.state.currentSeason.series[series.id].winsA, 0);
  assert.equal(prepared.state.currentSeason.series[series.id].gameResults.length, 0);
});
