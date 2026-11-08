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
