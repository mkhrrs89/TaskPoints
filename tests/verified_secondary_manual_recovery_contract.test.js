const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const preview = fs.readFileSync(path.join(ROOT, 'verified_secondary_recovery.html'), 'utf8');
const restore = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.html'), 'utf8');
const restoreRuntime = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.js'), 'utf8');
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
  assert.match(preview, /verified_secondary_restore\.html/);
  assert.doesNotMatch(preview, /scoring_core\.js/);
  assert.doesNotMatch(preview, /localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(preview, /\.transaction\([^\n]*['"]readwrite['"]/);
  assert.doesNotMatch(preview, /\.(?:put|delete|clear)\s*\(/);
});

test('restore page captures journals and enters Recovery Hold before TaskPointsCore', () => {
  inlineScripts(restore).forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
  const captureAt = restore.indexOf('window.__taskPointsVerifiedSecondaryRestorePreload');
  const legacyReadAt = restore.indexOf("localStorage.getItem('taskpoints_phase5b_pending_changes_v1')");
  const holdAt = restore.indexOf("localStorage.setItem('taskpoints_emergency_recovery_hold_v1'");
  const modeAt = restore.indexOf("localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off')");
  const coreAt = restore.indexOf('<script src="scoring_core.js" defer></script>');
  const runtimeAt = restore.indexOf('<script src="verified_secondary_restore.js" defer></script>');
  assert.ok(captureAt >= 0);
  assert.ok(legacyReadAt > captureAt);
  assert.ok(holdAt > legacyReadAt);
  assert.ok(modeAt > holdAt);
  assert.ok(coreAt > modeAt);
  assert.ok(runtimeAt > coreAt);
});

test('restore runtime verifies readonly candidate and rechecks live and pre-core journals', () => {
  assert.doesNotThrow(() => new vm.Script(restoreRuntime));
  assert.match(restoreRuntime, /db\.transaction\(STORE_NAME, 'readonly'\)/);
  assert.match(restoreRuntime, /record\.status !== 'passed_verification'/);
  assert.match(restoreRuntime, /record\.rawHash !== api\.rawHash\(record\.raw\)/);
  assert.match(restoreRuntime, /sameCounts\(decodedCounts, record\.counts/);
  assert.match(restoreRuntime, /const preloadJournals = global\.__taskPointsVerifiedSecondaryRestorePreload/);
  assert.match(restoreRuntime, /capturedHabitCount/);
  assert.match(restoreRuntime, /capturedLegacyPresent/);
  assert.match(restoreRuntime, /Math\.max\(liveHabitCount, capturedHabitCount\)/);
  assert.match(restoreRuntime, /liveLegacyPresent \|\| capturedLegacyPresent/);
  assert.match(restoreRuntime, /async function revalidateImmediatelyBeforeRestore\(\)/);
  assert.match(restoreRuntime, /verifyRecord\(await readLatest\(\), api\)/);
  assert.match(restoreRuntime, /The verified secondary changed while you were confirming/);
  assert.match(restoreRuntime, /existed before TaskPointsCore loaded/);
  assert.match(restoreRuntime, /capturedBeforeTaskPointsCore/);
});

test('restore requires download, confirmation, typed RESTORE, allowance, and exact readback', () => {
  assert.match(restoreRuntime, /const first = confirm\(/);
  assert.match(restoreRuntime, /type RESTORE in all capital letters/);
  assert.match(restoreRuntime, /typed !== 'RESTORE'/);
  const revalidateAt = restoreRuntime.indexOf('await revalidateImmediatelyBeforeRestore()');
  const downloadAt = restoreRuntime.indexOf('if (!downloadPackage())');
  const replaceAt = restoreRuntime.indexOf('core.safeReplaceTaskPointsStorage');
  assert.ok(revalidateAt >= 0 && downloadAt > revalidateAt && replaceAt > downloadAt);
  assert.match(restoreRuntime, /withTaskPointsDestructiveWriteAllowed/);
  assert.match(restoreRuntime, /readBackRaw !== candidate\.raw/);
  assert.match(restoreRuntime, /Restored raw hash verification failed/);
  assert.match(restoreRuntime, /Restored record-count verification failed/);
  assert.match(restore, /Player images are not touched/);
  assert.match(restore, /verified secondary database and safety vault remain preserved/i);
  assert.match(restoreRuntime, /verified secondary database was preserved/i);
});

test('Storage Health exposes the read-only recovery preview', () => {
  assert.match(health, /href="verified_secondary_recovery\.html"/);
  assert.match(health, /Manual verified-secondary recovery/);
  assert.match(health, /Preview recovery copy/);
});
