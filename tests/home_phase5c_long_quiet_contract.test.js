const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('Home Phase 5C verified-secondary background mirror requires sustained quiet', () => {
  assert.match(source, /const HOME_LONG_QUIET_MS = 8000;/);
  assert.match(source, /const HOME_LONG_QUIET_POLL_MS = 250;/);
  assert.match(source, /homeLongQuietEnabled = pathname === '' \|\| pathname === '\/'/);
  assert.match(source, /phase5c\.homeLongQuietDeferred/);
  assert.match(source, /phase5c\.homeLongQuietReleased/);
  assert.match(source, /lastInteractionAgoMs \|\| 0\) >= HOME_LONG_QUIET_MS/);
  assert.match(source, /core\.whenStorageMaintenanceQuiet\(execute, \{ source: 'phase5c_verified_secondary' \}\)/);
});

test('explicit verified-secondary flush remains available and bypasses background wait', () => {
  assert.match(source, /function flush\(\) \{\s*clearHomeLongQuietTimer\(\);\s*scheduled = false;/);
  assert.match(source, /core\.flushPhase5CVerifiedSecondaryWrites = flush;/);
  assert.match(source, /const writeTx = db\.transaction\(STORE, 'readwrite'\);/);
  assert.match(source, /const verifyTx = db\.transaction\(STORE, 'readonly'\);/);
  assert.match(source, /const promotion = await promoteCandidate\(db, readBack, raw, verifiedAtISO, nativeRecord\);/);
});
