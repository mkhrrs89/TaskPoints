'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');
const script=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const DB='taskpoints_state_v2',KEY='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1',PROJECTS='tp_projects_v1';
const initial=()=>({habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[{id:'t1',title:'Important Task'}]});
const projects=()=>[
  {id:'p2',name:'Second',done:80,notes:'long preserved note',
    subtasks:[{id:'s2',text:'step',done:true}]},
  {id:'p1',name:'First',category:'Home',done:22,
    extension:{deep:{owner:'untouched'}},subtasks:[]}
];
async function boot(raw=JSON.stringify(projects()),options={}) {
  const indexedDB=options.indexedDB||new FakeIndexedDB();
  const localStorage=options.localStorage||new FakeStorage({
    [DARK]:'1',[KEY]:JSON.stringify(initial()),
    ...(raw===null || raw===undefined ? {} : {[PROJECTS]:raw})
  });
  let id=0;
  const core={
    STORAGE_KEY:KEY,
    parseTaskPointsStorageJson(x){return JSON.parse(x)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(KEY))},
    writePendingHabitDelta(d){return {...d}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const crypto=options.crypto||{subtle:webcrypto.subtle,
    randomUUID(){return 'project-'+ ++id}};
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,crypto,
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  const seed=await api.seedFromLegacy();
  return {api,ctx,indexedDB,localStorage,seed,
    token(){return JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]))}};
}
async function seeded(){
  const app=await boot();
  const result=await app.api.rehearsePreviewProjectsCollectionSeed(app.token(),'source-seed');
  assert.equal(result.collectionParityVerified,true,JSON.stringify(result));
  return app;
}

test('V4 schema seeds Projects as separate ordered records with receipt and no V1 writes',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  const oldSnapshot=app.localStorage.getItem(KEY);
  const oldProjects=app.localStorage.getItem(PROJECTS);
  const outcome=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'seed-first');
  assert.equal(outcome.reason,'projects_preview_seed_verified',JSON.stringify(outcome));
  assert.equal(outcome.committed,true);
  assert.equal(outcome.confirmedDurable,true);
  assert.equal(outcome.collectionParityVerified,true);
  assert.equal(outcome.projectsMigrated,false);
  assert.equal(outcome.canPromote,false);
  const database=await app.api.open();
  assert.equal(database.version,4);
  assert.equal(database.objectStoreNames.contains('projects'),true);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.projects.sort((a,b)=>a.legacyIndex-b.legacyIndex)
    .map(row=>row.value),projects());
  const receipt=after.mutations.find(r=>r.id==='projects-preview-seed:seed-first');
  assert.equal(receipt.type,'projects-preview-seed');
  assert.equal(receipt.projectCount,2);
  assert.equal(after.meta.find(r=>r.id==='projects-preview').receiptId,receipt.id);
  assert.equal(app.localStorage.getItem(KEY),oldSnapshot);
  assert.equal(app.localStorage.getItem(PROJECTS),oldProjects);
  const parity=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
});

test('Projects preview is idempotent, survives restart and keeps receipt intact',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const repeat=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'other-action-id');
  assert.equal(repeat.reason,'projects_preview_already_verified',JSON.stringify(repeat));
  assert.equal(repeat.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const restart=await boot(undefined,{
    localStorage:app.localStorage,indexedDB:app.indexedDB
  });
  assert.equal((await restart.api.inspectPreviewProjectsCollectionParity()).match,true);
  const replay=await restart.api.rehearsePreviewProjectsCollectionSeed(
    restart.token(),'after-reload');
  assert.equal(replay.committed,false,JSON.stringify(replay));
  assert.deepEqual(restart.indexedDB.dump(DB),before);
});

