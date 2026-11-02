const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const standings = fs.readFileSync(path.join(__dirname, '..', 'standings.html'), 'utf8');
const rankings = fs.readFileSync(path.join(__dirname, '..', 'rankings.html'), 'utf8');
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'scope implementation exists');
  return source.slice(start, end);
}

function pageHarness(source, kind, dateKey, savedScope = null) {
  const prefix = kind.toUpperCase();
  const store = new Map();
  const storageKey = `taskpoints_${kind}_scope_v1`;
  if (savedScope) store.set(storageKey, savedScope);
  const DateAt = class extends Date {
    constructor(...args) { super(...(args.length ? args : [dateKey + 'T12:00:00'])); }
  };
  const ctx = vm.createContext({
    Date: DateAt, String, Number,
    localStorage: {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, v)
    }
  });
  const from = `const ${prefix}_SCOPE_STORAGE_KEY`;
  const end = kind === 'standings' ? 'function filterRowsForStandingsScope(' : 'function filterRowsForRankingsScope(';
  vm.runInContext(between(source, from, end), ctx);
  return { ctx, store, storageKey };
}

test('Season 4 starts inclusively on November 1, 2026; October stays Season 3', () => {
  for (const [source, kind] of [[standings, 'standings'], [rankings, 'rankings']]) {
    const current = pageHarness(source, kind, '2026-11-02', 'season3');
    assert.equal(current.store.get(current.storageKey), 'season4');
    const allows = current.ctx[kind + 'ScopeAllowsDate'];
    assert.equal(allows('2026-10-31'), false);
    assert.equal(allows('2026-11-01'), true);
    assert.equal(allows('2026-11-02'), true);
    const prior = pageHarness(source, kind, '2026-10-31', 'season3');
    assert.equal(prior.store.get(prior.storageKey), 'season3');
    assert.equal(prior.ctx[kind + 'ScopeAllowsDate']('2026-10-31'), true);
    assert.equal(prior.ctx[kind + 'ScopeAllowsDate']('2026-11-01'), false);
    const newUser = pageHarness(source, kind, '2026-11-01');
    assert.equal(newUser.store.get(newUser.storageKey), 'season4');
  }
});

test('historical/overall views remain selectable and explicitly saved selections survive transition', () => {
  for (const [source, kind, broad] of [
    [standings, 'standings', 'lifetime'],
    [rankings, 'rankings', 'overall']
  ]) {
    const h = pageHarness(source, kind, '2026-11-02', broad);
    assert.equal(h.store.get(h.storageKey), broad);
    assert.equal(h.ctx[kind + 'ScopeAllowsDate']('2026-06-15'), true);
    const seasonOne = pageHarness(source, kind, '2026-11-02', 'season1');
    assert.equal(seasonOne.store.get(seasonOne.storageKey), 'season1');
    assert.equal(seasonOne.ctx[kind + 'ScopeAllowsDate']('2026-06-15'), true);
    assert.equal(seasonOne.ctx[kind + 'ScopeAllowsDate']('2026-11-01'), false);
  }
});

test('Home scoreboard follows Season 4 without altering Season 3 or historical Gold', () => {
  const from = home.indexOf('const HOME_SCOREBOARD_SEASON_TWO_START');
  const end = home.indexOf('function getCanonicalRankingMap()', from);
  assert.ok(from >= 0 && end > from);
  const ctx = vm.createContext({
    Date, String, Array,
    getGameDayKey: () => '2026-11-02',
    state: {
      matchups: [{ dateKey: '2026-10-31' }, { dateKey: '2026-11-01' }, { dateKey: '2026-11-02' }],
      gameHistory: [{ dateKey: '2026-10-30' }, { dateKey: '2026-11-01' }],
      completions: [{ dateKey: '2026-11-01' }]
    }
  });
  vm.runInContext(home.slice(from, end), ctx);
  assert.deepEqual(Array.from(ctx.getHomeScoreboardCurrentSeasonState('2026-11-02').matchups, x => x.dateKey), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(Array.from(ctx.getHomeScoreboardCurrentSeasonState('2026-10-31').matchups, x => x.dateKey), ['2026-10-31']);
  assert.deepEqual(Array.from(ctx.getHomeScoreboardSeasonThreeState().matchups, x => x.dateKey), ['2026-10-31']);
  assert.deepEqual(Array.from(ctx.getHomeScoreboardCurrentSeasonState('2026-11-02').gameHistory, x => x.dateKey), ['2026-11-01']);
  assert.match(home, /const HOME_SCOREBOARD_SEASON_TWO_START = "2026-07-01"/);
});
