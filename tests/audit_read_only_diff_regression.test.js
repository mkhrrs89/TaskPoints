const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
const first = source.indexOf('function summarizeNoOpStateDiff(beforeState, afterState) {');
const next = source.indexOf('function summarizeValueShapeChange(beforeVal, afterVal) {', first);
assert.ok(first >= 0 && next > first, 'Audit comparison function exists');

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach(key => { out[key] = normalized(value[key]); });
  return out;
}
const stableStringify = value => JSON.stringify(normalized(value));
const excluded = new Set(['__auditRuntime']);
const actualDiff = new Function(
  'stableStringify', 'NO_OP_DIFF_EXCLUDED_KEYS',
  source.slice(first, next) + '\nreturn summarizeNoOpStateDiff;'
)(stableStringify, excluded);

function referenceDiff(beforeState, afterState) {
  const before = normalized(beforeState || {});
  const after = normalized(afterState || {});
  const changes = [];
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach(key => {
    if (excluded.has(key)) return;
    const hadBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (!hadBefore && hasAfter) {
      changes.push({ type: 'added', key, before: undefined, after: after[key] });
    } else if (hadBefore && !hasAfter) {
      changes.push({ type: 'dropped', key, before: before[key], after: undefined });
    } else if (stableStringify(before[key]) !== stableStringify(after[key])) {
      changes.push({ type: 'changed', key, before: before[key], after: after[key] });
    }
  });
  return changes;
}

function canonicalDiff(result) {
  return result.map(item => ({
    type: item.type,
    key: item.key,
    before: stableStringify(item.before),
    after: stableStringify(item.after)
  }));
}

test('Read-only Audit diff keeps exact classifications without duplicate state-wide normalization', () => {
  const cases = [
    [{ tasks: [{ id: 1, x: 2 }], __auditRuntime: 0 }, { tasks: [{ x: 2, id: 1 }], __auditRuntime: 1 }],
    [{ tasks: [{ id: 1, x: 2 }], habits: [] }, { tasks: [{ id: 1, x: 3 }], habits: [], notes: 'added' }],
    [{ completions: [{ id: 1 }], workHistory: [4], oldKey: { value: 3 } }, { completions: [{ id: 1 }], workHistory: [], newKey: { value: 5 } }],
    [{ nested: { a: [1, { c: 3, b: 2 }] } }, { nested: { a: [1, { b: 2, c: 3 }] } }],
    [{ nested: { a: [1, 2, 3] }, count: 0 }, { nested: { a: [1, 2, 4] }, count: 1 }]
  ];
  for (const [before, after] of cases) {
    const expected = canonicalDiff(referenceDiff(before, after));
    const actual = canonicalDiff(actualDiff(before, after));
    assert.deepEqual(actual, expected);
  }
});
