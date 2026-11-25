'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {schemas,read,root}=require('./taskpoints-schemas.cjs');
const {seedTaskPoints}=require('./seed-taskpoints.cjs');
const {preflight}=require('./startup-preflight.cjs');
const transfer=fs.readFileSync(path.join(__dirname,'transfer.js'),'utf8');
const scripts=['scoring_core.js','task_mutation_journal.js','task_create_fast_path.js','flex_action_fast_path.js'];
let browser;const servers=[],urls=[];
before(async()=>{
 for(let i=0;i<2;i++){
  const s=http.createServer((q,r)=>{
   const name=new URL(q.url,'http://localhost').pathname.slice(1);
   const file=path.resolve(root,name);
   if(name==='fixture'){r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Synthetic TaskPoints transfer</title>');return;}
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){r.writeHead(404);r.end();return;}
   r.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');r.end(fs.readFileSync(file));
  });await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);urls.push('http://127.0.0.1:'+s.address().port);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
 console.log('TaskPoints schemas:',schemas.length,'databases;',schemas.reduce((n,d)=>n+d.stores.length,0),'stores; Chromium',browser.version());
});
after(async()=>{await browser?.close();for(const s of servers)await new Promise(r=>s.close(r));});
async function tab(ctx,i){const p=await ctx.newPage();await p.goto(urls[i]+'/fixture');await p.addScriptTag({content:transfer});return p;}
async function fixture(t){
 const ctx=await browser.newContext();t.after(()=>ctx.close());
 const source=await tab(ctx,0),target=await tab(ctx,1);
 await seedTaskPoints(source);
 const original=await source.evaluate(()=>TransferRehearsal.exportPackage());
 return {ctx,source,target,original};
}
const restore=f=>f.target.evaluate(text=>TransferRehearsal.restore(text),f.original);
async function admission(p){
 const entries=await p.evaluate(()=>Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));
 return preflight(entries);
}
async function boot(p,initial=true){
 if(initial)assert.equal(await p.evaluate(async()=>(await TransferRehearsal.inspect()).verified),true,'incomplete transfer cannot start fixture runtime');
 const result=await admission(p);
 assert.equal(result.readerRehearsalAllowed,true,'reader rehearsal blocked: '+JSON.stringify(result.blockers));
 for(const f of scripts)await p.addScriptTag({content:read(f)});
}
async function effective(p){return p.evaluate(()=>{
 const s=TaskPointsCore.loadAppState({syncDerived:false,persistSync:false,persistConfirmedHistoricalRepairs:false}).state;
 return {task:s.tasks.find(x=>x.id==='t1'),player:s.players.find(x=>x.id==='p1'),habit:s.habits.find(x=>x.id==='h1'),
  completions:s.completions.map(x=>({id:x.id,points:x.points})).sort((a,b)=>a.id.localeCompare(b.id)),
  inbox:s.inboxMessages,events:s.inboxProcessedEventIds,flex:s.flexActions.map(x=>[x.id,x.order]),unknown:s.unknownRoot,gold:s.goldLedger};
});}
function assertLatest(s){
 assert.equal(s.task.title,'Latest Task');assert.equal(s.task.date,'2026-11-18');assert.deepEqual(s.task.unknownTask,{retain:1});
 assert.equal(s.player.name,'Latest Player');assert.equal(s.player.baseline,65);
 assert.ok(s.habit.doneKeys.includes('2026-11-17'));
 assert.equal(s.completions.length,3);assert.equal(new Set(s.completions.map(x=>x.id)).size,3);
 assert.equal(s.completions.some(x=>x.id==='obsolete'),false);
 assert.equal(s.completions.find(x=>x.id==='task-new').points,3);assert.equal(s.completions.find(x=>x.id==='flex-new').points,4);
 assert.equal(s.completions.find(x=>x.id!=='task-new'&&x.id!=='flex-new').points,2.5);
 assert.equal(s.inbox.length,1);assert.equal(s.inbox[0].id,'message');assert.equal(s.events.previous,true);assert.equal(s.events.newEvent,true);
 assert.deepEqual(s.flex,[['f1',2],['f2',1]]);assert.deepEqual(s.unknown,{retain:['all',null]});assert.deepEqual(s.gold,[{id:'gold-kept',amount:7}]);
}

