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

function install({hostname='localhost',dark=true,sharedStorage=null,sharedIndexedDB=null}={}){
  const localStorage=sharedStorage || new FakeStorage({
    ...(dark?{[DARK]:'1'}:{}),
    [KEY]:JSON.stringify({
      habits:[{id:'habit-1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
      tasks:[{id:'a',title:'Original',status:'active'}],
      completions:[],notes:'Preserve notes',
      extraImportedField:{doNotLose:true}
    })
  });
  // The shipped core bundle loads state_runtime_v2_generation.js before
  // task_mutation_journal.js. Bootstrap the same durable V2 epoch here so
  // a synthetic Task journal is never incorrectly installed unbound.
  if (dark && hostname === 'localhost'
    && localStorage.getItem('taskpoints_state_v2_generation_v1') === null)
    localStorage.setItem('taskpoints_state_v2_generation_v1',
      'v2-bootstrap:synthetic-task-live-journal-test');
  const indexedDB=sharedIndexedDB || new FakeIndexedDB();
  const timers=[]
  const documentListeners=new Map();
  const windowListeners=new Map();
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
    addEventListener(type,fn){
      const handlers=windowListeners.get(type) || [];
      handlers.push(fn);
      windowListeners.set(type,handlers);
    },
    document:{readyState:'loading',hidden:false,
      addEventListener(type,fn){documentListeners.set(type,fn)}}
  };
  context.window=context;
  context.globalThis=context;
  vm.runInNewContext(V2,context,{filename:'state_runtime_v2.js'});
  vm.runInNewContext(JOURNAL,context,{filename:'task_mutation_journal.js'});
  return {
    core,context,indexedDB,localStorage,timers,documentListeners,windowListeners,
    emitStorage(event){
      for(const fn of windowListeners.get('storage') || [])fn(event);
    },
    api:context.TaskPointsStateRuntimeV2,
    setIdleAgo(value){idleAgo=value},
    snapshotSaves(){return snapshotSaves}
  };
}

test('preview restart queues a bounded idle Task catch-up after V1 journal already compacted',async()=>{
  const app=install();
  // A previous page closed after V1 Task data was committed, but before
  // the optional V2 background observer ran. There is no pending journal
  // left to notify V2 of the task change.
  const saved=JSON.parse(app.localStorage.getItem(KEY));
  saved.tasks[0].title='Durable task from previous closed page';
  app.localStorage.setItem(KEY,JSON.stringify(saved));
  assert.equal(app.localStorage.getItem(PENDING),null);
  const initialV1=app.localStorage.getItem(KEY);
  const start=app.documentListeners.get('DOMContentLoaded');
  assert.equal(typeof start,'function');
  await start();
  // The DOM bootstrap returns the dark-startup promise; its catch-up
  // continuation is a microtask and schedules only the low-priority timer.
  await Promise.resolve();
  assert.equal(app.api.getObservedLegacyTaskStatus().startupCatchupRequests,1);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.equal(app.api.getObservedLegacyTaskStatus().attempts,0,
    'no Task collection scan runs as part of startup/foreground paint');
  assert.equal(app.indexedDB.dump(DB).tasks.length,0);
  assert.equal(app.timers.some(t=>t.ms===9000),true);
  const outcome=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(outcome.verified,true,outcome.reason);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,
    'Durable task from previous closed page');
  assert.equal(app.localStorage.getItem(KEY),initialV1);
  assert.equal(app.localStorage.getItem(PENDING),null);
  assert.equal(app.snapshotSaves(),0);
  assert.equal(app.api.getObservedLegacyTaskStatus().verified,1);
});

