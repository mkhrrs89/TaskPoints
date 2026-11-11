'use strict';
// M01: execute V1 production functions in disposable Node VM contexts.
// This is behavior coverage, NOT proof of V2 owner assignment or writer fencing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const KEY = 'taskpoints_v1';
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  tasks:[{id:'keep-task'}],completions:[{id:'keep-completion'}],
  matchups:[{id:'old-matchup'}],gameHistory:[{id:'old-game'}],
  goldLedger:[{id:'gold-original',amount:12}],
  seasonHistory:[{id:'past-season'}],
  unknownImportedField:{mustSurvive:true}
});
function storage(initial={},failure=null) {
  const rows=new Map(Object.entries(initial));
  const operations=[];
  return {
    rows,operations,
    getItem(k){return rows.get(String(k))??null},
    setItem(k,v){
      if(String(k)===failure)throw Error('QuotaExceededError');
      rows.set(String(k),String(v));operations.push(['set',String(k),String(v)]);
    },
    removeItem(k){rows.delete(String(k));operations.push(['remove',String(k)])}
  };
}
function source(file){
  return fs.readFileSync(path.join(root,file),'utf8');
}
function inline(file,marker){
  const code=[...source(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(m=>m[1]).find(v=>v.includes(marker));
  assert.ok(code,'missing inline page source '+file+' / '+marker);
  return code;
}
function segment(full,from,to) {
  const first=full.indexOf(from);
  const second=full.indexOf(to,first+from.length);
  assert.ok(first>=0 && second>first,'source marker moved: '+from+' -> '+to);
  return full.slice(first,second);
}
function context(fields={}) {
  const logs=[];
  const c={Date,Math,JSON,Number,String,Array,Object,Map,Set,Promise,
    console:{error(...args){logs.push(['error',args])},warn(...args){logs.push(['warn',args])},log(){}},
    ...fields};
  c.window=c;c.globalThis=c;c.logs=logs;
  vm.createContext(c);
  return c;
}
function execute(c,code,file='production'){vm.runInContext(code,c,{filename:file});return c;}
function state(s){return JSON.parse(s.getItem(KEY))}
function unchanged(s){assert.equal(state(s).unknownImportedField.mustSurvive,true);assert.equal(state(s).goldLedger[0].id,'gold-original')}

// 1. Week saveMerged executes the real inline writer with a full-source merge.
function weekHarness({fail=false,withWriter=true}={}){
  const s=storage({[KEY]:JSON.stringify(fixture())});
  const saves=[];
  const core={saveStateSnapshot(next,opts){saves.push({next:clone(next),opts:clone(opts)});
    if(fail)throw Error('V1 save refused');s.setItem(KEY,JSON.stringify(next));return {state:next};}};
  if(withWriter)core.saveAppState=()=>{};
  const c=context({TaskPointsCore:core,localStorage:s,STORAGE_KEY:KEY,
    load(){return state(s)},invalidatePageStateCache(){},
    pageStateCache:null,pageStateCacheDirty:false});
  execute(c,segment(inline('week.html','function saveMerged(partial'), 'function saveMerged(partial','function getCompletionPoints('),'week.html');
  return {s,c,saves,invoke:(partial,options)=>vm.runInContext('saveMerged('+JSON.stringify(partial)+','+JSON.stringify(options||{})+')',c)};
}
test('Week real snapshot writer merges edits without discarding Gold/imported fields',()=>{
  const h=weekHarness();
  const result=h.invoke({tasks:[{id:'new-week-task'}]},{immediateWrite:true});
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].opts.storageKey,KEY);
  assert.equal(h.saves[0].opts.immediateWrite,true);
  assert.equal(result.tasks[0].id,'new-week-task');
  assert.equal(state(h.s).tasks[0].id,'new-week-task');
  unchanged(h.s);
});
test('Week denied save preserves original V1 bytes and returns non-durable partial',()=>{
  const h=weekHarness({fail:true}),before=h.s.getItem(KEY);
  const result=h.invoke({tasks:[{id:'not-written'}]});
  assert.equal(result.tasks[0].id,'not-written');
  assert.equal(h.s.getItem(KEY),before);
  assert.ok(h.c.logs.some(x=>x[0]==='error'));
  const noWriter=weekHarness({withWriter:false});
  const raw=noWriter.s.getItem(KEY);
  noWriter.invoke({tasks:[{id:'not-written'}]});
  assert.equal(noWriter.s.getItem(KEY),raw);
});

