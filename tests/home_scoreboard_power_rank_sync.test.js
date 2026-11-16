const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const power = fs.readFileSync(path.join(__dirname, '..', 'rankings.html'), 'utf8');
const bonus = fs.readFileSync(path.join(__dirname, '..', 'season_champion_gold_bonus.js'), 'utf8');

function fn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const open = source.indexOf('{', start);
  let depth=0;
  for(let i=open;i<source.length;i++){
    if(source[i]==='{')depth++;
    else if(source[i]==='}' && --depth===0)return source.slice(start,i+1);
  }
  throw new Error('unclosed '+name);
}
function setupBonus() {
  const context = vm.createContext({
    console, Date, Map, Set, Math, Number, String, Array, Object, JSON,
    location:{pathname:'/index.html'},
    document:{readyState:'loading',addEventListener(){}},
    TaskPointsCore:{STORAGE_KEY:'taskpoints_v1'}
  });
  context.window=context;context.globalThis=context;
  vm.runInContext(bonus,context);
  return context.TaskPointsSeasonChampionGoldBonus;
}
function sampleState() {
  const players=Array.from({length:120},(_,i)=>({id:'P'+i,name:'Player '+i,active:true}));
  let seed=1267;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  const matchups=Array.from({length:6100},(_,i)=>({
    id:'m'+i,dateKey:i%31===0?'2026-11-16':'2026-11-'+String(i%15+1).padStart(2,'0'),
    playerAId:players[Math.floor(random()*120)].id,
    playerBId:players[Math.floor(random()*120)].id,
    scoreA:i%31===0?null:Math.round(random()*100),
    scoreB:i%29===0?null:Math.round(random()*100)
  }));
  return { players,matchups,gameHistory:[],youName:'Miggy',
    goldEconomy:{version:1},
    goldLedger:players.map((p,i)=>({playerId:p.id,amount:i*2})),
    seasonHistory:[{id:'one',endDateKey:'2026-09-30',championId:'P17'},
                   {id:'two',endDateKey:'2026-10-31',championId:'P12'}] };
}
test('Home rank matches the Power Rankings 75/25 order and keeps canonical PPD',()=>{
  const state=sampleState(), helper=setupBonus();
  const scoped={...state,matchups:state.matchups.filter(m=>m.dateKey>='2026-11-01')};
  const totals=helper.buildPowerRankingTotalGoldMap(state,scoped,{todayKey:'2026-11-16'});
  const canonical=[{playerId:'YOU',winPct:0.6,ppd:53,rank:1},...state.players.map((p,i)=>({
    playerId:p.id,winPct:(i%20+1)/21,ppd:i%55,rank:i+2
  }))];
  const core={computeCanonicalRankings:()=>canonical};
  const h=vm.createContext({
    state,window:{TaskPointsCore:core,TaskPointsSeasonChampionGoldBonus:{
      buildPowerRankingTotalGoldMap:()=>totals
    }},TaskPointsCore:core,Date,Map,Number,Math,performance:{now:()=>200},
    getHomeScoreboardCurrentSeasonState:()=>scoped,
    getGameDayKey:()=> '2026-11-16'
  });
  vm.runInContext('let homePowerRankingCache = null;\n'+fn(home,'getCanonicalRankingMap'),h);
  const homeRows=h.getCanonicalRankingMap();
  const p=vm.createContext({
    window:{TaskPointsCore:core},TaskPointsCore:core,
    computeRankingExtrasForPlayer:(player,row)=>({gold:totals.get(row.playerId)||0}),
    Math,Number,Map
  });
  vm.runInContext(fn(power,'computePowerRankedRows'),p);
  const expected=p.computePowerRankedRows(scoped,new Map());
  assert.deepEqual(Array.from(homeRows.values(),row=>row.playerId), Array.from(expected,row=>row.playerId));
  for(const row of expected) {
    assert.equal(homeRows.get(row.playerId).rank,row.rank);
    assert.equal(homeRows.get(row.playerId).ppd,row.ppd);
    assert.equal(homeRows.get(row.playerId).powerGold,row.powerGold);
  }
  assert.ok(totals.get('P17')>=25);
});
test('Home rank helper remains read-only and the rank marker uses its order',()=>{
  const source=fn(home,'getCanonicalRankingMap');
  assert.match(source,/computeCanonicalRankings\(scopedState, \{ preindexed: true \}\)/);
  assert.match(source,/row.powerScore = 0.75 \* winShare \+ 0.25 \* goldShare/);
  assert.doesNotMatch(source,/saveStateSnapshot|mergeAndSaveState|localStorage\.setItem/);
  assert.match(bonus,/global\.TaskPointsHomeRankPercentileLine\?\.scheduleRender\?\.\(\)/);
  assert.match(home,/function getHomepageRankValue\(playerId\)/);
  assert.match(home,/function getHomepagePpdValue\(playerId\)/);
});
