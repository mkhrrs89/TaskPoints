'use strict';
// M01: real V1 production source, isolated in disposable Node VMs.
// Behavioral observations are NOT authority/fencing/cutover certificates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const clone = x => JSON.parse(JSON.stringify(x));
const key = 'taskpoints_v1';

function inline(file, marker) {
  const html = fs.readFileSync(path.join(root,file),'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]);
  const code = scripts.find(x=>x.includes(marker));
  assert.ok(code, 'missing production inline JS: '+file);
  return code;
}
function element(id='') {
  return {id,innerHTML:'',textContent:'',children:[],style:{},value:'',
    classList:{add(){},remove(){},toggle(){}},addEventListener(){},
    appendChild(c){this.children.push(c);return c},querySelector(){return null},
    querySelectorAll(){return []},getAttribute(){return null}};
}
function fixture() {
  return {tasks:[{id:'archived-task',hidden:true,title:'Keep archive',points:4,
      status:'active',recurrence:{mode:'none'}}],
    completions:[{id:'completed-old',points:2}],
    schedule:[{id:'day-saved',date:'2026-11-13'}],
    matchups:[{id:'match-saved'}],players:[{id:'p',name:'Test player'}],
    goldLedger:[{id:'gold-saved'}],seasonHistory:[{id:'season-old'}],
    importedUnrecognizedField:{survive:true}};
}
function pageHarness(file, {writer=true,reject=false}={}) {
  const rows = new Map([[key,JSON.stringify(fixture())]]);
  const saves=[],logs=[];
  const storage={getItem(k){return rows.get(k)??null},
    setItem(k,v){rows.set(k,String(v))},removeItem(k){rows.delete(k)}};
  const core={
    STORAGE_KEY:key,
    readTaskPointsStoredState(){return JSON.parse(storage.getItem(key))},
    loadAppState(){return {state:JSON.parse(storage.getItem(key))}},
    saveStateSnapshot(state,options={}){
      saves.push({state:clone(state),options:clone(options)});
      if(reject) throw Error('storage quota or protection refused');
      storage.setItem(key,JSON.stringify(state));
      return {state:clone(state)};
    },
    syncYouMatchups(state){return {state,changed:false}}
  };
  if(writer)core.saveAppState=()=>{};
  const elements=new Map();
  const doc={getElementById(id){if(!elements.has(id))elements.set(id,element(id));return elements.get(id)},
    createElement(){return element()},addEventListener(){}};
  const ctx={TaskPointsCore:core,localStorage:storage,document:doc,
    console:{error(...a){logs.push(a.join(' '))},warn(...a){logs.push(a.join(' '))},log(){},debug(){}},
    addEventListener(){},confirm(){return true},crypto:{randomUUID(){return 'completion-new'}},
    Date,Number,Array,Object,String,Math,JSON,Set,Map,Promise};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  const marker=file==='archive.html'?'function saveMerged(partial)':'function saveState(nextState)';
  vm.runInContext(inline(file,marker),ctx,{filename:file});
  return {ctx,core,saves,logs,storage,run(s){return vm.runInContext(s,ctx)},
    state(){return JSON.parse(storage.getItem(key))}};
}
test('Archive real protected save unarchives without losing completions, Gold, or imported fields',()=>{
  const h=pageHarness('archive.html');
  h.run("unarchiveTask('archived-task')");
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].options.storageKey,key);
  assert.equal(h.state().tasks[0].hidden,false);
  assert.equal(h.state().completions[0].id,'completed-old');
  assert.equal(h.state().goldLedger[0].id,'gold-saved');
  assert.equal(h.state().importedUnrecognizedField.survive,true);
  h.run("completeTask('archived-task')");
  assert.equal(h.saves.length,2);
  assert.equal(h.state().completions[0].id,'completion-new');
  assert.equal(h.state().tasks[0].completedAtISO!==undefined,true);
});
test('Archive denies missing writer and leaves V1 bytes intact, with failed writer returning partial',()=>{
  const noWriter=pageHarness('archive.html',{writer:false});
  const raw=noWriter.storage.getItem(key);
  noWriter.run("unarchiveTask('archived-task')");
  assert.equal(noWriter.saves.length,0);
  assert.equal(noWriter.storage.getItem(key),raw);
  const failed=pageHarness('archive.html',{reject:true});
  const original=failed.storage.getItem(key);
  failed.run("unarchiveTask('archived-task')");
  assert.equal(failed.saves.length,1);
  assert.equal(failed.storage.getItem(key),original);
  assert.ok(failed.logs.some(x=>x.includes('saveMerged failed')));
});

