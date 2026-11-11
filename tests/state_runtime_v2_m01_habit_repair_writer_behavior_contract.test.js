'use strict';
// M01: actual legacy Habit repair UI save paths; synthetic V1 state only.
// No production V2 ownership, old-tab fencing or cutover is certified.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const scripts={
  audit:'habit_ledger_repair_audit.js',
  completion:'habit_ledger_completion_backed_repair.js',
  score:'habit_ledger_score_reconciliation.js'
};
const clone=v=>JSON.parse(JSON.stringify(v));
const day='2026-04-12';

function screen(kind,initial,dependencies={}){
  const nodes=new Map(),saveAttempts=[];
  let stored=clone(initial),failMode='',auditRefreshes=0;
  const element=(id='')=>{
    const el={
      id,disabled:false,checked:false,textContent:'',listeners:{},children:[],
      addEventListener(type,fn){(this.listeners[type] ||= []).push(fn)},
      trigger(type){for(const fn of this.listeners[type]||[])fn()},
      querySelector(selector){return nodes.get(String(selector).replace(/^#/,'') )||null},
      appendChild(child){this.children.push(child);if(child.id)nodes.set(child.id,child);return child},
      closest(selector){return selector==='main'?main:null}
    };
    Object.defineProperty(el,'innerHTML',{
      get(){return this._html||''},
      set(markup){this._html=markup;for(const [,found] of String(markup).matchAll(/id="([^"]+)"/g))if(!nodes.has(found))nodes.set(found,element(found))}
    });
    if(id)nodes.set(id,el);
    return el;
  };
  const main=element('main');
  const backup=element('habitLedgerBackupConfirmed');
  const auditChecks=element('auditChecks');
  if(kind==='completion')element('habitLedgerRepairPanel');
  if(kind==='score')element('completionBackedHabitRepair');
  const document={
    readyState:'complete',getElementById(id){return nodes.get(id)||null},
    createElement(){return element()},
    addEventListener(){}
  };
  const core={
    STORAGE_KEY:'taskpoints_v1',
    dateKey(date){return date.toISOString().slice(0,10)},
    readTaskPointsStoredState(){return clone(stored)},
    saveStateSnapshot(next,options={}){
      saveAttempts.push({state:clone(next),options:clone(options)});
      if(failMode==='throw')throw Error('quota or recovery protection');
      if(failMode==='skipped')return {state:clone(stored),skipped:true};
      stored=clone(next);
      return {state:clone(stored)};
    },
    ...dependencies.core
  };
  const ctx={
    TaskPointsCore:core,TaskPointsHabitLedgerRepair:dependencies.planner,
    TaskPointsCompletionBackedHabitRepair:dependencies.repair,
    document,localStorage:{getItem(){return null}},console:{log(){},warn(){},error(){}},
    JSON,Date,Number,String,Object,Array,Map,Set,WeakMap,WeakSet,Math,
    structuredClone:clone,setTimeout(){return 1},
    runAudit(){auditRefreshes++},module:{exports:{}}
  };
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,scripts[kind]),'utf8'),ctx,
    {filename:scripts[kind]});
  const controls={
    audit:['previewHabitLedgerRepairBtn','applyHabitLedgerRepairBtn','habitLedgerRepairStatus'],
    completion:['previewCompletionBackedRepairBtn','applyCompletionBackedRepairBtn','completionBackedRepairStatus'],
    score:['previewHabitScoreReconciliationBtn','applyHabitScoreReconciliationBtn','habitScoreReconciliationStatus']
  }[kind];
  const [preview,apply,status]=controls.map(id=>nodes.get(id));
  assert.ok(preview&&apply&&status,kind+' real panel was not installed');
  return {
    core,ctx,backup,preview,apply,status,saveAttempts,
    get stored(){return clone(stored)},
    get refreshes(){return auditRefreshes},
    set failMode(v){failMode=v},
    replace(next){stored=clone(next)},
    previewPlan(){preview.trigger('click')},
    confirm(){backup.checked=true;backup.trigger('change')},
    execute(){apply.trigger('click')}
  };
}

const emptyBase=()=>({
  sourceUpdates:[],failedDateRemovals:[],duplicateRemovals:[],manualReview:[],
  pointsRemoved:0,matchupImpact:{completeImpactChain:true,hasBlockingImpact:false,blockingDays:[]}
});
function correctionPlanner(){
  return {
    buildHabitLedgerRepairPlan(state){
      const changes=(state.completions||[]).flatMap((row,i)=>
        row.id==='vice-one'&&row.source!=='vice'
          ? [{completionIndex:i,habitName:'Vice',dayKey:day,
              fromSource:row.source,toSource:'vice'}] : []);
      return {...emptyBase(),sourceUpdates:changes};
    },
    applyHabitLedgerRepairPlan(live,preview){
      const next=clone(live);
      const changed=preview.sourceUpdates.length;
      for(const fix of preview.sourceUpdates) {
        if(next.completions[fix.completionIndex]?.id!=='vice-one')
          return {state:next,sourceRowsUpdated:0,failedRowsRemoved:0,
            duplicateRowsRemoved:0,skippedStale:1};
        next.completions[fix.completionIndex].source='vice';
      }
      return {state:next,sourceRowsUpdated:changed,failedRowsRemoved:0,
        duplicateRowsRemoved:0,manualReviewCount:0};
    }
  };
}
const viceState=()=>({
  habits:[{id:'v1',name:'Vice',category:'vice',doneKeys:[day],failedKeys:[],iceKeys:[]}],
  completions:[{id:'vice-one',source:'habit',habitId:'v1',dayKey:day,points:-2}],
  gold:55,players:[{id:'you',name:'YOU'}]
});

test('actual Habit ledger audit writer requires preview + backup, saves only corrected rows',()=>{
  const s=screen('audit',viceState(),{planner:correctionPlanner()});
  s.execute();assert.equal(s.saveAttempts.length,0,'no save without preview');
  s.previewPlan();s.execute();assert.equal(s.saveAttempts.length,0,'fresh backup required');
  assert.equal(s.apply.disabled,true);
  s.confirm();assert.equal(s.apply.disabled,false);
  s.execute();
  assert.equal(s.saveAttempts.length,1);
  assert.equal(s.saveAttempts[0].options.savePath,'audit-habit-ledger-consistency-repair');
  assert.equal(s.saveAttempts[0].options.allowDestructiveOverwrite,true);
  assert.equal(s.saveAttempts[0].options.replaceCompletions,true);
  assert.equal(s.stored.completions[0].source,'vice');
  assert.equal(s.stored.gold,55);assert.equal(s.stored.players[0].name,'YOU');
  assert.match(s.status.textContent,/Repair saved:/);
  assert.equal(s.refreshes,1);
});

test('Habit audit stale-preview and failed-write routes do not claim a successful save',()=>{
  const s=screen('audit',viceState(),{planner:correctionPlanner()});
  s.previewPlan();s.confirm();
  const newer=s.stored;
  newer.completions.unshift({id:'other',source:'habit',habitId:'v1',dayKey:'2026-04-13'});
  s.replace(newer);s.execute();
  assert.equal(s.saveAttempts.length,0,'stale row must not enter V1 writer');
  assert.match(s.status.textContent,/No rows changed/);
  assert.equal(s.stored.completions.length,2,'stale audit cannot remove or rewrite another row');

  const f=screen('audit',viceState(),{planner:correctionPlanner()});
  f.previewPlan();f.confirm();f.failMode='skipped';f.execute();
  assert.equal(f.saveAttempts.length,1);
  assert.equal(f.stored.completions[0].source,'habit');
  assert.match(f.status.textContent,/Repair failed:/);
});

function completionPlanner(){
  return {
    buildHabitLedgerRepairPlan(){return emptyBase()},
    applyHabitLedgerRepairPlan(state){return {state:clone(state),sourceRowsUpdated:0,
      failedRowsRemoved:0,duplicateRowsRemoved:0}},
    planFingerprint(plan){return JSON.stringify(plan)}
  };
}
const completionState=()=>({
  habits:[{id:'h1',name:'Workout',category:'habit',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[{id:'complete-one',source:'habit',habitId:'h1',dayKey:day,points:4}],
  gold:82,matchups:[{id:'match-unrelated',scoreA:8,scoreB:3}]
});
test('actual completion-backed Habit writer repairs missing doneKey but preserves points and Game',()=>{
  const s=screen('completion',completionState(),{planner:completionPlanner()});
  s.previewPlan();assert.match(s.status.textContent,/Preview ready/);
  s.execute();assert.equal(s.saveAttempts.length,0);
  s.confirm();s.execute();
  assert.equal(s.saveAttempts.length,1);
  assert.equal(s.saveAttempts[0].options.savePath,'audit-habit-ledger-completion-backed-repair');
  assert.equal(s.saveAttempts[0].options.replaceCompletions,true);
  assert.deepEqual(s.stored.habits[0].doneKeys,[day]);
  assert.equal(s.stored.completions.length,1);
  assert.equal(s.stored.completions[0].points,4);
  assert.equal(s.stored.gold,82);
  assert.equal(s.stored.matchups[0].scoreA,8);
  assert.match(s.status.textContent,/Repair saved:/);
});
test('completion-backed stale preview and quota failure cannot erase original ledger',()=>{
  const s=screen('completion',completionState(),{planner:completionPlanner()});
  s.previewPlan();s.confirm();
  const changed=s.stored;changed.completions[0].dayKey='2026-04-13';s.replace(changed);s.execute();
  assert.equal(s.saveAttempts.length,0);
  assert.match(s.status.textContent,/Repair failed:/);
  const q=screen('completion',completionState(),{planner:completionPlanner()});
  q.previewPlan();q.confirm();q.failMode='throw';q.execute();
  assert.equal(q.saveAttempts.length,1);
  assert.deepEqual(q.stored.habits[0].doneKeys,[]);
  assert.match(q.status.textContent,/Repair failed:/);
});

function scoreState(){
  const row={id:'m1',matchupId:'m1',dateKey:'2026-04-13',
    playerAId:'YOU',playerBId:'opp',scoreA:21.5,playerAScore:21.5,
    scoreB:10,playerBScore:10,winnerId:'YOU',loserId:'opp',result:'W'};
  return {
    habits:[{id:'h1',doneKeys:[day],failedKeys:[],iceKeys:[]}],
    completions:[
      {id:'keep',habitId:'h1',source:'habit',dayKey:day,points:10},
      {id:'remove-me',habitId:'h1',source:'habit',dayKey:day,points:5},
      {id:'day-two',habitId:'h1',source:'habit',dayKey:'2026-04-13',points:20}
    ],
    matchups:[clone(row)],
    schedule:[{dateKey:'2026-04-13',matchups:[clone(row)]}],
    gameHistory:[{id:'hist1',matchupId:'m1',dateKey:'2026-04-13',
      playerId:'YOU',opponentId:'opp',score:21.5,points:21.5,total:21.5}],
    seasonHistory:[],currentSeason:null,gold:50,players:[{id:'opp'}]
  };
}
function scorer(state){
  const first=(state.completions||[]).filter(r=>r.dayKey===day)
    .reduce((sum,r)=>sum+Number(r.points||0),0);
  return {[day]:first,'2026-04-13':20+first*0.1};
}
function scoreDeps(){
  const planner={
    __habitLedgerBaseApply(state,plan){
      const next=clone(state);next.completions=next.completions.filter(r=>r.id!=='remove-me');
      return {state:next,sourceRowsUpdated:0,failedRowsRemoved:1,duplicateRowsRemoved:0};
    },
    applyHabitLedgerRepairPlan(){throw Error('unverified planner apply')}
  };
  const repair={
    buildPlan(state){return {removePending:(state.completions||[]).some(r=>r.id==='remove-me')}},
    fingerprint(plan){return JSON.stringify(plan)},
    totalCount(plan){return plan?.removePending?1:0},
    applyPlan(state,plan){return {...planner.applyHabitLedgerRepairPlan(state,plan),
      doneKeysAdded:0,failedKeysRemoved:0}}
  };
  return {planner,repair,core:{youDailyTotalsWithInertia:scorer}};
}
test('real score reconciliation writer preserves matchup result and historical score copies',()=>{
  const s=screen('score',scoreState(),scoreDeps());
  s.previewPlan();
  assert.match(s.status.textContent,/Preview verified/);
  s.execute();assert.equal(s.saveAttempts.length,0);
  s.confirm();s.execute();
  assert.equal(s.saveAttempts.length,1);
  assert.equal(s.saveAttempts[0].options.savePath,'audit-habit-ledger-score-reconciliation');
  assert.equal(s.saveAttempts[0].options.allowDestructiveOverwrite,true);
  assert.equal(s.stored.completions.some(r=>r.id==='remove-me'),false);
  assert.equal(s.stored.matchups[0].scoreA,21);
  assert.equal(s.stored.matchups[0].winnerId,'YOU');
  assert.equal(s.stored.schedule[0].matchups[0].scoreA,21);
  assert.equal(s.stored.gameHistory[0].score,21);
  assert.equal(s.stored.gold,50);
  assert.match(s.status.textContent,/Repair saved:/);
});
test('score reconciliation refuses a changed historical matchup after preview',()=>{
  const s=screen('score',scoreState(),scoreDeps());
  s.previewPlan();s.confirm();
  const next=s.stored;next.matchups[0].scoreB=30;
  s.replace(next);s.execute();
  assert.equal(s.saveAttempts.length,0);
  assert.match(s.status.textContent,/Repair failed:/);
});

test('M01 certifies three Habit writer behavior rehearsals but zero production ownership',()=>{
  const inv=JSON.parse(fs.readFileSync(path.join(root,
    'docs/state-runtime-v2-storage-source-inventory.json'),'utf8'));
  const routes=inv.writerBehaviorWitnesses.filter(r=>
    r.testPath==='tests/state_runtime_v2_m01_habit_repair_writer_behavior_contract.test.js');
  assert.deepEqual(routes.map(r=>r.path).sort(),[
    'habit_ledger_completion_backed_repair.js',
    'habit_ledger_repair_audit.js',
    'habit_ledger_score_reconciliation.js'
  ]);
  for(const route of routes){
    assert.ok(inv.writerPathEvidence.some(w=>w.path===route.path&&w.anchor===route.anchor));
    assert.ok(route.observedBehaviors.length>=4);
    assert.equal(route.productionOwnerVerified,false);
    assert.equal(route.productionFenceVerified,false);
    assert.equal(route.cutoverPermission,false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,42);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments,0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced,false);
  assert.equal(inv.writerOwnershipAudit.status,'incomplete');
  assert.equal(inv.writerOwnershipAudit.habitRepairEvidence.productionHandoffCertified,false);
  assert.equal(inv.writerOwnershipAudit.habitRepairEvidence.legacyV1AuthorityUnchanged,true);
});
