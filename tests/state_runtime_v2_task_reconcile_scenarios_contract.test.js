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
}),subtle=webcrypto.subtle){
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
    crypto:{subtle,randomUUID(){return 'reconcile-'+ ++uuid}},
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
async function seeded(subtle=webcrypto.subtle){
  const app=install(undefined,undefined,subtle);
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
test('no-op Task reconciliation refuses V2 writes made after its initial read',async()=>{
  // The first digest freezes the desired V1 collection, and the second
  // freezes the earlier V2 rows. Tamper with the live store only AFTER the
  // second digest returns: the old shortcut could still report parity true.
  let app,armed=false,digests=0;
  const subtle={digest:async (...args)=>{
    const hash=await webcrypto.subtle.digest(...args);
    if (armed && ++digests===2) {
      const records=app.indexedDB._databases.get(DB)._stores.get('tasks');
      const row=records.get('a');
      records.set('a',{...row,value:{...row.value,title:'Raced V2-only edit'}});
    }
    return hash;
  }};
  app=await seeded(subtle);
  const v1=app.localStorage.getItem(KEY);
  armed=true;
  const outcome=await app.api.rehearsePreviewTaskCollectionReconcile(
    app.token(),'noop-v2-race');
  assert.equal(digests>=2,true);
  assert.equal(outcome.reason,'task_preview_noop_parity_mismatch',
    JSON.stringify(outcome));
  assert.equal(outcome.confirmedDurable,false);
  assert.equal(outcome.collectionParityVerified,false);
  assert.equal(outcome.committed,false);
  assert.equal(outcome.canPromote,false);
  assert.equal(app.localStorage.getItem(KEY),v1);
  assert.equal(app.indexedDB.dump(DB).tasks.find(row=>row.id==='a')
    .value.title,'Raced V2-only edit');
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

function updateCompletionHistory(app, completions) {
  const state=JSON.parse(app.localStorage.getItem(KEY));
  state.completions=completions;
  app.localStorage.setItem(KEY,JSON.stringify(state));
}
function completion(i,task='a') {
  return {id:'work-completion-'+i,source:'task',taskId:task,
    dayKey:'2026-11-'+String(i%28+1).padStart(2,'0'),points:i};
}
async function currentTasksWithHistory(app,completions) {
  updateCompletionHistory(app,completions);
  const taskUpdate=await app.api.rehearsePreviewTaskCollectionReconcile(
    app.token(),'completion-history-evidence');
  assert.equal(taskUpdate.confirmedDurable,true,taskUpdate.reason);
}

test('historical Task completions import without modifying V1 or Habit records',async()=>{
  const app=await seeded();
  const v2Before=app.indexedDB.dump(DB);
  await currentTasksWithHistory(app,[completion(1),completion(2,'b')]);
  const v1=app.localStorage.getItem(KEY);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-import');
  assert.equal(result.committed,true,result.reason);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.fullyMirrored,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.importedRows,2);
  assert.equal(result.remainingRows,0);
  assert.equal(result.canPromote,false);
  assert.deepEqual(app.indexedDB.dump(DB).habits,v2Before.habits);
  assert.equal(app.localStorage.getItem(KEY),v1);
  assert.equal((await app.api.inspectPreviewTaskCompletionOrderParity()).match,true);
  const same=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-import');
  assert.equal(same.reason,'task_completion_history_current');
  assert.equal(same.committed,false);
  const restarted=install(app.indexedDB,app.localStorage);
  await restarted.api.seedFromLegacy();
  assert.equal((await restarted.api.inspectPreviewTaskCompletionOrderParity()).match,true);
});

test('Task history backfill stays bounded and resumes without duplicate insertions',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,Array.from({length:66},(_,i)=>completion(i)));
  const first=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-1');
  assert.equal(first.committed,true,first.reason);
  assert.equal(first.importedRows,64);
  assert.equal(first.remainingRows,2);
  assert.equal(first.fullyMirrored,false);
  const second=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-2');
  assert.equal(second.committed,true,second.reason);
  assert.equal(second.importedRows,2);
  assert.equal(second.remainingRows,0);
  assert.equal(second.fullyMirrored,true,second.reason);
  const after=app.indexedDB.dump(DB);
  assert.equal(after.completions.length,66);
  const third=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-3');
  assert.equal(third.reason,'task_completion_history_current');
  assert.deepEqual(app.indexedDB.dump(DB),after);
});

test('backlog catch-up refuses a corrupted existing V2 completion',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1),completion(2)]);
  assert.equal((await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'first')).fullyMirrored,true);
  const rows=app.indexedDB._databases.get(DB)._stores.get('completions');
  const row=rows.get('work-completion-1');
  rows.set('work-completion-1',{...row,entries:[{
    ...row.entries[0],value:{...row.entries[0].value,points:999}
  }]});
  updateCompletionHistory(app,[completion(1),completion(2),completion(3)]);
  await app.api.rehearsePreviewTaskCollectionReconcile(app.token(),'source-change');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'no-repair');
  assert.equal(result.committed,false);
  assert.equal(result.reason,'v2_nonpilot_completion_evidence_preserved');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('history backfill refuses duplicate legacy completion IDs and preserves V2',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1),completion(1)]);
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'duplicates');
  assert.equal(result.committed,false);
  assert.equal(result.reason,'legacy_completion_id_ambiguous');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('history backfill refuses incomplete Task preview prerequisite without writes',async()=>{
  const app=await seeded();
  updateCompletionHistory(app,[completion(5)]);
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'source-stale');
  assert.equal(result.committed,false);
  assert.equal(result.reason,'task_preview_parity_required');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('history importer aborts the whole batch on quota failure',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1),completion(2)]);
  const before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'completions',operation:'add',
    error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'quota');
  assert.equal(result.committed,false);
  assert.equal(result.confirmedDurable,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical catchup refuses old full-origin tokens after unrelated changes',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1)]);
  const token=app.token(),before=app.indexedDB.dump(DB);
  app.localStorage.setItem('tp_projects_v1','new-other-tab-value');
  const result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    token,'stale');
  assert.equal(result.reason,'full_origin_changed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});


// Simulate a legacy-only tab writing immediately AFTER the parity inspector's
// final source check. The async inspector can be internally consistent while
// its independently captured origin is already stale for the caller.
function injectAfterHistoryParity(app) {
  const original=app.localStorage.getItem.bind(app.localStorage);
  let inventoryChecks=0, scheduled=false;
  app.localStorage.getItem=function(key) {
    const value=original(key);
    const stack=String(new Error().stack || '');
    if (String(key)===KEY
      && stack.includes('captureReadOnlyFullStorageInventory')
      && stack.includes('inspectPreviewTaskCompletionOrderParity')) {
      inventoryChecks+=1;
      if (inventoryChecks===5) {
        scheduled=true;
        queueMicrotask(()=>app.localStorage.setItem(
          'tp_projects_v1','late-legacy-only-project-edit'));
      }
    }
    return value;
  };
  return {restore(){app.localStorage.getItem=original;},
    observed(){return {inventoryChecks,scheduled};}};
}

test('historic completion no-op denies late V1 source change after parity await',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1)]);
  const initial=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'history-initial');
  assert.equal(initial.fullyMirrored,true,JSON.stringify(initial));
  const before=app.indexedDB.dump(DB),token=app.token();
  const injection=injectAfterHistoryParity(app);
  let result;
  try {
    result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
      token,'history-noop-late-origin');
  } finally {injection.restore();}
  assert.equal(injection.observed().scheduled,true,
    JSON.stringify(injection.observed()));
  assert.equal(result.reason,'legacy_changed_after_history_check',
    JSON.stringify(result));
  assert.equal(result.confirmedDurable,false);
  assert.equal(result.collectionParityVerified,false);
  assert.equal(result.canPromote,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historic completion durable import does not claim fresh parity after late V1 write',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1)]);
  const token=app.token();
  const injection=injectAfterHistoryParity(app);
  let result;
  try {
    result=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
      token,'history-import-late-origin');
  } finally {injection.restore();}
  assert.equal(injection.observed().scheduled,true,
    JSON.stringify(injection.observed()));
  assert.equal(result.reason,'legacy_changed_after_history_import',
    JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,false);
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.canPromote,false);
  assert.ok(app.indexedDB.dump(DB).completions.some(
    row=>row.id==='work-completion-1'));
});


