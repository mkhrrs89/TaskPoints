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
const inboxEventId='record:2026-11-17:SYN';
const inboxKey='taskpoints_pending_inbox_state_v1';
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
      const homeBundle=file==='scoring_core.js'&&['index.html','inbox.html','today.html','game.html','matchups.html'].some(page=>new URL(req.headers.referer||'http://localhost').pathname===prefix+page);
      const content=homeBundle?bundle:fs.readFileSync(resolved);
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});
      res.end(content);
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
    window.ownedTitles=[];
    new MutationObserver(()=>{
      if(!localStorage.getItem('taskpoints_isolated_task_fixture_v1'))return;
      const label=document.querySelector('.task-priority-card[data-task-id="t1"] .task-meta-line')?.textContent;
      if(label && ownedPaints.at(-1)!==label)ownedPaints.push(label);
      const title=document.querySelector('[data-task-card-body="t1"] .task-title')?.textContent;
      if(title && ownedTitles.at(-1)!==title)ownedTitles.push(title);
    }).observe(document,{subtree:true,childList:true});
    Error.stackTraceLimit=36;
    const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    Storage.prototype.setItem=function(key,value){
      if(this===localStorage&&this.getItem(key)!==String(value)) {
        const entry={key,stack:new Error().stack.split('\n').slice(2,36)};
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
async function fixture(t,provided,{beforeHome,coldCanonical=false}={}){
  let context=provided||await browser.newContext({serviceWorkers:'block',timezoneId:'America/New_York'});
  if(!provided){const seededContext=context;t.after(()=>seededContext.close());}
  await configureContext(context);
  let page=await context.newPage();
  const errors=[];
  page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.dismiss());
  await page.clock.install({time:new Date(quietDate+'T17:00:00Z')});
  await page.goto(origin+prefix+'seed.html');
  await page.addScriptTag({path:path.join(root,'scoring_core.js')});
  await page.evaluate(({oldDate,quietDate})=>{
    const snapshot={
      tasks:[{id:'t1',title:'Synthetic V2 target',status:'active',dueDateISO:oldDate,points:5,importance:'High',unknownTask:{keep:[0,null]}},
        {id:'t2',title:'Synthetic unrelated Task',status:'active',dueDateISO:oldDate,points:3,skills:[]}],
      habits:[{id:'h1',name:'Synthetic Habit',category:'habit',pointsPerDay:3,daysPerCompleteWeek:3,doneKeys:[],failedKeys:[],iceKeys:[],timeOfDay:''}],
      players:[{id:'SYN',pid:'SYN',name:'Synthetic Player',imageId:'synthetic-image',baseline:50}],
      gameHistory:[{id:'synthetic-game',dateISO:'2026-10-11',dateKey:'2026-10-11',playerId:'SYN',score:9},
        {id:'synthetic-inbox-score',dateISO:'2026-11-17',dateKey:'2026-11-17',playerId:'SYN',score:46}],
      goldEconomy:{version:1,launchDateKey:'2026-11-05',launchedAtISO:'2026-11-05T12:00:00Z',balances:{SYN:7}},
      goldLedger:[{id:'synthetic-gold',type:'opening_balance',playerId:'SYN',dateKey:'2026-11-05',amount:7,balanceAfter:7}],
      inboxStartedDateKey:'2026-11-01',goldTheftTop50InboxStartedDateKey:'2026-11-01',
      completions:[],reminders:[],matchups:[{id:'synthetic-inbox-game',dateKey:'2026-11-17',dateISO:'2026-11-17',
        playerAId:'SYN',playerBId:'YOU',scoreA:46,scoreB:0,winnerId:'SYN',matchupType:'exhibition'}],schedule:[],opponentDripSchedules:[],
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
  await page.goto(origin+prefix+'inbox.html');
  const generated=await page.evaluate(id=>{
    const result=TaskPointsInbox.populate({force:true});
    const saved=TaskPointsCore.readTaskPointsStoredState();
    return {changed:result.changed,message:saved.inboxMessages?.find(item=>item.id===id),
      journaled:TaskPointsCore.getInboxMutationJournalStatus().pending};
  },inboxEventId);
  assert.equal(generated.changed,true);
  assert.equal(generated.journaled,true);
  assert.equal(generated.message?.title,'Top-50 score');
  await page.clock.fastForward(9000);
  await page.waitForFunction(({id,key})=>localStorage.getItem(key)===null
    && TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1')).inboxMessages?.some(item=>item.id===id),{id:inboxEventId,key:inboxKey});
  const message=generated.message;
  if(beforeHome)await beforeHome(page,message);
  if(coldCanonical){
    // The producer may already have made a verified native mirror. A fresh
    // profile with the actual canonical bytes exercises the fallback without
    // touching that backup or overriding any startup safety guard.
    const source=await page.evaluate(()=>Object.entries(localStorage));
    context=await browser.newContext({serviceWorkers:'block',timezoneId:'America/New_York'});
    const coldContext=context;
    t.after(()=>coldContext.close());
    await configureContext(context);
    page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.dismiss());
    await page.clock.setFixedTime(new Date(quietDate+'T18:00:00Z'));
    await page.goto(origin+prefix+'seed.html');
    await page.evaluate(entries=>{
      for(const [key,value] of entries)localStorage.setItem(key,value);
      sessionStorage.setItem('tpBootSeenThisSession','1');
    },source);
  }
  await page.goto(origin+prefix+'index.html');await waitHome(page);
  assert.deepEqual(errors,[],'uncaught full Home startup errors');
  return {page,context,errors,message};
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
async function partOfState(page){return page.evaluate(async inboxEventId=>{
  const s=TaskPointsCore.readTaskPointsStoredState();
  const image=await TaskPointsCore.getImageBlob('synthetic-image');
  // Home adds three derived display counters during ordinary saves. Compare
  // all persisted Habit fields apart from those generated counters.
  const {__completion,__failedStreak,__streak,...habit}=s.habits.find(h=>h.id==='h1');
  return {task:s.tasks.find(t=>t.id==='t2'),habit,
    game:s.gameHistory.find(g=>g.id==='synthetic-game'||g.playerId==='SYN'),
    gold:s.goldLedger?.find(g=>g.id==='synthetic-gold'),inbox:s.inboxMessages?.find(r=>r.id===inboxEventId),
    projects:localStorage.getItem('tp_projects_v1'),notes:localStorage.getItem('taskpoints_notes_v1'),
    flex:s.flexActions?.find(action=>action.id==='synthetic-flex'),
    unknownTask:s.tasks.find(t=>t.id==='t1').unknownTask,
    unknownRaw:localStorage.getItem('synthetic_unknown_key'),
    quarantine:localStorage.getItem('taskpoints_quarantined_snapshot'),
    image:[...new Uint8Array(await image.arrayBuffer())]};
},inboxEventId);}
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
  for(const collection of ['task','habit','game','gold','inbox','projects','notes','flex','unknownTask'])assert.ok(unrelated[collection],collection+' witness missing');
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


test('ordinary Home startup preserves the notification created and compacted by the real Inbox',async t=>{
  const {page,message}=await fixture(t,undefined,{coldCanonical:true});
  const evidence=await page.evaluate(id=>({
    marker:localStorage.getItem('taskpoints_isolated_task_fixture_v1'),
    boot:window.__TP_HOME_BOOT_SOURCE,
    processed:TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1')).inboxProcessedEventIds?.[id],
    normalSave:legacyWrites.some(w=>w.key==='taskpoints_v1'&&w.stack.some(frame=>frame.includes(' at save '))),
    message:TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1')).inboxMessages?.find(m=>m.id===id),
    writes:legacyWrites.filter(e=>e.key==='taskpoints_v1'&&e.inboxBefore>e.inboxAfter)
  }),message.id);
  assert.equal(evidence.marker,null);
  assert.match(evidence.boot,/^localStorage:/);
  assert.deepEqual(evidence.message,message,JSON.stringify(evidence.writes));
  assert.equal(evidence.processed,true);
  assert.equal(evidence.normalSave,true,'ordinary Home startup must exercise the snapshot writer');
  assert.equal(evidence.writes.length,0);
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

async function interruptOwnedWrite(page,phase){
  await page.evaluate(phase=>{
    const transaction=IDBDatabase.prototype.transaction;
    let committed=false;
    IDBDatabase.prototype.transaction=function(stores,mode,...options){
      const owned=this.name==='taskpoints_state_v2'&&Array.isArray(stores)&&stores.includes('tasks');
      if(owned&&mode==='readonly'&&committed&&phase==='after commit'&&!window.allowOwnedReadback)throw Error('synthetic readback unavailable');
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
}

for(const phase of ['before commit','after commit'])test(`full Home interrupted ${phase} reopens with exactly the committed V2 state`,async t=>{
  const {page,context}=await acknowledged(t);
  await interruptOwnedWrite(page,phase);
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


function inboxState(page,id=inboxEventId){
  return page.evaluate(({id,key})=>{
    const canonical=TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'));
    const effective=TaskPointsCore.readTaskPointsStoredState();
    return {canonical:canonical.inboxMessages?.find(m=>m.id===id),
      effective:effective.inboxMessages?.find(m=>m.id===id),journal:localStorage.getItem(key),processed:canonical.inboxProcessedEventIds?.[id]};
  },{id,key:inboxKey});
}

async function saveOrdinaryHome(page){
  assert.equal(await page.evaluate(()=>{
    TaskPointsHomeLiveState.getState().syntheticInboxSaveWitness='Synthetic regular Home save';
    return save('inbox-preservation-home-save',{immediateWrite:true,userInitiated:true});
  }),true);
  assert.equal(await page.evaluate(()=>TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1')).syntheticInboxSaveWitness),'Synthetic regular Home save');
}

test('pending Inbox edits survive startup and ordinary Home save, then compact and reopen in Inbox',async t=>{
  let edited,pending;
  const {page,message}=await fixture(t,undefined,{beforeHome:async(page,message)=>{
    edited={...message,read:true,unknownInboxField:{retained:['exact',null]}};
    pending=await page.evaluate(({edited,key})=>{
      TaskPointsCore.mergeAndSaveState({inboxMessages:[edited]},{savePath:'inbox-auto-populate',immediateWrite:true});
      return localStorage.getItem(key);
    },{edited,key:inboxKey});
  }});
  const loaded=await inboxState(page);
  assert.deepEqual(loaded.canonical,message);
  assert.deepEqual(loaded.effective,edited);
  assert.equal(loaded.journal,pending);
  await saveOrdinaryHome(page);
  assert.deepEqual(await inboxState(page),loaded);
  await page.reload();await waitHome(page);
  assert.deepEqual((await inboxState(page)).effective,edited);
  await page.clock.fastForward(9000);
  await page.waitForFunction(key=>localStorage.getItem(key)===null,inboxKey);
  assert.deepEqual((await inboxState(page)).canonical,edited,'the compacted edit must be durable before navigation');
  await page.goto(origin+prefix+'inbox.html');
  const reopened=await inboxState(page);
  assert.deepEqual(reopened.canonical,edited,
    'the compacted edit must survive Inbox startup: '+JSON.stringify({reopened,writes:await page.evaluate(()=>legacyWrites.filter(w=>w.key==='taskpoints_v1'))}));
  await page.locator('#inboxMessages').getByText('Top-50 score',{exact:true}).waitFor();
});

test('an explicit empty Inbox journal compacts the deletion and stale Home state cannot resurrect it',async t=>{
  const {page,message}=await fixture(t);
  const stale=await page.evaluate(()=>structuredClone(TaskPointsCore.readTaskPointsStoredState()));
  await page.evaluate(()=>TaskPointsCore.mergeAndSaveState({inboxMessages:[]},{savePath:'inbox-auto-populate',immediateWrite:true}));
  assert.deepEqual((await inboxState(page)).canonical,message);
  assert.equal((await inboxState(page)).effective,undefined);
  await saveOrdinaryHome(page);
  assert.equal((await inboxState(page)).effective,undefined);
  await page.clock.fastForward(9000);
  await page.waitForFunction(key=>localStorage.getItem(key)===null,inboxKey);
  assert.equal((await inboxState(page)).canonical,undefined);
  await page.evaluate(stale=>TaskPointsCore.saveStateSnapshot(stale,{immediateWrite:true,savePath:'stale-home-snapshot'}),stale);
  await page.reload();await waitHome(page);
  const persisted=await inboxState(page);
  assert.equal(persisted.canonical,undefined);
  assert.equal(persisted.effective,undefined);
  assert.equal(persisted.processed,true);
  await page.goto(origin+prefix+'inbox.html');
  assert.equal(await page.evaluate(()=>TaskPointsInbox.populate({force:true}).changed),false);
  assert.equal(await page.locator('#inboxMessages > *').count(),0);
});

test('malformed Inbox evidence is preserved; fallback allows addition and refuses deletion',async t=>{
  const raw='{malformed Inbox evidence';
  const {page,message}=await fixture(t,undefined,{beforeHome:page=>page.evaluate(({raw,key})=>localStorage.setItem(key,raw),{raw,key:inboxKey})});
  const initial=await inboxState(page);
  assert.deepEqual(initial.canonical,message);
  assert.deepEqual(initial.effective,message);
  assert.equal(initial.journal,raw);
  await saveOrdinaryHome(page);
  await assert.rejects(page.evaluate(()=>TaskPointsCore.mergeAndSaveState({inboxMessages:[]},
    {savePath:'inbox-auto-populate',immediateWrite:true})),/fallback cannot replace messages/);
  assert.deepEqual(await inboxState(page),initial);
  const extra={...message,id:'synthetic-additive-fallback'};
  await page.evaluate(extra=>{
    const inboxMessages=TaskPointsCore.readTaskPointsStoredState().inboxMessages;
    return TaskPointsCore.mergeAndSaveState({inboxMessages:[...inboxMessages,extra]},
      {savePath:'inbox-auto-populate',immediateWrite:true});
  },extra);
  await page.reload();await waitHome(page);
  assert.deepEqual(await inboxState(page),initial);
  assert.deepEqual((await inboxState(page,extra.id)).canonical,extra);
});

const originalTitle='Synthetic V2 target';
const newerTitle='Synthetic V2 title & "quoted"';
const editCard=page=>page.locator('.task-priority-card[data-task-id="t1"]');
const titleField=page=>editCard(page).locator('input[data-field="title"]');
const titleSave=page=>editCard(page).locator('[data-task-action="task-save"]');
const backingTask=page=>page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().tasks.find(task=>task.id==='t1'));

async function openTaskEdit(page){
  const card=editCard(page),body=card.locator('[data-task-card-body="t1"]');
  if(await body.getAttribute('aria-expanded')==='false')await body.click();
  await card.locator('[data-task-action="edit"]').click();
}

async function submitTaskEdit(page){
  await page.evaluate(()=>{window.ownerOutcome=null;});
  await titleSave(page).click();
  await page.waitForFunction(()=>window.ownerOutcome!=null);
  return page.evaluate(()=>window.ownerOutcome);
}

async function assertHomeTitle(page,title){
  await page.waitForFunction(title=>document.querySelector('[data-task-card-body="t1"] .task-title')?.textContent===title,title);
}

async function freshTaskOwner(t){
  const f=await fixture(t);
  await f.page.evaluate(()=>TaskPointsCore.flushPendingSaves());
  await installOwner(f.page);
  assert.equal((await owned(f.page)).sourceDrift,false);
  return f;
}

test('real Home title edit commits in V2 and survives Notes, ordinary save, compaction, maintenance and reload',async t=>{
  const {page,errors}=await acknowledged(t);
  const before=await owned(page),legacy=await backingTask(page),unrelated=await partOfState(page);
  await openTaskEdit(page);
  assert.equal(await titleField(page).inputValue(),originalTitle);
  assert.equal(await editCard(page).locator('[data-field="due"]').inputValue(),newDate);
  assert.equal(await editCard(page).locator('[data-field="due"]').isDisabled(),true);
  assert.equal(await editCard(page).locator('[data-field="points"]').isEnabled(),true);
  await page.evaluate(()=>{legacyWrites.length=0;});
  await titleField(page).fill('  '+newerTitle+'  ');
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:newDate,title:newerTitle});
  await assertHomeTitle(page,newerTitle);
  const after=await owned(page),row=after.tasks.find(task=>task.id==='t1'),receipt=after.journal[1];
  assert.equal(after.journal.length,2);
  assert.deepEqual(after.journal[0],before.journal[0]);
  assert.equal(receipt.intent.operation,'home-task-title-edit');
  assert.equal(receipt.intent.title,newerTitle);
  assert.equal(receipt.priorRevision,1);
  assert.deepEqual(row,{...before.tasks[0],title:newerTitle,updatedAtISO:row.updatedAtISO});
  assert.deepEqual(receipt.after,row);
  assert.deepEqual(await backingTask(page),legacy);
  assert.equal(await page.evaluate(()=>legacyWrites.some(w=>['taskpoints_v1','taskpoints_pending_task_mutations_v1'].includes(w.key))),false);
  assert.deepEqual(await partOfState(page),unrelated);

  await page.locator('a.desktop-header-notes-link').click();
  await page.waitForURL('**/notes.html');
  assert.equal(await page.locator('#notesInput').inputValue(),unrelated.notes);
  await page.getByRole('link',{name:'Main',exact:true}).first().click();
  await waitHome(page);
  await assertHomeTitle(page,newerTitle);
  await saveOrdinaryHome(page);
  await assertHomeTitle(page,newerTitle);
  await page.evaluate(async()=>{
    const core=TaskPointsCore;
    core.journalTaskUpdates(['t2'],task=>{task.title='Synthetic latest unrelated Task';return true;});
    if(!core.flushPendingTaskMutations())throw Error('Expected unrelated Task journal compaction');
    core.queuePhase5CVerifiedSecondaryWrite();
    await core.flushPhase5CVerifiedSecondaryWrites();
    if(core.getPhase5CVerifiedSecondaryStatus().homeNativeStatus!=='passed_verification')
      throw Error('Expected verification of native Home maintenance snapshot');
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  });
  await assertHomeTitle(page,newerTitle);
  await page.reload();await waitHome(page);
  await assertHomeTitle(page,newerTitle);
  assert.equal(await page.evaluate(()=>window.__TP_HOME_BOOT_SOURCE),'indexeddb-native');
  assert.equal(await page.evaluate(()=>ownedTitles.includes('Synthetic V2 target')),false,'cold Home must never paint the legacy title');
  // Ordinary Home save materializes the existing default skills array.
  assert.deepEqual(await backingTask(page),{skills:[],...legacy});
  assert.equal((await assertV2(page,after)).sourceDrift,false);
  const preserved=await partOfState(page);
  assert.equal(preserved.task.title,'Synthetic latest unrelated Task');
  assert.deepEqual({...preserved,task:unrelated.task},unrelated);
  assert.deepEqual(errors,[]);
});

test('V2 title editor keeps the existing blank-title rule, and disabled ownership uses the ordinary V1 editor',async t=>{
  const {page}=await fixture(t);
  await openTaskEdit(page);
  assert.equal(await editCard(page).locator('[data-field="points"]').isEnabled(),true);
  await titleField(page).fill('  Synthetic V1 title  ');
  await editCard(page).locator('[data-field="points"]').fill('8');
  await titleSave(page).click();
  await assertHomeTitle(page,'Synthetic V1 title');
  const legacy=await backingTask(page);
  assert.equal(legacy.title,'Synthetic V1 title');
  assert.equal(legacy.points,8);
  assert.equal(await page.evaluate(async()=>!(await indexedDB.databases()).some(db=>db.name===TaskPointsStateRuntimeV2.DB_NAME)),true);
  await page.evaluate(()=>TaskPointsCore.flushPendingTaskMutations());
  await installOwner(page);
  const before=await owned(page);
  await openTaskEdit(page);
  await titleField(page).fill('   ');
  await titleSave(page).click();
  await assertHomeTitle(page,legacy.title);
  assert.deepEqual(await owned(page),before);
  assert.deepEqual(await backingTask(page),legacy);
});

test('stale title editor keeps its draft and refuses the competing edit even after a lifecycle refresh',async t=>{
  const {page,context}=await freshTaskOwner(t);
  await openTaskEdit(page);
  await titleField(page).fill('Synthetic uncommitted draft');
  const peer=await context.newPage();
  await peer.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await peer.goto(origin+prefix+'index.html');await waitHome(peer);
  await openTaskEdit(peer);
  await titleField(peer).fill(newerTitle);
  assert.deepEqual(await submitTaskEdit(peer),{ok:true,date:oldDate,title:newerTitle});
  await page.evaluate(async()=>{
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    await TaskPointsOwnedTaskExperiment.refresh();
  });
  assert.equal(await titleField(page).inputValue(),'Synthetic uncommitted draft');
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'owned_task_stale_edit'});
  assert.equal(await titleField(page).inputValue(),'Synthetic uncommitted draft');
  assert.equal((await owned(page)).journal.length,1);
  await editCard(page).locator('[data-task-action="task-cancel"]').click();
  await assertHomeTitle(page,newerTitle);
  await openTaskEdit(page);
  assert.equal(await titleField(page).inputValue(),newerTitle);
  await titleField(page).fill('Synthetic reviewed title');
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:oldDate,title:'Synthetic reviewed title'});
  assert.equal((await owned(page)).journal.length,2);
  assert.equal((await backingTask(page)).title,originalTitle);
});

test('legacy competing Task title is preserved and blocks V2 edits and rollback after compaction',async t=>{
  const {page}=await freshTaskOwner(t);
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  assert.equal((await submitTaskEdit(page)).ok,true);
  await assertHomeTitle(page,newerTitle);
  const before=await owned(page);
  await openTaskEdit(page);
  await titleField(page).fill('Synthetic competing V2 title');
  await page.evaluate(()=>{
    TaskPointsCore.journalTaskUpdates(['t1'],task=>{task.title='Synthetic competing legacy title';return true;});
    if(!TaskPointsCore.flushPendingTaskMutations())throw Error('Expected competing Task journal compaction');
  });
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'legacy_source_changed_preserved_reconciliation_required'});
  await editCard(page).locator('[data-task-action="task-cancel"]').click();
  await assertHomeTitle(page,newerTitle);
  const after=await owned(page);
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.journal,before.journal);
  assert.equal(after.sourceDrift,true);
  assert.equal((await backingTask(page)).title,'Synthetic competing legacy title');
  await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/legacy_source_changed/);
});

test('quota failure leaves the title uncommitted and unchanged, then an identical retry saves once',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page);
  await page.evaluate(()=>{
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(record,...args){
      if(!window.ownedQuotaRecovered&&record?.intent?.operation==='home-task-title-edit')
        throw new DOMException('synthetic title quota','QuotaExceededError');
      return add.call(this,record,...args);
    };
  });
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'synthetic title quota'});
  assert.deepEqual(await owned(page),before);
  assert.equal(await titleField(page).inputValue(),newerTitle);
  assert.equal((await backingTask(page)).title,originalTitle);
  await page.evaluate(()=>{window.ownedQuotaRecovered=true;});
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:oldDate,title:newerTitle});
  await assertHomeTitle(page,newerTitle);
  assert.equal((await owned(page)).journal.length,1);
});

