const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'emergency_recovery.html'), 'utf8');
const authorization = fs.readFileSync(path.join(ROOT, 'emergency_recovery_lock_authorization.js'), 'utf8');
const restore = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.js'), 'utf8');

test('emergency authorization loads before the normal storage bundle', () => {
  assert.doesNotThrow(() => new vm.Script(authorization));
  const authorizationAt = html.indexOf('<script src="emergency_recovery_lock_authorization.js" defer></script>');
  const coreAt = html.indexOf('<script src="scoring_core.js" defer></script>');
  assert.ok(authorizationAt >= 0 && coreAt > authorizationAt);
});

test('only the emergency page hides recovery locks from its own guards', () => {
  assert.match(authorization, /global\.__taskPointsEmergencyRecoveryAuthorized = true/);
  assert.match(authorization, /const HIDDEN_KEYS = new Set\(\[COMMITTED_LOCK_KEY, ATTEMPT_LOCK_KEY\]\)/);
  assert.match(authorization, /if \(HIDDEN_KEYS\.has\(String\(key\)\)\) return null/);
  assert.match(authorization, /if \(this === storage && HIDDEN_KEYS\.has\(String\(key\)\)\) return null/);
  const finalizeAt = authorization.indexOf('function finalizeEmergencyRecoveryLock()');
  const removeAt = authorization.indexOf('storage.removeItem(ATTEMPT_LOCK_KEY)', finalizeAt);
  const wrapperAt = authorization.indexOf('function wrapRestoreCandidateWhenReady()', finalizeAt);
  assert.ok(finalizeAt >= 0 && removeAt > finalizeAt && wrapperAt > removeAt);
});

test('a verified full emergency restore commits a fresh generation before removing the attempt', () => {
  const committedAt = authorization.indexOf('storage.setItem(COMMITTED_LOCK_KEY, JSON.stringify(committed))');
  const attemptRemovedAt = authorization.indexOf('storage.removeItem(ATTEMPT_LOCK_KEY)');
  assert.ok(committedAt >= 0 && attemptRemovedAt > committedAt);
  assert.match(authorization, /hold\?\.active === true && hold\?\.restored === true/);
  assert.match(authorization, /reason: 'full_emergency_recovery_verified'/);
});

test('manual verified-secondary restore fails closed without both lock helpers', () => {
  assert.match(restore, /const split = global\.TaskPointsVerifiedSecondaryRecoveryLockSplit/);
  assert.match(restore, /const guard = global\.TaskPointsVerifiedSecondaryRestoreLockGuard/);
  assert.match(restore, /if \(!split\?\.installed \|\| !guard\?\.installed\)/);
  assert.match(restore, /Recovery lock protection did not install\. Manual restoration is disabled/);
  const prerequisiteAt = restore.indexOf("if (!split?.installed || !guard?.installed)");
  const candidateAt = restore.indexOf('candidate = verifyRecord(await readLatest(), api)');
  assert.ok(prerequisiteAt >= 0 && candidateAt > prerequisiteAt);
});
