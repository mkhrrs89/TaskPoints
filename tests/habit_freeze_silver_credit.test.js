const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function days(first, last) {
  const result = [];
  for (let key = first; key <= last; key = core.addDaysToDateKey(key, 1)) result.push(key);
  return result;
}
function habit(doneKeys, extra = {}) {
  return {
    id: 'h', category: 'habit', name: 'Habit', pointsPerDay: 10,
    streakMultiplierEnabled: true, streakMultiplierStartDateKey: '2026-10-12',
    daysPerCompleteWeek: 2, doneKeys, ...extra
  };
}
function entry(dayKey, fraction = 1) {
  return { id: 'h:' + dayKey, habitId: 'h', source: 'habit', dayKey,
    completedAtISO: dayKey + 'T12:00:00.000Z', points: 10 * fraction,
    completionFraction: fraction };
}
function state(h, custom = null) {
  return { habits: [h], completions: custom || h.doneKeys.map(key => entry(key)) };
}
function status(h, s, day = '2026-11-04') {
  return core.getHabitFreezeStatus(h, s, day);
}

test('a manually frozen white day fills the silver threshold and awards one credit', () => {
  const h = habit(['2026-10-12', '2026-10-13', '2026-10-26']);
  const s = state(h);
  const before = status(h, s, '2026-10-28');
  assert.equal(before.earned, 1);
  assert.equal(before.balance, 1);
  assert.equal(core.getHabitManualFreezeEligibility(h, s, '2026-10-27', '2026-10-28').ok, true);
  const frozen = { ...h, manualStreakFreezeDays: ['2026-10-27'] };
  const after = status(frozen, s, '2026-10-28');
  assert.equal(after.earned, 2, 'Oct 26 completed + Oct 27 frozen make a silver week');
  assert.equal(after.spent, 1);
  assert.equal(after.balance, 1, 'freeze earned from silver offsets the freeze spent');
  assert.deepEqual(after.protectedDays, ['2026-10-27']);
  assert.equal(s.completions.some(c => c.dayKey === '2026-10-27'), false,
    'no fake completion or reward');
});

test('an automatic white day can complete a silver week and credit is usable later', () => {
  const completed = ['2026-10-12', '2026-10-13',
    '2026-10-31', '2026-11-01', '2026-11-02'];
  const h = habit(completed);
  const s = state(h);
  const asOf = status(h, s, '2026-11-04');
  assert.deepEqual(asOf.protectedDays, ['2026-11-03']);
  assert.equal(asOf.earned, 3, 'Nov 2 completion + Nov 3 white day are silver');
  assert.equal(asOf.spent, 1);
  assert.equal(asOf.balance, 2);
});

test('two frozen days in one week still grant just one silver freeze', () => {
  const h = habit(days('2026-10-12', '2026-11-01'));
  const s = state(h);
  const out = status(h, s, '2026-11-05');
  assert.deepEqual(out.protectedDays, ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(out.earned, 4, 'three white days in Nov 2 week count as only one silver');
  assert.equal(out.spent, 3);
  assert.equal(out.balance, 1);
});

test('half completions remain half a silver day alongside frozen white days', () => {
  const h = habit(['2026-10-12','2026-10-13', '2026-10-26', '2026-10-28'],
    { manualStreakFreezeDays: ['2026-10-27'] });
  const s = state(h, [entry('2026-10-12'), entry('2026-10-13'),
    entry('2026-10-26', 0.5), entry('2026-10-28', 0.5)]);
  const mid = status(h, s, '2026-10-28');
  assert.equal(mid.earned, 1, 'half day plus freeze = only 1.5, no silver');
  const end = status(h, s, '2026-10-29');
  assert.equal(end.earned, 2, '0.5 + 1 frozen + 0.5 = silver');
});

test('automatic freezes cannot self-create an initial credit', () => {
  const h = habit([], { daysPerCompleteWeek: 1 });
  const s = state(h);
  const empty = status(h, s, '2026-11-05');
  assert.equal(empty.earned, 0);
  assert.equal(empty.spent, 0);
  assert.equal(empty.balance, 0);
  assert.deepEqual(empty.protectedDays, []);
});

test('a silver-earning manual override still respects credit balance and existing auto protections', () => {
  const h = habit(days('2026-10-12','2026-10-29')
    .concat(['2026-10-31','2026-11-01']));
  const s = state(h);
  const before = status(h, s, '2026-11-03');
  const approval = core.getHabitManualFreezeEligibility(h, s, '2026-10-30', '2026-11-03');
  assert.equal(approval.ok, true);
  const after = approval.nextStatus;
  assert.ok(after.spent >= before.spent + 1);
  assert.equal(after.balance, before.balance + (after.earned - before.earned)
    - (after.spent - before.spent));
  for (const day of before.protectedDays) assert.ok(after.protectedDays.includes(day));
});

test('Home silver slab counts frozen days without counting them as habit completions', () => {
  const start = home.indexOf('function isHabitWeeklyCompleteForDays(');
  const end = home.indexOf('// Silver weeks count only after an actual weekly threshold', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    Set, Number, Math,
    state: {},
    TaskPointsCore: { getHabitFreezeStatus() { throw Error('cached frozen dates were ignored'); } },
    getCurrentTaskPointsDayKey() { return '2026-11-04'; },
    getHabitCompletionFraction(entry) { return Number(entry?.completionFraction) === 0.5 ? 0.5 : 1; },
    findHabitCompletionForDay() { return null; }
  };
  vm.createContext(context);
  vm.runInContext(home.slice(start, end), context);
  const week = days('2026-10-26', '2026-11-01').map(key => ({ key }));
  const h = habit(['2026-10-26']);
  assert.equal(context.isHabitWeeklyCompleteForDays(h, week, null, []), false);
  assert.equal(context.isHabitWeeklyCompleteForDays(h, week, null, ['2026-10-27']), true);
  assert.deepEqual(h.doneKeys, ['2026-10-26'], 'silver UI never marks the white day completed');
  assert.match(home, /protectedDays: freezeStatuses\.get\(String\(h\.id\)\)\?\.protectedDays \|\| \[\]/);
});
