'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const {createServer,prefix}=require('./server.cjs');
const {root}=require('./home-source.cjs');
let browser,server,url;
const executablePath=process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium';
const initial='2026-11-18',advanced='2026-11-19';
const legacyFile=path.join(root,'task_mutation_journal.js');
before(async()=>{
 server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 url='http://127.0.0.1:'+server.address().port+prefix+'index.html';
 browser=await chromium.launch({executablePath});
 console.log('Chromium '+browser.version()+' with fresh disposable storage.');
});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
const status=page=>page.locator('#status');
const waitStatus=(page,text)=>page.waitForFunction(text=>document.querySelector('#status').textContent.includes(text),text,{timeout:10000});
const button=(page,id='t1')=>page.locator('[data-task-action="bump"][data-task-id="'+id+'"]');
const date=page=>page.evaluate(()=>RealHomeTaskSlice.getState().tasks.find(t=>t.id==='t1')?.dueDateISO);
const read=page=>page.evaluate(()=>TaskPointsOwnedTaskExperiment.read());
async function open(context,create=false){
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('dialog',dialog=>dialog.dismiss());
 await page.goto(url);
 if(create){await page.click('#create');await waitStatus(page,'Loaded V2 revision 0');}
 else await waitStatus(page,'Loaded V2 revision');
 return page;
}
async function setup(t){const context=await browser.newContext();t.after(()=>context.close());return {context,page:await open(context,true)};}
async function pressBump(page){
 const task=button(page);
 if(!await task.isVisible()){
  const group=page.locator('.task-date-group').filter({has:task});
  const header=group.locator('[data-task-group-toggle]');
  if(await header.getAttribute('aria-expanded')==='false')await header.click();
 }
 await task.click();
}
async function click(page){await pressBump(page);await waitStatus(page,'Saved and verified in V2');}
function legacy(page){return page.evaluate(async()=>{
 const entries=Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]);
 const image=await TaskPointsCore.getImageBlob('synthetic-orphan');
 return {entries,bytes:[...new Uint8Array(await image.arrayBuffer())],attempts:[...OwnedTaskIsolation.attempts]};
});}
function fault(page,kind){return page.evaluate(kind=>{
 const original=IDBDatabase.prototype.transaction;
 let ownerWriteDone=false;
 IDBDatabase.prototype.transaction=function(stores,mode,...options){
  const owned=this.name==='taskpoints_state_v2'&&Array.isArray(stores)&&stores.includes('tasks');
  if(owned&&mode==='readonly'&&ownerWriteDone&&window.taskFault==='readback')throw Error('synthetic readback unavailable');
  const tx=original.call(this,stores,mode,...options);
  if(owned&&mode==='readwrite'){
   if(window.taskFault==='abort'||window.taskFault==='interrupt'){
    const store=tx.objectStore('mutations'),add=store.add.bind(store);
    store.add=(...args)=>{const request=add(...args);request.addEventListener('success',()=>{
     if(window.taskFault==='abort'){tx.abort();return;}
     // Keep uncommitted requests queued while automation closes the page.
     window.taskBeforeCommit=true;
     const hold=()=>store.get('__hold').addEventListener('success',hold,{once:true});hold();
    });return request;};
    const getStore=tx.objectStore.bind(tx);tx.objectStore=name=>name==='mutations'?store:getStore(name);
   }
   tx.addEventListener('complete',()=>{ownerWriteDone=true;window.taskCommitComplete=true;});
  }
  return tx;
 };
 const add=IDBObjectStore.prototype.add;
 IDBObjectStore.prototype.add=function(row,...rest){
  if(row?.type==='isolated-task-update'&&window.taskFault==='quota')throw new DOMException('synthetic IndexedDB quota','QuotaExceededError');
  return add.call(this,row,...rest);
 };
 window.taskFault=kind;
 },kind);}
