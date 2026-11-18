'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const {root}=require('./home-source.cjs');
const prefix='/experiments/v2-home-plus-one-day/full/';
const marker='taskpoints_isolated_task_fixture_v1';
const oldDate='2026-11-15',newDate='2026-11-16';
const quietDate='2026-11-18';
let browser,server,origin;
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

before(async()=>{
  // Same script order as the actual worker, rather than a mocked Home core.
  const list=read('_worker.js').match(/const CORE_BUNDLE_ASSET_PATHS = Object\.freeze\((\[[\s\S]*?\])\);/)[1];
  const bundle=Array.from(list.matchAll(/'\/([^']+)'/g),m=>`\n;\n/* ${m[1]} */\n${read(m[1])}`).join('');
  server=http.createServer((req,res)=>{
    const request=new URL(req.url,'http://localhost');
    const file=request.pathname.startsWith(prefix)?request.pathname.slice(prefix.length):request.pathname.slice(1);
    try {
      if(file==='seed.html') {
        res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Synthetic seed</title>');return;
      }
      if(file==='index.html'&&!request.pathname.startsWith(prefix)) {
        res.writeHead(302,{Location:prefix+'index.html'+request.search});res.end();return;
      }
      const resolved=path.resolve(root,file);
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'}[path.extname(file)];
      if(!mime||!resolved.startsWith(root+path.sep)||file.startsWith('experiments/'))throw Error('Outside experiment');
      const homeBundle=file==='scoring_core.js'&&new URL(req.headers.referer||'http://localhost').pathname===prefix+'index.html';
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});
      res.end(homeBundle?bundle:fs.readFileSync(resolved));
    }catch(_){res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
  console.log('Chromium',browser.version(),'serves the full checked-in Home document and worker-ordered bundle on loopback');
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});

async function configureContext(context){
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  const instrumentation = () => {
    if(location.hostname!=='127.0.0.1')return;
    window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__=true;
    window.legacyWrites=[];
    window.ownedPaints=[];
    new MutationObserver(()=>{
      if(!localStorage.getItem('taskpoints_isolated_task_fixture_v1'))return;
      const label=document.querySelector('.task-priority-card[data-task-id="t1"] .task-meta-line')?.textContent;
      if(label && ownedPaints.at(-1)!==label)ownedPaints.push(label);
    }).observe(document,{subtree:true,childList:true});
    Error.stackTraceLimit=25;
    const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    Storage.prototype.setItem=function(key,value){
      if(this===localStorage&&this.getItem(key)!==String(value)) {
        const entry={key,stack:new Error().stack.split('\n').slice(2,25)};
        if(key==='taskpoints_v1'&&window.TaskPointsCore?.parseTaskPointsStorageJson){
          try {
            entry.inboxBefore=TaskPointsCore.parseTaskPointsStorageJson(this.getItem(key))?.inboxMessages?.length||0;
            entry.inboxAfter=TaskPointsCore.parseTaskPointsStorageJson(String(value))?.inboxMessages?.length||0;
          }catch(_){/* Tracing must never change the write path. */}
        }
        legacyWrites.push(entry);
      }
      return set.call(this,key,value);
    };
    Storage.prototype.removeItem=function(key){
      if(this===localStorage&&this.getItem(key)!==null)legacyWrites.push({key,stack:new Error().stack.split('\n').slice(2,5)});
      return remove.call(this,key);
    };
  };
  await context.addInitScript({content: `(${instrumentation})();\n${fs.readFileSync(path.join(__dirname,'full-home-owner.js'),'utf8')}`});
}
async function fixture(t,provided){
  const context=provided||await browser.newContext({serviceWorkers:'block',timezoneId:'America/New_York'});
  if(!provided)t.after(()=>context.close());
  await configureContext(context);
  const page=await context.newPage(),errors=[];
  page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.dismiss());
  await page.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await page.goto(origin+prefix+'seed.html');
  await page.addScriptTag({path:path.join(root,'scoring_core.js')});
  await page.evaluate(({oldDate,quietDate})=>{
    const snapshot={
      tasks:[{id:'t1',title:'Synthetic V2 target',status:'active',dueDateISO:oldDate,points:5,importance:'High',unknownTask:{keep:[0,null]}},
        {id:'t2',title:'Synthetic unrelated Task',status:'active',dueDateISO:oldDate,points:3}],
      habits:[{id:'h1',name:'Synthetic Habit',category:'habit',pointsPerDay:3,daysPerCompleteWeek:3,doneKeys:[],failedKeys:[],iceKeys:[]}],
      players:[{id:'SYN',pid:'SYN',name:'Synthetic Player',imageId:'synthetic-image',baseline:50}],
      gameHistory:[{id:'synthetic-game',dateISO:'2026-10-11',dateKey:'2026-10-11',playerId:'SYN',score:9}],
      goldEconomy:{version:1,launchDateKey:'2026-11-05',launchedAtISO:'2026-11-05T12:00:00Z',balances:{SYN:7}},
      goldLedger:[{id:'synthetic-gold',type:'opening_balance',playerId:'SYN',dateKey:'2026-11-05',amount:7,balanceAfter:7}],
      inboxMessages:[{id:'synthetic-inbox',type:'record',eventDateKey:'2026-11-17',title:'Synthetic message',body:'Keep this',read:false,archived:false,createdAtISO:quietDate+'T10:00:00Z'}],
      inboxStartedDateKey:'2026-11-01',goldTheftTop50InboxStartedDateKey:'2026-11-01',inboxProcessedEventIds:{'synthetic-inbox':true},
      completions:[],reminders:[],matchups:[],schedule:[],opponentDripSchedules:[],
      flexActions:[{id:'synthetic-flex',name:'Synthetic Flex',points:2,order:1,unknown:'keep'}],
      notes:'Synthetic Notes',scoringSettings:{},habitTagColors:{},unknownRoot:{keep:true}
    };
    localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(snapshot));
    localStorage.setItem('taskpoints_notes_v1',snapshot.notes);
    localStorage.setItem('taskpoints_notes_authoritative_v1','1');
    localStorage.setItem('tp_projects_v1',JSON.stringify([{id:'synthetic-project',name:'Synthetic Project',unknown:'keep'}]));
    localStorage.setItem('synthetic_unknown_key','{opaque unrecognized data');
    localStorage.setItem('taskpoints_quarantined_snapshot','{opaque snapshot evidence');
    sessionStorage.setItem('tpBootSeenThisSession','1');
    return TaskPointsCore.saveImageBlob('synthetic-image',new Blob([new Uint8Array([0,17,254,255])],{type:'image/png'}));
  },{oldDate,quietDate});
  assert.equal(await page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().inboxMessages[0].id),'synthetic-inbox');
  await page.goto(origin+prefix+'index.html');await waitHome(page);
  assert.deepEqual(errors,[],'uncaught full Home startup errors');
  return {page,context,errors};
}
async function waitHome(page){
  await page.waitForFunction(()=>window.TaskPointsHomeLiveState?.getState()?.tasks?.length===2
    && document.querySelector('[data-task-action="bump"][data-task-id="t1"]')
    && document.querySelector('#habitsList .habitDay[data-habit="h1"]')
    && (!document.getElementById('bootSplash')||getComputedStyle(document.getElementById('bootSplash')).opacity==='0'),null,{timeout:14000});
}
const owned=page=>page.evaluate(()=>TaskPointsStateRuntimeV2.readIsolatedOwnedTasks());
const dates=page=>page.evaluate(()=>{
  const backing=TaskPointsHomeLiveState.getState();
  const owner=window.TaskPointsOwnedTaskExperiment;
  const home=owner?.isEnabled() ? owner.taskView(backing) : backing;
  return {home:home.tasks.find(t=>t.id==='t1')?.dueDateISO,
    legacy:TaskPointsCore.readTaskPointsStoredState().tasks.find(t=>t.id==='t1').dueDateISO};
});
async function partOfState(page){return page.evaluate(async()=>{
  const s=TaskPointsCore.readTaskPointsStoredState();
  const image=await TaskPointsCore.getImageBlob('synthetic-image');
  // Home adds three derived display counters during ordinary saves. Compare
  // all persisted Habit fields apart from those generated counters.
  const {__completion,__failedStreak,__streak,...habit}=s.habits.find(h=>h.id==='h1');
  return {task:s.tasks.find(t=>t.id==='t2'),habit,
    game:s.gameHistory.find(g=>g.id==='synthetic-game'||g.playerId==='SYN'),
    gold:s.goldLedger?.find(g=>g.id==='synthetic-gold'),inbox:s.inboxMessages?.find(r=>r.id==='synthetic-inbox'),
    projects:localStorage.getItem('tp_projects_v1'),notes:localStorage.getItem('taskpoints_notes_v1'),
    flex:s.flexActions?.find(action=>action.id==='synthetic-flex'),
    unknownTask:s.tasks.find(t=>t.id==='t1').unknownTask,
    unknownRaw:localStorage.getItem('synthetic_unknown_key'),
    quarantine:localStorage.getItem('taskpoints_quarantined_snapshot'),
    image:[...new Uint8Array(await image.arrayBuffer())]};
});}
async function installOwner(page){
  await page.evaluate(async marker=>{
    const api=TaskPointsStateRuntimeV2;
    if(localStorage.getItem(marker)===null){
      const fixture={id:crypto.randomUUID(),syntheticOnly:true,homeTaskId:'t1',phase:'prepared'};
      localStorage.setItem(marker,JSON.stringify(fixture));
      await api.initializeIsolatedTaskOwner(TaskPointsCore.readTaskPointsStoredState());
      localStorage.setItem(marker,JSON.stringify({...fixture,phase:'sealed'}));
    }
    await TaskPointsOwnedTaskExperiment.refresh(() => renderTasks());
  },marker);
}
async function press(page){
  const card=page.locator('.task-priority-card[data-task-id="t1"]');
  const body=card.locator('[data-task-card-body="t1"]');
  if(await body.getAttribute('aria-expanded')==='false')await body.click();
  await page.evaluate(()=>{window.ownerOutcome=null;});
  await card.locator('[data-task-action="bump"]').click();
  await page.waitForFunction(()=>window.ownerOutcome!==null&&window.ownerOutcome!==undefined);
  return page.evaluate(()=>ownerOutcome);
}
async function acknowledged(t,context){
  const f=await fixture(t,context);
  // Ordinary boot/initial IndexedDB maintenance may queue writes. Measure on
  // the same calm initial state used by an existing idle Home tab.
  await f.page.evaluate(()=>TaskPointsCore.flushPendingSaves());
  await installOwner(f.page);
  const admission=await owned(f.page);assert.equal(admission.sourceDrift,false);
  assert.deepEqual(await press(f.page),{ok:true,date:newDate});
  await assertShown(f.page,newDate);
  return f;
}

