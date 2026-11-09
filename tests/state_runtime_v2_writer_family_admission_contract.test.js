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
const DARK='taskpoints_state_v2_dark_mode_v1',V1='taskpoints_v1';
const DB='taskpoints_v2_writer_fence_preview_v1';
const FAMILIES=["scoring_core_snapshot_and_habit_journal","home_direct_keys_and_snapshot_saves","game_players_schedules_and_preferences","today_snapshot_and_view_state","settings_import_reset_and_direct_storage","notes_content_dirty_and_authority_flags","emergency_recovery_and_restore","task_journal_and_idle_compaction","work_entry_fast_path_and_editor_fallback"];
async function boot(opts={}){
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify({habits:[],completions:[],tasks:[]})
  });
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  const core={
    STORAGE_KEY:V1,parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1))},
    writePendingHabitDelta(row){return {...row}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b},
    ...opts.coreOverrides
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'family-test'}} ,
    location:{hostname:'localhost'},navigator:opts.navigator,
    JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  return {
    api,localStorage,indexedDB,ctx,
    token(){return JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));}
  };
}
const writer=(a,family,marker,extras={})=>a.api.rehearsePreviewDurableWriterFence(
  'writer',{expectedEpoch:0,marker,writerFamily:family,
    fullOriginToken:a.token(),...extras});
const TASK_JOURNAL='taskpoints_pending_task_mutations_v1';
async function bootRealTaskAdapter(opts={}){
  let commits=0;
  let storage;
  const navigator=opts.navigator||{locks:{request:async(name,_options,callback)=>{
    if(opts.beforeLock)await opts.beforeLock(name);
    return callback({name});
  }}};
  const api=await boot({navigator,
    indexedDB:opts.indexedDB,localStorage:opts.localStorage,
    coreOverrides:{
    assertTaskMutationJournalWritable(){return true},
    journalTaskCompletionBatch(rows){
      commits++;
      const prior=storage.getItem(TASK_JOURNAL);
      const next=prior?JSON.parse(prior):{
        schemaVersion:1,tasks:[],completionUpserts:[],completionDeletes:[],
        updatedAtISO:null
      };
      next.completionUpserts.push(...rows);
      storage.setItem(TASK_JOURNAL,JSON.stringify(next));
    }
  }});
  storage=api.localStorage;
  return {...api,get commits(){return commits}};
}

test('fence-audited real Task adapter commits a valid batch while preview is open',async()=>{
  const a=await bootRealTaskAdapter();
  const row={id:'v2-real-task',taskId:'t-1',points:4};
  const verdict=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [row],a.token());
  assert.equal(verdict.reason,'preview_task_batch_admitted',JSON.stringify(verdict));
  assert.equal(verdict.previewFenceChecked,true);
  assert.equal(verdict.previewFenceBeforeAndAfterStable,true);
  assert.equal(verdict.confirmedDurable,true);
  assert.equal(verdict.productionWritersFenced,false);
  assert.equal(a.commits,1);
  assert.deepEqual(JSON.parse(a.localStorage.getItem(TASK_JOURNAL))
    .completionUpserts,[row]);
});

test('frozen preview fence refuses real Task adapter before the V1 journal write',async()=>{
  const a=await bootRealTaskAdapter();
  const frozen=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen');
  const before=a.localStorage.getItem(TASK_JOURNAL);
  const verdict=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'refused-task'}],a.token());
  assert.equal(verdict.reason,'preview_fence_frozen');
  assert.equal(verdict.canPromote,false);
  assert.equal(verdict.confirmedDurable,false);
  assert.equal(a.commits,0);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),before);
});

test('concurrent preview freeze never receives a false clean Task acknowledgement',async()=>{
  let a,freeze=null,once=false;
  a=await bootRealTaskAdapter({beforeLock:async lockName=>{
    if(lockName==='taskpoints_v2_writer_handoff_rehearsal_v1'&&!once){
      once=true;
      freeze=await a.api.rehearsePreviewDurableWriterFence('freeze',{
        expectedEpoch:0});
    }
  }});
  const verdict=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'interleaved-task',points:1}],a.token());
  assert.equal(freeze.reason,'preview_fence_frozen');
  assert.equal(verdict.reason,'preview_fence_changed_during_task_batch',
    JSON.stringify(verdict));
  assert.equal(verdict.committed,true);
  assert.equal(verdict.confirmedDurable,false);
  assert.equal(verdict.writeOutcomeUncertain,true);
  assert.equal(verdict.canPromote,false);
  assert.equal(a.commits,1);
  assert.equal(JSON.parse(a.localStorage.getItem(TASK_JOURNAL))
    .completionUpserts[0].id,'interleaved-task');
});

const TASK_BRIDGE_LOCK='taskpoints_v2_preview_task_freeze_cooperative_v1';
const TASK_ATOMIC_LOCK='taskpoints_v2_writer_handoff_rehearsal_v1';
function sharedFakeWebLocks(onAcquired){
  const held=new Set();
  return {request:async(name,_opts,callback)=>{
    if(held.has(name))return callback(null);
    held.add(name);
    try{
      if(onAcquired)await onAcquired(name);
      return await callback({name});
    }finally{held.delete(name);}
  }};
}

test('cooperative preview freeze is refused while the guarded Task writer holds its lock',async()=>{
  let a,attemptedFreeze=null,once=false;
  const navigator={locks:sharedFakeWebLocks(async name=>{
    if(name===TASK_ATOMIC_LOCK&&!once){
      once=true;
      attemptedFreeze=await a.api.rehearsePreviewCooperativeWriterFreeze({
        expectedEpoch:0});
    }
  })};
  a=await bootRealTaskAdapter({navigator});
  const wrote=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'lock-writer-first',points:4}],a.token());
  assert.equal(wrote.reason,'preview_task_batch_admitted',JSON.stringify(wrote));
  assert.equal(wrote.confirmedDurable,true);
  assert.equal(wrote.cooperativeTaskFreezeLockUsed,true);
  assert.equal(attemptedFreeze.reason,'cooperative_freeze_lock_held_elsewhere');
  assert.equal(attemptedFreeze.canPromote,false);
  assert.equal(a.commits,1);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,false);
  const frozen=await a.api.rehearsePreviewCooperativeWriterFreeze({expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen',JSON.stringify(frozen));
  assert.equal(frozen.cooperativeTaskFreezeLockUsed,true);
  const previous=a.localStorage.getItem(TASK_JOURNAL);
  const denied=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'must-not-write-after-coop-freeze'}],a.token());
  assert.equal(denied.reason,'preview_fence_frozen');
  assert.equal(a.commits,1);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),previous);
});

test('guarded Task writer cannot enter a cooperative preview freeze in progress',async()=>{
  let a,attemptedTask=null,once=false;
  const navigator={locks:sharedFakeWebLocks(async name=>{
    if(name===TASK_BRIDGE_LOCK&&!once){
      once=true;
      attemptedTask=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
        [{id:'freeze-wins-over-task'}],a.token());
    }
  })};
  a=await bootRealTaskAdapter({navigator});
  const frozen=await a.api.rehearsePreviewCooperativeWriterFreeze({
    expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen',JSON.stringify(frozen));
  assert.equal(frozen.cooperativeTaskFreezeLockUsed,true);
  assert.equal(attemptedTask.reason,'cooperative_task_lock_held_elsewhere');
  assert.equal(attemptedTask.confirmedDurable,false);
  assert.equal(attemptedTask.committed,false);
  assert.equal(a.commits,0);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,true);
});

