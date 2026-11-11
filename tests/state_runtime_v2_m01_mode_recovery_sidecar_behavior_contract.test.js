'use strict';
// M01: behavior witnesses execute real V1 production modules in disposable Node VMs.
// They cannot certify V2 production ownership, generation fencing, or cutover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const MAIN = 'taskpoints_v1';
const SNAPSHOT = JSON.stringify({tasks:[{id:'keep'}],goldLedger:[{id:'gold'}],unknownImportedField:{keep:true}});
function storage(initial={},failKey=null) {
  const data=new Map(Object.entries(initial));
  const writes=[];
  return {data,writes,
    getItem(key){return data.get(String(key))??null},
    setItem(key,value){
      if(key===failKey)throw Error('QuotaExceededError');
      data.set(String(key),String(value));
      writes.push({type:'set',key:String(key),value:String(value)});
    },
    removeItem(key){data.delete(String(key));writes.push({type:'remove',key:String(key)})}
  };
}
function source(file,start=null,end=null) {
  const code=fs.readFileSync(path.join(root,file),'utf8');
  if(!start)return code;
  const i=code.indexOf(start),j=end?code.indexOf(end,i+start.length):code.length;
  assert.ok(i>=0&&j>i,'production module moved: '+file+' '+start);
  return code.slice(i,j);
}
function run(code,context,filename='production') {
  context.window=context;
  context.globalThis=context;
  context.console ||= {error(){},warn(){},log(){}};
  vm.createContext(context);
  vm.runInContext(code,context,{filename});
  return context;
}
function verifyUntouched(s) { assert.equal(s.getItem(MAIN),SNAPSHOT,'independent sidecar must not rewrite V1 snapshot'); }

// 1: Home targeted render preference, written by real safeStorageSet().
test('M01 Home targeted-render kill-switch persists and re-enables without editing snapshot',()=>{
  const s=storage({[MAIN]:SNAPSHOT});
  const ctx=run(source('home_targeted_render_control.js'),{localStorage:s});
  const api=ctx.TaskPointsHomeTargetedRenderControl;
  assert.equal(api.getStatus().enabled,true);
  assert.equal(api.disable().enabled,false);
  assert.equal(s.getItem(api.DISABLED_KEY),'1');
  verifyUntouched(s);
  const reload=run(source('home_targeted_render_control.js'),{localStorage:s});
  assert.equal(reload.TaskPointsHomeTargetedRenderControl.getStatus().enabled,false);
  assert.equal(reload.TaskPointsHomeTargetedRenderControl.enable().enabled,true);
  assert.equal(s.getItem(api.DISABLED_KEY),null);
  verifyUntouched(s);
});
test('M01 Home targeted-render denied preference write is not mistaken for durable storage',()=>{
  const key='taskpoints_home_targeted_render_disabled_v1';
  const s=storage({[MAIN]:SNAPSHOT},key);
  const api=run(source('home_targeted_render_control.js'),{localStorage:s}).TaskPointsHomeTargetedRenderControl;
  assert.equal(api.disable().enabled,false,'this page gets disabled in memory');
  assert.equal(s.getItem(key),null,'quota denial did not persist the preference');
  assert.equal(run(source('home_targeted_render_control.js'),{localStorage:s}).TaskPointsHomeTargetedRenderControl.getStatus().enabled,true,'next page restores actual stored setting');
  verifyUntouched(s);
});

// 2: Habit fast-path preference through the original production module.
test('M01 Habit fast-path setting persists and clears using original module',()=>{
  const s=storage({[MAIN]:SNAPSHOT});
  const c=run(source('habit_fast_path_control.js'),{localStorage:s});
  const api=c.TaskPointsHabitFastPathControl;
  assert.equal(api.isEnabled(),true);
  assert.equal(api.disable().enabled,false);
  assert.equal(s.getItem(api.DISABLED_KEY),'1');
  const fresh=run(source('habit_fast_path_control.js'),{localStorage:s});
  assert.equal(fresh.TaskPointsHabitFastPathControl.isEnabled(),false);
  assert.equal(fresh.TaskPointsHabitFastPathControl.enable().enabled,true);
  assert.equal(s.getItem(api.DISABLED_KEY),null);
  verifyUntouched(s);
});
test('M01 Habit fast-path quota denial cannot claim a persisted kill switch',()=>{
  const key='taskpoints_habit_fast_path_disabled_v1';
  const s=storage({[MAIN]:SNAPSHOT},key);
  const a=run(source('habit_fast_path_control.js'),{localStorage:s}).TaskPointsHabitFastPathControl;
  a.disable();
  assert.equal(a.isEnabled(),false);
  assert.equal(s.getItem(key),null);
  assert.equal(run(source('habit_fast_path_control.js'),{localStorage:s}).TaskPointsHabitFastPathControl.isEnabled(),true);
  verifyUntouched(s);
});