test('cold preview reload reconciles stale Tasks even when older V1 edit already compacted',async()=>{
  const before=install();
  await before.api.seedFromLegacy();
  const original=await before.api.rehearsePreviewTaskCollectionSeed();
  assert.equal(original.verified,true,original.reason);
  assert.equal(before.indexedDB.dump(DB).tasks[0].value.title,'Original');
  const persisted=JSON.parse(before.localStorage.getItem(KEY));
  persisted.tasks[0].title='Edited while old page was closing';
  persisted.tasks.push({id:'new-during-restart',title:'Added before reopening',status:'active'});
  before.localStorage.setItem(KEY,JSON.stringify(persisted));
  // After compaction the authoritative Task journal is absent: a new page
  // cannot rely on a journal notification to discover these newer tasks.
  assert.equal(before.localStorage.getItem(PENDING),null);
  const durableBefore=before.localStorage.getItem(KEY);
  const after=install({
    sharedStorage:before.localStorage,
    sharedIndexedDB:before.indexedDB
  });
  await after.documentListeners.get('DOMContentLoaded')();
  await Promise.resolve();
  assert.equal(after.api.getObservedLegacyTaskStatus().pending,true);
  assert.equal(after.api.getObservedLegacyTaskStatus().attempts,0);
  assert.equal(after.indexedDB.dump(DB).tasks[0].value.title,'Original');
  const reconciled=await after.api.flushObservedLegacyTaskJournal();
  assert.equal(reconciled.verified,true,reconciled.reason);
  const tasks=after.indexedDB.dump(DB).tasks.map(row=>row.value);
  assert.equal(tasks.find(row=>row.id==='a').title,
    'Edited while old page was closing');
  assert.equal(tasks.find(row=>row.id==='new-during-restart').title,
    'Added before reopening');
  assert.equal((await after.api.inspectPreviewTaskCollectionParity()).match,true);
  assert.equal(after.localStorage.getItem(KEY),durableBefore);
  assert.equal(after.localStorage.getItem(PENDING),null);
  assert.equal(after.snapshotSaves(),0);
  assert.equal(after.api.getObservedLegacyTaskStatus().startupCatchupRequests,1);
  assert.equal(reconciled.canPromote,false);
});

test('one preview Task catch-up is scheduled per startup generation without duplicate loops',async()=>{
  const app=install();
  const start=app.documentListeners.get('DOMContentLoaded');
  await start();
  await Promise.resolve();
  const before=app.timers.filter(t=>t.ms===9000).length;
  assert.equal(before,1);
  await start();
  await Promise.resolve();
  assert.equal(app.timers.filter(t=>t.ms===9000).length,before);
  assert.equal(app.api.getObservedLegacyTaskStatus().startupCatchupRequests,1);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
});

test('production or dark-disabled startup never schedules preview Task catch-up',async()=>{
  for(const config of [{hostname:'taskpoints.pages.dev',dark:true},
    {hostname:'localhost',dark:false}]){
    const app=install(config);
    const start=app.documentListeners.get('DOMContentLoaded');
    if(start)await start();
    await Promise.resolve();
    assert.equal(app.api.getObservedLegacyTaskStatus().startupCatchupRequests,0);
    assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
    assert.equal(app.timers.some(t=>t.ms===9000),false);
  }
});