test('stale V1 Projects revisions refuse reseed and retain all V2 records',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'later authoritative edit'},projects()[1]
  ]));
  const parity=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(parity.match,false);
  assert.equal(parity.reason,'projects_preview_source_stale',JSON.stringify(parity));
  const result=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'stale-v1');
  assert.equal(result.reason,'projects_preview_existing_evidence_preserved',
    JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('orphaned preview Project record without receipt is never overwritten',async()=>{
  const app=await boot();
  const db=app.indexedDB._databases.get(DB);
  db._stores.get('projects').set('stranded',{id:'stranded',legacyIndex:0,
    value:{id:'stranded',notes:'recoverable orphan'}});
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'must-not-overwrite');
  assert.equal(result.reason,'projects_preview_orphaned_records_preserved',
    JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('tampered V2 Projects or missing receipt cannot be declared parity',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const records=db._stores.get('projects');
  records.set('p2',{...records.get('p2'),value:{id:'p2',name:'tampered'}});
  const before=app.indexedDB.dump(DB);
  const mismatch=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(mismatch.match,false);
  assert.equal(mismatch.reason,'projects_preview_record_mismatch');
  const repeat=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'tampered');
  assert.equal(repeat.reason,'projects_preview_existing_evidence_preserved');
  assert.deepEqual(app.indexedDB.dump(DB),before);
  records.set('p2',{id:'p2',legacyIndex:0,value:projects()[0]});
  db._stores.get('mutations').delete('projects-preview-seed:source-seed');
  const missing=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(missing.match,false);
  assert.equal(missing.reason,'projects_preview_receipt_missing_or_invalid',
    JSON.stringify(missing));
});

test('invalid V1 Projects data never seeds an empty replacement',async()=>{
  const app=await boot('{broken'),before=app.indexedDB.dump(DB);
  const outcome=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'invalid');
  assert.equal(outcome.reason,'projects_source_preflight_required',
    JSON.stringify(outcome));
  assert.equal(outcome.prerequisiteReason,'legacy_projects_malformed_json');
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal(app.localStorage.getItem(PROJECTS),'{broken');
});

test('Projects preview quota failure aborts records metadata and receipt together',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'projects',operation:'add',
    error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'quota');
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(result.confirmedDurable,false);
  assert.equal(result.reason,'projects_preview_atomic_seed_failed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('concurrent V2 Project record insertion during admission aborts atomically',async()=>{
  const app=await boot(),db=app.indexedDB._databases.get(DB);
  const original=db.transaction.bind(db);
  let inserted=false;
  db.transaction=(stores,mode)=>{
    if (!inserted && mode==='readwrite'
      && Array.isArray(stores)&&stores.includes('projects')) {
      inserted=true;
      db._stores.get('projects').set('extra',{
        id:'extra',legacyIndex:9,value:{id:'extra',notes:'other preview tab'}
      });
    }
    return original(stores,mode);
  };
  const result=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'race');
  assert.equal(inserted,true);
  assert.equal(result.reason,'projects_preview_concurrent_change',
    JSON.stringify(result));
  assert.equal(app.indexedDB.dump(DB).projects.length,1);
  assert.equal(app.indexedDB.dump(DB).mutations.some(r=>r.id==='projects-preview-seed:race'),
    false);
});

test('full-origin stale source token rejects preview Projects seed before writing',async()=>{
  const app=await boot(),token=app.token();
  app.localStorage.setItem('tp_notes_v1','changed in other tab');
  const before=app.indexedDB.dump(DB);
  const outcome=await app.api.rehearsePreviewProjectsCollectionSeed(token,'stale');
  assert.equal(outcome.reason,'full_origin_changed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('empty and absent V1 Projects sources seed distinct evidence without erasure',async()=>{
  const missing=await boot(null);
  const a=await missing.api.rehearsePreviewProjectsCollectionSeed(
    missing.token(),'missing');
  assert.equal(a.committed,true,JSON.stringify(a));
  assert.equal(a.projectCount,0);
  assert.equal(missing.indexedDB.dump(DB).meta.find(r=>r.id==='projects-preview')
    .sourcePresent,false);
  const present=await boot('[]');
  const b=await present.api.rehearsePreviewProjectsCollectionSeed(
    present.token(),'empty');
  assert.equal(b.committed,true,JSON.stringify(b));
  assert.equal(present.indexedDB.dump(DB).meta.find(r=>r.id==='projects-preview')
    .sourcePresent,true);
  assert.equal((await present.api.inspectPreviewProjectsCollectionParity()).match,true);
});

test('upgrading an existing V3 mirror retains prior pilot rows and adds Projects store',async()=>{
  const app=await boot(),db=app.indexedDB._databases.get(DB);
  const previous=app.indexedDB.dump(DB);
  db.version=3;
  db._stores.delete('projects');
  db._indexes.delete('projects');
  const restart=await boot(undefined,{
    indexedDB:app.indexedDB,localStorage:app.localStorage
  });
  assert.equal((await restart.api.open()).version,4);
  assert.equal(restart.indexedDB.dump(DB).projects.length,0);
  assert.deepEqual(restart.indexedDB.dump(DB).habits,previous.habits);
  assert.deepEqual(restart.indexedDB.dump(DB).completions,previous.completions);
  const seeded=await restart.api.rehearsePreviewProjectsCollectionSeed(
    restart.token(),'post-upgrade');
  assert.equal(seeded.collectionParityVerified,true,JSON.stringify(seeded));
});

test('Projects preview writes are unavailable on production hosts',async()=>{
  const app=await boot();
  app.ctx.location.hostname='taskpoints.pages.dev';
  const outcome=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'prod');
  assert.equal(outcome.reason,'preview_host_required');
  assert.equal((await app.api.inspectPreviewProjectsCollectionParity()).reason,
    'preview_host_required');
});


