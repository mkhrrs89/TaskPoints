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
const DB='taskpoints_state_v2',V1='taskpoints_v1',
  TODAY='taskpoints_today_view_v1',DARK='taskpoints_state_v2_dark_mode_v1';
const start=()=>({
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[{id:'task-1',title:'Daily'}]
});
const sample=()=>({
  version:1,
  tasksByDay:{
    '2026-11-04':['task-1'],
    '2026-11-05':[]
  },
  notesByDay:{
    '2026-11-04':[{id:'note-1',text:'private retained note',done:false,
      extension:{version:7}}],
    '2026-11-03':[]
  },
  selectedHabitIdsByDay:{'2026-11-05':['h1']},
  orderByDay:{'2026-11-04':['task:task-1','note:note-1']},
  futureSettings:{foo:{bar:['retain this']}}
});
async function boot(raw=JSON.stringify(sample()),opts={}) {
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify(start()),
    ...(raw===null?{}:{[TODAY]:raw})
  });
  const indexedDB=opts.indexedDB||new FakeIndexedDB();
  let uuid=0;
  const core={
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1))},
    writePendingHabitDelta(delta){return {...delta}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:opts.crypto||{subtle:webcrypto.subtle,
      randomUUID(){return 'today-seed-'+ ++uuid}},
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  return {
    api,ctx,indexedDB,localStorage,
    token(){return JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));}
  };
}
async function seeded(raw) {
  const app=await boot(raw);
  const result=await app.api.rehearsePreviewTodayCollectionSeed(app.token(),'first');
  assert.equal(result.collectionParityVerified,true,JSON.stringify(result));
  return app;
}
test('Today source preflight validates all four sparse day maps without writing any storage',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  const original=app.localStorage.getItem(TODAY),v1=app.localStorage.getItem(V1);
  const result=await app.api.inspectPreviewTodaySource();
  assert.equal(result.sourceVerified,true,JSON.stringify(result));
  assert.equal(result.dayCount,3);
  assert.equal(result.noteCount,1);
  assert.equal(result.entryCount,5);
  assert.equal(result.hasSourceKey,true);
  assert.match(result.sourceFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  assert.equal(result.todayMigrated,false);
  assert.equal(result.canPromote,false);
  assert.equal(result.productionWritersFenced,false);
  assert.equal(JSON.stringify(result).includes('private retained note'),false);
  assert.equal(app.localStorage.getItem(TODAY),original);
  assert.equal(app.localStorage.getItem(V1),v1);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('V5 Today seed writes one root and three records, with exact sparse map provenance',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  const raw=app.localStorage.getItem(TODAY),v1=app.localStorage.getItem(V1);
  const result=await app.api.rehearsePreviewTodayCollectionSeed(app.token(),'seed-1');
  assert.equal(result.reason,'today_preview_seed_verified',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.dayCount,3);
  assert.equal(result.recordCount,4);
  assert.equal(result.canPromote,false);
  const db=await app.api.open();
  assert.equal(db.version,5);
  assert.equal(db.objectStoreNames.contains('todayDays'),true);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.projects,before.projects);
  assert.equal(after.todayDays.length,4);
  const root=after.todayDays.find(row=>row.id==='root');
  assert.deepEqual(root.presentMaps,
    ['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay']);
  assert.deepEqual(root.value,{version:1,futureSettings:sample().futureSettings});
  const nov4=after.todayDays.find(row=>row.id==='day:2026-11-04');
  assert.deepEqual(nov4.value,{
    tasksByDay:['task-1'],
    notesByDay:[{id:'note-1',text:'private retained note',done:false,
      extension:{version:7}}],
    orderByDay:['task:task-1','note:note-1']
  });
  assert.equal(Object.hasOwn(nov4.value,'selectedHabitIdsByDay'),false);
  const receipt=after.mutations.find(r=>r.id==='today-preview-seed:seed-1');
  assert.equal(receipt.type,'today-preview-seed');
  assert.equal(receipt.recordCount,4);
  assert.equal(after.meta.find(r=>r.id==='today-preview').receiptId,receipt.id);
  assert.equal(app.localStorage.getItem(TODAY),raw);
  assert.equal(app.localStorage.getItem(V1),v1);
  const parity=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
});

