const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guardSource = fs.readFileSync(path.join(__dirname, '..', 'phase4_diagnostics.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(__dirname, '..', 'phase4_storage_coordinator.js'), 'utf8');

test('Home Phase 4 automatic primary writes require sustained quiet', () => {
  assert.match(guardSource, /const HOME_LONG_QUIET_MS = 8000;/);
  assert.match(guardSource, /const HOME_LONG_QUIET_POLL_MS = 250;/);
  assert.match(guardSource, /reason\.startsWith\('phase4_primary_write_'\)/);
  assert.match(guardSource, /phase4\.homeLongQuietDeferred/);
  assert.match(guardSource, /phase4\.homeLongQuietReleased/);
  assert.match(guardSource, /lastInteractionAgoMs \|\| 0\) >= HOME_LONG_QUIET_MS/);
  assert.match(guardSource, /return originalGate\(\(\) => waitForHomeLongQuiet\(callback, options\), options\);/);
});

test('Home Phase 4 guard installs after the final shared idle scheduler', () => {
  assert.match(guardSource, /core\.__storageMaintenanceIdleInstalled/);
  assert.match(guardSource, /queueMicrotask\(startPostBundleInstall\)/);
  assert.match(guardSource, /phase4\.homeLongQuietGuardInstalled/);
});

test('Phase 4 reset and explicit queue or flush paths remain immediate', () => {
  assert.match(guardSource, /if \(authoritativeStateMissing\(\)\) \{\s*Promise\.resolve\(\)\.then\(callback\)/);
  assert.match(coordinatorSource, /core\.queuePhase4PrimaryWrite = queueWrite;/);
  assert.match(coordinatorSource, /core\.flushPhase4PrimaryWrites = flushWrites;/);
  assert.match(coordinatorSource, /function flushWrites\(\) \{\s*if \(backgroundWriteScheduled\) \{[\s\S]*return Promise\.resolve\(queueWrite\(/);
  assert.match(coordinatorSource, /function writeResetTombstone\(/);
});
