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


const FOLLOWUP_INTENT='taskpoints_v2_preview_notes_followup_intent_v1';
async function syncedFirstEdit(a,id='first-sealed'){
  await stage(a,id,'initial');
  const result=await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),id);
  assert.equal(result.notesSnapshotSynchronized,true,JSON.stringify(result));
}

test('sealed Notes follow-up intent safely stages a second edit after first snapshot sync',async()=>{
  const a=await boot();
  await syncedFirstEdit(a);
  const previous=a.localStorage.getItem(V1);
  const firstIntent=a.localStorage.getItem(INTENT);
  const priorDb=a.indexedDB.dump('taskpoints_state_v2');
  const proposed=await a.api.rehearsePreviewNotesFollowupIntent(
    'another text',a.token(),'followup-save-1');
  assert.equal(proposed.reason,'preview_notes_followup_intent_recorded',
    JSON.stringify(proposed));
  assert.equal(proposed.intentRecorded,true);
  assert.equal(proposed.canPromote,false);
  assert.equal(a.localStorage.getItem(CACHE),'initial');
  assert.equal(a.localStorage.getItem(V1),previous);
  assert.equal(a.localStorage.getItem(INTENT),firstIntent);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  const sealed=a.localStorage.getItem(FOLLOWUP_INTENT);
  const record=JSON.parse(sealed);
  assert.equal(record.schemaVersion,1);
  assert.equal(record.actionId,'followup-save-1');
  assert.equal(record.firstActionId,'first-sealed');
  assert.equal(record.snapshotFingerprint,
    await signedFingerprint(previous));
  assert.equal(record.cacheFingerprint,
    await signedFingerprint('initial'));
  const observed=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(observed.intentEvidenceVerified,true,JSON.stringify(observed));
  assert.equal(observed.observedRecoveryStage,
    'followup_intent_recorded_cache_pending');
  const cache=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'followup-save-1');
  assert.equal(cache.reason,
    'preview_notes_followup_cache_written_dirty_retained',
    JSON.stringify(cache));
  assert.equal(cache.cacheReadbackVerified,true);
  assert.equal(cache.dirtyMarkerPreserved,true);
  assert.equal(cache.confirmedNotesDurable,false);
  assert.equal(cache.safeToClearDirtyMarker,false);
  assert.equal(cache.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),previous);
  assert.equal(a.localStorage.getItem(CACHE),'another text');
  assert.equal(a.localStorage.getItem(AUTH),'1');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(INTENT),firstIntent);
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),sealed);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),priorDb);
  const pending=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(pending.intentEvidenceVerified,true);
  assert.equal(pending.cacheMatchesIntent,true);
  assert.equal(pending.snapshotMatchesIntent,false);
  assert.equal(pending.legacySelectsIntendedText,true);
  assert.equal(pending.observedRecoveryStage,
    'followup_cache_written_snapshot_pending');
  assert.equal(pending.canPromote,false);
  const restarted=await boot({
    localStorage:a.localStorage,indexedDB:a.indexedDB});
  const afterRestart=await restarted.api.inspectPreviewNotesFollowupIntent();
  assert.equal(afterRestart.intentEvidenceVerified,true);
  assert.equal(afterRestart.observedRecoveryStage,
    'followup_cache_written_snapshot_pending');
  assert.equal(restarted.localStorage.getItem(DIRTY),'1');
  const repeated=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'followup-save-1');
  assert.equal(repeated.cacheReadbackVerified,false);
  assert.equal(a.localStorage.getItem(V1),previous);
});

test('follow-up cannot begin before initial Notes snapshot sync or overwrite a pending follow-up',async()=>{
  const a=await boot();
  await stage(a,'pre-sync','first');
  const premature=await a.api.rehearsePreviewNotesFollowupIntent(
    'second',a.token(),'second-early');
  assert.equal(premature.reason,'followup_first_edit_not_synchronized',
    JSON.stringify(premature));
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),null);
  assert.equal((await a.api.rehearsePreviewAdmittedNotesSnapshotSync(
    a.token(),'pre-sync')).notesSnapshotSynchronized,true);
  assert.equal((await a.api.rehearsePreviewNotesFollowupIntent(
    'second',a.token(),'second-admitted')).intentRecorded,true);
  const signed=a.localStorage.getItem(FOLLOWUP_INTENT);
  const duplicate=await a.api.rehearsePreviewNotesFollowupIntent(
    'third',a.token(),'new-action');
  assert.equal(duplicate.reason,
    'existing_followup_intent_requires_inspection');
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),signed);
  const wrong=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'not-the-signed-action');
  assert.equal(wrong.cacheWriteAttempted,false);
  assert.equal(a.localStorage.getItem(CACHE),'first');
});