// 3: Phase 3 mode sidecar and its diagnostic record.
function phase3(options={}) {
  const s=storage({[MAIN]:SNAPSHOT,...options.initial},options.failKey||null);
  const timers=[];
  const core={STORAGE_KEY:MAIN,loadAppState(){return {state:{tasks:[{id:'keep'}]}}}};
  run(source('phase3_read_path.js'),{localStorage:s,TaskPointsCore:core,
    setTimeout(fn){timers.push(fn);return timers.length}});
  return {s,core,timers};
}
test('M01 Phase3 mode writer persists compare/off and keeps the main snapshot unchanged',()=>{
  const h=phase3();
  assert.equal(h.core.getPhase3ReadMode(),'off');
  assert.equal(h.core.setPhase3ReadMode('compare'),'compare');
  assert.equal(h.s.getItem('taskpoints_phase3_read_mode_v1'),'compare');
  assert.equal(JSON.parse(h.s.getItem('taskpoints_phase3_read_diagnostics_v1')).status,'warming');
  assert.equal(h.timers.length,1);
  assert.equal(h.core.setPhase3ReadMode('invalid_mode'),'off');
  assert.equal(h.core.getPhase3ReadMode(),'off');
  assert.equal(JSON.parse(h.s.getItem('taskpoints_phase3_read_diagnostics_v1')).effectiveSource,'localStorage');
  verifyUntouched(h.s);
});
test('M01 Phase3 storage refusal does not change actual persisted mode',()=>{
  const h=phase3({initial:{taskpoints_phase3_read_mode_v1:'off'},failKey:'taskpoints_phase3_read_mode_v1'});
  assert.equal(h.core.setPhase3ReadMode('compare'),'compare','API returns requested mode even if storage refused');
  assert.equal(h.core.getPhase3ReadMode(),'off','storage-backed mode is still safe/off');
  verifyUntouched(h.s);
});

// 4: Phase4 diagnostic writer, including fallback count behavior.
test('M01 Phase4 missing mirror falls back to V1 and logs diagnostic without changing save',()=>{
  const s=storage({taskpoints_phase4_diagnostics_v1:JSON.stringify({fallbackReadsTotal:4,kept:'yes'})});
  let legacyReads=0;
  const core={STORAGE_KEY:MAIN,PENDING_HABIT_DELTAS_KEY:'taskpoints_pending_habit_deltas_v1',
    getPhase4StorageMode(){return 'indexeddb_primary'},
    loadAppState(){legacyReads++;return {state:{source:'legacy'}}}};
  const timers=[];
  run(source('phase4_primary_read_path.js'),{TaskPointsCore:core,localStorage:s,
    sessionStorage:storage(),setTimeout(fn){timers.push(fn);return timers.length}});
  const result=core.loadAppState({persistSync:false});
  assert.equal(result.state.source,'legacy');
  assert.equal(legacyReads,1);
  const diag=JSON.parse(s.getItem('taskpoints_phase4_diagnostics_v1'));
  assert.equal(diag.fallbackReadsTotal,5);
  assert.equal(diag.lastFallbackReason,'authoritative_missing');
  assert.equal(diag.kept,'yes');
  assert.equal(s.getItem(MAIN),null,'read fallback did not manufacture a snapshot');
});
test('M01 Phase4 diagnostic quota denial must not block safe legacy read or rewrite mirror',()=>{
  const key='taskpoints_phase4_diagnostics_v1';
  const s=storage({[MAIN]:SNAPSHOT},key);
  let reads=0;
  const core={STORAGE_KEY:MAIN,PENDING_HABIT_DELTAS_KEY:'taskpoints_pending_habit_deltas_v1',
    getPhase4StorageMode(){return 'indexeddb_primary'},
    getPendingShadowDualWriteCount(){return 1},
    loadAppState(){reads++;return {state:{source:'legacy'}}}};
  run(source('phase4_primary_read_path.js'),{TaskPointsCore:core,localStorage:s,sessionStorage:storage(),
    setTimeout(){}});
  assert.equal(core.loadAppState().state.source,'legacy');
  assert.equal(reads,1);
  assert.equal(s.getItem(key),null);
  verifyUntouched(s);
});

