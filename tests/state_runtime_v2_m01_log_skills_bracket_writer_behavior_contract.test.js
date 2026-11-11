'use strict';
// M01 behavioral witnesses of existing legacy writer entrypoints. The real
// production JS (including the HTML inline scripts) is run in disposable VMs.
// Neither V2 ownership nor an old-tab generation fence is proven by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const KEY = 'taskpoints_v1';
const clone = value => JSON.parse(JSON.stringify(value));
function pageScript(file, marker) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8');
  const scripts = Array.from(raw.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
    item => item[1]);
  const target = scripts.find(script => script.includes(marker));
  assert.ok(target && target.includes(marker), 'missing real inline script: ' + file);
  return target;
}
function initialState() {
  return {
    tasks: [{ id: 'task-one', status: 'active', title: 'Keep task' }],
    completions: [],
    manualSkills: [{ id: 'skill-original', name: 'Cooking' }],
    manualSkillOverrides: {},
    players: [{ id: 'npc', name: 'Player' }],
    matchups: [{ id: 'match-one', dateKey: '2026-11-01' }],
    goldLedger: [{ id: 'gold-one', playerId: 'YOU', amount: 3 }],
    seasonHistory: [{ id: 'archived-season' }]
  };
}
function fakeDom() {
  const nodes = new Map();
  const element = (id='') => ({
    id, value:'', textContent:'', innerHTML:'', children:[], style:{},
    classList:{add(){},remove(){},toggle(){}}, listeners:{},
    addEventListener(name,handler){(this.listeners[name] ||= []).push(handler)},
    querySelectorAll(){return []}, appendChild(child){this.children.push(child);return child},
    getAttribute(){return null}, querySelector(){return null}, focus(){}, select(){}
  });
  return {
    getElementById(id) {
      if(!nodes.has(id)) nodes.set(id, element(id));
      return nodes.get(id);
    },
    createElement(){return element()},
    createDocumentFragment(){return element()},
    addEventListener(){},
    querySelectorAll(){return []}
  };
}
function pageHarness(page,{ protectedSave=true, rejectSave=false, rejectRaw=false, prompts=[] }={}) {
  const map=new Map([[KEY,JSON.stringify(initialState())]]);
  const writes={safe:[],raw:[],alerts:[],prompts:[],confirmations:0};
  const storage={
    getItem(key){return map.get(String(key))??null},
    setItem(key,value){map.set(String(key),String(value))},
    removeItem(key){map.delete(String(key))}
  };
  const core={
    STORAGE_KEY:KEY,
    loadAppState(){return {state:JSON.parse(storage.getItem(KEY))}},
    readTaskPointsStoredState(){return JSON.parse(storage.getItem(KEY))},
    saveStateSnapshot(state,options){
      writes.safe.push({state:clone(state),options:clone(options||{})});
      if(rejectSave) throw Error('protected V1 snapshot rejected');
      storage.setItem(KEY,JSON.stringify(state));
      return {state:clone(state)};
    },
    writeTaskPointsStoredState(state,options){
      writes.raw.push({state:clone(state),options:clone(options||{})});
      if(rejectRaw) throw Error('raw V1 write rejected');
      storage.setItem(KEY,JSON.stringify(state));
      return state;
    }
  };
  if(!protectedSave) delete core.saveStateSnapshot;
  const doc=fakeDom();
  const log={time(){},timeEnd(){},warn(){},info(){},log(){},debug(){},error(){}};
  const ctx={TaskPointsCore:core,localStorage:storage,document:doc,console:log,
    performance:{now(){return 0}},requestAnimationFrame(){return 1},
    requestIdleCallback(){return 1},setTimeout(){return 1},Date,JSON,Number,
    Array,String,Object,Set,Map,Math,Boolean,
    prompt(message){
      writes.prompts.push(message); return prompts.length?prompts.shift():null;
    },
    confirm(){writes.confirmations++;return true},
    alert(message){writes.alerts.push(message)}
  };
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  const marker=page==='log.html'?'function saveMerged(partial)'
    :'function saveState(nextState, savePath';
  vm.runInContext(pageScript(page,marker),ctx,{filename:page});
  return {ctx,core,doc,map,storage,writes,
    state(){return JSON.parse(storage.getItem(KEY))},
    run(source){return vm.runInContext(source,ctx,{filename:page+':user'})}
  };
}