test('older tab task write or forged intent blocks follow-up cache without losing Notes',async()=>{
  const a=await boot();
  await syncedFirstEdit(a,'first-a');
  assert.equal((await a.api.rehearsePreviewNotesFollowupIntent(
    'newer',a.token(),'followup-a')).intentRecorded,true);
  const signed=a.localStorage.getItem(FOLLOWUP_INTENT);
  const state=JSON.parse(a.localStorage.getItem(V1));
  state.tasks.push({id:'older-tab-keep',title:'Do not clobber'});
  a.localStorage.setItem(V1,JSON.stringify(state));
  const old=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'followup-a');
  assert.equal(old.cacheWriteAttempted,false);
  assert.equal(old.canPromote,false);
  assert.equal(a.localStorage.getItem(CACHE),'initial');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,
    'older-tab-keep');
  a.localStorage.setItem(FOLLOWUP_INTENT,
    signed.replace('"text":"newer"','"text":"forged"'));
  const forged=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(forged.reason,'followup_intent_integrity_mismatch');
  assert.equal(forged.safeToApply,false);
  assert.equal(forged.canPromote,false);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('follow-up quota denial keeps both sealed intents and dirty recovery flag',async()=>{
  const a=await boot();
  await syncedFirstEdit(a,'first-quota');
  assert.equal((await a.api.rehearsePreviewNotesFollowupIntent(
    'next',a.token(),'followup-quota')).intentRecorded,true);
  const prior=a.localStorage.getItem(V1);
  const followup=a.localStorage.getItem(FOLLOWUP_INTENT);
  const first=a.localStorage.getItem(INTENT);
  const original=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    if(key===CACHE)throw Error('QuotaExceededError');
    return original(key,value);
  };
  const result=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'followup-quota');
  assert.equal(result.reason,'followup_cache_write_uncertain',JSON.stringify(result));
  assert.equal(result.writeOutcomeUncertain,true);
  assert.equal(result.inspectIntentBeforeRetry,true);
  assert.equal(result.canPromote,false);
  assert.equal(a.localStorage.getItem(CACHE),'initial');
  assert.equal(a.localStorage.getItem(V1),prior);
  assert.equal(a.localStorage.getItem(INTENT),first);
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),followup);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('follow-up refuses observed transient old-tab storage event and production origin',async()=>{
  const a=await witnessBoot();
  await syncedFirstEdit(a,'witness-first');
  const result=await a.api.rehearsePreviewNotesFollowupIntent(
    'later',a.token(),'witness-followup');
  assert.equal(result.intentRecorded,true);
  assert.equal((await a.api.beginPreviewLegacyStorageEventWitness(
    a.token())).observing,true);
  const before=a.token();
  a.signal();
  const denied=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'witness-followup');
  assert.equal(denied.reason,'followup_cache_source_changed_before_write',
    JSON.stringify(denied));
  assert.equal(denied.cacheWriteAttempted,false);
  assert.equal(a.token(),before);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  a.api.stopPreviewLegacyStorageEventWitness();
  a.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),'witness-followup')).reason,'preview_host_required');
});


async function stagedFollowup(a,firstId='first-second-sync',secondId='second-sync'){
  await syncedFirstEdit(a,firstId);
  const signed=await a.api.rehearsePreviewNotesFollowupIntent(
    'second',a.token(),secondId);
  assert.equal(signed.intentRecorded,true,JSON.stringify(signed));
  const cached=await a.api.rehearsePreviewAdmittedNotesFollowupCacheWrite(
    a.token(),secondId);
  assert.equal(cached.cacheReadbackVerified,true,JSON.stringify(cached));
}

