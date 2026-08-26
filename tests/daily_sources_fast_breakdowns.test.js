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
