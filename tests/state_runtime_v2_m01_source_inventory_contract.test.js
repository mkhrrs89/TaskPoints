'use strict';
// M01 is NOT passed by this test. It prevents the source/key discovery
// baseline from silently getting out of sync with the V2 branch.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const inventory=JSON.parse(fs.readFileSync(path.join(
  root,'docs/state-runtime-v2-storage-source-inventory.json'),'utf8'));
const allSources=()=>fs.readdirSync(root,{withFileTypes:true})
  .filter(entry=>entry.isFile()&&/\.(?:html|js|mjs)$/.test(entry.name))
  .map(entry=>entry.name).sort();

test('M01 discovery covers every root source file and fails closed on new filenames',()=>{
  assert.equal(inventory.schemaVersion,1);
  assert.deepEqual(inventory.sourceFiles,allSources(),
    'new/removed source file requires an explicit M01 inventory update');
  assert.equal(new Set(inventory.sourceFiles).size,inventory.sourceFiles.length);
  assert.ok(inventory.sourceFiles.length>=168);
  assert.ok(inventory.limitations.some(x=>/NOT exhaustive/.test(x)),
    'source discovery must not be falsely described as full writer ownership');
});

test('M01 first-pass inspection is distinct from full owner/writer validation',()=>{
  const files=new Set(inventory.sourceFiles);
  assert.ok(inventory.firstPassInspected.length>0);
  assert.equal(new Set(inventory.firstPassInspected).size,
    inventory.firstPassInspected.length);
  for(const file of inventory.firstPassInspected)
    assert.ok(files.has(file),'inspected source must exist: '+file);
  assert.equal(inventory.firstPassInspected.length,files.size,
    'the root-source first pass must remain complete');
  assert.equal(inventory.writerOwnershipAudit?.status,'incomplete');
  assert.equal(inventory.writerOwnershipAudit?.productionAuthority,'v1');
  assert.equal(inventory.writerOwnershipAudit?.productionWritersFenced,false);
  assert.ok(inventory.writerOwnershipAudit.unresolvedPassConditions.length>=5,
    'source review must not be mistaken for production ownership certification');
  assert.ok(inventory.limitations.some(x=>/dynamic aliases/.test(x)),
    'dynamic/indirect writers must remain an explicit unresolved risk');
});

test('M01 known key/IDB evidence points to actual source bytes',()=>{
  const sources=new Map(inventory.firstPassInspected.map(name=>[
    name,fs.readFileSync(path.join(root,name),'utf8')
  ]));
  const families=new Set(['core','habits','tasks','notes','today','projects',
    'game','season','settings','backup','recovery','storage','v2-preview','session']);
  assert.ok(inventory.keyEvidence.length>=30);
  for(const entry of inventory.keyEvidence){
    assert.ok(typeof entry.key==='string'&&entry.key.length>=3);
    assert.ok(families.has(entry.family),'unclassified key: '+entry.key);
    assert.ok(entry.role.length>=12,'key meaning required: '+entry.key);
    assert.ok(sources.has(entry.evidencePath),
      'key source is not first-pass inspected: '+entry.evidencePath);
    assert.ok(sources.get(entry.evidencePath).includes(entry.key),
      'key no longer found at evidence path: '+entry.key);
  }
  assert.ok(inventory.dbEvidence.length>=3);
  for(const db of inventory.dbEvidence){
    const source=sources.get(db.evidencePath);
    assert.ok(source,'uninspected IndexedDB source: '+db.evidencePath);
    assert.ok(source.includes(db.db),'IndexedDB name missing: '+db.db);
    if(db.store!=='multiple')assert.ok(source.includes(db.store),
      'IndexedDB store missing: '+db.store);
  }
});

