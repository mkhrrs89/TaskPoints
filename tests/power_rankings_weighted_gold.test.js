const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'rankings.html'), 'utf8');
const addon = fs.readFileSync(path.join(__dirname, '..', 'rankings_tournament_trophies.js'), 'utf8');

function functionSource(name) {
  const start = page.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const opening = page.indexOf('{', start);
  let depth = 0;
  for (let i = opening; i < page.length; i++) {
    if (page[i] === '{') depth++;
    if (page[i] === '}') {
      depth--;
      if (depth === 0) return page.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}
function setup(baseRows, gold) {
  const calls = { gold: 0 };
  const context = vm.createContext({
    Math, Number, Map,
    TaskPointsCore: { computeCanonicalRankings: () => baseRows.map(row => ({ ...row })) },
    computeRankingExtrasForPlayer(_player, row) {
      calls.gold++;
      return { gold: gold.get(row.playerId) || 0, mov: 4, baseDelta: 2 };
    }
  });
  context.window = context;
  vm.runInContext(functionSource('computePowerRankedRows'), context);
  return { context, calls };
}
function ids(rows) { return Array.from(rows, row => row.playerId); }

test('the 75/25 Power Ranking score normalizes displayed Gold to its leader', () => {
  const canonical = [
    { playerId: 'WINNER', winPct: 0.9 },
    { playerId: 'BALANCED', winPct: 0.8 },
    { playerId: 'GOLD', winPct: 0.7 }
  ];
  const { context, calls } = setup(canonical, new Map([['WINNER', 0], ['BALANCED', 50], ['GOLD', 100]]));
  const ranked = context.computePowerRankedRows({});
  assert.deepEqual(ids(ranked), ['GOLD', 'BALANCED', 'WINNER']);
  assert.ok(Math.abs(ranked[0].powerScore - 0.775) < 1e-12);
  assert.ok(Math.abs(ranked[1].powerScore - 0.725) < 1e-12);
  assert.ok(Math.abs(ranked[2].powerScore - 0.675) < 1e-12);
  assert.deepEqual(Array.from(ranked, r => r.rank), [1, 2, 3]);
  assert.equal(calls.gold, 3, 'visible total Gold computed once per player');
  assert.equal(ranked[0].rankingsExtras.gold, 100, 'the card and formula share total Gold');
});

test('scaling all Gold totals does not change rank; inactive entries cannot change leader', () => {
  const canonical = [{playerId:'A',winPct:0.9},{playerId:'B',winPct:0.8}];
  for (const scale of [1,10,1000]) {
    const { context } = setup(canonical, new Map([['A',scale],['B',10*scale],['INACTIVE',100000*scale]]));
    const ranked = context.computePowerRankedRows({});
    assert.deepEqual(ids(ranked), ['B','A']);
    assert.ok(Math.abs(ranked[0].powerScore - 0.85) < 1e-12);
  }
});

test('zero Gold preserves the previous canonical Win% and PPD tie-break order', () => {
  const canonical = [
    {playerId:'TIE_PPD_BETTER',winPct:0.8},
    {playerId:'TIE_PPD_LOWER',winPct:0.8},
    {playerId:'NO_GAMES',winPct:0}
  ];
  const { context } = setup(canonical, new Map());
  assert.deepEqual(ids(context.computePowerRankedRows({})), ids(canonical));
});

test('rank movement is recomputed using the composite rather than old Win% ranking', () => {
  const render = functionSource('renderRankings');
  const prior = functionSource('computePriorRankMap');
  assert.match(render, /computePowerRankedRows\(scopedState, playerById\)/);
  assert.match(render, /rankingStatsHtml\(player, row, scopedState, row\.rankingsExtras\)/);
  assert.match(render, /computePriorRankMap\(scopedState, new Date\(\), playerById\)/);
  assert.match(prior, /computePowerRankedRows\(yesterdayState, playerById\)/);
  assert.match(prior, /yesterdayState\[completeKey\] = state\[completeKey\]\.filter/);
  assert.match(page, /75% Win% · 25% Total Gold/);
  assert.ok(page.includes('data-player-id="${escapeHtml(player.playerId || player.id || \'\')}"'));
});

test('existing trophy and Retro Winner badge lookup prefers stable player ID', () => {
  assert.match(addon, /row\?\.getAttribute\?\.\('data-player-id'\)/);
  assert.match(addon, /playerIdForName\(cleanName, state\)/);
  assert.match(addon, /ids\[index\]/);
});
