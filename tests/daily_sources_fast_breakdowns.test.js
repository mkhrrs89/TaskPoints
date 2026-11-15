const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'daily_sources.html'), 'utf8');

test('Daily Sources builds history in one completion pass and caches it across pagination', () => {
  assert.match(source, /function buildDailyBreakdownsFast\(stateInput\)/);
  assert.match(source, /for \(const completion of completions\)/);
  assert.match(source, /const dayCompletions = new Map\(\)/);
  assert.match(source, /TaskPointsCore\.computeInertia\(dailyTotals, key, normalized\)/);
  assert.match(source, /TaskPointsCore\.computeCalLogBonusPoints\(entries, normalized\)/);
  assert.match(source, /let dailyBreakdownsCache = null/);
  assert.match(source, /const daily = getDailyBreakdowns\(\)/);
  assert.match(source, /dailySources\.fastBreakdowns/);

  // The legacy O(days × completions) implementation remains available only as
  // a safety fallback. Normal pagination must not invoke it on every render.
  const legacyCalls = source.match(/TaskPointsCore\.buildDailyBreakdowns\(state\)/g) || [];
  assert.equal(legacyCalls.length, 1);
  assert.match(source, /dailyBreakdownsCache = TaskPointsCore\.buildDailyBreakdowns\(state\)/);
});

test('Daily Sources preserves existing pagination and source rendering controls', () => {
  assert.match(source, /DAILY_SOURCES_PAGE_SIZE = 50/);
  assert.match(source, /data-daily-page-action="prev"/);
  assert.match(source, /data-daily-page-action="next"/);
  assert.match(source, /CATEGORY_DEFS\s*\.map/);
  assert.match(source, /categories\.inertia/);
});

test('Daily Sources computes inertia history once and preserves scores across gaps and edits', () => {
  global.window = global;
  require('../scoring_core.js');
  const core = global.TaskPointsCore;
  const state = { scoringSettings: { inertia: { windowDays: 3, multiplier: 0.5 } }, completions: [] };
  for (const [day, points] of [['2026-10-30', 10], ['2026-11-02', -4], ['2026-11-03', 0]]) {
    state.completions.push({ id: day, title: 'Task', points, completedAtISO: day + 'T12:00:00' });
  }
  const functions = source.slice(source.indexOf('function addDailySourcePoints('),
    source.indexOf('function getDailyBreakdowns('));
  const run = new Function('TaskPointsCore', 'CATEGORY_DEFS', functions + '\nreturn buildDailyBreakdownsFast;');
  let builds = 0;
  const fast = run({ ...core, todayKey: () => '2026-11-06',
    computeInertiaMaps(...args) { builds++; return core.computeInertiaMaps(...args); },
    computeInertia() { assert.fail('history rebuilt inside calendar loop'); }
  }, core.CATEGORY_DEFS);
  const reference = run({ ...core, todayKey: () => '2026-11-06', computeInertiaMaps: undefined }, core.CATEGORY_DEFS);
  const before = fast(state);
  assert.deepEqual(before, reference(state));
  assert.equal(before['2026-10-31'].categories.inertia, 5);
  assert.equal(before['2026-11-01'].categories.inertia, 5, 'yesterday’s projected score cannot feed an unlogged day');
  assert.equal(before['2026-11-02'].total, 1);
  state.completions[0].points = 16;
  state.scoringSettings.inertia.multiplier = 0.25;
  const after = fast(state);
  assert.deepEqual(after, reference(state));
  assert.equal(after['2026-11-01'].categories.inertia, 4);
  assert.equal(builds, 2, 'one fresh lookup per rebuild');
});