test('Log protected writer merges named history and writes one canonical snapshot',()=>{
  const h=pageHarness('log.html');
  const result=h.run("saveMerged({completions:[{id:'new',title:'Completion',points:5,completedAtISO:'2026-11-11T10:00:00Z'}]})");
  assert.equal(h.writes.safe.length,1);
  assert.equal(h.writes.raw.length,0);
  assert.equal(h.writes.safe[0].options.storageKey,KEY);
  assert.equal(h.state().completions[0].id,'new');
  assert.equal(h.state().tasks[0].id,'task-one');
  assert.equal(h.state().goldLedger?.length,undefined,
    'current Log projection omits Gold Ledger: this is a migration risk, not ownership proof');
  assert.equal(result.completions[0].id,'new');
  assert.equal(h.run('pageStateCacheDirty'),false);
});

test('Log fallback directly writes V1 when snapshot interface is missing and preserves deletions',()=>{
  const h=pageHarness('log.html',{protectedSave:false});
  h.run("saveMerged({completions:[{id:'before',title:'Keep',points:5,completedAtISO:'2026-11-11T10:00:00Z'}]})");
  assert.equal(h.writes.raw.length,1);
  assert.equal(h.writes.raw[0].options.storageKey,KEY);
  h.run("saveMerged({completions:[]})");
  assert.equal(h.writes.raw.length,2);
  assert.equal(h.state().completions.length,0);
  assert.equal(h.state().tasks[0].id,'task-one');
  assert.equal(h.writes.safe.length,0);
});
test('Log declined direct write never changes storage bytes or pretends cache clean',()=>{
  const h=pageHarness('log.html',{protectedSave:false,rejectRaw:true});
  const raw=h.storage.getItem(KEY);
  h.run("saveMerged({completions:[{id:'not-saved'}]})");
  assert.equal(h.writes.raw.length,1);
  assert.equal(h.storage.getItem(KEY),raw);
  assert.equal(h.run('pageStateCacheDirty'),true);
});

test('Skills protected writer saves manual skill and keeps unrelated state',()=>{
  const h=pageHarness('skills.html',{prompts:['Guitar']});
  h.run('addManualSkill()');
  assert.equal(h.writes.safe.length,1);
  assert.equal(h.writes.safe[0].options.savePath,'skills-add-manual-skill');
  assert.equal(h.writes.raw.length,0);
  assert.deepEqual(h.state().manualSkills.map(s=>s.name),['Cooking','Guitar']);
  assert.equal(h.state().goldLedger[0].id,'gold-one');
  assert.equal(h.state().matchups[0].id,'match-one');
  h.run("deleteManualSkill('skill-original')");
  assert.equal(h.writes.safe.length,2);
  assert.equal(h.writes.safe[1].options.savePath,'skills-delete-manual-skill');
  assert.deepEqual(h.state().manualSkills.map(s=>s.name),['Guitar']);
});
test('Skills raw V1 fallback adds/removes manual skills when snapshot helper missing',()=>{
  const h=pageHarness('skills.html',{protectedSave:false,prompts:['Woodworking']});
  h.run('addManualSkill()');
  assert.equal(h.writes.safe.length,0);
  assert.equal(h.writes.raw.length,1);
  assert.equal(h.writes.raw[0].options.storageKey,KEY);
  assert.deepEqual(h.state().manualSkills.map(s=>s.name),['Cooking','Woodworking']);
  h.run("deleteManualSkill('skill-original')");
  assert.equal(h.writes.raw.length,2);
  assert.deepEqual(h.state().manualSkills.map(s=>s.name),['Woodworking']);
  assert.equal(h.state().tasks[0].id,'task-one');
  assert.equal(h.state().goldLedger[0].id,'gold-one');
});
test('Skills failed raw fallback leaves saved data unchanged and duplicate names do not save',()=>{
  const h=pageHarness('skills.html',{protectedSave:false,rejectRaw:true,prompts:['Guitar']});
  const raw=h.storage.getItem(KEY);
  assert.throws(()=>h.run('addManualSkill()'),/raw V1 write rejected/);
  assert.equal(h.storage.getItem(KEY),raw);
  const d=pageHarness('skills.html',{prompts:['cooking']});
  d.run('addManualSkill()');
  assert.equal(d.writes.safe.length,0);
  assert.equal(d.writes.alerts.length,1);
});

