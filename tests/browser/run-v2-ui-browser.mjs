import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, join, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

// The real TaskPoints Home HTML and JS run on a disposable localhost origin.
// The script is a focused local equivalent of _worker.js's scoring bundle;
// it does not contact the deployed app, GitHub, or any external API.
const engine=process.env.V2_BROWSER_ENGINE||'chromium';
if(!['chromium','webkit'].includes(engine))throw Error('Unsupported V2 Home browser engine: '+engine);
const root=resolve(process.cwd()), artifacts=join(root,'v2-ui-browser-artifacts',engine);
await mkdir(artifacts,{recursive:true});
const bundlePaths=[
  'performance_diagnostics.js','scoring_core.js',
  'phase2_dual_write.js','phase2_reset_hook.js',
  'phase3_read_path.js','phase3_session_codec.js','phase3_navigation_cache.js',
  'phase3_status_cache_guard.js','phase4_storage_coordinator.js',
  'phase4_primary_read_path.js','indexeddb_requalification_guard.js',
  'phase4_cache_guard.js','phase4_diagnostics.js',
  'phase5a_native_snapshot.js','phase5b_deferred_mirror.js',
  'home_yesterday_result_consistency.js',
  'score_alias_consistency.js','you_score_alias_alignment.js',
  'habit_completion_source_guard.js','habit_fast_path_control.js',
  'state_runtime_v2_generation.js','state_runtime_v2_wal.js',
  'state_runtime_v2.js','state_runtime_v2_wal_bridge.js',
  'state_runtime_v2_habit_edit_bridge.js','state_runtime_v2_habit_structure_bridge.js',
  'save_pipeline_shared_work.js','inbox_count_badge.js',
  'season_series_upset_notifications.js','task_mutation_journal.js',
  'task_create_fast_path.js','state_hot_cache.js',
  'storage_maintenance_idle.js','greed_gold_economy.js',
  'gold_theft_top50_notifications.js','season_bracket_builder_core.js',
  'season_bracket_builder_fixes.js','season3_tournament_rollover.js'
];
const bundle=(await Promise.all(bundlePaths.map(async name =>
  '\n;\n/* v2-ui: '+name+' */\n'+await readFile(join(root,name),'utf8')))).join('\n');
const server=createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://127.0.0.1');
    const pathname=decodeURIComponent(u.pathname);
    const path=resolve(root,'.'+pathname);
    if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css',
      '.svg':'image/svg+xml','.png':'image/png','.json':'application/json'}[extname(path)];
    if(!mime){res.writeHead(403);res.end();return;}
    const isHomeCore=pathname==='/scoring_core.js' && /(?:^|\/)index\.html/.test(req.headers.referer||'');
    const content=isHomeCore?bundle:await readFile(path);
    res.writeHead(200,{'Content-Type':(isHomeCore?'text/javascript':mime),'Cache-Control':'no-store'});
    res.end(content);
  }catch(error){res.writeHead(404);res.end(String(error));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true});
