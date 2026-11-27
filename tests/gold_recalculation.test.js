const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const gold=fs.readFileSync(path.join(__dirname,'..','greed_gold_economy.js'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'..','gold_recalculation.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','gold_ledger.html'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));

function state() {
  const start='2026-11-05';
  return {
    youName:'Tester',
    players:[{id:'A',name:'Alpha',greed:100},{id:'B',name:'Beta',greed:100}],
    goldEconomy:{version:1,launchDateKey:start,launchedAtISO:start+'T12:00:00Z',
      ignoredSameDayMatchupKeys:[],settledMatchupKeys:['id:g1','id:g2'],
      ignoredChampionKeys:[],settledChampionKeys:[]},
    goldLedger:[
      {id:'open-you',type:'opening_balance',playerId:'YOU',amount:100,balanceAfter:100,dateKey:start},
      {id:'open-A',type:'opening_balance',playerId:'A',amount:50,balanceAfter:50,dateKey:start},
      {id:'open-B',type:'opening_balance',playerId:'B',amount:20,balanceAfter:20,dateKey:start},
      {id:'margin-A',type:'matchup_margin',matchupId:'g1',playerId:'A',opponentId:'YOU',dateKey:'2026-11-15',amount:2,balanceAfter:52},
      {id:'loss-you',type:'matchup_theft',matchupId:'g1',transferId:'t1',playerId:'YOU',opponentId:'A',dateKey:'2026-11-15',amount:-10,balanceAfter:90},
      {id:'gain-A',type:'matchup_theft',matchupId:'g1',transferId:'t1',playerId:'A',opponentId:'YOU',dateKey:'2026-11-15',amount:10,balanceAfter:62},
      {id:'margin-B',type:'matchup_margin',matchupId:'g2',playerId:'B',opponentId:'A',dateKey:'2026-11-16',amount:1,balanceAfter:21},
      {id:'loss-A',type:'matchup_theft',matchupId:'g2',transferId:'t2',playerId:'A',opponentId:'B',dateKey:'2026-11-16',amount:-6.2,balanceAfter:55.8},
      {id:'gain-B',type:'matchup_theft',matchupId:'g2',transferId:'t2',playerId:'B',opponentId:'A',dateKey:'2026-11-16',amount:6.2,balanceAfter:27.2}
    ],
    matchups:[
      {id:'g1',dateKey:'2026-11-15',playerAId:'YOU',playerBId:'A',
        scoreA:60,scoreB:40,result:'you-win',
        goldOutcome:{settled:true,winnerId:'A',loserId:'YOU',marginGoldAwarded:2,theftGoldStolen:10}},
      {id:'g2',dateKey:'2026-11-16',playerAId:'B',playerBId:'A',
        scoreA:40,scoreB:30,playerAEffects:{greedRating:100},
        goldOutcome:{settled:true,winnerId:'B',loserId:'A',marginGoldAwarded:1,theftGoldStolen:6.2}}
    ],
    gameHistory:[],schedule:[],seasonHistory:[]
  };
}

function install(candidate=state(),overrides={}) {
  let clock='2026-11-17T15:00:00-05:00';
  const RealDate=Date;
  class Clock extends RealDate {
    constructor(...args){super(...(args.length?args:[clock]));}
    static now(){return new RealDate(clock).getTime();}
  }
  let saved=clone(candidate),saveCalls=0;
  const storage=new Map([['taskpoints_v1',JSON.stringify(saved)]]);
  const localStorage={
    getItem:key=>storage.get(key)||null,
    setItem:(key,value)=>storage.set(key,String(value))
  };
  const core={
    STORAGE_KEY:'taskpoints_v1',
    parseTaskPointsStorageJson(raw,fallback){try{return JSON.parse(raw);}catch{return fallback;}},
    saveValidatedSnapshot(candidate,options){
      saveCalls++;
      if(overrides.blockSave)return {blocked:true};
      saved=clone(candidate);localStorage.setItem('taskpoints_v1',JSON.stringify(saved));
      return {state:candidate};
    },
    ...overrides.core
  };
  const context=vm.createContext({
    TaskPointsCore:core,localStorage,console:{warn(){},error(){},log(){}},
    document:{readyState:'loading',addEventListener(){},querySelectorAll:()=>[]},
    window:null,Date:Clock,JSON,Number,String,Math,Array,Object,Set,Map,RegExp,
    encodeURIComponent,setTimeout(){},clearTimeout(){},crypto:{randomUUID:()=> 'test-run-001'}
  });
  context.window=context;context.globalThis=context;
  vm.runInContext(gold,context,{filename:'greed_gold_economy.js'});
  vm.runInContext(source,context,{filename:'gold_recalculation.js'});
  return {api:context.TaskPointsGoldRecalculation,core,localStorage,
    getSaved:()=>JSON.parse(localStorage.getItem('taskpoints_v1')),
    getWrites:()=>saveCalls,
    setClock:iso=>{clock=iso;},
    context};
}

