import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, join, extname } from 'node:path';
import { chromium } from 'playwright';

// The real TaskPoints Home HTML and JS run on a disposable localhost origin.
// The script is a focused local equivalent of _worker.js's scoring bundle;
// it does not contact the deployed app, GitHub, or any external API.
const root=resolve(process.cwd()), artifacts=join(root,'v2-ui-browser-artifacts');
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
const browser=await chromium.launch({headless:true});
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
          journal:window.TaskPointsCore?.readPendingHabitDeltas?.()
        }));
        await writeFile(join(artifacts,'failed-'+records.length+'-'+i+'.json'),JSON.stringify(diag,null,2));
        console.error('UI DIAGNOSTICS '+JSON.stringify(diag).slice(0,2500));
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
    await page.locator('#openAddTaskBtn').click({force:true});
    const taskField=await page.evaluate(()=>({url:location.pathname,modal:document.querySelector('#addTaskModal')?.className,
      input:document.querySelector('#titleInput')?.outerHTML,visible:document.querySelector('#titleInput')?.getClientRects?.().length,
      mobile:matchMedia('(max-width: 768px)').matches}));
    assert.ok(taskField.input&&taskField.visible,'Task add field unavailable: '+JSON.stringify(taskField));
    await page.locator('#titleInput').fill('Synthetic task persistence check');
    await page.locator('#pointsInput').fill('18');
    await page.locator('#importanceInput').selectOption('High');
    await page.locator('#addBtn').click({force:true});
    await page.waitForFunction(()=>window.TaskPointsCore.readTaskPointsStoredState().tasks
      .some(t=>t.title==='Synthetic task persistence check'),null,{timeout:12000});
    const created=await page.evaluate(()=>{
      const state=window.TaskPointsCore.readTaskPointsStoredState();
      const t=state.tasks.find(t=>t.title==='Synthetic task persistence check');
      return {id:t?.id,title:t?.title,importance:t?.importance,points:t?.points};
    });
    assert.ok(created.id);
    assert.equal(created.importance,'High');
    assert.equal(created.points,18);
    await page.locator('#taskList [data-task-action="complete"][data-task-id="'+created.id+'"]').click({force:true});
    await page.waitForFunction(id=>{
      const state=window.TaskPointsCore.readTaskPointsStoredState();
      return state.tasks.some(t=>t.id===id&&t.status==='done')
        || Boolean(window.TaskPointsCore.readPendingTaskMutations?.()?.some?.(x=>x.taskId===id));
    },created.id,{timeout:14000});
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
    assert.equal(recovered.task?.title,'Synthetic task persistence check');
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
    const scwmField=await page.evaluate(()=>({url:location.pathname,
      selected:document.querySelector('[data-home-tab="scwm"]')?.className,
      panel:document.querySelector('#homePanelScwm')?.className,
      sleep:document.querySelector('#sleepScoreInput')?.outerHTML,
      visible:document.querySelector('#sleepScoreInput')?.getClientRects?.().length,
      sleepRow:document.querySelector('#sleepInputRow')?.className}));
    assert.ok(scwmField.sleep&&scwmField.visible,'SCWM Sleep input unavailable: '+JSON.stringify(scwmField));
    await page.locator('#sleepScoreInput').fill('88');
    await page.locator('#sleepRestedInput').fill('1.5');
    await page.locator('#saveSleepScoreBtn').click({force:true});
    await page.locator('#caloriesInput').fill('1800');
    await page.locator('#saveCaloriesBtn').click({force:true});
    await page.locator('#workScoreInput').fill('6.5');
    await page.locator('#workHoursInput').fill('3');
    await page.locator('#saveWorkScoreBtn').click({force:true});
    await page.locator('#moodScoreInput').fill('3.7');
    await page.locator('#saveMoodScoreBtn').click({force:true});
    await page.locator('#moodEditModal').waitFor({state:'visible'});
    await page.locator('#moodEditNotesInput').fill('Synthetic private test note');
    await page.locator('#moodEditSaveBtn').click({force:true});
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
    await page.locator('#openAddTaskBtn').click({force:true});
    await page.locator('#titleInput').fill('Synthetic interleaved task');
    await page.locator('#pointsInput').fill('7');
    await page.locator('#addBtn').click({force:true});
    await page.locator('[data-home-tab="scwm"]').click({force:true});
    const interleavedScwm=await page.evaluate(()=>({sleep:document.querySelector('#sleepScoreInput')?.outerHTML,
      visible:document.querySelector('#sleepScoreInput')?.getClientRects?.().length,
      row:document.querySelector('#sleepInputRow')?.className}));
    assert.ok(interleavedScwm.sleep&&interleavedScwm.visible,
      'Interleaved SCWM input unavailable: '+JSON.stringify(interleavedScwm));
    await page.locator('#sleepScoreInput').fill('91');
    await page.locator('#saveSleepScoreBtn').click({force:true});
    await page.waitForFunction(()=>{
      const s=window.TaskPointsCore.readTaskPointsStoredState();
      return s.tasks.some(t=>t.title==='Synthetic interleaved task')
        && s.completions.some(c=>c.title?.startsWith('Sleep Score (91)'));
    },null,{timeout:15000});
    await page.close();
    const reopened=(await home(ctx)).page;
    const evidence=await reopened.evaluate(key=>{
      const core=window.TaskPointsCore;
      const s=core.readTaskPointsStoredState();
      const effective=structuredClone(s);
      core.applyPendingHabitDeltas(effective);
      return {habit:effective.habits.find(h=>h.id==='h1')?.doneKeys.includes(key),
        task:s.tasks.filter(t=>t.title==='Synthetic interleaved task').length,
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

}finally{
  await writeFile(join(artifacts,'results.json'),JSON.stringify({failures,records},null,2));
  await browser.close();
  await new Promise(done=>server.close(done));
}
if(failures){console.error('V2 UI integration failed: '+failures+' scenario(s)');process.exitCode=1;}
else console.log('V2 UI integration passed: '+records.length+' scenarios');
