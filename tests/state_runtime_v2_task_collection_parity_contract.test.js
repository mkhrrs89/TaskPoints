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
