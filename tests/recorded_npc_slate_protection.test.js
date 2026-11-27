const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreSource = fs.readFileSync(path.join(__dirname,'..','scoring_core.js'),'utf8');
const goldSource = fs.readFileSync(path.join(__dirname,'..','greed_gold_economy.js'),'utf8');
const home = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const day = '2026-11-27';
function game(id,a,b,scoreA=50,scoreB=40,dateKey=day) {
  return {id,dateKey,playerAId:a,playerBId:b,scoreA,scoreB,goldOutcome:{settled:true}};
}
function extract(s,name) {
  const start=s.indexOf('function '+name+'(');
  assert.ok(start>=0,name);
  let open=s.indexOf('{',start),depth=0;
  // Helpers with a default object parameter need the function body, not the default.
  if(s.slice(open,open+2)==='{}')open=s.indexOf('{',open+2);
  for(let i=open;i<s.length;i++){
    if(s[i]==='{')depth++;
    if(s[i]==='}'&&--depth===0)return s.slice(start,i+1);
  }
  throw Error('unclosed '+name);
}
const ctx={Set,Map,console, dateKey:x=>String(x).slice(0,10)};
vm.createContext(ctx);
vm.runInContext(['getStoredMatchupDateKey','finiteNumberValue','isSeasonTournamentMatchup',
  'recordedNpcGame','protectedNpcSlateGame','matchupStableIdentity','assertRecordedNpcHistoryPreserved']
  .map(name=>extract(coreSource,name)).join('\n')+
  '\nthis.check=assertRecordedNpcHistoryPreserved;',ctx);
test('stale full save cannot replace or delete a recorded NPC game',()=>{
  const original=game('original','A','B');
  const saved={matchups:[original]};
  assert.throws(()=>ctx.check(saved,{matchups:[game('replacement','A','C')]}),/protection blocked/);
  assert.throws(()=>ctx.check(saved,{matchups:[{...original,playerBId:'C'}]}),/protection blocked/);
  assert.throws(()=>ctx.check(saved,{matchups:[{...original,scoreA:99}]}),/protection blocked/);
  assert.throws(()=>ctx.check(saved,{matchups:[original,game('replacement','A','C')]}),/replacement game/);
});
test('legitimate additional games, future dates, score edits and explicit restores still work',()=>{
  const original=game('original','A','B'),saved={matchups:[original]};
  ctx.check(saved,{matchups:[original,game('missing','C','D'),game('tomorrow','A','B',55,40,'2026-11-28')]});
  ctx.check(saved,{matchups:[{...original,scoreA:60}]},{savePath:'matchups-edit-result'});
  ctx.check(saved,{matchups:[]},{allowDestructiveOverwrite:true});
});
test('historical duplicates already present do not block unrelated saves',()=>{
  const saved={matchups:[game('original','A','B'),game('already-existing','A','C')]};
  ctx.check(saved,JSON.parse(JSON.stringify(saved)));
});
test('Gold slot guard blocks a replacement even when the original game is absent',()=>{
  const gc={Set,Map,console};
  vm.createContext(gc);
  vm.runInContext(['rowDateKey','matchupContext','matchupIdentity','goldDailySettlementSlots','goldDailySlotConflict']
    .map(name=>extract(goldSource,name)).join('\n')+
    '\nthis.index=goldDailySettlementSlots;this.conflict=goldDailySlotConflict;',gc);
  const old={goldLedger:[{type:'matchup_margin',dateKey:day,matchupId:'lost',playerId:'A',opponentId:'B'}],matchups:[]};
  const index=gc.index(old);
  assert.equal(gc.conflict(index,game('new','A','C')),true);
  assert.equal(gc.conflict(index,game('new','C','B')),true);
  assert.equal(gc.conflict(index,game('lost','A','B')),false);
  assert.equal(gc.conflict(index,game('new','C','D')),false);
  assert.equal(gc.conflict(index,game('new','A','B',50,40,'2026-11-28')),false);
});
test('recorded ties reserve a daily settlement slot without Gold transactions',()=>{
  const gc={Set,Map,console};
  vm.createContext(gc);
  vm.runInContext(['rowDateKey','matchupContext','matchupIdentity','goldDailySettlementSlots','goldDailySlotConflict']
    .map(name=>extract(goldSource,name)).join('\n')+
    '\nthis.index=goldDailySettlementSlots;this.conflict=goldDailySlotConflict;',gc);
  const index=gc.index({matchups:[game('tie','A','B',50,50)],goldLedger:[]});
  assert.equal(gc.conflict(index,game('replacement','B','C')),true);
});
test('Home refreshes saved games before morning readiness; core and settlement guards are wired',()=>{
  assert.ok(home.indexOf('const refreshed = refreshRecordedGamesBeforeDailySimulation(todayKey);')>=0);
  assert.match(coreSource,/assertRecordedNpcHistoryPreserved\(latest, next, options\)/);
  assert.match(coreSource,/frozenExhibitions\.concat\(generatedExhibitions\)/);
  assert.match(goldSource,/goldDailySlotConflict\(dailySlots, matchup\)/);
});

