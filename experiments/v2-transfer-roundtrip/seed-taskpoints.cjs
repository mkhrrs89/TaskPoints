'use strict';
// Shared synthetic fixture; unchanged serializer, shadow migration and legacy Habit writer.
const {schemas,read}=require('./taskpoints-schemas.cjs');
async function seedTaskPoints(page){
 await page.addScriptTag({content:read('scoring_core.js')});
 await page.evaluate(async schemas=>{
  const state={tasks:[{id:'t1',title:'Old task',status:'active',unknownTask:{retain:1}}],
   habits:[{id:'h1',name:'Walk',pointsPerDay:5,doneKeys:[],failedKeys:[],iceKeys:[],updatedAtISO:'2026-11-16T00:00:00Z'}],
   completions:[{id:'obsolete',source:'task',taskId:'t1',title:'Delete me',points:2,completedAtISO:'2026-11-16T12:00:00Z'}],
   players:[{id:'p1',name:'Old player',imageId:'portrait',baseline:50}],flexActions:[{id:'f1',name:'Read',order:1},{id:'f2',name:'Run',order:2}],
   gameHistory:[],matchups:[],seasonHistory:[],schedule:[],reminders:[],notes:'Old snapshot note',
   inboxMessages:[],inboxProcessedEventIds:{previous:true},goldLedger:[{id:'gold-kept',amount:7}],
   unknownRoot:{retain:['all',null]},padding:'repeat '.repeat(1000)};
  // The actual serializer and shadow migration produce the persisted formats.
  localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(state));
  await TaskPointsCore.saveImageBlob('portrait',new Blob([new Uint8Array([0,1,254,255])],{type:'image/png'}));
  const shadow=await TaskPointsCore.runShadowMigration();
  if(shadow.status!=='passed_verification')throw Error('real shadow fixture failed: '+JSON.stringify(shadow));
  for(const d of schemas){
   const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(d.name,d.version);
    q.onupgradeneeded=()=>{for(const s of d.stores){const store=q.result.createObjectStore(s.name,{keyPath:s.keyPath});
     for(const i of s.indexes)store.createIndex(i.name,i.keyPath,{unique:i.unique,multiEntry:i.multiEntry});}};
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
   if(d.name!=='taskpoints_shadow_state_v1'){
    const tx=db.transaction(d.stores.map(s=>s.name),'readwrite');
    for(const s of d.stores){const store=tx.objectStore(s.name);
     if(d.name==='taskpoints'){
      store.put(new Blob([new Uint8Array([0,1,254,255])],{type:'image/png'}),'portrait');
      store.put(new Blob(['unreferenced bytes'],{type:'image/jpeg'}),'orphan');
     }else if(d.name==='taskpoints_safety_vault_v1'){
      for(const id of ['latest','prev1','prev2','prev3'])store.put({id,schemaVersion:1,createdAtISO:'2026-11-17T00:00:00Z',reason:'synthetic',
       raw:localStorage.getItem('taskpoints_v1'),rawHash:'synthetic-untrusted-hash',counts:{tasks:1,habits:1,players:1},unknown:{retain:true}});
     }else if(d.name==='taskpoints_verified_secondary_v1'){
      const fingerprint={rawHash:'synthetic-untrusted-hash',stateHash:'synthetic-untrusted-hash',counts:{tasks:1,habits:1,players:1}};
      store.put({id:'latest',status:'passed_verification',raw:localStorage.getItem('taskpoints_v1'),...fingerprint,writtenAtISO:'2026-11-17T00:00:00Z',verifiedAtISO:'2026-11-17T00:00:00Z',unknown:{retain:true}});
      store.put({id:'home_native_latest',schemaVersion:1,snapshotFormat:'home_structured_clone_v1',state,...fingerprint,rawLength:localStorage.getItem('taskpoints_v1').length,rawHead:'synthetic',rawTail:'synthetic',revision:'retained',unknown:{retain:true}});
      store.put({id:'candidate',status:'candidate_written',raw:'{interrupted candidate evidence',unknown:{retain:true}});
     }else store.put({[s.keyPath]:'latest',schemaVersion:1,raw:'backup raw bytes',state:{unknownFuture:{retain:true}},
      habitIds:['h1'],generation:'archived-generation',unknown:'preserve'});
    }
    await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
   } db.close();
  }
  const delta={habitId:'h1',dayKey:'2026-11-17',source:'habit',status:'half',done:true,failed:false,icy:false,
   completionFraction:0.5,completionPoints:2.5,updatedAtISO:'2026-11-17T12:00:00Z',completedAtISO:'2026-11-17T12:00:00Z'};
  TaskPointsCore.writePendingHabitDelta(delta);
  const entries={
   taskpoints_pending_task_mutations_v1:{schemaVersion:1,tasks:[{...state.tasks[0],title:'Latest Task',date:'2026-11-18'}],
    completionUpserts:[{id:'task-new',source:'task',taskId:'t1',title:'Latest Task',points:3,completedAtISO:'2026-11-17T12:00:00Z'}],completionDeletes:['obsolete'],updatedAtISO:'2026-11-17T12:00:00Z'},
   taskpoints_pending_player_edits_v1:{version:1,edits:[{playerId:'p1',patch:{name:'Latest Player',baseline:65}}]},
   taskpoints_pending_inbox_state_v1:{schemaVersion:2,inboxMessages:[{id:'message',title:'Latest Inbox'}],inboxProcessedEventIds:{newEvent:true},updatedAtISO:'2026-11-17T12:00:00Z'},
   taskpoints_pending_flex_completions_v1:[{id:'flex-new',flexId:'f1',taskId:null,source:'flex',title:'[Flex] Read',points:4,completedAtISO:'2026-11-17T12:00:00Z'}],
   taskpoints_pending_flex_order_v1:{schemaVersion:1,orderedIds:['f2','f1'],updatedAtISO:'2026-11-17T12:00:00Z'},
   taskpoints_today_view_v1:{tasksByDay:{'2026-11-17':[]},notesByDay:{'2026-11-17':'day note'},unknown:'keep'},
   tp_projects_v1:[{id:'project',name:'Project',unknown:'keep'}],
   taskpoints_quarantined_snapshot:{reason:'archived',payload:{unknown:'keep'}},
  };
  for(const [k,v]of Object.entries(entries))localStorage.setItem(k,JSON.stringify(v));
  for(const k of TaskPointsCore.BACKUP_SLOT_KEYS)localStorage.setItem(k,JSON.stringify({timestamp:'2026-11-17T00:00:00Z',reason:'synthetic',storageKey:'taskpoints_v1',summary:{tasks:1,habits:1,players:1},state,unknown:'keep'}));
  localStorage.setItem('taskpoints_notes_v1','Latest dirty Notes');localStorage.setItem('taskpoints_notes_dirty_v1','1');localStorage.setItem('taskpoints_notes_authoritative_v1','1');
  localStorage.setItem('taskpoints_state_v2_dark_mode_v1','0');localStorage.setItem('taskpoints_state_v2_generation_v1','retained-generation');
  localStorage.setItem('taskpoints_v2_habit_journal_event_v1:retained',JSON.stringify([{...delta,__v2JournalGeneration:'retained-generation'}]));
  localStorage.setItem('unknown_future_storage','{opaque evidence');
 },schemas);
}
module.exports={seedTaskPoints};
