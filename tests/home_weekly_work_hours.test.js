const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function extractFunction(name) {
  const start = home.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'Missing ' + name);
  const braceAt = home.indexOf('{', start);
  let depth = 0;
  for (let i = braceAt; i < home.length; i++) {
    if (home[i] === '{') depth++;
    if (home[i] === '}' && --depth === 0) return home.slice(start, i + 1);
  }
  throw new Error('Unclosed function: ' + name);
}

const dateKey = date => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0')
].join('-');

const context = { dateKey, console };
vm.createContext(context);
vm.runInContext([
  'const HOME_WORK_HOURS_GOAL = 40;',
  extractFunction('calculateHomeWeeklyWorkHours'),
  extractFunction('formatHomeWorkHours'),
  'this.calculate = calculateHomeWeeklyWorkHours;',
  'this.format = formatHomeWorkHours;'
].join('\n'), context);

const calculate = (entries, day = '2026-10-28') =>
  context.calculate(entries, new Date(day + 'T12:00:00'));

function entry(day, hours, score = 7) {
  return {
    title: 'Work Score (' + score + ') — Hours ' + hours,
    source: 'work',
    completedAtISO: new Date(day + 'T12:00:00').toISOString(),
    workHours: hours
  };
}

test('Work Hours card sits below the graph row and above Reminders/Streak Bonus', () => {
  const graph = home.indexOf('id="homeGraphWidget"');
  const hours = home.indexOf('id="homeWorkHoursSection"');
  const reminders = home.indexOf('id="remindersSection"');
  const streak = home.indexOf('id="homeReminderSidecar"');
  assert.ok(graph >= 0 && graph < hours && hours < reminders && reminders < streak);
  for (const id of ['homeWorkHoursLogged', 'homeWorkHoursRemaining',
    'homeWorkHoursProgress', 'homeWorkHoursStatus', 'homeWorkHoursWeek']) {
    assert.match(home, new RegExp('id="' + id + '"'));
  }
  assert.match(styles, /\.home-work-hours-card\s*\{/);
});

test('work week starts Monday, ends Sunday, and counts current week hours only', () => {
  const summary = calculate([
    entry('2026-10-25', 11), // previous Sunday
    entry('2026-10-26', 8),
    entry('2026-10-27', 8),
    entry('2026-10-28', 8),
    entry('2026-11-02', 9) // next Monday
  ]);
  assert.equal(dateKey(summary.weekStart), '2026-10-26');
  assert.equal(dateKey(summary.weekEnd), '2026-11-01');
  assert.equal(summary.logged, 24);
  assert.equal(summary.remaining, 16);
  assert.equal(summary.progress, 60);
});

test('Monday automatically starts a fresh week even with last Sunday hours present', () => {
  const entries = [entry('2026-11-01', 8), entry('2026-10-31', 5), entry('2026-10-30', 8)];
  const before = calculate(entries, '2026-11-01');
  const after = calculate(entries, '2026-11-02');
  assert.equal(before.logged, 21);
  assert.equal(after.logged, 0);
  assert.equal(after.remaining, 40);
  assert.equal(dateKey(after.weekStart), '2026-11-02');
});

test('PTO with primary score zero still adds eight logged hours', () => {
  const summary = calculate([entry('2026-10-27', 8, 0)]);
  assert.equal(summary.logged, 8);
  assert.equal(summary.remaining, 32);
});

test('decimal hours are summed, formatted, and never rounded to whole hours', () => {
  const summary = calculate([entry('2026-10-26', 7.75), entry('2026-10-27', 8.5)]);
  assert.equal(summary.logged, 16.25);
  assert.equal(summary.remaining, 23.75);
  assert.equal(context.format(summary.logged), '16.25');
});

test('hitting 40 stops remaining at zero and overtime is preserved', () => {
  const entries = [
    entry('2026-10-26', 10), entry('2026-10-27', 10),
    entry('2026-10-28', 10), entry('2026-10-29', 12.5)
  ];
  const summary = calculate(entries);
  assert.equal(summary.logged, 42.5);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.over, 2.5);
  assert.equal(summary.progress, 100);
});

test('duplicate SCWM Work records on the same date do not double-count', () => {
  const summary = calculate([
    entry('2026-10-27', 8.25),
    entry('2026-10-27', 8),
    entry('2026-10-26', 6)
  ]);
  assert.equal(summary.logged, 14.25);
});