test('full Home click commits V2 with ordinary startup running, and cold reload displays the V2 date before accepting another action',async t=>{
  const {page}=await acknowledged(t);
  const before=await owned(page);
  assert.equal(before.journal.length,1);
  const cardDate=page.locator('.task-priority-card[data-task-id="t1"] .task-meta-line');
  assert.match(await cardDate.textContent(),/Nov 16/);
  await page.reload();await waitHome(page);
  await assertShown(page,newDate);
  const after=await owned(page);
  assert.deepEqual(after.journal,before.journal);
  assert.equal(after.tasks[0].dueDateISO,newDate);
  assert.match(await cardDate.textContent(),/Nov 16/);
  assert.ok((await page.evaluate(()=>ownedPaints)).every(text=>!text.includes('Nov 15')),'must never paint the legacy owned date on reopen');
  assert.equal(after.sourceDrift,false);
  assert.deepEqual(await press(page),{ok:true,date:'2026-11-17'});
  assert.equal((await owned(page)).journal.length,2);
  assert.equal((await dates(page)).legacy,oldDate);
});

async function assertShown(page,expected){
  assert.deepEqual(await dates(page),{home:expected,legacy:oldDate});
  const label=page.locator('.task-priority-card[data-task-id="t1"] .task-meta-line');
  assert.match(await label.textContent(),new RegExp('Nov '+Number(expected.slice(-2))));
}
async function assertV2(page,expected){
  const current=await owned(page);
  assert.deepEqual(current.journal,expected.journal);
  assert.deepEqual(current.tasks,expected.tasks);
  assert.equal(current.tasks.find(t=>t.id==='t1').dueDateISO,newDate);
  return current;
}

