const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase2_dual_write.js'), 'utf8');

test('Home Phase 2 shadow dual-write requires sustained quiet without changing explicit flush behavior', () => {
  assert.match(source, /const HOME_LONG_QUIET_MS = 8000;/);
  assert.match(source, /homeLongQuietEnabled = pathname === '' \|\| pathname === '\/'/);
  assert.match(source, /const requiredQuietMs = homeLongQuietEnabled\s*\? HOME_LONG_QUIET_MS\s*:\s*Number\(status\.quietMs \|\| 0\)/);
  assert.match(source, /phase2\.homeLongQuietDeferred/);
  assert.match(source, /phase2\.homeLongQuietReleased/);
  assert.match(source, /if \(interactionBusy\(status\)\) \{\s*markHomeLongQuietDeferred\(status\);\s*scheduleFallbackRecheck\(\);\s*return false;/);
  assert.match(source, /function flush\(\) \{\s*if \(pendingSerializedBatch\) \{\s*return Promise\.resolve\(runScheduledSerializedWrite\(true\)\)/);
});