test('title Save does not report success without readback, and retries with the original receipt ID',async t=>{
  const {page}=await freshTaskOwner(t);
  await interruptOwnedWrite(page,'after commit');
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  await page.evaluate(()=>{
    const button=document.querySelector('[data-task-action="task-save"][data-task-id="t1"]');
    button.click();
    button.click();
  });
  await page.waitForFunction(()=>window.ownerOutcome!=null);
  assert.deepEqual(await page.evaluate(()=>ownerOutcome),{ok:false,error:'synthetic readback unavailable'});
  assert.equal(await editCard(page).locator('.task-title').count(),0,'failed readback cannot paint a success');
  await page.evaluate(async()=>{window.allowOwnedReadback=true;await TaskPointsOwnedTaskExperiment.refresh();});
  const before=await owned(page);
  assert.equal(before.journal.length,1);
  assert.equal(await titleField(page).inputValue(),newerTitle);
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:oldDate,title:newerTitle});
  await assertHomeTitle(page,newerTitle);
  assert.deepEqual(await owned(page),before);
  const receipt=before.journal[0];
  await assert.rejects(page.evaluate(intent=>TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({...intent,title:'Synthetic different payload'}),receipt.intent),/owned_task_action_id_conflict/);
  assert.equal((await backingTask(page)).title,originalTitle);
});