test('Home to Notes and back retains the acknowledged Task date while the other post-startup records survive navigation',async t=>{
  const {page}=await acknowledged(t),before=await owned(page),unrelated=await partOfState(page);
  for(const collection of ['task','habit','game','gold','projects','notes','flex','unknownTask'])assert.ok(unrelated[collection],collection+' witness missing');
  assert.deepEqual(unrelated.image,[0,17,254,255]);
  assert.equal(unrelated.unknownRaw,'{opaque unrecognized data');
  assert.equal(unrelated.quarantine,'{opaque snapshot evidence');
  await page.locator('a.desktop-header-notes-link').click();
  await page.waitForURL('**/notes.html');
  assert.equal(await page.locator('#notesInput').inputValue(),'Synthetic Notes');
  await page.getByRole('link',{name:'Main',exact:true}).first().click();
  await waitHome(page);
  await assertShown(page,newDate);
  assert.equal((await assertV2(page,before)).sourceDrift,false);
  assert.deepEqual(await partOfState(page),unrelated);
});

test('ordinary Home save serializes only the V1 backing date and does not invalidate V2',async t=>{
  const {page}=await acknowledged(t),before=await owned(page),unrelated=await partOfState(page);
  const write=await page.evaluate(()=>{
    legacyWrites.length=0;
    const saved=save('home-task-compatibility-witness',{immediateWrite:true,userInitiated:true});
    return {saved,writes:legacyWrites};
  });
  assert.equal(write.saved,true);
  assert.ok(write.writes.some(e=>e.key==='taskpoints_v1'));
  await assertShown(page,newDate);
  assert.equal((await assertV2(page,before)).sourceDrift,false);
  assert.deepEqual(await partOfState(page),unrelated);
  await page.reload();await waitHome(page);
  await assertShown(page,newDate);
});

