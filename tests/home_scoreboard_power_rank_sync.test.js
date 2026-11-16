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
  assert.match(source,/computeCanonicalRankings\(rankingState, \{ preindexed: true \}\)/);
  assert.match(source,/row.powerScore = 0.75 \* winShare \+ 0.25 \* goldShare/);
  assert.doesNotMatch(source,/saveStateSnapshot|mergeAndSaveState|localStorage\.setItem/);
  assert.match(bonus,/global\.TaskPointsHomeRankPercentileLine\?\.scheduleRender\?\.\(\)/);
  assert.match(home,/function getHomepageRankValue\(playerId\)/);
  assert.match(home,/function getHomepagePpdValue\(playerId\)/);
});


test('batched Home Gold equals individual existing Power Rankings Gold across historical quirks',()=>{
  const helper=setupBonus();
  const state={
    players:[{id:'A',active:true},{id:'B',active:true},{id:'C',active:true}],
    gameHistory:[],
    seasonHistory:[{id:'champion',endDateKey:'2026-10-31',championId:'A'},
                   {id:'champion',endDateKey:'2026-10-31',championId:'A'}],
    matchups:[
      {id:'self-loss',dateKey:'2026-11-10',playerAId:'A',playerBId:'A',scoreA:10,scoreB:90},
      {id:'self-win',dateKey:'2026-11-11',playerAId:'A',playerBId:'A',scoreA:30,scoreB:10},
      {id:'A-B',dateKey:'2026-11-12',playerAId:'A',playerBId:'B',scoreA:54,scoreB:23},
      {id:'B-C',dateKey:'2026-11-13',playerAId:'B',playerBId:'C',scoreA:18,scoreB:32},
      {id:'invalid',dateKey:'2026-11-14',playerAId:'B',playerBId:'C',scoreA:'N/A',scoreB:20},
      {id:'today',dateKey:'2026-11-16',playerAId:'A',playerBId:'C',scoreA:1000,scoreB:0},
      {id:'pre-Gold',dateKey:'2026-06-30',playerAId:'A',playerBId:'B',scoreA:100,scoreB:0}
    ]
  };
  const scope={...state,matchups:state.matchups.filter(m=>m.dateKey>='2026-11-01')};
  const round=value=>Math.round((Number(value)+Number.EPSILON)*10)/10;
  for(const withLedger of [false,true]){
    if(withLedger){
      state.goldEconomy={version:1};
      state.goldLedger=[{playerId:'A',amount:8.1},{playerId:'A',amount:-0.3},
                        {playerId:'B',amount:20},{playerId:'C',amount:1.1}];
    }else{
      delete state.goldEconomy;
      delete state.goldLedger;
    }
    const totals=helper.buildPowerRankingTotalGoldMap(state,scope,{todayKey:'2026-11-16'});
    for(const id of ['A','B','C','YOU']){
      let scopedMargin=0;
      for(const m of scope.matchups){
        if(m.dateKey>='2026-11-16'||m.dateKey<'2026-07-01')continue;
        const isA=m.playerAId===id, isB=m.playerBId===id;
        if(!isA&&!isB)continue;
        const a=Number(m.scoreA), b=Number(m.scoreB);
        if(!Number.isFinite(a)||!Number.isFinite(b))continue;
        const margin=isA?a-b:b-a;
        if(margin>0)scopedMargin+=margin/10;
      }
      const wallet=(state.goldLedger||[]).filter(row=>row.playerId===id).reduce((sum,row)=>sum+row.amount,0);
      const base=round(withLedger?wallet:scopedMargin);
      const cumulative=helper.getCumulativeMatchupGold(id,state,{todayKey:'2026-11-16'});
      const bonusGold=helper.getTournamentChampionGoldBonus(id,state);
      assert.equal(totals.get(id),round(Math.max(base,cumulative)+bonusGold),
        'batch equals previous Gold formula for '+id+' (ledger='+withLedger+')');
    }
    assert.ok(totals.get('A')<120,'self-match reverse side and today match cannot inflate Gold');
  }
});

test('Home includes the same archived results that Power Rankings counts',()=>{
  const state={
    players:[{id:'DONUT',active:true},{id:'HOLLIS',active:true}],
    matchups:[{id:'regular',dateKey:'2026-11-07',playerAId:'DONUT',playerBId:'HOLLIS',scoreA:30,scoreB:10}],
    seasonHistory:[{id:'archive',endDateKey:'2026-11-15',
      tournamentMatchupResults:[
        {id:'tourney',dateKey:'2026-11-08',playerAId:'DONUT',playerBId:'HOLLIS',scoreA:60,scoreB:20},
        {id:'today',dateKey:'2026-11-16',playerAId:'HOLLIS',playerBId:'DONUT',scoreA:100,scoreB:0}
      ]}]
  };
  const api=setupBonus();
  let seen=[];
  const core={computeCanonicalRankings: candidate=>{
    seen=candidate.matchups.map(m=>m.id);
    return [{playerId:'DONUT',winPct:1,ppd:52},{playerId:'HOLLIS',winPct:0,ppd:46}];
  }};
  const context=vm.createContext({
    state,window:{TaskPointsCore:core,TaskPointsSeasonChampionGoldBonus:api},
    TaskPointsCore:core,performance:{now:()=>100},Date,Map,Number,Math,
    getGameDayKey:()=> '2026-11-16',
    getHomeScoreboardCurrentSeasonState:()=>state,
    getHomeScoreboardCurrentSeasonRows:rows=>rows.filter(m=>m.dateKey>='2026-11-01')
  });
  vm.runInContext('let homePowerRankingCache = null;\n'+fn(home,'getCanonicalRankingMap'),context);
  const result=context.getCanonicalRankingMap();
  assert.deepEqual(seen,['regular','tourney','today'], 'matchup scope includes today; canonical ranking excludes unrevealed scores');
  assert.equal(result.get('DONUT').rank,1);
  assert.equal(state.matchups.length,1,'archives used for read-only ranking only');
});
