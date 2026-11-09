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
    addEventListener:opts.addEventListener,
    removeEventListener:opts.removeEventListener,
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


test('read-only completion evidence verifies a synced snapshot without clearing dirty',async()=>{
  const a=await boot();
  await stage(a,'complete-proof','short');
  const before=a.token(),raw=a.localStorage.getItem(V1);
  const unsynced=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    before,'complete-proof');
  assert.equal(unsynced.completionPointInTimeVerified,false);
  assert.equal(unsynced.reason,'notes_completion_not_synchronized',
    JSON.stringify(unsynced));
  assert.equal(unsynced.dirtyMarkerRetained,true);
  const sync=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'complete-proof');
  assert.equal(sync.notesSnapshotSynchronized,true,JSON.stringify(sync));
  const updated=a.token(),seal=a.localStorage.getItem(INTENT);
  const proved=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    updated,'complete-proof');
  assert.equal(proved.reason,'notes_snapshot_completion_point_in_time_observed',
    JSON.stringify(proved));
  assert.equal(proved.completionPointInTimeVerified,true);
  assert.equal(proved.snapshotAndCacheMatchIntent,true);
  assert.equal(proved.dirtyMarkerRetained,true);
  assert.equal(proved.safeToClearDirtyMarker,false);
  assert.equal(proved.missedStorageEventsRuledOut,false);
  assert.equal(proved.oldTabsExcluded,false);
  assert.equal(proved.notesMultiKeySyncVerified,false);
  assert.equal(proved.confirmedNotesDurable,false);
  assert.equal(proved.canPromote,false);
  assert.equal(a.token(),updated,'audit must never edit the origin');
  assert.equal(a.localStorage.getItem(INTENT),seal);
  assert.notEqual(raw,a.localStorage.getItem(V1));
  const reloaded=await boot({
    localStorage:a.localStorage,indexedDB:a.indexedDB
  });
  const later=await reloaded.api.inspectPreviewNotesSnapshotCompletionEvidence(
    reloaded.token(),'complete-proof');
  assert.equal(later.completionPointInTimeVerified,true,JSON.stringify(later));
  assert.equal(reloaded.localStorage.getItem(DIRTY),'1');
});

test('completion evidence detects older-tab snapshot overwrite and refuses clean marker',async()=>{
  const a=await boot();
  await stage(a,'postwrite-overwrite','new');
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'postwrite-overwrite')).notesSnapshotSynchronized,true);
  const cleanToken=a.token();
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.notes='Older tab restored long Notes';
  state.tasks.push({id:'t2',title:'Newer task from older tab'});
  a.localStorage.setItem(V1,JSON.stringify(state));
  const stale=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    cleanToken,'postwrite-overwrite');
  assert.equal(stale.reason,'notes_completion_origin_changed');
  const updated=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'postwrite-overwrite');
  assert.equal(updated.completionPointInTimeVerified,false);
  assert.equal(updated.snapshotAndCacheMatchIntent,false);
  assert.equal(updated.safeToClearDirtyMarker,false);
  assert.equal(updated.oldTabsExcluded,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,'t2');
});

test('completion evidence refuses wrong action, corrupted signed intent, and marker clearing',async()=>{
  const a=await boot();
  await stage(a,'sealed-proof','');
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'sealed-proof')).notesSnapshotSynchronized,true);
  const wrong=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'incorrect-action');
  assert.equal(wrong.completionPointInTimeVerified,false);
  assert.equal(wrong.safeToClearDirtyMarker,false);
  const sealed=a.localStorage.getItem(INTENT);
  a.localStorage.setItem(INTENT,
    sealed.replace('"text":""','"text":"tampered"'));
  const tampered=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'sealed-proof');
  assert.equal(tampered.reason,'notes_completion_intent_unverified');
  a.localStorage.setItem(INTENT,sealed);
  a.localStorage.removeItem(DIRTY);
  const cleaned=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'sealed-proof');
  assert.equal(cleaned.completionPointInTimeVerified,false);
  assert.equal(cleaned.dirtyMarkerRetained,false);
  assert.equal(cleaned.safeToClearDirtyMarker,false);
});