test('persisted orphan ledger entries protect both players even with no saved matchup rows',()=>{
  const saved={matchups:[],goldLedger:[
    {type:'matchup_margin',matchupId:'lost',playerId:'A',opponentId:'B',dateKey:day}
  ]};
  assert.throws(()=>ctx.check(saved,{matchups:[game('replacement','A','C')]}),/replacement game/);
  assert.throws(()=>ctx.check(saved,{matchups:[game('replacement','C','B')]}),/replacement game/);
  ctx.check(saved,{matchups:[game('legitimate','C','D')]});
});

test('archive duplicates do not override the current authoritative matchup row',()=>{
  const original=game('original','A','B'),saved={matchups:[original]};
  ctx.check(saved,{matchups:[original],seasonHistory:[
    {tournamentMatchupResults:[{...original,scoreA:1}]}
  ]});
});

test('Home readiness checks every known scheduled pair without rerolling completed games',()=>{
  const original=game('original','A','B');
  const missing={id:'missing',playerAId:'C',playerBId:'D'};
  const h={state:{matchups:[original],schedule:[{date:day,matchups:[original,missing]}]},
    getMatchupDateKeyLocal:row=>row.dateKey,hasRecordedMatchupScore:row=>Number.isFinite(row.scoreA)&&Number.isFinite(row.scoreB)};
  vm.createContext(h);
  vm.runInContext(extract(home,'homeDailyMatchupsReady')+'\nthis.ready=homeDailyMatchupsReady;',h);
  assert.equal(h.ready(day),false);
  h.state.matchups.push(game('missing','C','D'));
  assert.equal(h.ready(day),true);
  h.state.schedule=[];
  assert.equal(h.ready(day),true,'unknown remaining schedule must not trigger a replacement slate');
  assert.match(home,/const recorded = recordedNpcScores\.get\(id\)/);
});

test('actual Gold settlement refuses replacement games and preserves the ledger',()=>{
  const state={players:[{id:'A',greed:50},{id:'B',greed:50},{id:'C',greed:50},{id:'D',greed:50}],
    matchups:[],gameHistory:[],seasonHistory:[],
    goldEconomy:{version:1,launchDateKey:'2026-11-05',settledMatchupKeys:[],
      ignoredSameDayMatchupKeys:[],settledChampionKeys:[],ignoredChampionKeys:[]},
    goldLedger:[]};
  const runtime={TaskPointsCore:{STORAGE_KEY:'taskpoints_v1'},document:{readyState:'loading',addEventListener(){}},
    localStorage:{getItem(){return null}},console:{warn(){},error(){},log(){}},
    setTimeout(){},clearTimeout(){},Date,Math,JSON,Set,Map,Object,Array,String,Number,encodeURIComponent};
  runtime.window=runtime;
  vm.createContext(runtime);
  vm.runInContext(goldSource,runtime);
  const api=runtime.TaskPointsGreedGoldEconomy;
  const original={...game('original','A','B'),goldOutcome:undefined};
  state.matchups.push(original);
  assert.equal(api.settleOneMatchup(state,original),true);
  const saved=JSON.stringify(state.goldLedger);
  const replacement={...game('replacement','A','C'),goldOutcome:undefined};
  state.matchups=[replacement]; // reproduce an orphaned original
  assert.equal(api.settleOneMatchup(state,replacement),false);
  assert.equal(JSON.stringify(state.goldLedger),saved);
  const legal={...game('legal','C','D'),goldOutcome:undefined};
  state.matchups.push(legal);
  assert.equal(api.settleOneMatchup(state,legal),true);
  assert.equal(api.settleOneMatchup(state,legal),false);
});
