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

function sweet16Series(overrides = {}) {
  return {
    id: 'sweet_16_miggy_everly',
    seasonId: 'season_1_june_2026',
    roundId: 'sweet_16',
    roundName: 'Sweet 16',
    seriesIndex: 3,
    playerAId: 'YOU',
    playerAName: 'Miggy',
    playerASeed: 4,
    playerBId: 'everly',
    playerBName: 'Everly',
    playerBSeed: 13,
    bestOf: 5,
    winsNeeded: 3,
    winsA: 2,
    winsB: 1,
    status: 'active',
    gameResults: [],
    ...overrides
  };
}

function stateWithSeries(series, matchups = []) {
  return core.normalizeState({
    youName: 'Miggy',
    players: [{ id: 'everly', name: 'Everly' }],
    matchups,
    currentSeason: {
      id: 'season_1_june_2026',
      monthKey: '2026-06',
      status: 'active',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      series: { [series.id]: series }
    }
  });
}


test('Season winner helper maps matchup score fields onto the series participants before choosing winner', () => {
  const series = sweet16Series();
  const winner = core.getSeasonResultWinnerForSeries({
    playerAId: 'everly',
    playerBId: 'YOU',
    scoreA: 45.5,
    scoreB: 55.4,
    winnerId: 'everly'
  }, series);

  assert.equal(winner.winnerId, 'YOU');
  assert.equal(winner.loserId, 'everly');
  assert.equal(winner.playerAScore, 55.4);
  assert.equal(winner.playerBScore, 45.5);
  assert.equal(winner.source, 'scores');
});


test('Season result winner repair treats blank score fields as missing', () => {
  const series = sweet16Series({
    gameResults: [
      { matchupId: 'blank-a', dateKey: '2026-06-09', gameNumber: 1, winnerId: 'YOU', loserId: 'everly', playerAScore: '', playerBScore: '5', source: 'manual' }
    ]
  });

  const repair = core.repairSeasonSeriesResultWinnerIds(stateWithSeries(series), { nowISO: '2026-06-12T12:00:00.000Z' });
  const repairedSeries = repair.state.currentSeason.series[series.id];
  const result = repairedSeries.gameResults[0];

  assert.equal(result.winnerId, 'YOU');
  assert.equal(result.loserId, 'everly');
  assert.equal(repairedSeries.winsA, 1);
  assert.equal(repairedSeries.winsB, 0);
});

test('Season result winner repair treats whitespace score fields as missing', () => {
  const series = sweet16Series({
    gameResults: [
      { matchupId: 'whitespace-a', dateKey: '2026-06-09', gameNumber: 1, winnerId: 'YOU', loserId: 'everly', playerAScore: '   ', playerBScore: '5', source: 'manual' }
    ]
  });

  const repair = core.repairSeasonSeriesResultWinnerIds(stateWithSeries(series), { nowISO: '2026-06-12T12:00:00.000Z' });
  const repairedSeries = repair.state.currentSeason.series[series.id];
  const result = repairedSeries.gameResults[0];

  assert.equal(result.winnerId, 'YOU');
  assert.equal(result.loserId, 'everly');
  assert.equal(repairedSeries.winsA, 1);
  assert.equal(repairedSeries.winsB, 0);
});

test('Season result winner repair still treats real zero scores as valid', () => {
  const series = sweet16Series({
    gameResults: [
      { matchupId: 'zero-a', dateKey: '2026-06-09', gameNumber: 1, winnerId: 'YOU', loserId: 'everly', playerAScore: '0', playerBScore: '5', source: 'manual' }
    ]
  });

  const repair = core.repairSeasonSeriesResultWinnerIds(stateWithSeries(series), { nowISO: '2026-06-12T12:00:00.000Z' });
  const repairedSeries = repair.state.currentSeason.series[series.id];
  const result = repairedSeries.gameResults[0];

  assert.equal(result.winnerId, 'everly');
  assert.equal(result.loserId, 'YOU');
  assert.equal(repairedSeries.winsA, 0);
  assert.equal(repairedSeries.winsB, 1);
});

test('Season result winner helper treats invalid score fields as missing and falls back to winnerId', () => {
  const series = sweet16Series();
  const winner = core.getSeasonResultWinnerForSeries({ winnerId: 'YOU', loserId: 'everly', playerAScore: 'abc', playerBScore: '5' }, series);

  assert.equal(winner.winnerId, 'YOU');
  assert.equal(winner.loserId, 'everly');
  assert.equal(winner.source, 'winnerId');
});

