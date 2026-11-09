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
const DB='taskpoints_state_v2',V1='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1';
const NOTES='taskpoints_notes_v1',DIRTY='taskpoints_notes_dirty_v1';
const AUTH='taskpoints_notes_authoritative_v1';
const main=(notes='snapshot general notes')=>({
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[],notes
});
async function boot(opts={}) {
  const state=opts.state===undefined?JSON.stringify(main()):opts.state;
  // Establish the normal pilot generation first, then inject Notes-specific
  // damaged/compressed V1 source cases without asking the pilot to parse them.
  const data={[DARK]:'1',[V1]:JSON.stringify(main()),
    ...(opts.cache===undefined||opts.cache===null?{}:{[NOTES]:opts.cache}),
    ...(opts.dirty===undefined||opts.dirty===null?{}:{[DIRTY]:opts.dirty}),
    ...(opts.authority===undefined||opts.authority===null?{}:{[AUTH]:opts.authority})};
  const localStorage=opts.localStorage||new FakeStorage(data);
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  let i=0;
  const core={
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){
      return opts.parser?opts.parser(raw):JSON.parse(raw);
    },
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1))},
    writePendingHabitDelta(d){return {...d}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const crypto=opts.crypto||{subtle:webcrypto.subtle,
    randomUUID(){return 'notes-test-'+ ++i}};
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,crypto,
    location:{hostname:opts.hostname||'localhost'},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  if (state===null) localStorage.removeItem(V1);
  else if (opts.state!==undefined) localStorage.setItem(V1,state);
  return {api,ctx,localStorage,indexedDB,core};
}
test('Notes preview reads both V1 copies, reports agreement, changes no storage and never reveals text',async()=>{
  const app=await boot({cache:'snapshot general notes',authority:'1'});
  const before=app.indexedDB.dump(DB);
  const saved=JSON.stringify(Array.from({length:app.localStorage.length},
    (_,i)=>app.localStorage.key(i)).sort().map(k=>[k,app.localStorage.getItem(k)]));
  const result=await app.api.inspectPreviewNotesSource();
  assert.equal(result.sourceVerified,true,JSON.stringify(result));
  assert.equal(result.copiesAgree,true);
  assert.equal(result.cacheAuthoritative,true);
  assert.equal(result.selectedSource,'marked_cache');
  assert.equal(result.selectedLength,'snapshot general notes'.length);
  assert.equal(result.notesMigrated,false);
  assert.equal(result.canPromote,false);
  assert.equal(result.readAuthority,'legacy_only');
  assert.match(result.sourceFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  assert.equal(JSON.stringify(result).includes('snapshot general notes'),false);
  const fresh=JSON.stringify(Array.from({length:app.localStorage.length},
    (_,i)=>app.localStorage.key(i)).sort().map(k=>[k,app.localStorage.getItem(k)]));
  assert.equal(fresh,saved);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Dirty or authoritative cache wins even when deliberately shortened to empty',async()=>{
  for(const flags of [{dirty:'1'},{authority:'1'},{dirty:'1',authority:'1'}]){
    const app=await boot({...flags,cache:''});
    const report=await app.api.inspectPreviewNotesSource();
    assert.equal(report.sourceVerified,true,JSON.stringify(report));
    assert.equal(report.copiesAgree,false);
    assert.equal(report.selectedSource,'marked_cache');
    assert.equal(report.selectedLength,0);
    assert.equal(report.stateLength,'snapshot general notes'.length);
    assert.equal(app.localStorage.getItem(NOTES),'');
  }
});

test('Unmarked legacy Notes bootstrap chooses longer content without synchronizing copies',async()=>{
  const cases=[
    ['longer cached notes', 'short', 'unmarked_cache_longer','longer cached notes'.length],
    ['short', 'longer snapshot notes', 'unmarked_snapshot_longer','longer snapshot notes'.length],
    ['some cache', '', 'unmarked_cache_only','some cache'.length],
    ['', 'only snapshot', 'unmarked_snapshot_only','only snapshot'.length],
    ['same','same','unmarked_equal',4]
  ];
  for(const [cache,stateNotes,selected,length] of cases){
    const app=await boot({cache,state:JSON.stringify(main(stateNotes))});
    const result=await app.api.inspectPreviewNotesSource();
    assert.equal(result.selectedSource,selected,JSON.stringify(result));
    assert.equal(result.selectedLength,length);
    assert.equal(result.sourceVerified,true);
    assert.equal(app.localStorage.getItem(NOTES),cache);
  }
});

test('No Notes cache and no main note text is an explicit empty V1 source',async()=>{
  const app=await boot({state:JSON.stringify(main(''))});
  const result=await app.api.inspectPreviewNotesSource();
  assert.equal(result.sourceVerified,true,JSON.stringify(result));
  assert.equal(result.hasCache,false);
  assert.equal(result.cacheDirty,false);
  assert.equal(result.cacheAuthoritative,false);
  assert.equal(result.selectedLength,0);
  assert.equal(result.selectedSource,'unmarked_equal');
});

test('Missing dirty/authoritative cache and bad authority markers refuse guessing',async()=>{
  const cases=[
    [{dirty:'1'},'legacy_notes_authoritative_cache_missing'],
    [{authority:'1'},'legacy_notes_authoritative_cache_missing'],
    [{cache:'text',dirty:'yes'},'legacy_notes_marker_invalid'],
    [{cache:'text',authority:'invalid'},'legacy_notes_marker_invalid']
  ];
  for(const [opts,reason] of cases){
    const app=await boot(opts);
    const before=app.indexedDB.dump(DB);
    const result=await app.api.inspectPreviewNotesSource();
    assert.equal(result.sourceVerified,false,JSON.stringify(result));
    assert.equal(result.reason,reason,JSON.stringify(result));
    assert.deepEqual(app.indexedDB.dump(DB),before);
  }
});

test('Malformed V1 snapshot or nontext Notes value is refused even if cache looks valid',async()=>{
  for(const snapshot of ['{not-json','null','[]',JSON.stringify(main(123))]){
    const app=await boot({state:snapshot,cache:'good cached notes',authority:'1'});
    const result=await app.api.inspectPreviewNotesSource();
    assert.equal(result.sourceVerified,false,JSON.stringify(result));
    assert.ok(['legacy_notes_snapshot_or_cache_unreadable',
      'legacy_notes_snapshot_invalid',
      'legacy_notes_snapshot_field_invalid'].includes(result.reason),
      JSON.stringify(result));
    assert.equal(app.localStorage.getItem(V1),snapshot);
  }
});

test('Compressed V1 snapshot is parsed with the existing TaskPoints parser',async()=>{
  const packed='{"encoding":"compressed-placeholder","data":"bytes"}';
  let received='';
  const app=await boot({
    state:packed,
    parser(raw){received=raw;return main('compressed original Notes')},
    cache:'new cache',dirty:'1'
  });
  const report=await app.api.inspectPreviewNotesSource();
  assert.equal(report.sourceVerified,true,JSON.stringify(report));
  assert.equal(report.stateLength,'compressed original Notes'.length);
  assert.equal(report.selectedSource,'marked_cache');
  assert.equal(received,packed);
  assert.equal(app.localStorage.getItem(V1),packed);
});

test('A changed V1 Notes cache during async SHA invalidates whole-source proof',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'race'},subtle:{
    digest:async(...args)=>{
      const hash=await webcrypto.subtle.digest(...args);
      if(armed) {
        armed=false;
        app.localStorage.setItem(NOTES,'newer note typed in another tab');
      }
      return hash;
    }
  }};
  app=await boot({cache:'old cache',authority:'1',crypto});
  armed=true;
  const result=await app.api.inspectPreviewNotesSource();
  assert.equal(result.sourceVerified,false,JSON.stringify(result));
  assert.equal(result.reason,'legacy_notes_changed_after_digest',
    JSON.stringify(result));
  assert.equal(app.localStorage.getItem(NOTES),'newer note typed in another tab');
});