for(const phase of ['before commit','after commit'])test(`interrupted title Save ${phase} reopens with exactly the committed title`,async t=>{
  const {page,context}=await freshTaskOwner(t);
  await interruptOwnedWrite(page,phase);
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  await page.evaluate(()=>document.querySelector('[data-task-action="task-save"][data-task-id="t1"]').click());
  await page.waitForFunction(()=>window.ownedInterruptionReached===true);
  assert.notEqual(await page.evaluate(()=>window.ownerOutcome?.ok),true);
  await page.close();
  const reopened=await context.newPage();
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  const committed=phase==='after commit';
  await assertHomeTitle(reopened,committed?newerTitle:originalTitle);
  assert.equal((await owned(reopened)).journal.length,committed?1:0);
  assert.equal((await backingTask(reopened)).title,originalTitle);
});

async function openRollbackHome(t,transfer,time=quietDate+'T17:00:00Z'){
  const fresh=await browser.newContext({serviceWorkers:'block',timezoneId:'America/New_York'});
  t.after(()=>fresh.close());
  await configureContext(fresh);
  const destination=await fresh.newPage();
  await destination.clock.setFixedTime(new Date(time));
  await destination.goto(origin+prefix+'seed.html');
  await destination.addScriptTag({path:path.join(root,'scoring_core.js')});
  await destination.evaluate(async({checkpoint,image,marker})=>{
    for(const [key,value] of checkpoint.currentLegacySource){
      if(key!==marker&&value!==null)localStorage.setItem(key,value);
    }
    localStorage.setItem('taskpoints_v1',TaskPointsCore.serializeTaskPointsStoredState(checkpoint.snapshot));
    sessionStorage.setItem('tpBootSeenThisSession','1');
    await TaskPointsCore.saveImageBlob('synthetic-image',new Blob([new Uint8Array(image)],{type:'image/png'}));
  },{...transfer,marker});
  await destination.goto(origin+prefix+'index.html');await waitHome(destination);
  return destination;
}

test('Chromium restart and detached fresh-profile rollback preserve the verified V2 title and unrelated data',async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-home-title-edit-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await acknowledged(t,context);
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:newDate,title:newerTitle});
  await assertHomeTitle(page,newerTitle);
  const before=await owned(page),preserved=await partOfState(page);
  await context.close();context=await launch();await configureContext(context);
  const reopened=await context.newPage();
  reopened.on('dialog',dialog=>dialog.dismiss());
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  await assertHomeTitle(reopened,newerTitle);
  await assertShown(reopened,newDate);
  await assertV2(reopened,before);
  assert.deepEqual(await partOfState(reopened),preserved);
  const transfer=await reopened.evaluate(async()=>{
    const checkpoint=await TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(2);
    const blob=await TaskPointsCore.getImageBlob('synthetic-image');
    return {checkpoint,image:[...new Uint8Array(await blob.arrayBuffer())]};
  });
  const {checkpoint}=transfer;
  assert.deepEqual(checkpoint.receipts,before.journal);
  assert.equal(checkpoint.v2Frozen,true);
  await openTaskEdit(reopened);
  await titleField(reopened).fill('Synthetic rejected after rollback');
  assert.deepEqual(await submitTaskEdit(reopened),{ok:false,error:'rollback_frozen_no_task_writes'});

  const destination=await openRollbackHome(t,transfer);
  await assertHomeTitle(destination,newerTitle);
  assert.deepEqual(await dates(destination),{home:newDate,legacy:newDate});
  assert.equal((await backingTask(destination)).title,newerTitle);
  assert.deepEqual(await partOfState(destination),preserved);
  assert.equal(await destination.evaluate(async()=>!(await indexedDB.databases()).some(db=>db.name===TaskPointsStateRuntimeV2.DB_NAME)),true);
  assert.equal((await backingTask(reopened)).title,originalTitle);
  await assertV2(reopened,before);
});

test('reopen refuses a title receipt that also changes an unrelated field, even if the V2 row matches',async t=>{
  const {page}=await freshTaskOwner(t);
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  assert.equal((await submitTaskEdit(page)).ok,true);
  await assertHomeTitle(page,newerTitle);
  const {rows,journal}=await owned(page);
  const receipt=journal[0],row=rows.find(candidate=>candidate.id==='t1');
  row.value.points+=1;
  receipt.after.points=row.value.points;
  await page.evaluate(({row,receipt})=>new Promise((resolve,reject)=>{
    const open=indexedDB.open('taskpoints_state_v2');
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction(['tasks','mutations'],'readwrite');
      tx.objectStore('tasks').put(row);
      tx.objectStore('mutations').put(receipt);
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onabort=()=>{db.close();reject(tx.error);};
    };
  }),{row,receipt});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#taskList [role="status"]')?.textContent.includes('owned_task_journal_conflict'));
  assert.equal(await editCard(page).count(),0);
  assert.deepEqual(await page.evaluate(()=>ownedTitles),[]);
  assert.equal((await backingTask(page)).title,originalTitle);
  assert.equal(await page.locator('[data-task-card-body="t2"] .task-title').textContent(),'Synthetic unrelated Task');
});

const classificationOperation='home-task-classification-edit';
const classificationTags=['Work','Planning & "review" <draft>','Work'];
const classificationFields={importance:'Critical',tags:classificationTags};
const importanceField=page=>editCard(page).locator('[data-field="importance"]');
const tagsField=page=>editCard(page).locator('[data-field="tags"]');
const ownedTask=snapshot=>snapshot.tasks.find(task=>task.id==='t1');

async function fillClassification(page){
  await importanceField(page).selectOption('Critical');
  await tagsField(page).fill('  Work, , Planning & "review" <draft>, Work  ');
}

async function assertHomeClassification(page,importance,tags){
  const card=editCard(page);
  const cssClass=importance==='Critical'?'critical-card':importance==='High'?'high-card':'task-priority-'+importance.toLowerCase();
  await card.locator('[data-task-card-body="t1"]').waitFor();
  assert.ok((await card.getAttribute('class')).split(' ').includes(cssClass));
  assert.deepEqual(await card.locator('.task-tags .tag').allTextContents(),tags);
  assert.equal((await card.getAttribute('class')).split(' ').includes('task-work-tagged'),
    tags.some(tag=>tag.toLowerCase()==='work'));
}