async function intent(page,id='t1'){
 const current=await read(page),row=current.rows.find(r=>r.id===id);
 return {actionId:'action-'+Math.random(),operation:'home-plus-one-day',taskId:id,generation:current.meta.generation,expectedRevision:row.ownerRevision,expectedTask:row.value};
}
const commit=(page,input)=>page.evaluate(input=>TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({...input,mutate(task){
 if(!task.dueDateISO||task.completedAtISO||task.hidden||getTaskStatus(task)!=='active')return false;
 task.originalDueDateISO||=task.dueDateISO;bumpOneDay(task);return true;
}}),input);
const editStore=(page,store,method,key,value)=>page.evaluate(({store,method,key,value})=>new Promise((resolve,reject)=>{
 const q=indexedDB.open('taskpoints_state_v2');q.onerror=()=>reject(q.error);
 q.onsuccess=()=>{const db=q.result,tx=db.transaction(store,'readwrite');const target=tx.objectStore(store);
  if(method==='delete')target.delete(key);else target.put(value);
  tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};
}),{store,method,key,value});

test('real Home button commits directly to V2, preserves other fields and assets, and reloads the V2 date in a new page',async t=>{
 const {context,page}=await setup(t),before=await read(page),v1=await legacy(page);
 assert.equal(await button(page).textContent(),'+1d');assert.equal(await date(page),initial);
 await click(page);const after=await read(page),task=after.tasks[0];
 assert.equal(await date(page),advanced);assert.equal(task.dueDateISO,advanced);assert.equal(task.originalDueDateISO,initial);assert.equal(task.postponedDays,1);
 assert.deepEqual(task.unknownTask,before.tasks[0].unknownTask);assert.deepEqual(task.recurrence,before.tasks[0].recurrence);
 assert.deepEqual(after.tasks[1],before.tasks[1]);assert.deepEqual(after.meta.baseline,before.meta.baseline);
 assert.equal(after.journal.length,1);assert.deepEqual(after.journal[0].after,task);assert.equal(after.meta.revision,1);
 assert.deepEqual(await legacy(page),v1);assert.deepEqual(v1.attempts,[]);
 assert.equal(await page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().tasks[0].dueDateISO),initial);
 await page.close();const reopened=await open(context);assert.equal(await date(reopened),advanced);
 assert.match(await reopened.locator('.task-priority-card[data-task-id="t1"] .task-meta-line').textContent(),/\+1d/);assert.equal((await read(reopened)).journal.length,1);
});

test('closing Chromium and reopening the same disposable profile keeps the acknowledged V2 date',async t=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-owned-restart-'));let context;
 t.after(async()=>{await context?.close();fs.rmSync(profile,{recursive:true,force:true});});
 context=await chromium.launchPersistentContext(profile,{executablePath});const page=await open(context,true);await click(page);
 await context.close();context=await chromium.launchPersistentContext(profile,{executablePath});
 const reopened=await open(context);assert.equal(await date(reopened),advanced);assert.equal((await read(reopened)).meta.revision,1);
});

test('two deliveries of the same Home click while saving commit once',async t=>{
 const {page}=await setup(t);
 await page.evaluate(()=>{const b=document.querySelector('[data-task-action="bump"][data-task-id="t1"]');b.click();b.click();});
 await waitStatus(page,'Saved and verified in V2');assert.equal((await read(page)).journal.length,1);assert.equal(await date(page),advanced);
});

test('same action ID replays durably after restart and ID reuse for another intent conflicts',async t=>{
 const {page,context}=await setup(t),request=await intent(page);
 const first=await commit(page,request);assert.equal(first.replayed,false);
 await page.close();const reopened=await open(context);const duplicate=await commit(reopened,request);
 assert.equal(duplicate.replayed,true);assert.deepEqual(duplicate.receipt,first.receipt);
 const changed={...await intent(reopened),actionId:request.actionId};
 await assert.rejects(commit(reopened,changed),/action_id_conflict/);
 assert.equal((await read(reopened)).journal.length,1);
});

