'use strict';
// M01: execute real production storage writers in disposable Node VMs.
// These behavior witnesses are NOT V2 production owner/generation-fence certification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT=path.join(__dirname,'..');
const V1='taskpoints_v1';
const SNAPSHOT=JSON.stringify({tasks:[{id:'preserve-task'}],goldLedger:[{id:'preserve-gold',amount:18}],unknownImportedField:{retain:true}});
const MODE='taskpoints_phase4_storage_mode_v1';
const GATE='taskpoints_indexeddb_requalification_v1';
const LOCK='taskpoints_recovery_write_lock_v1';
const file=name=>fs.readFileSync(path.join(ROOT,name),'utf8');
function source(name,start,end){
  const s=file(name),i=s.indexOf(start),j=end?s.indexOf(end,i+start.length):s.length;
  assert.ok(i>=0 && j>i,'production anchor moved: '+name+' '+start+' -> '+end);
  return s.slice(i,j);
}
function storage(initial={},opt={}){
  const data=new Map([[V1,SNAPSHOT],...Object.entries(initial)]),writes=[];
  return {data,writes,
    getItem(key){if(opt.denyRead===key)throw Error('storage read denied');return data.get(String(key))??null},
    setItem(key,value){if(opt.denyWrite===key)throw Error('QuotaExceededError');writes.push([String(key),String(value)]);if(opt.ignoreWrite!==key)data.set(String(key),String(value))},
    removeItem(key){if(opt.denyRemove===key)throw Error('storage removal denied');writes.push([String(key),null]);data.delete(String(key))}
  };
}
function inspect(s){return JSON.parse(s.getItem(V1))}
function assertV1Untouched(s){assert.equal(s.getItem(V1),SNAPSHOT);assert.ok(!s.writes.some(([k])=>k===V1))}
function vmContext(options={}){
  const c={Date,Math,Number,String,JSON,Object,Array,Map,Set,Promise,
    console:{warn(){},error(){},log(){},count(){}},...options};
  c.window=c;c.globalThis=c;
  vm.createContext(c);
  return c;
}
function run(c,code,fileName='production'){vm.runInContext(code,c,{filename:fileName});return c}

// Route 1: Toolbar's real inbox auto-population writer.
function inboxHarness({changed=true,throwWrite=false}={}){
  const s=storage(),merges=[],events=[],checkpoints=[];
  const core={STORAGE_KEY:V1,
    loadAppState(){return {state:inspect(s)}},
    mergeAndSaveState(partial,opts){
      merges.push({partial,opts});
      if(throwWrite)throw Error('writer refused');
      s.setItem(V1,JSON.stringify({...inspect(s),...partial}));
      return {state:inspect(s)}
    }};
  const c=vmContext({TaskPointsCore:core,localStorage:s,
    tpInboxRevealDayKey(){return '2026-11-10'},
    tpInboxReadStorageFingerprint(){return 'source-fingerprint'},
    tpInboxScanCheckpointMatches(){return false},
    tpInboxWriteScanCheckpoint(info){checkpoints.push(info);return true},
    tpGenerateInboxMessages(before){
      return {changed,state:{...before,inboxMessages:[{id:'news-1',archived:false}],
        inboxProcessedEventIds:['processed-1'],inboxStartedDateKey:'2026-11-10'}}
    },
    CustomEvent:function(name,opts){this.type=name;this.detail=opts.detail},
    dispatchEvent(event){events.push(event)}});
  run(c,source('toolbar.js','function autoPopulateTaskPointsInbox(options = {}) {','window.TaskPointsInbox = {'),'toolbar.js');
  return {s,c,core,merges,events,checkpoints,populate:()=>vm.runInContext('autoPopulateTaskPointsInbox({force:true})',c)};
}
test('Toolbar Inbox auto-population persists only inbox domains and retains Gold and imported state',()=>{
  const h=inboxHarness(),r=h.populate();
  assert.equal(r.changed,true);
  assert.equal(h.merges.length,1);
  assert.equal(h.merges[0].opts.savePath,'inbox-auto-populate');
  assert.equal(h.merges[0].opts.immediateWrite,true);
  assert.deepEqual(Object.keys(h.merges[0].partial).sort(),
    ['inboxMessages','inboxProcessedEventIds','inboxStartedDateKey'].sort());
  assert.equal(inspect(h.s).goldLedger[0].id,'preserve-gold');
  assert.equal(inspect(h.s).unknownImportedField.retain,true);
  assert.equal(h.events[0].detail.count,1);
});
test('Toolbar Inbox denied write returns no success and preserves whole V1 snapshot',()=>{
  const h=inboxHarness({throwWrite:true});
  assert.equal(h.populate(),null);assert.equal(h.events.length,0);assertV1Untouched(h.s);
});