for(const withPoints of [false,true])test(`real Home saves Importance, Tags and title${withPoints?' with Points':''} in one V2 receipt through navigation, legacy save, maintenance and reload`,async t=>{
  const pointsPatch=withPoints?{points:12.75}:{};
  const fields={...classificationFields,title:newerTitle,...pointsPatch};
  const {page,errors}=await acknowledged(t);
  const before=await owned(page),legacy=await backingTask(page),unrelated=await partOfState(page);
  await openTaskEdit(page);
  assert.equal(await importanceField(page).inputValue(),'High');
  assert.equal(await tagsField(page).inputValue(),'');
  for(const field of ['due','repeat','repeatCustomCount','repeatCustomUnit'])
    assert.equal(await editCard(page).locator('[data-field="'+field+'"]').isDisabled(),true);
  await fillClassification(page);
  await titleField(page).fill('  '+newerTitle+'  ');
  if(withPoints)await pointsField(page).fill('12.75');
  await page.evaluate(()=>{legacyWrites.length=0;});
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:newDate,title:newerTitle,...classificationFields,...pointsPatch});
  await assertHomeTitle(page,newerTitle);
  await assertHomeClassification(page,'Critical',classificationTags);
  const after=await owned(page),task=ownedTask(after),receipt=after.journal.at(-1);
  assert.deepEqual(after.journal.slice(0,-1),before.journal);
  assert.equal(after.journal.length,2);
  assert.equal(receipt.intent.operation,withPoints?pointsOperation:classificationOperation);
  assert.deepEqual(receipt.intent.fields,fields);
  assert.deepEqual(task,{...ownedTask(before),...fields,updatedAtISO:task.updatedAtISO});
  assert.deepEqual(receipt.after,task);
  assert.deepEqual(await backingTask(page),legacy);
  assert.equal(await page.evaluate(()=>legacyWrites.some(w=>['taskpoints_v1','taskpoints_pending_task_mutations_v1'].includes(w.key))),false);
  assert.deepEqual(await partOfState(page),unrelated);

  await page.locator('a.desktop-header-notes-link').click();
  await page.waitForURL('**/notes.html');
  assert.equal(await page.locator('#notesInput').inputValue(),unrelated.notes);
  await page.getByRole('link',{name:'Main',exact:true}).first().click();
  await waitHome(page);
  await assertHomeClassification(page,'Critical',classificationTags);
  await saveOrdinaryHome(page);
  await assertHomeClassification(page,'Critical',classificationTags);
  await page.evaluate(async()=>{
    const core=TaskPointsCore;
    core.journalTaskUpdates(['t2'],task=>{task.title='Synthetic compacted unrelated edit';return true;});
    if(!core.flushPendingTaskMutations())throw Error('Expected unrelated Task journal compaction');
    if(core.readPendingTaskMutations().record.tasks.length)throw Error('Expected drained Task journal');
    core.queuePhase5CVerifiedSecondaryWrite();
    await core.flushPhase5CVerifiedSecondaryWrites();
    if(core.getPhase5CVerifiedSecondaryStatus().homeNativeStatus!=='passed_verification')
      throw Error('Expected verified maintenance snapshot');
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  });
  await assertHomeClassification(page,'Critical',classificationTags);
  await page.setViewportSize({width:390,height:844});
  await page.reload();await waitHome(page);
  await assertHomeClassification(page,'Critical',classificationTags);
  assert.equal(await page.locator('#criticalTasksIsland').getAttribute('data-active'),'1');
  await assertHomeTitle(page,newerTitle);await assertShown(page,newDate);
  if(withPoints)await assertHomePoints(page,12.75);
  assert.equal(await page.evaluate(()=>window.__TP_HOME_BOOT_SOURCE),'indexeddb-native');
  assert.deepEqual(await backingTask(page),{skills:[],...legacy});
  assert.equal((await assertV2(page,after)).sourceDrift,false);
  const preserved=await partOfState(page);
  assert.equal(preserved.task.title,'Synthetic compacted unrelated edit');
  assert.deepEqual({...preserved,task:unrelated.task},unrelated);
  await openTaskEdit(page);
  assert.equal(await importanceField(page).inputValue(),'Critical');
  assert.equal(await tagsField(page).inputValue(),classificationTags.join(', '));
  assert.deepEqual(errors,[]);
});

test('individual classification edits preserve untouched fields, normalize tags and clear tags explicitly',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page);
  await openTaskEdit(page);
  await importanceField(page).selectOption('Low');
  assert.equal((await submitTaskEdit(page)).ok,true);
  await assertHomeClassification(page,'Low',[]);
  let saved=await owned(page);
  assert.deepEqual(saved.journal[0].intent.fields,{importance:'Low'});
  assert.deepEqual(ownedTask(saved),{...ownedTask(before),importance:'Low',updatedAtISO:ownedTask(saved).updatedAtISO});
  await openTaskEdit(page);
  await tagsField(page).fill('  Alpha, , beta, Alpha  ');
  assert.equal((await submitTaskEdit(page)).ok,true);
  const tags=['Alpha','beta','Alpha'];
  await assertHomeClassification(page,'Low',tags);
  saved=await owned(page);
  assert.deepEqual(saved.journal[1].intent.fields,{tags});
  await openTaskEdit(page);
  await tagsField(page).fill('Alpha,beta,, Alpha   ');
  await titleSave(page).click();
  await assertHomeClassification(page,'Low',tags);
  assert.deepEqual(await owned(page),saved,'the same normalized tags cause no write');
  await openTaskEdit(page);
  await tagsField(page).fill(' , ');
  assert.equal((await submitTaskEdit(page)).ok,true);
  await assertHomeClassification(page,'Low',[]);
  saved=await owned(page);
  assert.deepEqual(saved.journal[2].intent.fields,{tags:[]});
  assert.deepEqual(ownedTask(saved).tags,[]);
});

test('with ownership disabled the real V1 editor still saves Importance and Tags',async t=>{
  const {page}=await fixture(t);
  await openTaskEdit(page);
  await fillClassification(page);
  await titleSave(page).click();
  await assertHomeClassification(page,'Critical',classificationTags);
  const legacy=await backingTask(page);
  assert.equal(legacy.importance,'Critical');
  assert.deepEqual(legacy.tags,classificationTags);
  assert.equal(await page.evaluate(async()=>!(await indexedDB.databases()).some(db=>db.name===TaskPointsStateRuntimeV2.DB_NAME)),true);
});

for(const withPoints of [false,true])test(`a competing V2 edit refuses a stale classification draft${withPoints?' with Points':''}, and a compacted V1 edit pauses V2 and rollback`,async t=>{
  const {page,context}=await freshTaskOwner(t);
  await openTaskEdit(page);
  await fillClassification(page);
  if(withPoints)await pointsField(page).fill('17');
  const peer=await context.newPage();
  await peer.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await peer.goto(origin+prefix+'index.html');await waitHome(peer);
  await openTaskEdit(peer);
  await importanceField(peer).selectOption('Medium');
  await tagsField(peer).fill('Peer tags');
  if(withPoints)await pointsField(peer).fill('11');
  assert.equal((await submitTaskEdit(peer)).ok,true);
  await assertHomeClassification(peer,'Medium',['Peer tags']);
  await page.evaluate(()=>TaskPointsOwnedTaskExperiment.refresh());
  assert.equal(await importanceField(page).inputValue(),'Critical');
  assert.equal(await tagsField(page).inputValue(),'  Work, , Planning & "review" <draft>, Work  ');
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'owned_task_stale_edit'});
  assert.equal(await importanceField(page).inputValue(),'Critical');
  assert.equal(await tagsField(page).inputValue(),'  Work, , Planning & "review" <draft>, Work  ');
  const saved=await owned(page);
  assert.equal(saved.journal.length,1);
  await editCard(page).locator('[data-task-action="task-cancel"]').click();
  await assertHomeClassification(page,'Medium',['Peer tags']);
  if(withPoints)await assertHomePoints(page,11);

  await openTaskEdit(page);
  await fillClassification(page);
  await page.evaluate(withPoints=>{
    TaskPointsCore.journalTaskUpdates(['t1'],task=>{task.tags=['Competing legacy'];if(withPoints)task.points=22;return true;});
    if(!TaskPointsCore.flushPendingTaskMutations())throw Error('Expected competing Task journal compaction');
  },withPoints);
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'legacy_source_changed_preserved_reconciliation_required'});
  assert.deepEqual(await owned(page),{...saved,sourceDrift:true});
  assert.deepEqual((await backingTask(page)).tags,['Competing legacy']);
  if(withPoints)assert.equal((await backingTask(page)).points,22);
  await assert.rejects(page.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1)),/legacy_source_changed/);
});

test('a quota failure leaves both classification fields uncommitted and allows an identical retry',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page),legacy=await backingTask(page);
  await page.evaluate(operation=>{
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(record,...args){
      if(!window.ownedQuotaRecovered&&record?.intent?.operation===operation)
        throw new DOMException('synthetic classification quota','QuotaExceededError');
      return add.call(this,record,...args);
    };
  },classificationOperation);
  await openTaskEdit(page);
  await fillClassification(page);
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'synthetic classification quota'});
  assert.deepEqual(await owned(page),before);
  assert.deepEqual(await backingTask(page),legacy);
  assert.equal(await importanceField(page).inputValue(),'Critical');
  assert.equal(await tagsField(page).inputValue(),'  Work, , Planning & "review" <draft>, Work  ');
  await page.evaluate(()=>{window.ownedQuotaRecovered=true;});
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:oldDate,title:originalTitle,...classificationFields});
  await assertHomeClassification(page,'Critical',classificationTags);
  assert.equal((await owned(page)).journal.length,1);
});

test('classification Save refuses success without readback and retries the exact fields with one receipt',async t=>{
  const {page}=await freshTaskOwner(t);
  await interruptOwnedWrite(page,'after commit');
  await openTaskEdit(page);
  await fillClassification(page);
  await page.evaluate(()=>{
    const button=document.querySelector('[data-task-action="task-save"][data-task-id="t1"]');
    button.click();
    button.click();
  });
  await page.waitForFunction(()=>window.ownerOutcome!=null);
  assert.deepEqual(await page.evaluate(()=>ownerOutcome),{ok:false,error:'synthetic readback unavailable'});
  assert.equal(await editCard(page).locator('.task-title').count(),0);
  await page.evaluate(async()=>{window.allowOwnedReadback=true;await TaskPointsOwnedTaskExperiment.refresh();});
  const saved=await owned(page);
  assert.equal(saved.journal.length,1);
  await tagsField(page).fill('Different retry');
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'Retry the unchanged pending Task action, or reopen Home to verify its outcome.'});
  await fillClassification(page);
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:oldDate,title:originalTitle,...classificationFields});
  await assertHomeClassification(page,'Critical',classificationTags);
  assert.deepEqual(await owned(page),saved);
  const {intent}=saved.journal[0];
  await assert.rejects(page.evaluate(intent=>TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({...intent,fields:{...intent.fields,tags:[]}}),intent),/owned_task_action_id_conflict/);
});

for(const phase of ['before commit','after commit'])for(const withPoints of [false,true])test(`interrupted classification Save${withPoints?' with Points':''} ${phase} reopens with both fields or neither`,async t=>{
  const {page,context}=await freshTaskOwner(t),before=await owned(page);
  await interruptOwnedWrite(page,phase);
  await openTaskEdit(page);
  await fillClassification(page);
  if(withPoints)await pointsField(page).fill('9');
  await page.evaluate(()=>document.querySelector('[data-task-action="task-save"][data-task-id="t1"]').click());
  await page.waitForFunction(()=>window.ownedInterruptionReached===true);
  assert.notEqual(await page.evaluate(()=>window.ownerOutcome?.ok),true);
  await page.close();
  const reopened=await context.newPage();
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  const committed=phase==='after commit',after=await owned(reopened);
  await assertHomeClassification(reopened,committed?'Critical':'High',committed?classificationTags:[]);
  assert.equal(after.journal.length,committed?1:0);
  if(withPoints)await assertHomePoints(reopened,committed?9:5);
  if(committed)assert.deepEqual(after.journal[0].intent.fields,withPoints?{...classificationFields,points:9}:classificationFields);
  else assert.deepEqual(after,before);
});