test('invalid or missing hours and non-Work completions do not inflate totals', () => {
  const bad = [
    entry('2026-10-26', 'garbage'),
    entry('2026-10-27', -5),
    { ...entry('2026-10-28', 10), source: 'mood', title: 'Mood Score (7)' },
    { ...entry('2026-10-29', 12), source: 'calories', title: 'Calories (2100)' }
  ];
  const summary = calculate(bad);
  assert.equal(summary.logged, 0);
  assert.equal(summary.remaining, 40);
});

test('legacy Work title Hours can be used when field is absent', () => {
  const row = { ...entry('2026-10-27', 8.25) };
  delete row.workHours;
  const summary = calculate([row]);
  assert.equal(summary.logged, 8.25);
});

test('original Work SCWM editing and saving paths remain intact', () => {
  assert.match(home, /function saveWorkScore\(\)/);
  assert.match(home, /function submitWorkEditModal\(\)/);
  assert.match(home, /markCompletionsDirty\(\);\s*save\(\);\s*scheduleRender\(renderAll\)/);
  assert.match(home, /renderHomeWorkHours\(\)/);
  assert.match(home, /startHomeWorkHoursWeekRollover\(\)/);
  assert.match(home, /refreshMainPageIfChanged\('visibilitychange'\);\s*renderHomeWorkHours\(\)/);
});

test('rendered card responds immediately to SCWM Hours edits and changes the progress UI', () => {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const row = entry(dateKey(monday), 8);
  const entries = [row];

  const ids = ['homeWorkHoursLogged', 'homeWorkHoursRemaining', 'homeWorkHoursWeek',
    'homeWorkHoursProgress', 'homeWorkHoursProgressTrack', 'homeWorkHoursStatus'];
  const nodes = new Map(ids.map(id => [id, {
    textContent: '', style: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  }]));
  const render = new Function('$', 'getDerived', 'calculateHomeWeeklyWorkHours',
    'formatHomeWorkHours', extractFunction('renderHomeWorkHours') +
    '\nreturn renderHomeWorkHours;')(
    id => nodes.get(id),
    () => ({ workEntries: entries }),
    context.calculate, context.format
  );

  render();
  assert.equal(nodes.get('homeWorkHoursLogged').textContent, '8');
  assert.equal(nodes.get('homeWorkHoursRemaining').textContent, '32');
  assert.equal(nodes.get('homeWorkHoursProgress').style.width, '20%');
  assert.equal(nodes.get('homeWorkHoursProgressTrack').attributes['aria-valuenow'], '8');

  row.workHours = 40;
  render();
  assert.equal(nodes.get('homeWorkHoursRemaining').textContent, '0');
  assert.equal(nodes.get('homeWorkHoursStatus').textContent, '40-hour goal reached!');

  row.workHours = 42.5;
  render();
  assert.equal(nodes.get('homeWorkHoursLogged').textContent, '42.5');
  assert.equal(nodes.get('homeWorkHoursProgress').style.width, '100%');
  assert.equal(nodes.get('homeWorkHoursStatus').textContent, '2.5 hours over your 40-hour goal');
});

test('a single read-only week rollover timer is scheduled on boot', () => {
  const scheduled = [];
  const timer = new Function('setTimeout', 'renderHomeWorkHours',
    extractFunction('startHomeWorkHoursWeekRollover') +
    '\nreturn startHomeWorkHoursWeekRollover;')(
    (fn, delay) => scheduled.push({ fn, delay }),
    () => {}
  );
  timer();
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay >= 1000);
  assert.ok(scheduled[0].delay <= 7 * 24 * 60 * 60 * 1000 + 2000);
});

test('Work Hours card uses exactly the same teal gradient as Inertia and Reminders', () => {
  const sharedGradient = /--tp-btn-teal-grad:\s*linear-gradient\(180deg,\s*#254C52,\s*#1A383B\)/;
  const workCard = styles.match(/\.home-work-hours-card\s*\{([^}]+)\}/)?.[1] || '';
  const inertiaCard = styles.match(/\.inertiaPanelLeft\s*\{([^}]+)\}/)?.[1] || '';
  const remindersHeader = styles.match(/\.sectionCard--teal\s+\.sectionHeader--teal\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(styles, sharedGradient);
  for (const block of [workCard, inertiaCard, remindersHeader]) {
    assert.match(block, /background:\s*var\(--tp-btn-teal-grad\);/);
  }
});
