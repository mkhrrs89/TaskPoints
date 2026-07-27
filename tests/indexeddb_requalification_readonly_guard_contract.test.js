const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_readonly_guard.js'), 'utf8');

test('opening or refreshing the checklist cannot flush or rewrite saved copies', () => {
  assert.doesNotThrow(() => new vm.Script(guard));
  assert.ok(page.indexOf('indexeddb_requalification_readonly_guard.js') < page.indexOf('indexeddb_requalification.js'));
  assert.match(guard, /flushPhase5CVerifiedSecondaryWrites/);
  assert.match(guard, /flushPhase4PrimaryWrites/);
  assert.match(guard, /flushPhase5ANativeSnapshotWrites/);
  assert.match(guard, /if \(permittedCalls <= 0\) return Promise\.resolve\(false\)/);
  assert.match(guard, /'startTestBtn', 'finishTestBtn'/);
  assert.doesNotMatch(guard, /refreshBtn/);
});
