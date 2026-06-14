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

function qfSeries(index, overrides = {}) {
  return {
    id: `season_1_june_2026_quarterfinals_${index}`,
    seasonId: 'season_1_june_2026',
    roundId: 'quarterfinals',
    roundName: 'Quarterfinals',
    roundIndex: 4,
    seriesIndex: index,
    bestOf: 5,
    winsNeeded: 3,
    status: 'active',
    playerAId: `p${index}a`,
    playerAName: `QF ${index}A`,
    playerBId: `p${index}b`,
    playerBName: `QF ${index}B`,
    winsA: 0,
    winsB: 0,
    winnerId: '',
    loserId: '',
    gameResults: [],
    ...overrides
  };
}

function makeState(matchups = []) {
  const userSeries = qfSeries(3, {
    playerAId: 'YOU',
    playerAName: 'Miggy',
    playerBId: 'VERRICK',
    playerBName: 'Verrick'
  });
  const series = {
    qf1: qfSeries(1),
    qf2: qfSeries(2),
    [userSeries.id]: userSeries,
    qf4: qfSeries(4)
  };
  const ids = ['YOU', 'VERRICK', 'REYNOLDS', 'p1a', 'p1b', 'p2a', 'p2b', 'p4a', 'p4b'];
  return {
    currentSeason: {
      id: 'season_1_june_2026',
      monthKey: '2026-06',
      status: 'active',
      meta: { seasonMatchupControlEnabled: true, roundStartDateKeys: { quarterfinals: '2026-06-14' } },
      series
    },
    players: ids.map((id) => ({ id, name: id === 'YOU' ? 'Miggy' : id === 'VERRICK' ? 'Verrick' : id, active: true, baseline: 40, variance: 5 })),
    matchups,
    schedule: [{ date: '2026-06-14', dateKey: '2026-06-14', matchups }],
    completions: [],
    tasks: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    opponentDripSchedules: []
  };
}

function staleExhibition() {
  return {
    id: '2026-06-14_exhibition_YOU_REYNOLDS',
    date: '2026-06-14',
    dateKey: '2026-06-14',
    playerAId: 'YOU',
    playerBId: 'REYNOLDS',
    matchupType: 'exhibition'
  };
}