test('completion evidence refuses a frozen writer fence and production host',async()=>{
  const a=await boot();
  await stage(a,'fence-proof','short');
  await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'fence-proof');
  a.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'fence-proof')).reason,'preview_host_required');
  a.ctx.location.hostname='localhost';
  await a.api.rehearsePreviewDurableWriterFence('freeze',{expectedEpoch:0});
  const refused=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'fence-proof');
  assert.equal(refused.reason,'notes_completion_fence_unverified_or_frozen');
  assert.equal(refused.canPromote,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('page-lifetime storage witness denies clean completion after observed external event',async()=>{
  const listeners=new Map();
  const on=(name,handler)=>{
    if(!listeners.has(name))listeners.set(name,new Set());
    listeners.get(name).add(handler);
  };
  const off=(name,handler)=>listeners.get(name)?.delete(handler);
  const a=await boot({addEventListener:on,removeEventListener:off});
  await stage(a,'witness-proof','short');
  await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'witness-proof');
  const start=await a.api.beginPreviewLegacyStorageEventWitness(a.token());
  assert.equal(start.observing,true,JSON.stringify(start));
  const before=a.token();
  for(const cb of listeners.get('storage')||[])cb({key:CACHE});
  const verdict=await a.api.inspectPreviewNotesSnapshotCompletionEvidence(
    a.token(),'witness-proof');
  assert.equal(verdict.completionPointInTimeVerified,false);
  assert.equal(verdict.externalStorageEventsObserved,true);
  assert.equal(verdict.reason,'notes_completion_external_storage_event_observed');
  assert.equal(a.token(),before);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  a.api.stopPreviewLegacyStorageEventWitness();
});


async function signedFingerprint(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const raw=await webcrypto.subtle.digest('SHA-256',bytes);
  return 'sha256:'+Array.from(new Uint8Array(raw),b=>
    b.toString(16).padStart(2,'0')).join('')+':'+bytes.byteLength;
}

test('Notes first-edit intent seals exact original V1 snapshot bytes',async()=>{
  const a=await boot();
  const original=a.localStorage.getItem(V1);
  const intent=await a.api.rehearsePreviewNotesFirstEditIntent(
    'tiny',a.token(),'snapshot-bound');
  assert.equal(intent.intentRecorded,true,JSON.stringify(intent));
  const sealed=JSON.parse(a.localStorage.getItem(INTENT));
  assert.equal(sealed.schemaVersion,2);
  assert.equal(sealed.snapshotFingerprint,await signedFingerprint(original));
  assert.equal((await a.api.inspectPreviewNotesFirstEditIntent())
    .intentEvidenceVerified,true);
  assert.equal(a.localStorage.getItem(V1),original);
});

test('old tab cannot overwrite a newly changed Task with a refreshed snapshot token',async()=>{
  const a=await boot();
  await stage(a,'older-tab-task','short');
  const sealed=a.localStorage.getItem(INTENT);
  const updated=JSON.parse(a.localStorage.getItem(V1));
  updated.tasks.push({id:'newer-task',title:'Changed in old tab'});
  a.localStorage.setItem(V1,JSON.stringify(updated));
  const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'older-tab-task');
  assert.equal(denied.reason,'snapshot_sync_original_snapshot_changed',
    JSON.stringify(denied));
  assert.equal(denied.notesSnapshotSynchronized,false);
  assert.equal(denied.snapshotWriteAttempted,false);
  assert.equal(denied.safeToClearDirtyMarker,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem(INTENT),sealed);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(CACHE),'short');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,'newer-task');
});