test('read-only replay corrects reversed YOU win and downstream opponent theft rates',()=>{
  const h=install(),before=JSON.stringify(h.getSaved());
  const r=h.api.preview();
  assert.equal(r.launch,'2026-11-05');
  assert.equal(r.until,'2026-11-16');
  assert.equal(r.stats.games,2);
  assert.equal(r.stats.incorrectResults,1);
  assert.equal(r.stats.affected,3);
  assert.deepEqual(clone(r.changes.map(x=>[x.playerId,x.before,x.after,x.delta])),
    [['YOU',90,104.5,14.5],['A',55.8,42.7,-13.1],['B',27.2,25.8,-1.4]]);
  assert.equal(h.getWrites(),0);
  assert.equal(JSON.stringify(h.getSaved()),before);
});

test('protected correction appends wallet adjustments, retains every saved row byte-for-byte, and is idempotent',()=>{
  const h=install(),initial=h.getSaved(),r=h.api.preview();
  assert.equal(r.changes.length,3);
  const result=h.api.commit();
  assert.equal(h.getWrites(),1);
  const after=h.getSaved();
  assert.equal(after.goldLedger.length,initial.goldLedger.length+3);
  assert.deepEqual(after.goldLedger.slice(0,initial.goldLedger.length),initial.goldLedger);
  assert.equal(result.adjustments.every(x=>x.type==='gold_recalculation_adjustment'),true);
  assert.equal(result.adjustments.every(x=>x.meta.throughDateKey==='2026-11-16'),true);
  assert.equal(result.adjustments[0].balanceAfter,104.5);
  assert.equal(h.api.preview().changes.length,0);
  assert.throws(()=>h.api.commit(),/no Gold corrections/i);
  assert.equal(h.getWrites(),1);
});

test('same-day provisional Gold transactions remain as-is until the day is finished',()=>{
  const s=state();
  s.goldLedger.push(
    {id:'today-loss',type:'matchup_theft',matchupId:'g3',playerId:'YOU',
      opponentId:'A',amount:-9,balanceAfter:81,dateKey:'2026-11-17'},
    {id:'today-gain',type:'matchup_theft',matchupId:'g3',playerId:'A',
      opponentId:'YOU',amount:9,balanceAfter:64.8,dateKey:'2026-11-17'});
  s.matchups.push({id:'g3',dateKey:'2026-11-17',playerAId:'YOU',playerBId:'A',
    scoreA:60,scoreB:30,goldOutcome:{settled:true,winnerId:'A',loserId:'YOU',theftGoldStolen:9}});
  const h=install(s),r=h.api.preview();
  assert.equal(r.stats.games,2);
  assert.equal(r.stats.frozenTransactions,2);
  assert.equal(r.changes.find(x=>x.playerId==='YOU').delta,14.5);
  assert.equal(h.getWrites(),0);
});

test('preview invalidates if any saved state changes before confirmation',()=>{
  const h=install(),preview=h.api.preview();
  const modified=h.getSaved();modified.tasks=[{id:'new-task'}];
  h.localStorage.setItem('taskpoints_v1',JSON.stringify(modified));
  assert.throws(()=>h.api.commit(),/changed.*fresh preview/i);
  assert.equal(h.getWrites(),0);
  assert.equal(preview.changes.length,3);
});

test('ledger inconsistencies, unknown historical games, and recovery holds block without writing',()=>{
  const inconsistent=state();inconsistent.goldLedger[4].balanceAfter=999;
  const h1=install(inconsistent);
  assert.throws(()=>h1.api.preview(),/running balance/i);assert.equal(h1.getWrites(),0);
  const unknown=state();unknown.goldLedger[3].matchupId='missing-game';
  const h2=install(unknown);
  assert.throws(()=>h2.api.preview(),/lacks a final recorded game/i);assert.equal(h2.getWrites(),0);
  const h3=install();h3.localStorage.setItem('taskpoints_emergency_recovery_hold_v1',JSON.stringify({active:true}));
  assert.throws(()=>h3.api.preview(),/Recovery hold/i);assert.equal(h3.getWrites(),0);
});

