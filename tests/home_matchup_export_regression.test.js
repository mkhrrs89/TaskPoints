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

function homePriority(matchup) {
  const type = String(matchup?.matchupType || '').toLowerCase();
  if (type === 'tournament' || type === 'season') return 0;
  if (type === 'exhibition') return 2;
  return 1;
}

function chooseHomeUserMatchupForDate(matchups, dateKeyStr) {
  return (Array.isArray(matchups) ? matchups : [])
    .filter((matchup) => {
      const matchupKey = matchup?.date || matchup?.dateKey || (matchup?.dateISO ? core.dateKey(matchup.dateISO) : '');
      return matchupKey === dateKeyStr && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU');
    })
    .sort((a, b) => {
      const byPriority = homePriority(a) - homePriority(b);
      if (byPriority !== 0) return byPriority;
      const aHasSeries = Boolean(a.seriesId || a.seasonSeriesId);
      const bHasSeries = Boolean(b.seriesId || b.seasonSeriesId);
      if (aHasSeries !== bHasSeries) return aHasSeries ? -1 : 1;
      return String(a.id || a.matchupId || '').localeCompare(String(b.id || b.matchupId || ''));
    })[0] || null;
}

test('Home matchup selection chooses same-day tournament over stale exhibition', () => {
  const matchups = [
    { id: 'exhibition_reynolds', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' },
    { id: 'qf_game_1', dateKey: '2026-06-14', matchupType: 'tournament', seriesId: 'qf_2_7', playerAId: 'VERRICK', playerBId: 'YOU' }
  ];

  const chosen = chooseHomeUserMatchupForDate(matchups, '2026-06-14');
  assert.equal(chosen.id, 'qf_game_1');
  assert.equal(chosen.playerAId, 'VERRICK');
});

test('Home matchup selection still chooses exhibition when it is the only user matchup', () => {
  const matchups = [
    { id: 'exhibition_reynolds', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' }
  ];

  const chosen = chooseHomeUserMatchupForDate(matchups, '2026-06-14');
  assert.equal(chosen.id, 'exhibition_reynolds');
});

test('schedule repair removes same-day exhibitions for tournament participants', () => {
  const state = {
    players: [], tasks: [], completions: [],
    matchups: [
      { id: 'qf_game_1', dateKey: '2026-06-14', matchupType: 'tournament', seriesId: 'qf_2_7', playerAId: 'VERRICK', playerBId: 'YOU' },
      { id: 'stale_exhibition', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' },
      { id: 'valid_exhibition', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'ALPHA', playerBId: 'BRAVO' },
      { id: 'past_exhibition', dateKey: '2026-06-13', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' }
    ],
    schedule: [{
      date: '2026-06-14',
      dateKey: '2026-06-14',
      matchups: [
        { id: 'qf_game_1', matchupType: 'tournament', seriesId: 'qf_2_7', playerAId: 'VERRICK', playerBId: 'YOU' },
        { id: 'stale_exhibition', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' },
        { id: 'valid_exhibition', matchupType: 'exhibition', playerAId: 'ALPHA', playerBId: 'BRAVO' }
      ]
    }]
  };

  const repaired = core.removeInvalidExhibitionsForTournamentParticipants(state, '2026-06-14');
  assert.equal(repaired.changed, true);
  assert.equal(repaired.state.matchups.some((m) => m.id === 'stale_exhibition'), false);
  assert.equal(repaired.state.matchups.some((m) => m.id === 'valid_exhibition'), true);
  assert.equal(repaired.state.matchups.some((m) => m.id === 'past_exhibition'), true);
  assert.equal(repaired.state.schedule[0].matchups.some((m) => m.id === 'stale_exhibition'), false);
});

test('audit flags tournament participant exhibition overlap today', () => {
  const result = core.auditTodayScheduleVsMatchups({
    matchups: [
      { id: 'qf_game_1', dateKey: '2026-06-14', matchupType: 'tournament', playerAId: 'VERRICK', playerBId: 'YOU' },
      { id: 'stale_exhibition', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' }
    ],
    schedule: [{ date: '2026-06-14', dateKey: '2026-06-14', matchups: [] }]
  }, { todayKey: '2026-06-14' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.tournamentExhibitionOverlaps, [{ playerAId: 'YOU', playerBId: 'REYNOLDS', matchupId: 'stale_exhibition' }]);
});

test('schedule-only cleanup carries parent dateKey onto undated child matchups', () => {
  const state = {
    players: [], tasks: [], completions: [], matchups: [],
    schedule: [{
      date: '2026-06-14',
      dateKey: '2026-06-14',
      matchups: [
        { id: 'qf_game_1', matchupType: 'tournament', playerAId: 'VERRICK', playerBId: 'YOU' },
        { id: 'stale_exhibition', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' },
        { id: 'valid_exhibition', matchupType: 'exhibition', playerAId: 'ALPHA', playerBId: 'BRAVO' }
      ]
    }]
  };

  const repaired = core.removeInvalidExhibitionsForTournamentParticipants(state, '2026-06-14');
  assert.equal(repaired.changed, true);
  assert.equal(repaired.state.schedule[0].matchups.some((m) => m.id === 'qf_game_1'), true);
  assert.equal(repaired.state.schedule[0].matchups.some((m) => m.id === 'stale_exhibition'), false);
  assert.equal(repaired.state.schedule[0].matchups.some((m) => m.id === 'valid_exhibition'), true);
});

test('Home ensureUpcomingSchedule freezes scored same-day stored rows before rebuild branch', () => {
  const fs = require('node:fs');
  const indexHtml = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(indexHtml, /function hasRecordedMatchupScore\(matchup\)/);
  const todayBlockStart = indexHtml.indexOf('const hasScoredStoredToday = Array.isArray(todaysStoredMatchups)');
  const freezeBranch = indexHtml.indexOf('hasScoredStoredToday) {', todayBlockStart);
  const rebuildBranch = indexHtml.indexOf('if (seasonControlApplies && !existingSeasonControlledValid)', todayBlockStart);
  assert.notEqual(todayBlockStart, -1);
  assert.notEqual(freezeBranch, -1);
  assert.notEqual(rebuildBranch, -1);
  assert.ok(freezeBranch < rebuildBranch);
});
