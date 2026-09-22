const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_missing_donekey_date_analysis.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function install(targets = []) {
  const context = {
    console,
    JSON,
    Date,
    Map,
    Set,
    Number,
    String,
    Object,
    Array,
    Math,
    structuredClone: clone,
    module: { exports: {} },
    TaskPointsHabitCompletionBackupRecovery: {
      buildMissingTargets() { return clone(targets); }
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      dateKey(value) {
        const date = value instanceof Date ? value : new Date(value);
        return date.toISOString().slice(0, 10);
      },
      youDailyTotalsWithInertia(state) {
        return clone(state.__scores || {});
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_missing_donekey_date_analysis.js' });
  return context.TaskPointsMissingDoneKeyDateAnalysis;
}

function target(dayKey, habitName, habitId) {
  return { dayKey, habitName, habitId: habitId || habitName.toLowerCase().replace(/\s+/g, '-') };
}

test('groups missing rows by date and recognizes a stored game score that matches the current ledger', () => {
  const api = install([
    target('2026-03-31', 'No Weed', 'h1'),
    target('2026-03-31', 'Podcast', 'h2'),
    target('2026-04-01', 'Art', 'h3')
  ]);
  const state = {
    __scores: { '2026-03-31': 40, '2026-04-01': 22 },
    players: [{ id: 'npc', name: 'Rival' }],
    matchups: [{
      id: 'm1',
      dateKey: '2026-03-31',
      playerAId: 'YOU',
      playerBId: 'npc',
      scoreA: 40,
      scoreB: 35
    }],
    gameHistory: []
  };
  const result = api.buildMissingDateAnalysis(state);
  assert.equal(result.missingRowCount, 3);
  assert.equal(result.affectedDateCount, 2);
  assert.equal(result.counts.frozenMatch, 1);
  assert.equal(result.counts.noGame, 1);
  const march = result.days.find((row) => row.dayKey === '2026-03-31');
  assert.equal(march.missingCount, 2);
  assert.equal(march.classification, 'frozen-match');
  assert.equal(march.storedUserScore, 40);
  assert.equal(march.currentCanonicalScore, 40);
  assert.equal(march.preservedResult, 'Win');
});

test('reports stored game score drift without attributing the gap to missing doneKeys', () => {
  const api = install([target('2026-09-14', 'No Late Night Eats', 'h1')]);
  const state = {
    __scores: { '2026-09-14': 37.5 },
    players: [{ id: 'npc', name: 'Rival' }],
    matchups: [{
      id: 'm2',
      dayKey: '2026-09-14',
      playerAId: 'npc',
      playerBId: 'YOU',
      scoreA: 34,
      scoreB: 40
    }],
    gameHistory: [{
      id: 'g2',
      dateKey: '2026-09-14',
      playerId: 'YOU',
      opponentId: 'npc',
      matchupId: 'm2',
      score: 40
    }]
  };
  const result = api.buildMissingDateAnalysis(state);
  const row = result.days[0];
  assert.equal(row.classification, 'frozen-drift');
  assert.equal(row.scoreGap, 2.5);
  assert.equal(row.matchingHistoryCount, 1);
  assert.match(row.reason, /cannot be assigned to these doneKeys alone/);
});

test('distinguishes no-game dates, history-only dates, and ambiguous multiple-matchup dates', () => {
  const api = install([
    target('2026-03-30', 'One', 'h1'),
    target('2026-03-31', 'Two', 'h2'),
    target('2026-04-01', 'Three', 'h3')
  ]);
  const state = {
    __scores: {
      '2026-03-30': 10,
      '2026-03-31': 20,
      '2026-04-01': 30
    },
    players: [{ id: 'npc', name: 'Rival' }],
    matchups: [
      { id:'a', dateKey:'2026-04-01', playerAId:'YOU', playerBId:'npc', scoreA:30, scoreB:25 },
      { id:'b', dateKey:'2026-04-01', playerAId:'YOU', playerBId:'npc', scoreA:31, scoreB:26 }
    ],
    gameHistory: [
      { id:'g', dateKey:'2026-03-31', playerId:'YOU', score:20 }
    ]
  };
  const result = api.buildMissingDateAnalysis(state);
  assert.equal(result.counts.noGame, 1);
  assert.equal(result.counts.historyOnly, 1);
  assert.equal(result.counts.needsReview, 1);
});

test('multiple compatible You history rows block a supposedly frozen matchup classification', () => {
  const api = install([target('2026-09-01', 'Habit', 'h1')]);
  const state = {
    __scores: { '2026-09-01': 25 },
    players: [{ id:'npc', name:'Rival' }],
    matchups: [{ id:'m', dateKey:'2026-09-01', playerAId:'YOU', playerBId:'npc', scoreA:25, scoreB:20 }],
    gameHistory: [
      { id:'g1', dateKey:'2026-09-01', playerId:'YOU', matchupId:'m', opponentId:'npc', score:25 },
      { id:'g2', dateKey:'2026-09-01', playerId:'YOU', matchupId:'m', opponentId:'npc', score:25 }
    ]
  };
  const result = api.buildMissingDateAnalysis(state);
  assert.equal(result.days[0].classification, 'needs-review');
  assert.match(result.days[0].reason, /2 compatible scored You gameHistory rows/);
});

test('Audit loads the date analysis after the backup recovery tool', () => {
  assert.match(worker, /habit_missing_donekey_date_analysis\.js\?v=20260922-1/);
  assert.ok(
    worker.indexOf('/habit_completion_backup_recovery.js?v=20260921-2')
      < worker.indexOf('/habit_missing_donekey_date_analysis.js?v=20260922-1')
  );
});
