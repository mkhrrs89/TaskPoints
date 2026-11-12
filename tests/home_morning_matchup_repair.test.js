const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceOf(name) {
  const start = home.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const open = home.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < home.length; i++) {
    if (home[i] === '{') depth++;
    if (home[i] === '}' && --depth === 0) return home.slice(start, i + 1);
  }
  throw new Error('unclosed function: ' + name);
}

function makeHarness({ existingPair = true, bye = false } = {}) {
  const day = '2026-11-12';
  const storedNpc = {
    id: 'already-scored',
    dateKey: day,
    playerAId: 'NPC-1', playerBId: 'NPC-2',
    scoreA: 67, scoreB: 54, matchupType: 'regular',
    goldOutcome: { settled: true, theftGoldStolen: 1.2 }
  };
  const plannedUser = {
    id: 'user-scheduled', dateKey: day, playerAId: 'YOU',
    playerBId: 'NPC-3', matchupType: 'regular'
  };
  const daySchedule = {
    date: day, dateKey: day, participantSignature: 'NPC-1|NPC-2|NPC-3|YOU',
    matchups: [existingPair ? plannedUser : null, {
      id: storedNpc.id, playerAId: storedNpc.playerAId,
      playerBId: storedNpc.playerBId, dateKey: day
    }].filter(Boolean),
    byeIds: bye ? ['YOU'] : []
  };
  const state = { players: [], schedule: [daySchedule], matchups: [storedNpc] };
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super('2026-11-12T07:54:00');
    }
  }
  const context = {
    state, Date: FixedDate, Map, Set, JSON, String, Number, Math,
    window: { TaskPointsCore: null },
    getAllParticipantIds() { return ['YOU', 'NPC-1', 'NPC-2', 'NPC-3']; },
    participantSignature(ids) { return ids.slice().sort().join('|'); },
    dateKey(date) {
      return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')].join('-');
    },
    getMatchupDateKeyLocal(m) { return m?.dateKey || m?.date || ''; },
    hasRecordedMatchupScore(m) {
      return Number.isFinite(m?.scoreA) && Number.isFinite(m?.scoreB);
    },
    buildDailySchedule() { throw new Error('existing schedule should be used'); }
  };
  vm.createContext(context);
  vm.runInContext(sourceOf('ensureUpcomingSchedule'), context);
  return { state, run: () => vm.runInContext('ensureUpcomingSchedule(1)', context), plannedUser, storedNpc };
}

test('a partially scored NPC slate retains the scheduled, unscored YOUR matchup', () => {
  const h = makeHarness();
  assert.equal(h.run(), true, 'the incomplete schedule is repaired');
  assert.equal(h.state.schedule.length, 1);
  const pairs = h.state.schedule[0].matchups;
  assert.equal(pairs.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(pairs[0])), h.storedNpc,
    'permanent scored NPC result and its Gold outcome stay untouched');
  assert.equal(pairs[1].playerAId, 'YOU');
  assert.equal(pairs[1].playerBId, 'NPC-3');
  assert.equal(pairs[1].id, h.plannedUser.id);
  assert.equal(h.state.matchups.length, 1, 'schedule repair alone does not settle or invent scores');
  assert.deepEqual(h.state.matchups[0], h.storedNpc, 'saved scored game stays exactly as it was');
  assert.equal(h.run(), false, 'repeat schedule checks do not keep rewriting the slate');
});

test('a genuine YOU bye does not create a phantom user matchup', () => {
  const h = makeHarness({ existingPair: false, bye: true });
  h.run();
  const pairs = h.state.schedule[0].matchups;
  assert.equal(pairs.length, 1);
  assert.ok(h.state.schedule[0].byeIds.includes('YOU'));
});

test('the independent daily ticker and immediate post-generation refresh remain available', () => {
  const refresh = sourceOf('refreshHomeMatchupAfterSimulation');
  assert.ok(refresh.includes('deriveTodayWithInertia(dailyTotals, matchupKey)'));
  assert.ok(refresh.includes('window.renderTodaysMatchup(matchupKey, matchupPoints)'));
  const ticker = sourceOf('startOpponentDripTicker');
  assert.ok(ticker.includes('setInterval(tick, 45000)'));
  assert.ok(ticker.includes('window.renderTodaysMatchup(matchupKey, matchupPoints)'));
});