console.log('V2 Home UI browser engine: '+engine+' (390x844 touch emulation)');
const records=[];let failures=0;
async function makeContext(){
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    serviceWorkers:'block'});
  await ctx.route('**/*',route=>
    new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await ctx.addInitScript(()=>{
    if(location.hostname!=='127.0.0.1'||!location.pathname.endsWith('/index.html'))return;
    sessionStorage.setItem('tpBootSeenThisSession','1');
    localStorage.setItem('taskpoints_state_v2_dark_mode_v1','1');
    if(localStorage.getItem('v2_synthetic_ui_seed')==='1')return;
    const habits=['h1','h2','h3'].map((id,index)=>({
      id,name:'Synthetic UI Habit '+(index+1),category:'habit',order:index+1,
      pointsPerDay:3+index,daysPerCompleteWeek:3,
      doneKeys:[],failedKeys:[],iceKeys:[],
      halfPointEnabled:true,updatedAtISO:'2026-10-20T12:00:00.000Z'
    }));
    localStorage.setItem('taskpoints_v1',JSON.stringify({
      habits,completions:[],tasks:[],reminders:[],players:[],
      gameHistory:[],matchups:[],schedule:[],opponentDripSchedules:[],flexActions:[],
      notes:'SYNTHETIC UI DATA',scoringSettings:{},habitTagColors:{}
    }));
    // Real Home uses both the state snapshot and a separate Notes cache.
    // A consistent synthetic backup must initialize both, or first-load
    // Notes reconciliation can legitimately select an empty cache.
    localStorage.setItem('taskpoints_notes_v1','SYNTHETIC UI DATA');
    localStorage.setItem('v2_synthetic_ui_seed','1');
  });
  return ctx;
}
async function home(context){
  const page=await context.newPage();
  const pageErrors=[],consoleErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('console',msg=>{
    if(msg.type()==='error'){
      consoleErrors.push(msg.text());
      console.warn('HOME CONSOLE '+msg.text().slice(0,250));
    }
  });
  await page.goto(origin+'/index.html?perf=1',{waitUntil:'load'});
  await page.waitForFunction(()=>typeof window.renderHabits==='function'
    && Boolean(window.TaskPointsCore?.writePendingHabitDelta),null,{timeout:20000});
  await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay[data-habit][data-day]').length>=21,
    null,{timeout:20000});
  const status=await page.evaluate(()=>({
    cards:document.querySelectorAll('#habitsList .habitRow').length,
    names:[...document.querySelectorAll('#habitsList [data-habit-row-id]')].map(n=>n.dataset.habitRowId),
    v2:Boolean(window.TaskPointsStateRuntimeV2?.getStatus?.()?.installed),
    dark:window.TaskPointsStateRuntimeV2?.getStatus?.()?.darkEnabled,
    readAuthority:window.TaskPointsStateRuntimeV2?.getStatus?.()?.readAuthority,
    notes:window.TaskPointsCore.readTaskPointsStoredState()?.notes
  }));
  assert.equal(status.v2,true,'V2 runtime must load in the actual Home bundle');
  assert.equal(status.dark,true,'V2 preview must be enabled only for this synthetic context');
  assert.equal(status.readAuthority,'legacy_only');
  assert.equal(status.notes,'SYNTHETIC UI DATA');
  // This is the real Home bundle, not the isolated fixture. Ensure its
  // preview mirror is seeded before inspecting actual UI mutation parity.
  await page.evaluate(() => window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
  assert.equal(consoleErrors.some(s=>s.includes('renderStats error')),false,
    'Home should not throw from a missing scoreboard helper');
  return {page,pageErrors,consoleErrors,status};
}
async function test(name,fn){
  const ctx=await makeContext();
  try{
    const result=await fn(ctx);
    records.push({name,result:'PASS',detail:result});
    console.log('PASS '+name+' '+JSON.stringify(result||{}));
  }catch(err){
    failures++;
    records.push({name,result:'FAIL',error:String(err.stack||err)});
    console.error('FAIL '+name+' '+String(err.stack||err));
    for(let i=0;i<ctx.pages().length;i++){
      const p=ctx.pages()[i];
      try{
        const diag=await p.evaluate(()=>({
          ready:document.readyState,
          habits:document.querySelectorAll('#habitsList .habitDay').length,
          tab:document.querySelector('[data-home-tab].is-active')?.getAttribute('data-home-tab'),
          runtime:window.TaskPointsStateRuntimeV2?.getStatus?.(),
          bridge:window.TaskPointsStateRuntimeV2WalBridge?.getStatus?.(),
          journal:window.TaskPointsCore?.readPendingHabitDeltas?.(),
          taskJournal:window.TaskPointsCore?.readPendingTaskMutations?.()?.record?.tasks
            ?.map(t=>({id:t.id,title:t.title,status:t.status,points:t.points})),
          liveTasks:(typeof state!=='undefined'?state.tasks:[])?.map(t=>({
            id:t.id,title:t.title,status:t.status,points:t.points
          })),
          rawTasks:window.TaskPointsCore?.readTaskPointsStoredState?.()?.tasks?.map(t=>({
            id:t.id,title:t.title,status:t.status,points:t.points
          })),
          liveMetrics:(typeof state!=='undefined'?state.completions:[])
            .filter(c=>c.source==='metric').map(c=>({title:c.title,notes:c.moodNotes})),
          rawMetrics:window.TaskPointsCore?.readTaskPointsStoredState?.()?.completions
            ?.filter(c=>c.source==='metric').map(c=>({title:c.title,notes:c.moodNotes})),
          moodModal:document.querySelector('#moodEditModal')?.className
        }));
        await writeFile(join(artifacts,'failed-'+records.length+'-'+i+'.json'),JSON.stringify(diag,null,2));
        console.error('UI DIAGNOSTICS '+JSON.stringify(diag).slice(0,2500));
        console.error('UI STORAGE DIAGNOSTICS '+JSON.stringify({
          liveTasks:diag.liveTasks,taskJournal:diag.taskJournal,rawTasks:diag.rawTasks,
          liveMetrics:diag.liveMetrics,rawMetrics:diag.rawMetrics,
          journal:diag.journal,habitGuard:diag.runtime?.externalRevisionInvalidated,
          modal:diag.moodModal
        }).slice(0,7000));
      }catch(e){console.error('UI diag '+String(e));}
      try{await p.screenshot({path:join(artifacts,'failure-'+records.length+'-'+i+'.png')});}catch{}
    }
  }finally{await ctx.close();}
}
try{
  await test('actual Home paints three synthetic Habits and keeps V1 authority',async ctx=>{
    const {page,status,pageErrors,consoleErrors}=await home(ctx);
    assert.equal(status.cards,3);
    assert.equal(status.names.length,3);
    assert.equal(pageErrors.length,0,'no uncaught Home startup errors');
    assert.equal(consoleErrors.some(s=>s.includes('renderStats error')),false);
    const p=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.checked,true);
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {cards:status.cards,readAuthority:status.readAuthority,parity:p.match};
  });
  await test('Home Habit bubble touch writes one durable journal entry and survives reload',async ctx=>{
    const {page}=await home(ctx);
    const chosen=await page.evaluate(()=>{
      const el=document.querySelector('#habitsList .habitDay[data-habit="h1"]');
      return {id:el?.dataset.habit,day:el?.dataset.day};
    });
    assert.equal(chosen.id,'h1');
    await page.locator('[data-home-tab="habits"]').click({force:true});
    await page.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+chosen.day+'"]').tap({force:true});
    await page.waitForFunction(([id,day])=>
      window.TaskPointsCore.readPendingHabitDeltas().some(d=>d.habitId===id && d.dayKey===day),
      [chosen.id,chosen.day],{timeout:10000});
    const before=await page.evaluate(([id,day])=>{
      const d=window.TaskPointsCore.readPendingHabitDeltas().find(d=>d.habitId===id&&d.dayKey===day);
      return {status:d?.status,source:d?.source};
    },[chosen.id,chosen.day]);
    assert.equal(before.status,'full');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelector('#habitsList .habitDay[data-habit="h1"]'));
    const persisted=await page.evaluate(([id,day])=>{
      const saved=window.TaskPointsCore.readTaskPointsStoredState();
      const pending=window.TaskPointsCore.readPendingHabitDeltas();
      const h=saved.habits.find(x=>x.id===id);
      const delta=pending.find(d=>d.habitId===id&&d.dayKey===day);
      return {done:(h.doneKeys||[]).includes(day),pending:delta?.status,
        v2:window.TaskPointsStateRuntimeV2?.getStatus?.()?.readAuthority};
    },[chosen.id,chosen.day]);
    assert.ok(persisted.done||persisted.pending==='full','tap must survive reload in V1 authority');
    assert.equal(persisted.v2,'legacy_only');
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const parity=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(parity.checked,true);
    assert.equal(parity.match,true,JSON.stringify(parity.differences));
    return {day:chosen.day,detectedBefore:before.status,retainedAfter:persisted,parity:parity.match};
  });

  await test('actual Habit touch cycles full to half to off with matching V1 and V2 state',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="habits"]').click({force:true});
    const day=await page.locator('#habitsList .habitDay[data-habit="h2"]').first().getAttribute('data-day');
    assert.ok(day);
    const bubble=()=>page.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]');
    const observed=[];
    for(const expected of ['full','half','off']){
      await bubble().tap({force:true});
      await page.waitForFunction(([key,value])=>
        window.TaskPointsCore.readPendingHabitDeltas()
          .some(d=>d.habitId==='h2'&&d.dayKey===key&&d.status===value),
        [day,expected],{timeout:12000});
      observed.push(await page.evaluate(key=>{
        const el=document.querySelector('#habitsList .habitDay[data-habit="h2"][data-day="'+key+'"]');
        const entry=window.TaskPointsCore.readPendingHabitDeltas().find(d=>d.habitId==='h2'&&d.dayKey===key);
        return {classList:el?.className,status:entry?.status};
      },day));
    }
    assert.deepEqual(observed.map(v=>v.status),['full','half','off']);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const result=await page.evaluate(key=>{
      const core=window.TaskPointsCore;
      const source=core.readTaskPointsStoredState();
      const overlay=core.readPendingHabitDeltas();
      const p=source.habits.find(h=>h.id==='h2');
      return {done:p.doneKeys.includes(key),pilotCompletion:source.completions
        .some(c=>c.habitId==='h2'&&c.dayKey===key),
        journal:overlay.find(d=>d.habitId==='h2'&&d.dayKey===key)?.status};
    },day);
    assert.equal(result.done,false);
    assert.equal(result.pilotCompletion,false);
    assert.ok(result.journal==null||result.journal==='off');
    const parity=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(parity.match,true,JSON.stringify(parity.differences));
    return {day,statuses:observed.map(v=>v.status),final:result,parity:parity.match};
  });


  await test('two actual Home tabs preserve Habit touches when the inactive tab refreshes before editing',async ctx=>{
    const first=(await home(ctx)).page;
    const second=(await home(ctx)).page;
    await first.locator('[data-home-tab="habits"]').click({force:true});
    const day=await first.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    assert.ok(day);
    // Only one tab is visible to a real person at a time. True simultaneous
    // writes are covered by the separate 18-scenario storage stress suite.
    await first.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+day+'"]').tap({force:true});
    await first.waitForFunction(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(d=>d.habitId==='h1'&&d.dayKey===key),day);
    // A tab opened before another tab's write may have stale Home data.
    // Refresh that tab *before* interacting so its optimistic UI and storage
    // authority agree. The separate synthetic storage suite validates
    // same-time writes without a UI reload.
    await second.reload({waitUntil:'load'});
    await second.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    await second.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await second.locator('[data-home-tab="habits"]').click({force:true});
    await second.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]').tap({force:true});
    await second.waitForFunction(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(d=>d.habitId==='h2'&&d.dayKey===key),day);
    const fromSecond=await second.evaluate(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .filter(d=>d.dayKey===key&&['h1','h2'].includes(d.habitId))
      .map(d=>d.habitId).sort(),day);
    assert.deepEqual(fromSecond,['h1','h2'],'both sequential Home touches must remain durable');
    await second.close();
    await first.reload({waitUntil:'load'});
    await first.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    await first.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const result=await first.evaluate(key=>{
      const core=window.TaskPointsCore;
      const baseline=core.readTaskPointsStoredState();
      const effective=structuredClone(baseline);
      core.applyPendingHabitDeltas(effective);
      return {done:effective.habits.filter(h=>['h1','h2'].includes(h.id)&&h.doneKeys.includes(key)).map(h=>h.id).sort(),
        journal:core.readPendingHabitDeltas().filter(d=>d.dayKey===key).map(d=>d.habitId).sort(),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    },day);
    assert.deepEqual(result.done,['h1','h2']);
    assert.equal(result.authority,'legacy_only');
    const p=await first.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {day,touched:result.done,durableJournal:result.journal,parity:p.match};
  });


  await test('Home survives simulated iPhone background pagehide and foreground resume between two Habit touches',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="habits"]').click({force:true});
    const day=await page.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    assert.ok(day);
    const touch=async habitId=>{
      await page.locator('#habitsList .habitDay[data-habit="'+habitId+'"][data-day="'+day+'"]')
        .tap({force:true});
      await page.waitForFunction(([id,key])=>{
        const core=window.TaskPointsCore;
        const pending=core.readPendingHabitDeltas();
        if(pending.some(d=>d.habitId===id&&d.dayKey===key&&d.status==='full'))return true;
        const source=core.readTaskPointsStoredState();
        return source.habits.some(h=>h.id===id&&h.doneKeys?.includes(key));
      },[habitId,day],{timeout:16000});
      await page.waitForFunction(()=>window.TaskPointsStateRuntimeV2Wal?.getStatus?.()?.pendingCount===0,
        null,{timeout:20000});
    };
    await touch('h1');
    // Headless WebKit may not report native hidden visibility. Creating a
    // second foreground page and dispatching lifecycle events separately
    // exercises both the browser tab handoff and Home's pagehide listeners.
    const foreground=await ctx.newPage();
    await foreground.goto('about:blank');
    const suspended=await page.evaluate(()=>{
      const visibility=document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      return {visibility,authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority,
        generation:window.TaskPointsStateRuntimeV2.getStatus().currentGeneration};
    });
    await page.bringToFront();
    await page.evaluate(()=>{
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await foreground.close();
    assert.equal(suspended.authority,'legacy_only');
    await page.locator('[data-home-tab="habits"]').click({force:true});
    await touch('h2');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const proof=await page.evaluate(async key=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const core=window.TaskPointsCore;
      const effective=structuredClone(core.readTaskPointsStoredState());
      core.applyPendingHabitDeltas(effective);
      const db=await runtime.open();
      const request=db.transaction('mutations','readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {days:effective.habits.filter(h=>['h1','h2'].includes(h.id)&&h.doneKeys.includes(key))
        .map(h=>h.id).sort(),mutationIds:mutations.map(m=>m.id),
        authority:runtime.getStatus().readAuthority,
        generation:runtime.getStatus().currentGeneration};
    },day);
    assert.deepEqual(proof.days,['h1','h2']);
    assert.equal(new Set(proof.mutationIds).size,proof.mutationIds.length);
    assert.ok(proof.mutationIds.length>=2,'both independent Habit taps must be in the V2 ledger');
    assert.equal(proof.authority,'legacy_only');
    assert.equal(proof.generation,suspended.generation);
    const p=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {engine,day,backgroundVisibility:suspended.visibility,
      resumedTouchPreserved:true,ledgerRows:proof.mutationIds.length,
      generationUnchanged:true,parity:true};
  });

  await test('stale Home tab safely reloads and replays the intercepted Habit tap exactly once',async ctx=>{
    const first=(await home(ctx)).page;
    const stale=(await home(ctx)).page;
    await first.locator('[data-home-tab="habits"]').click({force:true});
    await stale.locator('[data-home-tab="habits"]').click({force:true});
    const day=await first.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    assert.ok(day);
    await first.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+day+'"]').tap({force:true});
    await first.waitForFunction(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(d=>d.habitId==='h1'&&d.dayKey===key),day);
    await stale.waitForFunction(()=>window.TaskPointsStateRuntimeV2?.getStatus?.()?.externalRevisionInvalidated===true,
      null,{timeout:12000});
    // The second bubble is stale. Its guard must reload before applying it,
    // while keeping the user's intended tap for exactly one fresh replay.
    await stale.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]').tap({force:true});
    await stale.waitForFunction(key=>window.TaskPointsCore?.readPendingHabitDeltas?.()
      .some(d=>d.habitId==='h2'&&d.dayKey===key),day,{timeout:20000});
    const evidence=await stale.evaluate(key=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      const h2=pending.filter(d=>d.habitId==='h2'&&d.dayKey===key);
      const control=window.TaskPointsHabitFastPathControl?.getStatus?.();
      return {h1:pending.some(d=>d.habitId==='h1'&&d.dayKey===key),
        h2Count:h2.length,h2Status:h2[0]?.status,
        replays:control?.staleTapReplays,
        pending:control?.pendingStaleTap,
        generation:window.TaskPointsStateRuntimeV2.getStatus().currentGeneration};
    },day);
    assert.equal(evidence.h1,true);
    assert.equal(evidence.h2Count,1,'stale user tap must execute once, never twice');
    assert.equal(evidence.h2Status,'full');
    assert.equal(evidence.replays,1);
    assert.equal(evidence.pending,false);
    await stale.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const parity=await stale.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(parity.match,true,JSON.stringify(parity.differences));
    return {replayedExactlyOnce:true,journalPreserved:true,parity:parity.match};
  });

  await test('backgrounded Home tab refreshes imported generation before replaying its first Habit touch',async ctx=>{
    const sleeping=(await home(ctx)).page;
    const replacing=(await home(ctx)).page;
    await sleeping.locator('[data-home-tab="habits"]').click({force:true});
    const day=await sleeping.locator('#habitsList .habitDay[data-habit="h2"]').first().getAttribute('data-day');
    assert.ok(day);
    const original=await sleeping.evaluate(()=>({
      generation:window.TaskPointsStateRuntimeV2.getStatus().currentGeneration,
      invalidated:window.TaskPointsStateRuntimeV2.getStatus().externalRevisionInvalidated
    }));
    assert.equal(original.invalidated,false);
    await replacing.bringToFront();
    await sleeping.evaluate(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    const imported=await replacing.evaluate(()=>{
      const core=window.TaskPointsCore;
      const source=core.readTaskPointsStoredState();
      const candidate=structuredClone(source);
      const importedHabit=candidate.habits.find(h=>h.id==='h1');
      importedHabit.name='Imported Generation h1';
      // V1 resolves Habit merges by updatedAtISO, so the synthetic import
      // must describe a newer Habit edit rather than a stale identical version.
      importedHabit.updatedAtISO=new Date(Date.now()+60000).toISOString();
      const result=core.saveValidatedSnapshot(candidate,{
        allowDestructiveOverwrite:true,source:'settings-import',immediateWrite:true});
      const persisted=core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY),{});
      return {blocked:result?.blocked===true,
        generation:window.TaskPointsStateRuntimeV2Generation.read(),
        persistedName:persisted.habits.find(h=>h.id==='h1')?.name,
        returnedName:result?.state?.habits?.find(h=>h.id==='h1')?.name};
    });
    assert.equal(imported.blocked,false);
    assert.notEqual(imported.generation,original.generation);
    assert.equal(imported.persistedName,'Imported Generation h1');
    await replacing.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await sleeping.bringToFront();
    await sleeping.evaluate(()=>{
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // A generation replacement need not publish a same-generation V2
    // revision signal. Even without that signal, an old page must reload
    // before handling the tap, so it never uses pre-import Home state.
    const observed=await sleeping.evaluate(()=>({
      generation:window.TaskPointsStateRuntimeV2Generation.read(),
      pageRuntimeGeneration:window.TaskPointsStateRuntimeV2.getStatus().currentGeneration,
      revisionInvalidated:window.TaskPointsStateRuntimeV2.getStatus().externalRevisionInvalidated,
      importedName:(()=>{const core=window.TaskPointsCore;
        return core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY),{})
          .habits.find(h=>h.id==='h1')?.name;})()
    }));
    assert.equal(observed.generation,imported.generation);
    assert.equal(observed.importedName,'Imported Generation h1');
    await sleeping.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]').tap({force:true});
    await sleeping.waitForFunction(key=>{
      const pending=window.TaskPointsCore?.readPendingHabitDeltas?.()||[];
      const ctl=window.TaskPointsHabitFastPathControl?.getStatus?.();
      return pending.some(row=>row.habitId==='h2'&&row.dayKey===key&&row.status==='full')
        && ctl?.staleTapReplays===1;
    },day,{timeout:24000});
    const proof=await sleeping.evaluate(async key=>{
      const core=window.TaskPointsCore;
      const runtime=window.TaskPointsStateRuntimeV2;
      await runtime.startCoordinatedDarkMirror();
      const pending=core.readPendingHabitDeltas();
      const p=await runtime.verifyParity();
      const db=await runtime.open();
      const request=db.transaction(['mutations','meta'],'readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {h2:pending.filter(row=>row.habitId==='h2'&&row.dayKey===key).map(row=>row.status),
        importedName:core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY),{})
          .habits.find(h=>h.id==='h1').name,
        generation:runtime.getStatus().currentGeneration,
        authority:runtime.getStatus().readAuthority,
        pendingTap:sessionStorage.getItem('taskpoints_v2_stale_habit_tap_v1'),
        replayCount:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays,
        mutationRows:mutations.length,distinctMutations:new Set(mutations.map(m=>m.id)).size,
        parity:p};
    },day);
    assert.deepEqual(proof.h2,['full']);
    assert.equal(proof.importedName,'Imported Generation h1');
    assert.equal(proof.generation,imported.generation);
    assert.equal(proof.authority,'legacy_only');
    assert.equal(proof.pendingTap,null);
    assert.equal(proof.replayCount,1);
    assert.equal(proof.mutationRows,1);
    assert.equal(proof.distinctMutations,1);
    assert.equal(proof.parity.match,true,JSON.stringify(proof.parity.differences));
    return {importGenerationTransition:true,firstResumedTouchReplayedExactlyOnce:true,
      importedNamePreserved:true,completionNotDuplicated:true,parity:true};
  });

  await test('suspended Home tab blocks unreadable generation before first post-import Habit tap',async ctx=>{
    const sleeping=(await home(ctx)).page;
    const importer=(await home(ctx)).page;
    await sleeping.locator('[data-home-tab="habits"]').click({force:true});
    const day=await sleeping.locator('#habitsList .habitDay[data-habit="h2"]').first().getAttribute('data-day');
    assert.ok(day);
    const oldGeneration=await sleeping.evaluate(
      ()=>window.TaskPointsStateRuntimeV2Generation.read());
    await importer.bringToFront();
    const replacement=await importer.evaluate(()=>{
      const core=window.TaskPointsCore;
      const candidate=structuredClone(core.readTaskPointsStoredState());
      const habit=candidate.habits.find(h=>h.id==='h1');
      habit.name='Generation Read Recovery Import';
      habit.updatedAtISO=new Date(Date.now()+60000).toISOString();
      const result=core.saveValidatedSnapshot(candidate,{
        allowDestructiveOverwrite:true,source:'settings-import',immediateWrite:true});
      return {blocked:result?.blocked===true,
        generation:window.TaskPointsStateRuntimeV2Generation.read(),
        name:core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY),{})
          .habits.find(h=>h.id==='h1')?.name};
    });
    assert.equal(replacement.blocked,false);
    assert.notEqual(replacement.generation,oldGeneration);
    assert.equal(replacement.name,'Generation Read Recovery Import');
    await importer.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await sleeping.bringToFront();

    await sleeping.evaluate(()=>{
      const original=Storage.prototype.getItem;
      window.__syntheticGenerationReadOriginal=original;
      Storage.prototype.getItem=function(key){
        if(this===localStorage && String(key)==='taskpoints_state_v2_generation_v1')
          throw new DOMException('Synthetic suspended generation access denied','SecurityError');
        return original.call(this,key);
      };
    });
    try{
      await sleeping.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]').tap({force:true});
      const denied=await sleeping.evaluate(day=>({
        safetyBlocks:window.TaskPointsStateRuntimeV2.getStatus().generationInteractionSafetyBlocks,
        readable:window.TaskPointsStateRuntimeV2.getStatus().generationReadable,
        journal:window.TaskPointsCore.readPendingHabitDeltas()
          .filter(d=>d.habitId==='h2'&&d.dayKey===day).length,
        replayCount:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays,
        pendingTap:sessionStorage.getItem('taskpoints_v2_stale_habit_tap_v1')
      }),day);
      assert.equal(denied.safetyBlocks,1,'unreadable generation must block the actual Home tap');
      assert.equal(denied.readable,false);
      assert.equal(denied.journal,0,'no V1 Habit mutation can cross an unknown generation');
      assert.equal(denied.replayCount,0);
      assert.equal(denied.pendingTap,null,'unknown epoch cannot stamp a replay continuation');
    }finally{
      await sleeping.evaluate(()=>{
        if(window.__syntheticGenerationReadOriginal){
          Storage.prototype.getItem=window.__syntheticGenerationReadOriginal;
          delete window.__syntheticGenerationReadOriginal;
        }
      });
    }

    await sleeping.locator('#habitsList .habitDay[data-habit="h2"][data-day="'+day+'"]').tap({force:true});
    await sleeping.waitForFunction(day=>{
      const pending=window.TaskPointsCore?.readPendingHabitDeltas?.()||[];
      const ctl=window.TaskPointsHabitFastPathControl?.getStatus?.();
      return pending.some(d=>d.habitId==='h2'&&d.dayKey===day&&d.status==='full')
        && ctl?.staleTapReplays===1;
    },day,{timeout:24000});
    const result=await sleeping.evaluate(async day=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      await runtime.startCoordinatedDarkMirror();
      const core=window.TaskPointsCore;
      return {generation:window.TaskPointsStateRuntimeV2Generation.read(),
        importedName:core.parseTaskPointsStorageJson(localStorage.getItem(core.STORAGE_KEY),{})
          .habits.find(h=>h.id==='h1')?.name,
        completions:core.readPendingHabitDeltas()
          .filter(d=>d.habitId==='h2'&&d.dayKey===day).map(d=>d.status),
        replayCount:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays,
        parity:await runtime.verifyParity(),
        readAuthority:runtime.getStatus().readAuthority};
    },day);
    assert.equal(result.generation,replacement.generation);
    assert.equal(result.importedName,'Generation Read Recovery Import');
    assert.deepEqual(result.completions,['full']);
    assert.equal(result.replayCount,1);
    assert.equal(result.parity.match,true,JSON.stringify(result.parity.differences));
    assert.equal(result.readAuthority,'legacy_only');
    return {unknownGenerationBlocked:true,noV1MutationDuringDenial:true,
      resumedPostImportTapReplayedExactlyOnce:true,importedDataRetained:true,parity:true};
  });

  await test('Home never replays a queued Habit tap until session deletion is verified',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="habits"]').click({force:true});
    const day=await page.locator('#habitsList .habitDay[data-habit="h2"]').first().getAttribute('data-day');
    assert.ok(day);
    await page.evaluate(day=>{
      const generation=window.TaskPointsStateRuntimeV2Generation.read();
      sessionStorage.setItem('taskpoints_v2_stale_habit_tap_v1',JSON.stringify({
        version:1,habitId:'h2',dayKey:day,generation,
        pathname:location.pathname,createdEpochMs:Date.now()
      }));
      const remove=Storage.prototype.removeItem;
      window.__syntheticStaleTapRemove=remove;
      Storage.prototype.removeItem=function(key){
        if(this===sessionStorage && key==='taskpoints_v2_stale_habit_tap_v1') return;
        return remove.call(this,key);
      };
      window.dispatchEvent(new Event('pageshow'));
    },day);
    try{
      await page.waitForTimeout(300);
      const blocked=await page.evaluate(day=>({
        journal:window.TaskPointsCore.readPendingHabitDeltas()
          .filter(row=>row.habitId==='h2'&&row.dayKey===day),
        stale:sessionStorage.getItem('taskpoints_v2_stale_habit_tap_v1'),
        replays:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays
      }),day);
      assert.deepEqual(blocked.journal,[]);
      assert.ok(blocked.stale,'unconsumed session tap remains available');
      assert.equal(blocked.replays,0);
    }finally{
      await page.evaluate(()=>{
        if(window.__syntheticStaleTapRemove){
          Storage.prototype.removeItem=window.__syntheticStaleTapRemove;
          delete window.__syntheticStaleTapRemove;
        }
      });
    }
    await page.waitForFunction(day=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(row=>row.habitId==='h2'&&row.dayKey===day&&row.status==='full'),
      day,{timeout:15000});
    const result=await page.evaluate(async day=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      await runtime.startCoordinatedDarkMirror();
      const parity=await runtime.verifyParity();
      return {
        journal:window.TaskPointsCore.readPendingHabitDeltas()
          .filter(row=>row.habitId==='h2'&&row.dayKey===day).map(row=>row.status),
        pending:sessionStorage.getItem('taskpoints_v2_stale_habit_tap_v1'),
        replays:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays,
        authority:runtime.getStatus().readAuthority,parity
      };
    },day);
    assert.deepEqual(result.journal,['full']);
    assert.equal(result.pending,null);
    assert.equal(result.replays,1);
    assert.equal(result.authority,'legacy_only');
    assert.equal(result.parity.match,true,JSON.stringify(result.parity.differences));
    await page.reload({waitUntil:'load'});
    const after=await page.evaluate(day=>window.TaskPointsCore.readPendingHabitDeltas()
      .filter(row=>row.habitId==='h2'&&row.dayKey===day).length,day);
    assert.ok(after<=1,'reopening cannot duplicate a previously consumed Habit tap');
    return {silentStorageNoopPrevented:true,tapAppliedOnceAfterRecovery:true,parity:true};
  });

  await test('stale Habit continuation from a previous V2 generation is discarded without toggling',async ctx=>{
    const {page}=await home(ctx);
    const generation=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.getStatus().currentGeneration);
    await page.evaluate(generation=>sessionStorage.setItem('taskpoints_v2_stale_habit_tap_v1',
      JSON.stringify({version:1,habitId:'h2',dayKey:'2026-10-19',
        generation:'old-generation-'+generation,pathname:location.pathname,
        createdEpochMs:Date.now()})),generation);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>window.TaskPointsHabitFastPathControl?.getStatus?.().staleTapDiscarded===1,
      null,{timeout:10000});
    const evidence=await page.evaluate(()=>({
      count:window.TaskPointsCore.readPendingHabitDeltas().filter(d=>d.habitId==='h2').length,
      replays:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays,
      pending:sessionStorage.getItem('taskpoints_v2_stale_habit_tap_v1')
    }));
    assert.equal(evidence.count,0);
    assert.equal(evidence.replays,0);
    assert.equal(evidence.pending,null);
    return {wrongGenerationTapDiscarded:true,noUnexpectedMutation:true};
  });


  await test('stale same-Habit tap advances from the newer tab state instead of duplicating full completion',async ctx=>{
    const first=(await home(ctx)).page;
    const stale=(await home(ctx)).page;
    await first.locator('[data-home-tab="habits"]').click({force:true});
    await stale.locator('[data-home-tab="habits"]').click({force:true});
    const day=await first.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    assert.ok(day);
    await first.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+day+'"]').tap({force:true});
    await first.waitForFunction(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(d=>d.habitId==='h1'&&d.dayKey===key&&d.status==='full'),day);
    await stale.waitForFunction(()=>window.TaskPointsStateRuntimeV2?.getStatus?.()?.externalRevisionInvalidated===true,
      null,{timeout:12000});
    await stale.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+day+'"]').tap({force:true});
    await stale.waitForFunction(key=>window.TaskPointsCore?.readPendingHabitDeltas?.()
      .some(d=>d.habitId==='h1'&&d.dayKey===key&&d.status==='half'),day,{timeout:20000});
    const observed=await stale.evaluate(key=>{
      const core=window.TaskPointsCore;
      const snap=core.readTaskPointsStoredState();
      const pending=core.readPendingHabitDeltas();
      const effective=structuredClone(snap);
      core.applyPendingHabitDeltas(effective,pending);
      const rows=effective.completions.filter(c=>c.habitId==='h1'&&c.dayKey===key);
      return {journal:pending.filter(d=>d.habitId==='h1'&&d.dayKey===key).map(d=>d.status),
        count:rows.length,fraction:rows[0]?.completionFraction,
        replayCount:window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays};
    },day);
    assert.deepEqual(observed.journal,['half']);
    assert.equal(observed.count,1,'same Habit/day must not acquire duplicate completions');
    assert.equal(observed.fraction,0.5,'reload must advance newer full state to half');
    assert.equal(observed.replayCount,1);
    await stale.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const p=await stale.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {fullToHalfAcrossTabs:true,duplicateCompletions:0,parity:p.match};
  });


  await test('Tasks UI adds and completes a task while preserving its durable completion after close and reopen',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="tasks"]').click({force:true});
    // Use the same modal-opening handler as the mobile Add Task control.
    // A forced click on the underlying Tasks-panel "+" can hit an overlaid
    // floating navigation island on a mobile viewport.
    await page.evaluate(()=>window.openAddTaskModal()); 
    await page.locator('#titleInput').waitFor({state:'visible'});
    await page.locator('#titleInput').fill('Synthetic task persistence check');
    await page.locator('#pointsInput').fill('18');
    await page.locator('#importanceInput').selectOption('High');
    await page.locator('#addBtn').click();
    await page.waitForFunction(()=>window.TaskPointsCore.readTaskPointsStoredState().tasks
      .some(t=>String(t.title||'').toLowerCase()==='synthetic task persistence check'),null,{timeout:12000});
    const created=await page.evaluate(()=>{
      const state=window.TaskPointsCore.readTaskPointsStoredState();
      const t=state.tasks.find(t=>String(t.title||'').toLowerCase()==='synthetic task persistence check');
      return {id:t?.id,title:t?.title,importance:t?.importance,points:t?.points};
    });
    assert.ok(created.id);
    assert.equal(created.importance,'High');
    assert.equal(created.points,18);
    // The persistence test must exercise the real DOM click listener on
    // the completed task, not risk force-clicking a mobile overlay above it.
    // Other browser cases independently test pointer targeting.
    await page.evaluate(id=>{
      const button=document.querySelector('#taskList [data-task-action="complete"][data-task-id="'+id+'"]');
      if(!button)throw Error('Task completion control was not rendered');
      button.click();
    },created.id);
    await page.waitForFunction(id=>{
      const live=typeof state !== 'undefined' ? state : null;
      const journal=window.TaskPointsCore.readPendingTaskMutations?.();
      return live?.tasks?.some(t=>t.id===id&&t.status==='done')
        || journal?.record?.tasks?.some?.(t=>t.id===id&&t.status==='done');
    },created.id,{timeout:14000});
    const durableTask=await page.evaluate(id=>({
      live:typeof state !== 'undefined' ? state.tasks.find(t=>t.id===id)?.status : null,
      pending:window.TaskPointsCore.readPendingTaskMutations?.()?.record?.tasks?.find(t=>t.id===id)?.status,
      raw:window.TaskPointsCore.readTaskPointsStoredState().tasks.find(t=>t.id===id)?.status
    }),created.id);
    assert.equal(durableTask.live,'done','Task completion must update Home state');
    assert.ok(durableTask.pending==='done'||durableTask.raw==='done',
      'Task completion must be durable in the journal or verified snapshot');
    // Pagehide is the browser's actual navigation lifecycle event. Kill this
    // tab immediately after the completion has been journaled, then reopen
    // the real Home UI from an entirely new page in the same isolated context.
    await page.close();
    const reopened=(await home(ctx)).page;
    const recovered=await reopened.evaluate(id=>{
      const core=window.TaskPointsCore;
      const current=core.readTaskPointsStoredState();
      const t=current.tasks.find(t=>t.id===id);
      const row=current.completions.filter(c=>c.taskId===id);
      return {task:t?{title:t.title,status:t.status}:null,completionCount:row.length,
        points:row[0]?.points,sourceCount:current.completions.filter(c=>c.source==='habit').length};
    },created.id);
    assert.equal(recovered.task?.title?.toLowerCase(),'synthetic task persistence check');
    assert.equal(recovered.task?.status,'done');
    assert.equal(recovered.completionCount,1,'completed task must survive immediate page closure');
    assert.equal(recovered.points,18);
    const p=await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {taskRetained:true,completedOnce:true,points:recovered.points,habitParity:p.match};
  });

  await test('SCWM UI saves Sleep Calories Work and Mood including Mood notes across reload',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    // The original score-dashboard-v1 is deliberately removed by Home boot.
    // Exercise the *actual* score-dashboard-v2 cards and their edit modals.
    await page.locator('#scoreV2Row .scoreV2-card').first().waitFor({state:'visible'});
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="sleep"]').click();
    await page.locator('#sleepEditModal').waitFor({state:'visible'});
    await page.locator('#sleepEditScoreInput').fill('88');
    await page.locator('#sleepEditRestedInput').fill('1.5');
    await page.locator('#sleepEditSaveBtn').click();
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="calories"]').click();
    await page.locator('#caloriesEditModal').waitFor({state:'visible'});
    await page.locator('#caloriesEditInput').fill('1800');
    await page.locator('#caloriesEditSaveBtn').click();
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="work"]').click();
    await page.locator('#workEditModal').waitFor({state:'visible'});
    await page.locator('#workEditScoreInput').fill('6.5');
    await page.locator('#workEditHoursInput').fill('3');
    await page.locator('#workEditSaveBtn').click();
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="mood"]').click();
    await page.locator('#moodEditModal').waitFor({state:'visible'});
    await page.locator('#moodEditScoreInput').fill('3.7');
    await page.locator('#moodEditNotesInput').fill('Synthetic private test note');
    await page.locator('#moodEditSaveBtn').click();
    await page.waitForFunction(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      return ['Sleep Score (88)','Calories (1800)','Work Score (6.5)','Mood Score (3.7)']
        .every(prefix=>s.completions.some(c=>c.title?.startsWith(prefix)));
    },null,{timeout:15000});
    // Exercise app backgrounding behavior without sacrificing the open tab.
    await page.evaluate(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>Boolean(window.TaskPointsStateRuntimeV2?.getStatus?.()?.seeded));
    const saved=await page.evaluate(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      const get=prefix=>s.completions.filter(c=>c.title?.startsWith(prefix));
      return {sleep:get('Sleep Score (88)'),calories:get('Calories (1800)'),
        work:get('Work Score (6.5)'),mood:get('Mood Score (3.7)'),
        habits:s.habits.length};
    });
    for(const key of ['sleep','calories','work','mood'])assert.equal(saved[key].length,1,key+' must remain unique');
    assert.equal(saved.sleep[0].sleepRested,1.5);
    assert.equal(saved.calories[0].calories,1800);
    assert.equal(saved.work[0].workHours,3);
    assert.equal(saved.mood[0].moodNotes,'Synthetic private test note');
    assert.equal(saved.habits,3);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const p=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {fourSCWMCardsRetained:true,moodNotesRetained:true,habitParity:p.match};
  });

  await test('interleaved Habit Task and SCWM UI actions retain every domain through navigation and restart',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="habits"]').click({force:true});
    const day=await page.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    await page.locator('#habitsList .habitDay[data-habit="h1"][data-day="'+day+'"]').tap({force:true});
    await page.waitForFunction(key=>window.TaskPointsCore.readPendingHabitDeltas()
      .some(d=>d.habitId==='h1'&&d.dayKey===key&&d.status==='full'),day);
    await page.locator('[data-home-tab="tasks"]').click({force:true});
    await page.evaluate(()=>window.openAddTaskModal());
    await page.locator('#titleInput').waitFor({state:'visible'});
    await page.locator('#titleInput').fill('Synthetic interleaved task');
    await page.locator('#pointsInput').fill('7');
    await page.locator('#addBtn').click();
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="sleep"]').click();
    await page.locator('#sleepEditModal').waitFor({state:'visible'});
    await page.locator('#sleepEditScoreInput').fill('91');
    await page.locator('#sleepEditSaveBtn').click();
    await page.waitForFunction(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      return s.tasks.some(t=>String(t.title||'').toLowerCase()==='synthetic interleaved task')
        && s.completions.some(c=>c.title?.startsWith('Sleep Score (91)'));
    },null,{timeout:15000});
    const beforeClose=await page.evaluate(()=>({
      stateNotes:typeof state!=='undefined'?state.notes:null,
      storedNotes:window.TaskPointsCore.readTaskPointsStoredState().notes,
      companionNotes:localStorage.getItem('taskpoints_notes_v1'),
      rawSnapshotNotes:window.TaskPointsCore.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'),{}).notes
    }));
    assert.equal(beforeClose.storedNotes,'SYNTHETIC UI DATA',
      'Notes lost before reload: '+JSON.stringify(beforeClose));
    await page.close();
    const reopened=(await home(ctx)).page;
    const evidence=await reopened.evaluate(key=>{
      const core=window.TaskPointsCore;
      const s=core.readTaskPointsStoredState();
      const effective=structuredClone(s);
      core.applyPendingHabitDeltas(effective);
      return {habit:effective.habits.find(h=>h.id==='h1')?.doneKeys.includes(key),
        task:s.tasks.filter(t=>String(t.title||'').toLowerCase()==='synthetic interleaved task').length,
        sleep:s.completions.filter(c=>c.title?.startsWith('Sleep Score (91)')).length,
        journal:core.readPendingHabitDeltas().filter(d=>d.habitId==='h1'&&d.dayKey===key).length};
    },day);
    assert.equal(evidence.habit,true,'newer Habit tap must not be lost to non-Habit full snapshot saves');
    assert.equal(evidence.task,1);
    assert.equal(evidence.sleep,1);
    await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const p=await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {habitRetained:true,taskRetained:true,sleepRetained:true,parity:p.match};
  });


  await test('Task UI edit then Trash survives repeated reloads without resurrecting an older task',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="tasks"]').click({force:true});
    await page.evaluate(()=>window.openAddTaskModal());
    await page.locator('#titleInput').waitFor({state:'visible'});
    await page.locator('#titleInput').fill('Synthetic Task To Edit');
    await page.locator('#pointsInput').fill('11');
    await page.locator('#addBtn').click();
    const id=await page.evaluate(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      return s.tasks.find(t=>String(t.title||'').toLowerCase()==='synthetic task to edit')?.id;
    });
    assert.ok(id,'task must be created before editing');
    // A mobile Task card can be inside a collapsed/offscreen date group.
    // Invoke the actual Home edit action, then exercise its real edit fields
    // and Save button rather than forcing an unreachable viewport target.
    await page.evaluate(id=>window.editTask(id),id);
    const card=page.locator('#taskList .glass[data-task-id="'+id+'"]');
    await card.locator('input[data-field="title"]').fill('Synthetic Task Edited');
    await card.locator('input[data-field="points"]').fill('29');
    await card.locator('select[data-field="importance"]').selectOption('Critical');
    await card.locator('[data-task-action="task-save"]').click({force:true});
    // Edit Save uses the Task mutation journal rather than a synchronous
    // full-state snapshot. Either the durable journal or a completed
    // compaction may own the most recent record at this moment.
    await page.waitForFunction(id=>{
      const core=window.TaskPointsCore;
      const live=typeof state!=='undefined' ? state.tasks.find(t=>t.id===id) : null;
      const journal=core.readPendingTaskMutations?.()?.record?.tasks?.find(t=>t.id===id);
      const stored=core.readTaskPointsStoredState().tasks.find(t=>t.id===id);
      const newest=journal||stored;
      return live?.title==='Synthetic Task Edited'&&live.points===29
        && newest?.title==='Synthetic Task Edited'
        && newest.points===29&&newest.importance==='Critical';
    },id,{timeout:12000});
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    const edited=await page.evaluate(id=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      const t=s.tasks.find(x=>x.id===id);
      return t&&{title:t.title,points:t.points,importance:t.importance,status:t.status};
    },id);
    assert.deepEqual(edited,{title:'Synthetic Task Edited',points:29,importance:'Critical',status:'active'});
    await page.locator('[data-home-tab="tasks"]').click({force:true});
    page.once('dialog',dialog=>dialog.accept());
    await page.evaluate(id=>window.deleteTask(id),id);
    await page.waitForFunction(id=>window.TaskPointsCore.readTaskPointsStoredState()
      .tasks.some(t=>t.id===id&&t.status==='trashed'),id,{timeout:12000});
    for(let i=0;i<2;i++){
      await page.reload({waitUntil:'load'});
      await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    }
    const final=await page.evaluate(id=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      const matches=s.tasks.filter(t=>t.id===id);
      return {count:matches.length,status:matches[0]?.status,
        deletedFrom:matches[0]?.deletedFrom,
        visible:Boolean(document.querySelector('#taskList [data-task-id="'+id+'"]'))};
    },id);
    assert.equal(final.count,1,'Task must never be duplicated');
    assert.equal(final.status,'trashed','explicitly deleted task must not resurrect');
    assert.equal(final.visible,false);
    const p=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {taskEditsPersisted:true,trashPersisted:true,reloads:3,habitParity:p.match};
  });

  await test('repeated Mood edits interleaved with Habit and Sleep preserve the latest note and no duplicates',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    const mood=page.locator('#scoreV2Row .scoreV2-card[data-scorev2="mood"]');
    // Start with Sleep, matching the normal dashboard initialization path.
    // The second Sleep edit later must update, not duplicate, this record.
    await page.locator('#scoreV2Row .scoreV2-card[data-scorev2="sleep"]').click();
    await page.locator('#sleepEditModal').waitFor({state:'visible'});
    await page.locator('#moodEditModal').waitFor({state:'hidden',timeout:12000});
    await page.locator('#sleepEditScoreInput').fill('66');
    await page.locator('#sleepEditRestedInput').fill('0.5');
    await page.locator('#sleepEditSaveBtn').click();
    await page.locator('#sleepEditModal').waitFor({state:'hidden',timeout:12000});
    await page.waitForFunction(()=>window.TaskPointsCore.readTaskPointsStoredState()
      .completions.some(c=>c.title.startsWith('Sleep Score (66)')),null,{timeout:12000});
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    // Exercise the same Home dashboard Mood-edit action as the clickable
    // card without introducing a second hit-test race with the Sleep overlay.
    // Mood-only UI scenarios separately verify the card click itself.
    await page.evaluate(()=>window.openTodayMoodScoreV2Editor());
    await page.locator('#moodEditModal').waitFor({state:'visible',timeout:12000});
    await page.locator('#sleepEditModal').waitFor({state:'hidden',timeout:12000});
    await page.locator('#moodEditScoreInput').fill('2.1');
    await page.locator('#moodEditNotesInput').fill('Early synthetic note');
    await page.locator('#moodEditSaveBtn').click();
    await page.locator('#moodEditModal').waitFor({state:'hidden',timeout:12000});
    await page.waitForFunction(()=>window.TaskPointsCore.readTaskPointsStoredState()
      .completions.some(c=>c.title==='Mood Score (2.1)'),null,{timeout:12000});
    await page.locator('[data-home-tab="habits"]').click({force:true});
    await page.locator('#habitsList .habitDay[data-habit="h1"]').first().waitFor({state:'visible'});
    await page.waitForFunction(()=>window.TaskPointsHabitFastPathControl?.getStatus?.()?.installed===true
      && Boolean(document.querySelector('#habitsList .habitDay[data-habit="h1"]')));
    const day=await page.locator('#habitsList .habitDay[data-habit="h1"]').first().getAttribute('data-day');
    // This scenario checks cross-domain persistence, not gesture hit-testing.
    // Invoke Home's *real journal-first action* after switching tabs. Other
    // dedicated UI tests cover actual touch/pointer delivery and stale tabs.
    await page.evaluate(key=>{
      const bubble=document.querySelector('#habitsList .habitDay[data-habit="h1"][data-day="'+key+'"]');
      if(!bubble)throw Error('Habit bubble missing after SCWM edits');
      window.handleHabitBubbleTap(bubble);
    },day);
    await page.waitForFunction(key=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      if(pending.some(d=>d.habitId==='h1'&&d.dayKey===key&&d.status==='full'))return true;
      // A fast verified full-state compaction legitimately drains the
      // journal before Playwright observes it. Check the saved completion
      // and matching doneKey instead of requiring the temporary journal.
      const s=core.readTaskPointsStoredState();
      return s.habits.some(h=>h.id==='h1'&&h.doneKeys?.includes(key))
        && s.completions.some(c=>c.habitId==='h1'&&c.dayKey===key);
    },day,{timeout:12000});
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    // Exercise the same Home dashboard Mood-edit action as the clickable
    // card without introducing a second hit-test race with the Sleep overlay.
    // Mood-only UI scenarios separately verify the card click itself.
    await page.evaluate(()=>window.openTodayMoodScoreV2Editor());
    await page.locator('#moodEditModal').waitFor({state:'visible',timeout:12000});
    await page.locator('#sleepEditModal').waitFor({state:'hidden',timeout:12000});
    await page.locator('#moodEditScoreInput').fill('4.4');
    await page.locator('#moodEditNotesInput').fill('Latest synthetic note after habit');
    await page.locator('#moodEditSaveBtn').click();
    await page.locator('#moodEditModal').waitFor({state:'hidden',timeout:12000});
    // Test the real persisted-Sleep edit path independent of a dashboard
    // tab transition. Other Home scenarios verify actual card/touch targeting.
    await page.evaluate(()=>{
      const existing=window.getTodaySleepEntry();
      if(!existing)throw Error('Saved Sleep entry missing before second edit');
      window.promptEditSleepEntry(existing);
    });
    await page.locator('#sleepEditModal').waitFor({state:'visible'});
    await page.locator('#moodEditModal').waitFor({state:'hidden',timeout:12000});
    await page.locator('#sleepEditScoreInput').fill('79');
    await page.locator('#sleepEditRestedInput').fill('0.8');
    await page.locator('#sleepEditSaveBtn').click();
    await page.waitForFunction(()=>{
      const c=window.TaskPointsCore.readTaskPointsStoredState().completions;
      return c.some(x=>x.title==='Mood Score (4.4)'&&x.moodNotes==='Latest synthetic note after habit')
        && c.some(x=>x.title.startsWith('Sleep Score (79)'));
    },null,{timeout:12000});
    await page.close();
    const reopened=(await home(ctx)).page;
    const final=await reopened.evaluate(key=>{
      const core=window.TaskPointsCore;
      const state=core.readTaskPointsStoredState();
      const effective=structuredClone(state);
      core.applyPendingHabitDeltas(effective);
      const moods=state.completions.filter(c=>c.title?.startsWith('Mood Score'));
      const sleeps=state.completions.filter(c=>c.title?.startsWith('Sleep Score'));
      return {moods:moods.map(c=>({title:c.title,notes:c.moodNotes})),
        sleeps:sleeps.map(c=>c.title),
        habit:effective.habits.find(h=>h.id==='h1')?.doneKeys.includes(key)};
    },day);
    assert.deepEqual(final.moods,[{title:'Mood Score (4.4)',notes:'Latest synthetic note after habit'}]);
    assert.equal(final.sleeps.length,1);
    assert.equal(final.habit,true);
    const p=await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {lastMoodWins:true,oneMoodEntry:true,habitAndSleepRetained:true,parity:p.match};
  });


  await test('three Mood corrections across reloads retain only the most recent entry',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    const mood=page.locator('#scoreV2Row .scoreV2-card[data-scorev2="mood"]');
    let correction=0;
    for(const [score,note] of [['1.8','Synthetic first draft'],['2.6','Synthetic corrected draft'],['4.1','Synthetic final draft']]){
      if(correction++>0){
        await page.reload({waitUntil:'load'});
        await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
      }
      // The Home SCWM card may be replaced by a canonical rerender after
      // Save. Return to SCWM and use the current rendered card each time.
      // Use Home's ordinary Mood-entry action, then the actual modal
      // fields and Save button. This isolates persistence from dashboard
      // card hit-testing, which existing UI tests cover separately.
      await page.waitForFunction(()=>Boolean(document.querySelector('#scoreV2Row .scoreV2-card[data-scorev2="mood"]')));
      // Dispatch the same DOM click listener used by the real dashboard.
      // This avoids offscreen touch targeting while preserving its onSave path.
      await page.evaluate(()=>{
        document.querySelector('#scoreV2Row .scoreV2-card[data-scorev2="mood"]').click();
      });
      await page.locator('#moodEditModal').waitFor({state:'visible',timeout:12000});
      await page.locator('#moodEditScoreInput').fill(score);
      await page.locator('#moodEditNotesInput').fill(note);
      await page.locator('#moodEditSaveBtn').click();
      await page.waitForFunction(([expected,notes])=>{
        const entries=window.TaskPointsCore.readTaskPointsStoredState().completions
          .filter(c=>c.title?.startsWith('Mood Score'));
        return entries.length===1 && entries[0].title==='Mood Score ('+expected+')'
          && entries[0].moodNotes===notes;
      },[score,note],{timeout:12000});
    }
    await page.evaluate(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.close();
    const reopened=(await home(ctx)).page;
    const result=await reopened.evaluate(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      const mood=s.completions.filter(c=>c.title?.startsWith('Mood Score'));
      return {mood:mood.map(c=>({title:c.title,notes:c.moodNotes})),
        journal:window.TaskPointsCore.readPendingHabitDeltas().length,
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.deepEqual(result.mood,[{title:'Mood Score (4.1)',notes:'Synthetic final draft'}]);
    assert.equal(result.authority,'legacy_only');
    await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const parity=await reopened.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(parity.match,true,JSON.stringify(parity.differences));
    return {corrections:3,finalMood:'4.1',duplicates:0,parity:parity.match};
  });

  await test('unsaved Task creation form does not create a ghost Task after background and reload',async ctx=>{
    const {page}=await home(ctx);
    await page.locator('[data-home-tab="tasks"]').click({force:true});
    await page.evaluate(()=>window.openAddTaskModal());
    await page.locator('#titleInput').waitFor({state:'visible'});
    await page.locator('#titleInput').fill('Synthetic draft must never save');
    await page.locator('#pointsInput').fill('43');
    await page.evaluate(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelectorAll('#habitsList .habitDay').length>=21);
    const saved=await page.evaluate(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      const journal=window.TaskPointsCore.readPendingTaskMutations?.()?.record?.tasks||[];
      return {tasks:s.tasks.filter(t=>t.title==='Synthetic draft must never save').length,
        pending:journal.filter(t=>t.title==='Synthetic draft must never save').length};
    });
    assert.equal(saved.tasks,0,'form without Save must not persist a Task');
    assert.equal(saved.pending,0,'unsaved draft must not enter the Task journal');
    const p=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.verifyParity());
    assert.equal(p.match,true,JSON.stringify(p.differences));
    return {ghostTasks:0,pendingDrafts:0,parity:p.match};
  });

}finally{
  await writeFile(join(artifacts,'results.json'),JSON.stringify({failures,records},null,2));
  await browser.close();
  await new Promise(done=>server.close(done));
}
if(failures){console.error('V2 UI integration failed: '+failures+' scenario(s)');process.exitCode=1;}
else console.log('V2 UI integration passed: '+records.length+' scenarios');
