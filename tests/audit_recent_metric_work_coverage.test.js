const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const auditHtml = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');

function loadRecentCoverageAudit() {
  const start = auditHtml.indexOf('function auditRecentMetricCoverage(');
  const end = auditHtml.indexOf('function auditWorkHoursLast14Days(', start);
  assert.ok(start >= 0 && end > start, 'Expected standalone recent metric coverage helper');
  const source = auditHtml.slice(start, end);

  const core = {
    todayKey: () => '2026-10-28',
    fromKey: key => new Date(key + 'T12:00:00'),
    dateKey: input => input instanceof Date
      ? [input.getFullYear(), String(input.getMonth() + 1).padStart(2, '0'), String(input.getDate()).padStart(2, '0')].join('-')
      : String(input || '').slice(0, 10),
    getScoringSettings: () => ({}),
    deriveCompletionPoints: entry => ({ formula: entry.source })
  };
  const context = { TaskPointsCore: core };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.auditRecentMetricCoverage = auditRecentMetricCoverage;', context);
  return state => context.auditRecentMetricCoverage(state, '2026-10-28');
}

const coverage = loadRecentCoverageAudit();
const DAYS = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const WEEKDAYS = DAYS.filter(day => !['2026-10-24', '2026-10-25'].includes(day));

function metric(day, source) {
  return { dateKey: day, source, title: source === 'mood' ? 'Mood Score (7)' : 'Calories (2000)' };
}
function work(day, score, hours = 8) {
  return {
    dateKey: day,
    source: 'work',
    title: 'Work Score (' + score + ')' + (hours === undefined ? '' : ' — Hours ' + hours),
    ...(hours === undefined ? {} : { workHours: hours })
  };
}
function completeWeek() {
  return [
    ...DAYS.flatMap(day => [metric(day, 'mood'), metric(day, 'calories')]),
    ...WEEKDAYS.map(day => work(day, 7, 8))
  ];
}
function issues(completions) {
  return Array.from(coverage({ completions }).issues);
}

test('all seven past days require mood and calories but only weekdays require Work', () => {
  const outcome = coverage({ completions: completeWeek() });
  assert.equal(outcome.days, 7);
  assert.deepEqual(Array.from(outcome.issues), []);
});

test('missing weekday Work warns about primary score even when mood/calories are present', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-27'));
  assert.deepEqual(issues(rows), ['2026-10-27: missing primary Work Score']);
});

test('explicit zero primary Work Score on a weekday exempts Hours (day off)', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-26'));
  rows.push(work('2026-10-26', 0, undefined));
  assert.deepEqual(issues(rows), []);
});

test('PTO is valid with primary Work Score 0 and 8 Hours', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-26'));
  rows.push(work('2026-10-26', 0, 8));
  assert.deepEqual(issues(rows), []);
});

test('positive primary Work Score requires a positive, numeric Hours value', () => {
  for (const hours of [undefined, null, '', 0, 'abc', -1]) {
    const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-26'));
    rows.push(work('2026-10-26', 7, hours));
    assert.deepEqual(issues(rows), ['2026-10-26: missing Work Hours for nonzero primary Work Score'],
      'Unexpected Hours validation for ' + String(hours));
  }
});

test('Hours embedded in an older Work title count when the separate field is absent', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-27'));
  rows.push({ dateKey: '2026-10-27', title: 'Work Score (6) — Hours 8', source: 'work' });
  assert.deepEqual(issues(rows), []);
});

test('a malformed Work title cannot masquerade as a valid primary score', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-27'));
  rows.push({ dateKey: '2026-10-27', title: 'Work Score (oops) — Hours 8', source: 'work', workHours: 8 });
  assert.deepEqual(issues(rows), ['2026-10-27: missing primary Work Score (entry has no valid numeric score)']);
});

test('a duplicate zero-score record cannot hide missing Hours on a worked day', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'work' && entry.dateKey === '2026-10-27'));
  rows.push(work('2026-10-27', 0, 8));
  rows.push(work('2026-10-27', 5, 0));
  assert.deepEqual(issues(rows), ['2026-10-27: missing Work Hours for nonzero primary Work Score']);
});

test('weekends still require mood/calories but never Work or Hours', () => {
  const rows = completeWeek().filter(entry => !(entry.source === 'mood' && entry.dateKey === '2026-10-24'));
  rows.push(work('2026-10-24', 7, undefined));
  assert.deepEqual(issues(rows), ['2026-10-24: missing mood']);
});

test('today and days outside the past seven are not required', () => {
  const rows = completeWeek();
  rows.push(work('2026-10-28', 7, undefined));
  assert.deepEqual(issues(rows), []);
});

test('existing audit remains in place and shows the same warning status/detail semantics', () => {
  assert.match(auditHtml, /id: 'recent-metric-coverage'/);
  assert.match(auditHtml, /status: recentMissingMetrics.length \? 'WARN' : 'PASS'/);
  assert.match(auditHtml, /const workHoursAudit = auditWorkHoursLast14Days\(state\)/,
    'Retain the separate 14-day Work Hours validation check');
});
