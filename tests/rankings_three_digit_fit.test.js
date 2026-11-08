const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('only three-digit Power Rankings numbers are horizontally condensed', () => {
  const rankings = fs.readFileSync(path.resolve(__dirname, '..', 'rankings.html'), 'utf8');
  assert.ok(rankings.includes('.ranking-index--three-digit {'));
  assert.ok(rankings.includes('transform: scaleX(0.78);'));
  assert.ok(rankings.includes('transform-origin: center center;'));
  assert.ok(rankings.includes('grid-template-columns: 54px 84px minmax(0,1fr)'),
    'keep mobile card columns the same width');
  const start = rankings.indexOf('function renderRow(player, rank, imageUrl, delta) {');
  const end = rankings.indexOf('async function renderRankings()', start);
  assert.ok(start >= 0 && end > start);
  const render = new Function('escapeHtml', 'renderRankDelta',
    rankings.slice(start, end) + String.fromCharCode(10) + 'return renderRow;')(
    String, () => '');
  const player = { name: 'Example', wins: 0, losses: 0, winPctLabel: '—',
    ppdLabel: '0.0', rankingsStatsHtml: '' };
  for (const rank of [1, 9, 10, 99]) {
    assert.ok(render(player, rank, null, null).includes('<div class="ranking-index">' + rank + '</div>'),
      'rank ' + rank + ' must remain unchanged');
  }
  for (const rank of [100, 101, 999]) {
    assert.ok(render(player, rank, null, null).includes(
      '<div class="ranking-index ranking-index--three-digit">' + rank + '</div>'),
      'rank ' + rank + ' should be condensed horizontally');
  }
});