// 2. Matchups writer uses core merge and preserves separate histories.
function matchupsHarness({fail=false,withWriter=true}={}){
  const s=storage({[KEY]:JSON.stringify(fixture())});
  const calls=[];
  const core={mergeAndSaveState(next,opts){calls.push({next:clone(next),opts:clone(opts)});
    if(fail)throw Error('V1 merge refused');
    s.setItem(KEY,JSON.stringify(next));return {state:next};}};
  if(!withWriter)delete core.mergeAndSaveState;
  const c=context({TaskPointsCore:core,STORAGE_KEY:KEY,localStorage:s,
    load(){return state(s)},invalidatePageStateCache(){},
    pageStateCache:null,pageStateCacheDirty:false});
  execute(c,segment(inline('matchups.html','function save(nextState'), 'function save(nextState', 'document.addEventListener("DOMContentLoaded", renderMatchups)'), 'matchups.html');
  return {s,c,calls,save:(partial,path='matchups-save')=>vm.runInContext('save('+JSON.stringify(partial)+','+JSON.stringify(path)+')',c)};
}
test('Matchups real merge saves new results and retains unrelated V1 data',()=>{
  const h=matchupsHarness();
  const result=h.save({matchups:[{id:'updated-matchup'}]},'matchups-manual');
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].opts.savePath,'matchups-manual');
  assert.equal(h.calls[0].opts.storageKey,KEY);
  assert.equal(result.matchups[0].id,'updated-matchup');
  assert.equal(state(h.s).gameHistory[0].id,'old-game');
  unchanged(h.s);
});
test('Matchups failed or unavailable writer never changes V1 snapshot',()=>{
  for(const opt of [{fail:true},{withWriter:false}]) {
    const h=matchupsHarness(opt),before=h.s.getItem(KEY);
    h.save({matchups:[{id:'non-durable'}]});
    assert.equal(h.s.getItem(KEY),before);
  }
});

// 3. Tournament deferred saves reject stale queued data.
function tournamentHarness({fail=false}={}){
  const s=storage({[KEY]:JSON.stringify(fixture())});
  const pending=[],calls=[];
  const core={STORAGE_KEY:KEY,saveStateSnapshot(next,opts){
    calls.push({next:clone(next),opts:clone(opts)});
    if(fail)throw Error('blocked');
    s.setItem(KEY,JSON.stringify(next));return {state:next};}};
  const c=context({localStorage:s,TaskPointsCore:core,
    requestIdleCallback(fn){pending.push(fn);return pending.length},
    setTimeout(fn){pending.push(fn);return pending.length}});
  execute(c,segment(inline('tournament.html','function queueTournamentStateSave('),
    "const STORAGE_KEY =","const TOURNAMENT_PLAY_IN_PAIRINGS"),'tournament.html');
  return {s,c,pending,calls,queue:x=>vm.runInContext('queueTournamentStateSave('+JSON.stringify(x)+')',c)};
}
test('Tournament defers one compatible save and retains unrelated fields',()=>{
  const h=tournamentHarness();
  h.queue({...fixture(),matchups:[{id:'repair'}]});
  h.queue({...fixture(),matchups:[{id:'duplicate'}]});
  assert.equal(h.pending.length,1);
  assert.equal(h.calls.length,0);
  h.pending.shift()();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].opts.savePath,'tournament-season-result-resync');
  assert.equal(state(h.s).matchups[0].id,'repair');
  unchanged(h.s);
});
test('Tournament refuses stale deferred writes or failed storage',()=>{
  const h=tournamentHarness(),before=h.s.getItem(KEY);
  h.queue({...fixture(),matchups:[{id:'stale'}]});
  h.s.setItem(KEY,JSON.stringify({...fixture(),tasks:[{id:'newer'}]}));
  h.pending.shift()();
  assert.equal(h.calls.length,0);
  assert.equal(state(h.s).tasks[0].id,'newer');
  const blocked=tournamentHarness({fail:true}),raw=blocked.s.getItem(KEY);
  blocked.queue({...fixture(),matchups:[{id:'unsaved'}]});
  blocked.pending.shift()();
  assert.equal(blocked.s.getItem(KEY),raw);
  assert.ok(blocked.c.logs.some(x=>x[0]==='warn'));
  assert.notEqual(h.s.getItem(KEY),before);
});

