const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'standings.html'), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'Standings source includes ' + from);
  return source.slice(start, end);
}

function harness(matchups, scope) {
  let revealChecks = 0;
  const activeIds = new Set(['YOU', ...Array.from({length:120}, (_, i) => 'NPC-'+i)]);
  const state = {
    matchups: matchups.filter(m => {
      if (scope === 'lifetime') return true;
      const d = m?.dateKey || m?.date || m?.dateISO || '';
      if (scope === 'season1') return d < '2026-07-01';
      if (scope === 'season2') return d >= '2026-07-01' && d < '2026-09-01';
      if (scope === 'season3') return d >= '2026-09-01' && d < '2026-11-01';
      return d >= '2026-11-01';
    })
  };
  const ctx = vm.createContext({
    activeIds,
    getScopedStandingsState: () => state,
    getMatchupDateKey: m => m?.dateKey || m?.date || m?.dateISO || '',
    isMatchupRevealed: (m, includeToday) => {
      revealChecks++;
      return (m?.dateKey || m?.date || m?.dateISO || '') < '2026-11-16' || (includeToday && m?.dateKey === '2026-11-16');
    },
    Number, Map, Array, String, Math, Set
  });
  vm.runInContext(slice('const GOLD_START_DATE =', 'function formatOneDecimalNumber('), ctx);
  return { ctx, activeIds, state, getRevealChecks: () => revealChecks };
}

function sampleMatchups(count = 6200) {
  let seed = 1234321;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ids = ['YOU', ...Array.from({length:120}, (_, i) => 'NPC-'+i), 'INACTIVE'];
  return Array.from({length:count}, (_, i) => {
    const a = ids[Math.floor(random() * ids.length)];
    const b = i % 53 === 0 ? a : ids[Math.floor(random() * ids.length)];
    const d = i % 97 === 0 ? '2026-11-16' : '2026-' +
      String(i % 12 + 1).padStart(2, '0') + '-' + String(i % 27 + 1).padStart(2, '0');
    return { dateKey: d, playerAId: a, playerBId: b,
      scoreA: i % 31 === 0 ? 'NaN' : i % 23 === 0 ? null : Math.round(random() * 80 * 10) / 10,
      scoreB: i % 37 === 0 ? '' : i % 29 === 0 ? '43' : Math.round(random() * 80 * 10) / 10
    };
  });
}

test('single-pass Standings Gold index agrees with original winner-margin rules in every scope', () => {
  const matchups = sampleMatchups();
  for (const scope of ['season1','season2','season3','season4','lifetime']) {
    const h = harness(matchups, scope);
    const indexed = h.ctx.buildStandingsGoldIndex(h.state);
    // Legacy and optimized versions use the same scope, revealed dates,
    // inactive exclusions, original rounding, scores and self-match logic.
    for (const id of h.activeIds) {
      const expected = h.ctx.computeGoldForPlayerId(id);
      const actual = indexed.get(id) ?? 0;
      assert.equal(actual, expected, scope + ' / ' + id);
      assert.equal(h.ctx.getGoldCount({id}, indexed), expected);
    }
    const expectedOrder = [...h.activeIds].sort((a,b) =>
      h.ctx.computeGoldForPlayerId(b) - h.ctx.computeGoldForPlayerId(a));
    const newOrder = [...h.activeIds].sort((a,b) => (indexed.get(b) ?? 0) - (indexed.get(a) ?? 0));
    assert.deepEqual(newOrder, expectedOrder, 'both Gold sort orders match in ' + scope);
  }
});

test('Gold calculation visits matchup history once even with 120 players', () => {
  const h = harness(sampleMatchups(), 'lifetime');
  const index = h.ctx.buildStandingsGoldIndex(h.state);
  assert.ok(index instanceof Map);
  assert.ok(h.getRevealChecks() <= h.state.matchups.length,
    'a single index construction must check each game no more than once');
  const after = h.getRevealChecks();
  for (const id of h.activeIds) h.ctx.getGoldCount({ id }, index);
  assert.equal(h.getRevealChecks(), after, 'lookups cannot rescan thousands of matchups');
});

test('sort and render share scoped data, player statistics and Gold results once per refresh', () => {
  const render = slice('function renderTable() {', '    document.addEventListener("DOMContentLoaded"');
  assert.match(render, /const scopedState = getScopedStandingsState\(\)/);
  assert.match(render, /const goldIndex = buildStandingsGoldIndex\(scopedState\)/);
  assert.match(render, /new Map\(players\.map\(p => \[p, computePlayerStats\(p, scopedState\)\]\)\)/);
  assert.match(render, /getSortValue\(a, sortKey, statsByRow\.get\(a\), goldIndex\)/);
  assert.match(render, /getGoldCount\(p, goldIndex\)/);
  assert.match(render, /tbody\.replaceChildren\(fragment\)/);
  assert.doesNotMatch(render, /const stats = computePlayerStats\(p\);/);
  assert.doesNotMatch(render, /tbody\.appendChild\(tr\)/);
  assert.match(source, /function computeYouStats\(s = getScopedStandingsState\(\)\)/);
  assert.match(source, /function computePlayerStats\(p, s = getScopedStandingsState\(\)\)/);
});

test('Standings Gold is still winning-margin history, not a Greed wallet lookup', () => {
  const scoped = harness([
    { dateKey: '2026-11-15', playerAId: 'NPC-1', playerBId: 'YOU', scoreA: 20, scoreB: 10 },
    { dateKey: '2026-11-16', playerAId: 'NPC-1', playerBId: 'YOU', scoreA: 60, scoreB: 0 },
    { dateKey: '2026-06-30', playerAId: 'NPC-1', playerBId: 'YOU', scoreA: 50, scoreB: 0 }
  ], 'lifetime');
  const index = scoped.ctx.buildStandingsGoldIndex(scoped.state);
  assert.equal(index.get('NPC-1'), 1);
  assert.equal(scoped.ctx.getGoldCount({id:'YOU'}, index), 0);
});
