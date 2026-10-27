'use strict';

// This is a deliberately conservative source audit, NOT a complete parser or
// a production write fence. In particular, indirect aliases/dynamic calls and
// older open tabs can evade a source scan. Keep V2 nonauthoritative until all
// legacy writers are truly integrated with a verified cross-tab protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = filename => fs.readFileSync(path.join(ROOT, filename), 'utf8');

// Candidate scan intentionally looks across all top-level runtime .js/.html
// files, not merely the existing V2 modules. A writer can live in any page.
const STORAGE_CALL = /\b(?:localStorage|storage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/;
const CORE_CALL = /\b(?:TaskPointsCore|core)\s*\.\s*(?:saveStateSnapshot|saveValidatedSnapshot|safeReplaceTaskPointsStorage|writePendingHabitDelta)\s*\(/;

function findLegacyWriterCandidates() {
  const findings = [];
  for (const item of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!item.isFile() || !/\.(?:js|html)$/.test(item.name)) continue;
    const lines = read(item.name).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!STORAGE_CALL.test(line) && !CORE_CALL.test(line)) return;
      findings.push({
        file: item.name,
        line: index + 1,
        kind: CORE_CALL.test(line) ? 'core-state-entry' : 'potential-browser-storage-write',
        text: line.trim().slice(0, 200)
      });
    });
  }
  return findings;
}