// Route 2: Toolbar's true delayed merge/snapshot writer.
function debouncedHarness({denySnapshot=false,skipSnapshot=false,preview=false}={}){
  const s=storage(preview
    ? {'taskpoints_state_v2_dark_mode_v1':'1','taskpoints_state_v2_generation_v1':'epoch-a'}
    : {}),timers=[],listeners={},writes=[];
  let denied=denySnapshot,skipped=skipSnapshot;
  const core={STORAGE_KEY:V1,
    mergeState(partial,{existing}={}){return {state:{...(existing||inspect(s)),...partial}}},
    mergeAndSaveState(partial,opts={}){const next={...inspect(s),...partial};s.setItem(V1,JSON.stringify(next));return {state:next}},
    saveStateSnapshot(next,opts={}){
      writes.push({next,opts});
      if(denied)throw Error('snapshot refused');
      if(skipped)return {state:next,skipped:true,blockedByQuotaCircuit:true};
      s.setItem(V1,JSON.stringify(next));return {state:next};
    }
  };
  const c=vmContext({TaskPointsCore:core,STORAGE_KEY_FALLBACK:V1,localStorage:s,
    TP_PERSIST_DEBOUNCE_MS:900,document:{addEventListener(name,fn){listeners['doc:'+name]=fn},visibilityState:'visible'},
    addEventListener(name,fn){listeners[name]=fn},
    setTimeout(fn){timers.push(fn);return timers.length},
    clearTimeout(){},requestIdleCallback:null
  });
  run(c,source('toolbar.js','function setupDebouncedPersistence() {','setupDebouncedPersistence();')+'\nsetupDebouncedPersistence();','toolbar.js');
  return {s,core,timers,writes,listeners,allowSnapshot(){denied=false;skipped=false}};
}
test('Toolbar debounced merges flush the latest full state and preserve untouched snapshot fields',()=>{
  const h=debouncedHarness();
  h.core.mergeAndSaveState({notes:'one'});
  h.core.mergeAndSaveState({notes:'two'});
  assertV1Untouched(h.s);
  h.core.flushPendingSaves();
  assert.equal(h.writes.length,1);
  assert.equal(inspect(h.s).notes,'two');
  assert.equal(inspect(h.s).goldLedger[0].id,'preserve-gold');
  assert.equal(inspect(h.s).unknownImportedField.retain,true);
  h.core.flushPendingSaves();
  assert.equal(h.writes.length,1,'no duplicate flush');
});
test('Toolbar denied deferred snapshot flush does not claim a durable save',()=>{
  const h=debouncedHarness({denySnapshot:true});
  h.core.mergeAndSaveState({notes:'nondurable'});
  assert.throws(()=>h.core.flushPendingSaves(),/snapshot refused/);
  assertV1Untouched(h.s);
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,1);
  h.allowSnapshot();
  h.core.flushPendingSaves();
  assert.equal(inspect(h.s).notes,'nondurable','pending edit is retried after quota clears');
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,0);
});

test('Toolbar skipped quota-cooldown result retains the queued save until acknowledged',()=>{
  const h=debouncedHarness({skipSnapshot:true});
  h.core.mergeAndSaveState({notes:'queued-under-quota'});
  assert.throws(()=>h.core.flushPendingSaves(),
    error=>error.code==='TASKPOINTS_DEFERRED_SAVE_NOT_DURABLE');
  assertV1Untouched(h.s);
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,1);
  h.allowSnapshot();
  h.core.flushPendingSaves();
  assert.equal(inspect(h.s).notes,'queued-under-quota');
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,0);
});

