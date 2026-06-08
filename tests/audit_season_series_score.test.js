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
    'countSeriesResultsForAudit',
    'getAuditDateKeyForSeasonSeriesScores',
    'getSeasonRoundStartDateForAudit',
    'getSeasonRoundEndDateForAudit',
    'isSeasonSeriesStartedStatusForAudit',
    'isSeasonSeriesFutureStatusForAudit',
    'isMatchupLinkedToSeasonSeriesForAudit',
    'getSeasonSeriesLinkedMatchupsForAudit',
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

test('today or past linked matchup is checkable when results are missing', () => {
  const buildScoreAudit = loadScoreAuditHelper();
  const todayLinked = series({ id: 'sweet_16_today_linked', name: 'Today linked Sweet 16', roundId: 'sweet_16', status: 'pending' });

  const result = buildScoreAudit(
    { matchups: [linkedMatchup(todayLinked, '2026-06-08')] },
    { id: 'season_1_june_2026' },
    [todayLinked],
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