test('Projects reconcile atomically edits, adds, deletes, and reorders while preserving V1',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const modified=[
    {id:'p3',name:'New Project',done:3,subtasks:[{id:'s3',text:'New',done:false}]},
    {...projects()[0],notes:'authoritative revised note'}
  ];
  const raw=JSON.stringify(modified);
  app.localStorage.setItem(PROJECTS,raw);
  const result=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'edit-delete-add');
  assert.equal(result.reason,'projects_preview_reconciled',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.changedRows,3);
  assert.equal(result.addedRows,1);
  assert.equal(result.deletedRows,1);
  assert.equal(result.canPromote,false);
  assert.equal(result.projectsMigrated,false);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.projects.sort((a,b)=>a.legacyIndex-b.legacyIndex)
    .map(x=>x.value),modified);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.deepEqual(after.tasks,before.tasks);
  assert.equal(app.localStorage.getItem(PROJECTS),raw);
  const receipt=after.mutations.find(x=>x.id==='projects-preview-reconcile:edit-delete-add');
  assert.equal(receipt.type,'projects-preview-reconcile');
  assert.equal(receipt.priorReceiptId,'projects-preview-seed:source-seed');
  assert.deepEqual(receipt.deletedIds,['p1']);
  assert.deepEqual(receipt.changedIds,['p3','p2']);
  assert.equal(after.meta.find(x=>x.id==='projects-preview').receiptId,receipt.id);
  const parity=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
});

test('Projects reconciliation rechecks no-op parity and survives restart, second edit and new receipt',async()=>{
  const app=await seeded();
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[1],notes:'first change'},projects()[0]
  ]));
  const first=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'first');
  assert.equal(first.committed,true,JSON.stringify(first));
  assert.equal(first.collectionParityVerified,true);
  const afterFirst=app.indexedDB.dump(DB);
  const noOp=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'noop');
  assert.equal(noOp.reason,'projects_preview_already_current',JSON.stringify(noOp));
  assert.equal(noOp.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),afterFirst);

  // A different V1 key changes the full-origin fence, even if Projects
  // itself is unchanged: advancing the evidence is metadata-only.
  app.localStorage.setItem('some_external_key','cross-tab-change');
  const scope=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'origin-only');
  assert.equal(scope.committed,true,JSON.stringify(scope));
  assert.equal(scope.changedRows,0);
  assert.equal(scope.collectionParityVerified,true);
  assert.deepEqual(app.indexedDB.dump(DB).projects,afterFirst.projects);

  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[1],notes:'second change'},projects()[0]
  ]));
  const changed=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'second');
  assert.equal(changed.committed,true,JSON.stringify(changed));
  assert.equal(changed.changedRows,1);
  assert.equal(changed.collectionParityVerified,true);
  const beforeReload=app.indexedDB.dump(DB);
  const restart=await boot(undefined,{
    indexedDB:app.indexedDB,localStorage:app.localStorage
  });
  const replay=await restart.api.inspectPreviewProjectsCollectionParity();
  assert.equal(replay.match,true,JSON.stringify(replay));
  const retry=await restart.api.rehearsePreviewProjectsCollectionReconcile(
    restart.token(),'after-restart');
  assert.equal(retry.reason,'projects_preview_already_current',
    JSON.stringify(retry));
  assert.deepEqual(restart.indexedDB.dump(DB),beforeReload);
});

