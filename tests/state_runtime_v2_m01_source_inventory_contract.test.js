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
  assert.ok(inventory.firstPassInspected.length<files.size,
    'M01 requires separate exhaustive ownership validation before completion');
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
  assert.ok(unresolved.length>0,
    'M01 is not yet certified complete; update acceptance only with proof');
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
