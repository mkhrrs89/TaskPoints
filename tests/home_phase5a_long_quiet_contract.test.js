const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5a_native_snapshot.js'), 'utf8');

test('Home Phase 5A automatic native snapshot waits for sustained quiet', () => {
  assert.match(source, /const HOME_LONG_QUIET_MS = 8000;/);
  assert.match(source, /const HOME_LONG_QUIET_POLL_MS = 250;/);
  assert.match(source, /phase5a\.homeLongQuietDeferred/);
  assert.match(source, /phase5a\.homeLongQuietReleased/);
  assert.match(source, /lastInteractionAgoMs \|\| 0\) >= HOME_LONG_QUIET_MS/);
  assert.match(source, /core\.whenStorageMaintenanceQuiet/);
  assert.match(source, /source: 'phase5a_native_snapshot_background'/);
  assert.match(source, /String\(key\) === core\.STORAGE_KEY && mode\(\) !== 'off'\) scheduleBackgroundWrite\(\)/);
});

test('Phase 5A verification, reset cleanup, and explicit flush remain intact', () => {
  assert.match(source, /const writeTx = db\.transaction\(META, 'readwrite'\);/);
  assert.match(source, /const readTx = db\.transaction\(META, 'readonly'\);/);
  assert.match(source, /const verifyTx = db\.transaction\(META, 'readwrite'\);/);
  assert.match(source, /tx\.objectStore\(META\)\.delete\(ID\)/);
  assert.match(source, /core\.queuePhase5ANativeSnapshotWrite = queueWrite;/);
  assert.match(source, /core\.flushPhase5ANativeSnapshotWrites = flushWrites;/);
  assert.match(source, /if \(backgroundWriteScheduled\) \{\s*cancelBackgroundWrite\(\);\s*return Promise\.resolve\(queueWrite\(\)\)/);
});
