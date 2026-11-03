'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const runtime=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const start=runtime.indexOf('async function inspectPreviewTaskCollectionParity()');
const end=runtime.indexOf('async function inspectPreviewTaskRecord(idInput)',start);
const source=runtime.slice(start,end);

test('nonpilot Tasks inspector requires preview host and never mutates any source',()=>{
  assert.ok(start>=0 && end>start);
  assert.match(source,/isWalTestPreviewHost\(\)/);
  assert.match(source,/isDarkEnabled\(\)/);
  assert.match(source,/captureReadOnlyFullStorageInventory\(\)/);
  assert.match(source,/core\.readPendingTaskMutations\(\)/);
  assert.match(source,/core\.readTaskPointsStoredState\(\)/);
  assert.match(source,/db\.transaction\(\['tasks', 'meta'\], 'readonly'\)/);
  assert.doesNotMatch(source,/\b(?:tasksStore|mutationsStore)\.(?:put|add|delete|clear)\s*\(/);
  // Set.add() is bookkeeping for duplicate detection, not a storage write.
  // Restrict mutation bans to browser persistence APIs and canonical saves.
  assert.doesNotMatch(source,/\b(?:setItem|removeItem|saveStateSnapshot|journalTaskMutation)\s*\(/);
  assert.doesNotMatch(source,/\.objectStore\([^)]*\)\.(?:put|add|delete|clear)\s*\(/);
  assert.doesNotMatch(source,/\b(?:store|metaStore|localStorage)\.(?:put|add|delete|clear|setItem|removeItem)\s*\(/);
  assert.match(source,/mutationAuthority: 'legacy_only'/);
  assert.match(source,/canPromote: false/);
});

test('targeted Task read uses one IDB get and never implies collection-wide parity',()=>{
  const start=runtime.indexOf('async function inspectPreviewTaskRecord(idInput)');
  const end=runtime.indexOf('async function rehearsePreviewTaskRecordUpdate(',start);
  assert.ok(start>=0 && end>start);
  const snippet=runtime.slice(start,end);
  assert.match(snippet,/db\.transaction\(\['tasks', 'meta'\], 'readonly'\)/);
  assert.match(snippet,/tx\.objectStore\('tasks'\)\.get\(id\)/);
  assert.doesNotMatch(snippet,/tx\.objectStore\('tasks'\)\.getAll\(/);
  assert.match(snippet,/collectionParityVerified: false/);
  assert.match(snippet,/record\.legacyIndex === expectedIndex/);
  assert.match(snippet,/evidence\.taskFingerprint !== fingerprint/);
  assert.match(snippet,/currentGeneration\(\{ create: false \}\) === generation/);
  assert.match(snippet,/canPromote: false/);
  assert.match(runtime,/inspectPreviewTaskCollectionParity,\s*inspectPreviewTaskRecord,/);
});

test('preview Task update requires single atomic row/receipt transaction and refuses V1 mutation',()=>{
  const start=runtime.indexOf('async function rehearsePreviewTaskRecordUpdate(');
  const end=runtime.indexOf('// A narrower stepping stone toward REQUIRED writer admission',start);
  assert.ok(start>=0 && end>start);
  const update=runtime.slice(start,end);
  assert.match(update,/isWalTestPreviewHost\(\)/);
  assert.match(update,/db\.transaction\(\['tasks', 'mutations', 'meta'\], 'readwrite'\)/);
  assert.match(update,/tasksStore\.put\(/);
  assert.match(update,/mutationsStore\.add\(receipt\)/);
  assert.match(update,/transactionPromise\(tx\)/);
  assert.match(update,/db\.transaction\(\['tasks', 'mutations'\], 'readonly'\)/);
  assert.match(update,/previousReceipt/);
  assert.match(update,/task_preview_target_stale/);
  assert.match(update,/legacy_changed_after_preview_commit/);
  assert.match(update,/collectionParityVerified: false/);
  assert.match(update,/canPromote: false/);
  assert.doesNotMatch(update,/\b(?:journalTaskMutation|journalTaskCompletionBatch|saveStateSnapshot)\s*\(/);
  assert.doesNotMatch(update,/localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.match(runtime,/inspectPreviewTaskRecord,\s*rehearsePreviewTaskRecordUpdate,/);
});

test('Task lifecycle preview commits row, retry receipt and ordering counter in one IDB transaction',()=>{
  const begin=runtime.indexOf('async function rehearsePreviewTaskLifecycleMutation(');
  const end=runtime.indexOf('// A narrower stepping stone toward REQUIRED writer admission',begin);
  assert.ok(begin>=0 && end>begin);
  const snippet=runtime.slice(begin,end);
  assert.match(snippet,/isWalTestPreviewHost\(\)/);
  assert.match(snippet,/db\.transaction\(\['tasks', 'mutations', 'meta'\], 'readwrite'\)/);
  assert.match(snippet,/taskStore\.add\(/);
  assert.match(snippet,/taskStore\.delete\(taskId\)/);
  assert.match(snippet,/metaStore\.put\(/);
  assert.match(snippet,/mutationStore\.add\(receipt\)/);
  assert.match(snippet,/transactionPromise\(tx\)/);
  assert.match(snippet,/db\.transaction\(\['tasks', 'mutations'\], 'readonly'\)/);
  assert.match(snippet,/task_preview_lifecycle_counter_invalid/);
  assert.match(snippet,/task_action_id_conflict/);
  assert.match(snippet,/legacy_changed_after_preview_commit/);
  assert.match(snippet,/collectionParityVerified: false/);
  assert.match(snippet,/canPromote: false/);
  assert.doesNotMatch(snippet,/\b(?:journalTaskMutation|journalTaskCompletionBatch|saveStateSnapshot)\s*\(/);
  assert.doesNotMatch(snippet,/localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.match(runtime,/rehearsePreviewTaskRecordUpdate,\s*rehearsePreviewTaskLifecycleMutation,/);
});

test('linked Task completion preview requires unchanged V1 journal and atomic completion receipt',()=>{
  const begin=runtime.indexOf('async function rehearsePreviewTaskLinkedCompletion(');
  const end=runtime.indexOf('// A narrower stepping stone toward REQUIRED writer admission',begin);
  assert.ok(begin>=0&&end>begin);
  const snippet=runtime.slice(begin,end);
  assert.match(snippet,/isWalTestPreviewHost\(\)/);
  assert.match(snippet,/core\.readPendingTaskMutations\(\)/);
  assert.match(snippet,/core\.readTaskPointsStoredState\(\)/);
  assert.match(snippet,/captureReadOnlyFullStorageInventory\(\)/);
  assert.match(snippet,/isPilotCompletion\(completion\)/);
  assert.match(snippet,/db\.transaction\(\['tasks','completions','mutations','meta'\], 'readwrite'\)/);
  assert.match(snippet,/completionStore\.add\(packed\)/);
  assert.match(snippet,/mutationStore\.add\(receipt\)/);
  assert.match(snippet,/transactionPromise\(tx\)/);
  assert.match(snippet,/db\.transaction\(\['tasks','completions','mutations'\], 'readonly'\)/);
  assert.match(snippet,/stableJson\(row\) !== stableJson\(packed\)/);
  assert.match(snippet,/task_preview_linked_task_stale/);
  assert.match(snippet,/task_preview_completion_id_exists/);
  assert.match(snippet,/collectionParityVerified: false/);
  assert.match(snippet,/canPromote: false/);
  assert.doesNotMatch(snippet,/\b(?:journalTaskMutation|journalTaskCompletionBatch|saveStateSnapshot)\s*\(/);
  assert.doesNotMatch(snippet,/localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.match(runtime,/rehearsePreviewTaskLifecycleMutation,\s*rehearsePreviewTaskLinkedCompletion,/);
});

test('Task completion batches are journal-backed, bounded and atomically verified',()=>{
  const start=runtime.indexOf('async function rehearsePreviewTaskLinkedCompletionBatch(');
  const end=runtime.indexOf('// A narrower stepping stone toward REQUIRED writer admission',start);
  assert.ok(start>=0&&end>start);
  const source=runtime.slice(start,end);
  assert.match(source,/idsInput\.length > 64/);
  assert.match(source,/new Set\(idsInput\)\.size !== idsInput\.length/);
  assert.match(source,/core\.readPendingTaskMutations\(\)/);
  assert.match(source,/core\.readTaskPointsStoredState\(\)/);
  assert.match(source,/isPilotCompletion\(completion\)/);
  assert.match(source,/db\.transaction\(\['tasks','completions','mutations','meta'\],'readwrite'\)/);
  assert.match(source,/for \(const row of packedRows\) completionStore\.add\(row\)/);
  assert.match(source,/mutationStore\.add\(receipt\)/);
  assert.match(source,/await transactionPromise\(tx\)/);
  assert.match(source,/db\.transaction\(\['tasks','completions','mutations'\],'readonly'\)/);
  assert.match(source,/completionRows\.every/);
  assert.match(source,/task_completion_action_id_conflict/);
  assert.match(source,/collectionParityVerified:false/);
  assert.match(source,/canPromote:false/);
  assert.doesNotMatch(source,/localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(source,/\b(?:journalTaskMutation|journalTaskCompletionBatch|saveStateSnapshot)\s*\(/);
  assert.match(runtime,/rehearsePreviewTaskLinkedCompletion,\s*rehearsePreviewTaskLinkedCompletionBatch,/);
});

test('Task parity checks identity, payload, source inventory and generation without trusting metadata alone',()=>{
  assert.match(source,/previewRecoveryFingerprint\(tasks\)/);
  assert.match(source,/evidence\.taskFingerprint !== taskFingerprint/);
  assert.match(source,/evidence\.sourceInventory !== inventorySignature/);
  assert.match(source,/evidence\.resetGeneration !== generation/);
  assert.match(source,/row\.legacyIndex !== index/);
  assert.match(source,/String\(row\.value\.id\) !== row\.id/);
  assert.match(source,/stableJson\(row\.value\) !== stableJson\(tasks\[index\]\)/);
  assert.match(source,/if \(!sourceCurrent\(\)\) return refuse\('legacy_changed_during_inspection'\)/);
  assert.match(runtime,/rehearsePreviewTaskCollectionSeed,\s*inspectPreviewTaskCollectionParity,/);
});
