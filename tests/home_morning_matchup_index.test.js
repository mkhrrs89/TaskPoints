const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = home.indexOf('function simulateToday() {');
const end = home.indexOf('function getHistoryDateKey(g)', start);
assert.ok(start > 0 && end > start);
const simulateSource = home.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const day = '2026-11-11';
const scoreFor = id => id === 'YOU' ? 12 : 55 + Number(id.split('-')[1]);
const effectFor = id => ({ greedRating: 25, npcId: id });

function seed() {
  const players = Array.from({ length: 9 }, (_, i) =>
    ({ id: 'NPC-' + i, name: 'Player ' + i, greed: 25, active: true }));
  const matchups = Array.from({ length: 6500 }, (_, i) => ({
    id: 'prior-' + i, dateKey: '2026-11-10',
    playerAId: 'NPC-' + (i % 8), playerBId: 'NPC-' + ((i + 1) % 8),
    scoreA: 65, scoreB: 46
  }));
  // Match by pair, even though the new schedule has a different ID.
  matchups.push({ id: 'prior-today', dateKey: day, playerAId: 'NPC-1', playerBId: 'NPC-0',
    scoreA: 42, scoreB: 50, matchupType: 'regular', playerAEffects: { existing: true } });
  // Match by ID, even though the pair in the saved record differs.
  matchups.push({ id: 'stable', dateKey: day, playerAId: 'NPC-6', playerBId: 'NPC-7',
    scoreA: 41, scoreB: 46, matchupType: 'playoff' });
  const todayPairs = [
    { id: 'new-pair', playerAId: 'NPC-0', playerBId: 'NPC-1', matchupType: 'regular' },
    { id: 'stable', playerAId: 'NPC-1', playerBId: 'NPC-2', matchupType: 'playoff' },
    { id: 'new-3', playerAId: 'NPC-2', playerBId: 'NPC-3', matchupType: 'regular' },
    { id: 'new-4', playerAId: 'NPC-4', playerBId: 'NPC-5', matchupType: 'regular' },
    { id: 'new-5', playerAId: 'NPC-8', playerBId: 'YOU', matchupType: 'regular' }
  ];
  const gameHistory = Array.from({ length: 5000 }, (_, i) => ({
    id: 'history-' + i, date: '2026-11-10', playerId: 'NPC-' + (i % 8), score: 50
  }));
  gameHistory.push({ id: 'existing-today', date: day, playerId: 'NPC-3',
    score: 31, effects: { previous: true } });
  return {
    players, gameHistory, matchups,
    schedule: [{ date: day, matchups: todayPairs }]
  };
}

function expectedMatchups(state) {
  const existing = clone(state.matchups);
  const names = new Map(state.players.map(p => [p.id, p.name]));
  // Saved rows win against reversed pairs and colliding IDs.
  // Only the three remaining disjoint pairings may be created.
  for (const pair of state.schedule[0].matchups.slice(2)) {
    const score = id => id === 'NPC-3' ? 31 : scoreFor(id);
    const effects = id => id === 'YOU' ? null : id === 'NPC-3' ? { previous: true } : effectFor(id);
    existing.push({
      ...pair, id: pair.id, date: day, dateKey: day,
      playerAId: pair.playerAId, playerBId: pair.playerBId,
      playerAName: names.get(pair.playerAId) || (pair.playerAId === 'YOU' ? 'You' : 'Unknown'),
      playerBName: names.get(pair.playerBId) || (pair.playerBId === 'YOU' ? 'You' : 'Unknown'),
      scoreA: score(pair.playerAId), scoreB: score(pair.playerBId),
      playerAEffects: effects(pair.playerAId), playerBEffects: effects(pair.playerBId)
    });
  }
  return existing;
}

