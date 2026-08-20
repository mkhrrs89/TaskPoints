const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');

test('Flex reorder arrows journal the visible order before deferred compaction', () => {
  assert.match(source, /const ORDER_JOURNAL_KEY = 'taskpoints_pending_flex_order_v1';/);
  assert.match(source, /function captureRenderedFlexOrder\(\)/);
  assert.match(source, /const fastMoveFlexAction = function taskPointsFastMoveFlexAction/);
  assert.match(source, /global\.save = suppressedSave;/);
  assert.match(source, /writeOrderJournal\(orderedIds\)/);
  assert.match(source, /flex\.reorderDeferred/);
  assert.match(source, /scheduleSaveAfterPaint\(\{ resetRetry: true \}\)/);
  assert.match(source, /global\.moveFlexAction = fastMoveFlexAction;/);
});

test('pending Flex order survives reloads and participates in full snapshot verification', () => {
  assert.match(source, /applyOrderJournalToState\(state, orderRecord\.record\)/);
  assert.match(source, /if \(orderPending\) candidate = applyOrderJournalToState\(candidate, orderRecord\.record\);/);
  assert.match(source, /clearVerifiedOrderJournal\(storageKey\)/);
  assert.match(source, /event\.key !== ORDER_JOURNAL_KEY/);
  assert.match(source, /core\.PENDING_FLEX_ORDER_KEY = ORDER_JOURNAL_KEY;/);
});

test('reorder falls back to the legacy durable save if journaling is unavailable', () => {
  assert.match(source, /if \(!orderedIds\.length\) \{[\s\S]*priorSave\(\);/);
  assert.match(source, /could not journal the Flex Action reorder; using the normal durable save path/);
  assert.match(source, /catch \(error\) \{[\s\S]*priorSave\(\);/);
});