test('Toolbar V2 preview refuses known stale queued snapshot after a peer edits V1',()=>{
  const h=debouncedHarness({preview:true});
  h.core.mergeAndSaveState({notes:'stale-tab'});
  const newer={...inspect(h.s),goldLedger:[{id:'newer-gold',amount:100}]};
  h.s.setItem(V1,JSON.stringify(newer));
  assert.throws(()=>h.core.flushPendingSaves(),
    error=>error.code==='TASKPOINTS_V2_PREVIEW_DEFERRED_SOURCE_CHANGED');
  assert.equal(inspect(h.s).goldLedger[0].id,'newer-gold');
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,1);
  assert.equal(h.core.getDeferredSaveSafetyStatus().blockedStalePreviewFlushes,1);
});

test('Toolbar V2 preview rejects delayed writes across reset generation rotation',()=>{
  const h=debouncedHarness({preview:true});
  h.core.queueStateSnapshot({...inspect(h.s),notes:'pre-reset'});
  h.s.setItem('taskpoints_state_v2_generation_v1','epoch-b');
  assert.throws(()=>h.core.flushPendingSaves(),
    error=>error.code==='TASKPOINTS_V2_PREVIEW_DEFERRED_SOURCE_CHANGED');
  assertV1Untouched(h.s);
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,1);
});

test('Toolbar preview freshness gate never changes normal V1 save behavior',()=>{
  const h=debouncedHarness();
  h.core.mergeAndSaveState({notes:'allowed-nonpreview'});
  h.core.flushPendingSaves();
  assert.equal(inspect(h.s).notes,'allowed-nonpreview');
  assert.equal(h.core.getDeferredSaveSafetyStatus().pendingKeys.length,0);
  assert.equal(h.core.getDeferredSaveSafetyStatus().allLegacyWritersFenced,false);
});

// Route 3: verified-secondary restore's actual lock sequence and exact readback.
function secondaryLockHarness(opt={}){
  const s=storage({},opt);
  const c=vmContext({localStorage:s,crypto:{randomUUID(){return 'verified-restore-token'}}});
  const pre="const global=window;const LOCK_KEY='"+LOCK+"';let recoveryLockToken='';let candidate={rawHash:'candidate-hash'};\n";
  run(c,pre+source('verified_secondary_restore.js','function createLockToken() {','function downloadPackage()'),'verified_secondary_restore.js');
  return {s,c,act:(name)=>vm.runInContext(name+'()',c)};
}
test('Verified secondary restore writes, verifies, quarantines and commits the recovery lock',()=>{
  const h=secondaryLockHarness();
  h.act('acquireRecoveryLock');
  assert.equal(JSON.parse(h.s.getItem(LOCK)).token,'verified-restore-token');
  h.act('markRecoveryAttemptWriteBoundary');
  assert.equal(JSON.parse(h.s.getItem(LOCK)).retainUntilManualRecovery,true);
  assert.equal(JSON.parse(h.s.getItem(LOCK)).createdAtMs,'9999999999999');
  assert.equal(h.act('finalizeRecoveryLock'),true);
  const final=JSON.parse(h.s.getItem(LOCK));
  assert.equal(final.retainUntilManualRecovery,false);
  assert.ok(Number(final.committedAtMs)>0);
  h.act('releaseUncommittedRecoveryLock');
  assert.ok(h.s.getItem(LOCK),'committed lock must remain');
  assertV1Untouched(h.s);
});
test('Verified secondary restore refuses an ignored lock write; cannot claim cross-tab protection',()=>{
  const h=secondaryLockHarness({ignoreWrite:LOCK});
  assert.throws(()=>h.act('acquireRecoveryLock'),/cross-tab recovery lock could not be acquired/);
  assert.equal(h.s.getItem(LOCK),null);
  assertV1Untouched(h.s);
});