test('another tab changing the authoritative V1 snapshot queues an idle Task preview reconciliation',async()=>{
  const previous=install();
  await previous.api.seedFromLegacy();
  const seed=await previous.api.rehearsePreviewTaskCollectionSeed();
  assert.equal(seed.verified,true,seed.reason);
  const peer=install({sharedStorage:previous.localStorage,
    sharedIndexedDB:previous.indexedDB});
  await peer.documentListeners.get('DOMContentLoaded')();
  await Promise.resolve();
  assert.equal((await peer.api.flushObservedLegacyTaskJournal()).verified,true);
  const original=peer.localStorage.getItem(KEY);
  const changed=JSON.parse(original);
  changed.tasks[0].title='Peer edited this Task without a new journal';
  changed.tasks.push({id:'peer-created',title:'Peer-created Task',status:'active'});
  const changedRaw=JSON.stringify(changed);
  peer.localStorage.setItem(KEY,changedRaw);
  const beforeDb=peer.indexedDB.dump(DB);
  const beforeStatus=peer.api.getObservedLegacyTaskStatus();
  peer.emitStorage({key:KEY,oldValue:original,newValue:changedRaw,
    storageArea:peer.localStorage});
  const queued=peer.api.getObservedLegacyTaskStatus();
  assert.equal(queued.peerStorageListenerInstalled,true);
  assert.equal(queued.peerStorageNotifications,1);
  assert.equal(queued.peerStorageCatchupRequests,1);
  assert.equal(queued.pending,true);
  assert.equal(queued.attempts,beforeStatus.attempts,
    'cross-tab event must not start an immediate full Task read');
  assert.deepEqual(peer.indexedDB.dump(DB),beforeDb,
    'event handler may not write IndexedDB before the idle timer');
  assert.equal(peer.timers.at(-1).ms,9000);
  const result=await peer.api.flushObservedLegacyTaskJournal();
  assert.equal(result.verified,true,result.reason);
  assert.equal((await peer.api.inspectPreviewTaskCollectionParity()).match,true);
  assert.equal(peer.localStorage.getItem(KEY),changedRaw);
  assert.equal(peer.snapshotSaves(),0);
  assert.equal(peer.api.getStatus().readAuthority,'legacy_only');
});

test('peer V1 pending Task journal edits mirror without compacting or changing its bytes',async()=>{
  const tabA=install();
  await tabA.api.seedFromLegacy();
  assert.equal((await tabA.api.rehearsePreviewTaskCollectionSeed()).verified,true);
  const tabB=install({sharedStorage:tabA.localStorage,
    sharedIndexedDB:tabA.indexedDB});
  await tabB.documentListeners.get('DOMContentLoaded')();
  await Promise.resolve();
  await tabB.api.flushObservedLegacyTaskJournal();
  const prior=tabB.localStorage.getItem(PENDING);
  tabA.core.journalTaskMutation({task:{id:'a',
    title:'Durable V1 Task edit from another tab',status:'completed'}});
  const raw=tabB.localStorage.getItem(PENDING);
  assert.ok(raw);
  const dbBefore=tabB.indexedDB.dump(DB);
  tabB.emitStorage({key:PENDING,oldValue:prior,newValue:raw,
    storageArea:tabB.localStorage});
  assert.deepEqual(tabB.indexedDB.dump(DB),dbBefore);
  const result=await tabB.api.flushObservedLegacyTaskJournal();
  assert.equal(result.verified,true,result.reason);
  assert.equal(tabB.indexedDB.dump(DB).tasks[0].value.title,
    'Durable V1 Task edit from another tab');
  assert.equal(tabB.localStorage.getItem(PENDING),raw,
    'V2 shadow may never compact or remove the peer V1 pending journal');
  assert.equal(tabB.snapshotSaves(),0);
  assert.equal(tabB.api.getStatus().readAuthority,'legacy_only');
});

test('peer observer ignores unrelated keys, unchanged bytes, other storage and disabled preview',async()=>{
  const app=install();
  await app.documentListeners.get('DOMContentLoaded')();
  await Promise.resolve();
  await app.api.flushObservedLegacyTaskJournal();
  const before=app.api.getObservedLegacyTaskStatus();
  for(const event of [
    {key:'tp_appearance_v1',oldValue:'a',newValue:'b'},
    {key:KEY,oldValue:'same',newValue:'same'},
    {key:null,oldValue:null,newValue:null},
    {key:PENDING,oldValue:null,newValue:'new',storageArea:new FakeStorage()}
  ])app.emitStorage(event);
  const after=app.api.getObservedLegacyTaskStatus();
  assert.equal(after.pending,false);
  assert.equal(after.peerStorageNotifications,before.peerStorageNotifications);
  assert.equal(after.peerStorageCatchupRequests,before.peerStorageCatchupRequests);
  app.api.disableDarkMirror();
  app.emitStorage({key:PENDING,oldValue:null,newValue:'new',
    storageArea:app.localStorage});
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().peerStorageNotifications,0);
  const prod=install({hostname:'taskpoints.pages.dev'});
  await prod.documentListeners.get('DOMContentLoaded')();
  prod.emitStorage({key:KEY,oldValue:'old',newValue:'new',
    storageArea:prod.localStorage});
  assert.equal(prod.api.getObservedLegacyTaskStatus().peerStorageListenerInstalled,false);
  assert.equal(prod.api.getObservedLegacyTaskStatus().peerStorageCatchupRequests,0);
});

