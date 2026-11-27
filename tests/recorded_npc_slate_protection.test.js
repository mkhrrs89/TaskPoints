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