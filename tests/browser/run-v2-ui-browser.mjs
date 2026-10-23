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
  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('console',msg=>{if(msg.type()==='error') console.warn('HOME CONSOLE '+msg.text().slice(0,250));});
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
  return {page,pageErrors,status};
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
    const {page,status}=await home(ctx);
    assert.equal(status.cards,3);
    assert.equal(status.names.length,3);
    assert.equal(status.pageErrors?.length||0,0);
    return {cards:status.cards,readAuthority:status.readAuthority};
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
    return {day:chosen.day,detectedBefore:before.status,retainedAfter: persisted};
  });
}finally{
  await writeFile(join(artifacts,'results.json'),JSON.stringify({failures,records},null,2));
  await browser.close();
  await new Promise(done=>server.close(done));
}
if(failures){console.error('V2 UI integration failed: '+failures+' scenario(s)');process.exitCode=1;}
else console.log('V2 UI integration passed: '+records.length+' scenarios');
