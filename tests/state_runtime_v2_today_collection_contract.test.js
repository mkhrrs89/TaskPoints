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


test('Today reconcile atomically edits notes, removes a day, adds a day and reorders items',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const changed=sample();
  delete changed.notesByDay['2026-11-03'];
  changed.tasksByDay['2026-11-04']=['task-1','task-new'];
  changed.notesByDay['2026-11-04'][0].done=true;
  changed.orderByDay['2026-11-04'].reverse();
  changed.selectedHabitIdsByDay['2026-11-05']=['h1','h2'];
  changed.notesByDay['2026-11-06']=[{id:'note-new',text:'new day',done:false}];
  const raw=JSON.stringify(changed);
  app.localStorage.setItem(TODAY,raw);
  const result=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'edit-add-delete');
  assert.equal(result.reason,'today_preview_reconciled',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.changedRows,4);
  assert.equal(result.addedRows,1);
  assert.equal(result.deletedRows,1);
  assert.equal(result.canPromote,false);
  assert.equal(result.todayMigrated,false);
  const after=app.indexedDB.dump(DB);
  assert.equal(after.todayDays.some(r=>r.id==='day:2026-11-03'),false);
  assert.equal(after.todayDays.find(r=>r.id==='day:2026-11-04')
    .value.notesByDay[0].done,true);
  assert.deepEqual(after.todayDays.find(r=>r.id==='day:2026-11-04')
    .value.orderByDay,['note:note-1','task:task-1']);
  assert.deepEqual(after.todayDays.find(r=>r.id==='day:2026-11-06')
    .value.notesByDay,[{id:'note-new',text:'new day',done:false}]);
  assert.deepEqual(after.habits,before.habits);
  assert.deepEqual(after.completions,before.completions);
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.projects,before.projects);
  assert.equal(app.localStorage.getItem(TODAY),raw);
  const receipt=after.mutations.find(r=>r.id==='today-preview-reconcile:edit-add-delete');
  assert.equal(receipt.type,'today-preview-reconcile');
  assert.equal(receipt.priorReceiptId,'today-preview-seed:first');
  assert.deepEqual(receipt.deletedIds,['day:2026-11-03']);
  assert.equal(receipt.changedIds.includes('day:2026-11-06'),true);
  assert.equal(after.meta.find(r=>r.id==='today-preview').receiptId,receipt.id);
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
});

test('Today reconcile supports multiple receipts, restart and verified no-op',async()=>{
  const app=await seeded();
  const payload=sample();
  payload.futureSettings.foo.bar=['first updated root'];
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const first=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'first-update');
  assert.equal(first.committed,true,JSON.stringify(first));
  assert.equal(first.changedRows,1);
  assert.equal(first.collectionParityVerified,true);
  const firstDb=app.indexedDB.dump(DB);
  const noop=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'no-op');
  assert.equal(noop.reason,'today_preview_already_current',JSON.stringify(noop));
  assert.equal(noop.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),firstDb);
  app.localStorage.setItem('unrelated_second_legacy_key','changed');
  const metadataOnly=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'origin-metadata');
  assert.equal(metadataOnly.committed,true,JSON.stringify(metadataOnly));
  assert.equal(metadataOnly.changedRows,0);
  assert.deepEqual(app.indexedDB.dump(DB).todayDays,firstDb.todayDays);
  payload.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const second=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'second-update');
  assert.equal(second.committed,true,JSON.stringify(second));
  assert.equal(second.changedRows,1);
  assert.equal(second.collectionParityVerified,true);
  const snapshot=app.indexedDB.dump(DB);
  const restart=await boot(undefined,{
    localStorage:app.localStorage,indexedDB:app.indexedDB
  });
  const parity=await restart.api.inspectPreviewTodayCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
  const again=await restart.api.rehearsePreviewTodayCollectionReconcile(
    restart.token(),'after-restart');
  assert.equal(again.reason,'today_preview_already_current',
    JSON.stringify(again));
  assert.deepEqual(restart.indexedDB.dump(DB),snapshot);
});

