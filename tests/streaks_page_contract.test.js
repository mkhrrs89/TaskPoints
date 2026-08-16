const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'streaks.html'), 'utf8');
const nav = fs.readFileSync(path.join(ROOT, 'streaks_nav_link.js'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

test('streaks page exposes the requested sortable columns in order', () => {
  for (const key of ['name', 'bonus', 'streak', 'points']) {
    assert.match(page, new RegExp(`data-sort=["']${key}["']`));
  }
  assert.doesNotMatch(page, /data-sort=["']type["']/);
  assert.doesNotMatch(page, /<th[^>]*>.*\bType\b/s);
  assert.match(page, />Bonus\s*</);
  assert.match(page, />Days\s*</);
  assert.match(page, />Pts\s*</);
  assert.match(
    page,
    /data-sort=["']name["'][\s\S]*data-sort=["']bonus["'][\s\S]*data-sort=["']streak["'][\s\S]*data-sort=["']points["']/
  );
  assert.match(page, /filter\(\(habit\) => habit && !habit\.retired\)/);
});

test('streaks tables use compact fixed columns and default to bonus descending', () => {
  assert.match(page, /table-layout:\s*fixed/);
  assert.match(page, /\.streaks-col-name\s*\{\s*width:\s*41%/);
  assert.match(page, /\.streaks-col-bonus\s*\{\s*width:\s*25%/);
  assert.match(page, /\.streaks-table th\.numeric,[\s\S]*text-align:\s*left/);
  assert.match(page, /\.streaks-sort-btn\.numeric-sort[\s\S]*justify-content:\s*flex-start/);
  assert.match(page, /sortKey:\s*['"]bonus['"]/);
  assert.match(page, /sortDirection:\s*['"]desc['"]/);
});

test('zero-length current streaks are omitted from the tables', () => {
  assert.match(page, /filter\(\(row\) => row\.streak > 0\)/);
  assert.match(page, /No active habit or vice streaks found\./);
});

test('at-risk table is cloned above the full streak table', () => {
  assert.match(page, /data-streak-table=["']risk["'][\s\S]*data-streak-table=["']all["']/);
  assert.match(page, />At Risk Today\s*</);
  assert.match(page, /No streaks are at risk today\./);
});

test('at-risk streaks are last completed yesterday and not completed today', () => {
  assert.match(page, /endKey:\s*streak\.endKey/);
  assert.match(page, /completedToday:\s*completedTodayForHabit\(habit, state, todayKey, pendingDeltas\)/);
  assert.match(page, /row\.endKey === yesterdayKey\(\) && !row\.completedToday/);
  assert.match(page, /d\.setDate\(d\.getDate\(\) - 1\)/);
});

test('completed-today detection uses canonical completion day rules', () => {
  assert.match(page, /function validDayKey\(value\)/);
  assert.match(page, /for \(const value of \[row\?\.dayKey, row\?\.dateKey\]\)/);
  assert.match(page, /for \(const value of \[row\?\.completedAtISO, row\?\.createdAtISO\]\)/);
  assert.match(page, /completionHabitId\(completion\) !== String\(habit\?\.id \|\| ''\)\.trim\(\)/);
  assert.match(page, /completionDay\(completion\) === todayKey/);
  assert.match(page, /row\?\.habitId \|\| row\?\.viceId/);
});

test('completed-today detection also checks doneKeys and pending habit journal', () => {
  assert.match(page, /doneKeys\.includes\(todayKey\)/);
  assert.match(page, /taskpoints_pending_habit_deltas_v1/);
  assert.match(page, /pending\.status === 'full' \|\| pending\.status === 'half'/);
});

test('current bonus reuses canonical completion scoring and subtracts base value', () => {
  assert.match(page, /core\.pointsForCompletion\(synthetic, state\)/);
  assert.match(page, /adjusted - base/);
  assert.match(page, /streakMultiplierEnabled !== true/);
});

test('current streak keeps yesterday alive until today is explicitly marked', () => {
  assert.match(page, /diffToToday === 1 && isMarkedToday/);
  assert.match(page, /doneKeys\.includes\(todayKey\) \|\| failedKeys\.includes\(todayKey\)/);
});

test('mobile Streaks link is inserted directly after Today without replacing it', () => {
  assert.match(nav, /href = 'streaks\.html'/);
  assert.match(nav, /today\.html/);
  assert.match(nav, /today\.insertAdjacentElement\('afterend', link\)/);
  assert.match(nav, /textContent = 'Streaks'/);
});

test('shared bundled guard loads the Streaks nav helper', () => {
  assert.match(guard, /streaks_nav_link\.js\?v=20260815-1/);
  assert.match(guard, /data-taskpoints-streaks-nav-link/);
});