test('cooperative preview admission and freeze fail closed without Web Locks',async()=>{
  const a=await bootRealTaskAdapter({navigator:{locks:null}});
  assert.equal((await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'no-lock-write'}],a.token())).reason,'lock_manager_unavailable');
  assert.equal((await a.api.rehearsePreviewCooperativeWriterFreeze({
    expectedEpoch:0})).reason,'lock_manager_unavailable');
  assert.equal(a.commits,0);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,false);
});

test('read-only Task journal evidence survives reload after a confirmed preview write',async()=>{
  const a=await bootRealTaskAdapter();
  const row={id:'journal-evidence-after-reload',taskId:'task-a',points:3.5};
  const saved=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [row],a.token());
  assert.equal(saved.reason,'preview_task_batch_admitted',JSON.stringify(saved));
  const original=a.localStorage.getItem(TASK_JOURNAL);
  const restarted=await boot({
    localStorage:a.localStorage,indexedDB:a.indexedDB});
  const evidence=restarted.api.inspectPreviewTaskBatchJournalEvidence(
    JSON.stringify([row]));
  assert.equal(evidence.reason,'task_batch_rows_observed_in_pending_journal',
    JSON.stringify(evidence));
  assert.equal(evidence.pendingJournalRowsMatched,true);
  assert.equal(evidence.observedRowCount,1);
  assert.equal(evidence.safeToRetry,false);
  assert.equal(evidence.confirmedDurable,false);
  assert.equal(evidence.canPromote,false);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),original);
});

test('read-only Task journal evidence finds a potentially committed uncertain Task batch',async()=>{
  let a,freeze=null,once=false;
  a=await bootRealTaskAdapter({beforeLock:async name=>{
    if(name==='taskpoints_v2_writer_handoff_rehearsal_v1'&&!once){
      once=true;
      freeze=await a.api.rehearsePreviewDurableWriterFence('freeze',{
        expectedEpoch:0});
    }
  }});
  const row={id:'uncertain-task-journal-row',taskId:'task-b',points:1};
  const result=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [row],a.token());
  assert.equal(freeze.reason,'preview_fence_frozen');
  assert.equal(result.reason,'preview_fence_changed_during_task_batch');
  assert.equal(result.writeOutcomeUncertain,true);
  const raw=a.localStorage.getItem(TASK_JOURNAL);
  const verdict=a.api.inspectPreviewTaskBatchJournalEvidence(
    JSON.stringify([row]));
  assert.equal(verdict.pendingJournalRowsMatched,true);
  assert.equal(verdict.safeToRetry,false);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),raw);
});

test('Task journal evidence distinguishes missing, conflicting, duplicate and deleted rows',async()=>{
  const a=await boot();
  const row={id:'target-journal-evidence',taskId:'task-c',points:4};
  const request=JSON.stringify([row]);
  assert.equal(a.api.inspectPreviewTaskBatchJournalEvidence(request).reason,
    'task_journal_absent_or_compacted');
  const journal={schemaVersion:1,tasks:[],completionUpserts:[row],
    completionDeletes:[],updatedAtISO:null};
  const set=()=>a.localStorage.setItem(TASK_JOURNAL,JSON.stringify(journal));
  journal.completionUpserts=[{...row,points:9}];set();
  const wrong=a.api.inspectPreviewTaskBatchJournalEvidence(request);
  assert.equal(wrong.reason,'task_batch_journal_conflict');
  assert.equal(wrong.conflictingRowCount,1);
  journal.completionUpserts=[row,{...row,points:9}];set();
  const duplicate=a.api.inspectPreviewTaskBatchJournalEvidence(request);
  assert.equal(duplicate.reason,'task_batch_journal_conflict');
  assert.equal(duplicate.pendingJournalRowsMatched,false);
  journal.completionUpserts=[row];journal.completionDeletes=[row.id];set();
  const deleted=a.api.inspectPreviewTaskBatchJournalEvidence(request);
  assert.equal(deleted.reason,'task_batch_journal_tombstoned');
  assert.equal(deleted.tombstonedRowCount,1);
  journal.completionUpserts=[];journal.completionDeletes=[];set();
  const missing=a.api.inspectPreviewTaskBatchJournalEvidence(request);
  assert.equal(missing.reason,'task_batch_journal_incomplete_or_compacted');
  for(const value of [wrong,duplicate,deleted,missing]){
    assert.equal(value.safeToRetry,false);
    assert.equal(value.canPromote,false);
  }
});

test('Task journal recovery inspection detects concurrent old-tab source drift and leaves it untouched',async()=>{
  const a=await boot();
  const row={id:'old-tab-during-read',taskId:'task-d'};
  a.localStorage.setItem(TASK_JOURNAL,JSON.stringify({
    schemaVersion:1,tasks:[],completionUpserts:[row],
    completionDeletes:[],updatedAtISO:null
  }));
  const read=a.localStorage.getItem.bind(a.localStorage);
  let injected=false,reads=0;
  a.localStorage.getItem=key=>{
    const value=read(key);
    // The first read belongs to the opening full-origin inventory; trigger
    // the old-tab mutation on the separate raw-journal evidence read.
    if(key===TASK_JOURNAL&&++reads===2){
      injected=true;
      a.localStorage.setItem('tp_projects_v1','old-tab-write-during-inspection');
    }
    return value;
  };
  const verdict=a.api.inspectPreviewTaskBatchJournalEvidence(
    JSON.stringify([row]));
  assert.equal(injected,true);
  assert.equal(verdict.reason,'full_origin_changed_during_inspection');
  assert.equal(verdict.pendingJournalRowsMatched,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    'old-tab-write-during-inspection');
});

test('Task journal recovery inspection refuses invalid inputs and disabled preview',async()=>{
  const a=await boot();
  for(const input of ['[]','not-json','[{"id":"x"},{"id":"x"}]',
      '[{"id":""}]',JSON.stringify([{id:'x'},null])]){
    const result=a.api.inspectPreviewTaskBatchJournalEvidence(input);
    assert.equal(result.pendingJournalRowsMatched,false);
    assert.equal(result.safeToRetry,false);
    assert.equal(result.canPromote,false);
  }
  a.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal(a.api.inspectPreviewTaskBatchJournalEvidence('[{"id":"x"}]')
    .reason,'preview_host_required');
  a.ctx.location.hostname='localhost';
  a.localStorage.removeItem(DARK);
  assert.equal(a.api.inspectPreviewTaskBatchJournalEvidence('[{"id":"x"}]')
    .reason,'dark_disabled');
});

test('effective Task evidence recognizes a completion compacted from journal into V1 snapshot',async()=>{
  const a=await boot();
  const row={id:'snapshot-compacted-task',taskId:'task-a',points:5};
  const source=JSON.parse(a.localStorage.getItem(V1));
  source.completions.push(row);
  a.localStorage.setItem(V1,JSON.stringify(source));
  a.localStorage.removeItem(TASK_JOURNAL);
  const snapshot=a.localStorage.getItem(V1);
  const evidence=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([row]));
  assert.equal(evidence.reason,'task_batch_rows_observed_in_v1_snapshot',
    JSON.stringify(evidence));
  assert.equal(evidence.effectiveRowsObserved,true);
  assert.equal(evidence.observedSnapshotRowCount,1);
  assert.equal(evidence.observedJournalRowCount,0);
  assert.equal(evidence.safeToRetry,false);
  assert.equal(evidence.confirmedDurable,false);
  assert.equal(evidence.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),snapshot);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
});