test('hidden preview Task mirror resumes its deferred idle window when tab becomes visible',async()=>{
  const app=install();
  await app.documentListeners.get('DOMContentLoaded')();
  await Promise.resolve();
  const first=app.timers.filter(timer=>timer.ms===9000).at(-1);
  assert.ok(first,'startup Task preview should have a deferred timer');
  const beforeDb=app.indexedDB.dump(DB);
  app.context.document.hidden=true;
  app.context.document.visibilityState='hidden';
  first.fn();
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.equal(app.api.getObservedLegacyTaskStatus().attempts,0);
  assert.deepEqual(app.indexedDB.dump(DB),beforeDb,
    'hidden tab cannot write preview data');
  const beforeCount=app.timers.filter(timer=>timer.ms===9000).length;
  app.context.document.hidden=false;
  app.context.document.visibilityState='visible';
  const visible=app.documentListeners.get('visibilitychange');
  assert.equal(typeof visible,'function');
  visible();
  const status=app.api.getObservedLegacyTaskStatus();
  assert.equal(status.visibilityResumeListenerInstalled,true);
  assert.equal(status.visibilityResumeRequests,1);
  assert.equal(app.timers.filter(timer=>timer.ms===9000).length,beforeCount+1);
  assert.equal(status.attempts,0,
    'visibility listener must only schedule work, never run an IDB scan');
  const result=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(result.verified,true,result.reason);
  assert.equal(app.api.getStatus().readAuthority,'legacy_only');
  assert.equal(app.snapshotSaves(),0);
});

test('visibility events cannot duplicate pending timers or reactivate disabled V2 preview',async()=>{
  const app=install();
  const start=app.documentListeners.get('DOMContentLoaded');
  await start();
  await Promise.resolve();
  const visible=app.documentListeners.get('visibilitychange');
  const firstCount=app.timers.filter(timer=>timer.ms===9000).length;
  visible();
  visible();
  assert.equal(app.timers.filter(timer=>timer.ms===9000).length,firstCount);
  await start();
  assert.equal(app.api.getObservedLegacyTaskStatus().visibilityResumeRequests,0);
  app.api.disableDarkMirror();
  const previous=app.timers.filter(timer=>timer.ms===9000).length;
  visible();
  assert.equal(app.timers.filter(timer=>timer.ms===9000).length,previous);
  assert.equal(app.api.getObservedLegacyTaskStatus().visibilityResumeRequests,0);
  const prod=install({hostname:'taskpoints.pages.dev'});
  await prod.documentListeners.get('DOMContentLoaded')();
  assert.equal(prod.api.getObservedLegacyTaskStatus().visibilityResumeListenerInstalled,false);
  assert.equal(prod.api.getObservedLegacyTaskStatus().visibilityResumeRequests,0);
  // Other preexisting runtime modules may legitimately subscribe to
  // visibilitychange in production; this test only owns the Task observer.
});

test('peer observer installs only one listener despite repeated coordinated startup',async()=>{
  const app=install();
  const start=app.documentListeners.get('DOMContentLoaded');
  await start();
  await Promise.resolve();
  const listeners=app.windowListeners.get('storage').length;
  await start();
  await Promise.resolve();
  assert.equal(app.windowListeners.get('storage').length,listeners);
  assert.equal(app.api.getObservedLegacyTaskStatus().peerStorageListenerInstalled,true);
  const initial=app.api.getObservedLegacyTaskStatus().peerStorageNotifications;
  app.emitStorage({key:KEY,oldValue:'before',newValue:'after',
    storageArea:app.localStorage});
  assert.equal(app.api.getObservedLegacyTaskStatus().peerStorageNotifications,
    initial+1,'repeating startup must never attach duplicate peer handlers');
});

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