test('second sealed Notes edit synchronizes snapshot while retaining both intents and dirty marker',async()=>{
  const a=await boot();
  await stagedFollowup(a);
  const first=a.localStorage.getItem(INTENT);
  const followup=a.localStorage.getItem(FOLLOWUP_INTENT);
  const source=a.localStorage.getItem(V1);
  const original=JSON.parse(source);
  const beforeDb=a.indexedDB.dump('taskpoints_state_v2');
  const verdict=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'second-sync');
  assert.equal(verdict.reason,
    'preview_notes_followup_snapshot_written_dirty_retained',
    JSON.stringify(verdict));
  assert.equal(verdict.notesSnapshotSynchronized,true);
  assert.equal(verdict.dirtyMarkerPreserved,true);
  assert.equal(verdict.confirmedNotesDurable,false);
  assert.equal(verdict.oldTabsExcluded,false);
  assert.equal(verdict.safeToClearDirtyMarker,false);
  assert.equal(verdict.canPromote,false);
  const after=JSON.parse(a.localStorage.getItem(V1));
  assert.equal(after.notes,'second');
  assert.deepEqual({...after,notes:original.notes},original);
  assert.equal(a.localStorage.getItem(CACHE),'second');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(AUTH),'1');
  assert.equal(a.localStorage.getItem(INTENT),first);
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),followup);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),beforeDb);
  const inspected=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(inspected.intentEvidenceVerified,true);
  assert.equal(inspected.observedRecoveryStage,
    'followup_snapshot_synced_dirty_pending');
  const reloaded=await boot({
    indexedDB:a.indexedDB,localStorage:a.localStorage});
  assert.equal((await reloaded.api.inspectPreviewNotesFollowupIntent())
    .observedRecoveryStage,'followup_snapshot_synced_dirty_pending');
  const duplicate=await reloaded.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    reloaded.token(),'second-sync');
  assert.equal(duplicate.notesSnapshotSynchronized,false);
  assert.equal(reloaded.localStorage.getItem(DIRTY),'1');
});

test('older tab task changes cannot be blessed with a freshly recaptured token for second snapshot',async()=>{
  const a=await boot();
  await stagedFollowup(a,'first-old','second-old');
  const next=JSON.parse(a.localStorage.getItem(V1));
  next.tasks.push({id:'oldtab-later',title:'Must not lose'});
  a.localStorage.setItem(V1,JSON.stringify(next));
  const signed=a.localStorage.getItem(FOLLOWUP_INTENT);
  const denied=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'second-old');
  assert.equal(denied.reason,'followup_snapshot_original_origin_changed',
    JSON.stringify(denied));
  assert.equal(denied.snapshotWriteAttempted,false);
  assert.equal(denied.canPromote,false);
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,
    'oldtab-later');
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),signed);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(CACHE),'second');
});

test('second Notes snapshot write quota denial never clears dirty or sealed evidence',async()=>{
  const a=await boot();
  await stagedFollowup(a,'quota-first','quota-second');
  const snapshot=a.localStorage.getItem(V1);
  const first=a.localStorage.getItem(INTENT);
  const second=a.localStorage.getItem(FOLLOWUP_INTENT);
  const original=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    if(key===V1)throw Error('QuotaExceededError');
    return original(key,value);
  };
  const refused=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'quota-second');
  assert.equal(refused.reason,'followup_snapshot_write_uncertain',
    JSON.stringify(refused));
  assert.equal(refused.snapshotWriteAttempted,true);
  assert.equal(refused.writeOutcomeUncertain,true);
  assert.equal(refused.confirmedNotesDurable,false);
  assert.equal(refused.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),snapshot);
  assert.equal(a.localStorage.getItem(INTENT),first);
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),second);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(a.localStorage.getItem(CACHE),'second');
});