test('effective Task evidence handles mixed snapshot and journal completions after partial compaction',async()=>{
  const a=await boot();
  const old={id:'compacted-old-task',taskId:'task-1',points:3};
  const newer={id:'pending-new-task',taskId:'task-2',points:7};
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.completions=[old];
  a.localStorage.setItem(V1,JSON.stringify(state));
  a.localStorage.setItem(TASK_JOURNAL,JSON.stringify({
    schemaVersion:1,tasks:[],completionUpserts:[newer],
    completionDeletes:[],updatedAtISO:null
  }));
  const evidence=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([old,newer]));
  assert.equal(evidence.reason,'task_batch_rows_observed_in_both_sources',
    JSON.stringify(evidence));
  assert.equal(evidence.effectiveRowsObserved,true);
  assert.equal(evidence.observedSnapshotRowCount,1);
  assert.equal(evidence.observedJournalRowCount,1);
  assert.equal(evidence.safeToRetry,false);
});

test('effective Task evidence prioritizes newer journal corrections and tombstones',async()=>{
  const a=await boot();
  const old={id:'corrected-after-compaction',taskId:'task-1',points:3};
  const newer={...old,points:9};
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.completions.push(old);
  a.localStorage.setItem(V1,JSON.stringify(state));
  const journal={schemaVersion:1,tasks:[],completionUpserts:[newer],
    completionDeletes:[],updatedAtISO:null};
  const save=()=>a.localStorage.setItem(TASK_JOURNAL,JSON.stringify(journal));
  save();
  const exact=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([newer]));
  assert.equal(exact.reason,'task_batch_rows_observed_in_pending_journal');
  assert.equal(exact.effectiveRowsObserved,true);
  const stale=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([old]));
  assert.equal(stale.reason,'task_batch_effective_conflict');
  assert.equal(stale.effectiveRowsObserved,false);
  assert.equal(stale.conflictingRowCount,1);
  journal.completionDeletes=[old.id];save();
  const deleted=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([newer]));
  assert.equal(deleted.reason,'task_batch_effectively_tombstoned');
  assert.equal(deleted.effectiveRowsObserved,false);
  assert.equal(deleted.tombstonedRowCount,1);
  assert.equal(deleted.safeToRetry,false);
});

test('effective Task evidence refuses duplicate or corrupted sources without modifying them',async()=>{
  const a=await boot();
  const row={id:'duplicate-effective-row',taskId:'task-z'};
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.completions=[row,{...row,points:2}];
  a.localStorage.setItem(V1,JSON.stringify(state));
  const raw=a.localStorage.getItem(V1);
  assert.equal(a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([row])).reason,'task_snapshot_completion_ids_invalid');
  assert.equal(a.localStorage.getItem(V1),raw);
  state.completions=[row];
  a.localStorage.setItem(V1,JSON.stringify(state));
  const journal={schemaVersion:1,tasks:[],completionUpserts:[row,row],
    completionDeletes:[],updatedAtISO:null};
  a.localStorage.setItem(TASK_JOURNAL,JSON.stringify(journal));
  assert.equal(a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([row])).reason,'task_journal_completion_ids_invalid');
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),JSON.stringify(journal));
  a.localStorage.setItem(TASK_JOURNAL,'malformed{');
  assert.equal(a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([row])).reason,'task_source_inspection_unreadable');
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),'malformed{');
});

test('effective Task evidence rejects old-tab source drift and never retries',async()=>{
  const a=await boot();
  const row={id:'effective-race-row',taskId:'task-a',points:3};
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.completions.push(row);
  a.localStorage.setItem(V1,JSON.stringify(state));
  const normal=a.localStorage.getItem.bind(a.localStorage);
  let oldTabWrote=false,reads=0;
  a.localStorage.getItem=key=>{
    const value=normal(key);
    if(key===V1&&++reads===2){
      oldTabWrote=true;
      a.localStorage.setItem('tp_projects_v1','old-tab-changed-project');
    }
    return value;
  };
  // Capture inventory reads snapshot first; the separate snapshot read
  // then triggers the concurrent older-tab Projects save.
  const result=a.api.inspectPreviewTaskBatchEffectiveEvidence(
    JSON.stringify([row]));
  assert.equal(oldTabWrote,true);
  assert.equal(result.reason,'full_origin_changed_during_inspection');
  assert.equal(result.effectiveRowsObserved,false);
  assert.equal(result.safeToRetry,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    'old-tab-changed-project');
});

test('cooperative preview Projects writer saves real V1 data while preserving unknown fields',async()=>{
  const a=await bootRealTaskAdapter();
  const original=JSON.stringify([{id:'p1',title:'Existing',
    description:'keep this',subtasks:[{id:'s1',done:false}]}]);
  a.localStorage.setItem('tp_projects_v1',original);
  const updated=JSON.stringify([{id:'p1',title:'Updated',description:'keep this',
    extra:{arbitrary:'preserved'},subtasks:[{id:'s1',done:true}]},
    {id:'p2',title:'New',subtasks:[]}]);
  const before=a.localStorage.getItem(V1);
  const result=await a.api.rehearsePreviewCooperativeProjectsSave(
    updated,a.token());
  assert.equal(result.reason,'preview_projects_saved',JSON.stringify(result));
  assert.equal(result.projectsSaved,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.committed,true);
  assert.equal(result.productionWritersFenced,false);
  assert.equal(result.cooperativeTaskFreezeLockUsed,true);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),updated);
  assert.equal(a.localStorage.getItem(V1),before);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
  assert.equal(a.commits,0);
});

test('cooperative Projects writer refuses stale origin, invalid sources and invalid payloads',async()=>{
  const a=await bootRealTaskAdapter();
  const payload=JSON.stringify([{id:'keep',title:'Projects'}]);
  const originalToken=a.token();
  a.localStorage.setItem('taskpoints_notes_v1','old-tab-changed-notes');
  const denied=await a.api.rehearsePreviewCooperativeProjectsSave(
    payload,originalToken);
  assert.equal(denied.reason,'full_origin_changed',JSON.stringify(denied));
  assert.equal(a.localStorage.getItem('tp_projects_v1'),null);
  assert.equal(a.localStorage.getItem('taskpoints_notes_v1'),
    'old-tab-changed-notes');
  a.localStorage.setItem('tp_projects_v1','corrupt[');
  const invalid=await a.api.rehearsePreviewCooperativeProjectsSave(
    payload,a.token());
  assert.equal(invalid.reason,'projects_existing_source_invalid');
  assert.equal(a.localStorage.getItem('tp_projects_v1'),'corrupt[');
  for(const bad of ['[{"id":"a"},{"id":"a"}]',
    '[{"id":"a","subtasks":[{"id":"x"},{"id":"x"}]}]',
    '[{"id":"a"}] ', '{"id":"not-an-array"}']){
    const fail=await a.api.rehearsePreviewCooperativeProjectsSave(
      bad,a.token());
    assert.equal(fail.projectsSaved,false);
    assert.equal(fail.confirmedDurable,false);
    assert.equal(a.localStorage.getItem('tp_projects_v1'),'corrupt[');
  }
});