test('Today seed no-op and parity remain verified after a runtime reload',async()=>{
  const app=await seeded(),snapshot=app.indexedDB.dump(DB);
  const retry=await app.api.rehearsePreviewTodayCollectionSeed(app.token(),'other');
  assert.equal(retry.reason,'today_preview_already_verified',JSON.stringify(retry));
  assert.equal(retry.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),snapshot);
  const reload=await boot(undefined,{
    localStorage:app.localStorage,indexedDB:app.indexedDB
  });
  const parity=await reload.api.inspectPreviewTodayCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
  assert.deepEqual(reload.indexedDB.dump(DB),snapshot);
});

test('Today modified V1 notes or order never silently overwrite an earlier V2 seed',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const next=sample();
  next.notesByDay['2026-11-04'][0].done=true;
  next.orderByDay['2026-11-04'].reverse();
  app.localStorage.setItem(TODAY,JSON.stringify(next));
  const invalid=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(invalid.reason,'today_preview_source_stale',JSON.stringify(invalid));
  const reseed=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'cannot-replace');
  assert.equal(reseed.reason,'today_preview_existing_evidence_preserved',
    JSON.stringify(reseed));
  assert.equal(reseed.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today malformed payload, wrong shape and unrecognized versions fail closed',async()=>{
  const cases=[
    ['{bad','legacy_today_json_malformed'],
    ['null','legacy_today_object_required'],
    ['[]','legacy_today_object_required'],
    ['{"version":2}','legacy_today_schema_unrecognized'],
    ['{"tasksByDay":[]}','legacy_today_day_map_invalid'],
    ['{"notesByDay":{"2026-11-04":{}}}','legacy_today_day_entries_invalid'],
    ['{"orderByDay":{"bad-date":[]}}','legacy_today_day_entries_invalid']
  ];
  for (const [raw,reason] of cases) {
    const app=await boot(raw),before=app.indexedDB.dump(DB);
    const proof=await app.api.inspectPreviewTodaySource();
    assert.equal(proof.sourceVerified,false,raw);
    assert.equal(proof.reason,reason,JSON.stringify(proof));
    const seed=await app.api.rehearsePreviewTodayCollectionSeed(
      app.token(),'invalid');
    assert.equal(seed.reason,'today_source_preflight_required',
      JSON.stringify(seed));
    assert.equal(seed.prerequisiteReason,reason);
    assert.deepEqual(app.indexedDB.dump(DB),before);
    assert.equal(app.localStorage.getItem(TODAY),raw);
  }
});

test('Absent, empty object, and present empty day maps are distinct Today sources',async()=>{
  const cases=[
    [null,false,[]],
    ['{}',true,[]],
    [JSON.stringify({version:1,tasksByDay:{}}),true,['tasksByDay']]
  ];
  const fingerprints=[];
  for (const [raw,present,maps] of cases) {
    const app=await boot(raw);
    const source=await app.api.inspectPreviewTodaySource();
    assert.equal(source.sourceVerified,true,JSON.stringify(source));
    assert.equal(source.hasSourceKey,present);
    fingerprints.push(source.sourceFingerprint);
    const result=await app.api.rehearsePreviewTodayCollectionSeed(
      app.token(),'empty-'+fingerprints.length);
    assert.equal(result.collectionParityVerified,true,JSON.stringify(result));
    assert.equal(result.recordCount,1);
    const root=app.indexedDB.dump(DB).todayDays[0];
    assert.deepEqual(root.presentMaps,maps);
    const parity=await app.api.inspectPreviewTodayCollectionParity();
    assert.equal(parity.match,true,JSON.stringify(parity));
  }
  assert.equal(new Set(fingerprints).size,3);
});

