'use strict';
// Offline, fail-closed admission for the selected READER REHEARSAL, not an app
// startup gate. No production module imports this. Archives are never fallbacks.
const vm=require('node:vm');
const {read}=require('./taskpoints-schemas.cjs');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&v.trim()===v&&v.length>0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
const unique=xs=>new Set(xs).size===xs.length;
const rows=xs=>Array.isArray(xs)&&xs.every(x=>object(x)&&id(x.id))&&unique(xs.map(x=>x.id));
const prefix='taskpoints_v2_habit_journal_event_v1:';
const names={habit:'taskpoints_pending_habit_deltas_v1',player:'taskpoints_pending_player_edits_v1',task:'taskpoints_pending_task_mutations_v1',inbox:'taskpoints_pending_inbox_state_v1',flex:'taskpoints_pending_flex_completions_v1',order:'taskpoints_pending_flex_order_v1'};
const archives=k=>/^taskpoints_backup_(latest|prev[123])$/.test(k)||[
 'taskpoints_quarantined_snapshot','taskpoints_emergency_quarantined_phase5b_journal_v1',
 'taskpoints_emergency_pre_restore_mirror_v1'].includes(k);
function preflight(entries){
 const raw=new Map(entries),blockers=[],archiveOnly=[];
 const fail=(key,reason)=>blockers.push({key,reason});
 const check=(key,fn)=>{if(!raw.has(key))return;try{if(!fn(JSON.parse(raw.get(key))))fail(key,'unsupported or ambiguous contents');}catch(_){fail(key,'malformed or unreadable contents');}};
 // Parse with the ACTUAL core, outside the browser, with no timers, IndexedDB,
 // document or writable storage. Even swallowed write attempts fail admission.
 let attemptedWrite=false;
 const storage={getItem:k=>raw.get(k)??null,key:i=>[...raw.keys()][i]??null,length:raw.size,
  setItem(){attemptedWrite=true;throw Error('read-only');},removeItem(){attemptedWrite=true;throw Error('read-only');},clear(){attemptedWrite=true;throw Error('read-only');}};
 const sandbox={localStorage:storage,console:{warn(){},error(){},log(){}},setTimeout:()=>0,clearTimeout(){}};
 sandbox.window=sandbox;vm.createContext(sandbox);
 let state;
 try{
  vm.runInContext(read('scoring_core.js'),sandbox,{timeout:3000});
  sandbox.input=raw.get('taskpoints_v1');
  state=vm.runInContext('TaskPointsCore.parseTaskPointsStorageJson(input,null)',sandbox,{timeout:3000});
  if(!object(state)||!['tasks','habits','players','completions','flexActions'].every(k=>rows(state[k])))throw Error('shape');
  // Missing snapshot must NEVER select an archive or normalize into an empty app.
 }catch(_){fail('taskpoints_v1','missing, malformed or unsupported canonical snapshot');}
 if(attemptedWrite)fail('taskpoints_v1','parser attempted a write');
 const has=(collection,key)=>state?.[collection]?.some(x=>x.id===key)===true;
 for(const [key]of raw){
  if(archives(key)){archiveOnly.push(key);continue;}
  if(Object.values(names).includes(key)||key.startsWith(prefix))continue;
  // Unknown future pending/recovery protocols require review, even if valid JSON
  // or marked inactive. Never expire, clear, repair or reinterpret their evidence.
  if(/pending|journal|recovery|restore|quarantin|write_lock|data_loss_guard/i.test(key))fail(key,'recovery protocol not admitted by this rehearsal');
 }
 if(raw.has('taskpoints_state_v2_dark_mode_v1')&&raw.get('taskpoints_state_v2_dark_mode_v1')!=='0')fail('taskpoints_state_v2_dark_mode_v1','V2 must stay disabled');
 const habitRows=[];
 const habitFields=['id','habitId','dayKey','source','status','done','failed','icy','completionFraction','completionPoints','updatedAtISO','completedAtISO','__v2JournalGeneration'];
 for(const key of [...raw.keys()].filter(k=>k===names.habit||k.startsWith(prefix))){check(key,v=>{
  if(!Array.isArray(v)&&!object(v))return false;
  const list=Array.isArray(v)?v:Object.values(v);
  if(key.startsWith(prefix)&&list.length!==1)return false;
  if(!unique(list.map(x=>x&&`${x.source}:${x.habitId}:${x.dayKey}`)))return false;
  for(const d of list){
   if(!keys(d,habitFields)||!has('habits',d.habitId)||!['habit','vice'].includes(d.source)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(d.dayKey)||!iso(d.dayKey)||new Date(d.dayKey).toISOString().slice(0,10)!==d.dayKey
    ||!['full','half','none','failed','ice'].includes(d.status)||!iso(d.updatedAtISO)||!iso(d.completedAtISO)
    ||!['done','failed','icy'].every(k=>typeof d[k]==='boolean')
    ||!Number.isFinite(d.completionFraction)||d.completionFraction<0||d.completionFraction>1||!Number.isFinite(d.completionPoints))return false;
   if(d.__v2JournalGeneration&&d.__v2JournalGeneration!==raw.get('taskpoints_state_v2_generation_v1'))return false;
   if(d.id!==undefined&&d.id!==`${d.source}:${d.habitId}:${d.dayKey}`)return false;
   habitRows.push({key,delta:d});
  }return true;
 });}
 // Same event repeated across primary/sidecar is safe only if the payload agrees.
 const events=new Map();
 for(const {key,delta:d}of habitRows){const event=`${d.source}:${d.habitId}:${d.dayKey}`;
  const normalized={...d};delete normalized.id;delete normalized.__v2JournalGeneration;
  const payload=JSON.stringify(Object.keys(normalized).sort().map(k=>[k,normalized[k]]));
  if(events.has(event)&&events.get(event)!==payload)fail(key,'competing habit evidence requires reconciliation');
  events.set(event,payload);
 }
 check(names.player,v=>keys(v,['version','edits'])&&v.version===1&&Array.isArray(v.edits)&&unique(v.edits.map(e=>e?.playerId))&&v.edits.every(e=>
  keys(e,['playerId','patch','updatedAtISO'])&&has('players',e.playerId)&&keys(e.patch,['baseline','variance','varianceTilt','momentum','risky','intimidation','poise','greed','streaky','style','name','notes','rivalId','primaryColor','secondaryColor'])
  &&Object.values(e.patch).every(x=>x===null||typeof x==='string'||typeof x==='number')&&(!own(e,'updatedAtISO')||iso(e.updatedAtISO))));
 check(names.task,v=>keys(v,['schemaVersion','tasks','completionUpserts','completionDeletes','updatedAtISO'])&&v.schemaVersion===1&&rows(v.tasks)&&rows(v.completionUpserts)
  &&v.completionUpserts.every(x=>Number.isFinite(x.points)&&iso(x.completedAtISO))&&Array.isArray(v.completionDeletes)&&v.completionDeletes.every(id)&&unique(v.completionDeletes)
  &&!v.completionUpserts.some(x=>v.completionDeletes.includes(x.id))&&(!v.updatedAtISO||iso(v.updatedAtISO)));
 check(names.flex,v=>rows(v)&&v.every(x=>x.source==='flex'&&has('flexActions',x.flexId)&&typeof x.title==='string'&&Number.isFinite(x.points)&&iso(x.completedAtISO)));
 check(names.order,v=>keys(v,['version','schemaVersion','orderedIds','updatedAtISO'])&&(v.version===1||v.schemaVersion===1)
  &&(!own(v,'version')||v.version===1)&&(!own(v,'schemaVersion')||v.schemaVersion===1)&&Array.isArray(v.orderedIds)&&v.orderedIds.length>0
  &&unique(v.orderedIds)&&v.orderedIds.every(x=>id(x)&&has('flexActions',x))&&iso(v.updatedAtISO));
 check(names.inbox,v=>keys(v,['schemaVersion','inboxMessages','inboxProcessedEventIds','inboxStartedDateKey','goldTheftTop50InboxStartedDateKey','updatedAtISO'])&&[1,2].includes(v.schemaVersion)
  &&['inboxMessages','inboxProcessedEventIds','inboxStartedDateKey','goldTheftTop50InboxStartedDateKey'].some(k=>own(v,k))
  &&(!own(v,'inboxMessages')||rows(v.inboxMessages))&&(!own(v,'inboxProcessedEventIds')||(Array.isArray(v.inboxProcessedEventIds)?v.inboxProcessedEventIds.every(id)&&unique(v.inboxProcessedEventIds):object(v.inboxProcessedEventIds)&&Object.values(v.inboxProcessedEventIds).every(x=>x===true)))
  &&['inboxStartedDateKey','goldTheftTop50InboxStartedDateKey'].every(k=>!own(v,k)||v[k]===null||typeof v[k]==='string')&&iso(v.updatedAtISO));
 return {readerRehearsalAllowed:blockers.length===0,blockers,archiveOnly,
  applicationEnabled:false,recoveryFallbackAllowed:false};
}
module.exports={preflight};