// Route 4: actual secondary IndexedDB open and promotion writer.
function secondaryMirrorHarness({journalPending=false,sourceChanged=false}={}){
  const s=storage({'taskpoints_state_revision_v1':'revision-1'}),records=new Map(),
    puts=[],deletes=[],transactions=[],requests=[];
  const db={
    objectStoreNames:{contains(){return false}},
    createObjectStore(name,opts){db.created={name,opts}},
    transaction(name,mode){
      assert.equal(name,'snapshots');
      const tx={oncomplete:null,onabort:null,error:null,abort(){tx.aborted=true;tx.onabort?.()},
        objectStore(){
          return {
            get(id){
              const req={result:records.get(id),onsuccess:null,onerror:null};
              requests.push(req);
              setImmediate(()=>req.onsuccess?.());
              return req;
            },
            put(record){puts.push(record);records.set(record.id,record)},
            delete(id){deletes.push(id);records.delete(id)}
          }
        }};
      transactions.push({name,mode,tx});return tx;
    }
  };
  const openRequests=[];
  const indexedDB={open(name,version){
    const req={result:db,error:null,onupgradeneeded:null,onsuccess:null,onerror:null,onblocked:null};
    openRequests.push({name,version,req});return req;
  }};
  const c=vmContext({localStorage:s,indexedDB});
  const bootstrap="const global=window;const DB='taskpoints_verified_secondary_v1',STORE='snapshots',KEY='"+V1+"',REVISION='taskpoints_state_revision_v1',HOME_NATIVE_ID='home_native_latest';\n"+
    "const get = key => "+(sourceChanged?"key===KEY?'changed-snapshot':localStorage.getItem(key)":"localStorage.getItem(key)")+";\n"+
    "const journalCount=()=>"+(journalPending?'1':'0')+";\n";
  run(c,bootstrap+source('phase5b_deferred_mirror.js','const open = () => new Promise((resolve, reject) => {','async function mirror(raw) {'),'phase5b_deferred_mirror.js');
  return {s,c,records,puts,deletes,transactions,requests,db,openRequests,
    invokeOpen:()=>vm.runInContext('open()',c),
    promote:(candidate,raw,native)=>c.promoteCandidate(db,candidate,raw,'2026-11-11T12:00:00Z',native)
  };
}
test('Verified-secondary IndexedDB opener uses only its dedicated DB and creates snapshot store on upgrade',async()=>{
  const h=secondaryMirrorHarness(),promise=h.invokeOpen();
  const req=h.openRequests[0];
  assert.equal(req.name,'taskpoints_verified_secondary_v1');
  assert.equal(req.version,1);
  req.req.onupgradeneeded();
  assert.equal(h.db.created.name,'snapshots');
  req.req.onsuccess();
  assert.equal(await promise,h.db);
  assertV1Untouched(h.s);
});
test('Verified-secondary promotion writes latest/native copies only when V1 source and journal are stable',async()=>{
  const h=secondaryMirrorHarness(),raw=SNAPSHOT;
  const candidate={id:'candidate',raw,rawHash:'hash',stateHash:'state-hash'};
  const native={raw,rawHash:'hash',snapshotFormat:'home_structured_clone_v1'};
  const promise=h.promote(candidate,raw,native);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.puts.map(x=>x.id),['latest','home_native_latest']);
  assert.deepEqual(h.deletes,['candidate']);
  h.transactions[0].tx.oncomplete();
  assert.equal((await promise).promoted,true);
  assert.equal(h.records.get('latest').status,'passed_verification');
  assertV1Untouched(h.s);
  const stale=secondaryMirrorHarness({sourceChanged:true});
  const blocked=stale.promote(candidate,raw,native);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await blocked).reason,'authoritative_changed');
  assert.equal(stale.puts.length,0);
  assertV1Untouched(stale.s);
});

// Route 5: startup no-op snapshot wrapper, real first production IIFE.
function idleHarness({pending=false}={}){
  const s=storage(),calls=[],events={};
  const core={STORAGE_KEY:V1,
    saveStateSnapshot(next,opts){calls.push({next,opts});s.setItem(V1,JSON.stringify(next));return {state:next}},
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    normalizeState(state){return state},
    readPendingHabitDeltas(){return pending?[{id:'pending'}]:[]},
    readPendingPlayerEdits(){return []}
  };
  const c=vmContext({TaskPointsCore:core,localStorage:s,
    performance:{now(){return 100}},
    document:{readyState:'complete',visibilityState:'visible',addEventListener(){}},
    addEventListener(name,fn){events[name]=fn},
    setTimeout(){return 1}});
  run(c,source('storage_maintenance_idle.js','(function installTaskPointsStorageMaintenanceIdle(global) {',';(function installTaskPointsHomeHabitCompactionQuietGuard(global) {'),'storage_maintenance_idle.js');
  return {s,c,core,calls,events};
}
test('Maintenance startup guard skips identical V1 snapshot without rewriting storage',()=>{
  const h=idleHarness();
  const r=h.core.saveStateSnapshot(inspect(h.s),{savePath:'bootstrap'});
  assert.equal(r.noOp,true);
  assert.equal(h.calls.length,0);
  assert.equal(h.core.getStorageMaintenanceIdleStatus().startupSaveSkips,1);
  assertV1Untouched(h.s);
});
test('Maintenance startup guard NEVER suppresses an explicit repair, changed state or pending journal',()=>{
  const h=idleHarness();
  h.core.saveStateSnapshot(inspect(h.s),{savePath:'manual-repair',userInitiated:true});
  assert.equal(h.calls.length,1);
  const pending=idleHarness({pending:true});
  pending.core.saveStateSnapshot(inspect(pending.s),{savePath:'bootstrap'});
  assert.equal(pending.calls.length,1);
  const changed=idleHarness();
  const next={...inspect(changed.s),notes:'new-data'};
  changed.core.saveStateSnapshot(next,{savePath:'bootstrap'});
  assert.equal(changed.calls.length,1);
  assert.equal(inspect(changed.s).notes,'new-data');
});