test('cooperative Projects writer cannot write behind a frozen preview fence',async()=>{
  const a=await bootRealTaskAdapter();
  const frozen=await a.api.rehearsePreviewCooperativeWriterFreeze({
    expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen');
  const result=await a.api.rehearsePreviewCooperativeProjectsSave(
    JSON.stringify([{id:'frozen-project'}]),a.token());
  assert.equal(result.reason,'preview_fence_frozen',JSON.stringify(result));
  assert.equal(result.projectsSaved,false);
  assert.equal(result.committed,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),null);
});

test('shared lock excludes Projects save while cooperative Task adapter is active',async()=>{
  let a,competing=null,once=false;
  const navigator={locks:sharedFakeWebLocks(async name=>{
    if(name===TASK_ATOMIC_LOCK&&!once){
      once=true;
      competing=await a.api.rehearsePreviewCooperativeProjectsSave(
        JSON.stringify([{id:'cross-writer-project'}]),a.token());
    }
  })};
  a=await bootRealTaskAdapter({navigator});
  const task=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'task-holds-coop-lock',taskId:'t1',points:2}],a.token());
  assert.equal(task.reason,'preview_task_batch_admitted',JSON.stringify(task));
  assert.equal(competing.reason,'cooperative_projects_lock_held_elsewhere');
  assert.equal(a.localStorage.getItem('tp_projects_v1'),null);
  const saved=await a.api.rehearsePreviewCooperativeProjectsSave(
    JSON.stringify([{id:'cross-writer-project'}]),a.token());
  assert.equal(saved.reason,'preview_projects_saved',JSON.stringify(saved));
  assert.equal(a.localStorage.getItem(TASK_JOURNAL).includes('task-holds-coop-lock'),
    true);
});

test('Projects write racing a noncooperating old tab reports uncertainty without repair',async()=>{
  const a=await bootRealTaskAdapter();
  const original=a.localStorage.setItem.bind(a.localStorage);
  let injected=false;
  a.localStorage.setItem=(key,value)=>{
    original(key,value);
    if(key==='tp_projects_v1'&&!injected){
      injected=true;
      original('taskpoints_notes_v1','older-tab-keeps-new-notes');
    }
  };
  const result=await a.api.rehearsePreviewCooperativeProjectsSave(
    JSON.stringify([{id:'projects-race'}]),a.token());
  assert.equal(injected,true);
  assert.equal(result.reason,'other_origin_changed_during_projects_write',
    JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.confirmedDurable,false);
  assert.equal(result.committed,true);
  assert.equal(result.canPromote,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    '[{"id":"projects-race"}]');
  assert.equal(a.localStorage.getItem('taskpoints_notes_v1'),
    'older-tab-keeps-new-notes');
});

test('Projects write failure can leave durable data and is never falsely acknowledged',async()=>{
  const a=await bootRealTaskAdapter();
  const original=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    original(key,value);
    if(key==='tp_projects_v1')throw Error('postwrite-error');
  };
  const result=await a.api.rehearsePreviewCooperativeProjectsSave(
    JSON.stringify([{id:'written-then-error'}]),a.token());
  assert.equal(result.reason,'projects_write_failed');
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.projectsSaved,false);
  assert.equal(result.confirmedDurable,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    '[{"id":"written-then-error"}]');
});

test('cooperative Today V1 writer preserves all four day maps and unknown fields',async()=>{
  const a=await bootRealTaskAdapter();
  const original=JSON.stringify({version:1,tasksByDay:{
    '2026-11-09':[{id:'old-task',done:false}]}});
  a.localStorage.setItem('taskpoints_today_view_v1',original);
  const proposed=JSON.stringify({version:1,tasksByDay:{
    '2026-11-09':[{id:'old-task',done:true},{id:'new-task'}]},
    notesByDay:{'2026-11-09':['Hello']},
    selectedHabitIdsByDay:{'2026-11-10':['habit-a']},
    orderByDay:{'2026-11-09':['old-task','new-task']},
    extra:{legacyCustom:'preserved'}});
  const snapshot=a.localStorage.getItem(V1);
  const result=await a.api.rehearsePreviewCooperativeTodaySave(
    proposed,a.token());
  assert.equal(result.reason,'preview_today_saved',JSON.stringify(result));
  assert.equal(result.todaySaved,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.committed,true);
  assert.equal(result.cooperativeTaskFreezeLockUsed,true);
  assert.equal(result.productionWritersFenced,false);
  assert.equal(result.dayCount,2);
  assert.equal(result.entryCount,6);
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),proposed);
  assert.equal(a.localStorage.getItem(V1),snapshot);
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
  assert.equal(a.commits,0);
});

test('cooperative Today writer refuses stale source, malformed existing source and malformed JSON',async()=>{
  const a=await bootRealTaskAdapter();
  const raw=JSON.stringify({version:1,tasksByDay:{
    '2026-11-09':[{id:'task-today'}]}});
  const stale=a.token();
  a.localStorage.setItem('tp_projects_v1','[{"id":"external-project"}]');
  const denied=await a.api.rehearsePreviewCooperativeTodaySave(raw,stale);
  assert.equal(denied.reason,'full_origin_changed',JSON.stringify(denied));
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),null);
  a.localStorage.setItem('taskpoints_today_view_v1','{"version":');
  const corrupted=await a.api.rehearsePreviewCooperativeTodaySave(raw,a.token());
  assert.equal(corrupted.reason,'today_existing_source_invalid');
  assert.equal(corrupted.confirmedDurable,false);
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),'{"version":');
  for(const invalid of [
    '[]','{"version":2}',JSON.stringify({tasksByDay:[]}),
    JSON.stringify({tasksByDay:{'not-a-date':[]}}),
    '{"tasksByDay":{}} ', '{"notesByDay":{"2026-11-09":{}}}'
  ]){
    const result=await a.api.rehearsePreviewCooperativeTodaySave(
      invalid,a.token());
    assert.equal(result.todaySaved,false,JSON.stringify(result));
    assert.equal(result.confirmedDurable,false);
    assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),
      '{"version":');
  }
});

test('cooperative Today writer is blocked by a frozen preview fence',async()=>{
  const a=await bootRealTaskAdapter();
  const freeze=await a.api.rehearsePreviewCooperativeWriterFreeze({
    expectedEpoch:0});
  assert.equal(freeze.reason,'preview_fence_frozen');
  const result=await a.api.rehearsePreviewCooperativeTodaySave(
    '{"version":1}',a.token());
  assert.equal(result.reason,'preview_fence_frozen',JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(result.todaySaved,false);
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),null);
});

test('cooperative Today writer is excluded while Task adapter holds shared lock',async()=>{
  let a,opponent=null,once=false;
  const navigator={locks:sharedFakeWebLocks(async name=>{
    if(name===TASK_ATOMIC_LOCK&&!once){
      once=true;
      opponent=await a.api.rehearsePreviewCooperativeTodaySave(
        '{"version":1}',a.token());
    }
  })};
  a=await bootRealTaskAdapter({navigator});
  const wrote=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'task-holds-lock-for-today',taskId:'task-a'}],a.token());
  assert.equal(wrote.reason,'preview_task_batch_admitted',JSON.stringify(wrote));
  assert.equal(opponent.reason,'cooperative_today_lock_held_elsewhere');
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),null);
  const next=await a.api.rehearsePreviewCooperativeTodaySave(
    '{"version":1}',a.token());
  assert.equal(next.reason,'preview_today_saved',JSON.stringify(next));
  assert.equal(a.commits,1);
});