test('old tab changing Notes snapshot cannot be hidden by a freshly recaptured token',async()=>{
  const a=await boot();
  await stage(a,'older-tab-notes','tiny');
  const other=JSON.parse(a.localStorage.getItem(V1));
  other.notes='Someone else edited the snapshot';
  a.localStorage.setItem(V1,JSON.stringify(other));
  const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'older-tab-notes');
  assert.equal(denied.reason,'snapshot_sync_original_snapshot_changed');
  assert.equal(denied.notesSnapshotSynchronized,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).notes,other.notes);
});

test('legacy v1 signed intent remains inspectable but cannot sync without baseline attestation',async()=>{
  const a=await boot();
  await stage(a,'old-seal','tiny');
  const original=JSON.parse(a.localStorage.getItem(INTENT));
  const {integrityFingerprint,snapshotFingerprint,...v1}=original;
  v1.schemaVersion=1;
  const legacySeal=JSON.stringify({...v1,
    integrityFingerprint:await signedFingerprint(v1)});
  a.localStorage.setItem(INTENT,legacySeal);
  const observed=await a.api.inspectPreviewNotesFirstEditIntent();
  assert.equal(observed.intentEvidenceVerified,true,JSON.stringify(observed));
  assert.equal(observed.notesCacheMatchesIntent,true);
  const previous=a.localStorage.getItem(V1);
  const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'old-seal');
  assert.equal(denied.reason,'snapshot_sync_baseline_attestation_required',
    JSON.stringify(denied));
  assert.equal(denied.snapshotWriteAttempted,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),previous);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});


test('noncanonical snapshot bytes are refused without rewriting unrelated legacy data',async()=>{
  const original=JSON.stringify(legacy());
  const altered=[
    {kind:'pretty-printed snapshot',raw:JSON.stringify(legacy(),null,2)},
    {kind:'duplicate JSON keys',
      raw:original.slice(0,-1)+',"unknownExtra":"first","unknownExtra":"second"}'},
    {kind:'escaped Unicode text',raw:original.replace('Walk','\\u0057alk')},
    {kind:'precision-losing numeric token',
      raw:original.slice(0,-1)+',"unrelatedPrecision":9007199254740993}'}
  ];
  for(const {kind,raw} of altered){
    const a=await boot();
    a.localStorage.setItem(V1,raw);
    const beforeIdb=a.indexedDB.dump('taskpoints_state_v2');
    const action='noncanonical-'+altered.indexOf(altered.find(x=>x.kind===kind));
    await stage(a,action,'short');
    const sealed=a.localStorage.getItem(INTENT);
    const before=a.token();
    const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
      before,action);
    assert.equal(denied.reason,'snapshot_sync_noncanonical_legacy_json',
      kind+': '+JSON.stringify(denied));
    assert.equal(denied.snapshotWriteAttempted,false,kind);
    assert.equal(denied.notesSnapshotSynchronized,false,kind);
    assert.equal(denied.safeToClearDirtyMarker,false,kind);
    assert.equal(denied.canPromote,false,kind);
    assert.equal(a.localStorage.getItem(V1),raw,kind);
    assert.equal(a.localStorage.getItem(INTENT),sealed,kind);
    assert.equal(a.localStorage.getItem(DIRTY),'1',kind);
    assert.equal(a.localStorage.getItem(CACHE),'short',kind);
    assert.equal(a.token(),before,kind);
    assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),beforeIdb,kind);
  }
});


async function witnessBoot(){
  const handlers=new Map();
  const on=(event,callback)=>{
    if(!handlers.has(event))handlers.set(event,new Set());
    handlers.get(event).add(callback);
  };
  const off=(event,callback)=>handlers.get(event)?.delete(callback);
  const a=await boot({addEventListener:on,removeEventListener:off});
  const signal=(key='tp_projects_v1')=>{
    for(const handler of handlers.get('storage')||[])handler({key});
  };
  return {...a,signal};
}