// Route 6: requalification page gate authorization, mode-on test and fail-safe.
function requalificationHarness({baseReady=true,fastReady=true,failGate=false}={}){
  const s=storage({[MODE]:'off'},failGate?{denyWrite:GATE}:{});
  const elements={actionMessage:{textContent:''}};
  const calls=[];
  const core={
    setPhase4StorageMode(mode){calls.push(mode);s.setItem(MODE,mode);return mode},
    queuePhase4PrimaryWrite(){},
    async flushPhase4PrimaryWrites(){},
    async flushPhase5ANativeSnapshotWrites(){},
    async flushPhase5CVerifiedSecondaryWrites(){}
  };
  const before={baseReady,mode:'off',gate:{status:'not_started'},recoveryHold:false,recoveryHoldRaw:null,
    current:{rawHash:'base-hash',counts:{tasks:1}},phase4:{verificationFailuresTotal:0},
    blockedWrites:0};
  const after={...before,fast:{ready:fastReady},secondary:{exact:true},phase4:{latestPassedSequence:9},current:{rawHash:'base-hash',counts:{tasks:1}}};
  let reads=0;
  const c=vmContext({localStorage:s,TaskPointsCore:core,
    collect:async()=>reads++===0?before:after,
    phase4Healthy:()=>true,
    setBusy(){},render(){},
    $:id=>elements[id]||(elements[id]={textContent:''}),
    wait:async()=>{},
    PAGE_INSTANCE_ID:'requalification-page',BROWSER_SESSION_ID:'browser-session',
    busy:false
  });
  const prefix="const core=TaskPointsCore;const MODE_KEY='"+MODE+"',GATE_KEY='"+GATE+"',HOLD_KEY='taskpoints_emergency_recovery_hold_v1';"+
    "const get=key=>localStorage.getItem(key),set=(key,value)=>localStorage.setItem(key,value),remove=key=>localStorage.removeItem(key);"+
    "const json=(raw,fallback={})=>{try{return JSON.parse(raw)}catch(_){return fallback}};\n";
  run(c,prefix+source('indexeddb_requalification.js','async function startTest() {','async function finishTest() {'),'indexeddb_requalification.js');
  return {s,c,calls,elements,start:()=>vm.runInContext('startTest()',c)};
}
test('IndexedDB requalification start writes a gate only for healthy short-test preparation',async()=>{
  const h=requalificationHarness();await h.start();
  const record=JSON.parse(h.s.getItem(GATE));
  assert.equal(record.status,'awaiting_smoke_test');
  assert.equal(record.preparedBrowserSessionId,'browser-session');
  assert.equal(h.s.getItem(MODE),'verify_primary_writes');
  assertV1Untouched(h.s);
});
test('IndexedDB requalification blocked preflight fails and leaves mode off, without editing V1',async()=>{
  const h=requalificationHarness({baseReady:false});await h.start();
  assert.equal(h.s.getItem(MODE),'off');
  assert.equal(JSON.parse(h.s.getItem(GATE)).status,'failed');
  assert.match(h.elements.actionMessage.textContent,/test stopped safely/);
  assertV1Untouched(h.s);
});

