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
const DB='taskpoints_v2_habit_order_preview';
const KEY='taskpoints_habit_order_overlay_v1';
function baseline(){
  return {habits:[{id:'h1',name:'First',doneKeys:[],failedKeys:[],iceKeys:[]},
    {id:'h2',name:'Second',doneKeys:[],failedKeys:[],iceKeys:[]}],
    completions:[],tasks:[]};
}
async function boot(options={}){
  const indexedDB=options.indexedDB||new FakeIndexedDB();
  const localStorage=options.localStorage||new FakeStorage({
    taskpoints_v1:JSON.stringify(baseline()),
    taskpoints_state_v2_dark_mode_v1:'1',
    ...(options.overlay!==undefined?{[KEY]:options.overlay}:{})
  });
  let i=0;
  const core={STORAGE_KEY:'taskpoints_v1',
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem('taskpoints_v1'))},
    writePendingHabitDelta(x){return {...x}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}};
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:options.crypto||{subtle:webcrypto.subtle,randomUUID(){return 'sidecar-'+(++i)}},
    location:{hostname:options.hostname||'localhost'},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    TaskPointsCore:core,document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  if(!options.skipPilotSeed)await api.seedFromLegacy();
  const token=()=>JSON.stringify(Array.from({length:localStorage.length},
    (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));
  return {api,indexedDB,localStorage,ctx,token};
}
const original=()=>JSON.stringify({version:1,updatedAtISO:'2026-11-06T10:00:00Z',
  orders:{h1:2,h2:'1'},habitUpdatedAtISO:{h1:'2026-11-06T10:00:00Z'},
  unknown:{future:['keep',true]}});
const seed=(app,id='initial')=>app.api.rehearsePreviewHabitOrderSidecarSeed(app.token(),id);
const reconcile=(app,id='edit')=>app.api.rehearsePreviewHabitOrderSidecarReconcile(app.token(),id);

test('Sidecar seed preserves complete source bytes, unknown fields and per-Habit rows',async()=>{
  const app=await boot({overlay:original()});
  const v1=app.localStorage.getItem('taskpoints_v1');
  const origin=app.token(),pilot=app.indexedDB.dump('taskpoints_state_v2');
  const result=await seed(app);
  assert.equal(result.confirmedDurable,true,JSON.stringify(result));
  assert.equal(result.reason,'habit_order_preview_seed_verified');
  assert.equal(result.canPromote,false);
  assert.equal(result.readAuthority,'legacy_only');
  assert.equal(app.indexedDB.dump(DB).records.length,3);
  assert.equal(app.indexedDB.dump(DB).records.find(row=>row.id==='root').raw,original());
  assert.equal(app.indexedDB.dump(DB).records.find(row=>row.habitId==='h2').order,'1');
  assert.equal((await app.api.inspectPreviewHabitOrderSidecarParity()).match,true);
  assert.equal(app.token(),origin);
  assert.equal(app.localStorage.getItem('taskpoints_v1'),v1);
  assert.deepEqual(app.indexedDB.dump('taskpoints_state_v2'),pilot);
  const again=await seed(app,'ignored-repeat');
  assert.equal(again.confirmedDurable,true);
  assert.equal(again.committed,false);
  const reloaded=await boot({indexedDB:app.indexedDB,localStorage:app.localStorage});
  assert.equal((await reloaded.api.inspectPreviewHabitOrderSidecarParity()).match,true);
});

test('Sidecar incremental reconciliation preserves prior receipts and only changes affected rows',async()=>{
  const app=await boot({overlay:original()});
  assert.equal((await seed(app)).confirmedDurable,true);
  const before=app.indexedDB.dump(DB);
  const updated=JSON.stringify({version:1,updatedAtISO:'2026-11-06T11:00:00Z',
    orders:{h1:1,h3:3},habitUpdatedAtISO:{h3:'2026-11-06T11:00:00Z'},
    unknown:{future:['preserve']}});
  app.localStorage.setItem(KEY,updated);
  const stale=await app.api.inspectPreviewHabitOrderSidecarParity();
  assert.equal(stale.match,false);
  const done=await reconcile(app);
  assert.equal(done.confirmedDurable,true,JSON.stringify(done));
  assert.equal(done.reason,'habit_order_preview_reconcile_verified');
  const saved=app.indexedDB.dump(DB);
  assert.equal(saved.records.find(row=>row.id==='root').raw,updated);
  assert.equal(saved.records.some(row=>row.id==='habit:h2'),false);
  assert.equal(saved.records.find(row=>row.id==='habit:h3').order,3);
  assert.equal(saved.receipts.length,2);
  assert.equal(saved.meta[0].receiptId,'habit-order-preview:edit');
  assert.equal(saved.receipts.find(row=>row.id==='habit-order-preview:edit').priorReceiptId,
    'habit-order-preview:initial');
  const noop=await reconcile(app,'fresh-noop');
  assert.equal(noop.confirmedDurable,true);
  assert.equal(noop.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),saved);
  assert.notDeepEqual(before.records,saved.records);
  // Reopen the independent sidecar without trying to re-seed an intentionally
  // stale Habit pilot. The independent copy must remain verifiable by itself.
  const reloaded=await boot({indexedDB:app.indexedDB,
    localStorage:app.localStorage,skipPilotSeed:true});
  assert.equal((await reloaded.api.inspectPreviewHabitOrderSidecarParity()).match,true);
});

