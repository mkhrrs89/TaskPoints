const test = require('node:test');

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
const builder = require('../season_bracket_builder_core.js');
require('../season_bracket_builder_fixes.js');
require('../season_matchup_materialization_guard.js');
const recovery = require('../season2_missed_playin_recovery.js');
const core = global.TaskPointsCore;

function seeds() {
  return Array.from({ length: 60 }, (_, index) => {
    const seed = index + 1;
    return { seed, playerId: seed === 21 ? 'YOU' : `P${seed}`, playerName: seed === 21 ? 'Miggy' : `Player ${seed}`, name: seed === 21 ? 'Miggy' : `Player ${seed}` };
  });
}

function state() {
  const seedRows = seeds();
  const preview = {
    youName: 'Miggy',
    players: seedRows.map((seed) => ({ id: seed.playerId, name: seed.playerName, active: true })),
    tasks: [], habits: [], completions: [], matchups: [], gameHistory: [], schedule: [], flexActions: [], opponentDripSchedules: [],
    currentSeason: {
      id: 'season_2_august_2026', name: 'Season 2', label: 'August 2026 TaskPoints Championship', monthKey: '2026-08',
      startDate: '2026-08-01', endDate: '2026-08-31', startDateKey: '2026-08-01', endDateKey: '2026-08-31', status: 'preview', seedMode: 'manual',
      seeds: seedRows, playerPool: seedRows.map((seed) => ({ id: seed.playerId, name: seed.playerName })), bracket: {}, series: {}, meta: { seasonMatchupControlEnabled: false }
    }
  };
  const locked = builder.lockConfiguredSeasonBracket(preview, builder.createSeasonTwoPreset(), { nowISO: '2026-08-01T04:53:56.665Z' });
  const season = { ...locked.season, status: 'locked', meta: { ...(locked.season.meta || {}), seasonMatchupControlEnabled: false } };
  const seedMap = new Map(seedRows.map((seed) => [seed.playerId, seed.seed]));
  const gameHistory = Object.values(season.series).filter((series) => series.roundId === 'play_in').flatMap((series) => [series.playerAId, series.playerBId]).map((playerId) => ({
    id: `history-${playerId}`, date: '2026-08-01', dateKey: '2026-08-01', playerId, score: 100 - seedMap.get(playerId)
  }));
  const ids = seedRows.map((seed) => seed.playerId);
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `ordinary-${index + 1}`, date: '2026-08-02', dateKey: '2026-08-02', playerAId: ids[index * 2], playerBId: ids[index * 2 + 1] }));
  return core.normalizeState({ ...locked.state, currentSeason: season, gameHistory, matchups: rows, schedule: [{ date: '2026-08-02', dateKey: '2026-08-02', matchups: rows }] });
}

test('print generated tournament round IDs', () => {
  const result = recovery.repairMissedPlayIn(state(), { effectiveDateKey: '2026-08-02', nowISO: '2026-08-02T12:20:00.000Z' });
  const day = result.state.schedule.find((entry) => (entry.dateKey || entry.date) === '2026-08-02');
  const tournamentRows = (day?.matchups || []).filter((row) => row.matchupType === 'tournament');
  console.log('ROUND DIAGNOSTIC', tournamentRows.map((row) => ({ id: row.id, roundId: row.roundId, roundName: row.roundName, gameNumber: row.seriesGameNumber })));
});
