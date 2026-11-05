'use strict';

// Read-only source-evidence contract for the still-unfenced V1 writer topology.
// This is NOT a complete static analysis of runtime/dynamic/old-tab writers.
// Do not mark any writer family fenced based on passing this audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT,name),'utf8');
const SOURCE_ANCHORS = [
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "function safeReplaceTaskPointsStorage(storageKey, serializedCandidate)",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "localStorage.setItem(storageKey, serializedCandidate)",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "function writePendingHabitDelta(delta, storageKey = PENDING_HABIT_DELTAS_KEY)",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "localStorage.setItem(V2_HABIT_EVENT_PREFIX + unique,",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "function clearCompactedHabitDeltas(compacted, storageKey = PENDING_HABIT_DELTAS_KEY)",
    "maintenance",
    "verified_compaction"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "function schedulePendingHabitDeltaCompaction(state, options = {})",
    "deferred",
    "verified_compaction"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "function runPendingInteractiveRecompress(storageKey)",
    "deferred",
    "byte_identity_and_snapshot"
  ],
  [
    "scoring_core_snapshot_and_habit_journal",
    "scoring_core.js",
    "global.addEventListener('pagehide', flushPendingInteractiveRecompresses)",
    "lifecycle",
    "byte_identity_and_snapshot"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "function save(savePath, extraOptions = {})",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "TaskPointsCore.saveStateSnapshot(state, saveOptions)",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "localStorage.removeItem(STORAGE_KEY)",
    "destructive",
    "generation_and_rollback"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list))",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "localStorage.setItem(TODAY_STORE_KEY, JSON.stringify({",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "TaskPointsCore.writePendingHabitDelta(journalDelta, PENDING_HABIT_DELTAS_KEY)",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "TaskPointsCore.journalTaskMutation({ task: liveTask, completionUpsert: completion })",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "home_direct_keys_and_snapshot_saves",
    "index.html",
    "function savePendingHabitState(perfStart = null)",
    "maintenance",
    "verified_compaction"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "function saveState(nextState, options = {})",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "localStorage.setItem(GALLERY_COLUMNS_STORAGE_KEY, JSON.stringify(galleryColumns))",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "localStorage.setItem(GROUP_ACTIVE_PLAYERS_STORAGE_KEY, String(groupActivePlayers))",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "localStorage.setItem(PLAYER_SORT_STORAGE_KEY, mode)",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "state.youRivalId = validRival ? nextRivalId : \"\";",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "game_players_schedules_and_preferences",
    "game.html",
    "state = saveState(state, { allowStickyOverwriteKeys: [\"youImageId\", \"youName\", \"youPrimaryColor\", \"youSecondaryColor\"] });",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "today_snapshot_and_view_state",
    "today.html",
    "function saveApp(nextState)",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "today_snapshot_and_view_state",
    "today.html",
    "TaskPointsCore.saveStateSnapshot(nextState, { storageKey: STORAGE_KEY })",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "today_snapshot_and_view_state",
    "today.html",
    "function saveTodayStore(store = todayStore)",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "today_snapshot_and_view_state",
    "today.html",
    "localStorage.setItem(TODAY_STORE_KEY, JSON.stringify(db))",
    "synchronous",
    "nonpilot_key"
  ],
  [
    "settings_import_reset_and_direct_storage",
    "settings.html",
    "importSaveResult = TaskPointsCore.saveValidatedSnapshot(normalized, {",
    "destructive",
    "generation_and_rollback"
  ],
  [
    "settings_import_reset_and_direct_storage",
    "settings.html",
    "localStorage.setItem(\"tp_projects_v1\", incomingProjects)",
    "destructive",
    "nonpilot_key"
  ],
  [
    "settings_import_reset_and_direct_storage",
    "settings.html",
    "localStorage.removeItem(SETTINGS_STORAGE_KEY)",
    "destructive",
    "generation_and_rollback"
  ],
  [
    "settings_import_reset_and_direct_storage",
    "settings.html",
    "localStorage.setItem(storageKey, plan.chosenRaw)",
    "maintenance",
    "raw_replacement_rollback"
  ],
  [
    "settings_import_reset_and_direct_storage",
    "settings.html",
    "localStorage.setItem(\"taskpoints_notes_authoritative_v1\", \"1\")",
    "synchronous",
    "notes_consistency"
  ],
  [
    "notes_content_dirty_and_authority_flags",
    "notes.html",
    "function syncNotesStorageLocations(source = \"notes-storage-sync\")",
    "synchronous",
    "notes_consistency"
  ],
  [
    "notes_content_dirty_and_authority_flags",
    "notes.html",
    "TaskPointsCore.writeTaskPointsStoredState(latestState, { storageKey: STORAGE_KEY })",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "notes_content_dirty_and_authority_flags",
    "notes.html",
    "localStorage.setItem(NOTES_STORAGE_KEY, notesText)",
    "synchronous",
    "notes_consistency"
  ],
  [
    "notes_content_dirty_and_authority_flags",
    "notes.html",
    "localStorage.setItem(NOTES_DIRTY_KEY, \"1\")",
    "synchronous",
    "notes_consistency"
  ],
  [
    "emergency_recovery_and_restore",
    "emergency_recovery.html",
    "localStorage.setItem(MODE_KEY, 'off')",
    "destructive",
    "recovery_override"
  ],
  [
    "emergency_recovery_and_restore",
    "emergency_recovery.html",
    "core.safeReplaceTaskPointsStorage(STORAGE_KEY, chosenRaw)",
    "destructive",
    "recovery_override"
  ],
  [
    "emergency_recovery_and_restore",
    "emergency_recovery.html",
    "localStorage.removeItem(PHASE5B_JOURNAL_KEY)",
    "destructive",
    "recovery_override"
  ],
  [
    "emergency_recovery_and_restore",
    "emergency_recovery.html",
    "localStorage.setItem(HABIT_JOURNAL_KEY, '[]')",
    "destructive",
    "recovery_override"
  ],
  [
    "task_journal_and_idle_compaction",
    "task_mutation_journal.js",
    "function journalMutation(mutation = {})",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "task_journal_and_idle_compaction",
    "task_mutation_journal.js",
    "storage.setItem(JOURNAL_KEY, JSON.stringify(normalized))",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "task_journal_and_idle_compaction",
    "task_mutation_journal.js",
    "async function runWhenQuiet(reason, scheduledGeneration)",
    "deferred",
    "verified_compaction"
  ],
  [
    "task_journal_and_idle_compaction",
    "task_mutation_journal.js",
    "core.saveStateSnapshot = function saveStateSnapshotWithTaskJournal(state, options = {})",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "task_journal_and_idle_compaction",
    "task_mutation_journal.js",
    "function scheduleCompaction(reason = 'scheduled', knownJustWrittenRecord = null)",
    "deferred",
    "verified_compaction"
  ],
  [
    "work_entry_fast_path_and_editor_fallback",
    "work_entry_fast_path.js",
    "function runFastCommit(name, original, thisArg, args)",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "work_entry_fast_path_and_editor_fallback",
    "work_entry_fast_path.js",
    "core.journalTaskMutation({ completionUpsert: clone(entry) });",
    "synchronous",
    "journal_and_sidecar"
  ],
  [
    "work_entry_fast_path_and_editor_fallback",
    "work_entry_fast_path.js",
    "workSaveConfirmed = saveFallback(priorSave, 'journal-write-failed', true);",
    "synchronous",
    "snapshot_guard"
  ],
  [
    "work_entry_fast_path_and_editor_fallback",
    "work_entry_fast_path.js",
    "if (pending && scwm.flush?.() !== true) {",
    "synchronous",
    "verified_compaction"
  ],
  [
    "work_entry_fast_path_and_editor_fallback",
    "work_entry_fast_path.js",
    "const sleepAddWrapped = ready && wrapCommit('saveSleepScore');",
    "synchronous",
    "journal_and_sidecar"
  ]
];
const FAMILIES = [
  'scoring_core_snapshot_and_habit_journal',
  'home_direct_keys_and_snapshot_saves',
  'game_players_schedules_and_preferences',
  'today_snapshot_and_view_state',
  'settings_import_reset_and_direct_storage',
  'notes_content_dirty_and_authority_flags',
  'emergency_recovery_and_restore',
  'task_journal_and_idle_compaction',
  'work_entry_fast_path_and_editor_fallback'
];
const ALLOWED_TIMING = new Set(['synchronous','deferred','maintenance','lifecycle','destructive']);
const ALLOWED_REQUIREMENTS = new Set([
  'snapshot_guard','journal_and_sidecar','verified_compaction',
  'byte_identity_and_snapshot','generation_and_rollback','nonpilot_key',
  'raw_replacement_rollback','notes_consistency','recovery_override'
]);

test('every named unfenced writer family has pinned, classified real source evidence', () => {
  const sourceByFile = new Map();
  const ids = new Set();
  const foundFamilies = new Set();
  for (const [family,file,anchor,timing,requirement] of SOURCE_ANCHORS) {
    assert.ok(FAMILIES.includes(family), 'Unexpected legacy writer family: '+family);
    assert.ok(ALLOWED_TIMING.has(timing), 'Timing unclassified for '+file+': '+anchor);
    assert.ok(ALLOWED_REQUIREMENTS.has(requirement),
      'Handoff requirement unclassified: '+file+': '+anchor);
    assert.ok(typeof anchor === 'string' && anchor.length > 10);
    const id = file+'::'+anchor;
    assert.ok(!ids.has(id), 'Duplicate writer evidence: '+id);
    ids.add(id); foundFamilies.add(family);
    if (!sourceByFile.has(file)) sourceByFile.set(file,read(file));
    assert.ok(sourceByFile.get(file).includes(anchor),
      'Known legacy writer path changed: '+family+' / '+id+
      '. Audit the new route; never infer this path was fenced or removed safely.');
  }
  assert.deepEqual([...foundFamilies].sort(),[...FAMILIES].sort());
  assert.ok(SOURCE_ANCHORS.length >= 49,
    'Writer evidence inventory silently reduced without an explicit migration review');
  assert.equal(sourceByFile.size,9,'One of the nine known writer-owner source files went missing');
});

test('writer evidence matrix agrees with runtime hard blockers and remains nonpromotable', () => {
  const runtime=read('state_runtime_v2.js');
  const begin=runtime.indexOf('const AUTHORITY_CUTOVER_WRITER_FAMILIES = Object.freeze([');
  const end=runtime.indexOf('function captureReadOnlyFullStorageInventory()',begin);
  assert.ok(begin>0&&end>begin,'Unfenced V1 family list missing');
  const source=runtime.slice(begin,end);
  for(const family of FAMILIES)
    assert.ok(source.includes("'"+family+"'"),'Runtime omitted unfenced family: '+family);
  const gateStart=runtime.indexOf('async function inspectAuthorityCutoverBarriers()');
  const gateEnd=runtime.indexOf('// Explicit forensic inspection',gateStart);
  assert.ok(gateStart>0&&gateEnd>gateStart);
  const gate=runtime.slice(gateStart,gateEnd);
  for(const evidence of [
    'all_legacy_writers_not_fenced',
    'work_entry_multirecord_admission_not_validated',
    'workEntryAtomicAdmissionVerified: false',
    'workEntryFallbackPathFenced: false',
    'allLegacyWritersFenced: false',
    "canPromote: false",
    "mutationAuthority: 'legacy_only'",
    "readAuthority: 'legacy_only'",
    'knownUnfencedWriterFamilies: [...AUTHORITY_CUTOVER_WRITER_FAMILIES]'
  ])assert.ok(gate.includes(evidence),'Cutover fail-closed requirement missing: '+evidence);
});

test('the transactional preview protocol does not masquerade as a production V1 writer fence',()=>{
  const runtime=read('state_runtime_v2.js');
  const start=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  assert.ok(start>0&&end>start);
  const prototype=runtime.slice(start,end);
  assert.match(prototype,/isWalTestPreviewHost\(\)/);
  assert.match(prototype,/productionWritersFenced: false/);
  assert.match(prototype,/canPromote: false/);
  const owners=new Set(SOURCE_ANCHORS.map(([,file])=>file));
  for(const file of owners){
    const source=read(file);
    assert.ok(!source.includes('rehearsePreviewDurableWriterFence('),
      'A V1 writer started calling the experimental protocol without review: '+file);
  }
});

test('preview freeze must atomically audit full writer marker inventory before committing',()=>{
  const runtime=read('state_runtime_v2.js');
  const begin=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',begin);
  assert.ok(begin>=0&&end>begin);
  const source=runtime.slice(begin,end);
  assert.match(source,/action === 'audit'/);
  assert.match(source,/scan = store\.getAll\(\)/);
  assert.match(source,/markers\.length === state\.writersCommitted/);
  assert.match(source,/entities\.length === expectedEntities\.size/);
  assert.match(source,/entityByKey\.set\(row\.id,row\)/);
  assert.match(source,/row\.syntheticMutationJson !== latest\.syntheticMutationJson/);
  assert.match(source,/markerIds\.has\(lastKey\)/);
  assert.match(source,/fence_writer_inventory_inconsistent/);
  const freeze=source.slice(source.indexOf("if (action === 'freeze')"),
    source.indexOf('// Keep each synthetic marker',source.indexOf("if (action === 'freeze')")));
  assert.ok(freeze.indexOf('inspectAllWriterMarkers(')>=0);
  assert.ok(freeze.indexOf('store.put(next)')>freeze.indexOf('inspectAllWriterMarkers('));
  assert.match(freeze,/markerInventoryVerified: true/);
  assert.match(source,/productionWritersFenced: false/);
  assert.match(source,/canPromote: false/);
});

test('preview synthetic writer persists a canonical payload and SHA-256 marker atomically',()=>{
  const runtime=read('state_runtime_v2.js');
  const begin=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',begin);
  const preview=runtime.slice(begin,end);
  for(const evidence of [
    'syntheticMutationJson','canonicalSyntheticMutation',
    "preview_synthetic_digest_mismatch", "preview_synthetic_mutation_invalid",
    "global.crypto.subtle.digest('SHA-256', bytes)",
    'effectivePayloadFingerprint','syntheticMutationDurable: hasAnySynthetic',
    'fence_writer_synthetic_mutation_mismatch',
    'syntheticMutationVerified: hasAnySynthetic',
    'syntheticMarkerValid(row)','syntheticMarkerValid(marker)',
    "productionWritersFenced: false", "canPromote: false"
  ])assert.ok(preview.includes(evidence),'Synthetic preview contract lost '+evidence);
  const store=preview.indexOf('store.put({ id: markerId, generation, epoch: state.epoch,');
  const tally=preview.indexOf('store.put(next)',store);
  assert.ok(store>0&&tally>store,'marker/payload and counter must share a transaction');
  assert.ok(!preview.includes("localStorage.setItem("));
});

test('preview fence marker replays must validate caller-supplied payload identity',()=>{
  const runtime=read('state_runtime_v2.js');
  const start=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  assert.ok(start>0&&end>start);
  const preview=runtime.slice(start,end);
  assert.match(preview,/writer_payload_fingerprint_invalid/);
  assert.match(preview,/fence_writer_payload_mismatch/);
  assert.match(preview,/marker\.payloadFingerprint !== effectivePayloadFingerprint/);
  assert.match(preview,/item\.payloadFingerprint !== payloadFingerprint/);
  assert.match(preview,/store\.put\(\{ id: markerId, generation, epoch: state\.epoch,/);
  assert.match(preview,/payloadFingerprint: effectivePayloadFingerprint/);
  assert.match(preview,/materializedSyntheticEntity: hasAnySynthetic/);
  assert.match(preview,/readOnlyEntityInspection: true/);
  assert.match(preview,/syntheticSequence: next\.writersCommitted/);
  assert.match(preview,/productionWritersFenced: false/);
  assert.match(preview,/canPromote: false/);
});

test('V2 actual Habit mutation ledger refuses identity collisions before replay and WAL clearance',()=>{
  const runtime=read('state_runtime_v2.js');
  const begin=runtime.indexOf('function assertCommittedHabitMutationIdentity(');
  const check=runtime.indexOf('async function hasCommittedHabitMutation(',begin);
  const apply=runtime.indexOf('async function applyHabitDelta(',check);
  const next=runtime.indexOf('async function applyHabitOrder',apply);
  assert.ok(begin>0 && check>begin && apply>check && next>apply);
  const guard=runtime.slice(begin,check),readOnly=runtime.slice(check,apply);
  const writer=runtime.slice(apply,next);
  for(const condition of [
    "row.type !== 'habit-completion-set'",
    "row.status !== 'committed'",
    'row.resetGeneration !== generation',
    'mutationIdForDelta(delta, generation) !== mutationId',
    'stableJson(row.delta) !== stableJson(delta)',
    'state_runtime_v2_mutation_identity_mismatch'
  ]) assert.ok(guard.includes(condition),'Missing immutable ledger proof: '+condition);
  assert.ok(readOnly.includes('!expectedDelta) return false'),
    'Read-only WAL confirmation must fail closed without content');
  assert.ok(readOnly.includes('assertCommittedHabitMutationIdentity('));
  assert.ok(writer.indexOf('assertCommittedHabitMutationIdentity(')
    < writer.indexOf('duplicate = true;'),
    'Writer must reject colliding payloads before acknowledging duplicates');
  assert.ok(writer.includes('mutationsStore.put({'));
  const bridge=read('state_runtime_v2_wal_bridge.js');
  assert.ok(bridge.includes('hasCommittedHabitMutation(mutationId, generation, delta)'),
    'WAL bridge must compare the exact pending delta before cleanup');
});

test('WAL append and shared inventory refuse conflicting short mutation ID payloads',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const begin=wal.indexOf('function read()');
  const append=wal.indexOf('function appendHabitDelta(',begin);
  const remove=wal.indexOf('function removeMutation(',append);
  assert.ok(begin>0&&append>begin&&remove>append);
  const reader=wal.slice(begin,append);
  const writer=wal.slice(append,remove);
  assert.match(reader,/wal_shared_duplicate_identity_conflict/);
  assert.match(reader,/stableJson\(previous\.delta\) !== stableJson\(row\.delta\)/);
  assert.match(reader,/wal_shared_independent_identity_conflict/);
  assert.match(writer,/state_runtime_v2_wal_mutation_id_mismatch/);
  assert.match(writer,/state_runtime_v2_wal_duplicate_payload_conflict/);
  assert.match(writer,/stableJson\(existing\.delta\) !== stableJson\(delta\)/);
  assert.ok(writer.indexOf('state_runtime_v2_wal_duplicate_payload_conflict')
    < writer.indexOf('state_runtime_v2_wal_independent_write_failed'),
    'A conflicting duplicate must never overwrite the independent WAL');
  assert.ok(writer.indexOf('state_runtime_v2_wal_duplicate_payload_conflict')
    < writer.indexOf('writeRows(next)'),
    'A conflicting duplicate must never rewrite the shared WAL');
  const bridge=read('state_runtime_v2_wal_bridge.js');
  assert.ok(bridge.includes('hasCommittedHabitMutation(mutationId, generation, delta)'));
});

test('verified V2 Habit WAL cleanup must recheck exact payload and both localStorage copies',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const begin=wal.indexOf('function removeMutation(mutationId, expected = null)');
  const end=wal.indexOf('function getPendingRows()',begin);
  assert.ok(begin>0&&end>begin);
  const cleanup=wal.slice(begin,end);
  for(const evidence of [
    'state_runtime_v2_wal_cleanup_identity_required',
    'state_runtime_v2_wal_cleanup_identity_mismatch',
    'state_runtime_v2_wal_cleanup_payload_changed',
    'state_runtime_v2_wal_cleanup_shared_changed',
    'state_runtime_v2_wal_cleanup_sidecar_changed',
    'stableJson(target.delta) !== stableJson(verifiedIdentity.delta)',
    'readWalStorage(KEY) !== current.raw',
    'readWalStorage(sidecarKey) !== originalSidecar'
  ])assert.ok(cleanup.includes(evidence),'WAL cleanup guard missing: '+evidence);
  const sharedWrite=cleanup.indexOf("if (next.length) writeRows(next)");
  const sidecarDelete=cleanup.indexOf("removeWalStorageVerified(sidecarKey,");
  const sidecarRecheck=cleanup.lastIndexOf("readWalStorage(sidecarKey) !== originalSidecar");
  assert.ok(sharedWrite>0&&sidecarDelete>sharedWrite&&sidecarRecheck>sharedWrite
    &&sidecarRecheck<sidecarDelete,'Independent WAL must be checked again after shared cleanup');
  const bridge=read('state_runtime_v2_wal_bridge.js');
  const verified=bridge.indexOf('await runtime.hasCommittedHabitMutation(mutationId, generation, delta)');
  const removed=bridge.indexOf('wal.removeMutation(mutationId, { generation, delta })');
  assert.ok(verified>0&&removed>verified,'WAL cannot clear without matching V2 ledger verification');
});

test('unique cross-tab WAL admission claims survive old per-ID sidecar overwrites',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const begin=wal.indexOf('function read()');
  const append=wal.indexOf('function appendHabitDelta(',begin);
  const remove=wal.indexOf('function removeMutation(',append);
  const end=wal.indexOf('function getPendingRows()',remove);
  assert.ok(begin>0&&append>begin&&remove>append&&end>remove);
  const reader=wal.slice(begin,append);
  const writer=wal.slice(append,remove);
  const cleanup=wal.slice(remove,end);
  assert.match(reader,/const inventory = recoveryKeys\(\)/);
  assert.match(reader,/for \(const key of inventory\.events\)/);
  assert.match(reader,/for \(const key of inventory\.claims\)/);
  assert.match(reader,/wal_admission_claim_identity_conflict/);
  assert.match(reader,/wal_admission_claim_invalid/);
  assert.match(writer,/setWalStorageVerified\(uniqueClaimKey\(\), JSON.stringify\(row\)/);
  assert.match(writer,/state_runtime_v2_wal_admission_sidecar_conflict/);
  assert.ok(writer.indexOf('uniqueClaimKey()')<writer.indexOf('writeRows(next)'),
    'Admission claim must be durable before the shared WAL can be overwritten');
  const freshAdmission=writer.slice(writer.indexOf('const row = {'));
  assert.ok(freshAdmission.indexOf('uniqueClaimKey()')
    < freshAdmission.indexOf('setWalStorageVerified(independentKey(mutationId)'),
    'New admission claim must precede canonical per-ID WAL sidecar');
  assert.match(cleanup,/const cleanupInventory = recoveryKeys\(\)/);
  assert.match(cleanup,/for \(const key of cleanupInventory\.claims\)/);
  assert.match(cleanup,/state_runtime_v2_wal_cleanup_claim_disappeared/);
  assert.match(cleanup,/global\.localStorage\.length !== cleanupInventory\.observedLength/);
  assert.match(cleanup,/state_runtime_v2_wal_cleanup_claim_inventory_changed/);
  assert.match(cleanup,/const latestCleanupInventory = recoveryKeys\(\)/);
  assert.match(cleanup,/state_runtime_v2_wal_cleanup_keys_changed/);
  assert.ok(cleanup.indexOf('state_runtime_v2_wal_cleanup_claim_inventory_changed')
    < cleanup.indexOf('if (next.length) writeRows(next);'),
    'Cleanup must reject a changed recovery inventory before deleting shared WAL evidence');
  assert.ok(cleanup.indexOf('state_runtime_v2_wal_cleanup_keys_changed')
    < cleanup.indexOf('if (next.length) writeRows(next);'),
    'Cleanup must reject same-length recovery key replacements before shared deletion');
  assert.match(cleanup,/readWalStorage\(claim.key\) !== claim.raw/);
  assert.match(cleanup,/state_runtime_v2_wal_claim_remove_failed/);
});

test('WAL inventory scans legacy sidecars and immutable claims together without caching',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const begin=wal.indexOf('function recoveryKeys()');
  const end=wal.indexOf('function uniqueClaimKey()',begin);
  const scanner=wal.slice(begin,end);
  assert.ok(begin>0&&end>begin);
  assert.match(scanner,/const expectedLength = storage\.length/);
  assert.match(scanner,/for \(let i = 0; i < expectedLength; i \+= 1\)/);
  assert.match(scanner,/storage\.length !== expectedLength/);
  assert.match(scanner,/wal_storage_inventory_changed/);
  assert.match(scanner,/wal_storage_inventory_duplicate_key/);
  assert.match(scanner,/wal_storage_inventory_missing_key/);
  assert.match(scanner,/key\.startsWith\(EVENT_PREFIX\)/);
  assert.match(scanner,/key\.startsWith\(CLAIM_PREFIX\)/);
  const readStart=wal.indexOf('function read()');
  const appendStart=wal.indexOf('function appendHabitDelta(',readStart);
  const reader=wal.slice(readStart,appendStart);
  assert.equal(reader.match(/recoveryKeys\(\)/g)?.length,1,
    'WAL recovery should enumerate both key families in the same fresh pass');
  assert.match(reader,/wal_admission_claim_identity_conflict/);
  assert.match(reader,/wal_shared_independent_identity_conflict/);
  const statusStart=wal.indexOf('function getStatus()');
  const status=wal.slice(statusStart,wal.indexOf('const api =',statusStart));
  assert.match(status,/const inventory = recoveryKeys\(\)/);
  assert.match(status,/state_runtime_v2_wal_inventory_unreadable/);
});

