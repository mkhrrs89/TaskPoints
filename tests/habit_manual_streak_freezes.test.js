const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;
const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function dates(first, last) {
  const result = [];
  for (let day = first; day <= last; day = core.addDaysToDateKey(day, 1)) result.push(day);
  return result;
}
function makeHabit(doneKeys, extra = {}) {
  return {
    id: 'h', category: 'habit', name: 'Habit',
    pointsPerDay: 10, daysPerCompleteWeek: 2,
    streakMultiplierEnabled: true, streakMultiplierStartDateKey: '2026-10-12',
    doneKeys, ...extra
  };
}
function state(h, fractions = {}) {
  return {
    habits: [h],
    completions: (h.doneKeys || []).map(day => ({
      id: 'h:' + day, source: 'habit', habitId: 'h', dayKey: day,
      completedAtISO: day + 'T12:00:00.000Z',
      completionFraction: Object.hasOwn(fractions, day) ? fractions[day] : 1,
      points: 10
    }))
  };
}

test('a manual October miss costs one credit and protects streak continuity', () => {
  const done = dates('2026-10-12', '2026-10-29').concat([
    '2026-10-31', '2026-11-01', '2026-11-02'
  ]);
  const h = makeHabit(done);
  const s = state(h);
  const old = core.getHabitFreezeStatus(h, s, '2026-11-03');
  assert.equal(old.earned, 3);
  assert.equal(old.streak, 3, 'a prior October miss broke the streak');

  const candidate = core.getHabitManualFreezeEligibility(h, s, '2026-10-30', '2026-11-03');
  assert.equal(candidate.ok, true);
  const applied = { ...h, manualStreakFreezeDays: ['2026-10-30'] };
  const next = core.getHabitFreezeStatus(applied, s, '2026-11-03');
  assert.equal(next.earned, old.earned);
  assert.equal(next.spent, old.spent + 1);
  assert.equal(next.balance, old.balance - 1);
  assert.equal(next.streak, old.streak + 18);
  assert.deepEqual(next.manualProtectedDays, ['2026-10-30']);
  assert.ok(next.protectedDays.includes('2026-10-30'));
  assert.equal(s.completions.some(c => c.dayKey === '2026-10-30'), false);
});

test('retroactive freeze before the Oct 12 earning system restores subsequent streak multiplier', () => {
  const done = dates('2026-09-28', '2026-10-06')
    .concat(dates('2026-10-08', '2026-11-01'));
  const h = makeHabit(done, { streakMultiplierStartDateKey: '2026-09-28' });
  const s = state(h);
  const next = { ...h, manualStreakFreezeDays: ['2026-10-07'] };
  const existingPoints = core.pointsForCompletion(s.completions.find(c => c.dayKey === '2026-10-08'), s);
  const nextPoints = core.pointsForCompletion(s.completions.find(c => c.dayKey === '2026-10-08'), {
    ...s, habits: [next]
  });
  const candidate = core.getHabitManualFreezeEligibility(h, s, '2026-10-07', '2026-11-02');
  assert.equal(candidate.ok, true);
  assert.equal(existingPoints, 10);
  assert.ok(nextPoints > existingPoints);
  assert.deepEqual(core.getHabitFreezeStatus(next, s, '2026-11-02').manualProtectedDays, ['2026-10-07']);
  assert.equal(s.completions.some(c => c.dayKey === '2026-10-07'), false);
});

test('manual freezes reserve budget while preserving all already-automatic protections', () => {
  const done = dates('2026-10-12', '2026-10-29').concat(['2026-10-31', '2026-11-01']);
  const h = makeHabit(done);
  const s = state(h);
  const before = core.getHabitFreezeStatus(h, s, '2026-11-03');
  assert.deepEqual(before.protectedDays, ['2026-11-02']);
  const approved = core.getHabitManualFreezeEligibility(h, s, '2026-10-30', '2026-11-03');
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.nextStatus.protectedDays, ['2026-10-30', '2026-11-02']);
  assert.equal(approved.nextStatus.spent, before.spent + 1);
  assert.equal(approved.nextStatus.balance, before.balance - 1);
});

