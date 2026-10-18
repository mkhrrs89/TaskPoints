const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const start = home.indexOf('// Weekly silver milestones begin');
const end = home.indexOf('function addHabitWeeklyCompleteClasses(', start);
assert.ok(start >= 0 && end > start, 'weekly counter logic is present');

function setup() {
  const context = {
    Date, Map, Set, Number, Math, String,
    fromKey(key) {
      const [year, month, day] = String(key).split('-').map(Number);
      return new Date(year, month - 1, day, 12);
    },
    dateKey(d) {
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')].join('-');
    },
    startOfWeek(d) {
      const date = new Date(d);
      date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      return date;
    },
    getHabitCompletionFraction(c) {
      return Number(c?.completionFraction) === 0.5 ? 0.5 : 1;
    }
  };
  context.getCurrentTaskPointsDayKey = (now = new Date('2026-10-18T12:00:00')) => {
    const date = new Date(now);
    if (date.getHours() < 5) date.setDate(date.getDate() - 1);
    return context.dateKey(date);
  };
  vm.createContext(context);
  vm.runInContext(home.slice(start, end), context, { filename: 'habit-silver-week-counter.js' });
  return context.computeHabitSilverWeekCounts;
}
function habit(id, doneKeys, daysPerCompleteWeek = 2, createdAtISO = '2026-09-01T12:00:00.000Z') {
  return { id, name: id, category: 'habit', daysPerCompleteWeek, doneKeys, createdAtISO };
}

test('Oct 12–18 starts at zero and awards exactly one only at the silver threshold', () => {
  const count = setup();
  const habits = [
    habit('incomplete', ['2026-10-12', '2026-10-13'], 3),
    habit('threshold-met', ['2026-10-12', '2026-10-13', '2026-10-14'], 3),
    habit('historically-complete', ['2026-10-01', '2026-10-02'], 2),
    habit('missing-threshold', [], 0)
  ];
  assert.deepEqual(Array.from(count(habits, [], '2026-10-13').values()), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(count(habits, [], '2026-10-18').values()), [0, 1, 0, 0]);
});

test('future Monday–Sunday periods count once apiece, not once per day or per render', () => {
  const count = setup();
  const h = habit('a', ['2026-10-19', '2026-10-20', '2026-10-20', '2026-10-21',
    '2026-10-26', '2026-10-29', '2026-11-02']);
  assert.equal(count([h], [], '2026-10-19').get('a'), 0);
  assert.equal(count([h], [], '2026-10-20').get('a'), 1);
  assert.equal(count([h], [], '2026-10-29').get('a'), 2);
  assert.equal(count([h], [], '2026-10-29').get('a'), 2);
});

test('half completions contribute half a day; legacy missing completion is a full day', () => {
  const count = setup();
  const h = habit('half', ['2026-10-19', '2026-10-20', '2026-10-21']);
  const entries = [
    { source: 'habit', habitId: 'half', dayKey: '2026-10-19', completionFraction: 0.5 },
    { source: 'habit', habitId: 'half', dayKey: '2026-10-20', completionFraction: 0.5 }
  ];
  assert.equal(count([h], entries, '2026-10-20').get('half'), 0);
  assert.equal(count([h], entries, '2026-10-21').get('half'), 1);
});

test('Habit created after launch week starts at zero and can earn its first week', () => {
  const count = setup();
  const newHabit = habit('new', ['2026-10-20', '2026-10-22'], 2, '2026-10-20T12:00:00.000Z');
  assert.equal(count([newHabit], [], '2026-10-20').get('new'), 0);
  assert.equal(count([newHabit], [], '2026-10-22').get('new'), 1);
  const legacy = habit('legacy', [], 2);
  delete legacy.createdAtISO;
  assert.equal(count([legacy], [], '2026-10-18').get('legacy'), 0);
});

test('no configured threshold cannot earn new weeks; Vices remain unchanged', () => {
  const count = setup();
  const unconfigured = habit('no-threshold', ['2026-10-19', '2026-10-20'], 0);
  const vice = { ...habit('vice', ['2026-10-19', '2026-10-20']), category: 'vice' };
  const snapshot = JSON.stringify([unconfigured, vice]);
  const result = count([unconfigured, vice], [], '2026-10-20');
  assert.equal(result.get('no-threshold'), 0);
  assert.equal(result.has('vice'), false);
  assert.equal(JSON.stringify([unconfigured, vice]), snapshot, 'counter must be read-only');
});

test('counter renders a visible silver stat without replacing the silver slab logic', () => {
  assert.match(home, /const silverWeekCounts = computeHabitSilverWeekCounts\(habits, state\.completions\)/);
  assert.match(home, /silverWeekCount: silverWeekCounts\.get\(String\(h\.id\)\) \|\| 0/);
  assert.match(home, /class="tag habit-silver-weeks"/);
  assert.match(home, /isWeeklyComplete: isHabitWeeklyCompleteForDays\(h, days\)/);
  assert.match(styles, /\.habitRow \.habitLeft \.tag\.habit-silver-weeks/);
});


test('reaching the threshold during launch week increments from zero immediately', () => {
  const count = setup();
  const item = habit('silver-this-week', ['2026-10-12', '2026-10-15', '2026-10-18'], 3);
  assert.equal(count([item], [], '2026-10-17').get(item.id), 0);
  assert.equal(count([item], [], '2026-10-18').get(item.id), 1);
  assert.equal(count([item], [], '2026-10-19').get(item.id), 1,
    'the silver week is retained after the Monday rollover');
});

test('removing a qualifying completion recalculates the count rather than granting phantom credits', () => {
  const count = setup();
  const item = habit('corrected', ['2026-10-12', '2026-10-18'], 2);
  assert.equal(count([item], [], '2026-10-18').get(item.id), 1);
  item.doneKeys = ['2026-10-12'];
  assert.equal(count([item], [], '2026-10-18').get(item.id), 0);
});