test('inventory pins every current storage-creation source anchor and finds no auto-increment declarations',()=>{
 const files=fs.readdirSync(root).filter(f=>/\.(js|html)$/.test(f)).sort();const rows=[];
 for(const file of files){const text=read(file);assert.doesNotMatch(text,/autoIncrement\s*:/,file);
  text.split('\n').forEach((s,i)=>{if(s.includes('createObjectStore('))rows.push({path:file,line:i+1,source:s.trim()});});}
 const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'storage-creation-sites.json')));
 assert.deepEqual(rows,expected);assert.equal(schemas.length,11);assert.equal(schemas.reduce((n,d)=>n+d.stores.length,0),34);
});

test('all eleven actual database layouts, 34 stores, real serialized snapshot and shadow migration round-trip exactly',async t=>{
 const f=await fixture(t);await restore(f);
 const expected=JSON.parse(JSON.parse(f.original).body).data;
 const actual=await f.target.evaluate(()=>TransferRehearsal.capture(true));
 assert.deepEqual(actual,expected);
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).verified,true);
 assert.equal(await f.source.evaluate(()=>TransferRehearsal.exportPackage()),f.original);
});

test('actual core and journal startup readers recover latest Task/Habit/Player/Flex/Inbox state without duplicates on repeat loads',async t=>{
 const f=await fixture(t);await restore(f);await boot(f.target);
 const first=await effective(f.target);assertLatest(first);
 assert.deepEqual(await effective(f.target),first);
 assert.equal(await f.target.evaluate(()=>window.TaskPointsStateRuntimeV2===undefined),true);
});

test('real save/compaction and subsequent restart preserve journal effects exactly once',async t=>{
 const f=await fixture(t);await restore(f);await boot(f.target);assertLatest(await effective(f.target));
 const result=await f.target.evaluate(()=>{
  const s=TaskPointsCore.loadAppState({syncDerived:false,persistSync:false}).state;
  return TaskPointsCore.saveStateSnapshot(s,{immediateWrite:true,userInitiated:true,savePath:'transfer-rehearsal'});
 });assert.notEqual(result.skipped,true);
 await f.target.reload();await f.target.addScriptTag({content:transfer});await boot(f.target,false);
 assertLatest(await effective(f.target));assertLatest(await effective(f.target));
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).original,f.original);
});

test('snapshot quota failure preserves pending journal evidence and restart still recovers latest effective state',async t=>{
 const f=await fixture(t);await restore(f);await boot(f.target);
 const keys=['taskpoints_pending_task_mutations_v1','taskpoints_pending_habit_deltas_v1','taskpoints_pending_player_edits_v1','taskpoints_pending_flex_completions_v1','taskpoints_pending_flex_order_v1','taskpoints_pending_inbox_state_v1'];
 const before=await f.target.evaluate(keys=>keys.map(k=>localStorage.getItem(k)),keys);
 const refused=await f.target.evaluate(()=>{
  const put=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='taskpoints_v1')throw new DOMException('forced quota','QuotaExceededError');return put.call(this,k,v);};
  try{const r=TaskPointsCore.saveStateSnapshot(TaskPointsCore.loadAppState({syncDerived:false,persistSync:false}).state,{immediateWrite:true,userInitiated:true});return r?.skipped===true;}
  catch(_){return true;}
 });assert.equal(refused,true);
 assert.deepEqual(await f.target.evaluate(keys=>keys.map(k=>localStorage.getItem(k)),keys),before);
 await f.target.reload();await f.target.addScriptTag({content:transfer});await boot(f.target,false);assertLatest(await effective(f.target));
});

test('actual Notes page startup chooses transferred dirty authoritative cache',async t=>{
 const f=await fixture(t);await restore(f);
 assert.equal((await admission(f.target)).readerRehearsalAllowed,true);
 await f.target.goto(urls[1]+'/notes.html');await f.target.waitForFunction(()=>document.getElementById('notesInput')?.value==='Latest dirty Notes');
 assert.equal(await f.target.locator('#notesInput').inputValue(),'Latest dirty Notes');
 assert.equal(await f.target.evaluate(()=>window.TaskPointsStateRuntimeV2===undefined),true);
});

