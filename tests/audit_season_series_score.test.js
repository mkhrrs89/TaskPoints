const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadScoreAuditHelper() {
  const auditHtml = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  const functionNames = [
    'getSeriesDisplayNameForAudit',
    'getSeriesPlayerIdsForAudit',
    'getAuditPairKey',
    'getTodayGameDayKeyForAudit',
    'getSeasonSeriesListForAudit',
    'countSeriesResultsForAudit',
    'getAuditDateKeyForSeasonSeriesScores',
    'getSeasonRoundStartDateForAudit',
    'getSeasonRoundEndDateForAudit',
    'isSeasonSeriesStartedStatusForAudit',
    'isSeasonSeriesFutureStatusForAudit',
    'isMatchupLinkedToSeasonSeriesForAudit',
    'getSeasonSeriesLinkedMatchupsForAudit',
    'isSeasonSeriesCompletedStatusForAudit',
    'getSeasonSeriesRoundOrderIndexForAudit',
    'getLatestSeasonScheduledOrRecordedRoundIndexForAudit',
    'getSeasonSeriesScoreCheckabilityForAudit',
    'buildSeasonSeriesScoreAuditForAudit'
  ];
  const context = {
    TaskPointsCore: {
      todayKey: () => '2026-06-08',
      dateKey: (value) => String(value).slice(0, 10),
      getSeasonDateWindows: () => [
        { id: 'play_in', startDate: '2026-06-01', endDate: '2026-06-03' },
        { id: 'round_of_32', startDate: '2026-06-04', endDate: '2026-06-08' },
        { id: 'sweet_16', startDate: '2026-06-09', endDate: '2026-06-13' },
        { id: 'quarterfinals', startDate: '2026-06-14', endDate: '2026-06-18' },
        { id: 'semifinals', startDate: '2026-06-19', endDate: '2026-06-23' },
        { id: 'finals', startDate: '2026-06-24', endDate: '2026-06-30' }
      ]
    },
    matchupDateKey: (matchup) => matchup?.dateKey || matchup?.date || ''
  };
  context.window = context;
  vm.createContext(context);
  const source = functionNames.map((name) => extractFunction(auditHtml, name)).join('\n');
  vm.runInContext(`${source}; this.buildSeasonSeriesScoreAuditForAudit = buildSeasonSeriesScoreAuditForAudit;`, context);
  return context.buildSeasonSeriesScoreAuditForAudit;
}

function gameResult(series, winnerId, index) {
  return {
    id: `${series.id}_game_${index}`,
    matchupId: `${series.id}_game_${index}`,
    seriesId: series.id,
    seasonSeriesId: series.id,
    dateKey: '2026-06-08',
    gameNumber: index,
    winnerId
  };
}

function linkedMatchup(series, dateKey, extra = {}) {
  return {
    id: `${series.id}_${dateKey}`,
    seasonSeriesId: series.id,
    seriesId: series.id,
    matchupType: 'tournament',
    dateKey,
    playerAId: series.playerAId,
    playerBId: series.playerBId,
    ...extra
  };
}

function series(overrides = {}) {
  return {
    id: 'series_1',
    name: 'Series 1',
    roundId: 'round_of_32',
    playerAId: 'player_a',
    playerBId: 'player_b',
    winsA: 0,
    winsB: 0,
    status: 'pending',
    gameResults: [],
    ...overrides
  };
}

function futureSeries(roundId, index) {
  return series({
    id: `${roundId}_${index}`,
    name: `${roundId} ${index}`,
    roundId,
    playerAId: '',
    playerBId: '',
    placeholderA: `Winner of prior ${index}A`,
    placeholderB: `Winner of prior ${index}B`,
    winsA: 0,
    winsB: 0,
    status: 'pending',
    gameResults: []
  });
}

test('future bracket series do not create a warning', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const future = [
    ...Array.from({ length: 8 }, (_, index) => futureSeries('sweet_16', index + 1)),
    ...Array.from({ length: 4 }, (_, index) => futureSeries('quarterfinals', index + 1)),
    ...Array.from({ length: 2 }, (_, index) => futureSeries('semifinals', index + 1)),
    futureSeries('finals', 1)
  ];

  const result = buildScoreAudit({ matchups: [] }, { id: 'season_1_june_2026' }, future, '2026-06-08');

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.ok(result.details.includes('15 future unplayed series skipped'));
});

