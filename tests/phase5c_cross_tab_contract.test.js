const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('cross-tab saves cannot leave an older snapshot promoted as latest', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /function promoteCandidate\(db, candidate, raw, verifiedAtISO\)/);
  assert.match(source, /db\.transaction\(STORE, 'readwrite'\)/);
  assert.match(source, /const latestRequest = store\.get\('latest'\)/);
  assert.match(source, /const currentRaw = get\(KEY\)/);
  assert.match(source, /if \(currentRaw !== raw \|\| pendingJournal\)/);
  assert.match(source, /transaction\.abort\(\)/);
  assert.match(source, /if \(!pendingJournal && currentRaw\) queue\(currentRaw\)/);
  assert.match(source, /global\.addEventListener\('storage'/);
  assert.match(source, /event\?\.key === KEY/);
  assert.match(source, /if \(event\.newValue && get\(KEY\) === event\.newValue\)/);
  assert.match(source, /queue\(event\.newValue\)/);
});