test('second snapshot refuses witnessed cross-tab event and frozen fence',async()=>{
  const a=await witnessBoot();
  await stagedFollowup(a,'witness-first-sync','witness-second-sync');
  assert.equal((await a.api.beginPreviewLegacyStorageEventWitness(
    a.token())).observing,true);
  const before=a.localStorage.getItem(V1);
  a.signal('tp_projects_v1');
  const denied=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'witness-second-sync');
  assert.equal(denied.reason,'followup_snapshot_origin_or_witness_changed',
    JSON.stringify(denied));
  assert.equal(denied.snapshotWriteAttempted,false);
  assert.equal(a.localStorage.getItem(V1),before);
  a.api.stopPreviewLegacyStorageEventWitness();
  const frozen=await a.api.rehearsePreviewDurableWriterFence(
    'freeze',{expectedEpoch:0});
  assert.equal(frozen.reason,'preview_fence_frozen');
  const again=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'witness-second-sync');
  assert.equal(again.reason,'followup_snapshot_fence_unverified_or_frozen');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('second snapshot refuses noncanonical source without modifying legacy fields',async()=>{
  const a=await boot();
  await stagedFollowup(a,'noncanonical-first','noncanonical-second');
  const state=JSON.parse(a.localStorage.getItem(V1));
  const raw=JSON.stringify(state,null,2);
  a.localStorage.setItem(V1,raw);
  const refused=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'noncanonical-second');
  assert.equal(refused.snapshotWriteAttempted,false);
  assert.equal(refused.canPromote,false);
  assert.equal(a.localStorage.getItem(V1),raw);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});


test('follow-up audit never reports synced dirty after marker loss',async()=>{
  const a=await boot();
  await stagedFollowup(a,'marker-first','marker-second');
  const ok=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'marker-second');
  assert.equal(ok.notesSnapshotSynchronized,true,JSON.stringify(ok));
  a.localStorage.removeItem(DIRTY);
  const missing=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(missing.intentEvidenceVerified,true);
  assert.equal(missing.currentMarkersValid,false);
  assert.equal(missing.observedRecoveryStage,
    'followup_recovery_markers_missing');
  assert.equal(missing.legacySelectsIntendedText,false);
  assert.equal(missing.safeToClearDirtyMarker,false);
  assert.equal(missing.canPromote,false);
  a.localStorage.setItem(DIRTY,'1');
  a.localStorage.removeItem(AUTH);
  const noAuthority=await a.api.inspectPreviewNotesFollowupIntent();
  assert.equal(noAuthority.observedRecoveryStage,
    'followup_recovery_markers_missing');
  assert.equal(noAuthority.canPromote,false);
});


const REPEAT_JOURNAL='taskpoints_v2_preview_notes_repeat_journal_v1';
async function completedTwoNotesEdits(a){
  await stagedFollowup(a,'repeat-first','repeat-second');
  const second=await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'repeat-second');
  assert.equal(second.notesSnapshotSynchronized,true,JSON.stringify(second));
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).notes,'second');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
}
async function repeatSequence(a,id,text){
  const intent=await a.api.rehearsePreviewNotesRepeatEditIntent(
    text,a.token(),id);
  assert.equal(intent.intentRecorded,true,JSON.stringify(intent));
  const cached=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),id);
  assert.equal(cached.cacheReadbackVerified,true,JSON.stringify(cached));
  const synced=await a.api.rehearsePreviewAdmittedNotesRepeatSnapshotSync(
    a.token(),id);
  assert.equal(synced.notesSnapshotSynchronized,true,JSON.stringify(synced));
  return {intent,cached,synced};
}

