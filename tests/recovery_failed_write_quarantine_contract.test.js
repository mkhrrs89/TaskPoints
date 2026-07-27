const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const restore = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.js'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore_lock_guard.js'), 'utf8');

 test('the recovery attempt becomes durable before the authoritative write boundary', () => {
  const boundaryAt = restore.indexOf('markRecoveryAttemptWriteBoundary();');
  const writeAt = restore.indexOf('localStorage.setItem(STORAGE_KEY, candidate.raw)');
  assert.ok(boundaryAt >= 0 && writeAt > boundaryAt);
  assert.match(restore, /retainUntilManualRecovery: true/);
  assert.match(restore, /writeBoundaryEnteredAtISO/);
  assert.match(restore, /createdAtMs: '9999999999999'/);
  assert.match(restore, /The durable recovery quarantine could not be established before replacement/);
});

test('page teardown and normal expiry do not remove a durable failed-write quarantine', () => {
  assert.match(guard, /lock\.retainUntilManualRecovery !== true/);
  const releaseAt = guard.indexOf('function releaseOwnedUncommittedLock()');
  const retainedCheckAt = guard.indexOf('lock.retainUntilManualRecovery !== true', releaseAt);
  const removeAt = guard.indexOf('storage.removeItem(LOCK_KEY)', retainedCheckAt);
  assert.ok(releaseAt >= 0 && retainedCheckAt > releaseAt && removeAt > retainedCheckAt);
});

test('successful verification normalizes and commits the durable attempt', () => {
  assert.match(restore, /const restoredCreatedAtMs = String\(lock\.originalCreatedAtMs \|\| lock\.createdAtMs \|\| committedAtMs\)/);
  assert.match(restore, /retainUntilManualRecovery: false/);
  assert.match(restore, /restoreVerified = true/);
  assert.match(restore, /const lockFinalized = finalizeRecoveryLock\(\)/);
});

test('failed post-write verification reports that quarantine remains active', () => {
  assert.match(restore, /recovery quarantine remains active/);
  assert.match(restore, /if \(!authoritativeWriteOccurred\) releaseUncommittedRecoveryLock\(\)/);
  assert.doesNotMatch(restore, /if \(authoritativeWriteOccurred\) releaseUncommittedRecoveryLock\(\)/);
});
