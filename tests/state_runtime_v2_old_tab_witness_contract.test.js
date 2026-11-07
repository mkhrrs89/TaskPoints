'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');
const source=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const MAIN='taskpoints_v1',DARK='taskpoints_state_v2_dark_mode_v1';
const DB='taskpoints_v2_frozen_origin_witness_v1';
async function boot(opts={}){
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[MAIN]:JSON.stringify({habits:[],completions:[],tasks:[]})
  });
  let id=0;
  const core={
    STORAGE_KEY:MAIN,parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(MAIN))},
    writePendingHabitDelta(row){return {...row}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'frozen-witness-'+ ++id}},
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(source,ctx,{filename:'state_runtime_v2.js'});
  await ctx.TaskPointsStateRuntimeV2.seedFromLegacy();
  return {api:ctx.TaskPointsStateRuntimeV2,indexedDB,localStorage,ctx};
}
async function frozen(){
  const app=await boot();
  const before=await app.api.rehearsePreviewDurableWriterFence('read');
  assert.equal(before.reason,'fence_read_only',JSON.stringify(before));
  const freeze=await app.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:before.fence.epoch
  });
  assert.equal(freeze.reason,'preview_fence_frozen',JSON.stringify(freeze));
  return app;
}
test('unfrozen preview cannot capture an apparent exclusion proof',async()=>{
  const app=await boot();
  const before=app.indexedDB.dump(DB);
  const result=await app.api.capturePreviewFrozenOriginWitness('cannot-seal');
  assert.equal(result.captured,false);
  assert.equal(result.reason,'frozen_preview_fence_required');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});
test('frozen preview witnesses full origin without saving V1 plaintext',async()=>{
  const app=await frozen();
  const old=app.localStorage.getItem(MAIN);
  const captured=await app.api.capturePreviewFrozenOriginWitness('start');
  assert.equal(captured.captured,true,JSON.stringify(captured));
  assert.equal(captured.confirmedDurable,true);
  const inspection=await app.api.inspectPreviewFrozenOriginWitness('start');
  assert.equal(inspection.sourceCompared,true,JSON.stringify(inspection));
  assert.equal(inspection.originDriftObserved,false);
  assert.equal(inspection.canPromote,false);
  assert.equal(inspection.productionWritersFenced,false);
  assert.equal(inspection.silentLegacyWritersExcluded,false);
  assert.equal(inspection.readAuthority,'legacy_only');
  const rows=app.indexedDB.dump(DB).witnesses;
  assert.equal(rows.length,1);
  assert.equal(JSON.stringify(rows).includes(old),false);
  assert.match(rows[0].sourceFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  assert.equal(app.localStorage.getItem(MAIN),old);
  const oldDb=app.indexedDB.dump(DB);
  const repeated=await app.api.capturePreviewFrozenOriginWitness('start');
  assert.equal(repeated.reason,'witness_id_already_used');
  assert.deepEqual(app.indexedDB.dump(DB),oldDb);
});
test('old-tab V1 and independent sidecar writes are seen after synthetic freeze',async()=>{
  const app=await frozen();
  assert.equal((await app.api.capturePreviewFrozenOriginWitness('before-old-tab')).captured,true);
  for(const [key,raw] of [
    [MAIN,JSON.stringify({habits:[],completions:[],tasks:[{id:'old-tab-task'}]})],
    ['taskpoints_pending_task_mutations_v1','{"schemaVersion":1,"tasks":[]}'],
    ['tp_projects_v1','[{"id":"old-project"}]'],
    ['taskpoints_today_view_v1','{"version":1,"notesByDay":{}}'],
    ['taskpoints_notes_v1','Unsaved important notes'],
    ['taskpoints_player_sort_mode','pid-desc']
  ]){
    app.localStorage.setItem(key,raw);
    const r=await app.api.inspectPreviewFrozenOriginWitness('before-old-tab');
    assert.equal(r.sourceCompared,true,JSON.stringify(r));
    assert.equal(r.originDriftObserved,true,key);
    assert.equal(r.writerIdentityUnknown,true);
    assert.equal(r.safeToRestore,false);
    assert.equal(app.localStorage.getItem(key),raw);
  }
  const restarted=await boot({localStorage:app.localStorage,indexedDB:app.indexedDB});
  const after=await restarted.api.inspectPreviewFrozenOriginWitness('before-old-tab');
  assert.equal(after.originDriftObserved,true,JSON.stringify(after));
});
test('damaged or missing witness evidence is not mistaken for an unchanged origin',async()=>{
  const app=await frozen();
  assert.equal((await app.api.capturePreviewFrozenOriginWitness('healthy')).captured,true);
  const store=app.indexedDB._databases.get(DB)._stores.get('witnesses');
  const record=store.get('origin:healthy');
  store.set(record.id,{...record,sourceFingerprint:'sha256:'+'0'.repeat(64)+':1'});
  const corrupt=await app.api.inspectPreviewFrozenOriginWitness('healthy');
  assert.equal(corrupt.reason,'frozen_origin_witness_integrity_invalid');
  assert.equal(corrupt.originDriftObserved,null);
  store.set(record.id,record);
  store.delete(record.id);
  const missing=await app.api.inspectPreviewFrozenOriginWitness('healthy');
  assert.equal(missing.reason,'frozen_origin_witness_missing');
});
test('production, dark-off and stale generation fail closed without changing Main',async()=>{
  const app=await frozen();
  const prior=app.localStorage.getItem(MAIN);
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.capturePreviewFrozenOriginWitness('prod')).reason,
    'preview_host_required');
  assert.equal((await app.api.inspectPreviewFrozenOriginWitness('prod')).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.capturePreviewFrozenOriginWitness('dark')).reason,
    'dark_disabled');
  app.localStorage.setItem(DARK,'1');
  app.localStorage.setItem('taskpoints_state_v2_generation_v1','different');
  assert.equal((await app.api.capturePreviewFrozenOriginWitness('stale')).captured,false);
  assert.equal(app.localStorage.getItem(MAIN),prior);
});