test('V1 Task compaction preserves an unrelated edit and lifecycle refresh keeps the V2 date',async t=>{
  const {page}=await acknowledged(t),before=await owned(page),unrelated=await partOfState(page);
  const result=await page.evaluate(()=>{
    TaskPointsCore.journalTaskUpdates(['t2'],task=>{task.title='Synthetic unrelated journal edit';task.updatedAtISO=new Date().toISOString();return true;});
    const flushed=TaskPointsCore.flushPendingTaskMutations();
    return {flushed,remaining:TaskPointsCore.readPendingTaskMutations().record.tasks.length};
  });
  assert.deepEqual(result,{flushed:true,remaining:0});
  assert.equal((await dates(page)).legacy,oldDate);
  assert.equal((await assertV2(page,before)).sourceDrift,false);
  const actual=await partOfState(page);
  assert.equal(actual.task.title,'Synthetic unrelated journal edit');
  assert.deepEqual({...actual,task:unrelated.task},unrelated);
  assert.equal(await page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().tasks.find(t=>t.id==='t2').title),'Synthetic unrelated journal edit');
  await page.evaluate(()=>window.TaskPointsStateRevision.bump('synthetic-cross-page-revision'));
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.waitForFunction(()=>document.querySelector('[data-task-card-body="t2"]')?.textContent.includes('Synthetic unrelated journal edit'));
  await assertShown(page,newDate);
  await assertV2(page,before);
});