test('A changed Notes authority marker affects checksum without exposing note text',async()=>{
  const app=await boot({cache:'cache',authority:'0'});
  const first=await app.api.inspectPreviewNotesSource();
  assert.equal(first.sourceVerified,true,JSON.stringify(first));
  app.localStorage.setItem(AUTH,'1');
  const second=await app.api.inspectPreviewNotesSource();
  assert.equal(second.sourceVerified,true,JSON.stringify(second));
  assert.notEqual(first.sourceFingerprint,second.sourceFingerprint);
  assert.equal(second.selectedSource,'marked_cache');
  assert.equal(app.localStorage.getItem(AUTH),'1');
});

test('Notes source inspection is unavailable on real production hosts or dark disabled',async()=>{
  const app=await boot({cache:'notes'});
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewNotesSource()).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.inspectPreviewNotesSource()).reason,
    'dark_disabled');
});


test('Notes crash-window phase audit distinguishes partial markers and stale snapshots without trusting equality',async()=>{
  const cases=[
    [{cache:'new draft',dirty:'1',authority:'1'},
      'dirty_cache_pending_snapshot_sync',false],
    [{cache:'new draft',dirty:'1',authority:'0'},
      'dirty_marker_without_authority',true],
    [{cache:'new draft',dirty:'0',authority:'1'},
      'authoritative_cache_snapshot_diverged',false],
    [{cache:'snapshot general notes',dirty:'0',authority:'1'},
      'authoritative_cache_matches_snapshot',false],
    [{cache:'new draft',dirty:'0',authority:'1',state:null},
      'authoritative_cache_without_snapshot',false],
    [{cache:'new draft',authority:'0'},
      'unmarked_legacy_bootstrap',false]
  ];
  for(const [options,phase,partial] of cases){
    const app=await boot(options);
    const before=JSON.stringify(Array.from({length:app.localStorage.length},
      (_,i)=>app.localStorage.key(i)).sort()
      .map(key=>[key,app.localStorage.getItem(key)]));
    const dbBefore=app.indexedDB.dump(DB);
    const result=await app.api.inspectPreviewNotesSource();
    assert.equal(result.sourceVerified,true,JSON.stringify(result));
    assert.equal(result.notesSavePhase,phase,JSON.stringify(result));
    assert.equal(result.markerTransitionMayBeIncomplete,partial);
    assert.equal(result.notesMultiKeySyncVerified,false);
    assert.equal(result.readyForNotesAuthorityHandoff,false);
    assert.equal(result.canPromote,false);
    assert.equal(JSON.stringify(result).includes('new draft'),false);
    const after=JSON.stringify(Array.from({length:app.localStorage.length},
      (_,i)=>app.localStorage.key(i)).sort()
      .map(key=>[key,app.localStorage.getItem(key)]));
    assert.equal(after,before);
    assert.deepEqual(app.indexedDB.dump(DB),dbBefore);
  }
});

test('Notes phase cannot be verified when an older tab flips a marker during digest',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'notes-phase-race'},subtle:{
    digest:async(...args)=>{
      const hash=await webcrypto.subtle.digest(...args);
      if(armed){
        armed=false;
        app.localStorage.removeItem(DIRTY);
      }
      return hash;
    }
  }};
  app=await boot({cache:'new draft',dirty:'1',authority:'1',crypto});
  armed=true;
  const result=await app.api.inspectPreviewNotesSource();
  assert.equal(result.sourceVerified,false,JSON.stringify(result));
  assert.equal(result.reason,'legacy_notes_changed_after_digest');
  assert.equal(Object.hasOwn(result,'notesSavePhase'),false);
  assert.equal(app.localStorage.getItem(NOTES),'new draft');
});
