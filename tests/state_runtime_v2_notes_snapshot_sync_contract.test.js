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
const V1='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1';
const CACHE='taskpoints_notes_v1';
const AUTH='taskpoints_notes_authoritative_v1';
const DIRTY='taskpoints_notes_dirty_v1';
const INTENT='taskpoints_v2_preview_notes_first_edit_intent_v1';
function legacy(){return {
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  tasks:[{id:'t1',title:'Do not lose me'}],completions:[],
  notes:'A much longer original snapshot'
};}
async function boot(opts={}){
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify(legacy())
  });
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  let uuid=0;
  const core={
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw);},
    readPendingHabitDeltas(){return [];},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}};},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1));},
    writePendingHabitDelta(d){return {...d};},
    habitCompletionId(a,b){return 'habit:'+a+':'+b;}
  };
  const ctx={localStorage,indexedDB,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'snapshot-'+(++uuid);}},
    navigator:{locks:{request:async(name,options,callback)=>
      callback({name})}},
    location:{hostname:opts.hostname||'localhost'},
    TaskPointsCore:core,JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  const token=()=>JSON.stringify(Array.from({length:localStorage.length},
    (_,i)=>localStorage.key(i)).sort().map(key=>[key,localStorage.getItem(key)]));
  return {api,localStorage,indexedDB,ctx,token};
}
async function stage(app,id='first-sync',text='short'){
  const snapshotBefore=app.localStorage.getItem(V1);
  const intent=await app.api.rehearsePreviewNotesFirstEditIntent(
    text,app.token(),id);
  assert.equal(intent.intentRecorded,true,JSON.stringify(intent));
  const edit=await app.api.rehearsePreviewAdmittedNotesFirstEditCacheWrite(
    app.token(),id);
  assert.equal(edit.firstEditApplied,true,JSON.stringify(edit));
  assert.equal(app.localStorage.getItem(V1),snapshotBefore);
  return snapshotBefore;
}
test('snapshot continuation synchronizes only Notes in preview and retains dirty + original intent',async()=>{
  const a=await boot();
  const raw=await stage(a);
  const original=JSON.parse(raw);
  const sealed=a.localStorage.getItem(INTENT);
  const before=a.indexedDB.dump('taskpoints_state_v2');
  const result=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync');
  assert.equal(result.reason,'preview_notes_snapshot_written_dirty_retained',
    JSON.stringify(result));
  assert.equal(result.notesSnapshotSynchronized,true);
  assert.equal(result.readbackVerified,true);
  assert.equal(result.dirtyMarkerPreserved,true);
  assert.equal(result.notesMultiKeySyncVerified,false);
  assert.equal(result.confirmedNotesDurable,false);
  assert.equal(result.safeToClearDirtyMarker,false);
  assert.equal(result.oldTabsExcluded,false);
  assert.equal(result.canPromote,false);
  const snapshot=JSON.parse(a.localStorage.getItem(V1));
  assert.equal(snapshot.notes,'short');
  assert.deepEqual({...snapshot,notes:original.notes},original);
  assert.equal(a.localStorage.getItem(CACHE),'short');
  assert.equal(a.localStorage.getItem(AUTH),'1');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(INTENT),sealed);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),before);
  const inspected=await a.api.inspectPreviewNotesFirstEditIntent();
  assert.equal(inspected.observedRecoveryStage,'snapshot_synced_dirty_pending');
  const again=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync');
  assert.equal(again.notesSnapshotSynchronized,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('snapshot continuation refuses an incomplete first edit, wrong action and stale origin',async()=>{
  const a=await boot();
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'missing')).notesSnapshotSynchronized,false);
  await stage(a);
  const before=a.localStorage.getItem(V1),token=a.token();
  const wrong=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    token,'different');
  assert.equal(wrong.reason,'snapshot_sync_unverified_or_incompatible_snapshot');
  assert.equal(a.localStorage.getItem(V1),before);
  a.localStorage.setItem(CACHE,'older tab replaces cache');
  const stale=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    token,'first-sync');
  assert.equal(stale.reason,'snapshot_sync_origin_changed');
  assert.equal(a.localStorage.getItem(V1),before);
});

test('snapshot quota denial does not clear dirty or erase intent',async()=>{
  const a=await boot();
  const raw=await stage(a),sealed=a.localStorage.getItem(INTENT);
  const originalSet=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    if(key===V1)throw Error('QuotaExceededError');
    return originalSet(key,value);
  };
  const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync');
  assert.equal(denied.reason,'snapshot_sync_write_uncertain',JSON.stringify(denied));
  assert.equal(denied.writeOutcomeUncertain,true);
  assert.equal(denied.inspectIntentBeforeRetry,true);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),raw);
  assert.equal(a.localStorage.getItem(INTENT),sealed);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('old-tab write during snapshot storage action is detected and never silently discarded',async()=>{
  const a=await boot();
  await stage(a);
  const originalSet=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    const r=originalSet(key,value);
    if(key===V1)originalSet('tp_projects_v1','newer older-tab project');
    return r;
  };
  const result=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync');
  assert.equal(result.reason,'snapshot_sync_readback_or_origin_changed',
    JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.notesMultiKeySyncVerified,false);
  assert.equal(result.canPromote,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    'newer older-tab project');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('snapshot continuation refuses production hosts and frozen preview fence',async()=>{
  const a=await boot();
  await stage(a);
  const raw=a.localStorage.getItem(V1);
  a.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync')).reason,'preview_host_required');
  a.ctx.location.hostname='localhost';
  const frozen=await a.api.rehearsePreviewDurableWriterFence(
    'freeze',{expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen');
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync')).reason,
    'snapshot_sync_fence_unverified_or_frozen');
  assert.equal(a.localStorage.getItem(V1),raw);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('snapshot continuation refuses non-JSON legacy payload instead of rewriting its codec',async()=>{
  const a=await boot();
  await stage(a);
  a.localStorage.setItem(V1,'TPZ1:unhandled-compressed');
  const previous=a.localStorage.getItem(V1);
  const denial=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'first-sync');
  assert.equal(denial.notesSnapshotSynchronized,false);
  assert.equal(denial.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),previous);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});