test('Today old-tab source edit during preview write reports uncertainty and preserves both sources',async()=>{
  const a=await bootRealTaskAdapter();
  const real=a.localStorage.setItem.bind(a.localStorage);
  let injected=false;
  a.localStorage.setItem=(key,value)=>{
    real(key,value);
    if(key==='taskpoints_today_view_v1'&&!injected){
      injected=true;
      real('tp_projects_v1','[{"id":"other-tab-project"}]');
    }
  };
  const result=await a.api.rehearsePreviewCooperativeTodaySave(
    '{"version":1,"notesByDay":{"2026-11-09":["test"]}}',a.token());
  assert.equal(injected,true);
  assert.equal(result.reason,'other_origin_changed_during_today_write',
    JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.confirmedDurable,false);
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),
    '{"version":1,"notesByDay":{"2026-11-09":["test"]}}');
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    '[{"id":"other-tab-project"}]');
});

test('Today postwrite exception reports uncertain durability without rewriting V1',async()=>{
  const a=await bootRealTaskAdapter();
  const real=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    real(key,value);
    if(key==='taskpoints_today_view_v1')throw Error('postwrite-error');
  };
  const result=await a.api.rehearsePreviewCooperativeTodaySave(
    '{"version":1}',a.token());
  assert.equal(result.reason,'today_write_failed');
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.confirmedDurable,false);
  assert.equal(a.localStorage.getItem('taskpoints_today_view_v1'),
    '{"version":1}');
});

const NOTES_CACHE='taskpoints_notes_v1';
const NOTES_DIRTY='taskpoints_notes_dirty_v1';
const NOTES_AUTH='taskpoints_notes_authoritative_v1';
function primeDirtyNotesCache(app,cache='A safe cached note') {
  const state=JSON.parse(app.localStorage.getItem(V1));
  state.notes='Older saved notes';
  app.localStorage.setItem(V1,JSON.stringify(state));
  app.localStorage.setItem(NOTES_CACHE,cache);
  app.localStorage.setItem(NOTES_AUTH,'1');
  app.localStorage.setItem(NOTES_DIRTY,'1');
}

test('cooperative Notes preview keeps raw keystrokes without changing snapshot or markers',async()=>{
  const a=await bootRealTaskAdapter();
  primeDirtyNotesCache(a,'First draft');
  const snapshot=a.localStorage.getItem(V1);
  const result=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'Shorter draft',a.token());
  assert.equal(result.reason,'preview_notes_dirty_cache_saved',
    JSON.stringify(result));
  assert.equal(result.cacheWriteObserved,true);
  assert.equal(result.cacheReadbackVerified,true);
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,false);
  assert.equal(result.notesFullySynchronized,false);
  assert.equal(result.canPromote,false);
  assert.equal(result.cooperativeTaskFreezeLockUsed,true);
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'Shorter draft');
  assert.equal(a.localStorage.getItem(V1),snapshot);
  assert.equal(a.localStorage.getItem(NOTES_AUTH),'1');
  assert.equal(a.localStorage.getItem(NOTES_DIRTY),'1');
  assert.equal(a.localStorage.getItem(TASK_JOURNAL),null);
  const inspected=await a.api.inspectPreviewNotesSource();
  assert.equal(inspected.sourceVerified,true,JSON.stringify(inspected));
  assert.equal(inspected.selectedSource,'marked_cache');
  assert.equal(inspected.selectedLength,'Shorter draft'.length);
  assert.equal(a.commits,0);
  const cleared=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    '',a.token());
  assert.equal(cleared.reason,'preview_notes_dirty_cache_saved');
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'');
  assert.equal(a.localStorage.getItem(V1),snapshot);
  const reloaded=await boot({localStorage:a.localStorage,indexedDB:a.indexedDB});
  const proof=await reloaded.api.inspectPreviewNotesSource();
  assert.equal(proof.selectedSource,'marked_cache');
  assert.equal(proof.selectedLength,0);
});

test('cooperative Notes preview refuses first-edit marker initialization and unmarked cache',async()=>{
  const a=await bootRealTaskAdapter();
  const raw=JSON.stringify({habits:[],tasks:[],completions:[],
    notes:'Must not erase existing Notes'});
  a.localStorage.setItem(V1,raw);
  const first=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'Unsafe first edit',a.token());
  assert.equal(first.reason,'notes_dirty_authority_not_established');
  assert.equal(first.committed,false);
  assert.equal(a.localStorage.getItem(NOTES_CACHE),null);
  a.localStorage.setItem(NOTES_CACHE,'Cache exists');
  a.localStorage.setItem(NOTES_AUTH,'1');
  for(const marker of [null,'0']){
    if(marker===null)a.localStorage.removeItem(NOTES_DIRTY);
    else a.localStorage.setItem(NOTES_DIRTY,marker);
    const rejected=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
      'Not allowed',a.token());
    assert.equal(rejected.reason,'notes_dirty_authority_not_established');
    assert.equal(a.localStorage.getItem(NOTES_CACHE),'Cache exists');
  }
  a.localStorage.setItem(NOTES_DIRTY,'1');
  a.localStorage.removeItem(NOTES_AUTH);
  assert.equal((await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'Still blocked',a.token())).reason,'notes_dirty_authority_not_established');
  assert.equal(a.localStorage.getItem(V1),raw);
});

test('cooperative Notes preview checks stale origin and invalid snapshot before writing',async()=>{
  const a=await bootRealTaskAdapter();
  primeDirtyNotesCache(a);
  const token=a.token();
  a.localStorage.setItem('tp_projects_v1','[{"id":"old-tab-project"}]');
  const stale=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'should not overwrite',token);
  assert.equal(stale.reason,'full_origin_changed',JSON.stringify(stale));
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'A safe cached note');
  a.localStorage.setItem(V1,'broken-json{');
  const invalid=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'not safe yet',a.token());
  assert.equal(invalid.reason,'notes_source_unreadable');
  assert.equal(a.localStorage.getItem(V1),'broken-json{');
  for(const invalidValue of [null,123,{},'a'.repeat(1048577)]){
    const refused=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
      invalidValue,a.token());
    assert.equal(refused.reason,'notes_text_invalid_or_oversized');
  }
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'A safe cached note');
});

test('cooperative Notes cache is blocked by frozen preview and by a competing Task writer',async()=>{
  let a, competing=null,once=false;
  const navigator={locks:sharedFakeWebLocks(async name=>{
    if(name===TASK_ATOMIC_LOCK&&!once){
      once=true;
      competing=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
        'Concurrent note',a.token());
    }
  })};
  a=await bootRealTaskAdapter({navigator});
  primeDirtyNotesCache(a);
  const task=await a.api.rehearsePreviewFenceCheckedTaskCompletionBatch(
    [{id:'task-holds-notes-lock',taskId:'t1'}],a.token());
  assert.equal(task.reason,'preview_task_batch_admitted');
  assert.equal(competing.reason,'cooperative_notes_lock_held_elsewhere');
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'A safe cached note');
  assert.equal(a.localStorage.getItem(TASK_JOURNAL).includes('task-holds-notes-lock'),true);
  const frozen=await a.api.rehearsePreviewCooperativeWriterFreeze({
    expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen');
  const denied=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'No after freeze',a.token());
  assert.equal(denied.reason,'preview_fence_frozen');
  assert.equal(denied.cacheWriteObserved,false);
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'A safe cached note');
});