test('WAL read detects changes between inventory snapshot and payload verification',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const scanner=wal.slice(wal.indexOf('function recoveryKeys()'),
    wal.indexOf('function independentKeys()'));
  assert.match(scanner,/observedLength: expectedLength/);
  const reader=wal.slice(wal.indexOf('function read()'),
    wal.indexOf('function writeRows(rows)'));
  assert.match(reader,/wal_recovery_inventory_changed_after_read/);
  assert.match(reader,/global\.localStorage\.length !== inventory\.observedLength/);
  assert.match(reader,/wal_shared_changed_during_read/);
  assert.match(reader,/readWalStorage\(KEY\) !== raw/);
  assert.match(reader,/wal_recovery_entry_disappeared_during_read/);
  assert.ok(reader.indexOf('wal_recovery_inventory_changed_after_read')
    > reader.indexOf('for (const key of inventory.claims)'),
    'final inventory count guard must follow claim payload retrieval');
});

test('complete WAL shared-array appends serialize only a new row; missing rows still reconcile',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const readStart=wal.indexOf('function read()');
  const appendStart=wal.indexOf('function appendHabitDelta(',readStart);
  const reader=wal.slice(readStart,appendStart);
  assert.match(reader,/sharedComplete: parsed.length === merged.size/);
  assert.match(reader,/sharedRowCount: parsed.length/);
  const appendEnd=wal.indexOf('function removeMutation(',appendStart);
  const append=wal.slice(appendStart,appendEnd);
  // Duplicate repair for pre-claim WAL data precedes new admission and is
  // intentionally preserved. The strict ordering applies to a NEW row.
  const freshAdmission=append.slice(append.indexOf('const row = {'));
  const claim=freshAdmission.indexOf('setWalStorageVerified(uniqueClaimKey()');
  const sidecar=freshAdmission.indexOf('setWalStorageVerified(independentKey(mutationId)');
  const recheck=freshAdmission.indexOf('readWalStorage(KEY) !== current.raw');
  const fullFallback=freshAdmission.indexOf('writeRows(next)');
  assert.ok(claim>=0&&sidecar>claim&&recheck>sidecar&&fullFallback>recheck,
    'shared writes cannot precede independent recovery or shared-array race guard');
  assert.match(append,/state_runtime_v2_wal_append_shared_changed/);
  assert.match(append,/current.sharedComplete && current.raw !== null/);
  assert.match(append,/JSON.stringify\(row\) \+ current.raw.slice\(closing\)/);
  assert.match(append,/setWalStorageVerified\(KEY, text/);
  assert.match(append,/writeRows\(next\)/);
});

