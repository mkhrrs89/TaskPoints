const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('interrupted queued mirrors retry after page load without becoming a read source', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /existingStatus\.phase5cPendingWrite === true \|\| existingStatus\.phase5cLastStatus === 'queued'/);
  assert.match(source, /phase5cPendingWrite: interruptedWrite/);
  assert.match(source, /requestIdleCallback\(runRetry/);
  assert.match(source, /addEventListener\('load', retry, \{ once: true \}\)/);
  assert.match(source, /if \(latestRaw && journalCount\(\) === 0\) queue\(latestRaw\)/);
});

test('removing the authoritative save marks the verified secondary stale without deleting it', () => {
  assert.match(source, /function handleAuthoritativeRemoval\(\)/);
  assert.match(source, /phase5cLastStatus: 'authoritative_removed'/);
  assert.match(source, /phase5cMirrorsCurrentSave: false/);
  assert.match(source, /wrappedRemove = function phase5cRemoveItem/);
  assert.match(source, /prototype\.removeItem = function phase5cRemoveItem/);
  assert.match(source, /event\.newValue === null && get\(KEY\) === null/);
  assert.doesNotMatch(source, /deleteDatabase\s*\(/);
});