test('bounded repeat journal handles three sequential Notes edits with sealed previous history',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  const originals={first:a.localStorage.getItem(INTENT),
    second:a.localStorage.getItem(FOLLOWUP_INTENT)};
  const originalState=JSON.parse(a.localStorage.getItem(V1));
  const idbBefore=a.indexedDB.dump('taskpoints_state_v2');
  let expected=0;
  for(const [id,text] of [['repeat-3','third'],
    ['repeat-4','fourth'],['repeat-5','fifth']]){
    const saved=await repeatSequence(a,id,text);
    expected++;
    assert.equal(saved.intent.journalEntryCount,expected);
    assert.equal(saved.synced.canPromote,false);
    assert.equal(saved.synced.safeToClearDirtyMarker,false);
    assert.equal(saved.synced.confirmedNotesDurable,false);
    assert.equal(saved.synced.oldTabsExcluded,false);
    assert.equal(a.localStorage.getItem(INTENT),originals.first);
    assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),originals.second);
    assert.equal(a.localStorage.getItem(CACHE),text);
    assert.equal(a.localStorage.getItem(DIRTY),'1');
    const data=JSON.parse(a.localStorage.getItem(V1));
    assert.equal(data.notes,text);
    assert.deepEqual({...data,notes:originalState.notes},originalState);
    const evidence=await a.api.inspectPreviewNotesRepeatEditJournal();
    assert.equal(evidence.journalEvidenceVerified,true,JSON.stringify(evidence));
    assert.equal(evidence.journalEntryCount,expected);
    assert.equal(evidence.lastActionId,id);
    assert.equal(evidence.observedRecoveryStage,
      'repeat_snapshot_synced_dirty_pending');
  }
  const journal=JSON.parse(a.localStorage.getItem(REPEAT_JOURNAL));
  assert.equal(journal.entries.length,3);
  assert.deepEqual(journal.entries.map(x=>x.actionId),
    ['repeat-3','repeat-4','repeat-5']);
  assert.deepEqual(journal.entries.map(x=>x.previousActionId),
    ['repeat-second','repeat-3','repeat-4']);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),idbBefore);
  const reload=await boot({localStorage:a.localStorage,indexedDB:a.indexedDB});
  const evidence=await reload.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(evidence.journalEvidenceVerified,true,JSON.stringify(evidence));
  assert.equal(evidence.observedRecoveryStage,
    'repeat_snapshot_synced_dirty_pending');
  assert.equal(reload.localStorage.getItem(DIRTY),'1');
});

test('repeat admission refuses incomplete second edit and never appends over an unfinished action',async()=>{
  const a=await boot();
  await stagedFollowup(a,'pending-first','pending-second');
  const denied=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'premature-third');
  assert.equal(denied.intentRecorded,false);
  assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),null);
  await a.api.rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    a.token(),'pending-second');
  const first=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'first-repeat');
  assert.equal(first.intentRecorded,true,JSON.stringify(first));
  const sealed=a.localStorage.getItem(REPEAT_JOURNAL);
  const second=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'fourth',a.token(),'too-early');
  assert.equal(second.intentRecorded,false);
  assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),sealed);
  const wrong=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'different-action');
  assert.equal(wrong.cacheReadbackVerified,false);
  assert.equal(a.localStorage.getItem(CACHE),'second');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat journal reports crash stage after cache write and restart without replay',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  const baseline=a.localStorage.getItem(V1);
  const stored=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third after crash',a.token(),'restarted-repeat');
  assert.equal(stored.intentRecorded,true);
  const intentOnly=await a.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(intentOnly.observedRecoveryStage,
    'repeat_intent_recorded_cache_pending',JSON.stringify(intentOnly));
  const cached=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'restarted-repeat');
  assert.equal(cached.cacheReadbackVerified,true);
  const pending=await a.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(pending.observedRecoveryStage,
    'repeat_cache_written_snapshot_pending',JSON.stringify(pending));
  assert.equal(a.localStorage.getItem(V1),baseline);
  const copy=await boot({localStorage:a.localStorage,indexedDB:a.indexedDB});
  const recovered=await copy.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(recovered.journalEvidenceVerified,true);
  assert.equal(recovered.observedRecoveryStage,
    'repeat_cache_written_snapshot_pending');
  assert.equal(recovered.canAutomaticallyResume,false);
  const duplicate=await copy.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    copy.token(),'restarted-repeat');
  assert.equal(duplicate.cacheReadbackVerified,false);
  assert.equal(copy.localStorage.getItem(DIRTY),'1');
  const synced=await copy.api.rehearsePreviewAdmittedNotesRepeatSnapshotSync(
    copy.token(),'restarted-repeat');
  assert.equal(synced.notesSnapshotSynchronized,true,JSON.stringify(synced));
  assert.equal(JSON.parse(copy.localStorage.getItem(V1)).notes,
    'third after crash');
});