test('shared WAL completeness requires unique shared IDs before using fast append',()=>{
  const wal=read('state_runtime_v2_wal.js');
  const begin=wal.indexOf('function read()');
  const end=wal.indexOf('function writeRows(rows)',begin);
  const reader=wal.slice(begin,end);
  const count=reader.indexOf('const sharedDistinctRowCount = merged.size');
  const sidecar=reader.indexOf('const inventory = recoveryKeys()');
  assert.ok(count>0&&sidecar>count,'shared ID uniqueness must be recorded before recovery merge');
  assert.match(reader,/sharedComplete: parsed.length === merged.size/);
  assert.match(reader,/&& sharedDistinctRowCount === parsed.length/);
  assert.match(reader,/wal_shared_duplicate_identity_conflict/);
  const append=wal.slice(wal.indexOf('function appendHabitDelta('),
    wal.indexOf('function removeMutation('));
  assert.match(append,/current.sharedComplete && current.raw !== null/);
  assert.match(append,/writeRows\(next\)/,
    'incomplete shared WAL must still rebuild the entire verified union');
});

test('Task completion cleanup protects changed same-ID patches and preserves failed compaction',()=>{
  const journal=read('task_mutation_journal.js');
  const begin=journal.indexOf('function clearVerifiedSnapshot(snapshot)');
  const end=journal.indexOf('function persistedState()',begin);
  assert.ok(begin>0&&end>begin);
  const cleanup=journal.slice(begin,end);
  assert.match(cleanup,/if \(current\.malformed\) return false/);
  assert.match(cleanup,/snapshot\.completionUpserts\.some/);
  assert.match(cleanup,/sameRow\(saved, row\)/);
  assert.match(cleanup,/snapshot\.completionDeletes\.includes\(id\)/);
  const compactStart=journal.indexOf('function persistPending(reason =');
  const compactEnd=journal.indexOf('function scheduleRetry()',compactStart);
  assert.ok(compactStart>0&&compactEnd>compactStart);
  const compact=journal.slice(compactStart,compactEnd);
  const saved=compact.indexOf('originalSaveStateSnapshot(candidate,');
  const verified=compact.indexOf('if (!snapshotVerified(saved, snapshot, result.state))');
  const cleared=compact.indexOf('clearVerifiedSnapshot(snapshot)');
  assert.ok(saved>0&&verified>saved&&cleared>verified,
    'Task journal may clear only after the saved canonical snapshot is verified');
  assert.match(compact,/catch \(error\)/);
  assert.match(compact,/return false;/);
  const runtime=read('state_runtime_v2.js');
  const cutoverStart=runtime.indexOf('async function inspectAuthorityCutoverBarriers()');
  const cutoverEnd=runtime.indexOf('// Explicit forensic inspection',cutoverStart);
  const gate=runtime.slice(cutoverStart,cutoverEnd);
  assert.match(gate,/task_journal_compaction_handoff_not_validated/);
  assert.match(gate,/taskJournalCompactionHandoffValidated: false/);
  assert.match(gate,/canPromote: false/);
});

