const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const goldSource=fs.readFileSync(path.join(__dirname,'../greed_gold_economy.js'),'utf8');
const {buildGoldIntegrityChecks}=require('../audit_gold_integrity.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const money=n=>Math.round((n+Number.EPSILON)*10)/10;
const ids=['A','B','C','D','E','F'];

function setup() {
 let persisted={
  players:ids.map(id=>({id,name:id,active:true,greed:100})),
  matchups:[],gameHistory:[],seasonHistory:[],
  goldEconomy:{version:1,launchedAtISO:'2026-11-05T12:00:00.000Z',launchDateKey:'2026-11-05',
   settledMatchupKeys:[],ignoredSameDayMatchupKeys:[],ignoredChampionKeys:[],settledChampionKeys:[]},
  goldLedger:ids.map((id,i)=>({id:'open:'+id,type:'opening_balance',playerId:id,
   dateKey:'2026-11-05',amount:10*(i+1),balanceAfter:10*(i+1)}))
 };
 function runtime() {
   const storage={getItem:key=>key==='taskpoints_v1'?JSON.stringify(persisted):null,
     setItem:(key,value)=>{if(key==='taskpoints_v1')persisted=JSON.parse(value)}};
   const core={
     STORAGE_KEY:'taskpoints_v1',
     parseTaskPointsStorageJson:raw=>JSON.parse(raw),
     loadAppState(){return {state:clone(persisted)}},
     saveStateSnapshot(state){persisted=clone(state);return {state:clone(persisted)}},
     saveAppState(state){persisted=clone(state);return {state:clone(persisted)}},
     mergeAndSaveState(state){persisted=clone({...persisted,...state});return {state:clone(persisted)}}
   };
   const context=vm.createContext({TaskPointsCore:core,localStorage:storage,Date,Math,JSON,Number,
     String,Array,Object,Set,Map,RegExp,encodeURIComponent,
     setTimeout(){},clearTimeout(){},console:{warn(){},log(){},error(){}},
     document:{readyState:'loading',addEventListener(){},querySelector(){return null},querySelectorAll(){return []}}});
   context.window=context;context.globalThis=context;
   vm.runInContext(goldSource,context,{filename:'greed_gold_economy.js'});
   return {core:context.TaskPointsCore,api:context.TaskPointsGreedGoldEconomy};
 }
 return {load:()=>clone(persisted),runtime};
}

test('150 games over 30 days: Gold survives saves, restarts, and page edits without double-credit',()=>{
 const h=setup();
 let rt=h.runtime();
 const expected=new Map(ids.map((id,i)=>[id,(i+1)*10]));
 let thefts=0,restarts=0;
 for(let d=0;d<30;d++){
   const day=new Date(Date.UTC(2026,10,6+d)).toISOString().slice(0,10);
   for(let k=0;k<5;k++){
     const indexA=(d*3+k)%ids.length,indexB=(indexA+1+(k%4))%ids.length;
     const a=ids[indexA],b=ids[indexB],scoreA=45+(d*13+k*7)%31,scoreB=45+(d*17+k*11)%31;
     const match={id:'sim-'+d+'-'+k,dateKey:day,playerAId:a,playerBId:b,scoreA,scoreB};
     const state=h.load();state.matchups.push(match);
     rt.api.reconcileGoldEconomy(state,{dateKey:day});
     const outcome=state.matchups[state.matchups.length-1].goldOutcome;
     assert.equal(outcome.settled,true);
     if(scoreA!==scoreB) {
       const winner=scoreA>scoreB?a:b,loser=scoreA>scoreB?b:a;
       const winBefore=expected.get(winner),loseBefore=expected.get(loser);
       const stolen=Math.min(loseBefore,money(loseBefore*.1));
       const margin=money(Math.abs(scoreA-scoreB)/10);
       assert.equal(outcome.winnerPregameGold,winBefore);
       assert.equal(outcome.loserPregameGold,loseBefore);
       assert.equal(outcome.theftGoldStolen,stolen);
       assert.equal(outcome.marginGoldAwarded,margin);
       expected.set(winner,money(winBefore+stolen+margin));
       expected.set(loser,money(loseBefore-stolen));
       if(stolen>0)thefts++;
     }
     rt.core.saveStateSnapshot(state,{savePath:'simulated-game'});
     ids.forEach(id=>assert.equal(rt.api.goldBalance(h.load(),id),expected.get(id)));
     const prior=h.load();
     rt.core.loadAppState({syncDerived:false,persistSync:false});
     assert.deepEqual(h.load().goldLedger,prior.goldLedger,'reload may not change transactions');
     if((d*5+k)%13===0){
       rt.core.mergeAndSaveState({players:prior.players,matchups:prior.matchups,gameHistory:[],seasonHistory:[]},
         {savePath:'simulated-unrelated-page'});
     }
     if((d*5+k)%15===14){rt=h.runtime();restarts++;}
   }
 }
 const final=h.load();
 const transfers=new Map();
 final.goldLedger.filter(row=>row.type==='matchup_theft').forEach(row=>{
   if(!transfers.has(row.transferId))transfers.set(row.transferId,[]);
   transfers.get(row.transferId).push(row);
 });
 assert.equal(transfers.size,thefts);
 for(const rows of transfers.values()){
   assert.equal(rows.length,2);
   assert.equal(money(rows[0].amount+rows[1].amount),0);
 }
 assert.equal(restarts,10);
 assert.equal(final.goldEconomy.launchDateKey,'2026-11-05');
 assert.equal(final.goldEconomy.settledMatchupKeys.length,150);
 assert.deepEqual(buildGoldIntegrityChecks(final,{rollingBackups:[{state:clone(final)}]}).map(c=>c.status),
   ['PASS','PASS','PASS','PASS']);
 const before=clone(final);
 rt.api.reconcileGoldEconomy(final);
 assert.deepEqual(final.goldLedger,before.goldLedger,'same matchups should not mint Gold twice');
 const orphan={players:final.players,goldLedger:clone(final.goldLedger),matchups:[],seasonHistory:[]};
 assert.equal(rt.api.reconcileGoldEconomy(orphan).blocked,true,'orphaned history must not be erased');
 assert.deepEqual(orphan.goldLedger,final.goldLedger);
 const forgotten={players:final.players,matchups:clone(final.matchups),gameHistory:[],seasonHistory:[]};
 assert.equal(rt.api.reconcileGoldEconomy(forgotten).blocked,true,
   'recorded Gold outcomes must also block a full ledger+metadata reset');
 assert.equal(forgotten.goldEconomy,undefined);
 assert.equal(forgotten.goldLedger,undefined);
});
