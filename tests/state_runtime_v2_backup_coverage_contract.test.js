'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');

const script=fs.readFileSync(path.join(__dirname,'..',
  'state_runtime_v2.js'),'utf8');
const V1='taskpoints_v1';
const DARK='taskpoints_state_v2_dark_mode_v1';
function installCatalog(idb){
  idb.databases=async()=>Array.from(idb._databases,
    ([name,db])=>({name,version:db.version}));
}
async function boot({withCatalog=true,hostname='localhost'}={}){
  const localStorage=new FakeStorage({
    [DARK]:'1',
    [V1]:JSON.stringify({
      habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],
        iceKeys:[]}],
      tasks:[{id:'t1',title:'Keep task'}],
      completions:[],notes:'Keep Notes'
    }),
    tp_projects_v1:'[{"id":"p1","title":"Keep Project"}]'
  });
  const indexedDB=new FakeIndexedDB();
  if(withCatalog)installCatalog(indexedDB);
  const core={
    STORAGE_KEY:V1,IMAGE_DB_NAME:'taskpoints',
    IMAGE_STORE_NAME:'images',
    SHADOW_MIGRATION_DB_NAME:'taskpoints_shadow_v1',
    parseTaskPointsStorageJson(raw){return JSON.parse(raw);},
    readPendingHabitDeltas(){return [];},
    applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}};},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1));},
    writePendingHabitDelta(d){return {...d};},
    habitCompletionId(a,b){return 'habit:'+a+':'+b;}
  };
  const ctx={localStorage,indexedDB,structuredClone,TextEncoder,
    crypto:{subtle:webcrypto.subtle,randomUUID(){return 'coverage-id';}},
    navigator:{locks:{request:async(name,options,callback)=>
      callback({name})}},
    location:{hostname},TaskPointsCore:core,JSON,Date,Math,
    String,Number,Boolean,Array,Object,Map,Set,Promise,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  await ctx.TaskPointsStateRuntimeV2.seedFromLegacy();
  return {
    api:ctx.TaskPointsStateRuntimeV2,ctx,localStorage,indexedDB,
    token:()=>JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort()
      .map(key=>[key,localStorage.getItem(key)]))
  };
}
async function createDb(idb,name,storeName){
  const req=idb.open(name,1);
  req.onupgradeneeded=()=>req.result.createObjectStore(storeName);
  return new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

test('read-only backup census sees localStorage plus V2, image and unknown IDB stores',async()=>{
  const a=await boot();
  const imageDb=await createDb(a.indexedDB,'taskpoints','images');
  const imageTx=imageDb.transaction('images','readwrite');
  const imageWritten=new Promise((resolve,reject)=>{
    const request=imageTx.objectStore('images').put({
      id:'image-01',payload:'opaque image bytes'
    });
    request.onsuccess=resolve;request.onerror=()=>reject(request.error);
  });
  await imageWritten;
  await new Promise(resolve=>{
    if(imageTx._finished)return resolve();
    imageTx.oncomplete=resolve;
  });
  const other=await createDb(a.indexedDB,'third_party_legacy','unknownStore');
  other.close();
  const first=a.token();
  const beforeState=a.indexedDB.dump('taskpoints_state_v2');
  const beforeImages=a.indexedDB.dump('taskpoints');
  const beforeCalls=a.indexedDB.openCalls.length;
  const evidence=await a.api.inspectPreviewIndependentBackupCoverage(first);
  assert.equal(evidence.reason,'backup_coverage_inventory_readonly_observed',
    JSON.stringify(evidence));
  assert.equal(evidence.localStorageInventoryStable,true);
  assert.equal(evidence.indexedDbCatalogStable,true);
  assert.equal(evidence.localStorage.keyCount,
    JSON.parse(first).length);
  assert.ok(evidence.localStorage.utf8Bytes>0);
  assert.equal(evidence.databaseCount,3);
  assert.ok(evidence.objectStoreCount>=3);
  assert.equal(evidence.imageDatabasePresent,true);
  assert.equal(evidence.imageStorePresent,true);
  assert.equal(evidence.imageRecordCount,1);
  assert.deepEqual(Array.from(evidence.unexpectedDatabases),
    ['third_party_legacy']);
  const v2=evidence.databaseInventory.find(x=>
    x.name==='taskpoints_state_v2');
  assert.ok(v2&&v2.recordCount>0);
  assert.equal(evidence.backupComplete,false);
  assert.equal(evidence.offDeviceBackupVerified,false);
  assert.equal(evidence.recordContentVerified,false);
  assert.equal(evidence.binaryImageBytesVerified,false);
  assert.equal(evidence.imageBytesIncludedInBackup,false);
  assert.equal(evidence.canRestore,false);
  assert.equal(evidence.canPromote,false);
  assert.equal(a.token(),first);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),beforeState);
  assert.deepEqual(a.indexedDB.dump('taskpoints'),beforeImages);
  assert.deepEqual(a.indexedDB.databaseNames(),
    ['taskpoints','taskpoints_state_v2','third_party_legacy']);
  assert.ok(a.indexedDB.openCalls.length>beforeCalls,
    'existing DBs counted without creating new ones');
});