test('repeat journal refuses old tab edits even with fresh full origin token',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'repeat-stale');
  const prior=JSON.parse(a.localStorage.getItem(V1));
  prior.tasks.push({id:'t-old-tab',title:'Preserve old tab task'});
  a.localStorage.setItem(V1,JSON.stringify(prior));
  const blocked=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-stale');
  assert.equal(blocked.reason,'repeat_cache_original_origin_changed',
    JSON.stringify(blocked));
  assert.equal(blocked.writeAttempted,false);
  assert.equal(a.localStorage.getItem(CACHE),'second');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,'t-old-tab');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat snapshot refuses stale origin even if old tab change is retokened after cache write',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'repeat-snap-stale');
  await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-snap-stale');
  const prior=JSON.parse(a.localStorage.getItem(V1));
  prior.tasks.push({id:'old-tab-later',title:'Never overwrite'});
  a.localStorage.setItem(V1,JSON.stringify(prior));
  const result=await a.api.rehearsePreviewAdmittedNotesRepeatSnapshotSync(
    a.token(),'repeat-snap-stale');
  assert.equal(result.reason,'repeat_snapshot_original_origin_changed',
    JSON.stringify(result));
  assert.equal(result.writeAttempted,false);
  assert.equal(result.canPromote,false);
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).tasks[1].id,'old-tab-later');
  assert.equal(a.localStorage.getItem(CACHE),'third');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat journal corruption refuses new writes; existing sealed first and second intents survive',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  const before={first:a.localStorage.getItem(INTENT),
    second:a.localStorage.getItem(FOLLOWUP_INTENT)};
  await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'repeat-tamper');
  const record=JSON.parse(a.localStorage.getItem(REPEAT_JOURNAL));
  record.entries[0].text='forged';
  a.localStorage.setItem(REPEAT_JOURNAL,JSON.stringify(record));
  const evidence=await a.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(evidence.journalEvidenceVerified,undefined,
    JSON.stringify(evidence));
  assert.equal(evidence.canPromote,false);
  const refused=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-tamper');
  assert.equal(refused.cacheReadbackVerified,false);
  assert.equal(refused.writeAttempted,false);
  assert.equal(a.localStorage.getItem(INTENT),before.first);
  assert.equal(a.localStorage.getItem(FOLLOWUP_INTENT),before.second);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat cache quota and snapshot quota failures retain signed journal and dirty marker',async()=>{
  for(const failKey of [CACHE,V1]){
    const a=await boot();
    await completedTwoNotesEdits(a);
    await a.api.rehearsePreviewNotesRepeatEditIntent(
      'third',a.token(),'repeat-quota');
    const seal=a.localStorage.getItem(REPEAT_JOURNAL);
    const originalSet=a.localStorage.setItem.bind(a.localStorage);
    a.localStorage.setItem=(key,value)=>{
      if(key===failKey)throw Error('QuotaExceededError');
      return originalSet(key,value);
    };
    let result;
    if(failKey===CACHE){
      result=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
        a.token(),'repeat-quota');
      assert.equal(result.reason,'repeat_cache_write_uncertain',
        JSON.stringify(result));
    }else{
      // Only the snapshot call is quota-denied; let cache write succeed first.
      a.localStorage.setItem=originalSet;
      await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
        a.token(),'repeat-quota');
      a.localStorage.setItem=(key,value)=>{
        if(key===V1)throw Error('QuotaExceededError');
        return originalSet(key,value);
      };
      result=await a.api.rehearsePreviewAdmittedNotesRepeatSnapshotSync(
        a.token(),'repeat-quota');
      assert.equal(result.reason,'repeat_snapshot_write_uncertain',
        JSON.stringify(result));
    }
    assert.equal(result.writeOutcomeUncertain,true);
    assert.equal(result.inspectIntentBeforeRetry,true);
    assert.equal(result.canPromote,false);
    assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),seal);
    assert.equal(a.localStorage.getItem(DIRTY),'1');
  }
});