test('Task journal tombstones do not bypass ordinary completion history protection',()=>{
  const journal=read('task_mutation_journal.js');
  const original=journal.indexOf('core.saveStateSnapshot = function saveStateSnapshotWithTaskJournal(');
  const stop=journal.indexOf('core.readPendingTaskMutations =',original);
  assert.ok(original>0&&stop>original);
  const wrapper=journal.slice(original,stop);
  assert.match(wrapper,/!current\.malformed/);
  assert.match(wrapper,/current\.record\.completionDeletes\.length/);
  assert.match(wrapper,/pendingTaskCompletionDeleteIds/);
  assert.match(wrapper,/originalSaveStateSnapshot\(candidate, protectedSaveOptions\)/);
  const core=read('scoring_core.js');
  const start=core.indexOf('function preserveStickyFieldsBeforeSave(');
  const end=core.indexOf('function saveStateSnapshot(',start);
  assert.ok(start>0&&end>start);
  const guard=core.slice(start,end);
  assert.match(guard,/const pendingTaskCompletionDeleteIds = new Set/);
  assert.match(guard,/Array\.isArray\(options\.pendingTaskCompletionDeleteIds\)/);
  assert.match(guard,/key === 'completions'/);
  assert.match(guard,/next\[key\] = mergeCompletions\(latest\?\.\[key\], next\[key\]\)/);
  assert.match(guard,/pendingTaskCompletionDeleteIds\.has/);
  assert.match(guard,/allowExactReminderOverwrite \|\| pendingTaskCompletionDelete/);
  assert.match(guard,/if \(!allowEmptyArrayOverwrite/);
  assert.doesNotMatch(wrapper,/allowDestructiveOverwrite:\s*true/);
  assert.doesNotMatch(wrapper,/replaceCompletions:\s*true/);
});

test('preview logical mutation batches are bounded, unique and atomic',()=>{
  const runtime=read('state_runtime_v2.js');
  const start=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  assert.ok(start>0&&end>start);
  const code=runtime.slice(start,end);
  for(const evidence of [
    'preview_synthetic_batch_conflicts_with_single','preview_synthetic_batch_invalid',
    'batch.length>8','ids.has(key)','syntheticMutationBatchJson',
    'syntheticEntityKeys: syntheticEntries.map(syntheticEntityKeyFor)',
    'syntheticRecordCount: syntheticEntries.length','storedSyntheticEntries(row)',
    'expectedEntities.set(key,{','syntheticMutationVerified: hasAnySynthetic',
    "'completions'","productionWritersFenced: false","canPromote: false"
  ])assert.ok(code.includes(evidence),'Missing bounded multi-entity protection: '+evidence);
  const entity=code.lastIndexOf('for (const mutation of syntheticEntries)');
  const marker=code.indexOf('store.put({ id: markerId, generation, epoch: state.epoch,',entity);
  const counter=code.indexOf('store.put(next)',marker);
  assert.ok(entity>0&&marker>entity&&counter>marker,
    'All entity writes, immutable intent and counter must share IDB transaction');
  assert.doesNotMatch(code,/localStorage\.setItem\(/);
});

test('preview canonical mutation payload is snapshotted before async hashing',()=>{
  const runtime=read('state_runtime_v2.js');
  const a=runtime.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const b=runtime.indexOf('// Browser-native exclusive-lock *rehearsal*',a);
  const p=runtime.slice(a,b);
  assert.match(p,/hasSyntheticMutation \? \[JSON\.parse\(syntheticMutationJson\)\]/);
  assert.match(p,/hasSyntheticBatch \? JSON\.parse\(syntheticBatchJson\)/);
  const snapshot=p.indexOf('const syntheticEntries=');
  const digest=p.indexOf("global.crypto.subtle.digest('SHA-256', bytes)");
  const materialize=p.indexOf('for (const mutation of syntheticEntries)');
  assert.ok(snapshot>=0&&digest>snapshot&&materialize>digest,
    'The validated intent must be copied before awaiting digest and writing IDB');
  assert.doesNotMatch(p.slice(snapshot,materialize),
    /syntheticEntries\s*=\s*options\.syntheticMutations/);
});

test('preview entity materialization never mistakes marker ID sorting for commit order',()=>{
  const code=read('state_runtime_v2.js');
  const start=code.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=code.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  const preview=code.slice(start,end);
  assert.match(preview,/const seenSyntheticSequences = new Set\(\)/);
  assert.match(preview,/seenSyntheticSequences\.has\(row\.syntheticSequence\)/);
  assert.match(preview,/seenSyntheticSequences\.add\(row\.syntheticSequence\)/);
  assert.match(preview,/former\.syntheticSequence === row\.syntheticSequence/);
  assert.match(preview,/!former \|\| former\.syntheticSequence < row\.syntheticSequence/);
  assert.doesNotMatch(preview,/former && former\.syntheticSequence >= row\.syntheticSequence/);
  assert.match(preview,/row\.sequence !== latest\.syntheticSequence/);
  assert.match(preview,/canPromote: false/);
});


test('historical digest preflight never hashes in an open IDB transaction and requires the complete marker set',()=>{
  const code=read('state_runtime_v2.js');
  const start=code.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const end=code.indexOf('// Browser-native exclusive-lock *rehearsal*',start);
  const preview=code.slice(start,end);
  const preflight=preview.indexOf('const readPreviewMarkerDigestInputs = () =>');
  const snapshotTx=preview.indexOf("const tx=db.transaction(STORE,'readonly')",preflight);
  const scanComplete=preview.indexOf('tx.oncomplete=()=>finish({rows})',snapshotTx);
  const digest=preview.indexOf("global.crypto.subtle.digest('SHA-256',bytes)",scanComplete);
  const verifyTx=preview.indexOf('const tx = db.transaction(STORE,',digest);
  assert.ok(preflight>=0&&snapshotTx>preflight&&scanComplete>snapshotTx
    &&digest>scanComplete&&verifyTx>digest,
    'Hashing must follow a completed read-only snapshot and precede the verification transaction');
  assert.match(preview,/for\(let digestRetry=0;digestRetry<4;digestRetry\+\+\)/);
  assert.match(preview,/historicalMarkerSnapshots=new Map/);
  assert.match(preview,/const historicalUnchanged=historicalMarkerSnapshots\.size/);
  assert.match(preview,/const freshMarkers=markers\.filter/);
  assert.match(preview,/state\.writersCommitted===\s*preflightMarkerCount\+freshMarkers\.length/);
  assert.match(preview,/historicalMarkerSnapshots\.get\(row\.id\)!==stableJson\(row\)/);
  assert.match(preview,/markers\.filter\(row=>historicalMarkerSnapshots\.has\(row\.id\)\)\.length/);
  assert.doesNotMatch(preview,/freshSyntheticMarkers/);
  assert.match(preview,/fence_writer_digest_snapshot_stale/);
  assert.match(preview,/typedMarkerCount === historicalDigestProofs\.size/);
  assert.match(preview,/historicalDigestProofs\.get\(row\.id\)\.digest\s*!== row\.payloadFingerprint/);
  assert.match(preview,/historicalDigestProofs\.get\(row\.id\)\.json !==/);
  assert.match(preview,/historicalPayloadDigestsVerified: true/);
  assert.match(preview,/inventoryVerified: true/);
  assert.match(preview,/inspectAllWriterMarkers\(finishInspection\)/);
  assert.doesNotMatch(preview,/if \(item && hasAnySynthetic\)\s*inspectAllWriterMarkers\(finishInspection\)/);
  assert.match(preview,/markerInventoryVerified: true/);
  assert.match(preview,/canPromote: false/);
});


test('preview marker-only writers and retries share the strict immutable-ledger gate',()=>{
  const code=read('state_runtime_v2.js');
  const a=code.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const b=code.indexOf('// Browser-native exclusive-lock *rehearsal*',a);
  const p=code.slice(a,b);
  const replay=p.indexOf('const finishReplay = () =>');
  const writer=p.indexOf('const commitPreviewWriter = () =>');
  assert.ok(replay>=0&&writer>replay);
  const replayBody=p.slice(replay,writer);
  assert.match(replayBody,/inspectAllWriterMarkers\(finishReplay\)/);
  assert.doesNotMatch(replayBody,/else finishReplay\(\)/);
  const newWrite=p.slice(writer);
  assert.match(newWrite,/inspectAllWriterMarkers\(commitPreviewWriter\)/);
  assert.doesNotMatch(newWrite,/else commitPreviewWriter\(\)/);
  assert.match(p,/for\(let digestRetry=0;digestRetry<4;digestRetry\+\+\)/);
  assert.match(p,/typedMarkerCount === historicalDigestProofs\.size/);
  assert.match(p,/canPromote: false/);
});


test('preview writer sequence must identify the latest durable marker',()=>{
  const code=read('state_runtime_v2.js');
  const a=code.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})');
  const b=code.indexOf('// Browser-native exclusive-lock *rehearsal*',a);
  const p=code.slice(a,b);
  assert.match(p,/writerSequence: next\.writersCommitted/);
  assert.match(p,/const seenKnownWriterSequences = new Set\(\)/);
  assert.match(p,/seenKnownWriterSequences\.has\(knownSequence\)/);
  assert.match(p,/row\.syntheticSequence !== row\.writerSequence/);
  assert.match(p,/const lastKnownSequence=lastMarkerRow/);
  assert.match(p,/lastKnownSequence===state\.writersCommitted/);
  assert.match(p,/const finalSequenceOwner=markers\.find/);
  assert.match(p,/finalSequenceOwner\.id===lastKey/);
  assert.match(p,/lastMarkerSequenceValid/);
  assert.match(p,/markerWriterSequence: item/);
  assert.match(p,/canPromote: false/);
});