test('interrupted realistic import stays incomplete, refuses fixture startup, and restarts without lost pending edits',async t=>{
 const f=await fixture(t);
 await f.target.evaluate(text=>{window.paused=false;window.work=TransferRehearsal.restore(text,async phase=>{
  if(phase.startsWith('database:')){window.paused=true;await new Promise(()=>{});}});},f.original);
 await f.target.waitForFunction(()=>window.paused);await f.target.close();f.target=await tab(f.ctx,1);
 await assert.rejects(boot(f.target),/incomplete transfer/);
 await restore(f);await boot(f.target);assertLatest(await effective(f.target));
});

test('every literal key in the checked-in storage inventory survives as raw data alongside dynamic keys',async t=>{
 const f=await fixture(t);
 const inventory=JSON.parse(read('docs/state-runtime-v2-storage-source-inventory.json'));
 const keys=[...new Set(inventory.keyEvidence.map(x=>x.key))];
 await f.source.evaluate(keys=>{for(const key of keys)localStorage.setItem(key,JSON.stringify({fixtureOnly:key,unknown:{retain:true}}));},keys);
 f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 const actual=await f.target.evaluate(()=>TransferRehearsal.capture(true));
 assert.deepEqual(actual,JSON.parse(JSON.parse(f.original).body).data);
 assert.equal(keys.length,76); // 146 source references deduplicate to 76 literal keys.
});

test('restored active recovery lock still blocks real Task and Habit writers',async t=>{
 const f=await fixture(t);f.target.on('dialog',d=>d.dismiss());
 await f.source.evaluate(()=>localStorage.setItem('taskpoints_recovery_write_lock_v1',JSON.stringify({active:true,token:'synthetic-lock',createdAtMs:Date.now(),committedAtMs:0})));
 f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 assert.equal((await admission(f.target)).readerRehearsalAllowed,false);
 // Deliberately bypass experiment admission ONLY to verify the existing V1
 // writer protection independently. No real application route is opened.
 for(const script of scripts)await f.target.addScriptTag({content:read(script)});
 const source=read('home_yesterday_result_consistency.js');
 await f.target.addScriptTag({content:source.slice(source.indexOf('(function installTaskPointsRecoveryJournalWriteLockGuard'))});
 const result=await f.target.evaluate(()=>{
  const before=localStorage.getItem('taskpoints_pending_task_mutations_v1');let blocked=false;
  try{TaskPointsCore.journalTaskMutation({task:{id:'t1',title:'must not save'}});}catch(_){blocked=true;}
  let habitBlocked=false;try{TaskPointsCore.writePendingHabitDelta({habitId:'h1',dayKey:'2026-11-18',source:'habit',status:'full'});}catch(_){habitBlocked=true;}
  return {blocked,habitBlocked,same:before===localStorage.getItem('taskpoints_pending_task_mutations_v1'),lock:localStorage.getItem('taskpoints_recovery_write_lock_v1')};
 });assert.equal(result.blocked,true);assert.equal(result.habitBlocked,true);assert.equal(result.same,true);assert.equal(JSON.parse(result.lock).token,'synthetic-lock');
});

test('compatibility blocker: byte-perfect malformed journal transfer is not proof of healthy application startup',async t=>{
 const f=await fixture(t);
 await f.source.evaluate(()=>localStorage.setItem('taskpoints_pending_player_edits_v1','{corrupt preserved player journal'));
 f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).verified,true);
 await f.target.addScriptTag({content:read('scoring_core.js')});
 const result=await f.target.evaluate(()=>{
  let refused=false;try{TaskPointsCore.readPendingPlayerEdits();}catch(_){refused=true;}
  const s=TaskPointsCore.loadAppState({syncDerived:false,persistSync:false}).state;
  return {refused,name:s.players.find(x=>x.id==='p1').name,raw:localStorage.getItem('taskpoints_pending_player_edits_v1')};
 });assert.equal(result.refused,true);assert.equal(result.name,'Old player');assert.equal(result.raw,'{corrupt preserved player journal');
});

