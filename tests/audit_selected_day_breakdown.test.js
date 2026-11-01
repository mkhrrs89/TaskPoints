const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const stored = new Map();
global.localStorage = {
  getItem: key => stored.has(String(key)) ? stored.get(String(key)) : null,
  setItem: (key, value) => stored.set(String(key), String(value)),
  removeItem: key => stored.delete(String(key)),
  key: index => Array.from(stored.keys())[index] ?? null,
  get length() { return stored.size; }
};
require('../scoring_core.js');
const core = global.TaskPointsCore;
const { buildSelectedDayBreakdown } = require('../audit_selected_day_breakdown.js');

function completion(id, date, fields = {}) {
  return {
    id,
    title: 'Audit completion ' + id,
    completedAtISO: date + 'T12:00:00.000Z',
    points: 1.25,
    source: 'task',
    ...fields
  };
}

function compareToLegacy(state, dateKeys) {
  const old = core.buildDailyBreakdowns(state);
  for (const day of dateKeys) {
    const snapshot = core.buildDaySnapshot(day, state);
    const next = buildSelectedDayBreakdown(state, day, {
      core,
      normalizedState: snapshot.state,
      dailyTotals: snapshot.rollups.dailyTotals
    });
    const previous = old[day] || { total: 0, categories: {} };
    assert.equal(next.total, previous.total, 'total ' + day);
    assert.deepEqual(next.categories, previous.categories, 'categories ' + day);
  }
}

test('Selected-day Audit matches legacy math with multiple categories, bonuses, and gaps', () => {
  const state = {
    completions: [
      completion('one', '2026-10-19', { points: 4 }),
      completion('two', '2026-10-21', { points: 2.75, source: 'habit' }),
      completion('three', '2026-10-21', { title: 'Calories (150)', calories: 150, points: 0 }),
      completion('four', '2026-10-23', { points: -0.25 }),
      completion('five', '2026-10-27', { title: 'Calories (0)', calories: 0, points: 2.5 }),
      completion('six', '2026-10-30', { title: 'Calorie entry', calories: 200, calLogBonusDisabled: true, points: 0 })
    ]
  };
  compareToLegacy(state, [
    '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21',
    '2026-10-22', '2026-10-23', '2026-10-27', '2026-10-30',
    '2026-11-01', '2026-11-02'
  ]);
});

test('Selected-day Audit matches legacy for historical and future records', () => {
  const completions = [];
  for (let day = 1; day <= 24; day++) {
    const key = '2026-09-' + String(day).padStart(2, '0');
    completions.push(completion('h-' + day, key, {
      points: day / 3,
      source: day % 3 === 0 ? 'habit' : 'task'
    }));
  }
  completions.push(completion('future', '2026-12-01', { points: 5 }));
  compareToLegacy({ completions }, [
    '2026-08-31', '2026-09-01', '2026-09-12', '2026-09-24',
    '2026-09-25', '2026-10-01', '2026-11-01', '2026-12-01',
    '2026-12-02'
  ]);
});

test('Empty history stays empty and does not generate spurious inertia', () => {
  compareToLegacy({ completions: [] }, ['2026-09-01', '2026-11-01']);
});

test('Audit uses the selected-day optimization without removing existing checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  assert.match(source, /<script src="audit_selected_day_breakdown\.js"><\/script>/);
  assert.match(source, /TaskPointsAuditSelectedDay\.buildSelectedDayBreakdown\(state, dateKey/);
  assert.doesNotMatch(source, /TaskPointsCore\.buildDailyBreakdowns\(state\)/);
  assert.match(source, /checks\.push\(\.\.\.buildSeasonChampionshipAuditChecks\(state, dateKey\)\)/);
  assert.match(source, /runNoOpPageVisitAudit\(state\)/);
  assert.match(source, /runStickyFieldPreservationAudit\(state\)/);
  assert.match(source, /runWeightVo2HistorySavePathAudit\(state\)/);
});
