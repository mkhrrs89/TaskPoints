const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadAuditWorkHoursHelper() {
  const auditHtml = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  const fn = extractFunction(auditHtml, 'auditWorkHoursLast14Days');
  const context = {
    WORK_HOURS_AUDIT_DAYS: 14,
    WORK_HOURS_SUSPICIOUS_THRESHOLD: 24,
    TaskPointsCore: {
      todayKey: () => '2026-06-01',
      fromKey: (key) => new Date(`${key}T00:00:00`),
      dateKey: (value) => {
        if (!value) return '';
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        const text = String(value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        return new Date(text).toISOString().slice(0, 10);
      },
      getScoringSettings: () => ({}),
      deriveCompletionPoints: (entry) => ({ formula: entry.formula })
    }
  };
  vm.createContext(context);
  vm.runInContext(`${fn}; this.auditWorkHoursLast14Days = auditWorkHoursLast14Days;`, context);
  return context.auditWorkHoursLast14Days;
}

function workEntry(dateKey, workHours = 8) {
  return {
    id: `work-${dateKey}`,
    title: `Work ${dateKey}`,
    dateKey,
    formula: 'work',
    workHours
  };
}

function completedDaysThroughYesterday() {
  return Array.from({ length: 14 }, (_, idx) => {
    const d = new Date('2026-05-31T00:00:00');
    d.setDate(d.getDate() - idx);
    return d.toISOString().slice(0, 10);
  });
}

test('Work Hours audit checks the 14 completed days ending yesterday', () => {
  const auditWorkHoursLast14Days = loadAuditWorkHoursHelper();
  const completions = completedDaysThroughYesterday().map((day) => workEntry(day));

  const result = auditWorkHoursLast14Days({ completions }, '2026-06-01');

  assert.equal(result.issues.length, 0);
  assert.equal(result.days, 14);
});

test('Work Hours audit ignores missing today but flags yesterday, high, and non-numeric hours', () => {
  const auditWorkHoursLast14Days = loadAuditWorkHoursHelper();
  const completions = completedDaysThroughYesterday()
    .filter((day) => day !== '2026-05-31')
    .map((day) => workEntry(day));
  completions.find((entry) => entry.dateKey === '2026-05-30').workHours = 25;
  completions.find((entry) => entry.dateKey === '2026-05-29').workHours = 'abc';

  const result = auditWorkHoursLast14Days({ completions }, '2026-06-01');

  assert.equal(result.issues.some((issue) => issue.startsWith('2026-06-01:')), false);
  assert.equal(result.issues.some((issue) => issue.includes('2026-05-31: value=missing')), true);
  assert.equal(result.issues.some((issue) => issue.includes('2026-05-30: value=25')), true);
  assert.equal(result.issues.some((issue) => issue.includes('2026-05-29: value="abc"')), true);
});