test('two stale Home tabs cannot both bump the same revision',async t=>{
 const {context,page}=await setup(t),peer=await open(context);
 await click(page);await pressBump(peer);await waitStatus(peer,'NOT CONFIRMED');
 assert.match(await status(peer).textContent(),/stale_edit/);assert.equal(await date(peer),initial);
 assert.equal((await read(peer)).meta.revision,1);
 await peer.click('#refresh');await waitStatus(peer,'Loaded V2 revision 1');assert.equal(await date(peer),advanced);
});

test('concurrent different Tasks preserve both edits and unrelated V2 records',async t=>{
 const {page,context}=await setup(t),peer=await open(context);
 await editStore(page,'projects','put',null,{id:'p1',value:{unknown:'untouched'}});
 const results=await Promise.all([intent(page,'t1'),intent(peer,'t2')]);
 await Promise.all([commit(page,results[0]),commit(peer,results[1])]);
 const current=await read(page);assert.equal(current.meta.revision,2);assert.deepEqual(current.tasks.map(t=>t.dueDateISO),['2026-11-19','2026-11-20']);
 const project=await page.evaluate(()=>new Promise(resolve=>{const q=indexedDB.open('taskpoints_state_v2');q.onsuccess=()=>{const db=q.result,r=db.transaction('projects').objectStore('projects').get('p1');r.onsuccess=()=>{db.close();resolve(r.result);};};}));
 assert.deepEqual(project,{id:'p1',value:{unknown:'untouched'}});
});

test('an obsolete generation cannot commit even when Task contents still match',async t=>{
 const {page}=await setup(t),request=await intent(page);
 await assert.rejects(commit(page,{...request,generation:'old-generation'}),/generation_conflict/);
 assert.equal((await read(page)).meta.revision,0);
});

for(const kind of ['quota','abort'])test(kind+' between row write and commit leaves neither row nor receipt, and same intent retries exactly once',async t=>{
 const {page}=await setup(t),v1=await legacy(page);await fault(page,kind);
 await pressBump(page);await waitStatus(page,'NOT CONFIRMED');assert.equal(await date(page),initial);
 assert.equal((await read(page)).meta.revision,0);
 const id=await page.evaluate(()=>TaskPointsOwnedTaskExperiment.pendingIntent('t1').actionId);
 await page.evaluate(()=>window.taskFault=null);await click(page);const current=await read(page);
 assert.equal(current.journal.length,1);assert.equal(current.journal[0].intent.actionId,id);assert.equal(await date(page),advanced);assert.deepEqual(await legacy(page),v1);
});

test('post-commit readback failure displays no success; retry verifies the same receipt without a second bump',async t=>{
 const {page}=await setup(t);await fault(page,'readback');await pressBump(page);await waitStatus(page,'NOT CONFIRMED');
 assert.equal(await date(page),initial);assert.equal(await page.evaluate(()=>taskCommitComplete),true);
 await page.evaluate(()=>window.taskFault=null);assert.equal((await read(page)).journal.length,1);
 await click(page);assert.equal(await date(page),advanced);assert.equal((await read(page)).journal.length,1);
});

test('closing after an aborted write reopens at the original V2 date; closing after commit without acknowledgement reopens advanced once',async t=>{
 const {page,context}=await setup(t);await fault(page,'abort');await pressBump(page);await waitStatus(page,'NOT CONFIRMED');await page.close();
 const reopened=await open(context);assert.equal(await date(reopened),initial);
 await fault(reopened,'readback');await button(reopened).click();await waitStatus(reopened,'NOT CONFIRMED');await reopened.close();
 const recovered=await open(context);assert.equal(await date(recovered),advanced);assert.equal((await read(recovered)).journal.length,1);
});