test('Chromium restart and fresh V1 rollback preserve acknowledged classification, title, date and unrelated data',async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-home-classification-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await acknowledged(t,context);
  await openTaskEdit(page);
  await titleField(page).fill(newerTitle);
  await fillClassification(page);
  assert.deepEqual(await submitTaskEdit(page),{ok:true,date:newDate,title:newerTitle,...classificationFields});
  await assertHomeClassification(page,'Critical',classificationTags);
  const before=await owned(page),preserved=await partOfState(page);
  await context.close();context=await launch();await configureContext(context);
  const reopened=await context.newPage();
  reopened.on('dialog',dialog=>dialog.dismiss());
  await reopened.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  await assertHomeClassification(reopened,'Critical',classificationTags);
  await assertHomeTitle(reopened,newerTitle);await assertShown(reopened,newDate);
  await assertV2(reopened,before);
  assert.deepEqual(await partOfState(reopened),preserved);
  const journalKey='taskpoints_pending_task_mutations_v1';
  const pending=await reopened.evaluate(key=>{
    TaskPointsCore.journalTaskUpdates(['t2'],task=>{task.title='Synthetic pending unrelated edit';return true;});
    return localStorage.getItem(key);
  },journalKey);
  assert.ok(pending);
  const current=await partOfState(reopened);
  assert.equal(current.task.title,'Synthetic pending unrelated edit');
  assert.deepEqual({...current,task:preserved.task},preserved);
  const transfer=await reopened.evaluate(async()=>{
    const checkpoint=await TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(2);
    const blob=await TaskPointsCore.getImageBlob('synthetic-image');
    return {checkpoint,image:[...new Uint8Array(await blob.arrayBuffer())]};
  });
  assert.deepEqual(transfer.checkpoint.receipts,before.journal);
  assert.equal(transfer.checkpoint.v2Frozen,true);
  assert.deepEqual(transfer.checkpoint.snapshot.tasks.find(task=>task.id==='t1'),ownedTask(before));
  assert.equal(new Map(transfer.checkpoint.currentLegacySource).get(journalKey),pending);
  await openTaskEdit(reopened);
  await tagsField(reopened).fill('Refused after freeze');
  assert.deepEqual(await submitTaskEdit(reopened),{ok:false,error:'rollback_frozen_no_task_writes'});

  const destination=await openRollbackHome(t,transfer);
  await assertHomeClassification(destination,'Critical',classificationTags);
  await assertHomeTitle(destination,newerTitle);
  assert.deepEqual(await dates(destination),{home:newDate,legacy:newDate});
  // Ordinary Home can materialize an empty skills array during a save.
  assert.deepEqual({skills:[],...(await backingTask(destination))},{skills:[],...ownedTask(before)});
  assert.deepEqual(await partOfState(destination),current);
  assert.equal(await destination.evaluate(async()=>!(await indexedDB.databases()).some(db=>db.name===TaskPointsStateRuntimeV2.DB_NAME)),true);
  await openTaskEdit(destination);
  assert.equal(await tagsField(destination).inputValue(),classificationTags.join(', '));
  await assertV2(reopened,before);
});

test('classification intent rejects non-editor fields, invalid Importance and malformed Tags',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page);
  const intent={operation:classificationOperation,taskId:'t1',generation:before.meta.generation,
    expectedRevision:0,expectedTask:ownedTask(before)};
  for(const fields of [{importance:'Critical',points:10},{importance:'Other'},{tags:['ok','']},{tags:['one,two']},{title:'Title only'}]){
    await assert.rejects(page.evaluate(({intent,fields})=>TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({
      ...intent,actionId:crypto.randomUUID(),fields
    }),{intent,fields}),/invalid_owned_task_intent/);
  }
  assert.deepEqual(await owned(page),before);
});

const pointsOperation='home-task-points-edit';
const pointsField=page=>editCard(page).locator('[data-field="points"]');
const assertHomePoints=(page,expected)=>page.waitForFunction(points=>
  document.querySelector('[data-task-card-body="t1"] .taskPointsNumber')?.textContent===String(points),expected);

function rewardEvidence(page){
  return page.evaluate(()=>{
    const core=TaskPointsCore,s=core.readTaskPointsStoredState();
    return {
      completions:s.completions,
      earned:s.completions.map(entry=>[entry.id,core.pointsForCompletion(entry,s)]),
      totals:core.aggregateCompletionsByDate(s.completions,s),
      gameHistory:s.gameHistory,
      matchups:s.matchups,
      goldLedger:s.goldLedger,
      goldEconomy:s.goldEconomy
    };
  });
}

test('Points edits keep real historical rewards and future V1 Done earns the new amount after restart and rollback',async t=>{
  // Run before Home's daily Game simulation window on every reopen.
  const time=quietDate+'T07:00:00Z';
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-home-points-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await fixture(t,context);
  await page.clock.setFixedTime(new Date('2026-11-14T17:00:00Z'));
  await openTaskEdit(page);
  await editCard(page).locator('[data-field="repeat"]').selectOption('daily');
  await titleSave(page).click();
  await editCard(page).locator('[data-task-action="complete"]').click();
  await page.locator('.task-priority-card[data-task-id="t2"] [data-task-action="complete"]').click();
  await page.waitForFunction(()=>TaskPointsCore.readTaskPointsStoredState().completions.filter(c=>c.taskId==='t1'||c.taskId==='t2').length===2);
  assert.equal(await page.evaluate(()=>TaskPointsCore.flushPendingTaskMutations()),true);
  await page.clock.setFixedTime(new Date(time));
  await page.reload();await waitHome(page);
  await page.evaluate(()=>TaskPointsCore.flushPendingSaves());
  await page.evaluate(()=>{
    const core=TaskPointsCore;
    const saved=core.saveValidatedSnapshot(core.readTaskPointsStoredState(),{immediateWrite:true,savePath:'synthetic-points-backup'});
    if(saved?.blocked||saved?.skipped)throw Error('Synthetic backup save refused');
  });
  const history=await rewardEvidence(page),preserved=await partOfState(page);
  assert.equal(preserved.task.status,'done');
  assert.equal(history.completions.find(c=>c.taskId==='t1').points,5);
  assert.equal(history.completions.find(c=>c.taskId==='t2').points,3);
  assert.equal(history.totals.dailyTotals['2026-11-14'],8);
  await installOwner(page);
  assert.equal((await owned(page)).sourceDrift,false);
  const backupKeys=['taskpoints_backup_latest','taskpoints_backup_prev1','taskpoints_backup_prev2','taskpoints_backup_prev3'];
  const backups=await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),backupKeys);
  assert.ok(backups.some(value=>value!==null),'real rolling backup fixture');
  await openTaskEdit(page);
  await pointsField(page).fill('12.75');
  await page.evaluate(()=>{legacyWrites.length=0;});
  assert.equal((await submitTaskEdit(page)).points,12.75);
  await assertHomePoints(page,12.75);
  const committed=await owned(page);
  assert.deepEqual(committed.journal[0].intent.fields,{points:12.75});
  assert.deepEqual(await rewardEvidence(page),history);
  assert.deepEqual(await partOfState(page),preserved);
  assert.deepEqual(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),backupKeys),backups);
  assert.equal((await backingTask(page)).points,5);
  assert.equal(await page.evaluate(()=>legacyWrites.some(w=>['taskpoints_v1','taskpoints_pending_task_mutations_v1'].includes(w.key))),false);
  await editCard(page).locator('[data-task-action="complete"]').click();
  assert.deepEqual(await rewardEvidence(page),history);

  await context.close();context=await launch();await configureContext(context);
  const reopened=await context.newPage();
  await reopened.clock.setFixedTime(new Date(time));
  await reopened.goto(origin+prefix+'index.html');await waitHome(reopened);
  await assertHomePoints(reopened,12.75);
  assert.deepEqual((await owned(reopened)).journal,committed.journal);
  const afterRestart=await rewardEvidence(reopened);
  for(const key of ['completions','earned','totals'])assert.deepEqual(afterRestart[key],history[key]);
  // Ordinary boot can append a daily Game simulation and its Gold reward.
  // Existing rows must survive byte-for-byte, including linked matchup rewards.
  for(const key of ['gameHistory','matchups','goldLedger']){
    const previousIds=new Set(history[key].map(row=>row.id));
    assert.deepEqual(afterRestart[key].filter(row=>previousIds.has(row.id)),history[key]);
  }
  const transfer=await reopened.evaluate(async()=>{
    const checkpoint=await TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1);
    const blob=await TaskPointsCore.getImageBlob('synthetic-image');
    return {checkpoint,image:[...new Uint8Array(await blob.arrayBuffer())]};
  });
  assert.deepEqual(transfer.checkpoint.snapshot.completions,history.completions);
  assert.deepEqual(transfer.checkpoint.receipts,committed.journal);
  const restored=await openRollbackHome(t,transfer,time);
  await assertHomePoints(restored,12.75);
  assert.deepEqual(await rewardEvidence(restored),afterRestart);
  assert.deepEqual(await partOfState(restored),preserved);
  await editCard(restored).locator('[data-task-action="complete"]').click();
  await restored.waitForFunction(()=>TaskPointsCore.readTaskPointsStoredState().completions.filter(c=>c.taskId==='t1').length===2);
  const future=await rewardEvidence(restored);
  const award=future.completions.find(entry=>!history.completions.some(old=>old.id===entry.id));
  assert.equal(award.taskId,'t1');
  assert.equal(award.points,12.75);
  assert.equal(future.earned.find(([id])=>id===award.id)[1],12.75);
  assert.equal(future.totals.dailyTotals['2026-11-14'],8);
  assert.equal(future.totals.dailyTotals[quietDate],12.75);
  assert.deepEqual(future.completions.filter(entry=>entry.id!==award.id),history.completions);
  assert.deepEqual(future.earned.filter(([id])=>id!==award.id),history.earned);
  assert.equal(await restored.evaluate(()=>TaskPointsCore.flushPendingTaskMutations()),true);
  await restored.reload();await waitHome(restored);
  assert.deepEqual((await rewardEvidence(restored)).completions,future.completions);
});

