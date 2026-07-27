const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'home_yesterday_result_consistency.js'),
  'utf8'
);

test('weekly records projection mirrors the monthly on-track behavior', () => {
  assert.match(source, /const projectedTotal = \(actualTotal \/ elapsedDays\) \* 7;/);
  assert.match(source, /\(on-track\)/);
  assert.match(source, /row\.classList\.add\('leaderboard-current'\)/);
  assert.match(source, /\[\.\.\.baseRows, projectionRow\]/);
  assert.match(source, /\.sort\(\(a, b\) => \(b\.score - a\.score\)/);
  assert.match(source, /\.slice\(0, WEEKLY_BOARD_LIMIT\)/);
  assert.match(source, /const WEEKLY_BOARD_LIMIT = 10;/);
});

test('weekly projection refreshes after the normal records render', () => {
  const originalCall = source.indexOf('const result = original.apply(this, args);', source.indexOf('function installWeeklyOnTrackProjection'));
  const projectionCall = source.indexOf('applyWeeklyOnTrackProjection();', originalCall);
  assert.ok(originalCall >= 0, 'renderStats wrapper should call the original renderer');
  assert.ok(projectionCall > originalCall, 'projection should be applied after normal records rendering');
  assert.match(source, /global\.renderStats = wrapped;/);
  assert.match(source, /wrapped\.__taskPointsWeeklyOnTrackProjection = true;/);
});

test('weekly projection keeps the real current-week row separate', () => {
  assert.match(source, /board\.__taskPointsWeeklyBaseRows/);
  assert.match(source, /const rankedRows = \[\.\.\.baseRows, projectionRow\]/);
  assert.doesNotMatch(source, /baseRows\.filter\([^\n]*projection\.key/);
});
