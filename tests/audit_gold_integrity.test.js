const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGoldIntegrityChecks } = require('../audit_gold_integrity.js');

function fixture() {
  return {
    players: [{id:'D',name:'Drumpf'},{id:'B',name:'Rival'}],
    goldEconomy: {version:1,launchDateKey:'2026-11-05',
      launchedAtISO:'2026-11-05T11:46:23.000Z',
      ignoredSameDayMatchupKeys:[],settledMatchupKeys:['id:today']},
    goldLedger: [
      {id:'open-d',type:'opening_balance',playerId:'D',amount:4.7,balanceAfter:4.7,dateKey:'2026-11-05'},
      {id:'open-b',type:'opening_balance',playerId:'B',amount:10,balanceAfter:10,dateKey:'2026-11-05'},
      {id:'margin',type:'matchup_margin',matchupId:'today',playerId:'D',amount:1.3,balanceAfter:6,dateKey:'2026-11-05'},
      {id:'loss',type:'matchup_theft',transferId:'t',matchupId:'today',playerId:'B',opponentId:'D',amount:-.2,balanceAfter:9.8,dateKey:'2026-11-05'},
      {id:'gain',type:'matchup_theft',transferId:'t',matchupId:'today',playerId:'D',opponentId:'B',amount:.2,balanceAfter:6.2,dateKey:'2026-11-05'}
    ],
    matchups: [
      {id:'old',dateKey:'2026-11-03',goldOutcome:{settled:true,winnerId:'D',loserId:'B',theftGoldStolen:12,marginGoldAwarded:1.1}},
      {id:'today',dateKey:'2026-11-05',goldOutcome:{settled:true,winnerId:'D',loserId:'B',theftGoldStolen:.2,marginGoldAwarded:1.3}}
    ]
  };
}
const copy=s=>JSON.parse(JSON.stringify(s));
const run=(s,prior=s)=>buildGoldIntegrityChecks(s,{rollingBackups:[{source:'prior',state:copy(prior)}]});
const statuses=x=>x.map(c=>c.status);
test('fresh ledger ignores prelaunch thefts and passes all checks',()=>{
 const s=fixture(), before=JSON.stringify(s);
 assert.deepEqual(statuses(run(s)),['PASS','PASS','PASS','PASS']);
 assert.equal(JSON.stringify(s),before);
});
test('wrong running balance is a hard failure',()=>{
 const s=fixture();s.goldLedger[4].balanceAfter=100;
 assert.equal(run(s)[0].status,'FAIL');
});
test('broken or duplicate theft pair is caught',()=>{
 const s=fixture();s.goldLedger.push({...s.goldLedger[4]});
 assert.equal(run(s)[0].status,'FAIL');
 assert.equal(run(s)[1].status,'FAIL');
});
test('post-launch missing theft is a hard failure',()=>{
 const s=fixture();
 s.matchups.push({id:'new',dateKey:'2026-11-06',
 goldOutcome:{settled:true,winnerId:'D',loserId:'B',theftGoldStolen:2}});
 assert.equal(run(s)[2].status,'FAIL');
});
test('post-launch missing margin is a hard failure',()=>{
 const s=fixture();
 s.matchups.push({id:'new',dateKey:'2026-11-06',
 goldOutcome:{settled:true,winnerId:'D',loserId:'B',marginGoldAwarded:3}});
 assert.equal(run(s)[2].status,'FAIL');
});
test('unexpected Gold launch change and missing historical IDs are detected',()=>{
 const prior=fixture(),current=copy(prior);
 current.goldEconomy.launchedAtISO='2026-11-06T10:00:00Z';
 assert.equal(run(current,prior)[3].status,'FAIL');
 const missing=copy(prior);missing.goldLedger.splice(2,1);
 assert.equal(run(missing,prior)[3].status,'FAIL');
});
test('missing prior baseline warns rather than claiming continuity verified',()=>{
 assert.deepEqual(statuses(buildGoldIntegrityChecks(fixture())),['PASS','PASS','PASS','WARN']);
});
test('Audit page wires four Gold checks without replacing existing checks',()=>{
 const audit=fs.readFileSync(path.join(__dirname,'../audit.html'),'utf8');
 assert.match(audit,/audit_gold_integrity\.js\?v=20261105-1/);
 assert.match(audit,/checks\.push\(\.\.\.window\.TaskPointsAuditGoldIntegrity\.buildGoldIntegrityChecks/);
 assert.match(audit,/buildHabitViceScoringDateAudit/);
 assert.match(audit,/daily-total-parity/);
});