test('Projects reconciliation refuses malformed source without overwriting preview',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,'not json');
  const result=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'malformed');
  assert.equal(result.reason,'projects_source_preflight_required',
    JSON.stringify(result));
  assert.equal(result.prerequisiteReason,'legacy_projects_malformed_json');
  assert.equal(result.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Projects reconciliation refuses independently tampered V2 row or metadata receipt',async()=>{
  const app=await seeded();
  const store=app.indexedDB._databases.get(DB)._stores.get('projects');
  const row=store.get('p1');
  store.set(row.id,{...row,value:{...row.value,notes:'V2-only unauthorized edit'}});
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],name:'New'},projects()[1]
  ]));
  const denied=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'tampered');
  assert.equal(denied.reason,'projects_preview_existing_parity_mismatch',
    JSON.stringify(denied));
  assert.equal(denied.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  // Restore exact old row, then erase the receipt; both cases fail closed.
  store.set(row.id,row);
  app.indexedDB._databases.get(DB)._stores.get('mutations')
    .delete('projects-preview-seed:source-seed');
  const receiptBefore=app.indexedDB.dump(DB);
  const missing=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'missing-receipt');
  assert.equal(missing.reason,'projects_preview_provenance_invalid',
    JSON.stringify(missing));
  assert.deepEqual(app.indexedDB.dump(DB),receiptBefore);
});

test('Projects reconciliation quota denial atomically retains old records, metadata, receipt',async()=>{
  const app=await seeded(),old=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'new via V1'},projects()[1]
  ]));
  app.indexedDB.failNext({store:'projects',operation:'put',
    error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'quota-denied');
  assert.equal(result.reason,'projects_preview_reconcile_atomic_write_failed',
    JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(result.confirmedDurable,false);
  assert.deepEqual(app.indexedDB.dump(DB),old);
});

test('Projects reconciliation rejects V2 competing insertion in write-admission transaction',async()=>{
  const app=await seeded(),db=app.indexedDB._databases.get(DB);
  const original=db.transaction.bind(db);
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'new via V1'},projects()[1]
  ]));
  let competing=false;
  db.transaction=(stores,mode)=>{
    if (!competing && mode==='readwrite'
      && Array.isArray(stores)&&stores.includes('projects')) {
      competing=true;
      db._stores.get('projects').set('extra',{
        id:'extra',legacyIndex:99,value:{id:'extra',notes:'other writer'}
      });
    }
    return original(stores,mode);
  };
  const result=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'race');
  assert.equal(competing,true);
  assert.equal(result.reason,'projects_preview_reconcile_concurrent_change',
    JSON.stringify(result));
  assert.equal(result.committed,false);
  const current=app.indexedDB.dump(DB);
  assert.equal(current.projects.find(x=>x.id==='extra').value.notes,'other writer');
  assert.equal(current.projects.find(x=>x.id==='p2').value.notes,'long preserved note');
  assert.equal(current.mutations.some(x=>x.id==='projects-preview-reconcile:race'),false);
});

