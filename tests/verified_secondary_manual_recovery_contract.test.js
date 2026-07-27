const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const preview = fs.readFileSync(path.join(ROOT, 'verified_secondary_recovery.html'), 'utf8');
const restore = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.html'), 'utf8');
const restoreRuntime = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.js'), 'utf8');
const verifiedSecondaryRuntime = fs.readFileSync(path.join(ROOT, 'phase5b_deferred_mirror.js'), 'utf8');
const health = fs.readFileSync(path.join(ROOT, 'storage_health.html'), 'utf8');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((source) => source.trim());
}

test('read-only preview compiles and contains no saved-state mutation path', () => {
  inlineScripts(preview).forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
  assert.match(preview, /Read-only preview/);
  assert.match(preview, /taskpoints_verified_secondary_v1/);
  assert.match(preview, /db\.transaction\(STORE_NAME,'readonly'\)|db\.transaction\(STORE_NAME, 'readonly'\)/);
  assert.match(preview, /record\.status!==?'passed_verification'|record\.status !== 'passed_verification'/);
  assert.match(preview, /record\.rawHash!==?api\.rawHash\(record\.raw\)|record\.rawHash !== api\.rawHash\(record\.raw\)/);
  assert.match(preview, /sameCounts\(decodedCounts,record\.counts/);
  assert.match(preview, /<button id="restoreLink"[^>]*disabled/);
  assert.match(preview, /restoreLink'\)\.disabled=true/);
  assert.match(preview, /if\(!\$\('restoreLink'\)\.disabled\)global\.location\.href='verified_secondary_restore\.html'/);
  assert.doesNotMatch(preview, /scoring_core\.js/);
  assert.doesNotMatch(preview, /localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(preview, /\.transaction\([^\n]*['"]readwrite['"]/);
  assert.doesNotMatch(preview, /\.(?:put|delete|clear)\s*\(/);
});

test('restore page captures journals and enters Recovery Hold before isolated runtime', () => {
  inlineScripts(restore).forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
  const captureAt = restore.indexOf('window.__taskPointsVerifiedSecondaryRestorePreload');
  const legacyReadAt = restore.indexOf("localStorage.getItem('taskpoints_phase5b_pending_changes_v1')");
  const holdAt = restore.indexOf("localStorage.setItem('taskpoints_emergency_recovery_hold_v1'");
  const modeAt = restore.indexOf("localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off')");
  const runtimeAt = restore.indexOf('<script src="verified_secondary_restore.js" defer></script>');
  assert.ok(captureAt >= 0);
  assert.ok(legacyReadAt > captureAt);
  assert.ok(holdAt > legacyReadAt);
  assert.ok(modeAt > holdAt);
  assert.ok(runtimeAt > modeAt);
  assert.doesNotMatch(restore, /scoring_core\.js/);
});

test('restore runtime verifies readonly candidate and rechecks current state plus journals', () => {
  assert.doesNotThrow(() => new vm.Script(restoreRuntime));
  assert.match(restoreRuntime, /db\.transaction\(STORE_NAME, 'readonly'\)/);
  assert.match(restoreRuntime, /record\.status !== 'passed_verification'/);
  assert.match(restoreRuntime, /record\.rawHash !== api\.rawHash\(record\.raw\)/);
  assert.match(restoreRuntime, /sameCounts\(decodedCounts, record\.counts/);
  assert.match(restoreRuntime, /const preloadJournals = global\.__taskPointsVerifiedSecondaryRestorePreload/);
  assert.match(restoreRuntime, /Math\.max\(liveHabitCount, capturedHabitCount\)/);
  assert.match(restoreRuntime, /liveLegacyPresent \|\| capturedLegacyPresent/);
  assert.match(restoreRuntime, /async function revalidateImmediatelyBeforeRestore\(\)/);
  assert.match(restoreRuntime, /The current authoritative save changed while you were confirming/);
  assert.match(restoreRuntime, /verifyRecord\(await readLatest\(\), api\)/);
  assert.match(restoreRuntime, /The verified secondary changed while you were confirming/);
  assert.match(restoreRuntime, /capturedBeforeRecoveryRuntime/);
});

test('restore requires lock, download, confirmation, typed RESTORE, and exact direct readback', () => {
  assert.match(restoreRuntime, /const first = confirm\(/);
  assert.match(restoreRuntime, /Close every other TaskPoints tab or window first/);
  assert.match(restoreRuntime, /type RESTORE in all capital letters/);
  assert.match(restoreRuntime, /typed !== 'RESTORE'/);
  const lockAt = restoreRuntime.indexOf('acquireRecoveryLock()');
  const revalidateAt = restoreRuntime.indexOf('await revalidateImmediatelyBeforeRestore()');
  const downloadAt = restoreRuntime.indexOf('if (!downloadPackage())');
  const replaceAt = restoreRuntime.indexOf('localStorage.setItem(STORAGE_KEY, candidate.raw)');
  assert.ok(lockAt >= 0 && revalidateAt > lockAt && downloadAt > revalidateAt && replaceAt > downloadAt);
  assert.match(restoreRuntime, /await delay\(150\)/);
  assert.match(restoreRuntime, /finalizeRecoveryLock\(\)/);
  assert.doesNotMatch(restoreRuntime, /safeReplaceTaskPointsStorage|withTaskPointsDestructiveWriteAllowed/);
  assert.match(restoreRuntime, /readBackRaw !== candidate\.raw/);
  assert.match(restoreRuntime, /Restored raw hash verification failed/);
  assert.match(restoreRuntime, /Restored record-count verification failed/);
  assert.match(restore, /Player images are not touched/);
  assert.match(restore, /verified secondary database and safety vault remain preserved/i);
});

test('already-open TaskPoints tabs are blocked until reloaded after the recovery commit', () => {
  assert.doesNotThrow(() => new vm.Script(verifiedSecondaryRuntime));
  assert.match(verifiedSecondaryRuntime, /installTaskPointsRecoveryWriteLockGuard/);
  assert.match(verifiedSecondaryRuntime, /taskpoints_recovery_write_lock_v1/);
  assert.match(verifiedSecondaryRuntime, /const PAGE_STARTED_AT_MS = Date\.now\(\)/);
  assert.match(verifiedSecondaryRuntime, /committedAtMs > 0 && PAGE_STARTED_AT_MS >= committedAtMs/);
  assert.match(verifiedSecondaryRuntime, /assertWriteAllowed\('setItem'\)/);
  assert.match(verifiedSecondaryRuntime, /assertWriteAllowed\('removeItem'\)/);
  assert.match(verifiedSecondaryRuntime, /TASKPOINTS_RECOVERY_WRITE_LOCKED/);
  assert.match(verifiedSecondaryRuntime, /Reload this tab before making changes/);
});

test('post-commit metadata failure cannot be reported as an uncommitted restore', () => {
  assert.match(restoreRuntime, /let authoritativeWriteOccurred = false/);
  assert.match(restoreRuntime, /let restoreVerified = false/);
  assert.match(restoreRuntime, /authoritativeWriteOccurred = true/);
  assert.match(restoreRuntime, /restoreVerified = true/);
  assert.match(restoreRuntime, /catch \(_\) \{ holdFinalized = false; \}/);
  assert.match(restoreRuntime, /The restore is committed and verified/);
  assert.match(restoreRuntime, /Do not run the restore again/);
});

test('restore page cannot rotate or mutate the safety vault', () => {
  assert.doesNotMatch(restore, /scoring_core\.js|phase2_reset_hook/);
  assert.doesNotMatch(restoreRuntime, /taskpoints_safety_vault_v1|TASKPOINTS_SAFETY_VAULT|queueVaultSnapshot/);
  assert.doesNotMatch(restoreRuntime, /\.transaction\([^\n]*['"]readwrite['"]/);
  assert.doesNotMatch(restoreRuntime, /\.(?:put|delete|clear)\s*\(/);
});

test('Storage Health exposes the read-only recovery preview', () => {
  assert.match(health, /href="verified_secondary_recovery\.html"/);
  assert.match(health, /Manual verified-secondary recovery/);
  assert.match(health, /Preview recovery copy/);
});