test('silent old-tab exclusion cannot be inferred from preview peers or stable V1 inventory',()=>{
  const runtime=read('state_runtime_v2.js');
  const peerStart=runtime.indexOf('async function inspectPreviewWriterPeers()');
  const peerEnd=runtime.indexOf('function publishCommittedRevision(',peerStart);
  const probe=runtime.slice(peerStart,peerEnd);
  const cutoverStart=runtime.indexOf('async function inspectAuthorityCutoverBarriers()');
  const cutoverEnd=runtime.indexOf('// Explicit forensic inspection',cutoverStart);
  const gate=runtime.slice(cutoverStart,cutoverEnd);
  assert.ok(peerStart>=0&&peerEnd>peerStart&&cutoverStart>=0&&cutoverEnd>cutoverStart);
  assert.match(probe,/respondingPreviewTabsOnly: true/);
  assert.match(probe,/silentLegacyWriterExclusionVerified: false/);
  assert.match(probe,/productionWriterAdmissionComplete: false/);
  assert.match(probe,/canPromote: false/);
  assert.match(gate,/silent_or_suspended_legacy_writers_not_excluded/);
  assert.match(gate,/silentLegacyWriterExclusionVerified: false/);
  assert.match(gate,/productionWriterAdmissionComplete: false/);
  assert.match(gate,/legacyWriterQuietWindowProven: false/);
  assert.match(gate,/observedPeersOnly: peers\?\.respondingPreviewTabsOnly === true/);
  assert.match(gate,/fullStorageBefore !== fullStorageAfter/);
  assert.match(gate,/canPromote: false/);
  assert.match(gate,/allLegacyWritersFenced: false/);
});


