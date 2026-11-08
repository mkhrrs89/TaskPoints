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
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'family-test'}} ,
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
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
  store.set(saved.id,saved);
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