test('Season repair corrects stale winnerId when Sweet 16 scores clearly pick player A', () => {
  const series = sweet16Series({
    gameResults: [
      { matchupId: 'jun9', dateKey: '2026-06-09', gameNumber: 1, winnerId: 'YOU', loserId: 'everly', playerAScore: 55.4, playerBScore: 45.5, source: 'matchup' },
      { matchupId: 'jun10', dateKey: '2026-06-10', gameNumber: 2, winnerId: 'everly', loserId: 'YOU', playerAScore: 70.4, playerBScore: 53.2, source: 'matchup' },
      { matchupId: 'jun11', dateKey: '2026-06-11', gameNumber: 3, winnerId: 'YOU', loserId: 'everly', playerAScore: 60.8, playerBScore: 34.2, source: 'matchup' }
    ]
  });

  const repair = core.repairSeasonSeriesResultWinnerIds(stateWithSeries(series), { nowISO: '2026-06-12T12:00:00.000Z' });
  const repaired = repair.state.currentSeason.series[series.id];

  assert.equal(repair.changed, true);
  assert.equal(repair.repairedCount, 1);
  assert.deepEqual(repair.seriesIds, [series.id]);
  assert.equal(repaired.winsA, 3);
  assert.equal(repaired.winsB, 0);
  assert.equal(repaired.status, 'complete');
  assert.equal(repaired.winnerId, 'YOU');
  assert.equal(repaired.loserId, 'everly');
  assert.equal(repaired.gameResults.find(result => result.matchupId === 'jun10').winnerId, 'YOU');
  assert.equal(repaired.gameResults.find(result => result.matchupId === 'jun10').loserId, 'everly');
  assert.equal(repaired.gameResults.find(result => result.matchupId === 'jun10').playerAScore, 70.4);
  assert.equal(repaired.gameResults.find(result => result.matchupId === 'jun10').playerBScore, 53.2);
});

test('Season winner helper falls back to valid winnerId when scores are missing', () => {
  const series = sweet16Series();
  const winner = core.getSeasonResultWinnerForSeries({ winnerId: 'everly', loserId: 'YOU' }, series);
  assert.equal(winner.winnerId, 'everly');
  assert.equal(winner.loserId, 'YOU');
  assert.equal(winner.source, 'winnerId');

  const recalculated = core.recalculateSeasonSeriesFromGameResults({ ...series, gameResults: [{ winnerId: 'everly', loserId: 'YOU' }] }, { nowISO: '2026-06-12T12:00:00.000Z' });
  assert.equal(recalculated.winsA, 0);
  assert.equal(recalculated.winsB, 1);
});

test('Season winner helper does not invent winner for tied or invalid scores without valid winnerId', () => {
  const series = sweet16Series();
  const tied = core.getSeasonResultWinnerForSeries({ playerAScore: 50, playerBScore: 50 }, series);
  assert.equal(tied.winnerId, '');
  assert.equal(tied.source, 'none');

  const invalid = core.getSeasonResultWinnerForSeries({ playerAScore: 'bad', playerBScore: 51 }, series);
  assert.equal(invalid.winnerId, '');
  assert.equal(invalid.source, 'none');

  const recalculated = core.recalculateSeasonSeriesFromGameResults({ ...series, gameResults: [{ playerAScore: 50, playerBScore: 50 }] }, { nowISO: '2026-06-12T12:00:00.000Z' });
  assert.equal(recalculated.winsA, 0);
  assert.equal(recalculated.winsB, 0);
  assert.equal(recalculated.status, 'active');
});

test('Season winner repair leaves H2H/log matchup records unchanged', () => {
  const series = sweet16Series({
    gameResults: [
      { matchupId: 'jun10', dateKey: '2026-06-10', gameNumber: 2, winnerId: 'everly', loserId: 'YOU', playerAScore: 70.4, playerBScore: 53.2, source: 'matchup' }
    ]
  });
  const matchups = [
    { id: 'jun10', dateKey: '2026-06-10', matchupType: 'tournament', seriesId: series.id, playerAId: 'YOU', playerBId: 'everly', winnerId: 'everly', loserId: 'YOU', playerAScore: 70.4, playerBScore: 53.2 }
  ];
  const state = stateWithSeries(series, matchups);
  const repair = core.repairSeasonSeriesResultWinnerIds(state, { nowISO: '2026-06-12T12:00:00.000Z' });

  assert.deepEqual(repair.state.matchups, state.matchups);
});

test('Season sync counts completed prior-day results but skips current-day results by default', () => {
  const series = sweet16Series({ winsA: 0, winsB: 0, gameResults: [] });
  const matchups = [
    { id: 'jun11', dateKey: '2026-06-11', matchupType: 'tournament', seasonId: 'season_1_june_2026', seriesId: series.id, seasonSeriesId: series.id, playerAId: 'YOU', playerBId: 'everly', winnerId: 'YOU', loserId: 'everly', playerAScore: 60.8, playerBScore: 34.2 },
    { id: 'jun12', dateKey: '2026-06-12', matchupType: 'tournament', seasonId: 'season_1_june_2026', seriesId: series.id, seasonSeriesId: series.id, playerAId: 'YOU', playerBId: 'everly', winnerId: 'YOU', loserId: 'everly', playerAScore: 88.1, playerBScore: 70.2 }
  ];

  const sync = core.syncCurrentSeasonSeriesFromRecordedResults(stateWithSeries(series, matchups), { nowISO: '2026-06-12T12:00:00.000Z' });
  const synced = sync.state.currentSeason.series[series.id];

  assert.equal(synced.winsA, 1);
  assert.equal(synced.winsB, 0);
  assert.equal(synced.gameResults.length, 1);
  assert.equal(synced.gameResults[0].matchupId, 'jun11');
});
