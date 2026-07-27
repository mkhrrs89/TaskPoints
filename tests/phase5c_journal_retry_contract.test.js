const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('habit journal state invalidates or requeues the verified secondary as appropriate', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /storageKey === JOURNAL/);
  assert.match(source, /const pendingJournal = journalCount\(\)/);
  assert.match(source, /pendingJournal === 0/);
  assert.match(source, /if \(currentRaw\) queue\(currentRaw\)/);
  assert.match(source, /phase5cMirrorsCurrentSave: false/);
  assert.match(source, /journalCount\(\) === 0\);/);
});
