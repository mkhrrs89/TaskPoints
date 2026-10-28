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
    'assertPreviewCompleteWriterSourcesUnchanged',
    'STATE_RUNTIME_V2_PREVIEW_COMPLETE_TOKENS_REQUIRED',
    'STATE_RUNTIME_V2_PREVIEW_COMPLETE_GUARD_INACTIVE',
    'serialized_operation_complete_tokens_required',
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
  const fullGuard = section.slice(
    section.indexOf('const assertPreviewCompleteWriterSourcesUnchanged'),
    section.indexOf('const previewGuard = Object.freeze',section.indexOf('const assertPreviewCompleteWriterSourcesUnchanged'))
  );
  assert.match(fullGuard, /expected\.schemaVersion !== 1/);
  assert.equal((fullGuard.match(/assertPreviewLegacySnapshotUnchanged\(expected\.snapshotRaw\)/g)||[]).length,2);
  assert.equal((fullGuard.match(/assertPreviewPrimaryJournalsUnchanged\(expected\)/g)||[]).length,2);
  assert.equal((fullGuard.match(/assertPreviewHabitSidecarsUnchanged\(expected\.sidecarEntries\)/g)||[]).length,1);
  assert.match(fullGuard, /assertPreviewGenerationCurrent\(\)/);
  assert.ok(fullGuard.indexOf('assertPreviewHabitSidecarsUnchanged') <
    fullGuard.lastIndexOf('assertPreviewLegacySnapshotUnchanged'));

  assert.doesNotMatch(section, /localStorage\.(?:setItem|removeItem|clear)\(/);
  for(const file of [
    'index.html','today.html','settings.html','notes.html',
    'emergency_recovery.html','scoring_core.js','task_mutation_journal.js'
  ]) assert.ok(!read(file).includes('exercisePreviewSerializedSnapshotLease('),
    'Normal legacy writer was silently made asynchronous: '+file);
});

test('durable writer fence remains confined to preview IDB markers, not production V1 writers', () => {
  const runtime = read('state_runtime_v2.js');
  const start = runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end = runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  assert.ok(start > 0 && end > start, 'Preview durable writer fence implementation missing');
  const fence = runtime.slice(start,end);
  for (const requirement of [
    'isWalTestPreviewHost()',
    'isDarkEnabled()',
    "taskpoints_v2_writer_fence_preview_v1",
    "['read', 'writer', 'freeze', 'inspect_marker']",
    "action === 'read' || action === 'inspect_marker'",
    "'preview_writer_marker_present'",
    "'preview_writer_marker_absent'",
    'readOnlyMarkerInspection: true',
    'item && (!prior || state.writersCommitted < 1',
    'prior.writersCommitted === 0 && prior.lastWriterMarker !== null',
    "typeof prior.lastWriterMarker !== 'string'",
    'prior.frozen && prior.epoch === 0',
    'if (!prior || state.writersCommitted < 1',
    'item.id !== markerId || item.generation !== generation',
    "indexedDB.open(DB, 1)",
    "(action === 'read' || action === 'inspect_marker') ? 'readonly' : 'readwrite'",
    "store.get('writer_fence')",
    'expectedEpoch !== state.epoch',
    "state.generation !== generation",
    "reason, previewOnly: true, canPromote: false",
    "productionWritersFenced: false, allLegacyWritersKnown: false",
    "'legacy_only'",
    'frozen: true, epoch: state.epoch + 1',
    'store.put(next)',
    "store.get(markerId)",
    "'writer_marker:' + options.marker",
    "store.put({ id: markerId, generation, epoch: state.epoch })",
    "result = refuse('preview_writer_replayed'",
    "result = refuse('fence_writer_marker_conflict'",
    "result = refuse('fence_writer_marker_unreadable'",
    "fence_writer_counter_exhausted",
    "fence_epoch_exhausted",
    "tx.oncomplete = () => finish(result)"
  ]) assert.ok(fence.includes(requirement), 'Missing durable preview fence safety: '+requirement);
  assert.match(fence, /if \(state\.frozen\)/);
  const inspectBranch=fence.slice(fence.indexOf("if (action === 'inspect_marker')"),
    fence.indexOf('if (expectedEpoch !== state.epoch)'));
  assert.match(inspectBranch, /store.get\(markerId\)/);
  assert.match(inspectBranch, /currentGeneration\(\{ create: false \}\) !== generation/);
  assert.match(inspectBranch, /!prior \|\| state\.writersCommitted < 1/);
  assert.match(inspectBranch, /item\.id !== markerId/);
  assert.doesNotMatch(inspectBranch, /store.put\(/);
  assert.doesNotMatch(inspectBranch, /(?:setItem|removeItem|clear)\(/);
  assert.match(fence, /fence_transaction_aborted/);
  assert.match(fence, /fence_generation_mismatch/);
  assert.match(fence, /fence_epoch_stale/);
  assert.match(fence, /fence_frozen/);
  const markerCheck=fence.indexOf("const markerRequest = store.get(markerId)");
  const markerPut=fence.indexOf("store.put({ id: markerId, generation, epoch: state.epoch })");
  const counterPut=fence.indexOf("store.put(next)",markerPut);
  assert.ok(markerCheck > 0 && markerPut > markerCheck && counterPut > markerPut,
    'Dedup marker and aggregate count must be written in one IDB transaction');
  assert.match(fence, /marker\.generation !== generation/);
  assert.match(fence, /marker\.epoch !== state\.epoch/);
  const lookupCallback=fence.slice(
    fence.indexOf('markerRequest.onsuccess = () => {'),
    fence.indexOf('const marker = markerRequest.result')
  );
  assert.match(lookupCallback, /darkMirrorModeEpoch !== initialModeEpoch/);
  assert.match(lookupCallback, /currentGeneration\(\{ create: false \}\) !== generation/);
  assert.match(lookupCallback, /preview_or_generation_changed_in_transaction/);
  assert.ok(runtime.includes('    rehearsePreviewDurableWriterFence,'),
    'Test-only protocol must require an explicit preview API call');
  assert.doesNotMatch(fence, /localStorage\.(?:setItem|removeItem|clear)\(/);
  assert.doesNotMatch(fence, /saveStateSnapshot\(/);
  assert.doesNotMatch(fence, /canPromote: true/);
  for (const path of [
    'index.html','today.html','settings.html','notes.html',
    'emergency_recovery.html','scoring_core.js','task_mutation_journal.js'
  ]) assert.ok(!read(path).includes('rehearsePreviewDurableWriterFence('),
    'An existing V1 writer was inadvertently wired to preview-only IDB fencing: '+path);
});