test('Today source change during async digest blocks seed with no data loss',async()=>{
  const gate={armed:false,change:null};
  const subtle={digest:async(...args)=>{
    const result=await webcrypto.subtle.digest(...args);
    if(gate.armed){gate.armed=false;gate.change();}
    return result;
  }};
  const app=await boot(undefined,{crypto:{
    subtle,randomUUID(){return 'digest-race'}
  }});
  const before=app.indexedDB.dump(DB);
  gate.change=()=>app.localStorage.setItem(TODAY,'{}');
  gate.armed=true;
  const result=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'digest-race');
  assert.equal(result.reason,'today_source_preflight_required',JSON.stringify(result));
  assert.equal(result.prerequisiteReason,'legacy_today_changed_after_digest');
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal(app.localStorage.getItem(TODAY),'{}');
});

test('Today stale full-origin token refuses a change in an unrelated V1 key',async()=>{
  const app=await boot(),token=app.token();
  app.localStorage.setItem('tp_projects_v1','[]');
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTodayCollectionSeed(token,'stale');
  assert.equal(result.reason,'full_origin_changed',JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today orphaned V2 day row cannot be overwritten by a fresh source seed',async()=>{
  const app=await boot(),db=app.indexedDB._databases.get(DB);
  db._stores.get('todayDays').set('day:2026-11-04',{
    id:'day:2026-11-04',dayKey:'2026-11-04',
    value:{notesByDay:[{id:'preserve-me',text:'orphan'}]}
  });
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'no-clobber');
  assert.equal(result.reason,'today_preview_orphaned_rows_preserved',
    JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today tampered V2 record or lost receipt cannot pass parity',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const rows=db._stores.get('todayDays');
  const before=rows.get('day:2026-11-04');
  rows.set(before.id,{...before,value:{notesByDay:[]}});
  const broken=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(broken.reason,'today_preview_record_mismatch',JSON.stringify(broken));
  const reseed=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'no-repair');
  assert.equal(reseed.reason,'today_preview_existing_evidence_preserved');
  rows.set(before.id,before);
  db._stores.get('mutations').delete('today-preview-seed:first');
  const missing=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(missing.reason,'today_preview_receipt_invalid',
    JSON.stringify(missing));
});

test('Today quota denial rolls back all day rows, receipt and metadata',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'todayDays',operation:'add',
    error:new Error('QuotaExceededError')});
  const result=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'quota');
  assert.equal(result.reason,'today_preview_atomic_seed_failed',
    JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(result.confirmedDurable,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Competing Today preview write between inspection and atomic seed is refused',async()=>{
  const app=await boot(),db=app.indexedDB._databases.get(DB);
  const original=db.transaction.bind(db);
  let competing=false;
  db.transaction=(stores,mode)=>{
    if(!competing && mode==='readwrite'
      && Array.isArray(stores)&&stores.includes('todayDays')) {
      competing=true;
      db._stores.get('todayDays').set('other-preview',{
        id:'other-preview',value:{doNotErase:true}
      });
    }
    return original(stores,mode);
  };
  const result=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'competing');
  assert.equal(competing,true);
  assert.equal(result.reason,'today_preview_concurrent_change',
    JSON.stringify(result));
  assert.equal(app.indexedDB.dump(DB).todayDays.length,1);
  assert.equal(app.indexedDB.dump(DB).mutations
    .some(r=>r.id==='today-preview-seed:competing'),false);
});

test('V4 to V5 upgrade adds Today store and retains Task, Project and Habit rows',async()=>{
  const app=await boot();
  const db=app.indexedDB._databases.get(DB);
  const before=app.indexedDB.dump(DB);
  db.version=4;db._stores.delete('todayDays');db._indexes.delete('todayDays');
  const later=await boot(undefined,{
    indexedDB:app.indexedDB,localStorage:app.localStorage
  });
  assert.equal((await later.api.open()).version,5);
  const after=later.indexedDB.dump(DB);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.projects,before.projects);
  assert.deepEqual(after.todayDays,[]);
  assert.equal((await later.api.rehearsePreviewTodayCollectionSeed(
    later.token(),'upgrade')).collectionParityVerified,true);
});

test('Today preview APIs are unavailable on production host',async()=>{
  const app=await boot();
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewTodaySource()).reason,
    'preview_host_required');
  assert.equal((await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'production')).reason,'preview_host_required');
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).reason,
    'preview_host_required');
});
