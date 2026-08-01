const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'score_alias_audit_bootstrap.js'), 'utf8');

function install() {
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
    getSeasonSeriesListForAudit(season) { return Array.isArray(season?.series) ? season.series : []; },
    buildSeasonChampionshipAuditChecks() {
      return [
        { id: 'season-seed-count-34', status: 'FAIL' },
        {
          id: 'season-matchup-score-fields-aligned',
          title: 'Season tournament matchup score fields stay aligned',
          section: 'Season Championship Audits',
          status: 'FAIL',
          details: ['overbroad old result']
        },
        { id: 'season-player-ids-valid', status: 'PASS' }
      ];
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'score_alias_audit_bootstrap.js' });
  return context;
}

function mismatch(overrides = {}) {
  return {
    id: 'matchup',
    dateKey: '2026-08-01',
    playerAId: 'YOU',
    playerBId: 'npc',
    scoreA: 38.24,
    scoreB: 50,
    playerAScore: 7.4,
    playerBScore: 50,
    ...overrides
  };
}

test('blank daily matchup metadata is excluded from the season tournament score audit', () => {
  const context = install();
  const checks = context.buildSeasonChampionshipAuditChecks({
    currentSeason: { id: 'season-1', series: [{ id: 'series-1' }] },
    matchups: [mismatch()]
  });
  const audit = checks.find((check) => check.id === 'season-matchup-score-fields-aligned');
  assert.equal(audit.status, 'PASS');
  assert.equal(audit.details.length, 0);
  assert.doesNotMatch(audit.actual, /divergence\(s\)/);
});

test('explicit tournament types and current-season series links remain audited', () => {
  const context = install();
  const checks = context.buildSeasonChampionshipAuditChecks({
    currentSeason: { id: 'season-1', series: [{ id: 'series-1' }] },
    matchups: [
      mismatch({ id: 'typed', matchupType: 'tournament', seasonId: 'season-1' }),
      mismatch({ id: 'linked', seriesId: 'series-1' }),
      mismatch({ id: 'other-season', matchupType: 'season', seasonId: 'season-2' }),
      mismatch({ id: 'other-series', seriesId: 'series-2' }),
      mismatch({ id: 'regular', matchupType: 'daily', seriesId: 'series-1' })
    ]
  });
  const audit = checks.find((check) => check.id === 'season-matchup-score-fields-aligned');
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.details.length, 2);
  assert.match(audit.details.join('\n'), /typed/);
  assert.match(audit.details.join('\n'), /linked/);
  assert.doesNotMatch(audit.details.join('\n'), /other-season|other-series|regular/);
});

test('unrelated audits stay intact while fixed seed audits remain omitted', () => {
  const context = install();
  const checks = context.buildSeasonChampionshipAuditChecks({
    currentSeason: { id: 'season-1', series: [] },
    matchups: []
  });
  assert.equal(checks.some((check) => check.id === 'season-seed-count-34'), false);
  assert.equal(checks.some((check) => check.id === 'season-player-ids-valid'), true);
});