test('verified-secondary maintenance and native startup retain V2 display and allow the next edit',async t=>{
  const {page}=await acknowledged(t),before=await owned(page);
  const result=await page.evaluate(async()=>{
    const core=TaskPointsCore,raw=localStorage.getItem('taskpoints_v1');legacyWrites.length=0;
    core.queuePhase5CVerifiedSecondaryWrite();
    await core.flushPhase5CVerifiedSecondaryWrites();
    const snapshot=await new Promise((resolve,reject)=>{
      const q=indexedDB.open(core.PHASE5C_VERIFIED_SECONDARY_DB_NAME);
      q.onsuccess=()=>{
        const db=q.result,read=db.transaction(core.PHASE5C_VERIFIED_SECONDARY_STORE_NAME).objectStore(core.PHASE5C_VERIFIED_SECONDARY_STORE_NAME).get(core.HOME_NATIVE_SNAPSHOT_ID);
        read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>{db.close();reject(read.error);};
      };q.onerror=()=>reject(q.error);
    });
    return {rawUnchanged:localStorage.getItem('taskpoints_v1')===raw,phase:core.getPhase5CVerifiedSecondaryStatus(),
      nativeDate:snapshot?.state?.tasks?.find(t=>t.id==='t1')?.dueDateISO,writes:legacyWrites};
  });
  assert.equal(result.rawUnchanged,true);
  assert.equal(result.phase.homeNativeStatus,'passed_verification');
  assert.equal(result.nativeDate,oldDate);
  assert.ok(result.writes.some(w=>w.key==='taskpoints_storage_data_loss_guard_v1'));
  assert.equal((await assertV2(page,before)).sourceDrift,false);
  await page.reload();await waitHome(page);
  await assertShown(page,newDate);
  assert.equal(await page.evaluate(()=>window.__TP_HOME_BOOT_SOURCE),'indexeddb-native');
  await assertV2(page,before);
  assert.deepEqual(await press(page),{ok:true,date:'2026-11-17'});
});

test('competing legacy Task edit in another full Home tab survives and causes V2 admission and rollback to refuse',async t=>{
  const {page,context}=await acknowledged(t),before=await owned(page);
  const peer=await context.newPage();
  await peer.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await peer.goto(origin+prefix+'index.html');await waitHome(peer);
  await peer.evaluate(()=>TaskPointsCore.journalTaskUpdates(['t1'],task=>{task.dueDateISO='2026-11-14';return true;}));
  assert.equal((await dates(peer)).legacy,'2026-11-14');
  assert.equal((await assertV2(page,before)).sourceDrift,true);
  await installOwner(peer);
  const outcome=await press(peer);
  assert.deepEqual(outcome,{ok:false,error:'legacy_source_changed_preserved_reconciliation_required'});
  await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/legacy_source_changed/);
  await assertV2(page,before);
  assert.equal((await dates(peer)).legacy,'2026-11-14');
  assert.equal(await peer.evaluate(()=>TaskPointsCore.flushPendingTaskMutations()),true);
  assert.equal(await peer.evaluate(()=>TaskPointsCore.readPendingTaskMutations().record.tasks.length),0);
  assert.equal((await assertV2(page,before)).sourceDrift,true,'the compacted competing canonical Task also conflicts');
});

test('full Home IndexedDB quota failure has no success and reload keeps the original V2 date',async t=>{
  const {page}=await fixture(t);
  await installOwner(page);
  await page.evaluate(()=>{
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(record,...args){
      if(this.name==='mutations'&&record?.type==='isolated-task-update')throw new DOMException('synthetic owned quota','QuotaExceededError');
      return add.call(this,record,...args);
    };
  });
  const outcome=await press(page);
  assert.deepEqual(outcome,{ok:false,error:'synthetic owned quota'});
  assert.deepEqual(await dates(page),{home:oldDate,legacy:oldDate});
  assert.equal((await owned(page)).journal.length,0);
  await page.reload();await waitHome(page);
  assert.equal((await owned(page)).tasks[0].dueDateISO,oldDate);
});

