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

function makeQuarterfinalSeries(index, overrides = {}) {
  const playerAId = `P${index * 2 + 1}`;
  const playerBId = `P${index * 2 + 2}`;
  return {
    id: `season_1_june_2026_quarterfinals_${index + 1}`,
    seasonId: 'season_1_june_2026',
    roundId: 'quarterfinals',
    roundName: 'Quarterfinals',
    roundIndex: 3,
    seriesIndex: index,
    bestOf: 5,
    winsNeeded: 3,
    status: 'active',
    playerAId,
    playerAName: playerAId,
    playerBId,
    playerBName: playerBId,
    winsA: 0,
    winsB: 0,
    winnerId: '',
    loserId: '',
    gameResults: [],
    ...overrides
  };
}

function makeQuarterfinalState(matchups = []) {
  const seriesRows = [
    makeQuarterfinalSeries(0, {
      id: 'season_1_june_2026_quarterfinals_2_7',
      playerAId: 'VERRICK',
      playerAName: 'Verrick',
      playerBId: 'YOU',
      playerBName: 'Miggy',
      playerASeed: 2,
      playerBSeed: 7
    }),
    makeQuarterfinalSeries(1),
    makeQuarterfinalSeries(2),
    makeQuarterfinalSeries(3)
  ];
  return core.normalizeState({
    youName: 'Miggy',
    currentSeason: {
      id: 'season_1_june_2026',
      monthKey: '2026-06',
      status: 'active',
      meta: {
        seasonMatchupControlEnabled: true,
        roundStartDateKeys: { quarterfinals: '2026-06-14' }
      },
      series: Object.fromEntries(seriesRows.map((series) => [series.id, series]))
    },
    players: [
      { id: 'VERRICK', name: 'Verrick', active: true },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `P${index + 3}`, name: `Player ${index + 3}`, active: true }))
    ],
    matchups,
    schedule: [],
    completions: [],
    tasks: []
  });
}

function getHomeCandidatesFromSeasonSlate(state, dateKeyStr) {
  const slate = core.buildSeasonDailySlate(state, dateKeyStr, {
    nowISO: `${dateKeyStr}T12:00:00.000Z`
  });
  const todaySeasonMatchups = (Array.isArray(slate.tournamentMatchups) ? slate.tournamentMatchups : [])
    .map((matchup) => ({
      ...matchup,
      date: matchup.date || dateKeyStr,
      dateKey: matchup.dateKey || dateKeyStr
    }));
  const userHasSeasonMatchupToday = todaySeasonMatchups.some((matchup) =>
    matchup && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU')
  );
  const filteredStored = userHasSeasonMatchupToday
    ? (state.matchups || []).filter((matchup) => {
        const type = String(matchup?.matchupType || '').toLowerCase();
        const isUserRow = matchup?.playerAId === 'YOU' || matchup?.playerBId === 'YOU';
        const matchupKey = matchup?.date || matchup?.dateKey || (matchup?.dateISO ? core.dateKey(matchup.dateISO) : '');
        return !(type === 'exhibition' && isUserRow && matchupKey === dateKeyStr);
      })
    : (state.matchups || []);
  return todaySeasonMatchups.concat(filteredStored);
}

test('Home matchup candidates prefer active Season slate over stored stale exhibition', () => {
  const state = makeQuarterfinalState([
    { id: 'exhibition_reynolds', dateKey: '2026-06-14', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'REYNOLDS' }
  ]);

  const chosen = chooseHomeUserMatchupForDate(getHomeCandidatesFromSeasonSlate(state, '2026-06-14'), '2026-06-14');
  assert.ok(chosen, 'expected Home to find a user matchup');
  assert.equal(chosen.matchupType, 'tournament');
  assert.equal(chosen.playerAId, 'VERRICK');
  assert.equal(chosen.playerBId, 'YOU');
  assert.equal(chosen.dateKey, '2026-06-14');
});

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

test('Home candidate repair preserves scored same-day stored rows while selecting slate tournament', () => {
  const scoredStoredRow = {
    id: 'scored_tournament',
    dateKey: '2026-06-14',
    matchupType: 'tournament',
    seriesId: 'season_1_june_2026_quarterfinals_2_7',
    playerAId: 'VERRICK',
    playerBId: 'YOU',
    scoreA: 80,
    scoreB: 75
  };
  const state = makeQuarterfinalState([scoredStoredRow]);

  const candidates = getHomeCandidatesFromSeasonSlate(state, '2026-06-14');
  assert.equal(state.matchups[0], scoredStoredRow);
  assert.equal(state.matchups[0].scoreA, 80);
  assert.equal(state.matchups[0].scoreB, 75);

  const chosen = chooseHomeUserMatchupForDate(candidates, '2026-06-14');
  assert.equal(chosen.matchupType, 'tournament');
  assert.equal(chosen.playerAId, 'VERRICK');
  assert.equal(chosen.playerBId, 'YOU');
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

test('Home render materializes Season slate before choosing stored matchup row', () => {
  const fs = require('node:fs');
  const indexHtml = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(indexHtml, /function getTodaySeasonMatchupsForHome\(todayKeyStr\)/);
  assert.match(indexHtml, /TaskPointsCore\.buildSeasonDailySlate\(state, todayKeyStr, \{\s*nowISO: `\$\{todayKeyStr\}T12:00:00\.000Z`/);
  assert.match(indexHtml, /function getHomeUserMatchupCandidatesForDate\(storedMatchups, todayKeyStr\)/);
  assert.match(indexHtml, /todaySeasonMatchups\.concat\(filteredStoredMatchups\)/);
  assert.match(indexHtml, /TaskPointsCore\.materializeSeasonSlateMatchupsForDate\(state, todayKeyStr, \{/);
  assert.match(indexHtml, /if \(materialized\?\.changed\) save\(\);/);
  assert.match(indexHtml, /TaskPointsCore\.chooseUserMatchupForDate\(state, todayKeyStr, 'YOU'\)/);
});
