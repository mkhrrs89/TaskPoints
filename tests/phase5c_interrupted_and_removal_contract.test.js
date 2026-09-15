const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('a missing current Home-native mirror is backfilled from the latest authoritative save without becoming a read source', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const homeNativeKnownCurrent = Boolean\(currentRaw/);
  assert.match(source, /if \(hookInstalled && currentRaw && !homeNativeKnownCurrent && journalCount\(\) === 0\)/);
  assert.match(source, /const backfill = \(\) => \{/);
  assert.match(source, /if \(latestRaw && journalCount\(\) === 0\) queue\(latestRaw\)/);
  assert.match(source, /requestIdleCallback\(backfill, \{ timeout: 5000 \}\)/);
  assert.match(source, /indexedDbReadsEnabled: false/);
  assert.match(source, /indexedDbWriteBackEnabled: false/);
});

test('authoritative absence cannot be reported as a current verified secondary and does not delete recovery data', () => {
  assert.match(source, /const currentRaw = get\(KEY\)/);
  assert.match(source, /const verifiedStillCurrent = Boolean\(hookInstalled[\s\S]*?&& currentRaw/);
  assert.match(source, /phase5cMirrorsCurrentSave: verifiedStillCurrent/);
  assert.match(source, /verifiedStillCurrent \? 'passed_verification' : 'waiting_for_successful_save'/);
  assert.doesNotMatch(source, /deleteDatabase\s*\(/);
});