test('filled active quarterfinal series without scheduled games are skipped as future unplayed', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const sweet16 = series({
    id: 'sweet_16_1',
    name: 'Sweet 16 1',
    roundId: 'sweet_16',
    status: 'complete',
    winsA: 2,
    winsB: 0
  });
  sweet16.gameResults = [
    gameResult(sweet16, sweet16.playerAId, 1),
    gameResult(sweet16, sweet16.playerAId, 2)
  ];
  const quarterfinals = [
    series({ id: 'season_1_june_2026_quarterfinals_1', name: 'Lily vs Lyria', roundId: 'quarterfinals', playerAId: 'lily', playerBId: 'lyria', status: 'active' }),
    series({ id: 'season_1_june_2026_quarterfinals_2', name: 'Poppy vs Seraphine', roundId: 'quarterfinals', playerAId: 'poppy', playerBId: 'seraphine', status: 'active' }),
    series({ id: 'season_1_june_2026_quarterfinals_3', name: 'Verrick vs YOU/Miggy', roundId: 'quarterfinals', playerAId: 'verrick', playerBId: 'you_miggy', status: 'active' })
  ];

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(sweet16, '2026-06-10')] },
    { id: 'season_1_june_2026', series: { [sweet16.id]: sweet16, ...Object.fromEntries(quarterfinals.map(item => [item.id, item])) } },
    [sweet16, ...quarterfinals],
    '2026-06-12'
  );

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.ok(result.details.includes('3 future unplayed series skipped'));
});

test('real mismatch still fails', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const started = series({ winsA: 2, winsB: 0, status: 'complete' });
  started.gameResults = [gameResult(started, started.playerAId, 1), gameResult(started, started.playerBId, 2)];

  const result = buildScoreAudit({ matchups: [] }, { id: 'season_1_june_2026' }, [started], '2026-06-08');

  assert.equal(result.status, 'FAIL');
  assert.equal(result.actual, '1 mismatch(es)');
  assert.match(result.details[0], /expected 1–1 from results, stored 2–0/);
});

test('active series with matching results passes', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const active = series({ winsA: 2, winsB: 1, status: 'active' });
  active.gameResults = [
    gameResult(active, active.playerAId, 1),
    gameResult(active, active.playerBId, 2),
    gameResult(active, active.playerAId, 3)
  ];

  const result = buildScoreAudit({ matchups: [] }, { id: 'season_1_june_2026' }, [active], '2026-06-08');

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.equal(result.details.length, 0);
});

test('unplayed current/future placeholder series remains skipped', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const placeholder = futureSeries('sweet_16', 1);

  const result = buildScoreAudit({ matchups: [] }, { id: 'season_1_june_2026' }, [placeholder], '2026-06-08');

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.ok(result.details.includes('1 future unplayed series skipped'));
});

test('future-only linked matchup is skipped until the audit date reaches it', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const futureLinked = series({ id: 'sweet_16_future_linked', name: 'Future linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(futureLinked, '2026-06-09')] },
    { id: 'season_1_june_2026' },
    [futureLinked],
    '2026-06-08'
  );

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.ok(result.details.includes('1 future unplayed series skipped'));
});

test('same-day linked 0–0 no-result series is skipped during normal audit', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const todayLinked = series({ id: 'sweet_16_today_linked', name: 'Today linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(todayLinked, '2026-06-08')] },
    { id: 'season_1_june_2026' },
    [todayLinked],
    '2026-06-08'
  );

  assert.equal(result.status, 'PASS');
  assert.equal(result.actual, 'All played/checkable series scores match recorded results');
  assert.ok(result.details.includes('1 same-day unplayed/live series skipped'));
});

test('same-day linked 0–0 no-result series is checkable when current-day inclusion is forced', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const todayLinked = series({ id: 'sweet_16_today_forced_linked', name: 'Today forced linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(todayLinked, '2026-06-08')] },
    { id: 'season_1_june_2026' },
    [todayLinked],
    '2026-06-08',
    { includeCurrentDayResults: true }
  );

  assert.equal(result.status, 'WARN');
  assert.equal(result.actual, '1 checkable unplayed 0–0 series have no game results');
});