test('rollback from the acknowledged full Home commit freezes V2 and a fresh full Home can read the detached Task checkpoint',async t=>{
  const {page}=await acknowledged(t),before=await owned(page);
  await page.evaluate(()=>{
    TaskPointsCore.journalTaskUpdates(['t2'],task=>{task.title='Synthetic latest second Task';return true;});
    if(!TaskPointsCore.flushPendingTaskMutations())throw Error('Expected unrelated compaction');
  });
  const checkpoint=await page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1));
  const current=await assertV2(page,before);
  assert.equal(current.meta.mode,'rollback-frozen');
  assert.equal(checkpoint.v2Frozen,true);
  assert.equal(checkpoint.snapshot.tasks.find(t=>t.id==='t1').dueDateISO,newDate);
  assert.equal((await dates(page)).legacy,oldDate);
  const fresh=await fixture(t);
  await fresh.page.evaluate(snapshot=>localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(snapshot)),checkpoint.snapshot);
  await fresh.page.reload();await waitHome(fresh.page);
  assert.deepEqual(await dates(fresh.page),{home:newDate,legacy:newDate});
  assert.equal(await fresh.page.locator('[data-task-card-body="t2"] .task-title').textContent(),'Synthetic latest second Task');
  assert.deepEqual(checkpoint.snapshot.tasks.find(t=>t.id==='t1').unknownTask,{keep:[0,null]});
  assert.equal(new Map(checkpoint.currentLegacySource).get('synthetic_unknown_key'),'{opaque unrecognized data');
  assert.equal(await fresh.page.evaluate(async()=>!(await indexedDB.databases()).some(db=>db.name===TaskPointsStateRuntimeV2.DB_NAME)),true);
  assert.equal((await dates(page)).legacy,oldDate);
});


test('after Chromium process restart full Home renders the acknowledged V2 date',async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-full-home-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await acknowledged(t,context),before=await owned(page);
  await context.close();context=await launch();await configureContext(context);
  const reopened=await context.newPage();
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  await assertShown(reopened,newDate);
  await assertV2(reopened,before);
});


test('existing Home startup loses the seeded Inbox message before V2 ownership starts',async t=>{
  const {page}=await fixture(t);
  const evidence=await page.evaluate(()=>({
    marker:localStorage.getItem('taskpoints_isolated_task_fixture_v1'),
    messages:TaskPointsCore.readTaskPointsStoredState().inboxMessages||[],
    writes:legacyWrites.filter(e=>e.key==='taskpoints_v1'&&e.inboxBefore>e.inboxAfter)
  }));
  assert.equal(evidence.marker,null);
  assert.equal(evidence.messages.some(m=>m.id==='synthetic-inbox'),false);
  assert.ok(evidence.writes.length>0);
  console.log('EXISTING STARTUP BLOCKER Inbox loss stack:',evidence.writes[0].stack.filter(frame=>!frame.includes(' at Storage.')).slice(0,9).join(' | ').replaceAll(origin,'local'));
});


test('malformed V1 Task journal remains byte-for-byte intact, blocks V2 edits and leaves the verified date visible',async t=>{
  const {page}=await acknowledged(t),before=await owned(page);
  const malformed='{damaged synthetic Task journal';
  await page.evaluate(value=>localStorage.setItem('taskpoints_pending_task_mutations_v1',value),malformed);
  const rejected=await press(page);
  assert.deepEqual(rejected,{ok:false,error:'legacy_source_changed_preserved_reconciliation_required'});
  assert.match(await page.locator('#taskList [role="status"]').textContent(),/paused/);
  assert.equal(await page.evaluate(()=>localStorage.getItem('taskpoints_pending_task_mutations_v1')),malformed);
  await assertShown(page,newDate);await assertV2(page,before);
});

test('a lifecycle refresh sees V2 edits from another Home tab even without a V1 revision change',async t=>{
  const {page,context}=await acknowledged(t);
  const peer=await context.newPage();
  await peer.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await peer.goto(origin+prefix+'index.html');await waitHome(peer);await assertShown(peer,newDate);
  const v1Revision=await page.evaluate(()=>localStorage.getItem('taskpoints_state_revision_v1'));
  assert.deepEqual(await press(peer),{ok:true,date:'2026-11-17'});
  assert.equal(await page.evaluate(()=>localStorage.getItem('taskpoints_state_revision_v1')),v1Revision);
  // A tab that has not refreshed cannot overwrite the newer V2 edit.
  const stale=await press(page);
  assert.deepEqual(stale,{ok:false,error:'owned_task_stale_edit'});
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await assertShown(page,'2026-11-17');
  assert.equal((await owned(page)).journal.length,2);
});

