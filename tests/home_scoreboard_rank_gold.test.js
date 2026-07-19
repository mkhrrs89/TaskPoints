const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

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

function buildHomepageHelpers() {
  const context = vm.createContext({
    Map,
    Number,
    Math,
    Date,
    getGameDayKey: () => '2026-07-10',
    getCanonicalRankingMap: () => new Map([
      ['YOU', { rank: 4 }],
      ['CHESTER', { rank: 7 }],
      ['INVALID', { rank: 'unknown' }],
    ]),
  });
  const seasonStart = html.match(/const HOME_SCOREBOARD_SEASON_TWO_START = "2026-07-01";/);
  assert.ok(seasonStart, 'Home scoreboard must retain the Season 2 cutoff');
  vm.runInContext(`
    let state;
    ${seasonStart[0]}
    ${functionSource('getHomeScoreboardDateKey')}
    ${functionSource('getHomepageRankValue')}
    ${functionSource('getHomepageGoldValue')}
    ${functionSource('formatHomepageGold')}
    globalThis.setState = (nextState) => { state = nextState; };
    globalThis.helpers = { getHomepageRankValue, getHomepageGoldValue, formatHomepageGold };
  `, context);
  return context;
}

test('Home scoreboard places the unique inline ranks around safely truncating names', () => {
  assert.equal((html.match(/id="matchupYourRank"/g) || []).length, 1);
  assert.equal((html.match(/id="matchupOpponentRank"/g) || []).length, 1);
  assert.match(html, /scoreboard-name-row--you[\s\S]*?id="matchupYourName"[\s\S]*?id="matchupYourRank"/);
  assert.match(html, /scoreboard-name-row--opponent[\s\S]*?id="matchupOpponentRank"[\s\S]*?id="matchupOpponent"/);
  assert.doesNotMatch(html, />Rank:\s*—</);
  assert.match(html, /id="matchupYourGold"[\s\S]*?>Gold: 0\.0</);
  assert.match(html, /id="matchupOpponentGold"[\s\S]*?>Gold: —</);
  assert.match(css, /\.scoreboard-name-row \{[\s\S]*?display: flex;[\s\S]*?min-width: 0;/);
  assert.match(css, /\.scoreboard-name-row \.scoreboard-name \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;/);
  assert.match(css, /\.scoreboard-rank-inline \{[\s\S]*?color: #fff;[\s\S]*?font-variant-numeric: tabular-nums;/);
  assert.match(css, /\.scoreboard-gold \{[\s\S]*?color: #fb923c;[\s\S]*?font-variant-numeric: tabular-nums;/);
});

test('Home scoreboard rank and Gold helpers use read-only completed Season 2 results', () => {
  const context = buildHomepageHelpers();
  const { helpers } = context;
  const matchups = [
    { dateKey: '2026-06-30', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 100, scoreB: 0 },
    { dateKey: '2026-07-01', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 30, scoreB: 10 },
    { dateKey: '2026-07-02', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 10, scoreB: 20 },
    { dateKey: '2026-07-03', playerAId: 'CHESTER', playerBId: 'YOU', scoreA: 5, scoreB: 12 },
    { dateKey: '2026-07-04', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 11, scoreB: 10 },
    { dateKey: '2026-07-05', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 14, scoreB: 14 },
    { dateKey: '2026-07-10', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: 100, scoreB: 0 },
    { dateKey: '2026-07-06', playerAId: 'YOU', playerBId: 'CHESTER', scoreA: null, scoreB: 0 },
  ];
  const state = { matchups };
  const before = JSON.stringify(state);
  context.setState(state);

  assert.equal(helpers.getHomepageRankValue('YOU'), '4');
  assert.equal(helpers.getHomepageRankValue('CHESTER'), '7');
  assert.equal(helpers.getHomepageRankValue('INVALID'), '—');
  assert.equal(helpers.getHomepageRankValue(''), '—');
  assert.equal(helpers.getHomepageGoldValue('YOU'), 2.8, '20-point and multiple wins accumulate, while loss/tie/today do not');
  assert.equal(helpers.formatHomepageGold('YOU'), 'Gold: 2.8');
  assert.equal(helpers.formatHomepageGold(null), 'Gold: —');
  assert.equal(JSON.stringify(state), before, 'Gold is derived without persisting state');

  const goldHelper = functionSource('getHomepageGoldValue');
  assert.match(goldHelper, /key < HOME_SCOREBOARD_SEASON_TWO_START/);
  assert.match(goldHelper, /key >= today/);
  assert.doesNotMatch(goldHelper, /localStorage|save\s*\(/);
  assert.match(html, /getHomepageRankValue\('YOU'\)/);
  assert.match(html, /formatHomepageGold\('YOU'\)/);
  assert.match(html, /getPlayerRecordText|getYourRecordText/);
  assert.match(html, /formatPpdLine/);
  assert.match(html, /formatHeadToHeadRecord/);
  assert.match(html, /setPlayerColorSwatches/);
});