// Route 7: session-compatible requalification witness gate refresh.
function sessionCompatHarness({proven=true,denyGate=false}={}){
  const baseGate={status:'awaiting_smoke_test',baselineRawHash:'older-hash',
    preparedBrowserSessionId:'browser-prepared',freshAppSessionId:proven?'browser-fresh':null,
    exclusivePageLockConfirmed:true,freshAppRawHash:'stale-hash'};
  const s=storage({[MODE]:'verify_primary_writes',[GATE]:JSON.stringify(baseGate)},denyGate?{denyWrite:GATE}:{});
  const core={STORAGE_KEY:V1,getIndexedDbBrowserSessionStatus(){return {sessionId:'browser-fresh',lockSupported:true}},
    queuePhase4PrimaryWrite(){},async flushPhase4PrimaryWrites(){},
    queuePhase5ANativeSnapshotWrite(){},async flushPhase5ANativeSnapshotWrites(){},
    queuePhase5CVerifiedSecondaryWrite(){},async flushPhase5CVerifiedSecondaryWrites(){}
  };
  const c=vmContext({TaskPointsCore:core,localStorage:s,document:{getElementById(){return null}},
    setTimeout(){return 1},navigator:{}});
  run(c,file('indexeddb_requalification_session_compat.js'),'indexeddb_requalification_session_compat.js');
  return {s,c,core,baseGate};
}
test('Session compatibility gate refresh retains proven sessions while updating stale V1 hash',()=>{
  const h=sessionCompatHarness(),gate=JSON.parse(h.s.getItem(GATE));
  assert.equal(gate.status,'awaiting_smoke_test');
  assert.equal(gate.freshAppSessionId,'browser-fresh');
  assert.equal(gate.preparedBrowserSessionId,'browser-prepared');
  assert.equal(gate.freshAppWitnessRawHash,'stale-hash');
  assert.notEqual(gate.freshAppRawHash,'stale-hash');
  assertV1Untouched(h.s);
});
test('Session compatibility never fabricates a proven reopen from an unproven session',()=>{
  const h=sessionCompatHarness({proven:false});
  assert.equal(h.s.getItem(GATE),JSON.stringify(h.baseGate));
  assertV1Untouched(h.s);
});

// Route 8: cross-page browser lock witness and gate writer.
function restartWitnessHarness({exclusive=true,journal=null}={}){
  const session=storage(),s=storage({
    [MODE]:'verify_primary_writes',
    [GATE]:JSON.stringify({status:'awaiting_smoke_test',preparedBrowserSessionId:'previous-session'}),
    ...(journal?{'taskpoints_pending_habit_deltas_v1':journal}:{})
  });
  const timers=[],lockCalls=[];
  const core={STORAGE_KEY:V1,
    async restorePhase4CommittedPrimary(){return {restored:true}}};
  const c=vmContext({TaskPointsCore:core,localStorage:s,sessionStorage:session,
    crypto:{randomUUID(){return 'new-page-session'}},
    navigator:{locks:{request(name,opts,fn){lockCalls.push({name,opts});return fn(opts.mode==='exclusive'?(exclusive?{}:null):{})}}},
    location:{pathname:'/index.html'},
    performance:{getEntriesByType(){return [{type:'navigate'}]}},
    setTimeout(fn){timers.push(fn);return timers.length}});
  const raw=file('phase4_cache_guard.js'),start=raw.indexOf('(function installTaskPointsIndexedDbRestartWitness(global)');
  assert.ok(start>=0);
  const src=raw.slice(start);
  const anchor='  setTimeout(() => attemptWitness().catch(() => holdSharedPageLock()), 250);';
  assert.ok(src.includes(anchor),'real restart-witness runner moved');
  run(c,src.replace(anchor,'  global.__invokeRestartWitness = attemptWitness;'),'phase4_cache_guard.js');
  return {s,c,session,timers,lockCalls,core};
}
test('Fresh-page witness writes the gate only with exclusive lock and verified restore',async()=>{
  const h=restartWitnessHarness();
  await h.c.__invokeRestartWitness();
  const gate=JSON.parse(h.s.getItem(GATE));
  assert.equal(gate.freshAppSessionId,'new-page-session');
  assert.equal(gate.exclusivePageLockConfirmed,true);
  assert.equal(gate.freshAppPage,'index.html');
  assertV1Untouched(h.s);
});
test('Fresh-page witness cannot persist proof without lock, or while Habit journal is pending',async()=>{
  for(const opts of [{exclusive:false},{journal:'[{"id":"pending"}]'}]){
    const h=restartWitnessHarness(opts),raw=h.s.getItem(GATE);
    await h.c.__invokeRestartWitness();
    assert.equal(h.s.getItem(GATE),raw);
    assertV1Untouched(h.s);
  }
});