test('Today reconcile rejects malformed V1 and leaves every V2 record unchanged',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  app.localStorage.setItem(TODAY,'{bad');
  const result=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'corrupt');
  assert.equal(result.reason,'today_source_preflight_required',
    JSON.stringify(result));
  assert.equal(result.prerequisiteReason,'legacy_today_json_malformed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today reconcile fails closed after old V2 record or receipt tampering',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const rows=db._stores.get('todayDays');
  const old=rows.get('day:2026-11-04');
  rows.set(old.id,{...old,value:{
    ...old.value,notesByDay:[{id:'evil',text:'V2-only'}]
  }});
  const before=app.indexedDB.dump(DB);
  const payload=sample();
  payload.notesByDay['2026-11-04'][0].text='new V1 note';
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const denied=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'tampered');
  assert.equal(denied.reason,'today_preview_existing_parity_mismatch',
    JSON.stringify(denied));
  assert.equal(denied.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  rows.set(old.id,old);
  db._stores.get('mutations').delete('today-preview-seed:first');
  const afterReceiptLoss=app.indexedDB.dump(DB);
  const lost=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'missing-receipt');
  assert.equal(lost.reason,'today_preview_existing_receipt_invalid',
    JSON.stringify(lost));
  assert.deepEqual(app.indexedDB.dump(DB),afterReceiptLoss);
});

test('Today reconcile quota failure rolls back changes, receipt and evidence atomically',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const changed=sample();
  changed.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(changed));
  app.indexedDB.failNext({store:'todayDays',operation:'put',
    error:new Error('QuotaExceededError')});
  const denied=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'quota-denied');
  assert.equal(denied.committed,false,JSON.stringify(denied));
  assert.equal(denied.confirmedDurable,false);
  assert.equal(denied.reason,'today_preview_reconcile_atomic_write_failed');
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const recovered=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'retry-after-quota');
  assert.equal(recovered.committed,true,JSON.stringify(recovered));
});

test('Today reconcile delete fault never drops a historical day',async()=>{
  const app=await seeded(),before=app.indexedDB.dump(DB);
  const changed=sample();
  delete changed.notesByDay['2026-11-03'];
  app.localStorage.setItem(TODAY,JSON.stringify(changed));
  app.indexedDB.failNext({store:'todayDays',operation:'delete',
    error:new Error('QuotaExceededError')});
  const denied=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'delete-failure');
  assert.equal(denied.reason,'today_preview_reconcile_atomic_write_failed',
    JSON.stringify(denied));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today reconcile rejects competing V2 insert during write-admission transaction',async()=>{
  const app=await seeded(),db=app.indexedDB._databases.get(DB);
  const changed=sample();
  changed.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(changed));
  const original=db.transaction.bind(db);
  let raced=false;
  db.transaction=(stores,mode)=>{
    if(!raced&&mode==='readwrite'
      && Array.isArray(stores)&&stores.includes('todayDays')){
      raced=true;
      db._stores.get('todayDays').set('day:2026-11-07',{
        id:'day:2026-11-07',dayKey:'2026-11-07',
        value:{notesByDay:[{id:'peer-note',text:'other tab'}]}
      });
    }
    return original(stores,mode);
  };
  const outcome=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'competing-peer');
  assert.equal(raced,true);
  assert.equal(outcome.reason,'today_preview_reconcile_concurrent_change',
    JSON.stringify(outcome));
  assert.equal(outcome.committed,false);
  const after=app.indexedDB.dump(DB);
  assert.equal(after.todayDays.find(r=>r.id==='day:2026-11-04')
    .value.notesByDay[0].done,false);
  assert.equal(after.todayDays.some(r=>r.id==='day:2026-11-07'),true);
  assert.equal(after.mutations.some(r=>r.id==='today-preview-reconcile:competing-peer'),
    false);
});

test('Today reconcile rejects stale source token and action-id reuse',async()=>{
  const app=await seeded(),token=app.token();
  const payload=sample();
  payload.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const old=app.indexedDB.dump(DB);
  const stale=await app.api.rehearsePreviewTodayCollectionReconcile(
    token,'stale-token');
  assert.equal(stale.reason,'full_origin_changed',JSON.stringify(stale));
  assert.deepEqual(app.indexedDB.dump(DB),old);
  const first=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'used');
  assert.equal(first.committed,true,JSON.stringify(first));
  payload.notesByDay['2026-11-04'][0].text='next change';
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const beforeReplay=app.indexedDB.dump(DB);
  const replay=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'used');
  assert.equal(replay.reason,'today_preview_action_id_conflict',
    JSON.stringify(replay));
  assert.deepEqual(app.indexedDB.dump(DB),beforeReplay);
});

