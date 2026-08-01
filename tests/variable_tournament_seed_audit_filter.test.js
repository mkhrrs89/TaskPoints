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
    String,
    Array,
    Object,
    console
  };
  if (options.withBuilder !== false) {
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

test('keeps the existing score-alias audit bootstrap behavior', () => {
  assert.match(source, /TaskPointsScoreAliasConsistency/);
  assert.match(source, /installAuditRepairPanel/);
  assert.match(source, /scoreAliasRepairPanel/);
  assert.match(source, /buildSeasonChampionshipAuditChecks/);
});