// 5: Requalification diagnostic and mode decision guard.
function requal({initial={},denyDiagnostic=false}={}) {
  const MODE='taskpoints_phase4_storage_mode_v1';
  const s=storage({[MAIN]:SNAPSHOT,...initial},denyDiagnostic?'taskpoints_indexeddb_requalification_diagnostics_v1':null);
  const applied=[];
  const core={STORAGE_KEY:MAIN,PHASE4_STORAGE_MODE_KEY:MODE,
    getPhase4StorageMode(){return s.getItem(MODE)||'off'},
    setPhase4StorageMode(mode){applied.push(mode);s.setItem(MODE,mode);return mode}};
  const full=source('indexeddb_requalification_guard.js');
  const first=full.slice(0,full.indexOf(';(function installTaskPointsNpcScoreCap86'));
  run(first,{localStorage:s,TaskPointsCore:core});
  return {s,core,applied,MODE};
}
test('M01 requalification refuses fast mode without approved gate and records diagnostic',()=>{
  const h=requal();
  assert.equal(h.core.setPhase4StorageMode('indexeddb_primary'),'off');
  const d=JSON.parse(h.s.getItem('taskpoints_indexeddb_requalification_diagnostics_v1'));
  assert.equal(d.blockedReason,'short_test_not_finished');
  assert.equal(d.requestedMode,'indexeddb_primary');
  assert.equal(h.core.getPhase4StorageMode(),'off');
  const held=requal({initial:{taskpoints_emergency_recovery_hold_v1:JSON.stringify({active:true})}});
  assert.equal(held.core.setPhase4StorageMode('verify_primary_writes'),'off');
  assert.equal(JSON.parse(held.s.getItem('taskpoints_indexeddb_requalification_diagnostics_v1')).blockedReason,'recovery_hold_active');
  verifyUntouched(h.s);verifyUntouched(held.s);
});
test('M01 requalification diagnostic write failure must leave protected mode off',()=>{
  const h=requal({denyDiagnostic:true});
  assert.equal(h.core.setPhase4StorageMode('indexeddb_primary'),'off');
  assert.equal(h.s.getItem('taskpoints_indexeddb_requalification_diagnostics_v1'),null);
  assert.equal(h.s.getItem(h.MODE),'off');
  verifyUntouched(h.s);
});

// 6: Recovery hold guard fallback forces off, never touching snapshot.
test('M01 requalification hold preflight missing fails closed to off when mode helper throws',()=>{
  const MODE='taskpoints_phase4_storage_mode_v1';
  const s=storage({[MAIN]:SNAPSHOT,[MODE]:'indexeddb_primary'});
  const core={setPhase4StorageMode(){throw Error('runtime unavailable')}};
  run(source('indexeddb_requalification_hold_guard.js'),{localStorage:s,TaskPointsCore:core});
  assert.equal(s.getItem(MODE),'off');
  assert.equal(core.__indexedDbRequalificationGuardInstalled,false);
  assert.ok(s.writes.some(w=>w.type==='set'&&w.key===MODE&&w.value==='off'));
  verifyUntouched(s);
});
test('M01 active recovery hold rejects stale removal and forces off on storage event',()=>{
  const HOLD='taskpoints_emergency_recovery_hold_v1',MODE='taskpoints_phase4_storage_mode_v1';
  const s=storage({[MAIN]:SNAPSHOT,[MODE]:'indexeddb_primary',[HOLD]:'newer-hold'});
  const listeners={};
  const core={setPhase4StorageMode(){throw Error('read-path unavailable')}};
  const ctx=run(source('indexeddb_requalification_hold_guard.js'),{
    localStorage:s,TaskPointsCore:core,
    __TASKPOINTS_REQUALIFICATION_PREFLIGHT_HOLD_CAPTURE__:{available:true,raw:'initial-hold'},
    addEventListener(name,cb){listeners[name]=cb}
  });
  assert.equal(ctx.TaskPointsCore.getIndexedDbRecoveryHoldGuardStatus().currentHoldChanged,true);
  assert.throws(()=>s.removeItem(HOLD),e=>e.code==='TASKPOINTS_RECOVERY_HOLD_CHANGED');
  assert.equal(s.getItem(HOLD),'newer-hold');
  listeners.storage({storageArea:s,key:HOLD,newValue:'newer-hold'});
  assert.equal(s.getItem(MODE),'off');
  verifyUntouched(s);
});

