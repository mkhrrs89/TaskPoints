const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'score_alias_audit_bootstrap.js'), 'utf8');

function install(baseChecks) {
  const context = {
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {}
    },
    location: { pathname: '/audit.html', search: '', hash: '' },
    setTimeout(fn) { fn(); },
    TaskPointsCore: {
      getRecordedSeriesId(row) { return row?.seriesId || row?.seasonSeriesId || ''; }
    },
    getCurrentSeasonForAudit(state) { return state?.currentSeason || null; },
    getSeasonSeriesListForAudit(season) {
      if (Array.isArray(season?.series)) return season.series;
      return Object.values(season?.series || {});
    },
    getSeriesDisplayNameForAudit(series) {
      return series?.roundName ? `${series.roundName} ${series.seriesIndex}` : series?.id;
    },
    isSeriesCompleteForAudit(series) { return series?.status === 'complete'; },
    buildSeasonChampionshipAuditChecks() { return baseChecks; }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'score_alias_audit_bootstrap.js' });
  return context;
}

function baseChecks() {
  return [
    { id: 'season-seed-count-34', status: 'FAIL' },
    { id: 'season-matchup-score-fields-aligned', status: 'PASS', details: [] },
    {
      id: 'season-winners-advanced-correctly',
      title: 'Completed series winners advanced correctly',
      section: 'Season Championship Audits',
      status: 'FAIL',
      actual: '12 advancement issue(s)',
      details: ['legacy hard-coded seed failure']
    },
    { id: 'season-player-ids-valid', status: 'PASS' }
  ];
}

function buildDynamicSeason({ wrongSlot = false } = {}) {
  const series = {};
  const winners = [];
  for (let index = 1; index <= 12; index += 1) {
    const playInId = `season_2_august_2026_play_in_${index}`;
    const openingIndex = 13 - index;
    const openingId = `season_2_august_2026_opening_round_${openingIndex}`;
    const winnerId = `winner-${index}`;
    const loserId = `loser-${index}`;
    winners.push({ id: winnerId, name: `Winner ${index}` });
    series[playInId] = {
      id: playInId,
      roundId: 'play_in',
      roundName: 'Play-In',
      seriesIndex: index,
      status: 'complete',
      playerAId: winnerId,
      playerBId: loserId,
      winnerId,
      loserId,
      nextSeriesId: openingId,
      nextSlot: 'B'
    };
    series[openingId] = {
      id: openingId,
      roundId: 'opening_round',
      roundName: 'Opening Round',
      seriesIndex: openingIndex,
      status: 'active',
      playerAId: `seed-${16 + openingIndex}`,
      playerBId: wrongSlot && index === 8 ? loserId : winnerId
    };
  }
  return {
    players: winners,
    currentSeason: {
      id: 'season_2_august_2026',
      bracket: {
        presetId: 'season2_60_august_2026',
        roundOrder: ['play_in', 'opening_round', 'round_of_32']
      },
      series
    },
    matchups: []
  };
}

test('60-player Play-In winners are checked against declared Opening Round slots without seed-range assumptions', () => {
  const context = install(baseChecks());
  const checks = context.buildSeasonChampionshipAuditChecks(buildDynamicSeason());
  const audit = checks.find((check) => check.id === 'season-winners-advanced-correctly');
  assert.equal(audit.status, 'PASS');
  assert.match(audit.actual, /12 completed-series advancement target\(s\) checked; all correct/);
  assert.doesNotMatch(audit.details.join('\n'), /31–34|invalid seed/);
  assert.match(audit.trace, /configured dynamic bracket/);
});

test('dynamic audit still fails when a Play-In loser occupies the declared winner slot', () => {
  const context = install(baseChecks());
  const checks = context.buildSeasonChampionshipAuditChecks(buildDynamicSeason({ wrongSlot: true }));
  const audit = checks.find((check) => check.id === 'season-winners-advanced-correctly');
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.details.length, 1);
  assert.match(audit.details[0], /the loser advanced/);
  assert.match(audit.details[0], /Opening Round 5 slot B/);
});

test('legacy two-Play-In direct-to-Round-of-32 seasons retain the original protected-slot audit', () => {
  const previous = baseChecks();
  const context = install(previous);
  const series = {
    p1: { id: 'p1', roundId: 'play_in', status: 'complete', winnerId: 'w1', playerAId: 'w1', playerBId: 'l1', nextSeriesId: 'r1', nextSlot: 'B' },
    p2: { id: 'p2', roundId: 'play_in', status: 'complete', winnerId: 'w2', playerAId: 'w2', playerBId: 'l2', nextSeriesId: 'r2', nextSlot: 'B' },
    r1: { id: 'r1', roundId: 'round_of_32', playerAId: 'seed1', playerBId: 'w1' },
    r2: { id: 'r2', roundId: 'round_of_32', playerAId: 'seed2', playerBId: 'w2' }
  };
  const checks = context.buildSeasonChampionshipAuditChecks({ currentSeason: { id: 'legacy', series }, matchups: [] });
  const audit = checks.find((check) => check.id === 'season-winners-advanced-correctly');
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.actual, '12 advancement issue(s)');
  assert.deepEqual(audit.details, ['legacy hard-coded seed failure']);
});

test('variable seed audits remain omitted and unrelated checks remain intact', () => {
  const context = install(baseChecks());
  const checks = context.buildSeasonChampionshipAuditChecks(buildDynamicSeason());
  assert.equal(checks.some((check) => check.id === 'season-seed-count-34'), false);
  assert.equal(checks.some((check) => check.id === 'season-player-ids-valid'), true);
});