test('daily matchup index preserves authoritative games despite stale IDs and reversed pairs across 6500 historical games', () => {
  const input = seed();
  const expected = expectedMatchups(input);
  const state = clone(input);
  let dateReads = 0, saves = 0, generatedSchedules = 0, generatedIds = 0;
  const context = {
    state,
    console: { warn() {}, error() {} },
    Date, JSON, Math, Map, Set, String, Number, Array,
    markHomeMorningStartupPhase() {},
    getGameDayKey() { return day; },
    getMatchupDateKeyLocal(row) { dateReads++; return String(row?.dateKey || row?.date || ''); },
    hasRecordedMatchupScore(row) {
      return Number.isFinite(row?.scoreA) && Number.isFinite(row?.scoreB);
    },
    getHistoryDateKey(row) { return String(row?.date || row?.dateKey || ''); },
    getYouName() { return 'You'; },
    ensureUpcomingSchedule() { generatedSchedules++; },
    computeTodayPoints() { return 12; },
    simulateAiScoreForPlayer(player, dateKey, options) {
      options?.captureEffects?.(effectFor(player.id));
      return scoreFor(player.id);
    },
    ensureOpponentDripSchedule() {},
    makeId() { return 'generated-history-' + (++generatedIds); },
    TaskPointsCore: { withGoldNpcScoringBatch(state, fn) { return fn(); } },
    save() { saves++; return true; }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(simulateSource + String.fromCharCode(10) + 'simulateToday();', context);
  assert.deepEqual(clone(state.matchups), expected,
    'stored games remain byte-for-byte and only unoccupied scheduled pairs are added');
  assert.equal(saves, 1, 'new daily slate continues to save exactly once');
  assert.equal(generatedSchedules, 1);
  assert.ok(dateReads <= input.matchups.length * 2 + 100,
    'date lookups must scale with historic rows, not historic rows times each new game');
  assert.ok(state.gameHistory.some(g => g.id === 'existing-today' && g.score === 31 && g.effects?.previous === true),
    'interrupted simulation preserves original NPC score and effects');
  assert.equal(state.gameHistory.filter(g => g.date === day).length, 9,
    'each NPC gets exactly one today record; old records stay intact');
  assert.equal(input.gameHistory.length, 5001, 'seed was not mutated by simulation');
});

test('the one-pass matchup index does not remove season reconciliation or protected saving', () => {
  assert.ok(simulateSource.includes('const todayMatchupIds = new Map();'));
  assert.ok(simulateSource.includes('const todayMatchupPairs = new Map();'));
  assert.ok(simulateSource.includes('const existingIndex = Math.min('));
  assert.ok(simulateSource.includes('rebuildTodayMatchupIndex()'));
  assert.ok(simulateSource.includes('TaskPointsCore.dedupeSameDayGeneratedSlateState'));
  assert.ok(simulateSource.includes('TaskPointsCore.syncSeasonResultsFromDailyMatchups'));
  assert.ok(simulateSource.includes('const saved = save();'));
});


test('incomplete saved user matchup fills blank scores without replacing its opponent or Gold history', () => {
  const state = seed();
  const storedUser = {
    id: 'new-5', dateKey: day, playerAId: 'NPC-8', playerBId: 'YOU',
    matchupType: 'regular', scoreA: null, scoreB: null,
    seriesId: 'keep-existing-series', recordedAtISO: null
  };
  state.matchups.push(storedUser);
  let saves = 0;
  const context = {
    state, console: { warn() {}, error() {} },
    Date, JSON, Math, Map, Set, String, Number, Array,
    markHomeMorningStartupPhase() {},
    getGameDayKey() { return day; },
    getMatchupDateKeyLocal(row) { return String(row?.dateKey || row?.date || ''); },
    hasRecordedMatchupScore(row) {
      const a = row?.scoreA ?? row?.playerAScore;
      const b = row?.scoreB ?? row?.playerBScore;
      return (row?.winnerId != null && row.winnerId !== '') ||
        (a != null && b != null && Number.isFinite(Number(a)) && Number.isFinite(Number(b)));
    },
    getHistoryDateKey(row) { return String(row?.date || row?.dateKey || ''); },
    getYouName() { return 'You'; },
    ensureUpcomingSchedule() {},
    computeTodayPoints() { return 12; },
    simulateAiScoreForPlayer(player, dateKey, options) {
      options?.captureEffects?.(effectFor(player.id));
      return scoreFor(player.id);
    },
    ensureOpponentDripSchedule() {},
    makeId() { return 'generated-id'; },
    TaskPointsCore: { withGoldNpcScoringBatch(state, fn) { return fn(); } },
    save() { saves++; return true; }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(simulateSource + String.fromCharCode(10) + 'simulateToday();', context);
  const userRows = state.matchups.filter(row =>
    (row.playerAId === 'YOU' || row.playerBId === 'YOU') &&
    String(row.dateKey || row.date || '') === day);
  assert.equal(userRows.length, 1, 'existing user game is completed, not duplicated');
  assert.equal(userRows[0].id, 'new-5');
  assert.equal(userRows[0].seriesId, 'keep-existing-series');
  assert.equal(userRows[0].scoreA, scoreFor('NPC-8'));
  assert.equal(userRows[0].playerAId, 'NPC-8');
  assert.equal(userRows[0].scoreB, scoreFor('YOU'));
  assert.equal(saves, 1);
  const npcExisting = state.matchups.find(row => row.id === 'prior-today');
  assert.equal(npcExisting.scoreA, 42, 'previously completed NPC score is immutable');
  assert.equal(npcExisting.scoreB, 50);
  assert.deepEqual(npcExisting.playerAEffects, { existing: true });
});

test('morning score generation prepares and reuses one canonical standing table', () => {
  assert.match(simulateSource, /new Map\(TaskPointsCore\.computeCanonicalRankings\(state, \{ preindexed: true \}\)\.map\(row => \[row\.playerId, row\]\)\)/);
  assert.match(simulateSource, /simulateAiScoreForPlayer\(player, todayKey, \{\s*opponent,\s*canonicalRanksByPlayerId,/);
  assert.match(simulateSource, /markHomeMorningStartupPhase\('gold-preflight-start'\)/);
  assert.match(simulateSource, /markHomeMorningStartupPhase\('gold-preflight-finished'\)/);
  assert.match(simulateSource, /markHomeMorningStartupPhase\('rankings-ready'\)/);
});

test('conflicting durable user pairing stops before scoring or saving', () => {
  const state = seed();
  state.matchups.push({ id:'existing-user', dateKey:day, playerAId:'NPC-6',
    playerBId:'YOU', scoreA:null, scoreB:null });
  const original = clone(state);
  const context = { state, console:{warn(){},error(){}}, Date, JSON, Map, Set, Math, String, Number, Array,
    getGameDayKey:()=>day, getMatchupDateKeyLocal:r=>r?.dateKey || r?.date || '',
    markHomeMorningStartupPhase(){}, ensureUpcomingSchedule(){},
    computeTodayPoints(){throw Error('must not compute scores');},
    save(){throw Error('must not save conflicting state');} };
  context.window=context;
  vm.createContext(context);
  vm.runInContext(simulateSource+'\nsimulateToday();',context);
  assert.deepEqual(clone(state),original);
});
test('a partially saved NPC score is reused for the correct user opponent', () => {
  const state=seed();
  state.matchups.push({id:'new-5',dateKey:day,playerAId:'NPC-8',playerBId:'YOU',
    matchupType:'regular',scoreA:63,scoreB:null,playerAEffects:{original:true}});
  let saves=0;
  const context={state,console:{warn(){},error(){}},Date,JSON,Math,Map,Set,String,Number,Array,
    markHomeMorningStartupPhase(){},getGameDayKey:()=>day,getMatchupDateKeyLocal:r=>r?.dateKey||r?.date||'',
    getHistoryDateKey:r=>r?.date||r?.dateKey||'',getYouName:()=> 'You',
    hasRecordedMatchupScore:r=>Number.isFinite(r?.scoreA)&&Number.isFinite(r?.scoreB),
    ensureUpcomingSchedule(){},computeTodayPoints:()=>12,ensureOpponentDripSchedule(){},
    simulateAiScoreForPlayer(p,d,options){assert.notEqual(p.id,'NPC-8');options.captureEffects(effectFor(p.id));return scoreFor(p.id);},
    makeId:()=> 'new-history',TaskPointsCore:{withGoldNpcScoringBatch(s,fn){return fn();}},save(){saves++;return true;}};
  context.window=context;vm.createContext(context);
  vm.runInContext(simulateSource+'\nsimulateToday();',context);
  const row=state.matchups.find(r=>r.id==='new-5');
  assert.equal(row.scoreA,63);assert.equal(row.scoreB,12);
  assert.deepEqual(clone(row.playerAEffects),{original:true});assert.equal(saves,1);
});