test('M01 reports discovered storage-use sites and unresolved inspection workload',()=>{
  const inspected=new Set(inventory.firstPassInspected);
  const storageTouched=[];
  const possibleSinks=[];
  // Conservative discovery aid, NOT a complete dataflow/callgraph proof.
  // This includes HTML inline scripts and imported helper modules.
  const touch=/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bIDBDatabase\b|\bgetItem\s*\(|\bsetItem\s*\(|\bdeleteDatabase\s*\(/;
  const directSink=/\b(?:localStorage|sessionStorage)\s*(?:\.\s*(?:setItem|removeItem|clear)|\[\s*['"](?:setItem|removeItem|clear)['"]\])\s*\(|\bindexedDB\s*\.\s*(?:open|deleteDatabase)\s*\(/;
  for(const file of inventory.sourceFiles){
    const text=fs.readFileSync(path.join(root,file),'utf8');
    if(touch.test(text))storageTouched.push(file);
    if(directSink.test(text))possibleSinks.push(file);
  }
  const unresolved=storageTouched.filter(x=>!inspected.has(x));
  console.log('M01 first-pass inventory metrics:',JSON.stringify({
    allRootSources:inventory.sourceFiles.length,
    firstPassInspected:inspected.size,
    remainingRootSources:inventory.sourceFiles.length-inspected.size,
    storageTouchingFiles:storageTouched.length,
    storageTouchingFilesAwaitingReview:unresolved.length,
    directSinkCandidateFiles:possibleSinks.length,
    // Never show this as a validated-percent-complete or M01 pass.
    note:'discovery only; dynamic aliases, source fields, IDB stores and production writers remain unverified'
  }));
  assert.ok(storageTouched.length>=inspected.size/2,
    'unexpected scanner drop must trigger review');
  assert.equal(unresolved.length,0,
    'every storage-touching root file requires source-level first-pass review');
  assert.equal(inventory.writerOwnershipAudit.status,'incomplete',
    'a full root scan does NOT certify dynamic/indirect writer ownership');
});

test('M01 tracks every explicitly normalized V1 snapshot field without claiming exhaustiveness',()=>{
  const evidence=inventory.primarySnapshotFieldEvidence;
  assert.equal(evidence.path,'scoring_core.js');
  const core=fs.readFileSync(path.join(root,evidence.path),'utf8');
  const start=core.indexOf('function normalizeState(s)');
  const end=core.indexOf('\n  function ',start+10);
  assert.ok(start>=0&&end>start);
  const source=core.slice(start,end);
  assert.match(source,/\.\.\.src/,
    'source permits unknown keys: never treat explicit list as exhaustive');
  const discovered=[...new Set([...source.matchAll(/\bsrc\.([a-zA-Z_$][\w$]*)/g)]
    .map(m=>m[1]))].sort();
  assert.deepEqual(inventory.primarySnapshotNamedFields.slice().sort(),discovered,
    'normalizeState added/removed field: review M01 V1 field-owner inventory');
  assert.ok(discovered.length>=30);
  assert.match(evidence.limitation,/additional unknown fields/);
});


// M01 second-pass dynamic source witness: test the *literal* preview catalog
// against the reviewed inventory so new keys/fields force explicit updates.
test('M01 preview unknown-key witness maps exactly the current reviewed source names',()=>{
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const keys=runtime.match(/const M01_REVIEWED_ORIGIN_KEY_FAMILIES = Object\.freeze\((\{[^\n]+\})\);/);
  const fields=runtime.match(/const M01_EXPLICIT_LEGACY_FIELDS = Object\.freeze\((\[[^\n]+\])\);/);
  assert.ok(keys&&fields,'source-linked preview inventory catalog missing');
  const actual=JSON.parse(keys[1]);
  const expected={};
  for(const row of inventory.keyEvidence){
    if(!expected[row.key])expected[row.key]=[];
    if(!expected[row.key].includes(row.family))expected[row.key].push(row.family);
  }
  for(const family of Object.values(expected))family.sort();
  assert.deepEqual(actual,expected,
    'source manifest and preview inventory must not drift or invent owners');
  assert.deepEqual(JSON.parse(fields[1]),
    [...inventory.primarySnapshotNamedFields].sort(),
    'explicitly normalized V1 fields must stay source-linked');
  assert.equal(Object.keys(actual).length,new Set(inventory.keyEvidence.map(x=>x.key)).size);
});

test('M01 live unknown-owner observer is read-only, preview-scoped and permanently non-promotable',()=>{
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const start=runtime.indexOf('async function inspectPreviewDynamicOwnerGaps(');
  const end=runtime.indexOf('// Explicit developer-preview-only recovery *coverage* inventory.',start);
  assert.ok(start>0&&end>start);
  const source=runtime.slice(start,end);
  for(const required of [
    'isWalTestPreviewHost()', 'isDarkEnabled()',
    'captureReadOnlyFullStorageInventory()',
    'currentGeneration({create:false})',
    'parseTaskPointsStorageJson(main[1],null)',
    'unknownOriginKeys:unknownKeys',
    'unknownPrimaryFields:unknownFields',
    "ownerCoverageVerified:false,allWritersKnown:false",
    "productionWritersFenced:false,canPromote:false",
    "readAuthority:'legacy_only',mutationAuthority:'legacy_only'"
  ])assert.ok(source.includes(required),'M01 observer lost guard: '+required);
  assert.match(source,/previewRecoveryFingerprint\(entries\)/);
  assert.match(runtime,/inspectPreviewIndependentBackupCoverage,\s*inspectPreviewDynamicOwnerGaps,/);
  assert.doesNotMatch(source,/\b(?:localStorage|storage)\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(source,/\b(?:saveStateSnapshot|journalTaskMutation|seedFromLegacy|safeReplaceTaskPointsStorage)\s*\(/);
  assert.doesNotMatch(source,/\b(?:put|deleteDatabase|clear)\s*\(/);
  // Exclude comments when prohibiting execution: mentioning the legacy
  // normalizer in a safety explanation is not the same as calling it.
  const executable=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  assert.doesNotMatch(executable,/\bnormalizeState\s*\(/,
    'do not normalize unknown imported fields out of the live source witness');
});


test('M01 IndexedDB database/store preview catalog exactly matches source-reviewed DB examples',()=>{
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const catalog=runtime.match(/const M01_REVIEWED_IDB_STORE_EVIDENCE = Object\.freeze\((\{[^\n]+\})\);/);
  assert.ok(catalog,'M01 known IDB names must be source-linked, never guessed');
  const actual=JSON.parse(catalog[1]);
  const expected=Object.fromEntries(inventory.dbEvidence.map(row=>[
    row.db,{knownStore:row.store==='multiple'?null:row.store,
      state:row.state,owner:row.owner}
  ]));
  assert.deepEqual(actual,expected,
    'do not remove or silently mark a new IDB store as already owner-verified');
  assert.ok(Object.values(actual).some(row=>row.knownStore===null),
    'source catalog must explicitly signal that V2 multi-store schema remains incomplete');
});

test('M01 live IndexedDB ownership witness remains read-only, bounded and fail-closed',()=>{
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const start=runtime.indexOf('async function inspectPreviewIndexedDbOwnerGaps(');
  const end=runtime.indexOf('// Explicit developer-preview-only recovery *coverage* inventory.',start);
  assert.ok(start>0&&end>start);
  const source=runtime.slice(start,end);
  for(const required of [
    'isWalTestPreviewHost()', 'isDarkEnabled()',
    'captureReadOnlyFullStorageInventory()',
    'currentGeneration({create:false})',
    'previewNotesWitnessObservedExternalChange',
    "typeof global.indexedDB?.databases!=='function'",
    "typeof global.navigator?.locks?.request!=='function'",
    "mode:'exclusive',ifAvailable:true",
    "const maxDatabases=64,maxStores=96",
    'idb.open(item.name)',
    'req.onupgradeneeded=()=>',
    'req.transaction?.abort()',
    'db.objectStoreNames',
    "typeof db.objectStoreNames.contains!=='function'",
    'names.length!==db.objectStoreNames.length',
    'db?.close()',
    'catalog(await idb.databases())',
    'previewRecoveryFingerprint(rows)',
    "sourceStable:true,idbCatalogObserved:true,idbStoresObserved:true",
    "idbRecordBytesVerified:false",
    "independentRecoveryVerified:false",
    "allStoresMapped:false",
    "allWritersKnown:false",
    "ownerCoverageVerified:false",
    "productionWritersFenced:false",
    "canPromote:false",
    "readAuthority:'legacy_only',mutationAuthority:'legacy_only'"
  ])assert.ok(source.includes(required),
    'M01 IDB witness lost safety rule: '+required);
  assert.match(runtime,/inspectPreviewDynamicOwnerGaps,\s*inspectPreviewSessionStorageOwnerGaps,\s*inspectPreviewIndexedDbOwnerGaps,/);
  assert.doesNotMatch(source,/\b(?:localStorage|storage)\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(source,/\b(?:db|store|tx)\.(?:transaction|put|delete|clear|add|createObjectStore)\s*\(/);
  assert.doesNotMatch(source,/\b(?:seedFromLegacy|safeReplaceTaskPointsStorage|saveImageBlob|deleteImageBlob)\s*\(/);
  assert.doesNotMatch(source,/\b(?:getAll|openCursor|openKeyCursor|\.get\s*\(|objectStore\s*\()/,
    'IDB metadata inspection must not read records');
});


test('M01 rejected IDB opens close late successful connections without writing data',async()=>{
  const vm=require('node:vm');
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const start=runtime.indexOf('async function inspectPreviewIndexedDbOwnerGaps(');
  const end=runtime.indexOf('// Explicit developer-preview-only recovery *coverage* inventory.',start);
  assert.ok(start>0&&end>start,'extract only the preview IDB audit');
  const scannerSource=runtime.slice(start,end);
  for(const event of ['onblocked','onupgradeneeded']){
    let closes=0,abortions=0,opens=0;
    const indexedDB={
      databases:async()=>[{name:'taskpoints',version:1}],
      open(name){
        assert.equal(name,'taskpoints');
        opens++;
        const request={transaction:{abort(){abortions++;}}};
        queueMicrotask(()=>{
          request[event]();
          // If an already-rejected IDB request later succeeds, the
          // audit must close it, even though it never owns the promise.
          request.result={close(){closes++;}};
          request.onsuccess();
        });
        return request;
      }
    };
    const context=vm.createContext({
      global:{
        indexedDB,
        navigator:{locks:{request:async(_name,opts,callback)=>{
          assert.equal(opts.mode,'exclusive');
          assert.equal(opts.ifAvailable,true);
          return callback({});
        }}},
        crypto:{subtle:{digest:async()=>new Uint8Array(32)}},
        TextEncoder
      },
      isWalTestPreviewHost:()=>true,
      isDarkEnabled:()=>true,
      darkMirrorModeEpoch:1,
      currentGeneration:()=> 'test-generation',
      previewNotesWitnessObservedExternalChange:()=>false,
      captureReadOnlyFullStorageInventory:()=> 'unchanged-origin',
      PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK:'preview-only-test-lock',
      M01_REVIEWED_IDB_STORE_EVIDENCE:{},
      stableJson:JSON.stringify,
      previewRecoveryFingerprint:async()=> 'fingerprint'
    });
    const inspect=vm.runInContext(
      scannerSource+String.fromCharCode(10)+'inspectPreviewIndexedDbOwnerGaps',context);
    const observed=await inspect('unchanged-origin');
    await Promise.resolve();
    assert.equal(observed.reason,event==='onblocked'
      ?'m01_indexeddb_open_blocked'
      :'m01_indexeddb_database_disappeared');
    assert.equal(observed.sourceStable,false);
    assert.equal(observed.canPromote,false);
    assert.equal(observed.readAuthority,'legacy_only');
    assert.equal(opens,1);
    assert.equal(closes,1,'late successful open must release its IDB handle');
    assert.equal(abortions,event==='onupgradeneeded'?1:0);
  }
});


test('M01 preview sessionStorage census matches all source-known session keys and stays dark/read-only',()=>{
  const runtime=fs.readFileSync(path.join(root,'state_runtime_v2.js'),'utf8');
  const start=runtime.indexOf('const M01_REVIEWED_SESSION_STORAGE_KEYS = Object.freeze([');
  const end=runtime.indexOf('async function inspectPreviewSessionStorageOwnerGaps(',start);
  const next=runtime.indexOf('// M01 preview-only IDB catalog inspection:',end);
  assert.ok(start>0&&end>start&&next>end);
  const knownBlock=runtime.slice(start,end);
  const reviewed=[...knownBlock.matchAll(/'([^']+)'/g)].map(match=>match[1]);
  const manifest=[...new Set(inventory.keyEvidence
    .filter(entry=>entry.family==='session').map(entry=>entry.key))];
  assert.deepEqual(reviewed.slice().sort(),manifest.sort(),
    'new sessionStorage keys must be explicitly source-reviewed before M01 can close');
  const source=runtime.slice(end,next);
  for(const required of [
    'isWalTestPreviewHost()',
    'isDarkEnabled()',
    'currentGeneration({create:false})',
    'captureReadOnlyFullStorageInventory()===expectedInventoryToken',
    'previewNotesWitnessObservedExternalChange(generation,epoch)',
    'sessionFingerprint:fingerprint',
    'sessionInventoryStable:true',
    'allSessionKeysMapped:false',
    "canPromote:false",
    "readAuthority:'legacy_only'"
  ])assert.ok(source.includes(required),'session M01 audit lost safety rule: '+required);
  for(const token of [
    '.setItem(','.removeItem(','.clear(',
    'indexedDB','seedFromLegacy','saveStateSnapshot'
  ])assert.ok(!source.includes(token),
    'read-only session audit unexpectedly references a writer: '+token);
  assert.ok(runtime.includes(
    'inspectPreviewDynamicOwnerGaps,\\n    inspectPreviewSessionStorageOwnerGaps,'
      .replace('\\n',String.fromCharCode(10))),
    'session owner audit is not exported by the V2 runtime');
});
