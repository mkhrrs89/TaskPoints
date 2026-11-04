'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');

const runtime=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const game=fs.readFileSync(path.join(__dirname,'..','game.html'),'utf8');
const V1='taskpoints_v1',DARK='taskpoints_state_v2_dark_mode_v1';
const COLS='taskpoints_gallery_columns';
const SORT='taskpoints_player_sort_mode';
const GROUP='taskpoints_group_active_players';
const fixture=()=>({
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[],notes:'V1 source secret'
});
async function boot(opts={}) {
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify(fixture()),
    ...(opts.columns===undefined?{}:{[COLS]:opts.columns}),
    ...(opts.sort===undefined?{}:{[SORT]:opts.sort}),
    ...(opts.group===undefined?{}:{[GROUP]:opts.group})
  });
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  let count=0;
  const core={
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw);},
    readPendingHabitDeltas(){return []},
    applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1));},
    writePendingHabitDelta(row){return {...row};},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const crypto=opts.crypto||{subtle:webcrypto.subtle,
    randomUUID(){return 'game-test-'+(++count);}};
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,crypto,
    location:{hostname:opts.hostname||'localhost'},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(runtime,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  const token=()=>JSON.stringify(Array.from({length:localStorage.length},
    (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));
  return {api,ctx,indexedDB,localStorage,token};
}

test('Players page independent preference keys and whitelists match V2 audit',()=>{
  for(const key of [COLS,SORT,GROUP])assert.ok(game.includes(key),key);
  for(const mode of ['name-asc','name-desc','pid-asc','pid-desc',
    'avg-desc','overall-desc','ranking-asc','baseline-desc',
    'created-desc','created-asc']){
    assert.ok(game.includes('"'+mode+'"'),'Player sort mode must remain supported: '+mode);
  }
  assert.match(game,/portrait: portrait === 2 \|\| portrait === 3 \? portrait : 2/);
  assert.match(game,/landscape: landscape === 3 \|\| landscape === 4 \? landscape : 3/);
});

test('Absent Game preferences retain precise UI defaults without creating a key',async()=>{
  const app=await boot();
  const v1=app.token();
  const oldDb=app.indexedDB.dump('taskpoints_state_v2');
  const result=await app.api.inspectPreviewGamePreferencesSource();
  assert.equal(result.sourceVerified,true,JSON.stringify(result));
  assert.equal(result.galleryColumnsPresent,false);
  assert.equal(result.playerSortPresent,false);
  assert.equal(result.groupActivePresent,false);
  assert.equal(result.effectiveGalleryColumns.portrait,2);
  assert.equal(result.effectiveGalleryColumns.landscape,3);
  assert.equal(result.effectiveSortMode,'name-asc');
  assert.equal(result.effectiveGroupActive,false);
  assert.match(result.sourceFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  assert.equal(result.canPromote,false);
  assert.equal(result.readAuthority,'legacy_only');
  assert.equal(app.token(),v1);
  assert.deepEqual(app.indexedDB.dump('taskpoints_state_v2'),oldDb);
});

test('Valid Game preferences are inspected exactly, with no V1 mutation',async()=>{
  const app=await boot({columns:JSON.stringify({portrait:3,landscape:4}),
    sort:'created-desc',group:'true'});
  const before=app.token();
  const report=await app.api.inspectPreviewGamePreferencesSource();
  assert.equal(report.sourceVerified,true,JSON.stringify(report));
  assert.equal(report.galleryColumnsPresent,true);
  assert.equal(report.playerSortPresent,true);
  assert.equal(report.groupActivePresent,true);
  assert.equal(report.effectiveGalleryColumns.portrait,3);
  assert.equal(report.effectiveGalleryColumns.landscape,4);
  assert.equal(report.effectiveSortMode,'created-desc');
  assert.equal(report.effectiveGroupActive,true);
  assert.equal(report.gamePreferencesMigrated,false);
  assert.equal(JSON.stringify(report).includes('V1 source secret'),false);
  assert.equal(app.token(),before);
});

test('Invalid JSON, unsafe columns, unknown sort and group markers fail closed',async()=>{
  const cases=[
    [{columns:'{broken'},'game_preferences_gallery_json_invalid'],
    [{columns:'null'},'game_preferences_gallery_value_invalid'],
    [{columns:'[]'},'game_preferences_gallery_value_invalid'],
    [{columns:'{"portrait":4,"landscape":3}'},'game_preferences_gallery_value_invalid'],
    [{columns:'{"portrait":2}'},'game_preferences_gallery_value_invalid'],
    [{sort:'unexpected'},'game_preferences_sort_invalid'],
    [{group:'yes'},'game_preferences_group_invalid'],
    [{group:''},'game_preferences_group_invalid']
  ];
  for(const [args,reason] of cases){
    const app=await boot(args),before=app.token();
    const report=await app.api.inspectPreviewGamePreferencesSource();
    assert.equal(report.sourceVerified,false,JSON.stringify(report));
    assert.equal(report.reason,reason,JSON.stringify(report));
    assert.equal(report.canPromote,false);
    assert.equal(app.token(),before);
  }
});

test('Every independently written Game preference changes audited source fingerprint',async()=>{
  const app=await boot({columns:'{"portrait":2,"landscape":3}',
    sort:'name-asc',group:'false'});
  const first=await app.api.inspectPreviewGamePreferencesSource();
  assert.equal(first.sourceVerified,true);
  const snapshots=[first.sourceFingerprint];
  for(const [key,next] of [[COLS,'{"portrait":3,"landscape":3}'],
    [SORT,'pid-asc'],[GROUP,'true']]){
    app.localStorage.setItem(key,next);
    const updated=await app.api.inspectPreviewGamePreferencesSource();
    assert.equal(updated.sourceVerified,true,JSON.stringify(updated));
    assert.notEqual(updated.sourceFingerprint,snapshots.at(-1));
    snapshots.push(updated.sourceFingerprint);
  }
});

test('Unrelated origin mutation also invalidates Game preference preflight',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'race';},subtle:{
    digest:async(...args)=>{
      const digest=await webcrypto.subtle.digest(...args);
      if(armed){armed=false;app.localStorage.setItem('tp_projects_v1','late write');}
      return digest;
    }
  }};
  app=await boot({columns:'{"portrait":3,"landscape":4}',
    sort:'pid-desc',group:'true',crypto});
  armed=true;
  const report=await app.api.inspectPreviewGamePreferencesSource();
  assert.equal(report.sourceVerified,false,JSON.stringify(report));
  assert.equal(report.reason,'game_preferences_changed_after_digest');
  assert.equal(app.localStorage.getItem('tp_projects_v1'),'late write');
});

test('Game preference audit refuses denied storage reads without treating them as absence',async()=>{
  const app=await boot({sort:'name-desc'});
  const original=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=(key)=>{
    if(key===SORT)throw Error('SecurityError');
    return original(key);
  };
  const result=await app.api.inspectPreviewGamePreferencesSource();
  assert.equal(result.sourceVerified,false);
  assert.equal(result.reason,'game_preferences_source_unreadable');
});

test('Dark-disabled and production hosts cannot inspect or migrate Game preferences',async()=>{
  const app=await boot({sort:'pid-asc'});
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewGamePreferencesSource()).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.inspectPreviewGamePreferencesSource()).reason,
    'dark_disabled');
  assert.equal(app.localStorage.getItem(SORT),'pid-asc');
});