// 7: Emergency recovery commit lock and attempted-lock cleanup.
function emergency({failKey=null,restored=false}={}) {
  const ATTEMPT='taskpoints_recovery_attempt_lock_v1';
  const HOLD='taskpoints_emergency_recovery_hold_v1';
  const s=storage({[MAIN]:SNAPSHOT,[ATTEMPT]:'old_attempt',
    [HOLD]:JSON.stringify({active:true,restored})},failKey);
  const logs=[];
  const message={className:'',textContent:''};
  const ctx=run(source('emergency_recovery_lock_authorization.js'),{
    localStorage:s,crypto:{randomUUID(){return 'test-emergency-token'}},
    async restoreCandidate(){return {ok:true}},
    document:{getElementById(id){return id==='message'?message:null}},
    console:{error(...args){logs.push(args)},warn(){},log(){}}
  });
  return {s,ctx,logs,message};
}
test('M01 emergency verified restore commits lock and clears attempt without losing V1',async()=>{
  const h=emergency({restored:true});
  const result=await h.ctx.restoreCandidate();
  assert.equal(result.ok,true);
  const lock=JSON.parse(h.s.data.get('taskpoints_recovery_write_lock_v1'));
  assert.equal(lock.active,true);
  assert.equal(lock.reason,'full_emergency_recovery_verified');
  assert.equal(lock.token,'test-emergency-token');
  assert.equal(h.s.data.has('taskpoints_recovery_attempt_lock_v1'),false);
  assert.equal(h.s.getItem('taskpoints_recovery_write_lock_v1'),null,'emergency page hides lock from its own reader');
  verifyUntouched(h.s);
});
test('M01 failed emergency committed-lock write retains attempt lock and displays warning',async()=>{
  const h=emergency({restored:true,failKey:'taskpoints_recovery_write_lock_v1'});
  const result=await h.ctx.restoreCandidate();
  assert.equal(result.ok,true);
  assert.equal(h.s.data.has('taskpoints_recovery_attempt_lock_v1'),true);
  assert.equal(h.s.data.has('taskpoints_recovery_write_lock_v1'),false);
  assert.match(h.message.textContent,/cross-tab protection could not be finalized/);
  assert.equal(h.logs.length,1);
  verifyUntouched(h.s);
});

// 8: Home's stale *uncommitted* recovery lock janitor, from its actual IIFE.
function recoveryLock(initial, pageStartedAtMs=Date.now()-300000) {
  const LOCK='taskpoints_recovery_write_lock_v1';
  const s=storage({[MAIN]:SNAPSHOT,[LOCK]:JSON.stringify(initial)});
  const core={STORAGE_KEY:MAIN,getRecoveryWriteLockStatus(){return {pageStartedAtMs}}};
  const program=source('home_yesterday_result_consistency.js',
    '(function installTaskPointsRecoveryJournalWriteLockGuard(global)',
    '(function installTaskPointsRecoveryAttemptWriteLockGuard(global)');
  const ctx=run(program,{localStorage:s,TaskPointsCore:core});
  return {s,ctx,LOCK};
}
test('M01 expired uncommitted recovery lock is removed; unrelated snapshot survives',()=>{
  const h=recoveryLock({active:true,token:'abandoned',createdAtMs:Date.now()-180000,committedAtMs:0});
  assert.equal(h.ctx.TaskPointsRecoveryJournalWriteLockGuard.readLock(),null);
  assert.equal(h.s.getItem(h.LOCK),null);
  assert.ok(h.s.writes.some(w=>w.type==='remove'&&w.key===h.LOCK));
  verifyUntouched(h.s);
});
test('M01 completed recovery lock is never cleaned merely because it is old; stale tab remains blocked',()=>{
  const h=recoveryLock({active:true,token:'real-restored',createdAtMs:Date.now()-900000,
    committedAtMs:Date.now()-120000});
  assert.notEqual(h.s.getItem(h.LOCK),null);
  assert.throws(()=>h.s.setItem(MAIN,'stale overwrite'),e=>e.code==='TASKPOINTS_RECOVERY_WRITE_LOCKED');
  assert.throws(()=>h.s.removeItem('taskpoints_pending_habit_deltas_v1'),e=>e.code==='TASKPOINTS_RECOVERY_WRITE_LOCKED');
  assert.equal(h.s.getItem(MAIN),SNAPSHOT);
  assert.notEqual(h.s.getItem(h.LOCK),null);
});
