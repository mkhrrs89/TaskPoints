const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const streaksPage = fs.readFileSync(path.join(__dirname, '..', 'streaks.html'), 'utf8');

function keys(first, last) {
  const result = [];
  for (let key = first; key <= last; key = core.addDaysToDateKey(key, 1)) result.push(key);
  return result;
}
function habit(doneKeys, overrides = {}) {
  return {
    id: 'habit-a', name: 'Habit A', category: 'habit',
    streakMultiplierEnabled: true, streakMultiplierStartDateKey: '2026-10-12',
    daysPerCompleteWeek: 2, pointsPerDay: 10, doneKeys, ...overrides
  };
}
function entry(dayKey, fraction = 1, points = 10) {
  return {
    id: 'habit-' + dayKey, source: 'habit', habitId: 'habit-a',
    dayKey, completedAtISO: dayKey + 'T12:00:00.000Z',
    completionFraction: fraction, points
  };
}
function state(h, completions = null) {
  return { habits: [h], completions: completions ?? h.doneKeys.map(key => entry(key)) };
}
function status(h, s, key) {
  return core.getHabitFreezeStatus(h, s, key);
}

test('converts all earned silver weeks since Oct 12 into opening credits without past charges', () => {
  const done = keys('2026-10-12', '2026-11-01');
  const h = habit(done);
  const s = state(h);
  const opening = status(h, s, '2026-11-02');
  assert.equal(opening.earned, 3);
  assert.equal(opening.balance, 3);
  assert.equal(opening.spent, 0);
  assert.equal(opening.streak, 21);
  assert.deepEqual(opening.protectedDays, []);
});

test('two missed days each spend a freeze and preserve the 21-day bonus at 21, not 23', () => {
  const done = keys('2026-10-12', '2026-11-01');
  const h = habit([...done, '2026-11-04']);
  const s = state(h);
  const before = status(h, s, '2026-11-02');
  const afterOneMiss = status(h, s, '2026-11-03');
  const afterTwoMisses = status(h, s, '2026-11-04');
  assert.equal(before.balance, 3);
  assert.equal(afterOneMiss.balance, 2);
  assert.equal(afterTwoMisses.balance, 2);
  assert.equal(afterTwoMisses.earned, 4, 'the two white freezes make Nov 2–8 a silver week');
  assert.equal(afterTwoMisses.spent, 2);
  assert.deepEqual(afterTwoMisses.protectedDays, ['2026-11-02', '2026-11-03']);
  assert.equal(afterTwoMisses.streak, 22, 'only completed days count toward streak length');
  assert.equal(core.pointsForCompletion(entry('2026-11-04'), s), 12.32);
  assert.equal(s.completions.some(row => row.dayKey === '2026-11-02'), false);
  assert.equal(s.completions.some(row => row.dayKey === '2026-11-03'), false);
});

test('missing today does not spend a freeze until the next TaskPoints day', () => {
  const h = habit(['2026-10-26', '2026-10-27', '2026-10-31', '2026-11-01']);
  const s = state(h);
  assert.equal(status(h, s, '2026-11-02').spent, 0);
  assert.equal(status(h, s, '2026-11-03').spent, 1);
});

test('half completions preserve daily streak without consuming a freeze or earning full-week credit', () => {
  const days = ['2026-10-26', '2026-10-27', '2026-11-01', '2026-11-02'];
  const h = habit(days, { daysPerCompleteWeek: 2 });
  const s = state(h, [entry(days[0]), entry(days[1]), entry(days[2]), entry(days[3], 0.5, 5)]);
  const out = status(h, s, '2026-11-02');
  assert.equal(out.spent, 0);
  assert.equal(out.streak, 2);
  assert.equal(out.earned, 1, 'half completion contributes 0.5 to the silver threshold');
  assert.equal(core.pointsForCompletion(entry('2026-11-02', 0.5, 5), s), 5.05);
});