test('stale V1 snapshot and legacy journal edits remain preserved, block writes and cannot overwrite the acknowledged date',async t=>{
 const {page,context}=await setup(t);const stale=await page.evaluate(()=>localStorage.getItem('taskpoints_v1'));await click(page);
 const peer=await context.newPage();await peer.goto(new URL('/legacy-peer',url).href);
 await peer.addScriptTag({path:path.join(root,'scoring_core.js')});await peer.addScriptTag({path:legacyFile});
 // The real legacy writer can still edit V1 in a peer. V2 refuses source drift.
 await peer.evaluate(stale=>{localStorage.setItem('taskpoints_v1',stale);TaskPointsCore.journalTaskMutation({task:{id:'t1',title:'SYNTHETIC old peer edit',dueDateISO:'2026-11-16',status:'active'}});},stale);
 await pressBump(page);await waitStatus(page,'NOT CONFIRMED');assert.match(await status(page).textContent(),/legacy_source_changed/);
 const owned=await read(page);assert.equal(owned.sourceDrift,true);assert.equal(owned.tasks[0].dueDateISO,advanced);assert.equal(owned.journal.length,1);
 assert.match(await peer.evaluate(()=>localStorage.getItem('taskpoints_pending_task_mutations_v1')),/old peer edit/);
 await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/legacy_source_changed/);
});

test('missing receipt refuses reopen instead of falling back to V1 or reseeding',async t=>{
 const {page}=await setup(t);await click(page);const current=await read(page);
 await editStore(page,'mutations','delete',current.journal[0].id);await page.reload();await waitStatus(page,'REFUSED');
 assert.match(await status(page).textContent(),/journal_incomplete/);assert.equal(await button(page).count(),0);
 await page.click('#create');await waitStatus(page,'existing data preserved');assert.equal(await button(page).count(),0);
});

test('rollback refuses a stale revision and freezes fresh writes, then a fresh V1 context reads the latest date from the saved checkpoint',async t=>{
 const {page,context}=await setup(t);await click(page);const original=await legacy(page),request=await intent(page);
 await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(0)),/rollback_revision_conflict/);
 await page.click('#rollback');await waitStatus(page,'checkpoint prepared');
 const download=page.waitForEvent('download');await page.click('#rollbackFile');
 const checkpoint=JSON.parse(fs.readFileSync(await (await download).path(),'utf8'));
 assert.equal(checkpoint.revision,1);assert.equal(checkpoint.snapshot.tasks[0].dueDateISO,advanced);assert.equal(checkpoint.receipts.length,1);
 assert.deepEqual(checkpoint.originalSource,original.entries.filter(([k])=>k!=='taskpoints_isolated_task_fixture_v1'));
 assert.deepEqual(await legacy(page),original);await assert.rejects(commit(page,request),/rollback_frozen/);
 const reopened=await open(context);assert.equal((await read(reopened)).meta.mode,'rollback-frozen');assert.equal(await date(reopened),advanced);
 const detached=await browser.newContext();t.after(()=>detached.close());const fresh=await detached.newPage();await fresh.goto(new URL('/rollback-fixture',url).href);
 await fresh.addScriptTag({path:path.join(root,'scoring_core.js')});await fresh.addScriptTag({path:legacyFile});
 const effective=await fresh.evaluate(checkpoint=>{
  if(localStorage.length)throw Error('Fresh rollback context required');
  const state=checkpoint.snapshot;
  localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(state));
  return TaskPointsCore.readTaskPointsStoredState();
 },checkpoint);
 assert.equal(effective.tasks[0].dueDateISO,advanced);assert.deepEqual(effective.tasks[0].unknownTask,{retain:['all',null]});assert.equal(effective.notes,'SYNTHETIC Notes');
});