// 4. Audit: real automatic Season series reconciliation writer.
function auditSeriesHarness({changed=true,fail=false}={}){
  const s=storage({[KEY]:JSON.stringify(fixture())}),calls=[];
  const core={
    syncCurrentSeasonSeriesFromRecordedResults(original){
      return {changed,state:changed?{...original,currentSeason:{id:'repaired'}}:original};
    },
    saveStateSnapshot(next,opts){
      calls.push({next:clone(next),opts:clone(opts)});
      if(fail)throw Error('save denied');
      s.setItem(KEY,JSON.stringify(next));return {state:next};
    }
  };
  const code=inline('audit.html',"savePath: 'season-repair-sync-results'");
  const block=segment(code,
    'if (window.TaskPointsCore?.syncCurrentSeasonSeriesFromRecordedResults) {',
    'const snapshot = TaskPointsCore.buildDaySnapshot(dateKey, state);');
  const c=context({TaskPointsCore:core,localStorage:s});
  execute(c,'function auditSeasonSeriesWriter(state){\n'+block+'\nreturn state;\n}','audit.html');
  return {s,c,calls,invoke:()=>vm.runInContext('auditSeasonSeriesWriter('+JSON.stringify(fixture())+')',c)};
}
test('Audit Season repair writer persists changed season only, retaining all other domains',()=>{
  const h=auditSeriesHarness();
  const result=h.invoke();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].opts.savePath,'season-repair-sync-results');
  assert.equal(result.currentSeason.id,'repaired');
  assert.equal(state(h.s).currentSeason.id,'repaired');
  unchanged(h.s);
});
test('Audit Season no-op or denied repair cannot mutate storage',()=>{
  const no=auditSeriesHarness({changed:false}),raw=no.s.getItem(KEY);
  no.invoke();assert.equal(no.calls.length,0);assert.equal(no.s.getItem(KEY),raw);
  const fail=auditSeriesHarness({fail:true}),old=fail.s.getItem(KEY);
  assert.throws(()=>fail.invoke(),/save denied/);
  assert.equal(fail.s.getItem(KEY),old);
});

// 5. Audit: manual matchup resync writer.
function auditMatchupHarness({changed=true,writer=true,fail=false}={}){
  const s=storage({[KEY]:JSON.stringify(fixture())}),calls=[],alerts=[];
  const core={
    loadAppState(){return {state:state(s)}},
    syncDerivedPoints(original){return {changed:false,state:original}},
    syncYouMatchups(original){return {changed,state:changed?{...original,matchups:[{id:'rebuilt'}]}:original}},
    syncCurrentSeasonSeriesFromRecordedResults(original){return {changed:false,state:original}},
    repairSeasonSeriesResultWinnerIds(original){return {changed:false,state:original}},
    saveStateSnapshot(next,opts){calls.push({next:clone(next),opts});
      if(fail)throw Error('audit write refused');
      s.setItem(KEY,JSON.stringify(next));return {state:next};}
  };
  if(writer)core.saveAppState=()=>{};
  const c=context({TaskPointsCore:core,localStorage:s,alert(message){alerts.push(message)},runAudit(){}});
  const script=inline('audit.html','function syncMatchups()');
  execute(c,segment(script,'function syncMatchups()','function syncNotesFromAudit()'),'audit.html');
  return {s,c,calls,alerts,invoke:()=>vm.runInContext('syncMatchups()',c)};
}
test('Audit manual matchup resync writes only if changed and preserves V1 extensions',()=>{
  const h=auditMatchupHarness();h.invoke();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].opts.savePath,'season-result-resync');
  assert.equal(state(h.s).matchups[0].id,'rebuilt');
  unchanged(h.s);
  const no=auditMatchupHarness({changed:false});no.invoke();
  assert.equal(no.calls.length,0);
  assert.ok(no.alerts.some(x=>x.includes('already synced')));
});
test('Audit manual resync with no writer cannot claim durable change',()=>{
  const h=auditMatchupHarness({writer:false}),raw=h.s.getItem(KEY);
  h.invoke();
  assert.equal(h.calls.length,0);
  assert.equal(h.s.getItem(KEY),raw);
  assert.ok(h.c.logs.some(x=>x[0]==='warn'));
});