test('a first missed day after only one completion does not spend a freeze', () => {
  const h = habit(['2026-10-26', '2026-10-27', '2026-11-01']);
  const s = state(h);
  const out = status(h, s, '2026-11-03');
  assert.equal(out.earned, 1);
  assert.equal(out.spent, 0);
  assert.equal(out.balance, 1);
  assert.equal(out.streak, 0);
});

test('when the last freeze is spent, the next miss resets streak and bonus', () => {
  const h = habit(['2026-10-26', '2026-10-27', '2026-10-31', '2026-11-01', '2026-11-04'], { daysPerCompleteWeek: 3 });
  const s = state(h);
  const out = status(h, s, '2026-11-04');
  assert.equal(out.earned, 1);
  assert.equal(out.spent, 1);
  assert.deepEqual(out.protectedDays, ['2026-11-02']);
  assert.equal(out.balance, 0);
  assert.equal(out.streak, 1);
  assert.equal(core.pointsForCompletion(entry('2026-11-04'), s), 10);
});

test('backfilling a missed day refunds its freeze; editing a half day also recomputes awards', () => {
  const h = habit(keys('2026-10-12', '2026-11-01').concat('2026-11-04'));
  const s = state(h);
  const original = status(h, s, '2026-11-04');
  assert.equal(original.spent, 2);
  h.doneKeys.push('2026-11-02');
  s.completions.push(entry('2026-11-02'));
  const updated = status(h, s, '2026-11-04');
  assert.equal(updated.spent, 1);
  assert.equal(updated.earned, original.earned, 'the frozen week was already silver; backfill does not award it twice');
  assert.equal(updated.balance, original.balance + 1, 'restoring a completion refunds the one freeze');
  assert.equal(updated.streak, original.streak + 1);
  // Source state is not given a mutable "freezesRemaining" counter.
  assert.equal(Object.hasOwn(h, 'freezesRemaining'), false);
});

test('disabled multipliers and vices do not use freezes', () => {
  const h = habit(keys('2026-10-12', '2026-11-01'), { streakMultiplierEnabled: false });
  const s = state(h);
  assert.deepEqual(status(h, s, '2026-11-04'), {
    balance: 0, earned: 0, spent: 0, streak: 0, protectedDays: []
  });
  const vice = habit(h.doneKeys, { category: 'vice', streakMultiplierEnabled: true });
  assert.equal(status(vice, state(vice), '2026-11-04').spent, 0);
  assert.equal(status(vice, state(vice), '2026-11-04').earned, 0);
});

test('freeze threshold earns one as soon as met, never twice in one week', () => {
  const h = habit(['2026-11-02', '2026-11-03', '2026-11-04'], { daysPerCompleteWeek: 2 });
  const s = state(h);
  assert.equal(status(h, s, '2026-11-02').balance, 0);
  assert.equal(status(h, s, '2026-11-03').balance, 1);
  assert.equal(status(h, s, '2026-11-04').earned, 1);
});

test('Home displays balance for enabled habits and keeps silver count for disabled habits', () => {
  assert.match(home, /const freezeStatuses = new Map\(\)/);
  assert.match(home, /getHabitFreezeStatus\?\.\(\s*h,\s*\{ completions: completedRowsByHabit\.get\(String\(h\.id\)\) \|\| \[\] \}, currentFreezeDay\s*\)/);
  assert.match(home, /silverWeekCount: freezeStatuses\.get\(String\(h\.id\)\)\?\.balance \?\?/);
  assert.match(home, /freezeEnabled: freezeStatuses\.has\(String\(h\.id\)\)/);
  assert.match(home, /h\.__streak = status\.streak/);
  assert.match(home, /Available streak freezes/);
});


test('shared at-risk streak display retains the full protected streak and next-day bonus', () => {
  const h = habit(keys('2026-10-12', '2026-11-01'));
  const s = state(h);
  const rows = core.getAtRiskStreakRows(s, { todayKey: '2026-11-03', pendingDeltas: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].streak, 21, 'a protected November 2 miss keeps the previously earned streak');
  assert.equal(rows[0].bonus, 2.32);
  assert.equal(rows[0].pointsAtRisk, 2.32);
});