test('Projects reconciliation refuses stale origin token and reused action ID',async()=>{
  const app=await seeded(),token=app.token(),old=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'V1 changed'},projects()[1]
  ]));
  const stale=await app.api.rehearsePreviewProjectsCollectionReconcile(token,'stale');
  assert.equal(stale.reason,'full_origin_changed');
  assert.deepEqual(app.indexedDB.dump(DB),old);
  const first=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'used');
  assert.equal(first.committed,true,JSON.stringify(first));
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'another V1 change'},projects()[1]
  ]));
  const before=app.indexedDB.dump(DB);
  const repeated=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'used');
  assert.equal(repeated.reason,'projects_preview_action_id_conflict');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Projects reconcile refuses more than 64 record changes and preserves source',async()=>{
  const all=Array.from({length:66},(_,i)=>({
    id:'id-'+i,name:'Project '+i,notes:'original',subtasks:[]
  }));
  const app=await boot(JSON.stringify(all));
  const seed=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'large-seed');
  assert.equal(seed.collectionParityVerified,true,JSON.stringify(seed));
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(PROJECTS,JSON.stringify(
    all.map(item=>({...item,notes:'updated'}))));
  const result=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'too-big');
  assert.equal(result.reason,'projects_preview_reconcile_batch_too_large',
    JSON.stringify(result));
  assert.equal(result.changedRows,66);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Projects reconcile keeps absent and explicit-empty source distinct',async()=>{
  const app=await boot(null);
  const seeded=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'missing');
  assert.equal(seeded.collectionParityVerified,true);
  app.localStorage.setItem(PROJECTS,'[]');
  const added=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'present-empty');
  assert.equal(added.committed,true,JSON.stringify(added));
  assert.equal(added.changedRows,0);
  assert.equal((await app.api.inspectPreviewProjectsCollectionParity()).match,true);
  assert.equal(app.indexedDB.dump(DB).meta.find(x=>x.id==='projects-preview')
    .sourcePresent,true);
  app.localStorage.removeItem(PROJECTS);
  const deleted=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'absent-again');
  assert.equal(deleted.committed,true,JSON.stringify(deleted));
  assert.equal(deleted.changedRows,0);
  assert.equal((await app.api.inspectPreviewProjectsCollectionParity()).match,true);
  assert.equal(app.indexedDB.dump(DB).meta.find(x=>x.id==='projects-preview')
    .sourcePresent,false);
  app.localStorage.setItem(PROJECTS,JSON.stringify([{
    id:'project-later',name:'Created after empty',subtasks:[]
  }]));
  const afterEmpty=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'after-empty');
  assert.equal(afterEmpty.committed,true,JSON.stringify(afterEmpty));
  assert.equal(afterEmpty.addedRows,1);
  assert.equal((await app.api.inspectPreviewProjectsCollectionParity()).match,true);
});

test('Projects parity rejects broken predecessor receipt after reconciliation',async()=>{
  const app=await seeded();
  app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...projects()[0],notes:'changed'},projects()[1]
  ]));
  const changed=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'first');
  assert.equal(changed.collectionParityVerified,true,JSON.stringify(changed));
  const receipts=app.indexedDB._databases.get(DB)._stores.get('mutations');
  const prior=receipts.get('projects-preview-seed:source-seed');
  receipts.set(prior.id,{...prior,sourceFingerprint:'bad'});
  const before=app.indexedDB.dump(DB);
  const inspected=await app.api.inspectPreviewProjectsCollectionParity();
  assert.equal(inspected.match,false);
  assert.equal(inspected.reason,'projects_preview_receipt_chain_invalid');
  // Existing mirror data remains untouched, even when the receipt is bad.
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Projects no-op reconciliation notices a V2-only write after its initial digest',async()=>{
  const gate={armed:false,hashes:0,app:null};
  const subtle={digest:async(...args)=>{
    const hash=await webcrypto.subtle.digest(...args);
    if (gate.armed && ++gate.hashes===2) {
      const records=gate.app.indexedDB._databases.get(DB)._stores.get('projects');
      const prior=records.get('p2');
      records.set(prior.id,{...prior,value:{...prior.value,notes:'interleaved edit'}});
    }
    return hash;
  }};
  const app=await boot(undefined,{crypto:{subtle,randomUUID(){return 'test-digest'}}});
  gate.app=app;
  const initial=await app.api.rehearsePreviewProjectsCollectionSeed(
    app.token(),'race-seed');
  assert.equal(initial.collectionParityVerified,true,JSON.stringify(initial));
  gate.armed=true;
  const outcome=await app.api.rehearsePreviewProjectsCollectionReconcile(
    app.token(),'no-op-race');
  assert.equal(outcome.reason,'projects_preview_reconcile_noop_parity_mismatch',
    JSON.stringify(outcome));
  assert.equal(outcome.committed,false);
  assert.equal(app.indexedDB.dump(DB).projects.find(x=>x.id==='p2').value.notes,
    'interleaved edit');
});

