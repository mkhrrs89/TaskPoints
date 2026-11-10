'use strict';
// M01 V2-only, read-only inspection of existing Flex Action journals.
// This cannot certify production ownership, writer fencing, or live cutover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const begin = code.indexOf('  function inspectReadOnlyFlexJournalsForCutover() {');
const end = code.indexOf('  async function inspectAuthorityCutoverBarriers()', begin);
assert.ok(begin > 0 && end > begin);
const observer = code.slice(begin, end);
const COMPLETIONS = 'taskpoints_pending_flex_completions_v1';
const ORDER = 'taskpoints_pending_flex_order_v1';
function run(initial = {}, { rejectReads = false } = {}) {
  const stored = new Map(Object.entries(initial));
  const reads = [], writes = [];
  const ctx = { global: { localStorage: {
    getItem(key) {
      reads.push(key);
      if (rejectReads) throw Error('origin storage unavailable');
      return stored.get(key) ?? null;
    },
    setItem(...args) { writes.push(['set', ...args]); throw Error('observer wrote'); },
    removeItem(...args) { writes.push(['remove', ...args]); throw Error('observer deleted'); }
  }}, JSON, Number, Object, Array, String };
  vm.createContext(ctx);
  let result, error;
  try {
    vm.runInContext(observer + '\nresult = inspectReadOnlyFlexJournalsForCutover();',
      ctx, { filename: 'flex_cutover_observer.js' });
    result = ctx.result;
  } catch (e) { error = e; }
  return { result, error, reads, writes, stored };
}
const validCompletion = [{
  id: 'c1', flexId: 'flex1', source: 'flex', title: '[Flex] Read',
  completedAtISO: '2026-11-10T12:00:00.000Z', points: 4
}];
const validOrder = { version: 1, orderedIds: ['flex2', 'flex1'] };

test('both absent Flex journals are observed but cannot establish production fencing', () => {
  const x = run();
  assert.equal(x.result.completions.reason, 'absent');
  assert.equal(x.result.order.reason, 'absent');
  assert.deepEqual(x.reads, [COMPLETIONS, ORDER]);
  assert.equal(x.writes.length, 0);
});

test('separate completion and order journals are both reported pending with exact raw bytes', () => {
  const completionRaw = JSON.stringify(validCompletion);
  const orderRaw = JSON.stringify(validOrder);
  const x = run({ [COMPLETIONS]: completionRaw, [ORDER]: orderRaw });
  assert.equal(x.result.completions.reason, 'pending');
  assert.equal(x.result.completions.pendingCount, 1);
  assert.equal(x.result.completions.raw, completionRaw);
  assert.equal(x.result.order.reason, 'pending');
  assert.equal(x.result.order.pendingCount, 2);
  assert.equal(x.result.order.raw, orderRaw);
  assert.equal(x.stored.get(COMPLETIONS), completionRaw);
  assert.equal(x.stored.get(ORDER), orderRaw);
  assert.equal(x.writes.length, 0);
});

test('present empty completion journal remains unresolved, not mistaken for absent', () => {
  const x = run({ [COMPLETIONS]: '[]' });
  assert.equal(x.result.completions.reason, 'pending');
  assert.equal(x.result.completions.pendingCount, 0);
  assert.equal(x.result.order.reason, 'absent');
});

test('malformed Flex journals are kept without repair or deletion', () => {
  for (const raw of ['{broken', '', '{}', '[{}]',
    '[{"id":"c1","flexId":"flex1","source":"other","completedAtISO":"2026-11-10"}]']) {
    const x = run({ [COMPLETIONS]: raw });
    assert.equal(x.result.completions.reason, 'malformed', JSON.stringify(raw));
    assert.equal(x.result.completions.pendingCount, null);
    assert.equal(x.stored.get(COMPLETIONS), raw);
    assert.equal(x.writes.length, 0);
  }
  for (const raw of ['oops', '{}', '[]', '{"orderedIds":[]}',
    '{"orderedIds":[null]}', '{"orderedIds":[""]}']) {
    const x = run({ [ORDER]: raw });
    assert.equal(x.result.order.reason, 'malformed', JSON.stringify(raw));
    assert.equal(x.stored.get(ORDER), raw);
    assert.equal(x.writes.length, 0);
  }
});

test('denied reads fail the inspection and never mutate either journal', () => {
  const x = run({ [COMPLETIONS]: JSON.stringify(validCompletion) }, { rejectReads: true });
  assert.match(String(x.error?.message), /unavailable/);
  assert.equal(x.result, undefined);
  assert.equal(x.writes.length, 0);
});

test('cutover inspector scans both journals twice and refuses every kind of Flex handoff', () => {
  const gate = code.slice(end, code.indexOf('  // Explicit forensic inspection', end));
  for (const snippet of [
    'const flexJournalsBefore = inspectReadOnlyFlexJournalsForCutover();',
    'const flexJournalsAfter = inspectReadOnlyFlexJournalsForCutover();',
    'stableJson(flexJournalsBefore) !== stableJson(flexJournalsAfter)',
    "'flex_completion_journal_pending'",
    "'flex_completion_journal_malformed'",
    "'flex_order_journal_pending'",
    "'flex_order_journal_malformed'",
    "'flex_journal_compaction_handoff_not_validated'",
    "flexCompletionJournalEmpty: flexJournals?.completions?.reason === 'absent'",
    "flexOrderJournalEmpty: flexJournals?.order?.reason === 'absent'",
    'flexJournalCompactionHandoffValidated: false',
    "canPromote: false", "mutationAuthority: 'legacy_only'",
    'allLegacyWritersFenced: false'
  ]) assert.ok(gate.includes(snippet), 'Flex guard disappeared: '+snippet);
  assert.doesNotMatch(observer, /(?:setItem|removeItem|clear|saveStateSnapshot|mergeAndSaveState)\s*\(/);
  assert.doesNotMatch(gate, /(?:setItem|removeItem|clear)\s*\(/);
});
