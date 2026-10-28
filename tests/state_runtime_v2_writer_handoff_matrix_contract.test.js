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
    "function scheduleCompaction(reason = 'scheduled')",
    "deferred",
    "verified_compaction"
  ]
];
const FAMILIES = [
  'scoring_core_snapshot_and_habit_journal',
  'home_direct_keys_and_snapshot_saves',
  'today_snapshot_and_view_state',
  'settings_import_reset_and_direct_storage',
  'notes_content_dirty_and_authority_flags',
  'emergency_recovery_and_restore',
  'task_journal_and_idle_compaction'
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
  assert.ok(SOURCE_ANCHORS.length >= 35,
    'Writer evidence inventory silently reduced without an explicit migration review');
  assert.equal(sourceByFile.size,7,'One of the seven known writer-owner source files went missing');
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