test('edited history never changes stored snapshots merely by reading freeze balances', () => {
  const h = habit(keys('2026-10-12', '2026-11-01'));
  const s = state(h);
  const before = JSON.stringify(s);
  const first = status(h, s, '2026-11-04');
  const second = status(h, s, '2026-11-04');
  assert.deepEqual(first, second, 'repeated renders do not burn additional freezes');
  assert.equal(JSON.stringify(s), before, 'balance calculations do not mutate canonical data');
});

test('Home uses the 5am TaskPoints day key for charging missed days', () => {
  assert.match(home, /const currentFreezeDay = getCurrentTaskPointsDayKey\(\)/);
  assert.match(home, /getHabitFreezeStatus\?\.\(\s*h,\s*\{ completions: completedRowsByHabit\.get\(String\(h\.id\)\) \|\| \[\] \}, currentFreezeDay\s*\)/);
});

test('Home indexes completion rows once for all habit freeze status calculations', () => {
  assert.match(home, /const completedRowsByHabit = new Map\(\)/);
  assert.match(home, /completedRowsByHabit\.get\(id\)\.push\(completion\)/);
  assert.match(home, /getHabitFreezeStatus\?\.\(/);
});

test('Streaks completed table follows canonical freeze-aware streak length', () => {
  assert.match(streaksPage, /currentStreak = core\.getHabitFreezeStatus\(projectedHabit, state, todayKey\)\.streak/);
  assert.match(streaksPage, /if \(currentStreak > 0\) current\.push\(makeRow\(habit, currentStreak, todayKey, state\)\)/);
  assert.match(streaksPage, /src="scoring_core\.js\?v=20261102-freeze-silver-credit-2"/);
});

test('a spent freeze is displayed as a white bubble with black numbers only on its protected day', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = styles.match(/\.habitDay\.off\.streak-freeze-used\s*\{([^}]+)\}/);
  assert.ok(rule, 'freeze-protected missed days have a dedicated visual rule');
  assert.match(rule[1], /background:\s*#ffffff\s*!important/);
  assert.match(rule[1], /color:\s*#000000\s*!important/);
  assert.match(rule[1], /font-weight:\s*800\s*!important/, 'frozen day number is bold');
  assert.match(home, /const protectedDayKeys = new Set\(options\.protectedDays \|\| \[\]\)/);
  assert.match(home, /const isFreezeProtected = status === 'off' && protectedDayKeys\.has\(d\.key\)/);
  assert.match(home, /const isPastIncomplete = !on && !isFreezeProtected/);
  assert.match(home, /isFreezeProtected \? ' streak-freeze-used' : ''/);
  assert.match(home, /protectedDays: freezeStatuses\.get\(String\(h\.id\)\)\?\.protectedDays \|\| \[\]/);
  assert.match(home, /'past-failed', 'streak-freeze-used'/, 'live taps clear stale freeze visuals');
});

test('a refunded or spent freeze changes the protected-day projection without changing completion data', () => {
  const h = habit(keys('2026-10-12', '2026-11-01').concat('2026-11-04'));
  const s = state(h);
  const before = status(h, s, '2026-11-04');
  assert.deepEqual(before.protectedDays, ['2026-11-02', '2026-11-03']);
  assert.equal(before.balance, 2);
  h.doneKeys.push('2026-11-02');
  s.completions.push(entry('2026-11-02'));
  const after = status(h, s, '2026-11-04');
  assert.deepEqual(after.protectedDays, ['2026-11-03']);
  assert.equal(after.balance, 3);
  assert.equal(after.earned, before.earned, 'backfilling a frozen day cannot earn the same silver week twice');
  assert.ok(!after.protectedDays.includes('2026-11-02'));
});