test('Schedule real protected writer preserves canonical unknown fields and other domains',()=>{
  const h=pageHarness('schedule.html');
  const result=h.run("saveState({schedule:[{date:'2026-11-15',matchups:[{id:'new'}]}]})");
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].options.storageKey,key);
  assert.equal(result.schedule[0].date,'2026-11-15');
  assert.equal(h.state().goldLedger[0].id,'gold-saved');
  assert.equal(h.state().tasks[0].id,'archived-task');
  assert.equal(h.state().importedUnrecognizedField.survive,true);
});
test('Schedule read-only startup and blocked/missing save API cannot silently persist a rewrite',()=>{
  const missing=pageHarness('schedule.html',{writer:false});
  const before=missing.storage.getItem(key);
  missing.run("saveState({schedule:[]})");
  assert.equal(missing.saves.length,0);
  assert.equal(missing.storage.getItem(key),before);
  const failed=pageHarness('schedule.html',{reject:true});
  const raw=failed.storage.getItem(key);
  failed.run("saveState({schedule:[]})");
  assert.equal(failed.saves.length,1);
  assert.equal(failed.storage.getItem(key),raw);
  assert.equal(failed.run('pageStateCacheDirty'),true);
});

function seedsHarness({fail=false,saveApi=true}={}) {
  let stored={...fixture(),currentSeason:{
    id:'season_2_august_2026',status:'preview',seedMode:'auto',
    seedRankingScope:'overall',seeds:[{id:'p',playerId:'p'}]
  }};
  const saves=[],alerts=[];
  let click;
  const mount={innerHTML:'',querySelector(){return null},querySelectorAll(){return []}};
  const doc={readyState:'complete',
    getElementById(id){return id==='seasonView'?mount:null},
    addEventListener(name,cb){if(name==='click')click=cb},
    createElement(){return element()},
    createTextNode(text){return {textContent:text}}};
  const season={
    rebuildPreviewFromStandings(state){return {...state.currentSeason,
      seedRankingScope:'overall',seeds:[{id:'p',playerId:'p',seed:1}]};},
    renderSeasonView(){return '<section>season</section>'}
  };
  const core={
    loadAppState(){return {state:clone(stored)}},
    saveStateSnapshot(next,opts){
      saves.push({next:clone(next),opts:clone(opts)});
      if(fail) throw Error('V1 storage write failed');
      stored=clone(next);return {state:clone(stored)};
    }
  };
  if(!saveApi) delete core.saveStateSnapshot;
  const ctx={TaskPointsCore:core,TaskPointsSeason:season,document:doc,
    console:{error(){}},alert(text){alerts.push(text)},
    Date,Number,JSON,Object,Array,String,Set,Map};
  ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'season_seed_sources.js'),'utf8'),ctx);
  return {saves,alerts,get state(){return clone(stored)},
    rebuild(){
      const rootEl={querySelector(selector){if(selector==='[data-season-ranking-scope]')return {value:'season2'};return null}};
      const btn={getAttribute(){return 'rebuild-standings'},closest(){return rootEl}};
      let blocked=false,stopped=false;
      click({target:{closest(){return btn}},preventDefault(){blocked=true},
        stopImmediatePropagation(){stopped=true}});
      return {blocked,stopped};
    }};
}
test('Season ranking-source writer saves scoped preview and keeps unrelated state intact',()=>{
  const h=seedsHarness();
  const event=h.rebuild();
  assert.equal(event.blocked,true);
  assert.equal(event.stopped,true);
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].opts.savePath,'season-rebuild-season2-rankings');
  assert.equal(h.state.currentSeason.seedRankingScope,'season2');
  assert.equal(h.state.goldLedger[0].id,'gold-saved');
  assert.equal(h.state.importedUnrecognizedField.survive,true);
});
test('Season source update gracefully refuses failed protected save and does not write with no save helper',()=>{
  const f=seedsHarness({fail:true});
  f.rebuild();assert.equal(f.saves.length,1);
  assert.equal(f.state.currentSeason.seedRankingScope,'overall');
  assert.equal(f.alerts.length,1);
  const n=seedsHarness({saveApi:false});
  n.rebuild();assert.equal(n.saves.length,0);
  assert.equal(n.state.currentSeason.seedRankingScope,'overall');
});