async function importedTaskHistory(app,items) {
  await currentTasksWithHistory(app,items);
  const imported=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'initial-reconcile-history');
  assert.equal(imported.fullyMirrored,true,JSON.stringify(imported));
}
async function resyncChangedHistory(app,items,actionId) {
  updateCompletionHistory(app,items);
  const result=await app.api.rehearsePreviewTaskCollectionReconcile(
    app.token(),'task-evidence-'+actionId);
  assert.equal(result.confirmedDurable,true,JSON.stringify(result));
}

test('historical Task completion reconcile safely edits, deletes, inserts and reorders',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1),completion(2,'b'),completion(3)]);
  const changed=[completion(3),{...completion(2,'b'),points:777},completion(4)];
  await resyncChangedHistory(app,changed,'first');
  const authoritative=app.localStorage.getItem(KEY);
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'reconcile-first');
  assert.equal(result.reason,'task_completion_history_reconciled',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.changedRows,4);
  assert.equal(result.addedRows,1);
  assert.equal(result.deletedRows,1);
  assert.equal(result.canPromote,false);
  assert.equal(app.localStorage.getItem(KEY),authoritative);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.tasks,before.tasks);
  assert.equal(after.completions.length,3);
  assert.equal(after.completions.some(r=>r.id==='work-completion-1'),false);
  assert.equal(after.completions.find(r=>r.id==='work-completion-2').entries[0].value.points,777);
  assert.equal(after.completions.find(r=>r.id==='work-completion-3').entries[0].sequence,-1);
  assert.equal((await app.api.inspectPreviewTaskCompletionOrderParity()).match,true);

  const noOp=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'reconcile-noop');
  assert.equal(noOp.reason,'task_completion_history_already_current',JSON.stringify(noOp));
  assert.equal(noOp.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),after);

  const second=[{...completion(4),points:40},completion(3),completion(2,'b')];
  await resyncChangedHistory(app,second,'second');
  const again=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'reconcile-second');
  assert.equal(again.collectionParityVerified,true,JSON.stringify(again));
  assert.equal(again.changedRows,3);
  const restart=install(app.indexedDB,app.localStorage);
  await restart.api.seedFromLegacy();
  const verified=await restart.api.rehearsePreviewTaskCompletionHistoryReconcile(
    restart.token(),'reconcile-restart');
  assert.equal(verified.reason,'task_completion_history_already_current',
    JSON.stringify(verified));
});

