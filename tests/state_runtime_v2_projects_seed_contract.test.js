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
    ...(raw===undefined?{}:{[PROJECTS]:raw})
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
  const missing=await boot(undefined);
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