test('a blocked protected save never claims a correction',()=>{
  const h=install(state(),{blockSave:true});
  h.api.preview();
  assert.throws(()=>h.api.commit(),/protected save did not accept/i);
  assert.equal(h.getWrites(),1);
  assert.equal(h.getSaved().goldLedger.length,9);
});

test('Gold Ledger exposes both stages, preserves manual adjustment and labels repair transactions',()=>{
  for(const part of ['id="goldRecalcSection"','id="goldRecalcPreviewButton"','id="goldRecalcApplyButton"',
    'gold_recalculation.js','gold_recalculation_adjustment','id="goldManualForm"'])
    assert.ok(html.includes(part),'Missing '+part);
  assert.match(source,/saveValidatedSnapshot\(candidate/);
  assert.doesNotMatch(source,/loadAppState\(/);
});

function replacedSlate(){
  const s=state(), when='2026-11-16';
  for(const id of ['C','D','E','F']){
    s.players.push({id,name:id,greed:100});
    s.goldLedger.push({id:'open-'+id,type:'opening_balance',playerId:id,amount:100,balanceAfter:100,dateKey:s.goldEconomy.launchDateKey});
  }
  function settled(id,winner,loser,winBefore,loseBefore){
    s.goldEconomy.settledMatchupKeys.push('id:'+id);
    s.goldLedger.push(
      {id:id+'-m',type:'matchup_margin',matchupId:id,playerId:winner,opponentId:loser,dateKey:when,amount:1,balanceAfter:winBefore+1},
      {id:id+'-l',type:'matchup_theft',matchupId:id,transferId:id+'-t',playerId:loser,opponentId:winner,dateKey:when,amount:-10,balanceAfter:loseBefore-10},
      {id:id+'-g',type:'matchup_theft',matchupId:id,transferId:id+'-t',playerId:winner,opponentId:loser,dateKey:when,amount:10,balanceAfter:winBefore+11});
  }
  settled('old1','C','D',100,100);settled('old2','E','F',100,100);
  settled('new1','C','E',111,111);settled('new2','D','F',90,90);
  for(const [id,a,b] of [['new1','C','E'],['new2','D','F']])
    s.matchups.push({id,dateKey:when,playerAId:a,playerBId:b,scoreA:40,scoreB:30,playerAEffects:{greedRating:100}});
  return s;
}
test('complete replacement slate replays only surviving games, preserves original rows and is repeat-safe',()=>{
  const h=install(replacedSlate()),initial=h.getSaved(),p=h.api.preview();
  assert.equal(p.stats.orphanGames,2);assert.equal(p.stats.orphanTransactions,6);
  assert.deepEqual(clone(p.stats.replacedDays),[{dateKey:'2026-11-16',games:2,transactions:6}]);
  assert.equal(p.changes.find(x=>x.playerId==='C').after,111);
  assert.equal(p.changes.find(x=>x.playerId==='D').after,111);
  assert.equal(p.changes.find(x=>x.playerId==='E').after,90);
  assert.equal(p.changes.find(x=>x.playerId==='F').after,90);
  assert.equal(h.getWrites(),0);
  h.api.commit();
  assert.deepEqual(h.getSaved().goldLedger.slice(0,initial.goldLedger.length),initial.goldLedger);
  assert.equal(h.api.preview().changes.length,0);
});
test('incomplete replacement evidence and surviving partial IDs block without writing',()=>{
  const s=replacedSlate();s.matchups=s.matchups.filter(x=>x.id!=='new2');
  const h=install(s);assert.throws(()=>h.api.preview(),/Replacement evidence is incomplete/);assert.equal(h.getWrites(),0);
  const t=replacedSlate();t.schedule=[{matchups:[{id:'old1'}]}];
  const h2=install(t);assert.throws(()=>h2.api.preview(),/Replacement evidence is incomplete/);assert.equal(h2.getWrites(),0);
  const u=replacedSlate();u.goldEconomy.settledMatchupKeys=u.goldEconomy.settledMatchupKeys.filter(x=>x!=='id:old1');
  const h3=install(u);assert.throws(()=>h3.api.preview(),/Replacement evidence is incomplete/);assert.equal(h3.getWrites(),0);
});
test('Gold correction requires a verified pre-write recovery snapshot',()=>{
  const h=install(replacedSlate(),{core:{saveValidatedSnapshot(candidate,options){
    assert.equal(options.requireVerifiedRollingBackup,true);
    return {blocked:true,reason:'Verified recovery snapshot could not be created.'};
  }}});
  h.api.preview();assert.throws(()=>h.api.commit(),/Verified recovery snapshot/);
});