function bracketHarness({rejectSave=false,valid=true,confirmed=true}={}) {
  let state={...initialState(),currentSeason:{
    id:'season-demo',status:'preview',name:'Demo',startDate:'2026-12-01',
    endDate:'2026-12-31',seeds:[{id:'a'},{id:'b'},{id:'c'},{id:'d'}],
    meta:{existingField:'kept'}
  }};
  const saves=[],alerts=[];
  let clickHandler;
  const config={
    presetId:'custom_single_elimination',entrantCount:4,rounds:[{
      id:'finals',displayName:'Final',bestOf:1,startDate:'2026-12-24',
      endDate:'2026-12-24',tieBreaker:'none'
    }],mainBracketSize:4,directByes:0,preliminarySeries:0
  };
  const builder={
    SEASON_THREE_PRESET_ID:'season3',SEASON_TWO_PRESET_ID:'season2',
    createGenericConfig(){return clone(config)},
    normalizeConfig(value){return {...clone(config),...clone(value||{})}},
    validateConfig(value){
      return {ok:valid,errors:valid?[]:['bad bracket'],warnings:[],config:clone(value)};
    },
    buildConfiguredTournament(seeds,value){
      return {ok:valid,errors:valid?[]:['bad bracket'],config:clone(value),
        series:{},seeds:clone(seeds)};
    },
    lockConfiguredSeasonBracket(original,settings){
      return {ok:true,state:{...clone(original),currentSeason:{
        ...clone(original.currentSeason),status:'active',
        bracketConfig:clone(settings),series:{final:{id:'final'}}
      }}};
    }
  };
  const mount={
    innerHTML:'',handlers:{},
    querySelector(selector) {
      if(selector==='[data-builder-preset]')return {value:config.presetId};
      if(selector==='[data-builder-entrant-count]')return {value:'4'};
      return null;
    },
    querySelectorAll(){return []},
    addEventListener(type,handler){this.handlers[type]=handler}
  };
  const core={
    loadAppState(){return {state:clone(state)}},
    saveStateSnapshot(next,options) {
      saves.push({state:clone(next),options:clone(options)});
      if(rejectSave)throw Error('protected V1 bracket save rejected');
      state=clone(next);return {state:clone(state)};
    }
  };
  const location={href:'not-navigated'};
  const ctx={TaskPointsCore:core,TaskPointsBracketBuilder:builder,
    document:{getElementById(id){return id==='bracketBuilderView'?mount:null}},
    location,console:{error(){}},Date,Number,String,Array,Object,JSON,
    alert(message){alerts.push(message)},confirm(){return confirmed}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'season_bracket_builder.js'),'utf8'),ctx,
    {filename:'season_bracket_builder.js'});
  return {
    saves,alerts,mount,location,
    get state(){return clone(state)},
    action(name){
      mount.handlers.click({target:{closest(){return {dataset:{builderAction:name}}}}});
    }
  };
}
test('Bracket draft save retains seed order without creating official games',()=>{
  const h=bracketHarness();
  h.action('save-draft');
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].options.savePath,'season-bracket-builder-save-draft');
  assert.equal(h.saves[0].options.immediateWrite,true);
  assert.equal(h.saves[0].options.userInitiated,true);
  assert.equal(h.state.currentSeason.status,'preview');
  assert.equal(h.state.currentSeason.meta.seedsLockedForBuilder,true);
  assert.equal(h.state.currentSeason.meta.existingField,'kept');
  assert.equal(h.state.goldLedger[0].id,'gold-one');
  assert.equal(h.location.href,'not-navigated');
});
test('Bracket creation requires explicit confirmation and protected save before navigation',()=>{
  const refused=bracketHarness({confirmed:false});
  refused.action('create-official');
  assert.equal(refused.saves.length,0);
  assert.equal(refused.location.href,'not-navigated');
  const h=bracketHarness();
  h.action('create-official');
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].options.savePath,'season-bracket-builder-create-official');
  assert.equal(h.saves[0].options.immediateWrite,true);
  assert.equal(h.state.currentSeason.status,'active');
  assert.equal(h.location.href,'season.html');
  const rejected=bracketHarness({rejectSave:true});
  assert.throws(()=>rejected.action('create-official'),/protected V1 bracket save rejected/);
  assert.equal(rejected.location.href,'not-navigated');
  assert.equal(rejected.state.currentSeason.status,'preview');
  const invalid=bracketHarness({valid:false});
  invalid.action('save-draft');
  assert.equal(invalid.saves.length,0);
});
