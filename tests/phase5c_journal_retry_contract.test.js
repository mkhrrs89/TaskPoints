const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('clearing the habit journal requeues the current authoritative snapshot', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /storageKey === JOURNAL && journalCount\(\) === 0/);
  assert.match(source, /const currentRaw = get\(KEY\)/);
  assert.match(source, /if \(currentRaw\) queue\(currentRaw\)/);
});
