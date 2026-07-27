const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const preview = fs.readFileSync(path.join(ROOT, 'verified_secondary_recovery.html'), 'utf8');
const restore = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.html'), 'utf8');
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

test('restore page enters Recovery Hold before TaskPointsCore loads', () => {
  const holdAt = restore.indexOf("localStorage.setItem('taskpoints_emergency_recovery_hold_v1'");
  const modeAt = restore.indexOf("localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off')");
  const coreAt = restore.indexOf('<script src="scoring_core.js" defer></script>');
  assert.ok(holdAt >= 0);
  assert.ok(modeAt > holdAt);
  assert.ok(coreAt > modeAt);
});

test('restore requires a verified readonly candidate, clear journals, download, and explicit confirmations', () => {
  inlineScripts(restore).forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
  assert.match(restore, /db\.transaction\(STORE_NAME, 'readonly'\)/);
  assert.match(restore, /record\.status !== 'passed_verification'/);
  assert.match(restore, /record\.rawHash !== api\.rawHash\(record\.raw\)/);
  assert.match(restore, /sameCounts\(decodedCounts, record\.counts/);
  assert.match(restore, /pendingHabitCount \|\| validation\.legacyJournalPresent/);
  assert.match(restore, /const first = confirm\(/);
  assert.match(restore, /type RESTORE in all capital letters/);
  assert.match(restore, /typed !== 'RESTORE'/);
  const downloadAt = restore.indexOf('if (!downloadPackage())');
  const replaceAt = restore.indexOf('core.safeReplaceTaskPointsStorage');
  assert.ok(downloadAt >= 0 && replaceAt > downloadAt);
  assert.match(restore, /withTaskPointsDestructiveWriteAllowed/);
  assert.match(restore, /readBackRaw !== candidate\.raw/);
  assert.match(restore, /Restored raw hash verification failed/);
  assert.match(restore, /Restored record-count verification failed/);
  assert.match(restore, /Player images are not touched/);
  assert.match(restore, /verified IndexedDB copy is preserved|verified secondary database was preserved/i);
});

test('Storage Health exposes the read-only recovery preview', () => {
  assert.match(health, /href="verified_secondary_recovery\.html"/);
  assert.match(health, /Manual verified-secondary recovery/);
  assert.match(health, /Preview recovery copy/);
});