test('exclusive lease rehearsal inventories non-taskpoints origin keys',()=>{
  const runtime=read('state_runtime_v2.js');
  const inventoryStart=runtime.indexOf('function captureReadOnlyFullStorageInventory()');
  const cutoverStart=runtime.indexOf('async function inspectAuthorityCutoverBarriers()');
  const rehearsalStart=runtime.indexOf('async function rehearseExclusiveWriterLease()');
  const rehearsalEnd=runtime.indexOf('// Stage-C *comparison harness*',rehearsalStart);
  assert.ok(inventoryStart>0&&cutoverStart>inventoryStart
    &&rehearsalStart>cutoverStart&&rehearsalEnd>rehearsalStart);
  const inventory=runtime.slice(inventoryStart,cutoverStart);
  const rehearsal=runtime.slice(rehearsalStart,rehearsalEnd);
  assert.match(inventory,/const entries = \[\.\.\.keys\]\.sort\(\)\.map/);
  assert.match(rehearsal,/JSON\.parse\(captureReadOnlyFullStorageInventory\(\)\)/);
  assert.match(rehearsal,/currentInventory = captureReadOnlyFullStorageInventory\(\)/);
  assert.match(rehearsal,/captureReadOnlyFullStorageInventory\(\) !== currentInventory/);
  assert.match(rehearsal,/legacy_changed_under_lock/);
  assert.match(rehearsal,/legacy_changed_during_lock_verification/);
  assert.doesNotMatch(rehearsal,/previewRecoveryFingerprint\(captureLegacyNamespace\(\)\)/);
  assert.doesNotMatch(rehearsal,/currentInventory = captureLegacyNamespace\(\)/);
  assert.match(rehearsal,/canPromote: false/);
});