test('a synthetic legacy dark-mode toggle cannot open V2 through the old mirror',async t=>{
 const {page,context}=await setup(t);await click(page);
 const peer=await context.newPage();await peer.goto(new URL('/legacy-peer',url).href);
 await peer.evaluate(()=>localStorage.setItem('taskpoints_state_v2_dark_mode_v1','1'));
 await peer.addScriptTag({path:path.join(root,'scoring_core.js')});await peer.addScriptTag({path:path.join(root,'state_runtime_v2.js')});
 assert.deepEqual(await peer.evaluate(async()=>[TaskPointsStateRuntimeV2.isDarkEnabled(),await TaskPointsStateRuntimeV2.open()]),[false,null]);
 await peer.evaluate(()=>localStorage.removeItem('taskpoints_state_v2_dark_mode_v1'));
 // The other renderer can still see the old value until Chrome delivers the
 // cross-tab storage change. The owner must refuse until that value is gone.
 await page.waitForFunction(()=>localStorage.getItem('taskpoints_state_v2_dark_mode_v1')===null);
 assert.equal((await read(page)).tasks[0].dueDateISO,advanced);
});


test('closing the initiating page with journal and Task requests pending never acknowledges success',async t=>{
 const {page,context}=await setup(t);await fault(page,'interrupt');
 await button(page).click();await page.waitForFunction(()=>window.taskBeforeCommit===true);
 assert.match(await status(page).textContent(),/Saving directly/);assert.equal(await date(page),initial);
 await page.close();const reopened=await open(context);assert.equal(await date(reopened),initial);
 assert.equal((await read(reopened)).journal.length,0);await click(reopened);assert.equal(await date(reopened),advanced);
});

test('normal Home action uses the unchanged real V1 journal when the synthetic owner is absent',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
 await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<div id="emptyList"></div><select id="sortSelect"><option>due</option></select><div id="taskList"></div>'}));
 await page.goto(url);await page.addScriptTag({path:path.join(root,'scoring_core.js')});await page.addScriptTag({path:legacyFile});
 await page.addScriptTag({content:require('./home-source.cjs').source()});
 await page.evaluate(()=>{
  const state={tasks:[{id:'t1',title:'SYNTHETIC V1',status:'active',dueDateISO:'2026-11-18',points:5}]};
  localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(state));RealHomeTaskSlice.setState(state);RealHomeTaskSlice.render();
 });
 await button(page).click();assert.equal(await date(page),advanced);
 assert.equal(await page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().tasks[0].dueDateISO),advanced);
 assert.equal(await page.evaluate(async()=>(await indexedDB.databases()).some(d=>d.name==='taskpoints_state_v2')),false);
});


test('a silently dropped Task row fails verification and blocks reopening the inconsistent revision',async t=>{
 const {page}=await setup(t);
 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(row,...args){
   if(this.name==='tasks'&&row.ownerRevision===1)return this.get(row.id);
   return put.call(this,row,...args);
  };
 });
 await pressBump(page);await waitStatus(page,'NOT CONFIRMED');
 assert.match(await status(page).textContent(),/row_receipt_mismatch/);assert.equal(await date(page),initial);
 await page.reload();await waitStatus(page,'REFUSED');assert.equal(await button(page).count(),0);
});

test('an existing recovery hold blocks action and rollback while preserving the acknowledged V2 edit',async t=>{
 const {page,context}=await setup(t);await click(page);
 const peer=await context.newPage();await peer.goto(new URL('/legacy-peer',url).href);
 await peer.evaluate(()=>localStorage.setItem('taskpoints_emergency_recovery_hold_v1','{synthetic hold evidence'));
 await page.waitForFunction(()=>localStorage.getItem('taskpoints_emergency_recovery_hold_v1')!==null);
 await pressBump(page);await waitStatus(page,'NOT CONFIRMED');
 assert.match(await status(page).textContent(),/recovery_evidence/);
 await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/recovery_evidence/);
 assert.equal(await peer.evaluate(()=>localStorage.getItem('taskpoints_emergency_recovery_hold_v1')),'{synthetic hold evidence');
 await peer.evaluate(()=>localStorage.removeItem('taskpoints_emergency_recovery_hold_v1'));
 await page.waitForFunction(()=>localStorage.getItem('taskpoints_emergency_recovery_hold_v1')===null);
 assert.equal((await read(page)).tasks[0].dueDateISO,advanced);
});