// A copy can be valid while its contents are unsuitable for interpretation.
// Each case checks refusal, unchanged destination bytes, original retention and
// refusal again after a restart. These are synthetic failure injections.
const corruptCases=[
 ['player malformed','taskpoints_pending_player_edits_v1','{broken'],
 ['player empty evidence','taskpoints_pending_player_edits_v1',''],
 ['player unsupported version','taskpoints_pending_player_edits_v1',{version:9,edits:[]}],
 ['player missing target','taskpoints_pending_player_edits_v1',{version:1,edits:[{playerId:'missing',patch:{name:'lost'}}]}],
 ['player unknown patch','taskpoints_pending_player_edits_v1',{version:1,edits:[{playerId:'p1',patch:{futureEdit:'lost'}}]}],
 ['habit filtered invalid row','taskpoints_pending_habit_deltas_v1',[{habitId:'h1',source:'unknown',dayKey:'2026-11-17'}]],
 ['habit null shape','taskpoints_pending_habit_deltas_v1',null],
 ['sidecar empty evidence','taskpoints_v2_habit_journal_event_v1:retained',[]],
 ['task unsupported version','taskpoints_pending_task_mutations_v1',{schemaVersion:99,tasks:[],completionUpserts:[],completionDeletes:[]}],
 ['task missing arrays','taskpoints_pending_task_mutations_v1',{schemaVersion:1,tasks:[]}],
 ['task unknown mutation','taskpoints_pending_task_mutations_v1',{schemaVersion:1,tasks:[],completionUpserts:[],completionDeletes:[],futureDeletes:['t1']}],
 ['flex dropped row','taskpoints_pending_flex_completions_v1',[{source:'flex',id:'lost'}]],
 ['flex unsupported order','taskpoints_pending_flex_order_v1',{version:99,orderedIds:['f2','f1']}],
 ['inbox unsupported version','taskpoints_pending_inbox_state_v1',{schemaVersion:99,inboxMessages:[]}],
 ['inbox discarded field','taskpoints_pending_inbox_state_v1',{schemaVersion:2,inboxMessages:[],futureInbox:['lost']}],
 ['phase5b pending unsupported','taskpoints_phase5b_pending_changes_v1',{version:1,changes:[{id:'unreviewed'}]}],
 ['write lock malformed','taskpoints_recovery_write_lock_v1','{broken'],
 ['write lock inactive but unreviewed','taskpoints_recovery_write_lock_v1',{active:false}],
 ['recovery attempt','taskpoints_recovery_attempt_lock_v1',{active:true,token:'hold'}],
 ['emergency hold','taskpoints_emergency_recovery_hold_v1','{unreadable'],
 ['data loss guard','taskpoints_storage_data_loss_guard_v1',{blocked:true}],
 ['unreviewed restore package','taskpoints_verified_secondary_restore_package',{unknown:'keep'}],
 ['future recovery protocol','taskpoints_future_pending_recovery_v9',{unknown:'keep'}],
 ['canonical malformed','taskpoints_v1','{broken'],
 ['canonical empty object','taskpoints_v1',{}],
 ['canonical empty value','taskpoints_v1',''],
 ['V2 flag','taskpoints_state_v2_dark_mode_v1','1'],
];
for(const [name,key,value]of corruptCases)test('preflight refuses '+name+' without changing evidence, including after restart',async t=>{
 const f=await fixture(t),raw=typeof value==='string'?value:JSON.stringify(value);
 await f.source.evaluate(([key,raw])=>localStorage.setItem(key,raw),[key,raw]);
 f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).verified,true);
 const before=await f.target.evaluate(()=>TransferRehearsal.capture(true));
 for(let i=0;i<2;i++){
  const check=await admission(f.target);
  assert.equal(check.readerRehearsalAllowed,false);assert.ok(check.blockers.some(x=>x.key===key),JSON.stringify(check));
  assert.equal(check.applicationEnabled,false);assert.equal(check.recoveryFallbackAllowed,false);
  await assert.rejects(boot(f.target),/reader rehearsal blocked/);
  assert.equal(await f.target.evaluate(()=>typeof TaskPointsCore),'undefined');
  assert.deepEqual(await f.target.evaluate(()=>TransferRehearsal.capture(true)),before);
  assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).original,f.original);
  await f.target.reload();await f.target.addScriptTag({content:transfer});
 }
});

