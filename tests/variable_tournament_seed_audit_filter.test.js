const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'score_alias_audit_bootstrap.js'), 'utf8');

const OMITTED_IDS = [
  'season-seed-count-34',
  'season-seeds-continuous',
  'season-play-in-pairings'
];

function createContext(options = {}) {
  const scheduled = [];
  const listeners = new Map();
  const context = {
    document: {
      readyState: options.readyState || 'complete',
      getElementById() { return null; },
      addEventListener(name, callback) { listeners.set(name, callback); }
    },
    location: { pathname: '/audit.html', search: '', hash: '' },
    history: { state: null, replaceState() {} },
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
    Set,
    Map,
    String,
    Array,
    Object,
    console
  };
  if (typeof options.latestRoundHelper === 'function') {
    context.getLatestSeasonScheduledOrRecordedRoundIndexForAudit = options.latestRoundHelper;
  }
  if (typeof options.builderFactory === 'function') {
    context.buildSeasonChampionshipAuditChecks = options.builderFactory(context);
  } else if (options.withBuilder !== false) {
    context.buildSeasonChampionshipAuditChecks = () => [
      { id: 'season-seed-count-34' },
      { id: 'season-seeds-continuous' },
      { id: 'season-play-in-pairings' },
      { id: 'season-seed-player-uniqueness' },
      { id: 'season-round-integrity' }
    ];
  }
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'score_alias_audit_bootstrap.js' });
  return { context, scheduled, listeners };
}

test('removes only the three fixed 34-player audits', () => {
  const { context } = createContext();
  const ids = context.buildSeasonChampionshipAuditChecks().map((check) => check.id);

  assert.deepEqual(ids, [
    'season-seed-player-uniqueness',
    'season-round-integrity'
  ]);
  OMITTED_IDS.forEach((id) => assert.ok(!ids.includes(id)));
  assert.equal(context.__taskpointsVariableSeedAuditFilterInstalled, true);
});

test('installs before the page audit starts when the builder appears later', () => {
  const { context, scheduled, listeners } = createContext({ withBuilder: false, readyState: 'loading' });
  assert.ok(scheduled.length > 0, 'bootstrap should retry while the inline audit script is still loading');

  context.buildSeasonChampionshipAuditChecks = () => [
    { id: 'season-seed-count-34' },
    { id: 'season-player-id-integrity' }
  ];
  listeners.get('DOMContentLoaded')();

  assert.deepEqual(
    context.buildSeasonChampionshipAuditChecks().map((check) => check.id),
    ['season-player-id-integrity']
  );
});

test('memoizes the repeated latest-round scan only for one Season audit call', () => {
  let helperCalls = 0;
  const originalHelper = () => {
    helperCalls += 1;
    return 4;
  };
  const { context } = createContext({
    latestRoundHelper: originalHelper,
    builderFactory: (ctx) => (state) => {
      const season = state.currentSeason;
      for (let index = 0; index < 8; index += 1) {
        assert.equal(ctx.getLatestSeasonScheduledOrRecordedRoundIndexForAudit(state, season, '2026-08-18'), 4);
      }
      return [{ id: 'season-round-integrity' }];
    }
  });

  const state = { currentSeason: { id: 'season-1' } };
  context.buildSeasonChampionshipAuditChecks(state, '2026-08-18');
  assert.equal(helperCalls, 1, 'identical latest-round scans should be computed once per audit call');
  assert.equal(context.getLatestSeasonScheduledOrRecordedRoundIndexForAudit, originalHelper, 'the original helper must be restored after the audit call');

  context.buildSeasonChampionshipAuditChecks(state, '2026-08-18');
  assert.equal(helperCalls, 2, 'a later audit call must use a fresh short-lived cache');
});

test('keeps the existing score-alias audit bootstrap behavior', () => {
  assert.match(source, /TaskPointsScoreAliasConsistency/);
  assert.match(source, /installAuditRepairPanel/);
  assert.match(source, /scoreAliasRepairPanel/);
  assert.match(source, /buildSeasonChampionshipAuditChecks/);
});