test('Notes preview detects older-tab writes during cache append and preserves both',async()=>{
  const a=await bootRealTaskAdapter();
  primeDirtyNotesCache(a);
  const raw=a.localStorage.setItem.bind(a.localStorage);
  let injected=false;
  a.localStorage.setItem=(key,value)=>{
    raw(key,value);
    if(key===NOTES_CACHE&&!injected){
      injected=true;
      raw('tp_projects_v1','[{"id":"older-tab-unaltered"}]');
    }
  };
  const result=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'new Notes from preview',a.token());
  assert.equal(injected,true);
  assert.equal(result.reason,'other_origin_changed_during_notes_write',
    JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,false);
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'new Notes from preview');
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    '[{"id":"older-tab-unaltered"}]');
});

test('Notes preview postwrite failure leaves cached bytes and reports uncertainty',async()=>{
  const a=await bootRealTaskAdapter();
  primeDirtyNotesCache(a);
  const raw=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    raw(key,value);
    if(key===NOTES_CACHE)throw Error('failure-after-storage-wrote');
  };
  const result=await a.api.rehearsePreviewCooperativeDirtyNotesCacheSave(
    'persisted despite error',a.token());
  assert.equal(result.reason,'notes_cache_write_failed',JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.committed,false);
  assert.equal(result.confirmedDurable,false);
  assert.equal(a.localStorage.getItem(NOTES_CACHE),'persisted despite error');
  assert.equal(a.localStorage.getItem(NOTES_DIRTY),'1');
  assert.equal(a.localStorage.getItem(NOTES_AUTH),'1');
});

test('strict synthetic freeze requires all nine historical writer families',async()=>{
  const a=await boot();
  const before=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(before.reason,'preview_writer_families_incomplete',JSON.stringify(before));
  assert.equal(before.missingObservedFamilies.length,FAMILIES.length);
  const fresh=await a.api.rehearsePreviewDurableWriterFence('read');
  assert.equal(fresh.fence.frozen,false);
  for(const [i,family] of FAMILIES.entries()){
    const result=await writer(a,family,'family-'+i);
    assert.equal(result.reason,'preview_writer_recorded',JSON.stringify(result));
    assert.equal(result.fence.writersCommitted,i+1);
    const check=await a.api.rehearsePreviewDurableWriterFence('audit');
    assert.equal(check.reason,'preview_writer_inventory_consistent',JSON.stringify(check));
    assert.equal(check.previewWriterFamilyCounts[family],1);
    assert.equal(check.syntheticFamilyInventoryComplete,i===FAMILIES.length-1);
    assert.equal(check.allLegacyWritersKnown,false);
    assert.equal(check.productionWritersFenced,false);
  }
  const final=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(final.reason,'preview_fence_frozen',JSON.stringify(final));
  assert.equal(final.fence.frozen,true);
  assert.equal(final.fence.epoch,1);
  assert.equal((await writer(a,FAMILIES[0],'too-late',{expectedEpoch:1}))
    .reason,'fence_frozen');
  const after=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(after.syntheticFamilyInventoryComplete,true);
  assert.equal(after.productionWritersFenced,false);
});
test('source token is mandatory; stale journal and sidecar writes block admission',async()=>{
  const a=await boot(),v1=a.localStorage.getItem(V1),original=a.token();
  const missing=await a.api.rehearsePreviewDurableWriterFence('writer',{
    expectedEpoch:0,marker:'missing',writerFamily:FAMILIES[0]});
  assert.equal(missing.reason,'preview_writer_family_full_origin_token_required');
  a.localStorage.setItem('tp_projects_v1','[{"id":"old-tab"}]');
  const stale=await writer(a,FAMILIES[0],'stale',{fullOriginToken:original});
  assert.equal(stale.reason,'preview_writer_family_origin_stale');
  const after=await a.api.rehearsePreviewDurableWriterFence('read');
  assert.equal(after.fence.writersCommitted,0);
  assert.equal(a.localStorage.getItem(V1),v1);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),'[{"id":"old-tab"}]');
  const current=await writer(a,FAMILIES[0],'fresh');
  assert.equal(current.reason,'preview_writer_recorded',JSON.stringify(current));
});
test('read-only audit detects older-tab source changes without rewriting V1',async()=>{
  const a=await boot();
  const source=a.localStorage.getItem(V1);
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'audit-origin-'+i)).reason,
      'preview_writer_recorded');
  const matching=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(matching.syntheticFamilyInventoryComplete,true);
  assert.equal(matching.syntheticFamilyOriginConsistent,true);
  assert.equal(matching.syntheticFamilyOriginMatchesCurrent,true);
  a.localStorage.setItem(V1,JSON.stringify({
    habits:[],completions:[],tasks:[{id:'unfenced-older-tab-save'}]
  }));
  const changed=a.localStorage.getItem(V1);
  const drift=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(drift.reason,'preview_writer_inventory_consistent');
  assert.equal(drift.syntheticFamilyOriginConsistent,true);
  assert.equal(drift.syntheticFamilyOriginMatchesCurrent,false);
  assert.equal(drift.syntheticFamilyInventoryComplete,true);
  assert.equal(drift.productionWritersFenced,false);
  assert.equal(drift.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),changed);
  assert.notEqual(changed,source);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,false);
});

test('audit does not claim current source after an old tab races its fingerprint',async()=>{
  const a=await boot();
  assert.equal((await writer(a,FAMILIES[0],'race-baseline')).reason,
    'preview_writer_recorded');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  let injected=false;
  db.transaction=(stores,mode)=>{
    if(!injected&&mode==='readonly'){
      injected=true;
      a.localStorage.setItem('taskpoints_notes_v1','old-tab-saved-after-hash');
    }
    return original(stores,mode);
  };
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(injected,true);
  assert.equal(audit.reason,'preview_writer_inventory_consistent');
  assert.equal(audit.syntheticFamilyOriginConsistent,true);
  assert.equal(audit.syntheticFamilyOriginMatchesCurrent,false);
  assert.equal(audit.productionWritersFenced,false);
  assert.equal(a.localStorage.getItem('taskpoints_notes_v1'),
    'old-tab-saved-after-hash');
});