// 6. Phase3 navigation cache session projection sidecar.
function navigationHarness({fail=false}={}){
  const key='taskpoints_phase3_verified_session_cache_v1';
  const s=storage({[KEY]:JSON.stringify(fixture())},fail?key:null);
  const c=context({sessionStorage:s});
  const snippet=segment(source('phase3_navigation_cache.js'),
    'function persistSessionRecord(state, cache) {','async function rebuildNavigationCache()');
  execute(c,"const global = window;\nconst SESSION_CACHE_KEY = '"+key+"';\n"+snippet,'phase3_navigation_cache.js');
  return {s,c,key,invoke:(st,cache)=>vm.runInContext('persistSessionRecord('+JSON.stringify(st)+','+JSON.stringify(cache)+')',c)};
}
test('Phase3 navigation session writer persists exact verification receipt without modifying main snapshot',()=>{
  const h=navigationHarness(),record={sourceHash:'same',destinationHash:'same',sourceCounts:{tasks:1},destinationCounts:{tasks:1},verifiedAt:'2026-11-11'};
  assert.equal(h.invoke(fixture(),record),true);
  const stored=JSON.parse(h.s.getItem(h.key));
  assert.equal(stored.schemaVersion,1);
  assert.equal(stored.sourceHash,'same');
  assert.equal(stored.state.unknownImportedField.mustSurvive,true);
  unchanged(h.s);
});
test('Phase3 navigation session writer reports quota refusal without rewriting V1',()=>{
  const h=navigationHarness({fail:true});
  assert.equal(h.invoke(fixture(),{sourceHash:'x',destinationHash:'y'}),false);
  assert.equal(h.s.getItem(h.key),null);
  unchanged(h.s);
});

// 7. Recovery-attempt TTL janitor; keep live attempt locks.
function attemptHarness(lock) {
  const key='taskpoints_recovery_attempt_lock_v1';
  const s=storage({[KEY]:JSON.stringify(fixture()),[key]:JSON.stringify(lock)});
  const c=context({localStorage:s,TaskPointsCore:{STORAGE_KEY:KEY}});
  const src=source('home_yesterday_result_consistency.js');
  const mark='(function installTaskPointsRecoveryAttemptWriteLockGuard(global)';
  const i=src.indexOf(mark);
  assert.ok(i>=0);
  execute(c,src.slice(i),'home_yesterday_result_consistency.js');
  return {s,c,key,api:c.TaskPointsRecoveryAttemptWriteLockGuard};
}
test('Home recovery-attempt janitor clears expired attempt and preserves live V1 snapshot',()=>{
  const h=attemptHarness({active:true,token:'abandoned',createdAtMs:Date.now()-180000});
  assert.equal(h.s.getItem(h.key),null);
  assert.equal(h.api.readAttemptLock(),null);
  assert.ok(h.s.operations.some(([type,key])=>type==='remove'&&key===h.key));
  unchanged(h.s);
});
test('Home recovery-attempt guard blocks snapshot and journal writes while active',()=>{
  const h=attemptHarness({active:true,token:'current',createdAtMs:Date.now()});
  assert.notEqual(h.api.readAttemptLock(),null);
  const raw=h.s.getItem(KEY);
  assert.throws(()=>h.s.setItem(KEY,'stale'),e=>e.code==='TASKPOINTS_RECOVERY_ATTEMPT_WRITE_LOCKED');
  assert.throws(()=>h.s.removeItem('taskpoints_pending_habit_deltas_v1'),e=>e.code==='TASKPOINTS_RECOVERY_ATTEMPT_WRITE_LOCKED');
  assert.equal(h.s.getItem(KEY),raw);
});