test('Today reconcile preserves absent versus present-empty source transitions',async()=>{
  const app=await seeded(null);
  app.localStorage.setItem(TODAY,'{}');
  const first=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'make-present');
  assert.equal(first.committed,true,JSON.stringify(first));
  assert.equal(first.changedRows,0);
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
  assert.equal(app.indexedDB.dump(DB).meta.find(r=>r.id==='today-preview')
    .sourcePresent,true);
  app.localStorage.removeItem(TODAY);
  const second=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'make-absent');
  assert.equal(second.committed,true,JSON.stringify(second));
  assert.equal(second.changedRows,0);
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
  const payload={version:1,notesByDay:{'2026-11-04':[
    {id:'first-note',text:'first note after empty',done:false}
  ]}};
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const third=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'from-absent');
  assert.equal(third.committed,true,JSON.stringify(third));
  assert.equal(third.addedRows,1);
  assert.equal(third.changedRows,2);
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
});

test('Today reconcile rejects more than 64 changed days with no partial update',async()=>{
  const dates=Array.from({length:66},(_,i)=>{
    const d=new Date(Date.UTC(2026,0,i+1));
    return d.toISOString().slice(0,10);
  });
  const oldData={version:1,notesByDay:Object.fromEntries(
    dates.map(day=>[day,[{id:'note:'+day,text:'old note'}]]))};
  const app=await boot(JSON.stringify(oldData));
  const initial=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'many-days');
  assert.equal(initial.collectionParityVerified,true,JSON.stringify(initial));
  const before=app.indexedDB.dump(DB);
  for(const day of dates)oldData.notesByDay[day][0].text='updated';
  app.localStorage.setItem(TODAY,JSON.stringify(oldData));
  const denied=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'over-limit');
  assert.equal(denied.reason,'today_preview_reconcile_batch_too_large',
    JSON.stringify(denied));
  assert.equal(denied.changedRows,66);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today parity rejects damaged predecessor receipt after reconciliation',async()=>{
  const app=await seeded();
  const changed=sample();
  changed.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(changed));
  const update=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'first-update');
  assert.equal(update.collectionParityVerified,true,JSON.stringify(update));
  const receipts=app.indexedDB._databases.get(DB)._stores.get('mutations');
  const old=receipts.get('today-preview-seed:first');
  receipts.set(old.id,{...old,recordsFingerprint:'invalid'});
  const before=app.indexedDB.dump(DB);
  const parity=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(parity.match,false);
  assert.equal(parity.reason,'today_preview_receipt_chain_invalid',
    JSON.stringify(parity));
  const attempt=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'after-tamper');
  assert.equal(attempt.reason,'today_preview_existing_receipt_chain_invalid',
    JSON.stringify(attempt));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today parity re-reads V2 rows after asynchronous SHA to catch interleaved edit',async()=>{
  let app,armed=false,hashes=0;
  const crypto={
    randomUUID(){return 'digest-race'},
    subtle:{digest:async(...args)=>{
      const result=await webcrypto.subtle.digest(...args);
      if(armed && ++hashes===2) {
        const rows=app.indexedDB._databases.get(DB)._stores.get('todayDays');
        const row=rows.get('day:2026-11-04');
        rows.set(row.id,{...row,value:{...row.value,notesByDay:[]}});
      }
      return result;
    }}
  };
  app=await boot(undefined,{crypto});
  const seed=await app.api.rehearsePreviewTodayCollectionSeed(
    app.token(),'digest-seed');
  assert.equal(seed.collectionParityVerified,true,JSON.stringify(seed));
  armed=true;
  const check=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(check.match,false);
  assert.ok(['today_preview_rows_fingerprint_invalid',
    'today_preview_changed_during_parity'].includes(check.reason),
    JSON.stringify(check));
});

test('Earlier Today V5 seeds without row SHA remain inspectable but cannot rewrite by reconciliation',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const meta=db._stores.get('meta');
  const receipt=db._stores.get('mutations');
  const ev=meta.get('today-preview');
  const prior=receipt.get('today-preview-seed:first');
  meta.set(ev.id,{...ev,recordsFingerprint:undefined});
  receipt.set(prior.id,{...prior,recordsFingerprint:undefined});
  const inspect=await app.api.inspectPreviewTodayCollectionParity();
  assert.equal(inspect.match,true,JSON.stringify(inspect));
  const before=app.indexedDB.dump(DB);
  const payload=sample();
  payload.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(payload));
  const denied=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'legacy-unsealed');
  assert.equal(denied.reason,'today_preview_row_seal_required',
    JSON.stringify(denied));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});