test('real V2 Points input keeps V1 numeric behavior for decimals, negatives, blank and exponent values',async t=>{
  const {page}=await freshTaskOwner(t);
  for(const [value,points] of [['-1.25',-1.25],['',0],['1e2',100]]){
    await openTaskEdit(page);
    await pointsField(page).fill(value);
    assert.equal((await submitTaskEdit(page)).points,points);
    await assertHomePoints(page,points);
  }
  assert.deepEqual((await owned(page)).journal.map(receipt=>receipt.intent.fields.points),[-1.25,0,100]);
  assert.equal((await backingTask(page)).points,5);
});

test('Points quota and unconfirmed readback retries preserve the original intent and award no completion',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page),history=await rewardEvidence(page);
  await page.evaluate(operation=>{
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(record,...args){
      if(!window.ownedQuotaRecovered&&record?.intent?.operation===operation)
        throw new DOMException('synthetic Points quota','QuotaExceededError');
      return add.call(this,record,...args);
    };
  },pointsOperation);
  await openTaskEdit(page);
  await pointsField(page).fill('9');
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'synthetic Points quota'});
  assert.deepEqual(await owned(page),before);
  assert.equal(await pointsField(page).inputValue(),'9');
  await page.evaluate(()=>{window.ownedQuotaRecovered=true;});
  await interruptOwnedWrite(page,'after commit');
  assert.deepEqual(await submitTaskEdit(page),{ok:false,error:'synthetic readback unavailable'});
  await page.evaluate(async()=>{window.allowOwnedReadback=true;await TaskPointsOwnedTaskExperiment.refresh();});
  const unconfirmed=await owned(page);
  assert.equal(unconfirmed.journal.length,1);
  assert.equal((await submitTaskEdit(page)).points,9);
  await assertHomePoints(page,9);
  assert.deepEqual(await owned(page),unconfirmed);
  assert.deepEqual(await rewardEvidence(page),history);
});

test('Points receipt admission refuses strings, non-finite numbers and unrelated fields',async t=>{
  const {page}=await freshTaskOwner(t),before=await owned(page);
  const intent={operation:pointsOperation,taskId:'t1',generation:before.meta.generation,
    expectedRevision:0,expectedTask:ownedTask(before)};
  for(const fields of [{points:'9'},{points:Infinity},{points:NaN},{points:5,dueDateISO:newDate}]){
    await assert.rejects(page.evaluate(({intent,fields})=>TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({
      ...intent,actionId:crypto.randomUUID(),fields
    }),{intent,fields}),/invalid_owned_task_intent/);
  }
  assert.deepEqual(await owned(page),before);
});


// History of the stale 5-point award is preserved in commit 31bc2d20.
async function todayCompletionPage(context,alias=false){
  const page=await context.newPage();
  const alerts=[];
  page.setDefaultTimeout(12000);
  page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.dismiss();});
  await page.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await page.goto(origin+(alias?'/':prefix)+'today.html');
  return {page,alerts};
}
const todayTask=(page,id='t1')=>page.locator(`#todayList [data-kind="task"][data-id="${id}"]`);
const todayDone=(page,id)=>todayTask(page,id).locator('.today-check').dispatchEvent('click');
const homeDone=page=>editCard(page).locator('[data-task-action="complete"]').dispatchEvent('click');

function completionWriteEvidence(page){
  return page.evaluate(()=>{
    const keys=['taskpoints_v1','taskpoints_pending_task_mutations_v1','taskpoints_today_view_v1',
      'tpTodayScore','taskpoints_backup_latest','taskpoints_backup_prev1','taskpoints_backup_prev2',
      'taskpoints_backup_prev3','taskpoints_quarantined_snapshot'];
    return keys.map(k=>[k,localStorage.getItem(k)]);
  });
}

async function prepareCompletionBoundary(t,context){
  const f=await fixture(t,context),{page}=f;
  await page.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await openTaskEdit(page);
  await editCard(page).locator('[data-field="due"]').fill(quietDate);
  await titleSave(page).click();
  await page.evaluate(day=>{
    TaskPointsCore.journalTaskUpdates(['t2'],task=>{task.dueDateISO=day;return true;});
    if(!TaskPointsCore.flushPendingTaskMutations())throw Error('Expected Task compaction');
  },quietDate);
  return f;
}

async function setOwnedCompletionPoints(page){
  await installOwner(page);
  assert.equal((await owned(page)).sourceDrift,false);
  await openTaskEdit(page);
  await pointsField(page).fill('12.75');
  assert.equal((await submitTaskEdit(page)).points,12.75);
  await assertHomePoints(page,12.75);
  assert.equal((await backingTask(page)).points,5);
  return owned(page);
}

test('shared Done admission stops the stale 5-point award in fresh and already open Today tabs before any legacy write',async t=>{
  const {page,context}=await prepareCompletionBoundary(t);
  const stale=await todayCompletionPage(context);
  assert.equal(await todayTask(stale.page).locator('.today-sub').textContent(),'5 pts');
  const verified=await setOwnedCompletionPoints(page);
  const fresh=await todayCompletionPage(context,true);
  const homeAlerts=[];
  page.on('dialog',dialog=>homeAlerts.push(dialog.message()));
  for(const peer of [stale,fresh]){
    assert.equal(await todayTask(peer.page).locator('.today-sub').textContent(),'5 pts');
    // Use the checked-in shared core even when the Today tab has no V2 adapter or injection flag.
    assert.equal(await peer.page.evaluate(()=>{
      delete window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__;
      return typeof window.TaskPointsOwnedTaskExperiment;
    }),'undefined');
  }
  const history=await rewardEvidence(page),before=await completionWriteEvidence(page);
  assert.deepEqual(history.completions,[]);
  const participants=[page,stale.page,fresh.page];
  await Promise.all(participants.map(p=>p.evaluate(()=>{legacyWrites.length=0;})));
  await Promise.all([homeDone(page),todayDone(stale.page),todayDone(fresh.page)]);
  await Promise.all([homeDone(page),todayDone(stale.page),todayDone(fresh.page)]);
  for(const peer of [{alerts:homeAlerts},stale,fresh]){
    assert.equal(peer.alerts.length,2);
    assert.ok(peer.alerts.every(text=>text.includes('owned by the V2 experiment')));
  }
  assert.deepEqual(await completionWriteEvidence(page),before);
  assert.deepEqual(await rewardEvidence(page),history);
  assert.deepEqual(await page.evaluate(()=>TaskPointsHomeLiveState.getState().completions),[]);
  for(const participant of participants){
    assert.deepEqual(await participant.evaluate(()=>legacyWrites.filter(write=>
      write.stack.some(frame=>/completeTask|onListClick/.test(frame)))),[]);
  }
  await assertHomePoints(page,12.75);
  for(const peer of [stale,fresh]){
    assert.doesNotMatch(await todayTask(peer.page).getAttribute('class'),/is-done/);
  }
  assert.deepEqual(await owned(page),verified);

  await fresh.page.reload();
  await todayTask(fresh.page).waitFor();
  const reloadedBefore=await completionWriteEvidence(fresh.page);
  await todayDone(fresh.page);
  assert.equal(fresh.alerts.length,3);
  assert.deepEqual(await completionWriteEvidence(fresh.page),reloadedBefore);
  assert.equal(await fresh.page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().completions.length),0);
  assert.deepEqual(await owned(page),verified);
});

test('shared Done admission holds after restart with malformed evidence and after marker loss in an open tab',async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-done-admission-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await prepareCompletionBoundary(t,context);
  await setOwnedCompletionPoints(page);
  const malformed='{truncated synthetic owner marker';
  await page.evaluate(({key,value})=>localStorage.setItem(key,value),{key:marker,value:malformed});
  await context.close();
  context=await launch();
  await configureContext(context);
  const today=await todayCompletionPage(context);
  await todayTask(today.page).waitFor();
  const before=await completionWriteEvidence(today.page);
  await todayDone(today.page);
  assert.equal(today.alerts.length,1);
  assert.equal(await today.page.evaluate(key=>localStorage.getItem(key),marker),malformed);
  // Same-document loss does not dispatch a storage event. The startup/point-of-use
  // latch still prevents falling back to the legacy writer.
  await today.page.evaluate(key=>localStorage.removeItem(key),marker);
  await todayDone(today.page);
  assert.equal(today.alerts.length,2);
  assert.deepEqual(await completionWriteEvidence(today.page),before);
  assert.deepEqual(await today.page.evaluate(()=>TaskPointsCore.readTaskPointsStoredState().completions),[]);
});

test('Today can still complete an unrelated Task and a fresh V1 rollback awards the restored 12.75 Points once',async t=>{
  const {page,context}=await prepareCompletionBoundary(t);
  const verified=await setOwnedCompletionPoints(page);
  const today=await todayCompletionPage(context);
  await todayDone(today.page,'t2');
  await todayTask(today.page,'t2').and(today.page.locator('.is-done')).waitFor();
  assert.equal(today.alerts.length,0);
  const canonicalCompletions=page=>page.evaluate(()=>{
    const core=TaskPointsCore;
    return core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY)).completions;
  });
  const unrelatedAward=await canonicalCompletions(today.page);
  assert.equal(unrelatedAward.length,1);
  assert.equal(unrelatedAward[0].taskId,'t2');
  assert.equal(unrelatedAward[0].points,3);
  await page.waitForFunction(()=>TaskPointsCore.parseTaskPointsStorageJson(
    localStorage.getItem(TaskPointsCore.STORAGE_KEY)).completions.some(row=>row.taskId==='t2'));
  assert.deepEqual(await owned(page),verified);

  const transfer=await page.evaluate(async()=>{
    const checkpoint=await TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(1);
    const blob=await TaskPointsCore.getImageBlob('synthetic-image');
    return {checkpoint,image:[...new Uint8Array(await blob.arrayBuffer())]};
  });
  assert.deepEqual(transfer.checkpoint.snapshot.completions,unrelatedAward);
  const restored=await openRollbackHome(t,transfer);
  const rollbackToday=await todayCompletionPage(restored.context());
  assert.equal(await todayTask(rollbackToday.page).locator('.today-sub').textContent(),'12.75 pts');
  await todayDone(rollbackToday.page);
  await todayTask(rollbackToday.page).and(rollbackToday.page.locator('.is-done')).waitFor();
  await todayDone(rollbackToday.page);
  assert.equal(rollbackToday.alerts.length,0);
  const rewards=await canonicalCompletions(rollbackToday.page);
  assert.equal(rewards.length,2);
  assert.equal(rewards.find(row=>row.taskId==='t1')?.points,12.75);
  assert.deepEqual(rewards.filter(row=>row.taskId!=='t1'),unrelatedAward);
  await rollbackToday.page.reload();
  assert.deepEqual(await canonicalCompletions(rollbackToday.page),rewards);
});


