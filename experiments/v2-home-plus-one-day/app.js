(() => {
 'use strict';
 const api=window.TaskPointsStateRuntimeV2,$=id=>document.getElementById(id),slice=window.RealHomeTaskSlice;
 const MARKER='taskpoints_isolated_task_fixture_v1';
 let rows=new Map(),generation=null,active=false,mode=null,rollbackUrl=null;const pending=new Map(),busy=new Map();
 function status(text){$('status').textContent=text;}
 async function refresh(){
  active=false;const result=await api.readIsolatedOwnedTasks();
  if(result.sourceDrift)throw Error('Legacy source changed. Its edits are preserved; reconcile before proceeding.');
  rows=new Map(result.rows.map(r=>[r.id,r]));generation=result.meta.generation;mode=result.meta.mode;pending.clear();
  slice.setState({...result.meta.baseline,tasks:result.tasks});slice.render();
  $('details').textContent=JSON.stringify({authority:result.authority,revision:result.meta.revision,mode,tasks:result.tasks.map(t=>({id:t.id,dueDateISO:t.dueDateISO}))},null,2);
  active=true;$('refresh').disabled=false;$('rollback').disabled=false;$('create').disabled=true;
  status(`Loaded V2 revision ${result.meta.revision}${mode==='rollback-frozen'?' — writes frozen for rollback':''}.`);
  return result;
 }
 window.TaskPointsOwnedTaskExperiment=Object.freeze({
  // Once installed, failure must refuse; it must NEVER fall through to V1.
  isEnabled:()=>true,
  commitPlusOneDay(id,expectedTask,advance){
   if(busy.has(id))return busy.get(id);
   const work=(async()=>{
    if(!active||mode!=='owned')throw Error('V2 Task authority unavailable or rollback frozen');
    const row=rows.get(id);if(!row)throw Error('V2 Task missing');
    let intent=pending.get(id);
    if(!intent){intent={actionId:crypto.randomUUID(),operation:'home-plus-one-day',taskId:id,generation,expectedRevision:row.ownerRevision,expectedTask:structuredClone(expectedTask)};pending.set(id,intent);}
    $('refresh').disabled=true; $('rollback').disabled=true;
    status('Saving directly to V2…');
    try{
     const result=await api.commitIsolatedOwnedTask({...intent,mutate:advance});
     if(result.confirmedDurable!==true)throw Error('V2 result was not durable');
     rows.set(id,{...row,value:result.task,ownerRevision:result.taskRevision});pending.delete(id);
     $('details').textContent=JSON.stringify({authority:result.authority,receipt:result.receipt.id,dueDateISO:result.task.dueDateISO,revision:result.taskRevision},null,2);
     status(`Saved and verified in V2: ${result.task.dueDateISO}.`);return result;
    }catch(e){status('NOT CONFIRMED — '+e.message+'. Retry the same action, or reload V2 state to inspect the durable result.');throw e;}
   })();busy.set(id,work);work.finally(()=>{busy.delete(id);if(!busy.size){$('refresh').disabled=false;$('rollback').disabled=false;}}).catch(()=>{});return work;
  },refresh,read:()=>api.readIsolatedOwnedTasks(),pendingIntent:id=>structuredClone(pending.get(id))
 });
 async function create(){
  await OwnedTaskIsolation.createFixture(async()=>{
   const marker={id:crypto.randomUUID(),syntheticOnly:true,phase:'prepared'};
   localStorage.setItem(MARKER,JSON.stringify(marker));
   const baseline={tasks:[
    {id:'t1',title:'SYNTHETIC first V2 Task',status:'active',dueDateISO:'2026-11-18',points:5,importance:'High',tags:['Synthetic'],recurrence:{mode:'weekly'},unknownTask:{retain:['all',null]}},
    {id:'t2',title:'SYNTHETIC unrelated Task',status:'active',dueDateISO:'2026-11-19',points:3,importance:'Medium',unknown:'keep'}
   ],habits:[{id:'h1',name:'SYNTHETIC habit',doneKeys:[]}],completions:[],players:[],gameHistory:[],notes:'SYNTHETIC Notes',unknownRoot:{preserve:true},goldLedger:[{id:'g1',amount:7}]};
   localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(baseline));
   localStorage.setItem('taskpoints_pending_task_mutations_v1',JSON.stringify({schemaVersion:1,tasks:[],completionUpserts:[],completionDeletes:[],updatedAtISO:null}));
   localStorage.setItem('taskpoints_pending_habit_deltas_v1','[]');
   localStorage.setItem('taskpoints_backup_latest',JSON.stringify({state:baseline,unknown:'keep backup'}));
   localStorage.setItem('taskpoints_quarantined_snapshot','{synthetic malformed recovery evidence');
   localStorage.setItem('unknown_future_key','synthetic unknown raw value');
   await TaskPointsCore.saveImageBlob('synthetic-orphan',new Blob([new Uint8Array([0,1,254,255])],{type:'image/png'}));
   await api.initializeIsolatedTaskOwner(baseline);
   localStorage.setItem(MARKER,JSON.stringify({...marker,phase:'sealed'}));
  });
  await refresh();
 }
 $('create').onclick=()=>create().catch(e=>status('REFUSED — '+e.message));
 $('refresh').onclick=()=>refresh().catch(e=>{active=false;status('REFUSED — '+e.message);});
 $('sortSelect').onchange=()=>slice.render();
 $('rollback').onclick=async()=>{
  try {
   const current=await api.readIsolatedOwnedTasks();
   const checkpoint=await api.prepareIsolatedTaskRollback(current.meta.revision);
   await refresh();
   if(rollbackUrl)URL.revokeObjectURL(rollbackUrl);
   rollbackUrl=URL.createObjectURL(new Blob([JSON.stringify(checkpoint)],{type:'application/json'}));
   $('rollbackFile').href=rollbackUrl;
   $('rollbackFile').hidden=false;
   status('V2 writes frozen. Latest Task compatibility checkpoint prepared.');
  }catch(e){status('REFUSED — '+e.message);}
 };
 window.addEventListener('pagehide',()=>{if(rollbackUrl)URL.revokeObjectURL(rollbackUrl);});
 // This harness mounts the real Home Task component, not the rest of the app.
 // Other production features are neither migrated nor altered by this slice.
 $('taskList').addEventListener('click',e=>{const b=e.target.closest('[data-task-action]');if(b&&b.dataset.taskAction!=='bump'){e.preventDefault();e.stopImmediatePropagation();status('Only Home +1 Day is enabled in this isolated component experiment.');}},true);
 if(localStorage.getItem(MARKER))refresh().catch(e=>{active=false;status('REFUSED — '+e.message);});
 else status('Create a fresh synthetic fixture to begin. No V2 mode flag is enabled.');
})();
