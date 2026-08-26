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
  assert.match(page, /if \(!habit \|\| habit\.retired\) continue/);
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

test('completed streak table omits zero-length streaks', () => {
  assert.match(page, /if \(currentStreak > 0\) current\.push/);
  assert.match(page, /No completed habit or vice streaks for today\./);
});

test('at-risk table remains above the completed streak table', () => {
  assert.match(page, /data-streak-table=["']risk["'][\s\S]*data-streak-table=["']all["']/);
  assert.match(page, />At Risk Today\s*</);
  assert.match(page, /No streaks are at risk today\./);
});

test('at-risk means active through yesterday and completely untouched today', () => {
  assert.match(page, /const yesterdayStreak = countStreakEndingOn\(status\.done, yesterdayKey\)/);
  assert.match(page, /const completedToday = status\.done\.has\(todayKey\)/);
  assert.match(page, /const failedToday = status\.failed\.has\(todayKey\)/);
  assert.match(page, /const todayState = completedToday \? 'done' : \(failedToday \? 'failed' : ''\)/);
  assert.match(page, /if \(todayState === '' && yesterdayStreak > 0\)/);
  assert.match(page, /no completed or failed toggle for today/i);
});

test('toggle evidence mirrors habit done and failed state plus completion ledger', () => {
  assert.match(page, /habit\?\.doneKeys/);
  assert.match(page, /habit\?\.failedKeys/);
  assert.match(page, /completionDaysByHabit/);
  assert.match(page, /completionHabitId\(completion\)/);
  assert.match(page, /completionDay\(completion\)/);
  assert.match(page, /failed\.forEach\(\(dayKey\) => done\.delete\(dayKey\)\)/);
});

test('pending habit journal is the newest toggle-state override', () => {
  assert.match(page, /taskpoints_pending_habit_deltas_v1/);
  assert.match(page, /done\.delete\(dayKey\)/);
  assert.match(page, /failed\.delete\(dayKey\)/);
  assert.match(page, /if \(pendingIsDone\(delta\)\) done\.add\(dayKey\)/);
  assert.match(page, /else if \(pendingIsFailed\(delta\)\) failed\.add\(dayKey\)/);
  assert.match(page, /delta\?\.status === 'failed'/);
});

test('completion date and habit identity use canonical compatible fields', () => {
  assert.match(page, /function validDayKey\(value\)/);
  assert.match(page, /for \(const value of \[row\?\.dayKey, row\?\.dateKey\]\)/);
  assert.match(page, /for \(const value of \[row\?\.completedAtISO, row\?\.createdAtISO\]\)/);
  assert.match(page, /row\?\.habitId \|\| row\?\.viceId/);
  assert.match(page, /core\?\.dateKey/);
});

test('current bonus previews a missing completion before canonical scoring', () => {
  assert.match(page, /function stateWithPreviewedCompletion\(habit, dayKey, state\)/);
  assert.match(page, /doneKeys:\s*\[\.\.\.doneKeys, dayKey\]/);
  assert.match(page, /failedKeys:[\s\S]*filter\(\(key\) => key !== dayKey\)/);
  assert.match(page, /const scoringState = stateWithPreviewedCompletion\(habit, streak\.endKey, state\)/);
  assert.match(page, /core\.pointsForCompletion\(synthetic, scoringState\)/);
  assert.match(page, /adjusted - base/);
  assert.match(page, /streakMultiplierEnabled !== true/);
});

test('at-risk bonus previews today while the displayed streak remains completed-through-yesterday', () => {
  assert.match(page, /streak:\s*streakDays/);
  assert.match(
    page,
    /risk\.push\(makeRow\([\s\S]*?yesterdayStreak,[\s\S]*?yesterdayKey,[\s\S]*?state,[\s\S]*?yesterdayStreak \+ 1,[\s\S]*?todayKey[\s\S]*?\)\)/
  );
  assert.match(page, /Bonus shows today’s streak value/);
  assert.match(page, /Bonus previews what today’s completion would add/);
});

test('lower streak table contains completed-today streaks only', () => {
  assert.match(page, /if \(todayState === 'done'\)/);
  assert.match(page, /const currentStreak = countStreakEndingOn\(status\.done, todayKey\)/);
  assert.match(page, /current\.push\(makeRow\(habit, currentStreak, todayKey, state\)\)/);
  assert.doesNotMatch(page, /else if \(todayState === ''\)[\s\S]*current\.push/);
  assert.doesNotMatch(page, /todayState === 'failed'[\s\S]*current\.push/);
  assert.match(page, /Only habits and vices marked complete today appear here/);
  assert.match(page, /completed today/);
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
