'use strict';
// M01 V1/V2 writer behavior rehearsals from real production source in isolated Node VMs.
// Do not treat these as certified V2 ownership, durable cross-tab fencing, or cutover.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..'),V1='taskpoints_v1',SNAPSHOT=JSON.stringify({tasks:[{id:'keep'}],goldLedger:[{amount:15}],imported:{preserve:'yes'}});
function file(p){return fs.readFileSync(path.join(ROOT,p),'utf8')}
function slice(p,start,end){const s=file(p),a=s.indexOf(start),b=s.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,'Production anchors moved: '+p+' '+start);return s.slice(a,b)}
function store(data={},opt={}){
 const entries=new Map(Object.entries({[V1]:SNAPSHOT,...data})),writes=[];
 return {entries,writes,
 get length(){return entries.size},key(i){return [...entries.keys()][i]??null},
 getItem(k){if(opt.failRead===k)throw Error('storage read denied');return entries.get(String(k))??null},
 setItem(k,v){if(opt.failSet===k)throw Error('QuotaExceededError');writes.push(['set',k,String(v)]);if(opt.ignoreSet!==k)entries.set(String(k),String(v))},
 removeItem(k){if(opt.failRemove===k)throw Error('storage delete denied');writes.push(['remove',k]);if(opt.ignoreRemove!==k)entries.delete(String(k))}
 }
}
function ctx(props={}){const c={console:{log(){},warn(){},error(){}},Date,JSON,Math,Number,String,Map,Set,Promise,...props};c.window=c;c.globalThis=c;vm.createContext(c);return c}
function evaluate(c,s,p='production'){vm.runInContext(s,c,{filename:p});return c}
function unchanged(s){assert.equal(s.getItem(V1),SNAPSHOT);assert.ok(!s.writes.some(([,key])=>key===V1))}
function imageDb({failOn=null,failTransaction=false}={}){
 const deleted=[],tx={error:new Error('image transaction error'),abort(){this.aborted=true}};
 const db={objectStoreNames:{contains(n){return n==='images'}},close(){db.closed=true},transaction(name,mode){
  assert.equal(name,'images');assert.equal(mode,'readwrite');
  if(failTransaction)throw Error('transaction denied');
  return Object.assign(tx,{objectStore(){return {delete(key){if(key===failOn)throw Error('image delete failed');deleted.push(key);return {}}}}});
 }};
 const schedule=()=>{setImmediate(()=>{if(typeof tx.oncomplete!=='function')throw Error('test database transaction never installed completion handler');tx.oncomplete();})};
 return {db,tx,deleted,schedule};
}
// 1 toolbar fallback image deletion (actual production function).
test('toolbar image deletion uses only images readwrite store and skips missing id',async()=>{
 const s=store(),h=imageDb(),calls=[];
 const c=ctx({IMAGE_STORE_NAME_FALLBACK:'images',localStorage:s,
  async openImageDbFallback(){calls.push('open');return h.db},
  async requestToPromiseFallback(req){return req}});
 evaluate(c,slice('toolbar.js','async function deleteImageBlobFallback(imageId) {','function isImageDataUrlFallback('),'toolbar.js');
 await c.deleteImageBlobFallback('photo-17');
 await c.deleteImageBlobFallback('');
 assert.deepEqual(h.deleted,['photo-17']);assert.equal(calls.length,1);unchanged(s);
});
test('toolbar image deletion propagates failure and never mutates V1',async()=>{
 const s=store(),h=imageDb({failOn:'ref'});
 const c=ctx({IMAGE_STORE_NAME_FALLBACK:'images',localStorage:s,async openImageDbFallback(){return h.db},async requestToPromiseFallback(x){return x}});
 evaluate(c,slice('toolbar.js','async function deleteImageBlobFallback(imageId) {','function isImageDataUrlFallback('));
 await assert.rejects(c.deleteImageBlobFallback('ref'),/image delete failed/);unchanged(s);
});
// 2 storage_diagnostics direct image key deletion.
test('diagnostics direct deletion deduplicates image IDs and verifies transaction completion',async()=>{
 const s=store(),h=imageDb();const c=ctx({localStorage:s,IMAGE_STORE_NAME:'images',
  openExistingImageDb:async()=>h.db,setTimeout(fn){fn()}});
 evaluate(c,slice('storage_diagnostics.js','function deleteImageKeys(keysInput) {','function buildWarnings('));
 const p=c.deleteImageKeys(['photo1','photo1','photo2','']);
 await Promise.resolve();h.schedule();
 const r=await p;assert.equal(r.deleted,2);assert.deepEqual(h.deleted,['photo1','photo2']);unchanged(s);
});
test('diagnostics direct deletion refuses missing image DB and empty input is a no-op',async()=>{
 const s=store(),c=ctx({localStorage:s,IMAGE_STORE_NAME:'images',openExistingImageDb:async()=>null,setTimeout(fn){fn()}});
 evaluate(c,slice('storage_diagnostics.js','function deleteImageKeys(keysInput) {','function buildWarnings('));
 assert.equal((await c.deleteImageKeys([])).deleted,0);
 await assert.rejects(c.deleteImageKeys(['x']),/unavailable/);unchanged(s);
});
// 3 storage diagnostics manual cleanup controller transaction.
test('manual image cleanup deletes only nominated unique image keys after transaction completion',async()=>{
 const s=store(),h=imageDb(),c=ctx({localStorage:s,IMAGE_STORE_NAME:'images',openExistingImageDb:async()=>h.db});
 evaluate(c,slice('storage_diagnostics_cleanup_controller.js','async function deleteValidatedImageKeys(keysInput) {','async function refreshReport()'));
 const p=c.deleteValidatedImageKeys(['unreferenced','unreferenced','old']);
 await Promise.resolve();h.schedule();
 assert.equal((await p).deleted,2);
 assert.deepEqual(h.deleted,['unreferenced','old']);assert.equal(h.db.closed,true);unchanged(s);
});
test('manual image cleanup refuses failed transaction and preserves V1',async()=>{
 const s=store(),h=imageDb({failTransaction:true}),c=ctx({localStorage:s,IMAGE_STORE_NAME:'images',openExistingImageDb:async()=>h.db});
 evaluate(c,slice('storage_diagnostics_cleanup_controller.js','async function deleteValidatedImageKeys(keysInput) {','async function refreshReport()'));
 await assert.rejects(c.deleteValidatedImageKeys(['reference']),/transaction denied/);
 assert.equal(h.db.closed,true);assert.deepEqual(h.deleted,[]);unchanged(s);
});
// 4 export Notes cross-location synchronization.
function notes(extra={},aux={}){
 const s=store(aux),c=ctx({localStorage:s,...extra});
 evaluate(c,"const global=window;\n"+slice('home_export_responsiveness.js','function bestNotes(state) {','function buildExportPayload()'));
 return {s,c};
}
test('export bestNotes calls cross-location sync and includes latest Notes rather than old snapshot',()=>{
 const calls=[],h=notes({syncNotesStorageLocations(reason){calls.push(reason);return 'new durable notes'}});
 assert.equal(h.c.bestNotes({notes:'older snapshot notes'}),'new durable notes');
 assert.deepEqual(calls,['responsive-export-sync']);unchanged(h.s);
});
test('export bestNotes falls back to dirty/authoritative cache when sync fails',()=>{
 const h=notes({syncNotesStorageLocations(){throw Error('sync failed')}},{
  taskpoints_notes_v1:'cache text',taskpoints_notes_dirty_v1:'1'
 });
 assert.equal(h.c.bestNotes({notes:'longer but stale snapshot notes'}),'cache text');unchanged(h.s);
});
// 5 SCWM original deferred save handoff.
function scwm(){
 const callbacks=[],calls=[],s=store();
 const c=ctx({localStorage:s,clearTimeout(){},cancelIdleCallback(){},setTimeout(fn){callbacks.push(fn);return callbacks.length},
  requestIdleCallback(fn){callbacks.push(fn);return callbacks.length}});
 const sample= "const global=window;\nlet saveTimer=null,saveIdle=null,pendingSave=null;"
  +"const originals={save:function(...args){calls.push(args)}};"
  +"const status={savesFlushed:0};const SAVE_IDLE_TIMEOUT=900;\n"
  +slice('scwm_interaction_fast_path.js','function clearSaveSchedule() {','function fastSave()');
 c.calls=calls;
 evaluate(c,sample);
 return {c,s,callbacks,calls};
}
test('SCWM deferred writer flushes original exactly once with preserved arguments',()=>{
 const h=scwm();vm.runInContext("pendingSave={thisArg:null,args:['a',{b:2}]}",h.c);
 assert.equal(h.c.flushSave(),true);
 assert.equal(h.c.flushSave(),false);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'a');
 assert.equal(h.c.status.savesFlushed,1);unchanged(h.s);
});
test('SCWM deferred writer declines to claim a flush if no pending save or owner',()=>{
 const h=scwm();
 assert.equal(h.c.flushSave(),false);
 assert.equal(h.c.status.savesFlushed,0);unchanged(h.s);
});
// 6+7 V2 dark WAL: run entire production module and its real append and delete API.
function wal({failSet=null,ignoreSet=null,failRemove=null,ignoreRemove=null,failRead=null}={}){
 const WAL='taskpoints_v2_pending_mutations_v1';
 const s=store({taskpoints_state_v2_dark_mode_v1:'1',
  taskpoints_state_v2_generation_v1:'epoch-1'},
  {failSet,ignoreSet,failRemove,ignoreRemove,failRead});
 const c=ctx({localStorage:s,
  TaskPointsStateRuntimeV2Generation:{read(){return 'epoch-1'},ensure(){return {generation:'epoch-1'}}},
  crypto:{randomUUID(){return 'test-unique-event'}},
  structuredClone(x){return JSON.parse(JSON.stringify(x))},
  TaskPointsPerf:{mark(){}}
 });
 evaluate(c,file('state_runtime_v2_wal.js'),'state_runtime_v2_wal.js');
 return {s,c,api:c.TaskPointsStateRuntimeV2Wal,WAL};
}
const DELTA={habitId:'habit-alpha',dayKey:'2026-11-11',status:'full',updatedAtISO:'2026-11-11T12:00:00Z'};
test('V2 WAL append writes a verified shared record and independently durable claim, never V1',()=>{
 const h=wal(),a=h.api.appendHabitDelta(DELTA);
 assert.equal(a.written,true);
 assert.ok(h.s.getItem(h.WAL).includes(a.mutationId));
 assert.ok(h.s.writes.some(([,key])=>key.startsWith(h.api.CLAIM_PREFIX)));
 assert.equal(h.api.getPendingRows().rows.length,1);unchanged(h.s);
});
test('V2 WAL append rejects ignored shared-WAL write and preserves evidence',()=>{
 const h=wal({ignoreSet:'taskpoints_v2_pending_mutations_v1'});
 assert.throws(()=>h.api.appendHabitDelta(DELTA),/state_runtime_v2_wal_write_failed|unverified_write/);
 assert.equal(h.s.getItem(h.WAL),null);
 assert.ok(h.s.writes.some(([,key])=>key.startsWith(h.api.CLAIM_PREFIX)));
 unchanged(h.s);
});
test('V2 WAL verified removal clears shared WAL plus matching independent recovery keys',()=>{
 const h=wal(),a=h.api.appendHabitDelta(DELTA);
 const r=h.api.removeMutation(a.mutationId,{generation:a.generation,delta:DELTA});
 assert.equal(r.removed,true);
 assert.equal(h.s.getItem(h.WAL),null);
 assert.equal(h.api.getPendingRows().rows.length,0);
 assert.equal(h.api.getStatus().removeCount,1);unchanged(h.s);
});
test('V2 WAL refused removal does not call cleanup successful',()=>{
 const h=wal({failRemove:'taskpoints_v2_pending_mutations_v1'}),a=h.api.appendHabitDelta(DELTA);
 assert.throws(()=>h.api.removeMutation(a.mutationId,{generation:a.generation,delta:DELTA}),/state_runtime_v2_wal_remove_failed/);
 assert.ok(h.s.getItem(h.WAL));assert.equal(h.api.getStatus().removeCount,0);unchanged(h.s);
});
// 8 Gold reconciliation wrapper executes production module; non-matchup saves must pass unchanged.
function gold(){
 const s=store(),calls=[];
 const core={STORAGE_KEY:V1,saveStateSnapshot(next,opts){calls.push({next,opts});return {state:next}},
  parseTaskPointsStorageJson(raw){return JSON.parse(raw)}};
 const c=ctx({TaskPointsCore:core,localStorage:s});
 const src=file('gold_theft_top50_notifications.js');
 const start=src.indexOf(';(function installTaskPointsRetroactiveGoldScoreAdjustments(global)');
 assert.ok(start>=0);evaluate(c,src.slice(start),'gold_theft_top50_notifications.js');
 return {s,core,c,calls};
}
test('Gold wrapper preserves core writer and avoids retroactive edits outside Matchups',()=>{
 const h=gold(),payload={tasks:[{id:'keep'}],goldLedger:[{amount:15}],imported:{preserve:'yes'}};
 assert.equal(h.core.saveStateSnapshot(payload,{savePath:'habit-save'}).state,payload);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].next,payload);
 assert.equal(h.core.saveStateSnapshot.__taskPointsRetroactiveGoldAdjustments,true);
 unchanged(h.s);
});
test('Gold Matchups save without a valid economy leaves ledger intact and delegates once',()=>{
 const h=gold(),payload={goldLedger:[{id:'original',amount:15}],matchups:[],imported:{preserve:'yes'}};
 h.core.saveStateSnapshot(payload,{savePath:'matchups-edit-result'});
 assert.equal(h.calls.length,1);
 assert.equal(payload.goldLedger.length,1);unchanged(h.s);
});
// 9 secondary export provider's conditional schedule-preparation snapshot write.
function inbox(scheduleChanged=true,writer=true){
 const s=store({tp_projects_v1:'[]'}),calls=[],c=ctx({
   localStorage:s,location:{pathname:'/rankings.html'},
   TaskPointsCore:{STORAGE_KEY:V1,loadAppState(){return {state:JSON.parse(s.getItem(V1))}},
    normalizeState:x=>x,...(writer?{saveValidatedSnapshot(next,opts){calls.push({next,opts})}}:{})},
   ensureUpcomingScheduleFallback(next){if(scheduleChanged){next.schedule=[{id:'prepared'}]}return scheduleChanged}
 });
 const source= "const global=window;\n"+slice('inbox_count_badge.js','function isMainPage() {','function exportButtons()')+"\ninstallSecondarySnapshotProvider();";
 evaluate(c,source,'inbox_count_badge.js');
 return {s,c,calls};
}
test('secondary export persists schedule preparation using validated core writer once',()=>{
 const h=inbox();const out=h.c.getTaskPointsExportSnapshot();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].opts.source,'responsive-export-schedule-prep');
 assert.equal(h.calls[0].opts.immediateWrite,true);
 assert.equal(out.state.schedule[0].id,'prepared');
 unchanged(h.s);
});
test('secondary export does not persist if unchanged or no validated writer exists',()=>{
 const a=inbox(false),b=inbox(true,false);
 a.c.getTaskPointsExportSnapshot();b.c.getTaskPointsExportSnapshot();
 assert.equal(a.calls.length,0);assert.equal(b.calls.length,0);unchanged(a.s);unchanged(b.s);
});