test('Sidecar preserves absent vs present empty overlay and fails closed on malformed raw',async()=>{
  const absent=await boot();
  const s=await seed(absent);
  assert.equal(s.confirmedDurable,true,JSON.stringify(s));
  assert.equal(absent.indexedDB.dump(DB).records[0].raw,null);
  const present=JSON.stringify({version:1,orders:{}});
  absent.localStorage.setItem(KEY,present);
  const changed=await reconcile(absent,'explicit-empty');
  assert.equal(changed.confirmedDurable,true,JSON.stringify(changed));
  assert.equal(absent.indexedDB.dump(DB).records[0].raw,present);
  for(const raw of ['{invalid',JSON.stringify({version:1,orders:{h1:'oops'}}),
    JSON.stringify({version:2,orders:{h1:1}})]){
    const app=await boot();
    app.localStorage.setItem(KEY,raw);
    const before=app.indexedDB.dump('taskpoints_state_v2');
    const result=await seed(app);
    assert.equal(result.committed,false,JSON.stringify(result));
    assert.equal(result.confirmedDurable,false);
    assert.equal(app.indexedDB.dump(DB)?.records?.length||0,0);
    assert.deepEqual(app.indexedDB.dump('taskpoints_state_v2'),before);
  }
});

test('Sidecar denies stale caller, production host, and tampered row or receipt',async()=>{
  const app=await boot({overlay:original()});
  const oldToken=app.token();
  app.localStorage.setItem(KEY,JSON.stringify({version:1,orders:{h1:1}}));
  assert.equal((await app.api.rehearsePreviewHabitOrderSidecarSeed(
    oldToken,'stale')).reason,'full_origin_changed');
  assert.equal((await seed(app)).confirmedDurable,true);
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await reconcile(app,'production')).reason,'preview_host_required');
  app.ctx.location.hostname='localhost';
  const internal=app.indexedDB._databases.get(DB);
  const records=internal._stores.get('records');
  const root=records.get('root');
  records.set('root',{...root,raw:'CORRUPTED'});
  assert.equal((await reconcile(app,'tampered')).reason,'habit_order_preview_rows_tampered');
  records.set('root',root);
  const receipts=internal._stores.get('receipts');
  const originalReceipt=receipts.get('habit-order-preview:initial');
  receipts.delete(originalReceipt.id);
  assert.equal((await app.api.inspectPreviewHabitOrderSidecarParity()).match,false);
  receipts.set(originalReceipt.id,originalReceipt);
  assert.equal((await app.api.inspectPreviewHabitOrderSidecarParity()).match,true);
});

test('Sidecar quota denial rolls back rows and receipt, with safe explicit retry',async()=>{
  const app=await boot({overlay:original()});
  await app.api.inspectPreviewHabitOrderSidecarParity();
  const before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'receipts',operation:'add',
    error:new Error('QuotaExceededError')});
  const failed=await seed(app);
  assert.equal(failed.committed,false,JSON.stringify(failed));
  assert.equal(failed.confirmedDurable,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const retry=await seed(app);
  assert.equal(retry.confirmedDurable,true,JSON.stringify(retry));
});

test('Sidecar rejects tampered seal inventory and receipt counts without rewriting evidence',async()=>{
  const app=await boot({overlay:original()});
  assert.equal((await seed(app)).confirmedDurable,true);
  const internal=app.indexedDB._databases.get(DB);
  const meta=internal._stores.get('meta');
  const originalSeal=meta.get('habit-order-preview');
  for(const patch of [
    {recordCount:originalSeal.recordCount+1},
    {sourcePresent:!originalSeal.sourcePresent}
  ]){
    meta.set('habit-order-preview',{...originalSeal,...patch});
    const corrupted=app.indexedDB.dump(DB);
    const parity=await app.api.inspectPreviewHabitOrderSidecarParity();
    assert.equal(parity.match,false);
    assert.equal(parity.reason,'habit_order_preview_seal_invalid');
    const denied=await reconcile(app,'corrupt-seal');
    assert.equal(denied.committed,false);
    assert.equal(denied.confirmedDurable,false);
    assert.deepEqual(app.indexedDB.dump(DB),corrupted);
    meta.set('habit-order-preview',originalSeal);
  }
  const receipts=internal._stores.get('receipts');
  const originalReceipt=receipts.get('habit-order-preview:initial');
  for(const patch of [{changeCount:-1},{deleteCount:0.5}]){
    receipts.set(originalReceipt.id,{...originalReceipt,...patch});
    const corrupted=app.indexedDB.dump(DB);
    const parity=await app.api.inspectPreviewHabitOrderSidecarParity();
    assert.equal(parity.match,false);
    assert.equal(parity.reason,'habit_order_preview_receipt_invalid');
    const denied=await reconcile(app,'corrupt-receipt');
    assert.equal(denied.committed,false);
    assert.equal(denied.confirmedDurable,false);
    assert.deepEqual(app.indexedDB.dump(DB),corrupted);
    receipts.set(originalReceipt.id,originalReceipt);
  }
  assert.equal((await app.api.inspectPreviewHabitOrderSidecarParity()).match,true);
});
