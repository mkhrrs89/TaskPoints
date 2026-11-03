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
const DB='taskpoints_state_v2', KEY='taskpoints_v1', DARK='taskpoints_state_v2_dark_mode_v1';
const base=()=>({habits:[{id:'h1',name:'Exercise',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[{id:'a',title:'First',points:2},{id:'b',title:'Second',points:3}]});
function install(indexedDB=new FakeIndexedDB(),localStorage=new FakeStorage({
  [DARK]:'1',[KEY]:JSON.stringify(base())
})){
  let uuid=0;
  const core={
    STORAGE_KEY:KEY,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(KEY))},
    writePendingHabitDelta(delta){return {...delta}},
    habitCompletionId(id,day){return 'habit:'+id+':'+day}
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'reconcile-'+ ++uuid}},
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  return {
    api:ctx.TaskPointsStateRuntimeV2,indexedDB,localStorage,
    token(){return JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort().map(key=>[key,localStorage.getItem(key)]))},
    change(tasks){const value=JSON.parse(localStorage.getItem(KEY));
      value.tasks=tasks;localStorage.setItem(KEY,JSON.stringify(value))}
  };
}
async function seeded(){
  const app=install();
  await app.api.seedFromLegacy();
  const seed=await app.api.rehearsePreviewTaskCollectionSeed();
  assert.equal(seed.verified,true,JSON.stringify(seed));
  return app;
}
test('preview Task reconciliation atomically applies edits, additions, deletions and reorder',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const next=[{id:'b',title:'Second revised',points:4},{id:'c',title:'Third',points:8}];
  app.change(next);const v1=app.localStorage.getItem(KEY);
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'batch');
  assert.equal(result.committed,true,result.reason);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.changedRows,3);
  assert.equal(result.deletedRows,1);
  assert.equal(result.addedRows,1);
  assert.equal(result.canPromote,false);
  assert.equal(app.localStorage.getItem(KEY),v1);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.tasks.sort((a,b)=>a.legacyIndex-b.legacyIndex).map(r=>r.value),next);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.ok(after.mutations.some(r=>r.id==='task-preview-reconcile:batch'));
  const parity=await app.api.inspectPreviewTaskCollectionParity();
  assert.equal(parity.match,true,parity.reason);
  const copy=app.indexedDB.dump(DB);
  const repeated=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'batch');
  assert.equal(repeated.reason,'task_preview_already_current');
  assert.equal(repeated.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),copy);
  const restart=install(app.indexedDB,app.localStorage);
  await restart.api.seedFromLegacy();
  const recovered=await restart.api.inspectPreviewTaskCollectionParity();
  assert.equal(recovered.match,true,recovered.reason);
});
test('unexplained V2-only Task edits are never overwritten',async()=>{
  const app=await seeded();
  const rows=app.indexedDB._databases.get(DB)._stores.get('tasks');
  const current=rows.get('a');
  rows.set('a',{...current,value:{...current.value,title:'unreconciled V2 edit'}});
  const prior=app.indexedDB.dump(DB);
  app.change([{id:'a',title:'new V1 Task'},{id:'b',title:'Second'}]);
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'preserve');
  assert.equal(result.reason,'task_preview_existing_evidence_preserved');
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});
test('unrelated full-origin V1 edits invalidate stale Task reconciliation',async()=>{
  const app=await seeded(),token=app.token();
  app.localStorage.setItem('tp_projects_v1','new-projects-value');
  const prior=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(token,'stale');
  assert.equal(result.reason,'full_origin_changed');
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});
test('more than 64 changes refuse all writes, not a partial collection',async()=>{
  const app=await seeded();
  app.change(Array.from({length:66},(_,i)=>({id:'new-'+i,title:'Task '+i})));
  const prior=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'large');
  assert.equal(result.reason,'task_reconcile_batch_too_large');
  assert.equal(result.maxAtomicRows,64);
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});
test('quota denial rolls back every Task row and receipt',async()=>{
  const app=await seeded();
  app.change([{id:'a',title:'Edited'},{id:'b',title:'Other edit'}]);
  const prior=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'tasks',operation:'put',error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'quota');
  assert.equal(result.committed,false);
  assert.equal(result.reason,'task_reconcile_atomic_write_failed');
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});
test('reconcile aborts if concurrent V2 evidence changes before admission',async()=>{
  const app=await seeded();
  app.change([{id:'a',title:'V1 changed'},{id:'b',title:'Second'}]);
  const db=app.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  let changed=false;
  db.transaction=(stores,mode)=>{
    if(!changed&&mode==='readwrite'){
      changed=true;
      const meta=db._stores.get('meta');
      const old=meta.get('task-preview');
      meta.set('task-preview',{...old,taskCount:999});
    }
    return original(stores,mode);
  };
  const before=app.indexedDB.dump(DB).tasks;
  const outcome=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'race');
  assert.equal(changed,true);
  assert.equal(outcome.reason,'task_preview_concurrent_change');
  assert.deepEqual(app.indexedDB.dump(DB).tasks,before);
});
test('reusing a consumed Task action ID on different data refuses admission',async()=>{
  const app=await seeded();
  app.change([{id:'a',title:'First updated'},{id:'b',title:'Second'}]);
  assert.equal((await app.api.rehearsePreviewTaskCollectionReconcile(
    app.token(),'same')).committed,true);
  app.change([{id:'a',title:'Again'},{id:'b',title:'Second'}]);
  const before=app.indexedDB.dump(DB);
  const outcome=await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'same');
  assert.equal(outcome.reason,'task_reconcile_action_id_conflict');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});