const REQUIRED_WRITERS = Object.freeze([
  { file: 'scoring_core.js', text: 'localStorage.setItem(storageKey' },
  { file: 'index.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'index.html', text: 'localStorage.removeItem(STORAGE_KEY)' },
  { file: 'today.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'settings.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'settings.html', text: 'localStorage.setItem(storageKey, plan.chosenRaw)' },
  { file: 'notes.html', text: 'localStorage.setItem(NOTES_STORAGE_KEY' },
  { file: 'emergency_recovery.html', text: 'core.safeReplaceTaskPointsStorage(' },
  { file: 'task_mutation_journal.js', text: 'storage.setItem(JOURNAL_KEY' }
]);

test('legacy writer candidate audit includes nonpilot pages, replacement, recovery and journal writes', () => {
  const findings = findLegacyWriterCandidates();
  for (const expected of REQUIRED_WRITERS) {
    assert.ok(findings.some(item => item.file === expected.file && item.text.includes(expected.text)),
      'Legacy write surface missing or changed: ' + expected.file + ' / ' + expected.text
      + '. Review the new path before treating writer coverage as established.');
  }
  const files = new Set(findings.map(item => item.file));
  assert.ok(files.size >= 9, 'Unexpectedly narrow writer scan; check file selection and aliases');
  assert.ok(findings.length >= REQUIRED_WRITERS.length,
    'Writer scan did not capture all documented candidate sinks');
});

test('V2 WAL interception remains limited; it cannot imply universal V1 writer fencing', () => {
  const bridge = read('state_runtime_v2_wal_bridge.js');
  assert.match(bridge, /wrapSnapshotReplacement\(core, 'saveStateSnapshot'\)/);
  assert.match(bridge, /wrapSnapshotReplacement\(core, 'saveValidatedSnapshot'\)/);
  assert.match(bridge, /core\.safeReplaceTaskPointsStorage = wrappedSafeReplaceTaskPointsStorage/);
  // The above wrappers are useful recovery/migration mechanisms, but note
  // that Notes and other direct-key pages bypass them.
  for (const file of ['notes.html', 'settings.html', 'index.html', 'emergency_recovery.html']) {
    assert.ok(read(file).includes('localStorage.'), file + ' no longer exposes its expected direct storage paths');
  }
});

test('shared writer rehearsal cannot be mistaken for a production writer lease or authority cutover', () => {
  const runtime = read('state_runtime_v2.js');
  const start = runtime.indexOf('async function exercisePreviewCooperativeWriterLease(');
  const end = runtime.indexOf('async function rehearseExclusiveWriterLease()', start);
  assert.ok(start >= 0 && end > start, 'Developer-only lease rehearsal is missing');
  const rehearsal = runtime.slice(start, end);
  assert.match(rehearsal, /isWalTestPreviewHost\(\)/);
  assert.match(rehearsal, /productionWritersFenced:\s*false/);
  assert.match(rehearsal, /allLegacyWritersKnown:\s*false/);
  assert.match(rehearsal, /canPromote:\s*false/);
  assert.doesNotMatch(rehearsal, /canPromote:\s*true\b/);
  // Preview callback writers must be able to voluntarily recheck the
  // generation after an await and before any fixture side effect. This
  // reduces a TOCTOU window but does not fence legacy writers globally.
  assert.match(rehearsal, /const assertPreviewGenerationCurrent = \(\) =>/);
  assert.match(rehearsal, /STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED/);
  assert.match(rehearsal, /await operation\(previewGuard\)/);
  assert.match(rehearsal, /cooperative_operation_generation_invalidated/);

  // Normal V1 writers do not yet participate in the prototype. Before any
  // handoff this must be replaced by actual writer fencing, not a test tweak.
  for (const file of [
    'index.html', 'today.html', 'settings.html', 'notes.html',
    'emergency_recovery.html', 'scoring_core.js', 'task_mutation_journal.js'
  ]) {
    assert.ok(!read(file).includes('exercisePreviewCooperativeWriterLease('),
      file + ' began calling the prototype: perform a full writer/rollback safety review.');
  }
});

test('full cutover inventory is read-only, hard-blocked, and observes legacy nonpilot races', () => {
  const runtime = read('state_runtime_v2.js');
  const first = runtime.indexOf('  async function inspectAuthorityCutoverBarriers()');
  const last = runtime.indexOf('  // Explicit forensic inspection', first);
  assert.ok(first > 0 && last > first, 'Cutover inspection API missing');
  const report = runtime.slice(first,last);
  for (const protection of [
    'allLegacyWritersFenced: false',
    'allAuthoritativeCollectionsMigrated: false',
    'independentOffDeviceRollbackVerified: false',
    'physicalSafariPwaLifecycleValidated: false',
    'productionMultiContextHandoffValidated: false',
    "canPromote: false",
    "mutationAuthority: 'legacy_only'",
    "readAuthority: 'legacy_only'",
    'fullStorageBefore = captureReadOnlyFullStorageInventory()',
    'fullStorageAfter = captureReadOnlyFullStorageInventory()',
    'stableJson(pilot) !== stableJson(pilotAfter)',
    'stableJson(rollback) !== stableJson(rollbackAfter)'
  ]) {
    assert.ok(report.includes(protection), 'Missing mandatory non-promotable V2 barrier: '+protection);
  }
  assert.ok(runtime.includes('    inspectAuthorityCutoverBarriers,'),
    'Full cutover barrier inspection must remain available in the preview API');
  assert.ok(!report.includes('enableDarkMirror('));
  assert.ok(!report.includes('createPreviewRecoveryCheckpoint('));
  assert.ok(!report.includes('safeReplaceTaskPointsStorage('));
  assert.ok(!report.includes('seedFromLegacy('));
  const observerStart = runtime.indexOf('function captureReadOnlyFullStorageInventory()');
  assert.ok(observerStart > 0, 'Missing complete cutover-localStorage observation');
  const observer = runtime.slice(observerStart,first);
  assert.match(observer, /storage\.key\(i\)/);
  assert.match(observer, /storage\.getItem\(key\)/);
  assert.match(observer, /storage\.length !== count/);
  assert.match(observer, /stableJson\(entries\)/);
  assert.doesNotMatch(observer, /storage\.(?:setItem|removeItem|clear)\(/);
  assert.ok(read('scoring_core.js').includes("tp_projects_v1"),
    'Non-taskpoints-prefixed legacy project key must remain in scope');
  // Checkpoint payload collection remains unchanged: the broader inventory
  // is a read-only safety diagnostic and cannot silently alter backups.
  assert.match(runtime, /function captureLegacyNamespace\(\)/);
});

test('exclusive snapshot writer rehearsal stays developer-only and cannot change production authority', () => {
  const runtime = read('state_runtime_v2.js');
  const first = runtime.indexOf('async function exercisePreviewSerializedSnapshotLease(operation)');
  const last = runtime.indexOf('async function rehearseExclusiveWriterLease()', first);
  assert.ok(first > 0 && last > first, 'Serialized writer preview helper missing');
  const section = runtime.slice(first, last);
  for(const fragment of [
    'isWalTestPreviewHost()',
    'isDarkEnabled()',
    "mode: 'exclusive', ifAvailable: true",
    'EXCLUSIVE_WRITER_REHEARSAL_LOCK',
    'currentGeneration({ create: false })',
    'darkMirrorModeEpoch',
    'assertPreviewGenerationCurrent',
    'assertPreviewLegacySnapshotUnchanged',
    'assertPreviewPrimaryJournalsUnchanged',
    'assertPreviewHabitSidecarsUnchanged',
    'STATE_RUNTIME_V2_PREVIEW_SIDECARS_CHANGED',
    'STATE_RUNTIME_V2_PREVIEW_SIDECAR_UNREADABLE',
    'STATE_RUNTIME_V2_PREVIEW_SIDECAR_TOKEN_INVALID',
    'STATE_RUNTIME_V2_PREVIEW_SIDECAR_GUARD_INACTIVE',
    'serialized_operation_habit_sidecars_changed',
    'serialized_operation_habit_sidecars_unreadable',
    'serialized_operation_habit_sidecar_token_invalid',
    "taskpoints_v2_habit_journal_event_v1:",
    'STATE_RUNTIME_V2_PREVIEW_JOURNALS_CHANGED',
    'STATE_RUNTIME_V2_PREVIEW_JOURNAL_UNREADABLE',
    'STATE_RUNTIME_V2_PREVIEW_JOURNAL_TOKENS_REQUIRED',
    'STATE_RUNTIME_V2_PREVIEW_JOURNAL_GUARD_INACTIVE',
    'serialized_operation_primary_journals_changed',
    'serialized_operation_primary_journal_unreadable',
    "storage.getItem('taskpoints_pending_task_mutations_v1')",
    "core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1'",
    'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_CHANGED',
    'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_UNREADABLE',
    'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_TOKEN_REQUIRED',
    'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_GUARD_INACTIVE',
    'serialized_operation_snapshot_changed',
    'serialized_operation_snapshot_unreadable',
    'serialized_operation_snapshot_token_required',
    'callbackActive = false',
    "storage.getItem(core.STORAGE_KEY || 'taskpoints_v1')",
    'await operation(previewGuard)',
    'serialized_operation_generation_invalidated',
    'serialized_snapshot_rehearsed',
    'exclusiveLockAcquired: true',
    'productionWritersFenced: false',
    'allLegacyWritersKnown: false',
    'canPromote: false',
    "mutationAuthority: 'legacy_only'",
    "readAuthority: 'legacy_only'"
  ]) assert.ok(section.includes(fragment), 'Missing preview-only serialization guard: ' + fragment);
  assert.ok(runtime.includes('    exercisePreviewSerializedSnapshotLease,'),
    'Serialized prototype must be available only through an explicit preview call');
  assert.ok(!section.includes('canPromote: true'));
  // The guard only compares the exact saved V1 snapshot. Journals and
  // separately written keys require their own provenance/fence protocols.
  assert.match(section, /actualRaw !== expectedRaw/);
  assert.match(section, /if \(!callbackActive\)/);
  assert.match(section, /callbackActive = true/);
  assert.match(section, /if \(!callbackActive\)/);
  assert.match(section, /taskRaw !== expected\.taskJournalRaw/);
  assert.match(section, /habitRaw !== expected\.habitJournalRaw/);
  assert.match(section, /const readPreviewHabitSidecarInventory = \(\) =>/);
  assert.match(section, /key\.startsWith\(sidecarPrefix\)/);
  assert.match(section, /storage\.key\(index\)/);
  assert.match(section, /storage\.getItem\(key\)/);
  assert.match(section, /storage\.length !== count/);
  assert.match(section, /stableJson\(actualEntries\) !== stableJson\(expectedEntries\)/);
  assert.doesNotMatch(section, /localStorage\.(?:setItem|removeItem|clear)\(/);
  for(const file of [
    'index.html','today.html','settings.html','notes.html',
    'emergency_recovery.html','scoring_core.js','task_mutation_journal.js'
  ]) assert.ok(!read(file).includes('exercisePreviewSerializedSnapshotLease('),
    'Normal legacy writer was silently made asynchronous: '+file);
});