test('transient V1 journal read denial requeues only a delayed, bounded V2 Task catch-up',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskMutation({task:{id:'a',title:'Saved while storage flaky'}});
  const durableJournal=app.localStorage.getItem(PENDING);
  const durableSnapshot=app.localStorage.getItem(KEY);
  const before=app.indexedDB.dump(DB);
  const get=app.localStorage.getItem.bind(app.localStorage);
  let deny=true;
  app.localStorage.getItem=key=>{
    if(deny&&key===PENDING)throw Error('temporary storage denial');
    return get(key);
  };
  const refused=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(refused.verified,false);
  assert.equal(refused.reason,'task_preview_observation_failed');
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,1);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true);
  assert.ok(app.timers.filter(t=>t.ms===9000).length>=2);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  deny=false;
  const recovered=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(recovered.verified,true,recovered.reason);
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,'Saved while storage flaky');
  assert.equal(app.localStorage.getItem(PENDING),durableJournal);
  assert.equal(app.localStorage.getItem(KEY),durableSnapshot);
  assert.equal(app.snapshotSaves(),0);
  assert.equal(app.api.getStatus().readAuthority,'legacy_only');
});

test('repeated Task mirror read denials stop after two retries until a new durable edit',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskMutation({task:{id:'a',title:'Keep pending V1'}}); 
  const durable=app.localStorage.getItem(PENDING);
  const get=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=key=>{
    if(key===PENDING)throw Error('denied repeatedly');
    return get(key);
  };
  for(let attempt=1;attempt<=3;attempt++){
    const declined=await app.api.flushObservedLegacyTaskJournal();
    assert.equal(declined.verified,false);
    assert.equal(declined.reason,'task_preview_observation_failed');
    const state=app.api.getObservedLegacyTaskStatus();
    assert.equal(state.transientRetryCount,Math.min(attempt,2));
    assert.equal(state.maxTransientRetries,2);
    assert.equal(state.pending,attempt<3);
  }
  assert.equal((await app.api.flushObservedLegacyTaskJournal()).reason,
    'no_pending_task_observation');
  assert.equal(app.api.getObservedLegacyTaskStatus().attempts,3);
  app.localStorage.getItem=get;
  assert.equal(app.localStorage.getItem(PENDING),durable);
  assert.equal(app.indexedDB.dump(DB).tasks.length,0);
  app.core.journalTaskMutation({task:{id:'a',title:'New durable V1 retry event'}});
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  assert.equal((await app.api.flushObservedLegacyTaskJournal()).verified,true);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,
    'New durable V1 retry event');
  assert.equal(app.snapshotSaves(),0);
});

test('malformed pending Task journal is never auto-retried or normalized by V2',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.localStorage.setItem(PENDING,'{"schemaVersion":1,"tasks":[');
  const saved=app.localStorage.getItem(PENDING);
  app.api.queueObservedLegacyTaskJournal();
  const result=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(result.reason,'legacy_task_journal_unreadable');
  assert.equal(result.verified,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  assert.equal(app.localStorage.getItem(PENDING),saved);
  assert.equal(app.indexedDB.dump(DB).tasks.length,0);
  assert.equal(app.snapshotSaves(),0);
});

test('reset generation rotation suppresses a retry after an observed source failure',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  app.core.journalTaskMutation({task:{id:'a',title:'Old generation Task'}});
  const pending=app.localStorage.getItem(PENDING);
  const get=app.localStorage.getItem.bind(app.localStorage);
  let rotated=false;
  app.localStorage.getItem=key=>{
    if(key===PENDING&&!rotated){
      rotated=true;
      app.localStorage.setItem(app.api.GENERATION_KEY,'newer-reset-generation');
      throw Error('source read raced reset');
    }
    return get(key);
  };
  const declined=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(declined.reason,'task_preview_observation_failed');
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  assert.equal(app.localStorage.getItem(PENDING),pending);
  assert.equal(app.indexedDB.dump(DB).tasks.length,0);
  assert.equal(app.snapshotSaves(),0);
});