test('Pre-row-SHA V5 Today seed can be sealed without changing any day then reconciled',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const meta=db._stores.get('meta');
  const mutations=db._stores.get('mutations');
  const oldMeta=meta.get('today-preview');
  const oldReceipt=mutations.get('today-preview-seed:first');
  const unsealedMeta={...oldMeta},unsealedReceipt={...oldReceipt};
  delete unsealedMeta.recordsFingerprint;
  delete unsealedReceipt.recordsFingerprint;
  meta.set('today-preview',unsealedMeta);
  mutations.set('today-preview-seed:first',unsealedReceipt);
  const oldRows=app.indexedDB.dump(DB).todayDays;
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
  const sealed=await app.api.rehearsePreviewTodayRowSeal(
    app.token(),'one-time-upgrade');
  assert.equal(sealed.reason,'today_preview_row_sealed',JSON.stringify(sealed));
  assert.equal(sealed.committed,true);
  assert.equal(sealed.collectionParityVerified,true);
  assert.deepEqual(app.indexedDB.dump(DB).todayDays,oldRows);
  assert.deepEqual(db._stores.get('mutations').get('today-preview-seed:first'),
    unsealedReceipt);
  const newEvidence=db._stores.get('meta').get('today-preview');
  assert.match(newEvidence.recordsFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  const sealReceipt=mutations.get('today-preview-seal:one-time-upgrade');
  assert.equal(sealReceipt.priorReceiptId,'today-preview-seed:first');
  assert.equal(sealReceipt.type,'today-preview-seal');
  const retry=await app.api.rehearsePreviewTodayRowSeal(
    app.token(),'second-seal-should-noop');
  assert.equal(retry.committed,false,JSON.stringify(retry));
  assert.equal(retry.reason,'today_preview_row_seal_already_verified');
  const changed=sample();
  changed.notesByDay['2026-11-04'][0].done=true;
  app.localStorage.setItem(TODAY,JSON.stringify(changed));
  const reconciled=await app.api.rehearsePreviewTodayCollectionReconcile(
    app.token(),'after-seal');
  assert.equal(reconciled.committed,true,JSON.stringify(reconciled));
  assert.equal(reconciled.collectionParityVerified,true);
  assert.equal((await app.api.inspectPreviewTodayCollectionParity()).match,true);
  assert.equal(app.indexedDB.dump(DB).todayDays
    .find(row=>row.id==='day:2026-11-04').value.notesByDay[0].done,true);
});

test('Today legacy seed cannot be sealed after V1 changes, preserving every old row',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const oldMeta={...db._stores.get('meta').get('today-preview')};
  const oldReceipt={...db._stores.get('mutations').get('today-preview-seed:first')};
  delete oldMeta.recordsFingerprint;
  delete oldReceipt.recordsFingerprint;
  db._stores.get('meta').set('today-preview',oldMeta);
  db._stores.get('mutations').set('today-preview-seed:first',oldReceipt);
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(TODAY,JSON.stringify({
    ...sample(),notesByDay:{'2026-11-04':[]}
  }));
  const denied=await app.api.rehearsePreviewTodayRowSeal(
    app.token(),'too-late');
  assert.equal(denied.reason,'today_preview_seal_parity_required',
    JSON.stringify(denied));
  assert.equal(denied.prerequisiteReason,'today_preview_source_stale');
  assert.equal(denied.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Today legacy sealing quota failure leaves the original receipt and rows intact',async()=>{
  const app=await seeded();
  const db=app.indexedDB._databases.get(DB);
  const oldMeta={...db._stores.get('meta').get('today-preview')};
  const oldReceipt={...db._stores.get('mutations').get('today-preview-seed:first')};
  delete oldMeta.recordsFingerprint;
  delete oldReceipt.recordsFingerprint;
  db._stores.get('meta').set('today-preview',oldMeta);
  db._stores.get('mutations').set('today-preview-seed:first',oldReceipt);
  const before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'mutations',operation:'add',
    error:new Error('QuotaExceededError')});
  const denied=await app.api.rehearsePreviewTodayRowSeal(
    app.token(),'quota-seal');
  assert.equal(denied.reason,'today_preview_seal_atomic_write_failed',
    JSON.stringify(denied));
  assert.equal(denied.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});
