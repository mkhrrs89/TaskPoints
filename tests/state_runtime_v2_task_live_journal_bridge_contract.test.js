'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');

const ROOT=path.resolve(__dirname,'..');
const V2=fs.readFileSync(path.join(ROOT,'state_runtime_v2.js'),'utf8');
const JOURNAL=fs.readFileSync(path.join(ROOT,'task_mutation_journal.js'),'utf8');
const KEY='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1';
const PENDING='taskpoints_pending_task_mutations_v1';
const DB='taskpoints_state_v2';

function install({hostname='localhost',dark=true}={}){
  const localStorage=new FakeStorage({
    ...(dark?{[DARK]:'1'}:{}),
    [KEY]:JSON.stringify({
      habits:[{id:'habit-1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
      tasks:[{id:'a',title:'Original',status:'active'}],
      completions:[],notes:'Preserve notes',
      extraImportedField:{doNotLose:true}
    })
  });
  const indexedDB=new FakeIndexedDB();
  const timers=[];
  let idleAgo=10000,uuid=0,snapshotSaves=0;
  const core={
    STORAGE_KEY:KEY,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},
    applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(KEY))},
    loadAppState(){return {state:JSON.parse(localStorage.getItem(KEY))}},
    saveStateSnapshot(state){
      snapshotSaves++;
      localStorage.setItem(KEY,JSON.stringify(state));
      return {state};
    },
    getStorageMaintenanceIdleStatus(){return {lastInteractionAgoMs:idleAgo}},
    isStorageMaintenanceQuiet(){return true},
    noteStorageUserInteraction(){},
    clearStateHotCache(){},
    writePendingHabitDelta(row){return row},
    habitCompletionId(id,day){return 'habit:'+id+':'+day}
  };
  const context={
    TaskPointsCore:core,localStorage,indexedDB,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'task-bridge-'+ ++uuid}},
    location:{hostname},console:{log(){},warn(){},error(){}},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    setTimeout(fn,ms){timers.push({fn,ms});return timers.length},
    clearTimeout(){},
    document:{readyState:'loading',hidden:false,addEventListener(){}}
  };
  context.window=context;
  context.globalThis=context;
  vm.runInNewContext(V2,context,{filename:'state_runtime_v2.js'});
  vm.runInNewContext(JOURNAL,context,{filename:'task_mutation_journal.js'});
  return {
    core,context,indexedDB,localStorage,timers,
    api:context.TaskPointsStateRuntimeV2,
    setIdleAgo(value){idleAgo=value},
    snapshotSaves(){return snapshotSaves}
  };
}

test('real, already-verified V1 Task edits populate preview Tasks without switching authority',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  const before=app.indexedDB.dump(DB);
  app.core.journalTaskMutation({
    task:{id:'a',title:'First real Task edit',status:'active'}
  });
  const journalAfterFirst=app.localStorage.getItem(PENDING);
  const v1BeforeMirror=app.localStorage.getItem(KEY);
  assert.equal(JSON.parse(journalAfterFirst).tasks[0].title,'First real Task edit');
  assert.equal(app.snapshotSaves(),0,'foreground edit only writes the synchronous V1 journal');
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.deepEqual(app.indexedDB.dump(DB),before,
    'no V2 read/write work should run during the foreground Task save');
  const first=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(first.verified,true,first.reason);
  assert.equal(first.canPromote,false);
  assert.equal(app.localStorage.getItem(KEY),v1BeforeMirror);
  assert.equal(app.localStorage.getItem(PENDING),journalAfterFirst);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,'First real Task edit');

  app.core.journalTaskMutation({
    task:{id:'a',title:'Second real Task edit',status:'active'}
  });
  const rawAfterSecond=app.localStorage.getItem(PENDING);
  const second=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(second.verified,true,second.reason);
  assert.equal(app.localStorage.getItem(PENDING),rawAfterSecond);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,'Second real Task edit');
  assert.equal((await app.api.inspectPreviewTaskCollectionParity()).match,true);
  assert.equal(app.snapshotSaves(),0);
  assert.equal(app.api.getObservedLegacyTaskStatus().verified,2);
  assert.equal(app.api.getObservedLegacyTaskStatus().running,false);
});