test('manual override can be removed and one credit is refunded without changing earned history', () => {
  const done = dates('2026-10-12', '2026-11-01');
  const h = makeHabit(done, { manualStreakFreezeDays: ['2026-10-11'] });
  const s = state(h);
  const before = core.getHabitFreezeStatus(h, s, '2026-11-02');
  const after = core.getHabitFreezeStatus({ ...h, manualStreakFreezeDays: [] }, s, '2026-11-02');
  assert.equal(before.spent, 1);
  assert.equal(after.spent, 0);
  assert.equal(after.balance, before.balance + 1);
  assert.equal(after.earned, before.earned);
});

test('complete or half-complete manual dates are dormant and do not consume freezes', () => {
  const done = dates('2026-10-12', '2026-11-01');
  const h = makeHabit(done, { manualStreakFreezeDays: ['2026-10-13'] });
  const s = state(h, { '2026-10-13': 0.5 });
  const out = core.getHabitFreezeStatus(h, s, '2026-11-02');
  assert.equal(out.spent, 0);
  assert.deepEqual(out.manualProtectedDays, []);
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-10-14', '2026-11-02').reason, 'completed');
});

test('manual spending rejects future/current dates, vices, disabled multipliers and zero credits', () => {
  const done = ['2026-10-12']; // no silver week yet, so no credits exist
  const h = makeHabit(done);
  const s = state(h);
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-11-02', '2026-11-02').reason, 'not_closed');
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-11-03', '2026-11-02').reason, 'not_closed');
  assert.equal(core.getHabitManualFreezeEligibility({ ...h, category: 'vice' }, s, '2026-10-20', '2026-11-02').reason, 'disabled');
  assert.equal(core.getHabitManualFreezeEligibility({ ...h, streakMultiplierEnabled: false }, s, '2026-10-20', '2026-11-02').reason, 'disabled');
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-10-20', '2026-11-02').reason, 'no_credits');
});

test('automatic protected days cannot be billed again by a manual action', () => {
  const done = dates('2026-10-12', '2026-11-01');
  const h = makeHabit(done);
  const s = state(h);
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-11-02', '2026-11-03').reason, 'already_auto');
});

test('freeze projection is read-only and manual dates persist across normalization', () => {
  const done = dates('2026-10-12', '2026-11-01');
  const h = makeHabit(done, { manualStreakFreezeDays: ['2026-10-11'] });
  const s = state(h);
  const original = JSON.stringify(s);
  const first = core.getHabitFreezeStatus(h, s, '2026-11-03');
  const second = core.getHabitFreezeStatus(h, s, '2026-11-03');
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(s), original);
  assert.deepEqual(core.normalizeState(s).habits[0].manualStreakFreezeDays, ['2026-10-11']);
});

test('Home long press never also toggles a completion and the popup verifies saves', () => {
  assert.match(home, /setTimeout\(\(\) => \{[\s\S]*?showHabitFreezePopup\(gesture\.habitId, gesture\.dayKey\);[\s\S]*?\}, 550\)/);
  assert.match(home, /if \(gesture\.longPressed\) \{[\s\S]*?return; \/\/ a long press never also toggles completion/);
  assert.match(home, /if \(dx > 12 \|\| dy > 12\) \{[\s\S]*?clearLongPressTimer\(tap\)/);
  assert.match(home, /wrap\.addEventListener\('contextmenu'/);
  assert.match(home, /parseTaskPointsStorageJson\(localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(home, /if \(!verified\) \{[\s\S]*?current\.manualStreakFreezeDays = oldDays/);
  assert.match(home, /renderHabits\(\)/);
  assert.match(css, /\.habit-freeze-action-overlay/);
  assert.match(css, /\.habitDay\.off\.streak-freeze-used/);
});