const ownedRewards=[
  {id:'synthetic-owned-current',taskId:'t1',title:'Synthetic V2 reward',points:12.75,completedAtISO:quietDate+'T16:00:00Z',unknown:{keep:true}},
  {id:'synthetic-owned-negative',taskId:'t1',title:'Synthetic negative reward',points:-2.25,completedAtISO:'2026-11-18T02:00:00Z'},
  {id:'synthetic-owned-zero',taskId:'t1',title:'Synthetic zero reward',points:0,completedAtISO:'2026-11-17T02:00:00Z'}
];
const unrelatedRewardRows=[
  {id:'synthetic-unrelated-current',taskId:'t2',title:'Synthetic unrelated reward',points:3,completedAtISO:quietDate+'T16:00:00Z'}
];

async function seedScoringReads(t,context){
  const f=await prepareCompletionBoundary(t,context);
  const legacyRewards=[{...ownedRewards[0],points:5},...unrelatedRewardRows];
  await f.page.evaluate(async({marker,ownedRewards,legacyRewards,day})=>{
    const core=TaskPointsCore,snapshot=core.readTaskPointsStoredState();
    snapshot.completions=legacyRewards;
    snapshot.tasks.find(row=>row.id==='t1').recurrence={mode:'daily'};
    snapshot.scoringSettings={...snapshot.scoringSettings,inertia:{windowDays:7,multiplier:0}};
    snapshot.players.push({id:'SYN2',name:'Synthetic second player',baseline:50},{id:'SYN3',name:'Synthetic third player',baseline:50});
    snapshot.matchups.push({id:'synthetic-owned-matchup',date:day,dateKey:day,playerAId:'YOU',playerBId:'SYN',
      scoreA:8,scoreB:46,matchupType:'exhibition'});
    core.writeTaskPointsStoredState(snapshot);
    const fixture={id:crypto.randomUUID(),syntheticOnly:true,homeTaskId:'t1',completionRead:true,phase:'prepared'};
    localStorage.setItem('taskpoints_isolated_task_scoring_read_v1',fixture.id);
    localStorage.setItem(marker,JSON.stringify(fixture));
    await TaskPointsStateRuntimeV2.initializeIsolatedTaskOwner(snapshot,{completionSeed:ownedRewards});
    localStorage.setItem(marker,JSON.stringify({...fixture,phase:'sealed'}));
  },{marker,ownedRewards,legacyRewards,day:quietDate});
  await f.page.reload();await waitHome(f.page);
  return {...f,legacyRewards};
}

async function openScoringPage(context,file){
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('dialog',dialog=>dialog.dismiss());
  await page.clock.setFixedTime(new Date(quietDate+'T17:00:00Z'));
  await page.goto(origin+prefix+file);
  return page;
}

async function scoresFromCore(page){
  return page.evaluate(()=>{
    const core=TaskPointsCore,source=core.readTaskPointsStoredState();
    const totals=core.youDailyTotalsWithInertia(source);
    const current=core.buildDaySnapshot(core.todayKey(),source);
    return {totals,entries:current.items.map(row=>[row.id,row.points]),
      selectedLegacy:source.completions.find(row=>row.taskId==='t1')?.points};
  });
}

test('verified completion reads agree across real Home, Today, Game, and persisted matchups after Chromium restart',async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-verified-scores-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page,legacyRewards}=await seedScoringReads(t,context);
  const homeScore=await page.evaluate(async()=>{
    try {
      return {score:computeTodayPoints(),painted:document.getElementById('todayScoreIslandValue')?.textContent,
        receipt:await TaskPointsStateRuntimeV2.readIsolatedTaskScoring().then(read=>read.completions)};
    }catch(error){return {error:error.message,runtime:await TaskPointsStateRuntimeV2.readIsolatedTaskScoring().then(()=>true,e=>e.message)};}
  });
  assert.equal(homeScore.score,15.8,JSON.stringify(homeScore));
  await page.waitForFunction(()=>document.getElementById('todayScoreIslandValue')?.textContent==='15.8');
  assert.equal(await page.evaluate(()=>computeTodayPoints()),15.8);
  const before=await scoresFromCore(page);
  assert.equal(before.totals[quietDate],15.75);
  assert.equal(before.totals['2026-11-17'],-2.25);
  assert.equal(before.totals['2026-11-16'],0);
  assert.equal(before.selectedLegacy,5);
  assert.deepEqual(before.entries,[['synthetic-unrelated-current',3],['synthetic-owned-current',12.75]]);
  assert.deepEqual(await scoresFromCore(page),before,'repeated reads never add another reward');

  const today=await todayCompletionPage(context);
  const selected=todayTask(today.page);
  assert.equal(await selected.locator('.today-sub').textContent(),'12.75 pts');
  assert.match(await selected.getAttribute('class'),/is-done/);
  assert.deepEqual(await scoresFromCore(today.page),before);

  const game=await openScoringPage(context,'game.html');
  await game.locator('#playersList .playerCard').first().waitFor();
  assert.equal(await game.evaluate(()=>computeTodayPoints()),15.8);
  assert.deepEqual(await scoresFromCore(game),before);

  const matchups=await openScoringPage(context,'matchups.html');
  const scoringErrors=[];
  matchups.on('console',msg=>{if(['error','warning'].includes(msg.type()))scoringErrors.push(msg.text());});
  matchups.on('pageerror',error=>scoringErrors.push(error.message));
  const action=matchups.locator('#matchupsChronological').getByRole('button',{name:'Generate retro matchups'}).first();
  const header=action.locator('xpath=ancestor::section[1]').locator('.matchup-collapsible-header').first();
  if(await header.getAttribute('aria-expanded')==='false')await header.click();
  await action.click();
  await matchups.waitForFunction(()=>{
    const s=TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem(TaskPointsCore.STORAGE_KEY));
    return s.matchups.find(row=>row.id==='synthetic-owned-matchup')?.scoreA===15.75
      && s.matchups.find(row=>row.id==='synthetic-inbox-game')?.scoreB===-2.25;
  },null,{timeout:3500}).catch(async error=>{
    const evidence=await matchups.evaluate(()=>{
      const s=TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem(TaskPointsCore.STORAGE_KEY));
      return s.matchups.map(row=>[row.id,row.scoreA,row.scoreB]);
    });
    throw Error(JSON.stringify({scoringErrors,evidence}),{cause:error});
  });
  const persisted=await matchups.evaluate(()=>{
    const core=TaskPointsCore;
    return core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY)).completions;
  });
  assert.deepEqual(persisted,legacyRewards,'V1 retains its original completion rows');

  await context.close();context=await launch();await configureContext(context);
  const reopened=await openScoringPage(context,'index.html');
  await waitHome(reopened);
  const afterRestart=await reopened.evaluate(async()=>{
    try {return {score:computeTodayPoints(),painted:document.getElementById('todayScoreIslandValue')?.textContent};}
    catch(error){
      const {meta,sourceDrift}=await TaskPointsStateRuntimeV2.readIsolatedOwnedTasks();
      const core=TaskPointsCore,current=core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY));
      return {error:error.message,sourceDrift,seed:meta.homeTaskEvidence,
        current:{task:current.tasks.find(row=>row.id==='t1'),linked:current.completions.filter(row=>row.taskId==='t1'),
          journal:core.readPendingTaskMutations(),generation:localStorage.getItem('taskpoints_state_v2_generation_v1')}};
    }
  });
  assert.equal(afterRestart.score,15.8,JSON.stringify(afterRestart));
  assert.deepEqual(await scoresFromCore(reopened),before);
  await reopened.locator('a.desktop-header-notes-link').click();
  await reopened.waitForURL('**/notes.html');
  await reopened.getByRole('link',{name:'Main',exact:true}).first().click();
  await waitHome(reopened);
  assert.equal(await reopened.evaluate(()=>computeTodayPoints()),15.8);
  assert.deepEqual(await scoresFromCore(reopened),before);
  assert.deepEqual((await backingTask(reopened)).recurrence,{mode:'daily'});
  await assert.rejects(reopened.evaluate(()=>TaskPointsStateRuntimeV2.prepareIsolatedTaskRollback(0)),
    /isolated_completion_checkpoint_requires_verified_transfer/);
});

test('verified scoring reads preserve unrelated journal edits through compaction and maintenance',async t=>{
  const {page}=await seedScoringReads(t);
  const v2=await owned(page);
  await page.evaluate(()=>{
    const core=TaskPointsCore;
    core.journalTaskMutation({completionUpsert:{id:'synthetic-unrelated-extra',taskId:'t2',
      title:'Synthetic extra reward',points:1.25,completedAtISO:TaskPointsCore.todayKey()+'T17:00:00Z'}});
  });
  assert.equal((await scoresFromCore(page)).totals[quietDate],17);
  await page.evaluate(async()=>{
    if(!TaskPointsCore.flushPendingTaskMutations())throw Error('Expected unrelated journal compaction');
    TaskPointsCore.queuePhase5CVerifiedSecondaryWrite();
    await TaskPointsCore.flushPhase5CVerifiedSecondaryWrites();
  });
  await page.reload();await waitHome(page);
  assert.equal((await scoresFromCore(page)).totals[quietDate],17);
  assert.deepEqual(await owned(page),v2);
});

for(const fault of ['missing completion','corrupt completion','missing receipt','missing ownership','competing legacy edit','malformed journal','interrupted read','recovery hold']){
  test(`verified scoring refuses persisted matchup writes after ${fault}`,async t=>{
    const {page,context}=await seedScoringReads(t);
    const matchups=await openScoringPage(context,'matchups.html');
    const action=matchups.locator('#matchupsChronological').getByRole('button',{name:'Generate retro matchups'}).first();
    await action.waitFor();
    if(fault==='missing receipt'){
      await openTaskEdit(page);await pointsField(page).fill('19');
      assert.equal((await submitTaskEdit(page)).points,19);
    }
    await matchups.evaluate(async ({fault,marker})=>{
      if(fault==='missing ownership'){
        localStorage.removeItem(marker);
        return;
      }
      if(fault==='competing legacy edit'){
        TaskPointsCore.journalTaskUpdates(['t1'],row=>{row.points=77;return true;});
        return;
      }
      if(fault==='malformed journal'){
        localStorage.setItem('taskpoints_pending_task_mutations_v1','{synthetic corrupt journal');
        return;
      }
      if(fault==='recovery hold'){
        localStorage.setItem('taskpoints_recovery_write_lock_v1','{synthetic recovery evidence');
        return;
      }
      if(fault==='interrupted read'){
        const transaction=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(names,mode,...args){
          if(this.name==='taskpoints_state_v2'&&mode==='readonly'&&names.includes('completions'))
            throw new DOMException('synthetic interrupted read','AbortError');
          return transaction.call(this,names,mode,...args);
        };
        return;
      }
      await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_state_v2');
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{
          const db=request.result;
          const storeName=fault==='missing receipt'?'mutations':'completions';
          const tx=db.transaction(storeName,'readwrite'),store=tx.objectStore(storeName);
          if(fault==='missing receipt') store.clear();
          else if(fault==='missing completion') store.delete('isolated-score:synthetic-owned-current');
          else {
            const row=store.get('isolated-score:synthetic-owned-current');
            row.onsuccess=()=>store.put({...row.result,value:{...row.result.value,points:500}});
          }
          tx.oncomplete=()=>{db.close();resolve();};
          tx.onabort=()=>{db.close();reject(tx.error);};
        };
      });
    },{fault,marker});
    const before=await completionWriteEvidence(matchups);
    await action.dispatchEvent('click');
    // Join the real control's fresh read before checking the durable bytes.
    assert.equal(await matchups.evaluate(()=>TaskPointsCore.refreshIsolatedTaskScoring()),false);
    assert.deepEqual(await completionWriteEvidence(matchups),before);
    await assert.rejects(matchups.evaluate(()=>{
      const core=TaskPointsCore,source=core.readTaskPointsStoredState();
      return core.buildDaySnapshot(core.todayKey(),source);
    }),/Verified Task completions are unavailable/);
    const rejected=await matchups.evaluate(()=>{
      const core=TaskPointsCore,source=core.readTaskPointsStoredState();
      source.matchups[0].scoreB=9000;
      try {core.writeTaskPointsStoredState(source);return '';}
      catch(error){return error.message;}
    });
    assert.match(rejected,/freshly verified Task completions/);
    assert.deepEqual(await completionWriteEvidence(matchups),before);
  });
}

