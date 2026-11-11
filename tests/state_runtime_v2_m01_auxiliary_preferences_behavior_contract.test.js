'use strict';
// M01: execute existing V1 preference writers in isolated Node VMs.
// These rehearsals do NOT certify V2 ownership, durability, or stale-tab fencing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const SNAPSHOT = 'taskpoints_v1';
const originalSnapshot = JSON.stringify({tasks:[{id:'keep'}],goldLedger:[{id:'gold'}],unknownImportedField:{keep:true}});

function script(file, marker) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const code = scripts.find(s => s.includes(marker));
  assert.ok(code, 'missing real inline production script: ' + file + ' / ' + marker);
  return code;
}
function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'production snippet moved: ' + start + ' -> ' + end);
  return source.slice(a, b);
}
function storage(initial = {}, failKey = null) {
  const data = new Map([[SNAPSHOT, originalSnapshot], ...Object.entries(initial)]);
  const writes = [];
  return {data,writes,
    getItem(k){return data.get(k) ?? null},
    setItem(k,v){if (k === failKey) throw Error('QuotaExceededError');data.set(k,String(v));writes.push([k,String(v)])},
    removeItem(k){data.delete(k);writes.push([k,null])}
  };
}
class FixedDate extends Date {
  constructor(...args){super(...(args.length ? args : ['2026-11-11T12:00:00']))}
  static now(){return new Date('2026-11-11T12:00:00').getTime()}
}
function scopeHarness(page, {saved, marker = null, failKey = null} = {}) {
  const rankings = page === 'rankings';
  const upper = rankings ? 'RANKINGS' : 'STANDINGS';
  const cap = rankings ? 'Rankings' : 'Standings';
  const field = rankings ? 'rankingsScope' : 'standingsScope';
  const key = 'taskpoints_' + page + '_scope_v1';
  const markKey = 'taskpoints_' + page + '_scope_season4_rollover_v1';
  const s = storage({
    ...(saved === undefined ? {} : {[key]:saved}),
    ...(marker === null ? {} : {[markKey]:marker}),
  },failKey);
  const buttons = ['season4','season3', rankings ? 'overall' : 'lifetime'].map(scope => ({
    scope, handlers:{},attrs:{},
    getAttribute(n){return n === 'data-' + page + '-scope' ? scope : null},
    setAttribute(n,v){this.attrs[n]=v},
    addEventListener(n,fn){this.handlers[n]=fn},
    classList:{toggle(){}},
    click(){this.handlers.click()}
  }));
  let renders = 0;
  const doc = {querySelectorAll(selector){
    assert.equal(selector, '[data-' + page + '-scope]');
    return buttons;
  }};
  const ctx = {localStorage:s,document:doc,Date:FixedDate,
    renderRankings(){renders++},renderTable(){renders++},String,Number,JSON,Map,Set};
  vm.createContext(ctx);
  const src = script(page + '.html', 'const ' + upper + '_SCOPE_STORAGE_KEY');
  const initial = between(src,'const ' + upper + '_SCOPE_STORAGE_KEY','function ' + field + 'AllowsDate');
  const controls = between(src,'function update' + cap + 'ScopeTabs()','function get' + cap + 'ScopeLabel()');
  const dateHelper = rankings ? '' : between(src,'function getSimpleDateKey(input)','function getCompletionDateKey(entry)');
  vm.runInContext(initial + '\n' + dateHelper + '\n' + controls,ctx,{filename:page + '.html'});
  vm.runInContext('init' + cap + 'ScopeTabs()',ctx);
  return {s,buttons,renders:()=>renders,scope:()=>vm.runInContext(field,ctx),key,markKey,original:originalSnapshot};
}
for (const page of ['rankings','standings']) {
  const historic = page === 'rankings' ? 'overall' : 'lifetime';
  test(page + ': Season 4 rollover writes marker and changes only former default season scope', () => {
    const h = scopeHarness(page,{saved:'season3'});
    assert.equal(h.scope(),'season4');
    assert.equal(h.s.getItem(h.markKey),'1');
    assert.equal(h.s.getItem(h.key),'season4');
    assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
    assert.equal(h.s.writes.filter(([k])=>k===h.markKey).length,1);
    const resumed = scopeHarness(page,{saved:h.s.getItem(h.key),marker:h.s.getItem(h.markKey)});
    assert.equal(resumed.scope(),'season4');
    assert.equal(resumed.s.writes.length,0,'no repeat rollover');
  });
  test(page + ': explicit lifetime/overall selection survives rollover and user changes are saved separately', () => {
    const h = scopeHarness(page,{saved:historic});
    assert.equal(h.scope(),historic);
    assert.equal(h.s.getItem(h.markKey),'1');
    assert.equal(h.s.getItem(h.key),historic,'do not overwrite an explicit historic preference');
    h.buttons[0].click();
    assert.equal(h.scope(),'season4');
    assert.equal(h.s.getItem(h.key),'season4');
    assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
    assert.equal(h.renders(),1);
    const reload = scopeHarness(page,{saved:h.s.getItem(h.key),marker:'1'});
    assert.equal(reload.scope(),'season4');
  });
  test(page + ': denied preference/rollover writes never alter main V1 snapshot', () => {
    const h = scopeHarness(page,{saved:historic,marker:'1',failKey:'taskpoints_' + page + '_scope_v1'});
    h.buttons[0].click();
    assert.equal(h.scope(),'season4','in-memory UI may change without durable preference');
    assert.equal(h.s.getItem(h.key),historic,'the failed write was not durable');
    assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
    assert.equal(h.renders(),1);
    const blocked = scopeHarness(page,{saved:'season3',failKey:'taskpoints_' + page + '_scope_season4_rollover_v1'});
    assert.equal(blocked.scope(),'season4','existing best-effort fallback selects current season');
    assert.equal(blocked.s.getItem(blocked.markKey),null);
    assert.equal(blocked.s.getItem(blocked.key),'season3');
  });
}
function ratingsHarness({saved='1',fail=false}={}) {
  const key = 'taskpoints_ratings_show_inactive';
  const s = storage({[key]:saved},fail?key:null);
  const toggle = {checked:false,handlers:{},addEventListener(n,fn){this.handlers[n]=fn},
    change(value){this.checked=value;return this.handlers.change()}};
  let renders=0;
  const doc={getElementById(id){return id==='showInactiveToggle'?toggle:null}};
  const ctx={localStorage:s,document:doc,renderTable(){renders++}};
  vm.createContext(ctx);
  const src=script('game_ratings.html','const RATINGS_SHOW_INACTIVE_KEY');
  const keySource=between(src,'const RATINGS_SHOW_INACTIVE_KEY','let latestState');
  const initial=between(src,'let showInactivePlayers =','let sortKey =');
  const callback=between(src,'const showInactiveToggle = $("showInactiveToggle");','const headers = document.querySelectorAll("th[data-sort]");');
  vm.runInContext(keySource + '\n' + initial + '\nconst $ = id => document.getElementById(id);\n' + callback,ctx);
  return {s,toggle,renders:()=>renders,visible:()=>vm.runInContext('showInactivePlayers',ctx),key};
}
test('Ratings inactive-player preference toggles and survives reload without modifying V1',()=>{
  const h=ratingsHarness();
  assert.equal(h.visible(),true);
  assert.equal(h.toggle.checked,true);
  h.toggle.change(false);
  assert.equal(h.s.getItem(h.key),'0');
  assert.equal(h.renders(),1);
  assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
  assert.equal(ratingsHarness({saved:h.s.getItem(h.key)}).visible(),false);
});
test('Ratings preference quota refusal does not claim a persisted setting or touch V1',()=>{
  const h=ratingsHarness({fail:true});
  assert.throws(()=>h.toggle.change(false),/QuotaExceededError/);
  assert.equal(h.s.getItem(h.key),'1');
  assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
  assert.equal(h.renders(),0,'callback aborted before re-render');
});
function skillsHarness({initial={},fail=false}={}) {
  const key='taskpoints_skills_level_config';
  const s=storage(initial,fail?key:null);
  const ctx={localStorage:s,console:{warn(){}},String,Number,Math,Array,JSON};
  vm.createContext(ctx);
  const src=script('skills.html','const SKILLS_LEVEL_CONFIG_KEY');
  const constants=between(src,"const DEFAULT_SORT_MODE = 'count-desc';",'function loadState()');
  const functions=between(src,'function normalizePositiveNumber','function getSkillLevelInfo(');
  vm.runInContext(constants + '\n' + functions,ctx,{filename:'skills.html'});
  return {s,key,run(code){return vm.runInContext(code,ctx)}};
}
test('Skills level preference normalizes and stores independently of snapshot, then reloads',()=>{
  const h=skillsHarness();
  const result=h.run("saveSkillsLevelConfig({levelCount:2,levels:[{pointsToNext:5,color:'#fff'},{pointsToNext:-3,color:'invalid'}]})");
  assert.equal(result.levelCount,2);
  assert.equal(result.levels[0].pointsToNext,5);
  assert.equal(result.levels[1].pointsToNext,15);
  assert.equal(h.s.getItem(SNAPSHOT),originalSnapshot);
  const reloaded=skillsHarness({initial:{[h.key]:h.s.getItem(h.key)}});
  const restored=reloaded.run('loadSkillsLevelConfig()');
  assert.equal(restored.levelCount,2);
  assert.equal(restored.levels[0].pointsToNext,5);
  assert.equal(restored.levels[1].pointsToNext,15);
});
test('Skills corrupt config falls back safely and quota-denied update does not persist',()=>{
  const corrupted=skillsHarness({initial:{taskpoints_skills_level_config:'{bad JSON'}});
  assert.equal(corrupted.run('loadSkillsLevelConfig()').levelCount,10);
  const blocked=skillsHarness({fail:true});
  assert.throws(()=>blocked.run("saveSkillsLevelConfig({levelCount:3})"),/QuotaExceededError/);
  assert.equal(blocked.s.getItem(blocked.key),null);
  assert.equal(blocked.s.getItem(SNAPSHOT),originalSnapshot);
});
