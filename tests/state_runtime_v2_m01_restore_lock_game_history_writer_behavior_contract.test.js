'use strict';
// Two M01 behavior witnesses using the actual V1 recovery/repair code.
// Synthetic storage is deliberately isolated; V2 authority is NEVER granted.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const clone=x=>JSON.parse(JSON.stringify(x));
const LOCK='taskpoints_recovery_write_lock_v1';
const MAIN='taskpoints_v1';

function restoreHarness() {
  const map=new Map([[MAIN,'{"tasks":[{"id":"safe"}]}']]);
  const events=new Map();
  const writes=[],removes=[];
  const localStorage={
    getItem(k){return map.has(String(k))?map.get(String(k)):null;},
    setItem(k,v){map.set(String(k),String(v));writes.push(String(k));},
    removeItem(k){map.delete(String(k));removes.push(String(k));}
  };
  const ctx={localStorage,Date,Number,JSON,Object,String,
    addEventListener(type,fn){events.set(type,fn)}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'verified_secondary_restore_lock_guard.js'),'utf8'),
    ctx,{filename:'verified_secondary_restore_lock_guard.js'});
  return {ctx,map,localStorage,events,writes,removes,
    guard:ctx.TaskPointsVerifiedSecondaryRestoreLockGuard};
}
const uncommitted=(token,createdAtMs=Date.now())=>
  JSON.stringify({token,active:true,createdAtMs,committedAtMs:0});

test('real restore lock guard admits V1 write only while its uncommitted token is owned',()=>{
  const h=restoreHarness();
  assert.equal(h.guard.installed,true);
  h.localStorage.setItem(LOCK,uncommitted('owned'));
  assert.equal(h.guard.getOwnedToken(),'owned');
  h.localStorage.setItem(MAIN,'{"tasks":[{"id":"restored"}]}');
  assert.match(h.map.get(MAIN),/restored/);
  const before=h.map.get(MAIN);
  h.map.set(LOCK,uncommitted('foreign'));
  assert.throws(()=>h.localStorage.setItem(MAIN,'{"tasks":[]}'),
    /no longer owns the cross-tab recovery lock/);
  assert.equal(h.map.get(MAIN),before,'foreign lock must fence old page writer');
  h.guard.releaseOwnedUncommittedLock();
  assert.equal(h.map.has(LOCK),true,'foreign lock can never be removed by old owner');
});

test('restore pagehide releases only its own uncommitted lock, never committed or manual-recovery holds',()=>{
  const a=restoreHarness();
  a.localStorage.setItem(LOCK,uncommitted('mine'));
  a.events.get('pagehide')();
  assert.equal(a.map.has(LOCK),false);
  const b=restoreHarness();
  b.localStorage.setItem(LOCK,uncommitted('mine'));
  b.map.set(LOCK,JSON.stringify({active:true,token:'mine',createdAtMs:Date.now(),
    committedAtMs:Date.now(),retainUntilManualRecovery:true}));
  b.events.get('beforeunload')();
  assert.equal(b.map.has(LOCK),true);
  assert.throws(()=>b.localStorage.setItem(MAIN,'{}'),/no longer owns/);
  const c=restoreHarness();
  c.localStorage.setItem(LOCK,JSON.stringify({active:true,token:'mine',
    createdAtMs:Date.now(),retainUntilManualRecovery:true,committedAtMs:0}));
  c.events.get('pagehide')();
  assert.equal(c.map.has(LOCK),true,'manual recovery hold remains');
});

test('expired old uncommitted restore lock is cleaned but never authorizes abandoned writer',()=>{
  const h=restoreHarness();
  h.localStorage.setItem(LOCK,uncommitted('owned',Date.now()-180000));
  assert.equal(h.guard.readLock(),null);
  assert.equal(h.map.has(LOCK),false);
  assert.throws(()=>h.localStorage.setItem(MAIN,'{}'),/no longer owns/);
  assert.ok(h.removes.includes(LOCK));
});