test('malformed archives remain exact evidence, never become automatic recovery candidates',async t=>{
 const f=await fixture(t);
 await f.source.evaluate(async()=>{
  localStorage.setItem('taskpoints_backup_latest','{intentionally damaged backup');
  localStorage.setItem('taskpoints_quarantined_snapshot','{preserved damaged evidence');
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('taskpoints_safety_vault_v1');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put({id:'latest',schemaVersion:999,raw:'{broken vault',unknown:'preserve'});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 });
 f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 assert.deepEqual(await f.target.evaluate(()=>TransferRehearsal.capture(true)),JSON.parse(JSON.parse(f.original).body).data);
 const report=await admission(f.target);
 assert.equal(report.readerRehearsalAllowed,true);assert.equal(report.recoveryFallbackAllowed,false);assert.equal(report.applicationEnabled,false);
 assert.ok(report.archiveOnly.includes('taskpoints_backup_latest'));
 await boot(f.target);assertLatest(await effective(f.target));
 // No fallback to archives if the canonical state is absent, even when some
 // backup records look healthy. Mutation affects only this synthetic destination.
 await f.target.evaluate(()=>localStorage.removeItem('taskpoints_v1'));
 const missing=await admission(f.target);assert.equal(missing.readerRehearsalAllowed,false);
 assert.ok(missing.blockers.some(x=>x.key==='taskpoints_v1'));
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).original,f.original);
});

test('competing habit sidecar edits require explicit reconciliation rather than timestamp-based loss',async t=>{
 const f=await fixture(t);
 await f.source.evaluate(()=>{
  const key='taskpoints_v2_habit_journal_event_v1:retained',v=JSON.parse(localStorage.getItem(key));
  v[0].completionPoints=999;localStorage.setItem(key,JSON.stringify(v));
 });f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 assert.equal((await admission(f.target)).readerRehearsalAllowed,false);
 await assert.rejects(boot(f.target),/competing habit evidence/);
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).verified,true);
});

test('stale-generation sidecar is preserved but cannot be silently abandoned at rehearsal startup',async t=>{
 const f=await fixture(t);
 await f.source.evaluate(()=>{
  const key='taskpoints_v2_habit_journal_event_v1:retained',v=JSON.parse(localStorage.getItem(key));
  v[0].__v2JournalGeneration='old-generation';localStorage.setItem(key,JSON.stringify(v));
 });f.original=await f.source.evaluate(()=>TransferRehearsal.exportPackage());await restore(f);
 await assert.rejects(boot(f.target),/reader rehearsal blocked/);
 assert.equal((await f.target.evaluate(()=>TransferRehearsal.inspect())).verified,true);
});

test('realistic import quota failure retains original, blocks startup, and resumes after restart',async t=>{
 const f=await fixture(t);
 await f.target.evaluate(()=>{
  const put=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='taskpoints_v1')throw new DOMException('synthetic import failure','QuotaExceededError');return put.call(this,k,v);};
 });
 await assert.rejects(restore(f),/synthetic import failure/);
 let inspection=await f.target.evaluate(()=>TransferRehearsal.inspect());
 assert.equal(inspection.verified,false);assert.equal(inspection.original,f.original);
 await f.target.reload();await f.target.addScriptTag({content:transfer});
 await assert.rejects(boot(f.target),/incomplete transfer/);
 await restore(f);await boot(f.target);assertLatest(await effective(f.target));
 inspection=await f.target.evaluate(()=>TransferRehearsal.inspect());assert.equal(inspection.original,f.original);
});

test('native image readback includes referenced and orphan Blob bytes after realistic restore',async t=>{
 const f=await fixture(t);await restore(f);
 const images=await f.target.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('taskpoints');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const tx=db.transaction('images','readonly'),store=tx.objectStore('images');
  const get=key=>new Promise((resolve,reject)=>{const q=store.get(key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const values=await Promise.all([get('portrait'),get('orphan')]);db.close();
  return Promise.all(values.map(async blob=>({type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]})));
 });
 assert.deepEqual(images,[{type:'image/png',bytes:[0,1,254,255]},{type:'image/jpeg',bytes:[...Buffer.from('unreferenced bytes')]}]);
});