test('historical reconciliation refuses unexpected V2-only edits and preserves them',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1),completion(2)]);
  await resyncChangedHistory(app,[{...completion(1),points:90},completion(2)],'tamper');
  const store=app.indexedDB._databases.get(DB)._stores.get('completions');
  const prior=store.get('work-completion-1');
  store.set(prior.id,{...prior,entries:[{...prior.entries[0],
    value:{...prior.entries[0].value,points:999}}]});
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'do-not-overwrite');
  assert.equal(result.reason,'task_completion_reconcile_provenance_mismatch',
    JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical reconciliation refuses legacy source races without writes',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1)]);
  const oldToken=app.token();
  await resyncChangedHistory(app,[{...completion(1),points:9}],'fresh-source');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    oldToken,'stale-source');
  assert.equal(result.reason,'full_origin_changed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical reconciliation preserves all data on an IndexedDB quota denial',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1),completion(2)]);
  await resyncChangedHistory(app,[{...completion(1),points:80},completion(2)],'quota');
  const before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'completions',operation:'put',
    error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'reconcile-quota');
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(result.confirmedDurable,false);
  assert.equal(result.reason,'task_completion_reconcile_atomic_write_failed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical reconciliation rejects a changed V1 action with reused action ID',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1)]);
  await resyncChangedHistory(app,[{...completion(1),points:80}],'action-first');
  assert.equal((await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'used-action')).committed,true);
  await resyncChangedHistory(app,[{...completion(1),points:81}],'action-second');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'used-action');
  assert.equal(result.reason,'task_completion_reconcile_action_id_conflict');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical reconciliation deletes the last completion without false parity',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1)]);
  await resyncChangedHistory(app,[],'empty');
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'delete-all');
  assert.equal(result.committed,true,JSON.stringify(result));
  assert.equal(result.deletedRows,1);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(app.indexedDB.dump(DB).completions.length,0);
  assert.equal((await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'no-op-empty')).collectionParityVerified,true);
  await resyncChangedHistory(app,[completion(7)],'new-after-empty');
  const renewed=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'new-after-empty');
  assert.equal(renewed.committed,true,JSON.stringify(renewed));
  assert.equal(renewed.addedRows,1);
  assert.equal(renewed.collectionParityVerified,true);
});