const VERRICK='358b982e-c494-4c58-815a-d59953742997';
function historyState() {
  return {
    players:[{id:VERRICK,name:'Verrick',active:true,baseline:40}],
    matchups:[{
      id:'verified-game',matchupId:'verified-game',dateKey:'2026-06-14',
      date:'2026-06-14',playerAId:VERRICK,playerBId:'YOU',
      scoreA:43.2,playerAScore:43.2,scoreB:64.85,playerBScore:64.85,
      completedAtISO:'2026-06-14T23:59:00.000Z',matchupType:'tournament'
    }],
    gameHistory:[{
      id:'history-verrick',dateKey:'2026-06-14',date:'2026-06-14',
      playerId:VERRICK,matchupId:'verified-game',score:62.8,points:62.8
    }],
    goldLedger:[{id:'gold-unchanged'}],
    seasonHistory:[{id:'historic-season'}],
    tasks:[{id:'keep-task',status:'active'}]
  };
}
function gameHistoryHarness({failMode='none'}={}){
  let data=historyState();
  const saves=[],runs=[];
  const nodes=new Map();
  function node(id=''){
    const x={
      id,disabled:false,checked:false,textContent:'',listeners:{},
      addEventListener(type,fn){(this.listeners[type] ||= []).push(fn)},
      click(){for(const cb of this.listeners.click||[])cb()},
      change(){for(const cb of this.listeners.change||[])cb()},
      querySelector(selector){return nodes.get(selector.slice(1))||null},
      appendChild(child){if(child.id)nodes.set(child.id,child);return child}
    };
    Object.defineProperty(x,'innerHTML',{get(){return this._html||''},set(html){
      this._html=html;
      for(const [,found]of String(html).matchAll(/id="([^"]+)"/g)){
        if(!nodes.has(found))nodes.set(found,node(found));
      }
    }});
    return x;
  }
  const main=node('main');
  const checks=node('auditChecks');checks.closest=()=>main;
  nodes.set('auditChecks',checks);
  const doc={readyState:'loading',getElementById(id){return nodes.get(id)||null},
    querySelector(sel){return sel==='main'?main:null},
    createElement(){return node()},addEventListener(){}};
  const core={
    STORAGE_KEY:MAIN,
    loadAppState(){return {state:clone(data)}},
    saveStateSnapshot(next,options){
      saves.push({state:clone(next),options:clone(options)});
      if(failMode==='throw')throw Error('quota or recovery hold');
      if(failMode==='blocked')return {blocked:true,reason:'recovery hold'};
      data=clone(next);
      return {state:clone(data)};
    }
  };
  const ctx={TaskPointsCore:core,document:doc,console:{error(){}},
    Date,JSON,Number,Object,String,Array,Set,Map,WeakSet,
    structuredClone:clone,setTimeout(){},runAudit(){runs.push('audit')}};
  ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'game_history_reconciliation_repair.js'),'utf8'),
    ctx,{filename:'game_history_reconciliation_repair.js'});
  assert.equal(ctx.TaskPointsGameHistoryReconciliationRepair.installAuditPanel(),true);
  return {
    saves,runs,
    get state(){return clone(data)},
    replace(next){data=clone(next)},
    preview(){nodes.get('previewGameHistoryRepairBtn').click()},
    confirm(){nodes.get('gameHistoryBackupConfirmed').checked=true;
      nodes.get('gameHistoryBackupConfirmed').change()},
    apply(){nodes.get('repairGameHistoryBtn').click()},
    status(){return nodes.get('gameHistoryRepairStatus').textContent},
    button(){return nodes.get('repairGameHistoryBtn')}
  };
}
test('Game History repair uses actual UI preview + backup + V1 writer and preserves unrelated fields',()=>{
  const h=gameHistoryHarness();
  h.apply();
  assert.equal(h.saves.length,0);
  h.preview();
  assert.match(h.status(),/Preview ready/);
  assert.equal(h.button().disabled,true);
  h.apply();
  assert.equal(h.saves.length,0,'without confirmed export cannot persist');
  h.confirm();assert.equal(h.button().disabled,false);
  h.apply();
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].options.savePath,'audit-game-history-reconciliation-repair');
  assert.equal(h.saves[0].options.userInitiated,true);
  assert.equal(h.saves[0].options.immediateWrite,true);
  assert.equal(h.state.gameHistory[0].score,43.2);
  assert.equal(h.state.matchups[0].scoreA,43.2);
  assert.equal(h.state.goldLedger[0].id,'gold-unchanged');
  assert.equal(h.state.tasks[0].id,'keep-task');
  assert.match(h.status(),/Repair saved:/);
  assert.equal(h.runs.length,1);
});

test('Game History repair refuses a stale preview, and blocked save never reports success',()=>{
  const stale=gameHistoryHarness();
  stale.preview();stale.confirm();
  const changed=stale.state;changed.gameHistory[0].score=40;
  stale.replace(changed);stale.apply();
  assert.equal(stale.saves.length,0);
  assert.match(stale.status(),/saved data changed after the preview/);
  assert.equal(stale.state.gameHistory[0].score,40);

  const blocked=gameHistoryHarness({failMode:'blocked'});
  blocked.preview();blocked.confirm();blocked.apply();
  assert.equal(blocked.saves.length,1);
  assert.equal(blocked.state.gameHistory[0].score,62.8);
  assert.match(blocked.status(),/Save failed, so no success/);
  assert.equal(blocked.runs.length,0);
});

test('M01 witnessed routes in this contract are not V2 owner or cutover certificates',()=>{
  const inv=JSON.parse(fs.readFileSync(path.join(root,
    'docs/state-runtime-v2-storage-source-inventory.json'),'utf8'));
  const witness=inv.writerBehaviorWitnesses.filter(row=>row.testPath==='tests/state_runtime_v2_m01_restore_lock_game_history_writer_behavior_contract.test.js');
  assert.equal(witness.length,2);
  for(const row of witness){
    assert.ok(inv.writerPathEvidence.some(src=>src.path===row.path&&src.anchor===row.anchor));
    assert.ok(row.observedBehaviors.length>=4);
    assert.equal(row.productionOwnerVerified,false);
    assert.equal(row.productionFenceVerified,false);
    assert.equal(row.cutoverPermission,false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,42);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments,0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced,false);
  assert.equal(inv.writerOwnershipAudit.status,'incomplete');
  assert.equal(inv.writerOwnershipAudit.sixRouteSafetyEvidence.crossTabFencingVerified,false);
  assert.equal(inv.writerOwnershipAudit.sixRouteSafetyEvidence.cutoverPermission,false);
});