for(const phase of ['before commit','after commit'])test(`full Home interrupted ${phase} reopens with exactly the committed V2 state`,async t=>{
  const {page,context}=await acknowledged(t);
  await page.evaluate(phase=>{
    const transaction=IDBDatabase.prototype.transaction;
    let committed=false;
    IDBDatabase.prototype.transaction=function(stores,mode,...options){
      const owned=this.name==='taskpoints_state_v2'&&Array.isArray(stores)&&stores.includes('tasks');
      if(owned&&mode==='readonly'&&committed&&phase==='after commit')throw Error('synthetic readback unavailable');
      const tx=transaction.call(this,stores,mode,...options);
      if(owned&&mode==='readwrite'){
        tx.addEventListener('complete',()=>{committed=true;window.ownedInterruptionReached=true;});
        if(phase==='before commit'){
          const store=tx.objectStore('mutations'),add=store.add.bind(store),getStore=tx.objectStore.bind(tx);
          store.add=(...args)=>{
            const request=add(...args);
            request.addEventListener('success',()=>{
              window.ownedInterruptionReached=true;
              const hold=()=>store.get('synthetic-hold').addEventListener('success',hold,{once:true});hold();
            });
            return request;
          };
          tx.objectStore=name=>name==='mutations'?store:getStore(name);
        }
      }
      return tx;
    };
  },phase);
  await page.evaluate(()=>{window.ownerOutcome=null;document.querySelector('[data-task-action="bump"][data-task-id="t1"]').click();});
  await page.waitForFunction(()=>window.ownedInterruptionReached===true);
  assert.notEqual(await page.evaluate(()=>window.ownerOutcome?.ok),true);
  await page.close();
  const reopened=await context.newPage();
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  await assertShown(reopened,phase==='after commit'?'2026-11-17':newDate);
  assert.equal((await owned(reopened)).journal.length,phase==='after commit'?2:1);
});


test('rollback refuses unreadable Inbox journal evidence and preserves both stores',async t=>{
  const {page}=await acknowledged(t),before=await owned(page);
  const raw='{unreadable synthetic Inbox evidence';
  await page.evaluate(value=>localStorage.setItem('taskpoints_pending_inbox_state_v1',value),raw);
  await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/rollback_unreadable_legacy_journal/);
  assert.equal(await page.evaluate(()=>localStorage.getItem('taskpoints_pending_inbox_state_v1')),raw);
  assert.equal((await assertV2(page,before)).meta.mode,'owned');
  await assertShown(page,newDate);
});

test('an unreadable V2 receipt chain withholds the owned card on startup instead of displaying the legacy date',async t=>{
  const {page}=await acknowledged(t),before=await owned(page);
  await page.evaluate(id=>new Promise((resolve,reject)=>{
    const open=indexedDB.open('taskpoints_state_v2');
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction('mutations','readwrite');
      tx.objectStore('mutations').delete(id);
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onabort=()=>{db.close();reject(tx.error);};
    };
  }),before.journal[0].id);
  await page.reload();
  const notice=page.locator('#taskList [role="status"]');
  await page.waitForFunction(()=>document.querySelector('#taskList [role="status"]')?.textContent.includes('V2 Task unavailable'));
  assert.match(await notice.textContent(),/owned_task_journal_incomplete/);
  assert.equal(await page.locator('.task-priority-card[data-task-id="t1"]').count(),0);
  assert.equal(await page.locator('.task-priority-card[data-task-id="t2"]').count(),1);
  assert.deepEqual(await page.evaluate(()=>ownedPaints),[]);
  assert.equal((await dates(page)).legacy,oldDate);
});