test('automatic Task observer yields to user activity and never blocks the foreground journal',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskMutation({task:{id:'a',title:'Real changed task'}});
  const queued=app.timers.find(t=>t.ms===9000);
  assert.ok(queued,'preview mirror must run only after a long quiet delay');
  app.setIdleAgo(150);
  queued.fn();
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.equal(app.api.getObservedLegacyTaskStatus().lastReason,'waiting_for_idle');
  assert.equal(app.api.getObservedLegacyTaskStatus().idleDeferrals,1);
  assert.equal(app.indexedDB.dump(DB).tasks.length,0,
    'active use cannot trigger an automatic preview Task seed');
  const nextQuietWindow=app.timers.filter(t=>t.ms===9000).at(-1);
  assert.notStrictEqual(nextQuietWindow,queued,
    'active-use deferral schedules a later bounded background opportunity');
  app.setIdleAgo(10000);
  nextQuietWindow.fn();
  const outcome=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(outcome.verified,true,outcome.reason);
  assert.equal(app.api.getObservedLegacyTaskStatus().idleDeferrals,0);
  assert.equal(app.core.getTaskMutationJournalStatus().journalWritesVerified,1);
});

test('unrelated Work/SCWM completion batches do not start unnecessary V2 Task scans',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskCompletionBatch([
    {id:'work-metric',title:'Work Score',source:'work',points:8},
    {id:'sleep-metric',title:'Sleep Score',source:'metric',points:7}
  ]);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.timers.some(t=>t.ms===9000),false);
  assert.equal(app.indexedDB.dump(DB).tasks.length,0);
  // Real Task-associated completion edits should still be observable.
  app.core.journalTaskCompletionBatch([
    {id:'task-completion',taskId:'a',points:3}
  ]);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.equal(app.timers.some(t=>t.ms===9000),true);
});

test('production hostname and dark-disabled mode never queue preview Task work',()=>{
  for(const options of [{hostname:'taskpoints.pages.dev',dark:true},
                       {hostname:'localhost',dark:false}]){
    const app=install(options);
    app.core.journalTaskMutation({task:{id:'a',title:'V1 still saves'}});
    assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
    assert.equal(app.api.getObservedLegacyTaskStatus().attempts,0);
    assert.equal(app.indexedDB.databaseNames().includes(DB),false);
    assert.equal(JSON.parse(app.localStorage.getItem(PENDING)).tasks[0].title,
      'V1 still saves');
  }
});

test('a failed real Task journal write cannot enqueue or mirror an uncommitted Task',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  const prior=app.indexedDB.dump(DB);
  const set=app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem=(key,value)=>{
    if(key===PENDING)throw new Error('simulated quota denial');
    return set(key,value);
  };
  assert.throws(()=>app.core.journalTaskMutation({
    task:{id:'a',title:'Rejected foreground save'}
  }),/simulated quota denial/);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.deepEqual(app.indexedDB.dump(DB),prior);
  assert.equal(app.localStorage.getItem(PENDING),null);
});

test('preview Task seeding preserves inexplicable unowned rows rather than clearing them',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  const store=app.indexedDB._databases.get(DB)._stores.get('tasks');
  store.set('preview-unowned',{id:'preview-unowned',legacyIndex:0,
    value:{id:'preview-unowned',title:'Never clear this unowned preview row'}});
  const before=app.indexedDB.dump(DB);
  const result=await app.api.rehearsePreviewTaskCollectionSeed();
  assert.equal(result.verified,false);
  assert.equal(result.reason,'task_preview_unowned_rows_preserved');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('rotated reset generation prevents queued legacy Task observation from becoming verified',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskMutation({task:{id:'a',title:'Pending at reset'}});
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(app.api.GENERATION_KEY,'rotated-by-reset');
  const outcome=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(outcome.verified,false);
  assert.equal(outcome.canPromote,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().verified,0);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal(JSON.parse(app.localStorage.getItem(PENDING)).tasks[0].title,
    'Pending at reset');
});
