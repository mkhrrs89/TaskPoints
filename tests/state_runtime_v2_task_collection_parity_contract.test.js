'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const runtime=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const start=runtime.indexOf('async function inspectPreviewTaskCollectionParity()');
const end=runtime.indexOf('// A narrower stepping stone toward REQUIRED writer admission',start);
const source=runtime.slice(start,end);

test('nonpilot Tasks inspector requires preview host and never mutates any source',()=>{
  assert.ok(start>=0 && end>start);
  assert.match(source,/isWalTestPreviewHost\(\)/);
  assert.match(source,/isDarkEnabled\(\)/);
  assert.match(source,/captureReadOnlyFullStorageInventory\(\)/);
  assert.match(source,/core\.readPendingTaskMutations\(\)/);
  assert.match(source,/core\.readTaskPointsStoredState\(\)/);
  assert.match(source,/db\.transaction\(\['tasks', 'meta'\], 'readonly'\)/);
  assert.doesNotMatch(source,/\b(?:put|add|delete|clear|setItem|removeItem|saveStateSnapshot|journalTaskMutation)\s*\(/);
  assert.match(source,/mutationAuthority: 'legacy_only'/);
  assert.match(source,/canPromote: false/);
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