test('Main Work action batches atomic V1 journal writes without removing fallback',()=>{
  const journal=read('task_mutation_journal.js');
  const work=read('work_entry_fast_path.js');
  const coreStart=journal.indexOf('function journalMutation(mutation = {})');
  const coreEnd=journal.indexOf('function applyRecord(',coreStart);
  const core=journal.slice(coreStart,coreEnd);
  const workStart=work.indexOf('function journalRows(rows)');
  const workEnd=work.indexOf('function runFastCommit(',workStart);
  const batch=work.slice(workStart,workEnd);
  assert.ok(coreStart>=0&&coreEnd>coreStart&&workStart>=0&&workEnd>workStart);
  assert.match(core,/Object\.prototype\.hasOwnProperty\.call\(mutation, 'completionUpserts'\)/);
  assert.match(core,/rows\.length > 64/);
  assert.match(core,/seen\.has\(id\)/);
  // All batch IDs are validated before one linear scan; the legacy
  // single-row journal path still uses mergeById for compatibility.
  const batchCoreStart=core.indexOf("if (Object.prototype.hasOwnProperty.call(mutation, 'completionUpserts'))");
  const batchCoreEnd=core.indexOf('if (mutation.completionDeleteId)',batchCoreStart);
  assert.ok(batchCoreStart>=0&&batchCoreEnd>batchCoreStart);
  const batchCore=core.slice(batchCoreStart,batchCoreEnd);
  assert.match(batchCore,/record\.completionUpserts = record\.completionUpserts\.filter\(/);
  assert.match(batchCore,/for \(const row of rows\) record\.completionUpserts\.push\(clone\(row\)\)/);
  assert.doesNotMatch(batchCore,/mergeById\(/);
  assert.match(core,/TASKPOINTS_TASK_COMPLETION_BATCH_INVALID/);
  // One single synchronous journal commit after every validated row is
  // merged. The writeRecord helper itself performs the only setItem.
  const writeStart=journal.indexOf('function writeRecord(record, alreadyNormalized = false)');
  const writeEnd=journal.indexOf('function mergeById(',writeStart);
  assert.ok(writeStart>0&&writeEnd>writeStart);
  assert.equal((core.match(/writeRecord\(record, true\)/g)||[]).length,1);
  assert.match(journal.slice(writeStart,writeEnd),
    /storage\.setItem\(JOURNAL_KEY, JSON\.stringify\(normalized\)\)/);
  assert.match(journal,/core\.journalTaskCompletionBatch = \(rows\) => journalMutation\(\{ completionUpserts: rows \}\)/);
  assert.match(batch,/typeof core\.journalTaskCompletionBatch === 'function'/);
  assert.match(batch,/core\.journalTaskCompletionBatch\(completeRows\)/);
  assert.match(batch,/counters\.journaledCompletionUpserts \+= completeRows\.length/);
  assert.match(batch,/return;/);
  assert.match(batch,/core\.journalTaskMutation\(\{ completionUpsert: clone\(entry\) \}\)/);
  // The existing confirmed full snapshot path stays active on failure.
  assert.match(work,/workSaveConfirmed = saveFallback\(priorSave, 'journal-write-failed', true\)/);
  assert.match(work,/if \(pending && scwm\.flush\?\.\(\) !== true\)/);
  assert.match(read('state_runtime_v2.js'),/workEntryAtomicAdmissionVerified: false/);
  assert.match(read('state_runtime_v2.js'),/work_entry_multirecord_admission_not_validated/);
});

test('preview writer admission checks independent full-origin keys under its exclusive lease',()=>{
  const source=read('state_runtime_v2.js');
  const begin=source.indexOf('async function exercisePreviewSerializedSnapshotLease(operation)');
  const end=source.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})',begin);
  assert.ok(begin>0&&end>begin);
  const rehearsal=source.slice(begin,end);
  assert.match(rehearsal,/const assertPreviewFullOriginInventoryUnchanged = expectedSerialized =>/);
  assert.match(rehearsal,/if \(!callbackActive\)/);
  assert.match(rehearsal,/assertPreviewGenerationCurrent\(\)/);
  assert.match(rehearsal,/actual = captureReadOnlyFullStorageInventory\(\)/);
  assert.match(rehearsal,/actual !== expectedSerialized/);
  assert.match(rehearsal,/STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_CHANGED/);
  assert.match(rehearsal,/serialized_operation_full_origin_changed/);
  assert.match(rehearsal,/serialized_operation_full_origin_unreadable/);
  assert.match(rehearsal,/serialized_operation_full_origin_token_required/);
  assert.match(rehearsal,/assertPreviewFullOriginInventoryUnchanged\n    \}\)/);
  assert.match(rehearsal,/mode: 'exclusive', ifAvailable: true/);
  assert.match(rehearsal,/canPromote: false/);
  assert.match(rehearsal,/productionWritersFenced: false/);
  assert.match(rehearsal,/callbackActive = false/);
  assert.ok(!read('task_mutation_journal.js').includes('assertPreviewFullOriginInventoryUnchanged'),
    'the preview guard must not intercept the existing synchronous V1 Task journal');
});