test('different family replays cannot claim another family marker',async()=>{
  const a=await boot();
  assert.equal((await writer(a,FAMILIES[0],'shared')).reason,'preview_writer_recorded');
  const snapshot=a.indexedDB.dump(DB);
  assert.equal((await writer(a,FAMILIES[1],'shared')).reason,
    'fence_writer_family_mismatch');
  const inspect=await a.api.rehearsePreviewDurableWriterFence(
    'inspect_marker',{marker:'shared',writerFamily:FAMILIES[1]});
  assert.equal(inspect.reason,'fence_writer_family_mismatch');
  const matching=await a.api.rehearsePreviewDurableWriterFence(
    'inspect_marker',{marker:'shared',writerFamily:FAMILIES[0]});
  assert.equal(matching.reason,'preview_writer_marker_present');
  assert.equal(matching.recordedWriterFamily,FAMILIES[0]);
  assert.equal(matching.previewFamilyClaimMatched,true);
  const replay=await writer(a,FAMILIES[0],'shared');
  assert.equal(replay.reason,'preview_writer_replayed',JSON.stringify(replay));
  assert.deepEqual(a.indexedDB.dump(DB),snapshot);
});
test('tampering a stored writer family blocks audit, further writers and freeze',async()=>{
  const a=await boot();
  assert.equal((await writer(a,FAMILIES[0],'original')).reason,'preview_writer_recorded');
  const store=a.indexedDB._databases.get(DB)._stores.get('control');
  const saved=store.get('writer_marker:original');
  store.set(saved.id,{...saved,writerFamily:'unregistered_legacy_route'});
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.reason,'fence_writer_inventory_inconsistent',JSON.stringify(audit));
  const freeze=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(freeze.reason,'fence_writer_inventory_inconsistent');
  const attempted=await writer(a,FAMILIES[1],'blocked');
  assert.equal(attempted.reason,'fence_writer_inventory_inconsistent');
  // Fake readwrite transactions replace their backing Map on completion.
  // The stale Map from before the refused freeze is not the active store.
  a.indexedDB._databases.get(DB)._stores.get('control').set(saved.id,saved);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('audit')).reason,
    'preview_writer_inventory_consistent');
});
test('representatives do not block an uncooperative old tab or grant authority',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'recognized-'+i)).reason,'preview_writer_recorded');
  const frozen=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(frozen.reason,'preview_fence_frozen');
  a.localStorage.setItem(V1,JSON.stringify({
    habits:[],completions:[],tasks:[{id:'old-tab-wrote-after-freeze'}]
  }));
  a.localStorage.setItem('taskpoints_today_view_v1','{"version":1}');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks.length,1);
  const cutover=await a.api.inspectAuthorityCutoverBarriers();
  assert.equal(cutover.canPromote,false);
  assert.equal(cutover.checks.allLegacyWritersFenced,false);
  assert.equal(cutover.checks.productionWriterAdmissionComplete,false);
});
test('invalid family and disabled preview hosts fail before writing any markers',async()=>{
  const a=await boot(),before=a.indexedDB.dump(DB);
  const invalid=await writer(a,'unknown_dynamic_save_path','invalid');
  assert.equal(invalid.reason,'preview_writer_family_invalid');
  assert.deepEqual(a.indexedDB.dump(DB),before);
  a.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await writer(a,FAMILIES[0],'production')).reason,'preview_host_required');
  a.ctx.location.hostname='localhost';
  a.localStorage.removeItem(DARK);
  assert.equal((await writer(a,FAMILIES[0],'dark')).reason,'dark_disabled');
});

test('post-commit old-tab save makes writer acknowledgment uncertain, not clean',async()=>{
  const a=await boot();
  await a.api.rehearsePreviewDurableWriterFence('read');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  const changed=JSON.stringify({habits:[],completions:[],tasks:[
    {id:'old-tab-after-commit'}]});
  let injected=false;
  db.transaction=(stores,mode)=>{
    const tx=original(stores,mode);
    if(mode==='readwrite'&&!injected){
      const commit=tx._commit.bind(tx);
      tx._commit=()=>{
        commit();
        injected=true;
        a.localStorage.setItem(V1,changed);
      };
    }
    return tx;
  };
  const attempt=await writer(a,FAMILIES[0],'committed-before-old-tab');
  assert.equal(injected,true);
  assert.equal(attempt.reason,
    'preview_writer_family_origin_changed_after_transaction',JSON.stringify(attempt));
  assert.equal(attempt.canPromote,false);
  assert.equal(attempt.durableMarkerMayExist,true);
  assert.equal(attempt.inspectMarkerBeforeRetry,true);
  assert.equal(attempt.fence.writersCommitted,1);
  const marker=await a.api.rehearsePreviewDurableWriterFence('inspect_marker',{
    marker:'committed-before-old-tab',writerFamily:FAMILIES[0]});
  assert.equal(marker.reason,'preview_writer_marker_present');
  assert.equal(a.localStorage.getItem(V1),changed);
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.syntheticFamilyOriginMatchesCurrent,false);
  assert.equal(audit.productionWritersFenced,false);
});

test('post-commit unreadable source cannot produce clean writer acknowledgment',async()=>{
  const a=await boot();
  await a.api.rehearsePreviewDurableWriterFence('read');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  const normalGet=a.localStorage.getItem.bind(a.localStorage);
  let makeUnreadable=false;
  a.localStorage.getItem=(key)=>{
    if(makeUnreadable)throw Error('old-tab-storage-access-denied');
    return normalGet(key);
  };
  db.transaction=(stores,mode)=>{
    const tx=original(stores,mode);
    if(mode==='readwrite'){
      const commit=tx._commit.bind(tx);
      tx._commit=()=>{commit();makeUnreadable=true;};
    }
    return tx;
  };
  const attempt=await writer(a,FAMILIES[1],'source-unreadable-after-commit');
  assert.equal(attempt.reason,
    'preview_writer_family_origin_unreadable_after_transaction');
  assert.equal(attempt.inspectMarkerBeforeRetry,true);
  assert.equal(attempt.durableMarkerMayExist,true);
  assert.equal(attempt.canPromote,false);
  makeUnreadable=false;
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('inspect_marker',{
    marker:'source-unreadable-after-commit',writerFamily:FAMILIES[1]
  })).reason,'preview_writer_marker_present');
});

test('independent old tab modifying V1 during admission prevents an atomic family marker',async()=>{
  const a=await boot();
  // Open the preview fence first, so the competing old-tab write can be
  // triggered after the initial origin token check, at IDB transaction entry.
  await a.api.rehearsePreviewDurableWriterFence('read');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  const token=a.token();
  let injected=false;
  db.transaction=(stores,mode)=>{
    if(!injected&&mode==='readwrite'){
      injected=true;
      a.localStorage.setItem('taskpoints_today_view_v1',
        '{"version":1,"notesByDay":{"2026-11-07":[]}}');
    }
    return original(stores,mode);
  };
  const r=await writer(a,FAMILIES[3],'old-tab-race',{fullOriginToken:token});
  assert.equal(injected,true);
  assert.equal(r.reason,'preview_writer_family_origin_stale',JSON.stringify(r));
  const fence=await a.api.rehearsePreviewDurableWriterFence('read');
  assert.equal(fence.fence.writersCommitted,0);
  assert.equal(a.indexedDB.dump(DB).control.some(row=>
    row.id==='writer_marker:old-tab-race'),false);
  assert.match(a.localStorage.getItem('taskpoints_today_view_v1'),
    /notesByDay/);
});

test('nine family claims from different V1 revisions cannot authorize strict freeze',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries()){
    if(i===5)a.localStorage.setItem('tp_projects_v1','[{"id":"old-tab-edit"}]');
    assert.equal((await writer(a,family,'split-'+i)).reason,
      'preview_writer_recorded');
  }
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.syntheticFamilyInventoryComplete,true);
  assert.equal(audit.syntheticFamilyOriginConsistent,false);
  const frozen=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true
  });
  assert.equal(frozen.reason,'preview_writer_families_origin_diverged',
    JSON.stringify(frozen));
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,false);
});