// 8. Actual performance trace session-storage writer.
function performanceHarness({query='?perf=1',fail=null}={}) {
  const s=storage({[KEY]:JSON.stringify(fixture())},fail);
  const listeners={};
  const c=context({sessionStorage:s,location:{search:query,pathname:'/settings.html',origin:'http://localhost'},
    URLSearchParams,JSON:{parse:JSON.parse,stringify:JSON.stringify},
    addEventListener(name,fn){listeners[name]=fn},
    setTimeout(){return 1},clearTimeout(){},
    navigator:{userAgent:'Node test'},performance:{now(){return 10},timeOrigin:1}});
  execute(c,source('performance_diagnostics.js'),'performance_diagnostics.js');
  return {s,c,listeners};
}
test('Performance trace writes opt-in session flag and bounded session history, never V1',()=>{
  const h=performanceHarness();
  assert.equal(h.s.getItem('tp_perf_trace_enabled_v1'),'1');
  assert.equal(h.c.TaskPointsPerf.enabled,true);
  h.c.TaskPointsPerf.persistCurrentPage();
  const history=JSON.parse(h.s.getItem('tp_perf_trace_pages_v1'));
  assert.equal(history.length,1);
  assert.equal(history[0].path,'/settings.html');
  unchanged(h.s);
  const off=performanceHarness({query:'?perf=0'});
  assert.equal(off.s.getItem('tp_perf_trace_enabled_v1'),null);
});
test('Performance trace best-effort opt-in failure cannot claim session persistence',()=>{
  const h=performanceHarness({fail:'tp_perf_trace_enabled_v1'});
  assert.equal(h.s.getItem('tp_perf_trace_enabled_v1'),null);
  assert.equal(h.c.TaskPointsPerf,undefined);
  unchanged(h.s);
});

// 9. Season-image repair exact V1 snapshot writer and race/readback checks.
function imageRepairHarness({fail=false,stale=false,noWriter=false,mismatch=false}={}){
  const original=JSON.stringify(fixture()),s=storage({[KEY]:original});
  const calls=[];
  const core={STORAGE_KEY:KEY,writeTaskPointsStoredState(next,opts){
    calls.push({next:clone(next),opts});
    if(fail)throw Error('quota exceeded');
    const raw=JSON.stringify(next);
    if(!mismatch)s.setItem(KEY,raw);
    return raw;
  }};
  if(noWriter)delete core.writeTaskPointsStoredState;
  const c=context({TaskPointsCore:core,localStorage:s});
  const snippet=segment(source('storage_diagnostics_season_image_repair_controller.js'),
    'function persistSeasonRepairExact(nextState, expectedPreviousRaw) {',
    'async function repairMissingSeasonImages()');
  execute(c,"const STORAGE_KEY = '"+KEY+"';\n"+snippet,'storage_diagnostics_season_image_repair_controller.js');
  if(stale)s.setItem(KEY,JSON.stringify({...fixture(),tasks:[{id:'newer-task'}]}));
  return {s,c,calls,original,invoke:next=>vm.runInContext('persistSeasonRepairExact('+JSON.stringify(next)+','+JSON.stringify(original)+')',c)};
}
test('Season image repair exact writer rechecks prior bytes, writer output and untouched data',()=>{
  const h=imageRepairHarness();
  const next={...fixture(),seasonHistory:[{id:'past-season',imageId:'repaired-image'}]};
  const raw=h.invoke(next);
  assert.equal(raw,h.s.getItem(KEY));
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].opts.reason,'storage-diagnostics-season-image-reference-repair');
  assert.equal(state(h.s).seasonHistory[0].imageId,'repaired-image');
  unchanged(h.s);
});
test('Season image repair rejects stale, missing, failed and unverifiable exact writes',()=>{
  for(const mode of [{stale:true},{noWriter:true},{fail:true},{mismatch:true}]){
    const h=imageRepairHarness(mode),raw=h.s.getItem(KEY);
    assert.throws(()=>h.invoke({...fixture(),seasonHistory:[{id:'past-season',imageId:'updated-image'}]}),/changed immediately|writer is unavailable|quota exceeded|did not retain/);
    assert.equal(h.s.getItem(KEY),raw,'failed exact repair never silently replaces snapshot');
  }
});