test('materialization upserts tournament row and removes stale same-day user exhibition', () => {
  const result = core.materializeSeasonSlateMatchupsForDate(makeState([staleExhibition()]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  assert.equal(result.changed, true);
  assert.equal(result.removedExhibitionCount, 1);
  const chosen = core.chooseUserMatchupForDate(result.state, '2026-06-14');
  assert.equal(chosen.playerAId, 'YOU');
  assert.equal(chosen.playerBId, 'VERRICK');
  assert.equal(chosen.matchupType, 'tournament');
  assert.equal(result.state.matchups.some((m) => m.playerBId === 'REYNOLDS'), false);
  assert.equal(result.state.schedule[0].matchups.some((m) => m.playerBId === 'REYNOLDS'), false);
});

test('GameHub chooser path resolves the same materialized tournament matchup', () => {
  const result = core.materializeSeasonSlateMatchupsForDate(makeState([staleExhibition()]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const gameHubChoice = core.chooseUserMatchupForDate(result.state, '2026-06-14', 'YOU');
  assert.equal(gameHubChoice.playerBId, 'VERRICK');
});

test('opponent drip schedule generator creates ordered numeric events that sum to expected total', () => {
  const result = core.materializeSeasonSlateMatchupsForDate(makeState([staleExhibition()]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const chosen = core.chooseUserMatchupForDate(result.state, '2026-06-14');
  const schedule = core.generateOpponentDripScheduleCore(42.7, '2026-06-14', { playerId: chosen.playerBId });
  assert.equal(schedule.playerId, 'VERRICK');
  assert.equal(schedule.total, 42.7);
  assert.ok(schedule.events.length > 0);
  const times = schedule.events.map((e) => new Date(e.t).getTime());
  assert.deepEqual(times, times.slice().sort((a, b) => a - b));
  const sum = schedule.events.reduce((total, event) => total + Number(event.pts), 0);
  assert.equal(Math.round(sum * 10) / 10, 42.7);
});

test('existing same-day scored tournament row preserves scores during materialization', () => {
  const existing = {
    id: '2026-06-14_season_1_june_2026_quarterfinals_3_g1',
    date: '2026-06-14',
    dateKey: '2026-06-14',
    playerAId: 'YOU',
    playerBId: 'VERRICK',
    seriesId: 'season_1_june_2026_quarterfinals_3',
    matchupType: 'tournament',
    scoreA: 12.3,
    scoreB: 45.6,
    result: 'you-loss'
  };
  const result = core.materializeSeasonSlateMatchupsForDate(makeState([existing]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const chosen = core.chooseUserMatchupForDate(result.state, '2026-06-14');
  assert.equal(chosen.scoreA, 12.3);
  assert.equal(chosen.scoreB, 45.6);
  assert.equal(chosen.result, 'you-loss');
  assert.equal(chosen.roundName, 'Quarterfinals');
});

test('current-day materialization does not add gameResults or change series wins', () => {
  const state = makeState([staleExhibition()]);
  const before = state.currentSeason.series.season_1_june_2026_quarterfinals_3;
  assert.equal(before.winsA, 0);
  assert.equal(before.winsB, 0);
  assert.equal(before.gameResults.length, 0);
  const result = core.materializeSeasonSlateMatchupsForDate(state, '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const after = result.state.currentSeason.series.season_1_june_2026_quarterfinals_3;
  assert.equal(after.winsA, 0);
  assert.equal(after.winsB, 0);
  assert.equal(after.gameResults.length, 0);
});

function makeFullQfState(extraMatchups = [], overrides = {}) {
  const series = [1, 2, 3, 4].map((i) => qfSeries(i, i === 4 ? {
    playerAId: 'SLOANE', playerAName: 'Sloane', playerBId: 'COOPER', playerBName: 'Cooper'
  } : {}));
  const tournamentIds = series.flatMap((s) => [s.playerAId, s.playerBId]);
  const exhibitionIds = Array.from({ length: 25 }, (_, i) => `EX${i + 1}`);
  const historicalIds = ['EVENCHIK'];
  return {
    currentSeason: {
      id: 'season_1_june_2026',
      monthKey: '2026-06',
      status: 'active',
      meta: { seasonMatchupControlEnabled: true, roundStartDateKeys: { quarterfinals: '2026-06-14' } },
      series: Object.fromEntries(series.map((s) => [s.id, { ...s, ...(overrides.series?.[s.id] || {}) }]))
    },
    players: tournamentIds.concat(exhibitionIds, historicalIds).map((id) => ({ id, name: id, active: !historicalIds.includes(id), baseline: 40, variance: 5 })),
    matchups: extraMatchups,
    schedule: [{ date: '2026-06-14', dateKey: '2026-06-14', seasonMatchupControl: true, matchups: extraMatchups }],
    completions: [], tasks: [], habits: [], flexActions: [], gameHistory: [], opponentDripSchedules: []
  };
}

test('materialization removes stale same-day prior-round season-looking row when unreferenced', () => {
  const stale = { id: '2026-06-14_season_1_june_2026_sweet_16_7_g5', dateKey: '2026-06-14', playerAId: 'SLOANE', playerBId: 'EVENCHIK', scoreA: 63.8, scoreB: 76.1 };
  const result = core.materializeSeasonSlateMatchupsForDate(makeFullQfState([stale]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  assert.equal(result.state.matchups.some((m) => m.id === stale.id), false);
  assert.equal(result.removedStaleSeasonCount, 1);
});

test('materialization preserves same-day season-looking row referenced by current season results', () => {
  const stale = { id: '2026-06-14_season_1_june_2026_sweet_16_7_g5', dateKey: '2026-06-14', playerAId: 'SLOANE', playerBId: 'EVENCHIK', scoreA: 63.8, scoreB: 76.1 };
  const state = makeFullQfState([stale], { series: { season_1_june_2026_quarterfinals_4: { gameResults: [{ matchupId: stale.id, winnerId: 'EVENCHIK' }] } } });
  const result = core.materializeSeasonSlateMatchupsForDate(state, '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  assert.equal(result.state.matchups.some((m) => m.id === stale.id), true);
});

test('materialization removes same-day exhibition rows containing current tournament players', () => {
  const exhibition = { id: 'bad_ex', dateKey: '2026-06-14', playerAId: 'SLOANE', playerBId: 'EX1', matchupType: 'exhibition' };
  const result = core.materializeSeasonSlateMatchupsForDate(makeFullQfState([exhibition]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  assert.equal(result.state.matchups.some((m) => m.id === exhibition.id), false);
  assert.equal(result.removedExhibitionCount, 1);
});

test('materialization fills NPC-vs-NPC scores and preserves existing finite scores', () => {
  const existing = { id: '2026-06-14_season_1_june_2026_quarterfinals_1_g1', dateKey: '2026-06-14', seriesId: 'season_1_june_2026_quarterfinals_1', playerAId: 'p1a', playerBId: 'p1b', matchupType: 'tournament', scoreA: 12, scoreB: 13 };
  const result = core.materializeSeasonSlateMatchupsForDate(makeFullQfState([existing]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const qf1 = result.state.matchups.find((m) => m.id === existing.id);
  const qf2 = result.state.matchups.find((m) => m.id === '2026-06-14_season_1_june_2026_quarterfinals_2_g1');
  assert.equal(qf1.scoreA, 12);
  assert.equal(qf1.scoreB, 13);
  assert.equal(Number.isFinite(Number(qf2.scoreA)), true);
  assert.equal(Number.isFinite(Number(qf2.scoreB)), true);
});

test('repairSeasonControlledScheduleFromSyncedSeason repairs today despite scored stale rows', () => {
  const stale = { id: '2026-06-14_season_1_june_2026_sweet_16_7_g5', dateKey: '2026-06-14', playerAId: 'SLOANE', playerBId: 'EVENCHIK', scoreA: 63.8, scoreB: 76.1 };
  const current = { id: '2026-06-14_season_1_june_2026_quarterfinals_4_g1', dateKey: '2026-06-14', seriesId: 'season_1_june_2026_quarterfinals_4', playerAId: 'SLOANE', playerBId: 'COOPER', matchupType: 'tournament', scoreA: 77, scoreB: 66 };
  const result = core.repairSeasonControlledScheduleFromSyncedSeason(makeFullQfState([stale, current]), { todayDateKey: '2026-06-14', nowISO: '2026-06-14T12:00:00.000Z' });
  const qf4 = result.state.matchups.find((m) => m.id === current.id);
  assert.equal(result.state.matchups.some((m) => m.id === stale.id), false);
  assert.equal(qf4.scoreA, 77);
  assert.equal(qf4.scoreB, 66);
});

test('real same-day bug fixture materializes 17 rows without duplicate players or stale Sweet 16 row', () => {
  const stale = { id: '2026-06-14_season_1_june_2026_sweet_16_7_g5', dateKey: '2026-06-14', playerAId: 'SLOANE', playerBId: 'EVENCHIK', scoreA: 63.8, scoreB: 76.1 };
  const result = core.materializeSeasonSlateMatchupsForDate(makeFullQfState([stale]), '2026-06-14', { nowISO: '2026-06-14T12:00:00.000Z' });
  const sameDay = result.state.matchups.filter((m) => m.dateKey === '2026-06-14');
  const players = sameDay.flatMap((m) => [m.playerAId, m.playerBId]);
  assert.equal(result.state.schedule.find((day) => day.dateKey === '2026-06-14').matchups.length, 17);
  const scheduledIds = new Set(result.state.schedule.find((day) => day.dateKey === '2026-06-14').matchups.map((m) => m.id));
  assert.equal(sameDay.filter((m) => scheduledIds.has(m.id)).length, 17);
  assert.equal(new Set(players).size, players.length);
  assert.equal(sameDay.some((m) => m.id === stale.id), false);
  ['2026-06-14_season_1_june_2026_quarterfinals_1_g1', '2026-06-14_season_1_june_2026_quarterfinals_2_g1', '2026-06-14_season_1_june_2026_quarterfinals_4_g1'].forEach((id) => {
    const row = sameDay.find((m) => m.id === id);
    assert.equal(Number.isFinite(Number(row?.scoreA)), true);
    assert.equal(Number.isFinite(Number(row?.scoreB)), true);
  });
  });