test('post-commit old-tab write makes strict freeze acknowledgment uncertain',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'postfreeze-family-'+i)).reason,
      'preview_writer_recorded');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  const changed='[{"id":"old-tab-wrote-after-freeze-commit"}]';
  let injected=false;
  db.transaction=(stores,mode)=>{
    const tx=original(stores,mode);
    if(mode==='readwrite'&&!injected){
      const commit=tx._commit.bind(tx);
      tx._commit=()=>{
        commit();
        injected=true;
        a.localStorage.setItem('tp_projects_v1',changed);
      };
    }
    return tx;
  };
  const result=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(injected,true);
  assert.equal(result.reason,
    'preview_writer_family_freeze_origin_changed_after_transaction',
    JSON.stringify(result));
  assert.equal(result.canPromote,false);
  assert.equal(result.fenceMayAlreadyBeFrozen,true);
  assert.equal(result.inspectFenceBeforeRetry,true);
  assert.equal(result.fence.frozen,true);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,true);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),changed);
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.syntheticFamilyOriginMatchesCurrent,false);
  assert.equal(audit.productionWritersFenced,false);
});

test('unreadable V1 after committed strict freeze never reports clean success',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'unreadable-family-'+i)).reason,
      'preview_writer_recorded');
  const db=a.indexedDB._databases.get(DB),original=db.transaction.bind(db);
  const normalRead=a.localStorage.getItem.bind(a.localStorage);
  let unreadable=false;
  a.localStorage.getItem=key=>{
    if(unreadable)throw Error('source-now-unreadable');
    return normalRead(key);
  };
  db.transaction=(stores,mode)=>{
    const tx=original(stores,mode);
    if(mode==='readwrite'){
      const commit=tx._commit.bind(tx);
      tx._commit=()=>{commit();unreadable=true;};
    }
    return tx;
  };
  const result=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(result.reason,
    'preview_writer_family_freeze_origin_unreadable_after_transaction');
  assert.equal(result.canPromote,false);
  assert.equal(result.inspectFenceBeforeRetry,true);
  assert.equal(result.fenceMayAlreadyBeFrozen,true);
  unreadable=false;
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,true);
});

test('strict preview freeze retains its V1 source seal across reload and detects drift',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'durable-seal-'+i)).reason,
      'preview_writer_recorded');
  const frozen=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true});
  assert.equal(frozen.reason,'preview_fence_frozen',JSON.stringify(frozen));
  const baseline=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(baseline.reason,'preview_writer_inventory_consistent');
  assert.equal(baseline.strictFreezeSourceSealed,true);
  assert.equal(baseline.strictFreezeSourceMatchesCurrent,true);
  const stored=a.indexedDB._databases.get(DB)._stores.get('control')
    .get('writer_fence');
  assert.match(stored.strictFreezeSourceFingerprint,
    /^sha256:[a-f0-9]{64}:\d+$/);
  const reloaded=await boot({localStorage:a.localStorage,indexedDB:a.indexedDB});
  const afterReload=await reloaded.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(afterReload.strictFreezeSourceSealed,true);
  assert.equal(afterReload.strictFreezeSourceMatchesCurrent,true);
  a.localStorage.setItem('tp_projects_v1','[{"id":"older-tab-after-reload"}]');
  const drift=await reloaded.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(drift.reason,'preview_writer_inventory_consistent');
  assert.equal(drift.strictFreezeSourceSealed,true);
  assert.equal(drift.strictFreezeSourceMatchesCurrent,false);
  assert.equal(drift.productionWritersFenced,false);
  assert.equal(drift.canPromote,false);
});

test('tampered durable strict-freeze seal fails closed without repairing stored evidence',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'seal-tamper-'+i)).reason,
      'preview_writer_recorded');
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true})).reason,'preview_fence_frozen');
  const db=a.indexedDB._databases.get(DB),store=db._stores.get('control');
  const existing=store.get('writer_fence');
  const tampered={...existing,
    strictFreezeSourceFingerprint:'sha256:'+('0'.repeat(64))+':123'};
  store.set('writer_fence',tampered);
  const denied=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(denied.reason,'fence_writer_inventory_inconsistent',
    JSON.stringify(denied));
  assert.equal(denied.canPromote,false);
  assert.equal(db._stores.get('control').get('writer_fence')
    .strictFreezeSourceFingerprint,tampered.strictFreezeSourceFingerprint);
});

test('older non-strict freezes remain readable without manufacturing a source seal',async()=>{
  const a=await boot();
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0})).reason,'preview_fence_frozen');
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.reason,'preview_writer_inventory_consistent');
  assert.equal(audit.strictFreezeSourceSealed,false);
  assert.equal(audit.strictFreezeSourceMatchesCurrent,null);
  assert.equal(audit.canPromote,false);
});

test('old tab changing source after all nine admissions refuses strict freeze',async()=>{
  const a=await boot();
  for(const [i,family] of FAMILIES.entries())
    assert.equal((await writer(a,family,'same-source-'+i)).reason,
      'preview_writer_recorded');
  a.localStorage.setItem('taskpoints_notes_v1','old-tab-edit');
  const denied=await a.api.rehearsePreviewDurableWriterFence('freeze',{
    expectedEpoch:0,requireAllKnownFamilies:true
  });
  assert.equal(denied.reason,'preview_writer_families_origin_diverged',
    JSON.stringify(denied));
  assert.equal(denied.canPromote,false);
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('read'))
    .fence.frozen,false);
});

test('legacy unbound family markers remain inspectable but cannot complete strict roster',async()=>{
  const a=await boot();
  assert.equal((await writer(a,FAMILIES[0],'old-format')).reason,
    'preview_writer_recorded');
  const db=a.indexedDB._databases.get(DB);
  const store=db._stores.get('control'),old=store.get('writer_marker:old-format');
  const legacy={...old};delete legacy.originFingerprint;
  store.set(old.id,legacy);
  const audit=await a.api.rehearsePreviewDurableWriterFence('audit');
  assert.equal(audit.reason,'preview_writer_inventory_consistent',JSON.stringify(audit));
  assert.equal(audit.previewWriterFamilyCounts[FAMILIES[0]],1);
  assert.ok(audit.missingObservedFamilies.includes(FAMILIES[0]));
  assert.equal(audit.syntheticFamilyInventoryComplete,false);
  const marker=await a.api.rehearsePreviewDurableWriterFence('inspect_marker',{
    marker:'old-format',writerFamily:FAMILIES[0]});
  assert.equal(marker.reason,'preview_writer_marker_present');
  assert.equal(marker.recordedOriginFingerprint,null);
});

test('corrupted family source digest fails closed instead of admitting another family',async()=>{
  const a=await boot();
  assert.equal((await writer(a,FAMILIES[0],'sealed')).reason,
    'preview_writer_recorded');
  const store=a.indexedDB._databases.get(DB)._stores.get('control');
  const marker=store.get('writer_marker:sealed');
  store.set(marker.id,{...marker,originFingerprint:'invalid'});
  assert.equal((await a.api.rehearsePreviewDurableWriterFence('audit')).reason,
    'fence_writer_inventory_inconsistent');
  assert.equal((await writer(a,FAMILIES[1],'next')).reason,
    'fence_writer_inventory_inconsistent');
});
