const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name} helper`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`could not find end of ${name}`);
}

test('Home scoreboard rank, record, and PPD use the Season 3 ranking window', () => {
  assert.match(html, /const HOME_SCOREBOARD_SEASON_THREE_START = "2026-09-01";/);
  assert.match(html, /const HOME_SCOREBOARD_SEASON_THREE_END = "2026-10-01";/);

  const rows = functionSource('getHomeScoreboardSeasonThreeRows');
  assert.match(rows, /key >= HOME_SCOREBOARD_SEASON_THREE_START/);
  assert.match(rows, /key < HOME_SCOREBOARD_SEASON_THREE_END/);

  const state = functionSource('getHomeScoreboardSeasonThreeState');
  assert.match(state, /getHomeScoreboardSeasonThreeRows\(s\.matchups\)/);
  assert.match(state, /getHomeScoreboardSeasonThreeRows\(s\.gameHistory\)/);
  assert.match(state, /getHomeScoreboardSeasonThreeRows\(s\.completions\)/);

  assert.match(functionSource('getPlayerRecordText'), /getHomeScoreboardSeasonThreeState\(\)/);
  assert.match(functionSource('computeYourRecord'), /getHomeScoreboardSeasonThreeState\(\)/);
  assert.match(functionSource('getCanonicalRankingMap'), /getHomeScoreboardSeasonThreeState\(\)/);
  assert.match(functionSource('getHomepagePpdValue'), /getCanonicalRankingMap\(\)/);
});

test('Home scoreboard Gold keeps its existing independent Season 2 cutoff', () => {
  assert.match(html, /const HOME_SCOREBOARD_SEASON_TWO_START = "2026-07-01";/);
  assert.match(functionSource('getHomepageGoldValue'), /key < HOME_SCOREBOARD_SEASON_TWO_START/);
});