test('backup coverage refuses missing IDB catalog without creating databases',async()=>{
  const a=await boot({withCatalog:false});
  const before=a.token(),dbNames=a.indexedDB.databaseNames();
  const opens=a.indexedDB.openCalls.length;
  const denied=await a.api.inspectPreviewIndependentBackupCoverage(before);
  assert.equal(denied.reason,'indexeddb_database_catalog_unavailable');
  assert.equal(denied.backupComplete,false);
  assert.equal(denied.canRestore,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.token(),before);
  assert.deepEqual(a.indexedDB.databaseNames(),dbNames);
  assert.equal(a.indexedDB.openCalls.length,opens);
});

test('backup coverage refuses stale localStorage token or non-preview production host',async()=>{
  const a=await boot();
  const before=a.token();
  a.localStorage.setItem('unrelated-old-tab-key','new text');
  const changed=await a.api.inspectPreviewIndependentBackupCoverage(before);
  assert.equal(changed.reason,'backup_coverage_origin_changed');
  a.ctx.location.hostname='taskpoints.pages.dev';
  const forbidden=await a.api.inspectPreviewIndependentBackupCoverage(
    a.token());
  assert.equal(forbidden.reason,'preview_host_required');
  assert.equal(forbidden.canPromote,false);
});

test('backup coverage detects database catalog changes across its count-only scan',async()=>{
  const a=await boot();
  let times=0;
  a.indexedDB.databases=async()=>{
    times++;
    return times===1
      ?[{name:'taskpoints_state_v2',version:6}]
      :[{name:'taskpoints_state_v2',version:6},
        {name:'new_old_tab_db',version:1}];
  };
  const before=a.token();
  const denied=await a.api.inspectPreviewIndependentBackupCoverage(before);
  assert.equal(denied.reason,'backup_coverage_inventory_changed',
    JSON.stringify(denied));
  assert.equal(denied.backupComplete,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.token(),before);
});

test('backup coverage refuses a vanishing IDB without resurrecting an empty database',async()=>{
  const a=await boot();
  const existing=a.indexedDB.databaseNames();
  a.indexedDB.databases=async()=>[
    {name:'taskpoints_state_v2',version:6},
    {name:'deleted_between_catalog_and_open',version:1}
  ];
  const evidence=await a.api.inspectPreviewIndependentBackupCoverage(
    a.token());
  assert.equal(evidence.reason,'backup_coverage_database_scan_unavailable',
    JSON.stringify(evidence));
  assert.equal(evidence.backupComplete,false);
  assert.equal(evidence.canRestore,false);
  assert.deepEqual(a.indexedDB.databaseNames(),existing);
});

test('backup coverage refuses an IDB count failure and preserves all source bytes',async()=>{
  const a=await boot();
  const before=a.token(),v2=a.indexedDB.dump('taskpoints_state_v2');
  a.indexedDB.failNext({
    store:'habits',operation:'count',error:new Error('read_abort')
  });
  const evidence=await a.api.inspectPreviewIndependentBackupCoverage(before);
  assert.equal(evidence.reason,'backup_coverage_database_scan_unavailable',
    JSON.stringify(evidence));
  assert.equal(evidence.backupComplete,false);
  assert.equal(a.token(),before);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),v2);
});

test('backup census rejects same-catalog record-count drift from an older tab',async()=>{
  const a=await boot();
  const imageDb=await createDb(a.indexedDB,'taskpoints','images');
  imageDb.close();
  const prior=a.token();
  const priorV2=a.indexedDB.dump('taskpoints_state_v2');
  const open=a.indexedDB.open.bind(a.indexedDB);
  let imageOpens=0;
  a.indexedDB.open=(name,version)=>{
    if(name==='taskpoints'&&++imageOpens===2){
      // An uncooperative tab creates a record after the first count.
      // The database catalog and localStorage remain unchanged.
      a.indexedDB._databases.get('taskpoints')
        ._stores.get('images')
        .set('late-image',{id:'late-image',payload:'keep image bytes'});
    }
    return open(name,version);
  };
  const denied=await a.api.inspectPreviewIndependentBackupCoverage(prior);
  assert.equal(denied.reason,'backup_coverage_record_count_changed',
    JSON.stringify(denied));
  assert.equal(denied.backupComplete,false);
  assert.equal(denied.canRestore,false);
  assert.equal(denied.canPromote,false);
  assert.equal(a.token(),prior);
  assert.deepEqual(a.indexedDB.dump('taskpoints_state_v2'),priorV2);
  assert.equal(a.indexedDB.dump('taskpoints').images.length,1,
    'read-only inspection must preserve the external write');
});

test('backup census recount does not claim content-level consistency',async()=>{
  const a=await boot();
  const token=a.token();
  const report=await a.api.inspectPreviewIndependentBackupCoverage(token);
  assert.equal(report.reason,'backup_coverage_inventory_readonly_observed',
    JSON.stringify(report));
  assert.equal(report.indexedDbRecordCountsRechecked,true);
  assert.equal(report.indexedDbRecordContentStable,false);
  assert.equal(report.recordContentVerified,false);
  assert.equal(report.binaryImageBytesVerified,false);
  assert.equal(report.offDeviceBackupVerified,false);
  assert.equal(report.backupComplete,false);
  assert.equal(report.canPromote,false);
});
