const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

function rgb(hex) {
  const raw = String(hex).replace('#', '');
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16)
  ];
}

test('home Records uses a dedicated first-half 2026 date tier across every leaderboard', () => {
  assert.match(indexSource, /const isFirstHalf2026Date = \(value\) =>/);
  assert.match(indexSource, /key >= '2026-01-01' && key <= '2026-06-30'/);
  assert.match(indexSource, /const isFirstHalf2026Month = \(value\) =>/);
  assert.match(indexSource, /key >= '2026-01' && key <= '2026-06'/);
  assert.match(indexSource, /return 'leaderboard-first-half-2026'/);

  for (const board of ['dailyBoard', 'taskDaysBoard', 'sleepDaysBoard', 'workDaysBoard', 'moodDaysBoard']) {
    const pattern = new RegExp("fillBoard\\('" + board + "'[^\\n]+dailyDateClass\\)");
    assert.match(indexSource, pattern, board + ' should use the daily date color tier');
  }
  assert.match(indexSource, /fillBoard\('weeklyBoard'[^\n]+weeklyDateClass\)/);
  assert.match(indexSource, /fillBoard\('monthlyBoard'[^\n]+monthlyDateClass\)/);
});

test('2025 remains darker than first-half 2026, which is the exact midpoint to normal Records text', () => {
  const normal = rgb('#e6edf6');
  const old = rgb('#7a7a7a');
  const expectedMid = normal.map((value, index) => Math.round((value + old[index]) / 2));
  assert.deepEqual(expectedMid, rgb('#b0b4b8'));

  assert.match(stylesSource, /\.leaderboard-first-half-2026\s*\{\s*color:\s*#b0b4b8;/);
  assert.match(stylesSource, /\.leaderboard-year-2025\s*\{\s*color:\s*#7a7a7a;/);
  assert.match(stylesSource, /body\s*\{[\s\S]*?color:\s*#e6edf6;/);
});

test('2025 styling keeps precedence for a week that crosses from 2025 into 2026', () => {
  const weeklyStart = indexSource.indexOf('const weeklyDateClass = (row) => {');
  const weeklyEnd = indexSource.indexOf('const monthlyDateClass', weeklyStart);
  const weeklyLogic = indexSource.slice(weeklyStart, weeklyEnd);
  assert.ok(weeklyLogic.indexOf("return 'leaderboard-year-2025'") < weeklyLogic.indexOf("return 'leaderboard-first-half-2026'"));
});


test('current-month orange applies only to Task, Sleep, Work, and Mood daily record boards', () => {
  assert.match(indexSource, /const markCurrentMonthRecordRows = \(rows\) => rows\.map/);
  assert.match(indexSource, /isCurrentMonth: String\(row\?\.key \|\| ''\)\.slice\(0, 7\) === thisMonthK/);

  for (const sourceName of [
    'isNormalTaskCompletion',
    'isSleepCompletion',
    'isWorkCompletion',
    'isMoodCompletion'
  ]) {
    const pattern = new RegExp(
      'markCurrentMonthRecordRows\\(buildDailyRecordBoard\\(' + sourceName + '\\)\\)'
    );
    assert.match(indexSource, pattern, sourceName + ' board should mark current-month rows');
  }

  assert.match(
    indexSource,
    /if \(row\.isCurrentMonth \|\| row\.isOnTrack\) \{\s*li\.classList\.add\('leaderboard-current'\);/
  );
  assert.match(
    indexSource,
    /const topBestDays = fillBoard\('dailyBoard', bestDays,/,
    'Best Days should continue using its existing today-only current-period highlighting'
  );
  assert.doesNotMatch(
    indexSource,
    /fillBoard\('dailyBoard', markCurrentMonthRecordRows\(/,
    'Best Days must not mark every day in the current month orange'
  );
});