test('transient external-tab event blocks Notes first intent and cache writes',async()=>{
  const intentApp=await witnessBoot();
  const prior=intentApp.token();
  const started=await intentApp.api.beginPreviewLegacyStorageEventWitness(prior);
  assert.equal(started.observing,true,JSON.stringify(started));
  intentApp.localStorage.setItem('tp_projects_v1','ephemeral');
  intentApp.localStorage.removeItem('tp_projects_v1');
  assert.equal(intentApp.token(),prior);
  intentApp.signal();
  const blocked=await intentApp.api.rehearsePreviewNotesFirstEditIntent(
    'short',intentApp.token(),'intent-transient');
  assert.equal(blocked.reason,'notes_first_edit_external_tab_event_observed',
    JSON.stringify(blocked));
  assert.equal(intentApp.localStorage.getItem(INTENT),null);
  assert.equal(intentApp.localStorage.getItem(DIRTY),null);
  assert.equal(intentApp.api.stopPreviewLegacyStorageEventWitness().stopped,true);

  const cacheApp=await witnessBoot();
  const recorded=await cacheApp.api.rehearsePreviewNotesFirstEditIntent(
    'short',cacheApp.token(),'cache-transient');
  assert.equal(recorded.intentRecorded,true,JSON.stringify(recorded));
  const sealed=cacheApp.localStorage.getItem(INTENT);
  const raw=cacheApp.localStorage.getItem(V1);
  assert.equal((await cacheApp.api.beginPreviewLegacyStorageEventWitness(
    cacheApp.token())).observing,true);
  cacheApp.signal();
  const blockedCache=await cacheApp.api
    .rehearsePreviewAdmittedNotesFirstEditCacheWrite(
      cacheApp.token(),'cache-transient');
  assert.equal(blockedCache.reason,'first_edit_external_tab_event_observed',
    JSON.stringify(blockedCache));
  assert.equal(blockedCache.firstEditApplied,false);
  assert.equal(cacheApp.localStorage.getItem(V1),raw);
  assert.equal(cacheApp.localStorage.getItem(INTENT),sealed);
  assert.equal(cacheApp.localStorage.getItem(AUTH),null);
  assert.equal(cacheApp.localStorage.getItem(DIRTY),null);
  cacheApp.api.stopPreviewLegacyStorageEventWitness();
});

test('transient external-tab event blocks snapshot despite restored full-origin token',async()=>{
  const a=await witnessBoot();
  const original=await stage(a,'sync-transient','tiny');
  const signed=a.localStorage.getItem(INTENT);
  const token=a.token();
  const begin=await a.api.beginPreviewLegacyStorageEventWitness(token);
  assert.equal(begin.observing,true,JSON.stringify(begin));
  a.localStorage.setItem('tp_projects_v1','temporary old-tab value');
  a.localStorage.removeItem('tp_projects_v1');
  a.signal();
  a.signal();
  assert.equal(a.token(),token);
  const denied=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    token,'sync-transient');
  assert.equal(denied.reason,'snapshot_sync_external_tab_event_observed',
    JSON.stringify(denied));
  assert.equal(denied.snapshotWriteAttempted,false);
  assert.equal(denied.notesSnapshotSynchronized,false);
  assert.equal(denied.oldTabsExcluded,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),original);
  assert.equal(a.localStorage.getItem(INTENT),signed);
  assert.equal(a.localStorage.getItem(CACHE),'tiny');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.token(),token);
  a.api.stopPreviewLegacyStorageEventWitness();
});

test('event observed during Notes snapshot write remains uncertain, not green',async()=>{
  const a=await witnessBoot();
  await stage(a,'midwrite-event','tiny');
  assert.equal((await a.api.beginPreviewLegacyStorageEventWitness(
    a.token())).observing,true);
  const originalSet=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    const result=originalSet(key,value);
    if(key===V1)a.signal();
    return result;
  };
  const result=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'midwrite-event');
  assert.equal(result.reason,'snapshot_sync_postwrite_fence_changed',
    JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.snapshotWriteAttempted,true);
  assert.equal(result.notesSnapshotSynchronized,false);
  assert.equal(result.safeToClearDirtyMarker,false);
  assert.equal(result.canPromote,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  a.api.stopPreviewLegacyStorageEventWitness();
});