const todayKey='taskpoints_today_view_v1';
const seededTodayList={
  version:1,unknownRoot:{bytes:[0,255],label:'Synthetic Today metadata'},
  tasksByDay:{
    [quietDate]:['t2','t1','t1'],
    '2026-11-17':['t1','historical-other'],
    '2026-11-16':['t1'],
    '2026-11-15':['t1','unaffected']
  },
  orderByDay:{
    [quietDate]:['note:n1','future:opaque','task:t1','habit:h1','task:t2','task:t1'],
    '2026-11-17':['task:t1','task:historical-other'],
    '2026-11-16':['task:t1'],
    '2026-11-15':['task:t1','task:unaffected']
  },
  notesByDay:{[quietDate]:[{id:'n1',text:'Synthetic preserved note',done:false,unknown:{keep:true}}]},
  selectedHabitIdsByDay:{[quietDate]:['h1']},
  dayKey:'2026-11-17',taskIds:['t1','historical-other'],order:['task:t1','note:older']
};
const cleanedTodayList=structuredClone(seededTodayList);
for(const day of [quietDate,'2026-11-17','2026-11-16']){
  cleanedTodayList.tasksByDay[day]=cleanedTodayList.tasksByDay[day].filter(id=>id!=='t1');
  cleanedTodayList.orderByDay[day]=cleanedTodayList.orderByDay[day].filter(key=>key!=='task:t1');
}
cleanedTodayList.taskIds=['historical-other'];
cleanedTodayList.order=['note:older'];

const todayBytes=page=>page.evaluate(key=>localStorage.getItem(key),todayKey);
const writeTodayFixture=(page,raw)=>page.evaluate(({key,raw})=>localStorage.setItem(key,raw),{key:todayKey,raw});

async function waitTodayBytes(page,expected){
  await page.waitForFunction(({key,expected})=>localStorage.getItem(key)===expected,
    {key:todayKey,expected});
}

async function assertCheckedOwnedTask(page){
  const item=todayTask(page).and(page.locator('.is-done'));
  await item.waitFor();
  assert.equal(await item.locator('.today-sub').textContent(),'12.75 pts');
}

test('verified Today cleanup preserves current and historical days, ordering and unrelated data across navigation and legacy replay',async t=>{
  const {page,context}=await seedScoringReads(t);
  const v2=await owned(page);
  const original=JSON.stringify(seededTodayList),cleaned=JSON.stringify(cleanedTodayList);
  await page.evaluate(key=>new Promise(resolve=>{
    navigator.locks.request(key,()=>new Promise(release=>{window.releaseTodayLock=release;resolve();}));
  }),todayKey);
  await writeTodayFixture(page,original);
  const today=await todayCompletionPage(context);
  await assertCheckedOwnedTask(today.page);
  assert.equal(await todayBytes(today.page),original,'checked before cleanup can acquire the lock');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.evaluate(()=>window.releaseTodayLock());
  await waitTodayBytes(today.page,cleaned);
  assert.equal(await today.page.evaluate(()=>TaskPointsCore.reconcileIsolatedTodayList()),false,'replay is a no-op');
  assert.deepEqual(await owned(page),v2);

  await today.page.reload();
  await assertCheckedOwnedTask(today.page);
  assert.equal(await todayBytes(today.page),cleaned);
  // Simulate an old list snapshot restoring membership. The current Today
  // reader keeps the authoritative check and replays the targeted cleanup.
  await writeTodayFixture(page,original);
  await waitTodayBytes(today.page,cleaned);
  await assertCheckedOwnedTask(today.page);
  await today.page.getByRole('link',{name:'Main',exact:true}).first().click();
  await waitHome(today.page);
  assert.equal(await todayBytes(today.page),cleaned);
});

test('competing Today tabs rebase real note additions and refuse an obsolete order edit',async t=>{
  const {page,context}=await seedScoringReads(t);
  await writeTodayFixture(page,JSON.stringify(seededTodayList));
  const left=await todayCompletionPage(context),right=await todayCompletionPage(context);
  const clean=JSON.stringify(cleanedTodayList);
  await waitTodayBytes(left.page,clean);
  await waitTodayBytes(right.page,clean);
  await left.page.locator('#noteInput').fill('Synthetic note from left');
  await right.page.locator('#noteInput').fill('Synthetic note from right');
  await Promise.all([left.page.locator('#addNoteBtn').click(),right.page.locator('#addNoteBtn').click()]);
  await right.page.waitForFunction(({day,key})=>JSON.parse(localStorage.getItem(key)).notesByDay[day].length===3,
    {day:quietDate,key:todayKey});
  const raw=await todayBytes(right.page),actual=JSON.parse(raw);
  const newNotes=actual.notesByDay[quietDate].slice(1);
  assert.deepEqual(newNotes.map(note=>note.text).sort(),['Synthetic note from left','Synthetic note from right']);
  for(const note of newNotes)assert.ok(actual.orderByDay[quietDate].includes('note:'+note.id));
  actual.notesByDay[quietDate]=actual.notesByDay[quietDate].slice(0,1);
  actual.orderByDay[quietDate]=actual.orderByDay[quietDate].filter(key=>!newNotes.some(note=>key==='note:'+note.id));
  assert.deepEqual(actual,cleanedTodayList);
  await assert.rejects(left.page.evaluate(expected=>TaskPointsCore.reconcileIsolatedTodayList(db=>{
    db.orderByDay[TaskPointsCore.todayKey()]=[];
  },expected),clean),/Today list changed while editing/);
  assert.equal(await todayBytes(right.page),raw);
  await assertCheckedOwnedTask(right.page);
  await right.page.locator('#clearDoneBtn').click();
  await todayTask(right.page).waitFor({state:'hidden'});
  const dismissed=JSON.parse(await todayBytes(right.page));
  assert.equal(dismissed.verifiedCompletionDismissalsByDay[quietDate],'synthetic-owned-current');
  assert.deepEqual(dismissed.tasksByDay,{...cleanedTodayList.tasksByDay,[quietDate]:[]});
  assert.deepEqual(dismissed.orderByDay[quietDate],
    JSON.parse(raw).orderByDay[quietDate].filter(key=>key!=='task:t2'));
  assert.deepEqual(dismissed.notesByDay[quietDate].slice(1),newNotes);
  await right.page.reload();
  await right.page.locator('#todayList').getByText('Synthetic preserved note').waitFor();
  assert.equal(await todayTask(right.page).count(),0);
  assert.equal((await scoresFromCore(right.page)).totals[quietDate],15.75);
});

for(const phase of ['before','after'])test(`verified Today cleanup resumes after Chromium restart ${phase} the localStorage update`,async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tp-today-reconcile-'));
  const launch=()=>chromium.launchPersistentContext(profile,{
    executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium',serviceWorkers:'block',timezoneId:'America/New_York'
  });
  let context=await launch();
  t.after(async()=>{await context.close();fs.rmSync(profile,{recursive:true,force:true});});
  const {page}=await seedScoringReads(t,context);
  const original=JSON.stringify(seededTodayList),cleaned=JSON.stringify(cleanedTodayList);
  await writeTodayFixture(page,original);
  await context.addInitScript(({key,phase})=>{
    if(!location.pathname.endsWith('/today.html'))return;
    const set=Storage.prototype.setItem;
    Storage.prototype.setItem=function(name,value){
      if(this===localStorage&&name===key&&!window.todayInterrupted){
        if(phase==='after')set.call(this,name,value);
        window.todayInterrupted=true;
        throw new DOMException('Synthetic interruption around Today write','AbortError');
      }
      return set.call(this,name,value);
    };
  },{key:todayKey,phase});
  const interrupted=await todayCompletionPage(context);
  await interrupted.page.waitForFunction(()=>window.todayInterrupted===true);
  await assertCheckedOwnedTask(interrupted.page);
  assert.equal(await todayBytes(interrupted.page),phase==='before'?original:cleaned);
  await context.close();
  context=await launch();
  await configureContext(context);
  const restored=await todayCompletionPage(context);
  await waitTodayBytes(restored.page,cleaned);
  await assertCheckedOwnedTask(restored.page);
  assert.equal(await restored.page.evaluate(()=>TaskPointsCore.reconcileIsolatedTodayList()),false);
});

test('verified Today cleanup preserves malformed bytes while rendering the verified completion',async t=>{
  const {page,context}=await seedScoringReads(t);
  for(const malformed of ['{truncated Today list','{"version":1,"tasksByDay":{"2026-11-18":{"invalid":true}}}']){
    await writeTodayFixture(page,malformed);
    const today=await todayCompletionPage(context);
    await assertCheckedOwnedTask(today.page);
    await today.page.locator('#noteInput').fill('Keep this unsaved text');
    await today.page.locator('#addNoteBtn').click();
    await today.page.waitForFunction(()=>document.getElementById('noteInput')?.value==='Keep this unsaved text');
    await assert.rejects(today.page.evaluate(()=>TaskPointsCore.reconcileIsolatedTodayList()));
    assert.equal(await todayBytes(today.page),malformed);
    assert.equal(await today.page.locator('#noteInput').inputValue(),'Keep this unsaved text');
    await today.page.close();
  }
});
