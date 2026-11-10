'use strict';
// V2-only read-only Inbox cutover observer. Testing the real observer source
// does not certify V2 writer ownership, cross-tab fencing or promotion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const runtime = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const begin = runtime.indexOf('  function inspectReadOnlyInboxJournalForCutover() {');
const finish = runtime.indexOf('  async function inspectAuthorityCutoverBarriers()', begin);
assert.ok(begin > 0 && finish > begin, 'actual read-only Inbox observer must exist');
const observer = runtime.slice(begin, finish);
const KEY = 'taskpoints_pending_inbox_state_v1';

function inspect(raw = null, { failure = false } = {}) {
  const values = new Map();
  if (raw !== null) values.set(KEY, raw);
  const readKeys = [], writes = [];
  const localStorage = {
    getItem(key) {
      readKeys.push(key);
      if (failure) throw Error('private data inaccessible');
      return values.get(key) ?? null;
    },
    setItem(...args) { writes.push(['setItem', ...args]); throw Error('observer wrote'); },
    removeItem(...args) { writes.push(['removeItem', ...args]); throw Error('observer removed'); }
  };
  const ctx = { global: { localStorage }, JSON, Object, Number, Array, Error };
  vm.createContext(ctx);
  let result, error;
  try {
    vm.runInContext(observer + '\nresult = inspectReadOnlyInboxJournalForCutover();',
      ctx, { filename: 'state_runtime_v2_inbox_cutover_observer.js' });
    result = ctx.result;
  } catch (caught) { error = caught; }
  return { result, error, readKeys, writes, rawAfter: values.get(KEY) ?? null };
}

test('missing Inbox journal is absent, not proof that its producer is production fenced', () => {
  const x = inspect();
  assert.equal(x.error, undefined);
  assert.equal(x.result.reason, 'absent');
  assert.equal(x.result.pendingCount, 0);
  assert.equal(x.result.messages, 0);
  assert.equal(x.result.processedEventIds, 0);
  assert.deepEqual(x.readKeys, [KEY]);
  assert.equal(x.writes.length, 0);
});

test('real V1 array and V2 map shapes remain pending even with empty message arrays', () => {
  for (const record of [
    { schemaVersion: 1, inboxMessages: [], inboxProcessedEventIds: ['event-a', 'event-b'] },
    { schemaVersion: 2, inboxMessages: [{ id: 'message-1' }],
      inboxProcessedEventIds: { 'event-a': true },
      inboxStartedDateKey: '2026-11-10' },
    { schemaVersion: 2, inboxMessages: [], inboxProcessedEventIds: {} },
    { schemaVersion: 2, goldTheftTop50InboxStartedDateKey: null }
  ]) {
    const raw = JSON.stringify(record);
    const x = inspect(raw);
    assert.equal(x.error, undefined);
    assert.equal(x.result.reason, 'pending', raw);
    assert.equal(x.result.raw, raw);
    assert.equal(x.rawAfter, raw, 'inspection must not rewrite pending/legacy journal');
    assert.equal(x.writes.length, 0);
  }
});

test('corrupt, invalid and unrecognized Inbox journal evidence cannot be classified absent', () => {
  const values = [
    '{not-json',
    '',
    '[]',
    '{"schemaVersion":9,"inboxMessages":[]}',
    '{"schemaVersion":2,"inboxMessages":{}}',
    '{"schemaVersion":2,"inboxProcessedEventIds":null}',
    '{"schemaVersion":2,"inboxStartedDateKey":[]}',
    '{"schemaVersion":2,"unrelatedField":true}'
  ];
  for (const raw of values) {
    const x = inspect(raw);
    assert.equal(x.error, undefined);
    assert.equal(x.result.reason, 'malformed', JSON.stringify(raw));
    assert.equal(x.result.pendingCount, null);
    assert.equal(x.rawAfter, raw);
    assert.equal(x.writes.length, 0);
  }
});

test('denied Inbox journal read throws for outer cutover gate to refuse the inspection', () => {
  const x = inspect(null, { failure: true });
  assert.match(String(x.error?.message), /private data inaccessible/);
  assert.equal(x.result, undefined);
  assert.equal(x.writes.length, 0);
});

test('full V2 cutover gate checks Inbox journal twice and never turns the result into admission', () => {
  const gate = runtime.slice(finish,
    runtime.indexOf('  // Explicit forensic inspection', finish));
  for (const required of [
    "const inboxJournalBefore = inspectReadOnlyInboxJournalForCutover();",
    "const inboxJournalAfter = inspectReadOnlyInboxJournalForCutover();",
    "stableJson(inboxJournalBefore) !== stableJson(inboxJournalAfter)",
    "'inbox_mutation_journal_pending'",
    "'inbox_mutation_journal_malformed'",
    "'inbox_journal_compaction_handoff_not_validated'",
    "inboxJournalEmpty: inboxJournal?.reason === 'absent'",
    'inboxJournalCompactionHandoffValidated: false',
    'canPromote: false',
    "mutationAuthority: 'legacy_only'",
    'allLegacyWritersFenced: false'
  ]) assert.ok(gate.includes(required), 'missing fail-closed Inbox cutover guard: ' + required);
  assert.doesNotMatch(observer, /(?:setItem|removeItem|clear|saveStateSnapshot|mergeAndSaveState)\s*\(/);
  assert.doesNotMatch(gate, /(?:setItem|removeItem|clear)\s*\(/);
});