test('past linked 0–0 no-result series still warns', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const pastLinked = series({ id: 'sweet_16_past_linked', name: 'Past linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(pastLinked, '2026-06-07')] },
    { id: 'season_1_june_2026' },
    [pastLinked],
    '2026-06-08'
  );

  assert.equal(result.status, 'WARN');
  assert.equal(result.actual, '1 checkable unplayed 0–0 series have no game results');
});

test('past gameHistory-linked 0–0 no-result series still warns', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const pastLinked = series({ id: 'sweet_16_past_history_linked', name: 'Past history linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [], gameHistory: [linkedMatchup(pastLinked, '2026-06-07')] },
    { id: 'season_1_june_2026' },
    [pastLinked],
    '2026-06-08'
  );

  assert.equal(result.status, 'WARN');
  assert.equal(result.actual, '1 checkable unplayed 0–0 series have no game results');
});

test('future linked matchup with stored wins is still checkable', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const futureLinkedWithWins = series({
    id: 'sweet_16_future_linked_with_wins',
    name: 'Future linked Sweet 16 with wins',
    roundId: 'sweet_16',
    status: 'pending',
    winsA: 1,
    winsB: 0
  });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(futureLinkedWithWins, '2026-06-09')] },
    { id: 'season_1_june_2026' },
    [futureLinkedWithWins],
    '2026-06-08'
  );

  assert.equal(result.status, 'FAIL');
  assert.equal(result.actual, '1 mismatch(es)');
  assert.match(result.details[0], /expected 0–0 from results, stored 1–0/);
});

function loadAdditionalSeasonAuditHelpers() {
  const auditHtml = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  const functionNames = [
    'getSeriesDisplayNameForAudit',
    'getAuditDateKeyForSeasonSeriesScores',
    'toAuditFiniteSeasonScore',
    'buildSeasonMatchupScoreFieldDivergenceAuditForAudit',
    'buildCurrentDaySeriesGameResultsAuditForAudit'
  ];
  const context = {
    TaskPointsCore: {
      getRecordedSeriesId: (record) => record?.seriesId || record?.seasonSeriesId || ''
    },
    getTodayGameDayKeyForAudit: () => '2026-06-12'
  };
  context.window = context;
  vm.createContext(context);
  const source = functionNames.map((name) => extractFunction(auditHtml, name)).join('\n');
  vm.runInContext(`${source}; this.buildSeasonMatchupScoreFieldDivergenceAuditForAudit = buildSeasonMatchupScoreFieldDivergenceAuditForAudit; this.buildCurrentDaySeriesGameResultsAuditForAudit = buildCurrentDaySeriesGameResultsAuditForAudit;`, context);
  return context;
}

test('audit catches Season tournament matchup score field divergence', () => {
  const helpers = loadAdditionalSeasonAuditHelpers();
  const season = { id: 'season_1_june_2026', series: { s1: series({ id: 's1', roundId: 'sweet_16', playerAId: 'YOU', playerBId: 'everly' }) } };
  const result = helpers.buildSeasonMatchupScoreFieldDivergenceAuditForAudit({
    matchups: [{
      id: 'you-everly-g3',
      seasonId: season.id,
      seriesId: 's1',
      matchupType: 'tournament',
      dateKey: '2026-06-11',
      playerAId: 'YOU',
      playerBId: 'everly',
      scoreA: 61.02,
      scoreB: 34.2,
      playerAScore: 8.67,
      playerBScore: 34.2,
      winnerId: 'everly'
    }]
  }, season);

  assert.equal(result.status, 'FAIL');
  assert.match(result.details[0], /61\.02–34\.2 disagree with playerAScore\/playerBScore 8\.67–34\.2/);
});

test('audit catches current-day Season gameResults in normal mode', () => {
  const helpers = loadAdditionalSeasonAuditHelpers();
  const s = series({ id: 's_today', name: 'Today Series', roundId: 'sweet_16' });
  s.gameResults = [{ matchupId: 'today-g4', dateKey: '2026-06-12', gameNumber: 4, winnerId: s.playerBId }];

  const result = helpers.buildCurrentDaySeriesGameResultsAuditForAudit({ id: 'season_1_june_2026' }, [s], '2026-06-12', {});

  assert.equal(result.status, 'FAIL');
  assert.match(result.details[0], /2026-06-12: current\/future gameResult is present during normal mode/);
});
