const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recovery = fs.readFileSync(path.join(__dirname, '..', 'emergency_recovery.html'), 'utf8');
const status = fs.readFileSync(path.join(__dirname, '..', 'phase4_storage_status.html'), 'utf8');

test('recovery page enters write hold before loading TaskPointsCore', () => {
  const holdAt = recovery.indexOf("localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off')");
  const coreAt = recovery.indexOf('<script src="scoring_core.js" defer></script>');
  assert.ok(holdAt >= 0);
  assert.ok(coreAt > holdAt);
});

test('scanner checks every retained local and IndexedDB recovery source', () => {
  ['taskpoints_backup_latest', 'taskpoints_backup_prev1', 'taskpoints_backup_prev2', 'taskpoints_backup_prev3']
    .forEach((key) => assert.match(recovery, new RegExp(key)));
  ['phase5a_native_snapshot', 'phase4_primary_snapshot', 'phase4_primary_commit']
    .forEach((id) => assert.match(recovery, new RegExp(id)));
  assert.match(recovery, /IndexedDB legacy per-store copy/);
  assert.match(recovery, /taskpoints_quarantined_snapshot/);
  assert.match(recovery, /taskpoints_phase4_verified_primary_cache_v1/);
});

test('scan is read-only and restore requires confirmation, download, and verification', () => {
  const scanStart = recovery.indexOf('async function scan()');
  const restoreStart = recovery.indexOf('async function restoreCandidate');
  const scanSource = recovery.slice(scanStart, restoreStart);
  assert.doesNotMatch(scanSource, /safeReplaceTaskPointsStorage|saveValidatedSnapshot|removeItem\(STORAGE_KEY/);
  assert.match(recovery, /Final confirmation: restore this saved copy now/);
  assert.match(recovery, /downloadCandidate\(id\);/);
  assert.match(recovery, /Recovery verification failed/);
  assert.match(recovery, /Player images are not touched/);
});

test('storage status exposes the emergency recovery page', () => {
  assert.match(status, /href="emergency_recovery\.html"/);
  assert.match(status, /Emergency Data Recovery/);
});
