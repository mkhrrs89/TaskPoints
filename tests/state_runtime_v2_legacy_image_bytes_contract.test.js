'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const runtime=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const start=runtime.indexOf('async function inspectPreviewLegacyImageBytes(');
const end=runtime.indexOf('// V2 PREVIEW ONLY: observe real, already-durable V1 Task journal edits.',start);
const source=runtime.slice(start,end);

test('whole legacy image byte audit is preview-only and cannot claim migration or recovery',()=>{
  assert.ok(start>0&&end>start);
  assert.match(source,/isWalTestPreviewHost\(\)/);
  assert.match(source,/isDarkEnabled\(\)/);
  assert.match(source,/currentGeneration\(\{create:false\}\)/);
  assert.match(source,/mode:'exclusive',ifAvailable:true/);
  assert.match(source,/binaryImageBytesVerified:false/);
  assert.match(source,/offDeviceBackupVerified:false/);
  assert.match(source,/backupComplete:false,canRestore:false,canPromote:false/);
  assert.match(source,/readAuthority:'legacy_only',mutationAuthority:'legacy_only'/);
  assert.match(runtime,/inspectPreviewIndependentBackupCoverage,\s*inspectPreviewLegacyImageBytes,/);
});

test('image audit requires exact source and existing database without upgrading or altering V1 bytes',()=>{
  assert.match(source,/captureReadOnlyFullStorageInventory\(\)===expectedInventoryToken/);
  assert.match(source,/indexedDB\?\.databases/);
  assert.match(source,/idb\.databases\(\)/);
  assert.match(source,/request\.onupgradeneeded=\(\)=>\{/);
  assert.match(source,/request\.transaction\?\.abort\(\)/);
  assert.match(source,/db\.transaction\(storeName,'readonly'\)/);
  assert.doesNotMatch(source,/\b(?:localStorage|storage)\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(source,/\b(?:saveImageBlob|deleteImageBlob|saveStateSnapshot|journalTaskMutation)\s*\(/);
  // Set.add() tracks duplicate image IDs in memory; it is not a storage write.
  assert.doesNotMatch(source,/\b(?:store|tx|db|localStorage)\.(?:put|delete|add|clear|setItem|removeItem)\s*\(/);
});

test('all-image audit checks every row twice and hashes image content, not just counts',()=>{
  assert.match(source,/getAllKeys\(undefined,maxRows\+1\)/,
    'key enumeration must be bounded even if a peer adds rows after count');
  assert.doesNotMatch(source,/\.getAll\s*\(/,
    'loading every image Blob at once can exceed an iPhone memory budget');
  assert.match(source,/requestPromise\(rowTx\.objectStore\(storeName\)\.get\(id\)\)/,
    'stream image reads one key at a time');
  assert.match(source,/const rowTx=db\.transaction\(storeName,'readonly'\)/);
  assert.match(source,/const \[blob\]=await Promise\.all\(\[/);
  assert.match(source,/rowDone/);
  assert.match(source,/if\(bytes>maxBytes\)throw Error\('legacy_image_byte_budget_exceeded'\);/);
  assert.ok(source.indexOf('if(bytes>maxBytes)')<source.indexOf('await blob.arrayBuffer()'),
    'byte budget must be enforced before allocating an image buffer');
  assert.match(source,/\.count\(\)/);
  assert.match(source,/const first=await capture\(\)/);
  assert.match(source,/const second=await capture\(\)/);
  assert.match(source,/stableJson\(first\)!==stableJson\(second\)/);
  assert.match(source,/blob\.arrayBuffer\(\)/);
  assert.match(source,/crypto\.subtle\.digest\('SHA-256',data\)/);
  assert.match(source,/Number\.isSafeInteger\(blob\.size\)/);
  assert.match(source,/legacy_image_blob_invalid/);
  assert.match(source,/legacy_image_byte_budget_exceeded/);
  assert.match(source,/legacy_image_count_changed/);
  assert.match(source,/legacy_image_missing/);
  assert.match(source,/legacy_image_bytes_changed_during_audit/);
  assert.match(source,/imageReferencesCovered:false/);
  assert.doesNotMatch(source,/\.get\(\s*(?:imageId|id)\s*\)/,
    'full inventory may not silently narrow itself to currently referenced IDs');
});