test('historical reconcile fails closed if prior reconciliation seal is altered',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1)]);
  await resyncChangedHistory(app,[{...completion(1),points:8}],'sealed');
  assert.equal((await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'seal-initial')).committed,true);
  const meta=app.indexedDB._databases.get(DB)._stores.get('meta');
  const record=meta.get('task-preview-completion-reconcile');
  meta.set(record.id,{...record,stateFingerprint:'invalid'});
  await resyncChangedHistory(app,[{...completion(1),points:9}],'seal-followup');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'seal-invalid');
  assert.equal(result.reason,'task_completion_reconcile_prior_seal_invalid');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});



test('historical completion reconcile refuses unproven single-record preview import',async()=>{
  const app=await seeded();
  await currentTasksWithHistory(app,[completion(1)]);
  const lone=await app.api.rehearsePreviewTaskLinkedCompletion(
    'work-completion-1',app.token(),'single');
  assert.equal(lone.confirmedDurable,true,JSON.stringify(lone));
  await resyncChangedHistory(app,[{...completion(1),points:75}],'single-new-v1');
  const before=app.indexedDB.dump(DB);
  const outcome=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'single-unproven');
  assert.equal(outcome.reason,'task_completion_reconcile_provenance_missing');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical completion reconcile refuses more than 64 logical deltas',async()=>{
  const app=await seeded();
  const original=Array.from({length:66},(_,i)=>completion(i));
  await currentTasksWithHistory(app,original);
  const first=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'oversize-hist-1');
  assert.equal(first.importedRows,64,JSON.stringify(first));
  const second=await app.api.rehearsePreviewTaskCompletionHistoryCatchUp(
    app.token(),'oversize-hist-2');
  assert.equal(second.fullyMirrored,true,JSON.stringify(second));
  await resyncChangedHistory(app,original.map(row=>({...row,points:row.points+400})),
    'oversize');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'too-many');
  assert.equal(result.reason,'task_completion_reconcile_batch_too_large',
    JSON.stringify(result));
  assert.equal(result.changedRows,66);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('historical completion reconcile aborts if V2 changes inside write admission',async()=>{
  const app=await seeded();
  await importedTaskHistory(app,[completion(1),completion(2)]);
  await resyncChangedHistory(app,[{...completion(1),points:82},completion(2)],
    'concurrent');
  const database=app.indexedDB._databases.get(DB);
  const original=database.transaction.bind(database);
  let edited=false;
  database.transaction=(stores,mode)=>{
    if (!edited && mode==='readwrite'
      && Array.isArray(stores) && stores.includes('completions')) {
      edited=true;
      const rows=database._stores.get('completions');
      const row=rows.get('work-completion-2');
      rows.set(row.id,{...row,entries:[{...row.entries[0],
        value:{...row.entries[0].value,points:999}}]});
    }
    return original(stores,mode);
  };
  const result=await app.api.rehearsePreviewTaskCompletionHistoryReconcile(
    app.token(),'concurrent-v2');
  assert.equal(edited,true);
  assert.equal(result.reason,'task_completion_reconcile_concurrent_change',
    JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(app.indexedDB.dump(DB).completions.find(
    row=>row.id==='work-completion-1').entries[0].value.points,1);
  assert.equal(app.indexedDB.dump(DB).completions.find(
    row=>row.id==='work-completion-2').entries[0].value.points,999);
  assert.equal(app.indexedDB.dump(DB).mutations.some(
    row=>row.id==='task-preview-completion-reconcile:concurrent-v2'),false);
});

