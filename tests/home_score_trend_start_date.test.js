const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('default Home daily score chart starts at December 1 2025 without changing stored data', () => {
  const start = source.indexOf('function drawDailyTrend(dailyTotals)');
  const end = source.indexOf('function drawWeightTrend', start);
  const body = source.slice(start, end);
  assert.match(body, /const SCORE_TREND_START_DATE = '2025-12-01'/);
  assert.match(body, /\.filter\(\(entry\) => entry\.key >= SCORE_TREND_START_DATE\)/);
  assert.doesNotMatch(body, /delete dailyTotals/);
});