test('repeat journal rejects observed transient old tab storage event and refuses production hosts',async()=>{
  const a=await witnessBoot();
  await completedTwoNotesEdits(a);
  const good=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'repeat-event');
  assert.equal(good.intentRecorded,true,JSON.stringify(good));
  const start=await a.api.beginPreviewLegacyStorageEventWitness(a.token());
  assert.equal(start.observing,true);
  a.signal();
  const denied=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-event');
  assert.equal(denied.reason,'repeat_cache_source_changed_before_write',
    JSON.stringify(denied));
  assert.equal(denied.cacheReadbackVerified,false);
  assert.equal(a.localStorage.getItem(CACHE),'second');
  a.api.stopPreviewLegacyStorageEventWitness();
  a.ctx.location.hostname='taskpoints.pages.dev';
  const forbidden=await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-event');
  assert.equal(forbidden.reason,'preview_host_required');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat journal is bounded at sixteen extra sequential edits',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  for(let i=1;i<=16;i++){
    const id='repeat-cap-'+i;
    await repeatSequence(a,id,'value-'+i);
  }
  const previous=a.localStorage.getItem(REPEAT_JOURNAL);
  const blocked=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'one-too-many',a.token(),'repeat-cap-17');
  assert.equal(blocked.reason,'repeat_journal_capacity_reached',
    JSON.stringify(blocked));
  assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),previous);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
  assert.equal(JSON.parse(a.localStorage.getItem(V1)).notes,'value-16');
});


test('repeat journal refuses reused action IDs without corrupting ancestry',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  const before=a.token();
  for(const id of ['repeat-first','repeat-second']){
    const denied=await a.api.rehearsePreviewNotesRepeatEditIntent(
      'third',a.token(),id);
    assert.equal(denied.reason,'repeat_action_id_already_recorded',
      id+': '+JSON.stringify(denied));
    assert.equal(a.token(),before);
    assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),null);
  }
  await repeatSequence(a,'repeat-third','third');
  const signed=a.localStorage.getItem(REPEAT_JOURNAL);
  const duplicate=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'fourth',a.token(),'repeat-third');
  assert.equal(duplicate.reason,'repeat_action_id_already_recorded',
    JSON.stringify(duplicate));
  assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),signed);
  const proof=await a.api.inspectPreviewNotesRepeatEditJournal();
  assert.equal(proof.journalEvidenceVerified,true,JSON.stringify(proof));
  assert.equal(proof.journalEntryCount,1);
});

test('repeat intent quota failure never edits Notes or replaces older journal entries',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  await repeatSequence(a,'repeat-safe','third');
  const priorJournal=a.localStorage.getItem(REPEAT_JOURNAL);
  const priorSnapshot=a.localStorage.getItem(V1);
  const priorCache=a.localStorage.getItem(CACHE);
  const originalSet=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    if(key===REPEAT_JOURNAL)throw Error('QuotaExceededError');
    return originalSet(key,value);
  };
  const denied=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'fourth',a.token(),'repeat-quota-intent');
  assert.equal(denied.reason,'repeat_intent_write_uncertain',
    JSON.stringify(denied));
  assert.equal(denied.writeOutcomeUncertain,true);
  assert.equal(denied.inspectIntentBeforeRetry,true);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem(REPEAT_JOURNAL),priorJournal);
  assert.equal(a.localStorage.getItem(V1),priorSnapshot);
  assert.equal(a.localStorage.getItem(CACHE),priorCache);
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});

test('repeat snapshot readback detects independent old tab update after its write',async()=>{
  const a=await boot();
  await completedTwoNotesEdits(a);
  const step=await a.api.rehearsePreviewNotesRepeatEditIntent(
    'third',a.token(),'repeat-midwrite');
  assert.equal(step.intentRecorded,true,JSON.stringify(step));
  assert.equal((await a.api.rehearsePreviewAdmittedNotesRepeatCacheWrite(
    a.token(),'repeat-midwrite')).cacheReadbackVerified,true);
  const originalSet=a.localStorage.setItem.bind(a.localStorage);
  a.localStorage.setItem=(key,value)=>{
    const result=originalSet(key,value);
    if(key===V1)originalSet('tp_projects_v1','old-tab-new-project');
    return result;
  };
  const denied=await a.api.rehearsePreviewAdmittedNotesRepeatSnapshotSync(
    a.token(),'repeat-midwrite');
  assert.equal(denied.reason,'repeat_snapshot_readback_or_origin_changed',
    JSON.stringify(denied));
  assert.equal(denied.writeOutcomeUncertain,true);
  assert.equal(denied.notesSnapshotSynchronized,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.localStorage.getItem('tp_projects_v1'),
    'old-tab-new-project');
  assert.equal(a.localStorage.getItem(DIRTY),'1');
});
