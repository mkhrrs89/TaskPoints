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
      getRecordedSeriesId(row) { return row?.seriesId || row?.seasonSeriesId || ''; },
      getSeasonRoundOrder(season) {
        if (Array.isArray(season?.bracket?.roundOrder)) return season.bracket.roundOrder;
        if (Array.isArray(season?.bracketConfig?.rounds)) return season.bracketConfig.rounds.map((round) => round?.id).filter(Boolean);
        return [];
      }
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

function buildProtectedCustom34Season() {
  const series = {
    play1: {
      id: 'play1', roundId: 'play_in', roundName: 'Play-In', seriesIndex: 1,
      status: 'complete', playerAId: 'winner-34', playerBId: 'loser-31',
      winnerId: 'winner-34', loserId: 'loser-31',
      // Generic bracket metadata is fixed, but protected advancement reseeds.
      nextSeriesId: 'round32-2', nextSlot: 'B'
    },
    play2: {
      id: 'play2', roundId: 'play_in', roundName: 'Play-In', seriesIndex: 2,
      status: 'complete', playerAId: 'winner-31', playerBId: 'loser-34',
      winnerId: 'winner-31', loserId: 'loser-34',
      nextSeriesId: 'round32-1', nextSlot: 'B'
    }
  };

  for (let index = 1; index <= 16; index += 1) {
    series[`round32-${index}`] = {
      id: `round32-${index}`,
      roundId: 'round_of_32',
      roundName: 'Round of 32',
      seriesIndex: index,
      status: 'pending',
      playerAId: `seed-${index}`,
      playerBId: ''
    };
  }

  // After the upset, the worse numeric winner (Seed 34) is correctly reseeded
  // against Seed 1, while the other winner faces Seed 2. This intentionally no
  // longer agrees with the fixed nextSeriesId metadata on the Play-In rows.
  series['round32-1'].playerBId = 'winner-34';
  series['round32-2'].playerBId = 'winner-31';

  return {
    currentSeason: {
      id: 'custom_34',
      bracket: {
        type: 'dynamic_configured_championship',
        presetId: 'custom_single_elimination',
        roundOrder: ['play_in', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals']
      },
      bracketConfig: {
        presetId: 'custom_single_elimination',
        entrantCount: 34,
        rounds: [
          { id: 'play_in' },
          { id: 'round_of_32' },
          { id: 'round_of_16' },
          { id: 'quarterfinals' },
          { id: 'semifinals' },
          { id: 'finals' }
        ]
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

test('custom 34-player brackets retain protected reseeding after a Play-In upset', () => {
  const previous = baseChecks();
  const originalAudit = previous.find((check) => check.id === 'season-winners-advanced-correctly');
  originalAudit.status = 'PASS';
  originalAudit.actual = 'Protected Play-In winners are correctly reseeded into Round of 32';
  originalAudit.details = ['Seed 34 correctly faces Seed 1; Seed 31 correctly faces Seed 2'];

  const context = install(previous);
  const checks = context.buildSeasonChampionshipAuditChecks(buildProtectedCustom34Season());
  const audit = checks.find((check) => check.id === 'season-winners-advanced-correctly');

  assert.equal(audit.status, 'PASS');
  assert.equal(audit.actual, originalAudit.actual);
  assert.deepEqual(audit.details, originalAudit.details);
  assert.doesNotMatch(audit.trace || '', /configured dynamic bracket/);
});

test('official legacy protected bracket types retain the original audit', () => {
  const previous = baseChecks();
  const context = install(previous);
  const state = buildProtectedCustom34Season();
  state.currentSeason.bracket.type = 'official_34_player_championship';
  state.currentSeason.series = {
    p1: { id: 'p1', roundId: 'play_in', status: 'complete', winnerId: 'w1', playerAId: 'w1', playerBId: 'l1', nextSeriesId: 'r1', nextSlot: 'B' },
    p2: { id: 'p2', roundId: 'play_in', status: 'complete', winnerId: 'w2', playerAId: 'w2', playerBId: 'l2', nextSeriesId: 'r2', nextSlot: 'B' },
    r1: { id: 'r1', roundId: 'round_of_32', playerAId: 'seed1', playerBId: 'w1' },
    r2: { id: 'r2', roundId: 'round_of_32', playerAId: 'seed2', playerBId: 'w2' }
  };
  const checks = context.buildSeasonChampionshipAuditChecks(state);
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