// Route 9: Habit-ledger repair's actual confirmed save and post-save check.
function habitRepairHarness({failWrite=false,blockedPreview=false}={}){
  const s=storage(),nodes={};
  const node=id=>({
    id,dataset:{},checked:false,disabled:false,innerHTML:'',textContent:'',
    handlers:{},addEventListener(name,fn){this.handlers[name]=fn},
    cloneNode(){return node(id)},
    replaceWith(replacement){nodes[id]=replacement},
    click(){this.handlers.click()}
  });
  for(const id of ['previewHabitScoreReconciliationBtn','applyHabitScoreReconciliationBtn',
    'habitLedgerBackupConfirmed','habitScoreReconciliationStatus','habitScoreReconciliationSummary',
    'habitScoreReconciliationRows'])nodes[id]=node(id);
  const auditCalls=[];
  const core={STORAGE_KEY:V1,
    readTaskPointsStoredState(){return inspect(s)},
    saveStateSnapshot(next,opts){
      if(failWrite)return {blocked:true,reason:'writer refused'};
      s.setItem(V1,JSON.stringify(next));return {state:next};
    }};
  const repair={
    totalCount(plan){return plan?.remaining?0:1},
    buildPlan(state){return {remaining:state.reconciled===true}}
  };
  const api={
    buildReconciliationPlan(){return {canApply:!blockedPreview,fullPlan:{},affectedDays:1,
      matchupDays:1,noMatchupDayCount:0,resultChanges:0,blockingIssues:blockedPreview?[{dayKey:'2026-11-11',reason:'blocked'}]:[],
      scoreUpdates:[]}},
    applyReconciliationPlan(live){
      return {state:{...live,reconciled:true},scoreDaysChanged:1,matchupRowsUpdated:1,
        historyRowsUpdated:0,scheduleCopiesUpdated:0,seasonCopiesUpdated:0}
    }
  };
  const c=vmContext({localStorage:s,TaskPointsCore:core,TaskPointsCompletionBackedHabitRepair:repair,
    TaskPointsHabitLedgerRepair:{},document:{getElementById(id){return nodes[id]||null}},
    runAudit(){auditCalls.push(true)}});
  const prefix="const global=window;const STORAGE_KEY='"+V1+"';\n";
  run(c,prefix+source('habit_ledger_score_reconciliation_hardening.js',
    'function readStoredState(core, fallback = null) {','function install() {'),'habit_ledger_score_reconciliation_hardening.js');
  assert.equal(c.installPanel(api),true);
  return {s,c,api,nodes,auditCalls,preview:()=>nodes.previewHabitScoreReconciliationBtn.click(),
    apply:()=>nodes.applyHabitScoreReconciliationBtn.click()};
}
test('Habit-ledger reconciliation requires preview plus backup and verifies the saved result',()=>{
  const h=habitRepairHarness();
  h.apply();
  assertV1Untouched(h.s);
  h.preview();
  h.nodes.habitLedgerBackupConfirmed.checked=true;
  h.nodes.habitLedgerBackupConfirmed.handlers.change();
  h.apply();
  assert.equal(inspect(h.s).reconciled,true);
  assert.equal(inspect(h.s).unknownImportedField.retain,true);
  assert.match(h.nodes.habitScoreReconciliationStatus.textContent,/Repair saved/);
  assert.equal(h.auditCalls.length,1);
});
test('Habit-ledger reconciliation fails visibly on refused writer and retains V1',()=>{
  const h=habitRepairHarness({failWrite:true});h.preview();
  h.nodes.habitLedgerBackupConfirmed.checked=true;
  h.nodes.habitLedgerBackupConfirmed.handlers.change();
  h.apply();
  assert.match(h.nodes.habitScoreReconciliationStatus.textContent,/Repair failed: writer refused/);
  assert.equal(h.auditCalls.length,0);assertV1Untouched(h.s);
});
