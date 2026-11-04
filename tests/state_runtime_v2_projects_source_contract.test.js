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
const DB='taskpoints_state_v2', KEY='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1', PROJECTS='tp_projects_v1';

async function boot(rawProjects,gate=null) {
  const start={habits:[{id:'h1',name:'Exercise',doneKeys:[],failedKeys:[],iceKeys:[]}],
    tasks:[{id:'t1',title:'Task'}],completions:[]};
  const rows={[DARK]:'1',[KEY]:JSON.stringify(start)};
  if (rawProjects!==undefined) rows[PROJECTS]=rawProjects;
  const localStorage=new FakeStorage(rows),indexedDB=new FakeIndexedDB();
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
  const subtle=gate ? {digest:async(...args)=>{
    const hash=await webcrypto.subtle.digest(...args);
    if (gate.armed) {
      gate.armed=false;
      gate.callback();
    }
    return hash;
  }} : webcrypto.subtle;
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:{subtle,randomUUID(){return 'project-preview-'+ ++uuid}},
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  await ctx.TaskPointsStateRuntimeV2.seedFromLegacy();
  return {api:ctx.TaskPointsStateRuntimeV2,indexedDB,localStorage,ctx};
}
const sample=()=>[
  {id:'p1',name:'First',done:33,notes:'private note',category:'Home',
    createdAt:100,updatedAt:200,unknownField:{nested:['retained']},
    subtasks:[{id:'s1',text:'one',done:true},{id:'s2',text:'two',done:false}]},
  {id:'p2',name:'Second',done:60,subtasks:[]}
];

test('independent Projects source preview verifies exact nonempty source without writes',async()=>{
  const raw=JSON.stringify(sample()),app=await boot(raw);
  const beforeDb=app.indexedDB.dump(DB);
  const beforeKeys=Array.from(app.localStorage.rows.entries());
  const result=await app.api.inspectPreviewProjectsSource();
  assert.equal(result.reason,'legacy_projects_source_verified',JSON.stringify(result));
  assert.equal(result.sourceVerified,true);
  assert.equal(result.projectCount,2);
  assert.equal(result.subtaskCount,2);
  assert.equal(result.hasSourceKey,true);
  assert.match(result.sourceFingerprint,/^sha256:[0-9a-f]{64}:\d+$/);
  assert.equal(result.projectsMigrated,false);
  assert.equal(result.canPromote,false);
  assert.equal(result.productionWritersFenced,false);
  assert.deepEqual(app.indexedDB.dump(DB),beforeDb);
  assert.deepEqual(Array.from(app.localStorage.rows.entries()),beforeKeys);
  assert.equal(app.localStorage.getItem(PROJECTS),raw);
  assert.equal(JSON.stringify(result).includes('private note'),false);
});

test('absent Projects key is a verified empty source, not an import or reset',async()=>{
  const app=await boot();
  const before=app.indexedDB.dump(DB);
  const result=await app.api.inspectPreviewProjectsSource();
  assert.equal(result.sourceVerified,true,JSON.stringify(result));
  assert.equal(result.projectCount,0);
  assert.equal(result.hasSourceKey,false);
  assert.equal(app.localStorage.getItem(PROJECTS),null);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const explicit=await boot('[]');
  const answer=await explicit.api.inspectPreviewProjectsSource();
  assert.equal(answer.sourceVerified,true);
  assert.equal(answer.hasSourceKey,true);
  assert.equal(answer.sourceFingerprint,result.sourceFingerprint);
});

test('malformed or non-array Projects JSON never becomes an empty collection',async()=>{
  for (const [raw,reason] of [
    ['{bad','legacy_projects_malformed_json'],
    ['{"projects":[]}','legacy_projects_array_required'],
    ['null','legacy_projects_array_required'],
    ['""','legacy_projects_array_required']
  ]) {
    const app=await boot(raw),prior=app.indexedDB.dump(DB);
    const result=await app.api.inspectPreviewProjectsSource();
    assert.equal(result.reason,reason,raw+' '+JSON.stringify(result));
    assert.equal(result.sourceVerified,false);
    assert.equal(result.canPromote,false);
    assert.deepEqual(app.indexedDB.dump(DB),prior);
    assert.equal(app.localStorage.getItem(PROJECTS),raw);
  }
});

test('duplicate/missing Project IDs and invalid subtask evidence fail closed',async()=>{
  const cases=[
    [{id:'same'},{id:'same'}],
    [{name:'no-id'}],
    [{id:'x',subtasks:{id:'bad'}}],
    [{id:'x',subtasks:[{id:'same'},{id:'same'}]}],
    [{id:'x',subtasks:[{text:'missing id'}]}]
  ];
  for (let i=0;i<cases.length;i++) {
    const raw=JSON.stringify(cases[i]),app=await boot(raw);
    const before=app.indexedDB.dump(DB);
    const result=await app.api.inspectPreviewProjectsSource();
    assert.equal(result.sourceVerified,false,JSON.stringify(result));
    assert.equal(result.reason,i<2?'legacy_project_ids_invalid'
      :'legacy_project_subtasks_invalid');
    assert.deepEqual(app.indexedDB.dump(DB),before);
    assert.equal(app.localStorage.getItem(PROJECTS),raw);
  }
});

test('a Projects write during asynchronous digest invalidates its capture',async()=>{
  const gate={armed:false,callback:null};
  const app=await boot(JSON.stringify(sample()),gate);
  const before=app.indexedDB.dump(DB);
  gate.callback=()=>app.localStorage.setItem(PROJECTS,JSON.stringify([
    {...sample()[0],notes:'new Project note'}
  ]));
  gate.armed=true;
  const result=await app.api.inspectPreviewProjectsSource();
  assert.equal(result.reason,'legacy_projects_changed_after_fingerprint',
    JSON.stringify(result));
  assert.equal(result.sourceVerified,false);
  assert.equal(gate.armed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('an unrelated origin key write during Projects digest also invalidates the proof',async()=>{
  const gate={armed:false,callback:null};
  const app=await boot(JSON.stringify(sample()),gate);
  gate.callback=()=>app.localStorage.setItem('notes_view_v1','new-other-tab-value');
  gate.armed=true;
  const result=await app.api.inspectPreviewProjectsSource();
  assert.equal(result.reason,'legacy_projects_changed_after_fingerprint',
    JSON.stringify(result));
  assert.equal(result.sourceVerified,false);
  assert.equal(app.localStorage.getItem('notes_view_v1'),'new-other-tab-value');
});

test('Projects source inspector refuses unavailable storage and production host',async()=>{
  const app=await boot(JSON.stringify(sample()));
  const original=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=function(key) {
    if (key===PROJECTS) throw Error('storage read denied');
    return original(key);
  };
  const denied=await app.api.inspectPreviewProjectsSource();
  assert.equal(denied.sourceVerified,false);
  assert.equal(denied.reason,'legacy_projects_source_unreadable');
  app.localStorage.getItem=original;
  app.ctx.location.hostname='taskpoints.pages.dev';
  const host=await app.api.inspectPreviewProjectsSource();
  assert.equal(host.reason,'preview_host_required');
  assert.equal(host.sourceVerified,false);
});
