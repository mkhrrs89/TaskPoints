const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};
require('../scoring_core.js');

const core = global.TaskPointsCore;

test('computeCalLogBonusPoints handles edge cases', () => {
  assert.equal(core.computeCalLogBonusPoints([]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: '0' }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: NaN }, { calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: -10 }]), 0);
});

test('computeCalLogBonusPoints uses configurable calories.logBonus', () => {
  const entries = [{ calories: 120 }];
  assert.equal(core.computeCalLogBonusPoints(entries, { scoringSettings: { calories: { logBonus: 3.5 } } }), 3.5);
  assert.equal(core.computeCalLogBonusPoints(entries, { scoringSettings: { calories: { logBonus: 0 } } }), 0);
});

test('aggregateCompletionsByDate adds/removes cal log bonus idempotently', () => {
  const dateIso = '2026-02-01T12:00:00.000Z';
  const entry = {
    id: 'cal-1',
    title: 'Calories (100)',
    completedAtISO: dateIso,
    calories: 100,
    points: 0,
  };

  let rollup = core.aggregateCompletionsByDate([entry], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10 + 2);

  const edited = { ...entry, title: 'Calories (0)', calories: 0 };
  rollup = core.aggregateCompletionsByDate([edited], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10);
});


test('saveStateSnapshot preserves existing reminders from stale snapshots', () => {
  storage.clear();
  const existing = core.normalizeState({
    tasks: [],
    reminders: [{ id: 'rem-1', text: 'Do not drop me', createdAtISO: '2026-05-28T12:00:00.000Z' }],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(existing));

  const stale = core.normalizeState({
    tasks: [],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  core.saveStateSnapshot(stale, { storageKey: core.STORAGE_KEY });
  const saved = JSON.parse(global.localStorage.getItem(core.STORAGE_KEY));
  assert.equal(saved.reminders.length, 1);
  assert.equal(saved.reminders[0].text, 'Do not drop me');
});

test('saveStateSnapshot allows explicit reminder deletion by id', () => {
  storage.clear();
  const existing = core.normalizeState({
    tasks: [],
    reminders: [
      { id: 'rem-delete', text: 'Delete me', createdAtISO: '2026-05-28T12:00:00.000Z' },
      { id: 'rem-keep', text: 'Keep me', createdAtISO: '2026-05-28T12:01:00.000Z' }
    ],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(existing));

  const next = { ...existing, reminders: existing.reminders.filter((reminder) => reminder.id !== 'rem-delete') };
  core.saveStateSnapshot(next, { storageKey: core.STORAGE_KEY, deletedReminderIds: ['rem-delete'] });
  const saved = JSON.parse(global.localStorage.getItem(core.STORAGE_KEY));
  assert.deepEqual(saved.reminders.map((reminder) => reminder.id), ['rem-keep']);
});