test('peer edit arriving during final parity is retried and verified without losing the V1 source',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  assert.equal((await app.api.rehearsePreviewTaskCollectionSeed()).verified,true);
  const initial=JSON.parse(app.localStorage.getItem(KEY));
  const updated={...initial,
    tasks:[{...initial.tasks[0],title:'Peer edit arriving during final parity'}]};
  const updatedRaw=JSON.stringify(updated);
  const originalSubtle=app.context.crypto.subtle;
  const originalDigest=originalSubtle.digest.bind(originalSubtle);
  let digests=0;
  app.context.crypto.subtle={
    digest:async(...args)=>{
      const hashed=await originalDigest(...args);
      // First digest authenticates the already-seeded Task mirror. The
      // second is parity's digest; mutate V1 after hashing but before
      // the parity inspector's final V1 source recheck.
      if(++digests===2)app.localStorage.setItem(KEY,updatedRaw);
      return hashed;
    }
  };
  app.api.queueObservedLegacyTaskJournal();
  const first=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(digests>=2,true,'parity must separately hash Tasks');
  assert.equal(first.verified,false);
  assert.equal(first.reason,'legacy_changed_before_inspection');
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,true,
    'durable peer edit discovered during parity must get a bounded retry');
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,1);
  assert.equal(app.localStorage.getItem(KEY),updatedRaw);
  app.context.crypto.subtle=originalSubtle;
  const second=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(second.verified,true,second.reason);
  assert.equal(app.api.getObservedLegacyTaskStatus().pending,false);
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  assert.equal(app.indexedDB.dump(DB).tasks[0].value.title,
    'Peer edit arriving during final parity');
  assert.equal(app.localStorage.getItem(KEY),updatedRaw);
  assert.equal(app.localStorage.getItem(PENDING),null);
  assert.equal(app.snapshotSaves(),0);
  assert.equal(app.api.getStatus().readAuthority,'legacy_only');
});

test('repeated peer source churn is bounded and does not certify a stale Task shadow',async()=>{
  const app=install();
  await app.api.seedFromLegacy();
  assert.equal((await app.api.rehearsePreviewTaskCollectionSeed()).verified,true);
  const read=app.core.readTaskPointsStoredState;
  let reads=0,updates=0;
  app.core.readTaskPointsStoredState=()=>{
    if(++reads%2===0){
      const previous=JSON.parse(app.localStorage.getItem(KEY));
      previous.tasks[0].title='Peer churn revision '+(++updates);
      app.localStorage.setItem(KEY,JSON.stringify(previous));
    }
    return read();
  };
  app.api.queueObservedLegacyTaskJournal();
  for(let attempt=1;attempt<=3;attempt++){
    const observed=await app.api.flushObservedLegacyTaskJournal();
    assert.equal(observed.verified,false);
    const status=app.api.getObservedLegacyTaskStatus();
    assert.equal(status.transientRetryCount,Math.min(attempt,2));
    assert.equal(status.pending,attempt<3,
      'only the first two parity refusals may schedule another attempt');
  }
  assert.equal((await app.api.flushObservedLegacyTaskJournal()).reason,
    'no_pending_task_observation');
  assert.equal(app.api.getObservedLegacyTaskStatus().attempts,3);
  assert.equal(app.api.getObservedLegacyTaskStatus().verified,0);
  assert.equal(app.snapshotSaves(),0);
  app.core.readTaskPointsStoredState=read;
  app.api.queueObservedLegacyTaskJournal();
  assert.equal(app.api.getObservedLegacyTaskStatus().transientRetryCount,0);
  const recovered=await app.api.flushObservedLegacyTaskJournal();
  assert.equal(recovered.verified,true,recovered.reason);
  assert.equal((await app.api.inspectPreviewTaskCollectionParity()).match,true);
  assert.equal(app.api.getStatus().readAuthority,'legacy_only');
});