test('mandatory preview-only Task batch admission validates source and generation before the actual journal write',()=>{
  const source=read('state_runtime_v2.js');
  const begin=source.indexOf('async function rehearsePreviewAdmittedTaskCompletionBatch(rowsInput, expectedInventoryToken)');
  const end=source.indexOf('async function rehearsePreviewDurableWriterFence(action, options = {})',begin);
  assert.ok(begin>0&&end>begin);
  const method=source.slice(begin,end);
  for(const evidence of [
    'if (!isWalTestPreviewHost())',
    'if (!isDarkEnabled())',
    'const originalEpoch = darkMirrorModeEpoch',
    'currentGeneration({ create: false })',
    'typeof core.journalTaskCompletionBatch',
    'typeof core.assertTaskMutationJournalWritable',
    "mode: 'exclusive', ifAvailable: true",
    'currentInventory = captureReadOnlyFullStorageInventory()',
    'currentInventory !== expectedInventoryToken',
    'core.assertTaskMutationJournalWritable()',
    'core.journalTaskCompletionBatch(rows)',
    "global.localStorage.getItem('taskpoints_pending_task_mutations_v1')",
    'rows.every(row =>',
    "reason: 'preview_task_batch_admitted'",
    'confirmedDurable: true',
    'productionWritersFenced: false',
    "mutationAuthority: 'legacy_only'",
    "readAuthority: 'legacy_only'",
    "writeOutcomeUncertain: true",
    "'generation_changed_after_write'"
  ]) assert.ok(method.includes(evidence),'Missing safety invariant: '+evidence);
  assert.ok(method.indexOf('currentInventory !== expectedInventoryToken')
    < method.indexOf('core.journalTaskCompletionBatch(rows)'),
    'freshness admission must precede the durable V1 journal write');
  assert.ok(method.indexOf('core.journalTaskCompletionBatch(rows)')
    < method.indexOf('rows.every(row =>'),
    'readback may only verify a completed synchronous batch');
  assert.ok(!method.includes('core.saveStateSnapshot('));
  assert.ok(!method.includes('safeReplaceTaskPointsStorage('));
  assert.ok(!method.includes('canPromote: true'));
  assert.ok(source.includes('    rehearsePreviewAdmittedTaskCompletionBatch,'),
    'preview adapter must only be available as an explicitly invoked API');
  assert.ok(!read('task_mutation_journal.js').includes('rehearsePreviewAdmittedTaskCompletionBatch'),
    'preview adapter must not intercept production Task journaling');
});

test('nonpilot Tasks store is additive, explicit, source-verified and cannot become authoritative',()=>{
  const source=read('state_runtime_v2.js');
  const begin=source.indexOf('async function rehearsePreviewTaskCollectionSeed()');
  const end=source.indexOf('// A narrower stepping stone toward REQUIRED writer admission',begin);
  assert.ok(begin>0&&end>begin);
  const preview=source.slice(begin,end);
  assert.match(source,/const DB_VERSION = 6/);
  assert.match(source,/if \(!db\.objectStoreNames\.contains\('tasks'\)\) db\.createObjectStore\('tasks', \{ keyPath: 'id' \}\)/);
  assert.match(source,/if \(!db\.objectStoreNames\.contains\('projects'\)\) db\.createObjectStore\('projects', \{ keyPath: 'id' \}\)/);
  assert.match(source,/if \(!db\.objectStoreNames\.contains\('todayDays'\)\) db\.createObjectStore\('todayDays', \{ keyPath: 'id' \}\)/);
  assert.match(source,/const STORE_NAMES = Object\.freeze\(\['habits', 'completions', 'mutations', 'meta'\]\)/);
  for(const evidence of [
    'if (!isWalTestPreviewHost())',
    'if (!isDarkEnabled())',
    'core.readPendingTaskMutations()',
    'if (pending?.malformed)',
    'core.readTaskPointsStoredState()',
    'inventoryBefore !== inventoryAfter',
    'await previewRecoveryFingerprint(tasks)',
    'const generation = currentGeneration({ create: false })',
    "db.transaction(['tasks','meta'], 'readwrite')",
    "metaStore.get('task-preview')",
    'task_preview_concurrent_conflict',
    'task_preview_existing_evidence_preserved',
    'task_preview_readback_mismatch',
    'legacy_changed_after_seed',
    'productionWritersFenced:false',
    "mutationAuthority:'legacy_only'",
    'canPromote:false'
  ]) assert.ok(preview.includes(evidence),'Missing nonpilot migration safety invariant: '+evidence);
  assert.ok(preview.indexOf('captureReadOnlyFullStorageInventory()')
    < preview.indexOf("db.transaction(['tasks','meta'], 'readwrite')"));
  assert.ok(!preview.includes('core.saveStateSnapshot('));
  assert.ok(!preview.includes('core.journalTaskMutation('));
  assert.ok(!preview.includes('canPromote:true'));
  assert.match(source,/    rehearsePreviewTaskCollectionSeed,/);
});