function rolloverHarness({fail=false,count=60,prior='none'}={}) {
  let stored={...fixture(),
    players:Array.from({length:count-1},(_,i)=>({id:'P'+i,name:'Player '+i,active:true})),
    currentSeason:prior==='different'?{id:'other-season',status:'active'}:null};
  const saves=[];
  const core={
    STORAGE_KEY:key,
    loadAppState(){return {state:clone(stored)}},
    normalizeState:clone,
    getSeasonSeedSourceRows(state){return {rows:[
      {id:'YOU',playerId:'YOU',name:'You'},
      ...state.players.map(p=>({id:p.id,playerId:p.id,name:p.name}))
    ],warnings:[]}},
    saveStateSnapshot(next,opts){
      saves.push({next:clone(next),opts:clone(opts)});
      if(fail)throw Error('V1 rollover rejected');
      stored=clone(next);
      return {state:clone(stored)};
    }
  };
  const builder={
    createSeasonThreePreset(){return {presetId:'season3_60_october_2026'}},
    lockConfiguredSeasonBracket(next){
      const season={...next.currentSeason,status:'locked'};
      return {ok:true,state:{...next,currentSeason:season},season};
    }
  };
  const ctx={TaskPointsCore:core,TaskPointsBracketBuilder:builder,
    console:{error(){}},Date,Number,Object,Array,Map,Set,JSON};
  ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'season3_tournament_rollover.js'),'utf8'),ctx);
  return {api:ctx.TaskPointsSeasonThreeTournamentRollover,saves,
    get state(){return clone(stored)}};
}
test('Season 3 rollover protected writer locks 60 seeds once and preserves all unrelated data',()=>{
  const h=rolloverHarness();
  const options={effectiveDateKey:'2026-10-01',nowISO:'2026-10-01T12:00:00Z',materialize:false};
  const first=h.api.persistAutomaticRollover(options);
  assert.equal(first.ok,true);assert.equal(first.changed,true);
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].opts.savePath,'season3-october-auto-rollover');
  assert.equal(h.saves[0].opts.immediateWrite,true);
  assert.equal(h.state.currentSeason.seeds.length,60);
  assert.equal(h.state.currentSeason.status,'locked');
  assert.equal(h.state.goldLedger[0].id,'gold-saved');
  assert.equal(h.state.tasks[0].id,'archived-task');
  assert.equal(h.state.importedUnrecognizedField.survive,true);
  assert.equal(h.api.persistAutomaticRollover(options).changed,false);
  assert.equal(h.saves.length,1);
});
test('Season 3 rollover refuses insufficient field, other active season and failed V1 write',()=>{
  const tooSmall=rolloverHarness({count:59});
  assert.equal(tooSmall.api.persistAutomaticRollover({effectiveDateKey:'2026-10-01'}).reason,'insufficient_qualifiers');
  assert.equal(tooSmall.saves.length,0);
  const conflict=rolloverHarness({prior:'different'});
  assert.equal(conflict.api.persistAutomaticRollover({effectiveDateKey:'2026-10-01'}).reason,'different_current_season');
  assert.equal(conflict.saves.length,0);
  const f=rolloverHarness({fail:true});
  assert.throws(()=>f.api.persistAutomaticRollover({effectiveDateKey:'2026-10-01'}),/V1 rollover rejected/);
  assert.equal(f.saves.length,1);
  assert.equal(f.state.currentSeason,null);
});
