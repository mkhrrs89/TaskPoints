import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

const engine = process.env.V2_BROWSER_ENGINE || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) {
  throw Error('Unsupported V2 browser engine: ' + engine);
}
const root = resolve(process.cwd());
const artifacts = join(root, 'v2-browser-artifacts', engine);
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const filename = resolve(root, '.' + pathname);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(filename)];
    if (!filename.startsWith(root + sep) || !mime) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(await readFile(filename));
  } catch (error) { res.writeHead(404); res.end(String(error.message || error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + server.address().port + '/tests/browser/v2-storage-fixture.html';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
console.log('V2 storage safety browser engine: ' + engine);
const results = [];
let failures = 0;
async function open(context) {
  const page = await context.newPage();
  page.on('pageerror', error => console.warn('Browser error: ' + error.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.V2BrowserFixture?.status().runtime.installed));
  const status = await page.evaluate(() => window.V2BrowserFixture.start());
  assert.equal(status.runtime.readAuthority, 'legacy_only');
  return page;
}
async function settled(page, count) {
  await page.waitForFunction(n => {
    const s = window.V2BrowserFixture?.status();
    return s && s.wal.pendingCount === 0 && s.bridge.confirmationsCleared >= n;
  }, count, { timeout: 20000 });
  const status = await page.evaluate(() => window.V2BrowserFixture.status());
  assert.equal(status.runtime.mirrorFailures, 0, JSON.stringify(status.runtime));
  assert.equal(status.bridge.failures, 0, JSON.stringify(status.bridge));
  return status;
}
async function parity(page) {
  const p = await page.evaluate(() => window.TaskPointsStateRuntimeV2.verifyParity());
  assert.equal(p.checked, true);
  assert.equal(p.match, true, JSON.stringify(p.differences));
  assert.equal(p.scopeExcludedCounts.actualCompletions, 0);
  return p;
}
async function run(name, test) {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' ? route.continue() : route.abort();
  });
  try {
    const detail = await test(context);
    results.push({ name, result:'PASS', detail });
    console.log('PASS ' + name + ' ' + JSON.stringify(detail || {}));
  } catch (error) {
    failures++;
    results.push({ name, result:'FAIL', error:String(error.stack || error) });
    console.error('FAIL ' + name + ': ' + String(error.stack || error));
    for (const [i, page] of context.pages().entries()) {
      try {
        const diagnostics = await page.evaluate(() => ({
          status: window.V2BrowserFixture?.status(),
          journal: window.TaskPointsCore?.readPendingHabitDeltas?.(),
          stored: window.V2BrowserFixture?.rawLegacy?.()?.completions?.filter(x => x.source === 'habit')
        }));
        console.error('PAGE_DIAGNOSTICS ' + i + ' ' + JSON.stringify(diagnostics));
        await writeFile(join(artifacts, 'diagnostics-' + results.length + '-' + i + '.json'), JSON.stringify(diagnostics, null, 2));
      } catch (diagnosticError) { console.error('Diagnostic collection failed: ' + String(diagnosticError)); }
    }
    for (const [i, page] of context.pages().entries()) {
      try { await page.screenshot({ path: join(artifacts, 'failed-' + results.length + '-' + i + '.png') }); } catch (_) {}
    }
  } finally { await context.close(); }
}
try {
  await run('real IndexedDB seed retains unrelated V1 completion only in V1', async context => {
    const page = await open(context);
    const p = await parity(page);
    assert.equal(p.actualCounts.habits, 3);
    assert.equal(p.actualCounts.completions, 0);
    const row = await page.evaluate(() => window.TaskPointsStateRuntimeV2.getHabit('h1'));
    assert.equal(row.name, 'Synthetic h1');
    return p.actualCounts;
  });

  await run('rapid full-half-off burst and two further Habits preserve final state', async context => {
    const page = await open(context);
    await page.evaluate(() => {
      const f = window.V2BrowserFixture;
      f.delta('h1', '2026-10-21', 'full', 1);
      f.delta('h1', '2026-10-21', 'half', 2);
      f.delta('h1', '2026-10-21', 'off', 3);
      f.delta('h2', '2026-10-21', 'full', 4);
      f.delta('h3', '2026-10-21', 'full', 5);
    });
    await settled(page, 5);
    const p = await parity(page);
    const rows = await page.evaluate(async () => {
      const r = window.TaskPointsStateRuntimeV2;
      return { h1: await r.getCompletionsForHabit('h1'),
        h2: await r.getCompletionsForHabit('h2'),
        h3: await r.getCompletionsForHabit('h3'),
        journal: window.TaskPointsCore.readPendingHabitDeltas() };
    });
    assert.equal(rows.h1.length, 0);
    assert.equal(rows.h2.length, 1);
    assert.equal(rows.h3.length, 1);
    assert.equal(rows.journal.length, 3);
    return { matched: p.match, remainingCompletions: p.actualCounts.completions };
  });

  await run('three WAL entries survive reload and replay before V2 reseeding', async context => {
    const page = await open(context);
    await page.evaluate(() => {
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1', '1');
      const f = window.V2BrowserFixture;
      // Deliberately append newest-first, opposite V1's replay order.
      // WAL replay may commit these in append order, but the saved completion
      // ordering must still follow their V1 journal timestamps.
      f.delta('h1', '2026-10-21', 'full', 9);
      f.delta('h2', '2026-10-21', 'full', 5);
      f.delta('h3', '2026-10-21', 'full', 1);
    });
    const before = await page.evaluate(() => window.V2BrowserFixture.status());
    assert.equal(before.wal.pendingCount, 3);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => {
      const s = window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount === 0 && s.bridge.replayCleared >= 3;
    }, null, { timeout: 20000 });
    const after = await page.evaluate(() => window.V2BrowserFixture.status());
    assert.equal(after.bridge.lastStartupOrder, 'wal_then_seed');
    assert.equal(after.bridge.failures, 0);
    const p = await parity(page);
    assert.equal(p.actualCounts.completions, 3);
    const order=await page.evaluate(async()=> (await window.TaskPointsStateRuntimeV2
      .buildCompatibilitySnapshot()).completions
      .filter(c=>c.source==='habit').map(c=>c.id));
    assert.deepEqual(order,[
      'habit:h1:2026-10-21','habit:h2:2026-10-21','habit:h3:2026-10-21'
    ],'WAL replay order cannot override V1 canonical timestamp order');
    return { replayCleared: after.bridge.replayCleared, startupOrder: after.bridge.lastStartupOrder };
  });

  await run('stale background Home save preserves persisted Habit and unrelated task', async context => {
    const page = await open(context);
    const saved = await page.evaluate(() => {
      const core = window.TaskPointsCore;
      const stale = window.V2BrowserFixture.rawLegacy();
      const latest = structuredClone(stale);
      latest.habits[0].doneKeys = ['2026-10-21'];
      latest.habits[0].updatedAtISO = '2026-10-22T14:00:00.000Z';
      latest.completions.unshift({ id:'habit:h1:2026-10-21', source:'habit',
        habitId:'h1',dayKey:'2026-10-21',points:3,
        completedAtISO:'2026-10-21T12:00:00.000Z' });
      core.saveStateSnapshot(latest, { immediateWrite:true, savePath:'habit-journal-compaction' });
      stale.liveDiffHistory = { synthetic: [{ score: 5 }] };
      core.saveStateSnapshot(stale, { savePath:'home-live-diff-capture' });
      const result = window.V2BrowserFixture.rawLegacy();
      return { done: result.habits[0].doneKeys, pilot: result.completions.filter(c=>c.habitId==='h1').length,
        tasks:result.completions.filter(c=>c.source==='task').length, diff:result.liveDiffHistory };
    });
    assert.deepEqual(saved.done, ['2026-10-21']);
    assert.equal(saved.pilot, 1);
    assert.equal(saved.tasks, 1);
    assert.equal(saved.diff.synthetic[0].score, 5);
    return saved;
  });

  await run('queued compression does not overwrite newer stored snapshot', async context => {
    const page = await open(context);
    const saved = await page.evaluate(() => {
      const core = window.TaskPointsCore;
      const previous = window.V2BrowserFixture.rawLegacy();
      const r = core.saveStateSnapshot(previous, { interactive:true, deferCompression:true,
        immediateWrite:true, savePath:'synthetic-interactive' });
      const newer = window.V2BrowserFixture.rawLegacy();
      newer.habits[0].name = 'Newest preserved';
      const raw = core.buildOptimizedTaskPointsStorageRaw(newer).chosenRaw;
      localStorage.setItem(core.STORAGE_KEY, raw);
      core.flushPendingInteractiveRecompresses();
      return { deferred:r.deferredCompression, rawUnchanged:localStorage.getItem(core.STORAGE_KEY)===raw,
        name:window.V2BrowserFixture.rawLegacy().habits[0].name };
    });
    assert.equal(saved.deferred, true);
    assert.equal(saved.rawUnchanged, true);
    assert.equal(saved.name, 'Newest preserved');
    return saved;
  });

  await run('two browser tabs preserve durable legacy journal entries', async context => {
    const a = await open(context), b = await open(context);
    await a.evaluate(() => window.V2BrowserFixture.delta('h1','2026-10-21','full',1));
    await a.waitForFunction(() => window.V2BrowserFixture.status().wal.pendingCount===0);
    await b.evaluate(() => window.V2BrowserFixture.delta('h2','2026-10-21','full',2));
    await b.waitForFunction(() => window.V2BrowserFixture.status().wal.pendingCount===0);
    const journal = await a.evaluate(() => window.TaskPointsCore.readPendingHabitDeltas());
    assert.deepEqual(journal.map(x=>x.habitId).sort(), ['h1','h2']);
    return { tabs:2, durableEntries:journal.length };
  });

  await run('repeated reloads retain V2 mutation ledger and completed Habit parity', async context => {
    const page=await open(context);
    await page.evaluate(()=>{
      const f=window.V2BrowserFixture;
      f.delta('h1','2026-10-21','full',1);
      f.delta('h2','2026-10-21','half',2);
      f.delta('h3','2026-10-21','full',3);
    });
    await settled(page,3);
    let previousRevision=0;
    for(let i=0;i<5;i++){
      await page.reload({waitUntil:'load'});
      await page.evaluate(()=>window.V2BrowserFixture.start());
      const p=await parity(page);
      assert.equal(p.actualCounts.completions,3);
      const evidence=await page.evaluate(async()=>{
        const db=await window.TaskPointsStateRuntimeV2.open();
        const tx=db.transaction(['meta','mutations'],'readonly');
        const read=r=>new Promise((resolve,reject)=>{
          r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
        });
        const [meta,rows]=await Promise.all([
          read(tx.objectStore('meta').get('runtime')),
          read(tx.objectStore('mutations').getAll())
        ]);
        return {revision:meta.revision,ids:rows.map(r=>r.id)};
      });
      assert.equal(evidence.ids.length,3,'committed mutation ledger must survive reload');
      assert.equal(new Set(evidence.ids).size,3,'no duplicated mutations');
      assert.ok(evidence.revision>=previousRevision,'revisions cannot move backward');
      previousRevision=evidence.revision;
    }
    return {reloads:5,completions:3,mutationsRetained:3};
  });

  await run('backup serialize, authorized import and restore protect generation and unrelated completions',async context=>{
    const page=await open(context);
    const first=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const backup=core.serializeTaskPointsStoredState(window.V2BrowserFixture.rawLegacy());
      const decoded=core.parseTaskPointsStorageJson(backup,{});
      const previous=window.TaskPointsStateRuntimeV2Generation.read();
      const imported=structuredClone(decoded);
      imported.habits[0].name='Imported Synthetic Habit';
      imported.notes='Import-only synthetic note';
      const result=core.saveValidatedSnapshot(imported,{
        allowDestructiveOverwrite:true,source:'settings-import',immediateWrite:true
      });
      return {backup,previous,after:window.TaskPointsStateRuntimeV2Generation.read(),
        resultBlocked:result?.blocked===true,
        importedName:window.V2BrowserFixture.rawLegacy().habits[0].name};
    });
    assert.equal(first.resultBlocked,false);
    assert.notEqual(first.previous,first.after);
    assert.equal(first.importedName,'Imported Synthetic Habit');
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await page.waitForFunction(async()=> (await window.TaskPointsStateRuntimeV2.getHabit('h1'))?.name==='Imported Synthetic Habit');
    await parity(page);
    const restored=await page.evaluate(backup=>{
      const core=window.TaskPointsCore;
      const data=core.parseTaskPointsStorageJson(backup,{});
      const result=core.saveValidatedSnapshot(data,{
        allowDestructiveOverwrite:true,source:'settings-restore',immediateWrite:true
      });
      const saved=window.V2BrowserFixture.rawLegacy();
      return {generation:window.TaskPointsStateRuntimeV2Generation.read(),
        blocked:result?.blocked===true,name:saved.habits[0].name,
        taskRows:saved.completions.filter(r=>r.source==='task').length};
    },first.backup);
    assert.equal(restored.blocked,false);
    assert.notEqual(restored.generation,first.after);
    assert.equal(restored.name,'Synthetic h1');
    assert.equal(restored.taskRows,1);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await page.waitForFunction(async()=> (await window.TaskPointsStateRuntimeV2.getHabit('h1'))?.name==='Synthetic h1');
    await parity(page);
    return {importAndRestoreGenerationsRotated:true,unrelatedTaskPreserved:true};
  });

  await run('closing a tab with held WAL replays safely from a surviving tab',async context=>{
    const first=await open(context),second=await open(context);
    await second.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h3','2026-10-21','full',1);
    });
    assert.equal((await second.evaluate(()=>window.V2BrowserFixture.status())).wal.pendingCount,1);
    await second.close();
    const durable=await first.evaluate(()=>({
      wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows(),
      journal:window.TaskPointsCore.readPendingHabitDeltas()
    }));
    assert.equal(durable.wal.rows.length,1);
    assert.equal(durable.journal.filter(r=>r.habitId==='h3').length,1);
    await first.reload({waitUntil:'load'});
    await first.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount===0 && s.bridge.replayCleared>=1;
    },null,{timeout:20000});
    const report=await parity(first);
    assert.equal(report.actualCounts.completions,1);
    const status=await first.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.bridge.failures,0);
    assert.equal(status.bridge.lastStartupOrder,'wal_then_seed');
    return {replayed:status.bridge.replayCleared,parity:report.match};
  });


  await run('three simulated Safari background kills replay held WAL without losing later cross-tab edits',async context=>{
    const survivor=await open(context);
    let replayed=0;
    for(let round=0;round<3;round++){
      const writer=await open(context);
      const key='2026-10-'+String(10+round).padStart(2,'0');
      await writer.evaluate(day=>{
        // Preview-only test fault models iOS suspending a tab before the V2
        // mirror confirmation. V1 has already durably written its journal.
        sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
        window.V2BrowserFixture.delta('h1',day,'full',roundNumber(day));
        function roundNumber(day){ return Number(day.slice(-2)); }
      },key);
      const before=await writer.evaluate(day=>{
        const s=window.V2BrowserFixture.status();
        const journal=window.TaskPointsCore.readPendingHabitDeltas();
        return {wal:s.wal.pendingCount,
          journal:journal.filter(d=>d.habitId==='h1'&&d.dayKey===day).length,
          authority:s.runtime.readAuthority};
      },key);
      assert.deepEqual(before,{wal:1,journal:1,authority:'legacy_only'},
        'held mutation must be represented independently in the WAL and V1 journal');
      const lifecycle=await writer.evaluate(()=>{
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pagehide'));
        return {wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length,
          journal:window.TaskPointsCore.readPendingHabitDeltas().length};
      });
      assert.equal(lifecycle.wal,1,'background lifecycle must not erase uncommitted WAL');
      assert.ok(lifecycle.journal>=1,'background lifecycle must retain the authoritative journal');
      await writer.close(); // kill the held writer, as if iOS evicted its tab
      await survivor.reload({waitUntil:'load'});
      await survivor.waitForFunction(()=>{
        const s=window.V2BrowserFixture?.status();
        return s&&s.wal.pendingCount===0&&s.bridge.replayCleared>=1;
      },null,{timeout:20000});
      replayed++;
      assert.equal((await parity(survivor)).actualCounts.completions,2*round+1);
      await survivor.evaluate(([day,n])=>
        window.V2BrowserFixture.delta('h2',day,'full',n),[key,30+round]);
      await settled(survivor,1);
      const p=await parity(survivor);
      assert.equal(p.actualCounts.completions,2*(round+1));
    }
    await survivor.reload({waitUntil:'load'});
    const result=await survivor.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const tx=db.transaction(['mutations','completions'],'readonly');
      const get=name=>new Promise((resolve,reject)=>{
        const r=tx.objectStore(name).getAll();
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const [mutations,completions]=await Promise.all(['mutations','completions'].map(get));
      return {mutationIds:mutations.map(m=>m.id),
        completionIds:completions.flatMap(row=>Array.isArray(row.entries)
          ? row.entries.map(x=>x.value.id)
          : row.value?.id?[row.value.id]:[]),
        generation:runtime.getStatus().currentGeneration,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(result.mutationIds.length,6);
    assert.equal(new Set(result.mutationIds).size,6);
    assert.equal(result.completionIds.length,6);
    assert.equal(new Set(result.completionIds).size,6);
    assert.equal(result.authority,'legacy_only');
    assert.equal((await parity(survivor)).match,true);
    return {simulatedSuspensions:3,heldWalRecoveries:replayed,
      crossTabFollowupEdits:3,mutationRows:6,completionRows:6,parity:true};
  });

  await run('incomplete restore snapshot is rejected without rotating generation or changing V1',async context=>{
    const page=await open(context);
    const outcome=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const initial=localStorage.getItem(core.STORAGE_KEY);
      const generation=window.TaskPointsStateRuntimeV2Generation.read();
      const result=core.saveValidatedSnapshot({ habits:[],completions:[] },{
        allowDestructiveOverwrite:true,source:'settings-restore',immediateWrite:true
      });
      return {blocked:result?.blocked===true,reason:result?.reason,
        originalUnchanged:localStorage.getItem(core.STORAGE_KEY)===initial,
        generationUnchanged:window.TaskPointsStateRuntimeV2Generation.read()===generation};
    });
    assert.equal(outcome.blocked,true);
    assert.match(outcome.reason,/missing required domains/);
    assert.equal(outcome.originalUnchanged,true);
    assert.equal(outcome.generationUnchanged,true);
    const p=await parity(page);
    assert.equal(p.actualCounts.habits,3);
    return {blockedSafely:true,generationUnchanged:true,parity:p.match};
  });


  await run('60 rapid synthetic Habit/day writes preserve exact durable V1 and V2 record counts',async context=>{
    const page=await open(context);
    await page.evaluate(()=>{
      const f=window.V2BrowserFixture;
      for(let day=1;day<=20;day++){
        const key='2026-09-'+String(day).padStart(2,'0');
        for(let habit=0;habit<3;habit++){
          f.delta('h'+(habit+1),key,'full',(day-1)*3+habit);
        }
      }
    });
    await settled(page,60);
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,60);
    assert.equal(p.expectedCounts.completions,60);
    const observed=await page.evaluate(async()=>{
      const core=window.TaskPointsCore;
      const journal=core.readPendingHabitDeltas();
      const db=await window.TaskPointsStateRuntimeV2.open();
      const request=db.transaction('mutations','readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {journal:journal.length,uniqueDays:new Set(journal.map(x=>x.dayKey)).size,
        mutations:mutations.length,mutationsDistinct:new Set(mutations.map(x=>x.id)).size};
    });
    assert.deepEqual(observed,{journal:60,uniqueDays:20,mutations:60,mutationsDistinct:60});
    return {writes:60,days:20,pilotCompletions:p.actualCounts.completions,mutations:observed.mutations};
  });

  await run('journal timestamp ordering is stable when IndexedDB commits run newest event first',async context=>{
    const page=await open(context);
    // Commit in the opposite order from V1's timestamp-sorted replay:
    // the new h1 event has a later timestamp but commits before older h2.
    page.on('pageerror',e=>console.warn('order-test browser error: '+e.message));
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',9));
    await settled(page,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-20','full',1));
    await settled(page,2);
    const report=await parity(page);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const read=async name=>new Promise((resolve,reject)=>{
        const r=db.transaction(name,'readonly').objectStore(name).getAll();
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const rows=await read('completions');
      const visible=await runtime.buildCompatibilitySnapshot();
      return {order:visible.completions.filter(c=>c.source==='habit').map(c=>c.id),
        mutationRows:(await read('mutations')).length,completionRows:rows.length};
    });
    assert.deepEqual(proof.order,['habit:h1:2026-10-20','habit:h2:2026-10-20']);
    assert.equal(proof.mutationRows,2);
    assert.equal(proof.completionRows,2);
    // Reopening must adopt the verified existing rows rather than reseed.
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>window.V2BrowserFixture?.status().runtime.installed);
    assert.equal((await parity(page)).match,true);
    return {reverseCommitOrder:true,canonicalV1Order:proof.order,
      mutationRowsRetained:proof.mutationRows,parity:report.match};
  });


  await run('different-day writes to same Habit preserve V1 timestamp order across reverse commits and reload',async context=>{
    const page=await open(context);
    // The higher timestamp is committed first. Legacy Habit replay sorts the
    // timestamps before appending day keys, even though IDB commit order differs.
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-18','full',9));
    await settled(page,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-19','full',1));
    await settled(page,2);
    const order=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const habit=await runtime.getHabit('h1');
      const snapshot=await runtime.buildCompatibilitySnapshot();
      const db=await runtime.open();
      const request=db.transaction('mutations','readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {doneKeys:habit.doneKeys,latest:habit.updatedAtISO,
        completionIds:snapshot.completions.filter(c=>c.source==='habit').map(c=>c.id),
        mutationCount:mutations.length};
    });
    assert.deepEqual(order.doneKeys,['2026-10-19','2026-10-18']);
    assert.equal(order.latest,'2026-10-22T12:00:09.000Z');
    assert.deepEqual(order.completionIds,
      ['habit:h1:2026-10-18','habit:h1:2026-10-19']);
    assert.equal(order.mutationCount,2);
    assert.equal((await parity(page)).match,true);
    await page.reload({waitUntil:'load'});
    assert.equal((await parity(page)).match,true);
    return {reversedCommits:2,reloaded:true,doneKeys:order.doneKeys,
      originalMutationsPreserved:order.mutationCount};
  });

  await run('two concurrent tabs retain both writes and recover outstanding WAL after reopening',async context=>{
    const first=await open(context),second=await open(context);
    await Promise.all([
      first.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',1)),
      second.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-20','full',2))
    ]);
    const original=await first.evaluate(()=>window.TaskPointsCore.readPendingHabitDeltas());
    assert.deepEqual(original.map(row=>row.habitId).sort(),['h1','h2']);
    await first.waitForTimeout(350);
    const pending=await first.evaluate(()=>window.V2BrowserFixture.status().wal.pendingCount);
    // Another tab can advance the V2 revision between transactions. The WAL
    // must remain durable if a conflict prevents immediate V2 confirmation.
    assert.ok(pending>=0 && pending<=2,'no WAL entry may be duplicated');
    await second.close();
    await first.reload({waitUntil:'load'});
    await first.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s?.wal.pendingCount===0;
    },null,{timeout:25000});
    let p=null;
    let safeOrderMismatch=false;
    try {
      p=await parity(first);
    } catch (error) {
      // Keep the strict parity failure. An order-only disagreement must not
      // be treated as equivalent state, nor repaired behind the user's back.
      // Instead prove the exact records and journal survived, and that V2
      // continues to reject a destructive same-generation reseed.
      const evidence=await first.evaluate(async()=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        const core=window.TaskPointsCore;
        const db=await runtime.open();
        const read=async()=>{
          const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
          const all=name=>new Promise((resolve,reject)=>{
            const request=tx.objectStore(name).getAll();
            request.onsuccess=()=>resolve(request.result);
            request.onerror=()=>reject(request.error);
          });
          const [meta,habits,completions,mutations]=await Promise.all(
            ['meta','habits','completions','mutations'].map(all));
          return {meta,habits,completions,mutations};
        };
        const before=await read();
        const effective=structuredClone(window.V2BrowserFixture.rawLegacy());
        core.applyPendingHabitDeltas(effective);
        const expected=effective.completions.filter(c=>c.source==='habit');
        const actual=before.completions.flatMap(row=>row.entries
          ? row.entries.map(entry=>({value:entry.value,sequence:entry.sequence}))
          : row.value ? [{value:row.value,sequence:row.sequence}] : [])
          .sort((a,b)=>Number(b.sequence||0)-Number(a.sequence||0))
          .map(entry=>entry.value);
        let blocked=null;
        try{await runtime.seedFromLegacy();}
        catch(e){blocked={code:e.code,evidence:e.evidence};}
        const after=await read();
        return {expected,actual,blocked,before,after,
          wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows(),
          journal:core.readPendingHabitDeltas(),
          authority:runtime.getStatus().readAuthority};
      });
      console.warn('MULTITAB_STRICT_MISMATCH_EVIDENCE '+JSON.stringify({
        expectedOrder:evidence.expected.map(c=>c.id),
        actualOrder:evidence.actual.map(c=>c.id),
        blocked:evidence.blocked,
        mutationCount:evidence.after.mutations.length
      }));
      // This is a supported *fail-closed outcome*, but not a parity pass.
      // Refuse all cases with lost records, modified content, or changes to
      // either store during the attempted startup reconciliation.
      assert.equal(evidence.blocked?.code,'STATE_V2_PARITY_MISMATCH_PRESERVED',
        'a mismatch must remain blocked rather than disappearing on retry');
      assert.equal(evidence.blocked?.evidence?.destructiveReseedBlocked,true);
      assert.ok(evidence.blocked.evidence.completionOrderDisagreements>0);
      assert.equal(evidence.blocked.evidence.v2OnlyCompletions,0);
      assert.equal(evidence.blocked.evidence.legacyOnlyCompletions,0);
      assert.equal(evidence.blocked.evidence.changedCompletions,0);
      const byId=rows=>rows.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      assert.deepEqual(byId(evidence.actual),byId(evidence.expected),
        'even an order-only disagreement must preserve exact completion contents');
      assert.notDeepEqual(evidence.actual.map(c=>c.id),evidence.expected.map(c=>c.id));
      assert.deepEqual(evidence.after,evidence.before,
        'an attempted same-generation seed must change zero V2 records');
      assert.equal(evidence.before.mutations.length,2);
      assert.equal(evidence.journal.length,2);
      assert.equal(evidence.wal.ok,true);
      assert.equal(evidence.wal.rows.length,0);
      assert.equal(evidence.authority,'legacy_only');
      safeOrderMismatch=true;
    }
    // Both test events have different canonical UTC timestamps. With V1's
    // timestamp ordering implemented, this must now produce actual parity;
    // the fail-closed diagnostic path above remains strictly non-destructive.
    assert.equal(safeOrderMismatch,false,
      'cross-tab writes with distinct timestamps must not leave an order mismatch');
    assert.equal(p?.match,true,'cross-tab WAL recovery must fully match V1');
    assert.equal(p.actualCounts.completions,2);
    const status=await first.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.wal.pendingCount,0);
    const journal=await first.evaluate(()=>window.TaskPointsCore.readPendingHabitDeltas());
    assert.equal(journal.length,2);
    return {concurrentWrites:2,recoveryReplayCount:status.bridge.replayCleared,
      durableLegacyDeltas:journal.length,parity:p?.match===true,
      strictOrderMismatchPreserved:safeOrderMismatch};
  });

  await run('temporary IndexedDB write failure keeps legacy journal and WAL until restart replay',async context=>{
    const page=await open(context);
    await page.evaluate(()=>{
      const original=IDBDatabase.prototype.transaction;
      window.__syntheticV2WriteFault=true;
      IDBDatabase.prototype.transaction=function(storeNames,mode,...options){
        if(window.__syntheticV2WriteFault && mode==='readwrite'){
          throw new DOMException('Synthetic V2 write unavailable','QuotaExceededError');
        }
        return original.call(this,storeNames,mode,...options);
      };
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
    });
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s?.bridge.failures>0 && s?.runtime.mirrorFailures>0;
    },null,{timeout:16000});
    const protectedRecords=await page.evaluate(()=>({
      status:window.V2BrowserFixture.status(),
      journal:window.TaskPointsCore.readPendingHabitDeltas()
    }));
    assert.equal(protectedRecords.status.wal.pendingCount,1);
    assert.equal(protectedRecords.journal.length,1);
    assert.equal(protectedRecords.journal[0].habitId,'h1');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount===0 && s.bridge.replayCleared>=1;
    },null,{timeout:20000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    const status=await page.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.bridge.failures,0);
    assert.equal(status.runtime.mirrorFailures,0);
    return {fault:'synthetic IDB readwrite rejection',walReplayed:status.bridge.replayCleared,
      legacyJournalPreserved:true,parity:p.match};
  });


  await run('48 rapid changes to one Habit/day preserve last-write-wins with no duplicate completion',async context=>{
    const page=await open(context);
    await page.evaluate(()=>{
      const f=window.V2BrowserFixture;
      for(let n=1;n<=48;n++){
        f.delta('h1','2026-10-20',['full','half','failed','off'][(n-1)%4],n);
      }
      f.delta('h2','2026-10-20','full',49);
      f.delta('h3','2026-10-20','half',50);
    });
    await settled(page,50);
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,2);
    const rows=await page.evaluate(async()=>{
      const r=window.TaskPointsStateRuntimeV2;
      return {h1:await r.getHabit('h1'),h1Completions:await r.getCompletionsForHabit('h1'),
        h2Completions:await r.getCompletionsForHabit('h2'),
        h3Completions:await r.getCompletionsForHabit('h3'),
        journal:window.TaskPointsCore.readPendingHabitDeltas()};
    });
    assert.equal(rows.h1Completions.length,0);
    assert.equal(rows.h1.doneKeys.includes('2026-10-20'),false);
    assert.equal(rows.h1.failedKeys.includes('2026-10-20'),false);
    assert.equal(rows.h2Completions.length,1);
    assert.equal(rows.h3Completions.length,1);
    assert.equal(rows.h3Completions[0].completionFraction,0.5);
    assert.equal(rows.journal.length,3,'legacy journal must coalesce repeated edits per Habit/day');
    assert.equal(rows.journal.find(x=>x.habitId==='h1').status,'off');
    return {rapidMutations:50,coalescedLegacyEntries:3,remainingCompletions:2,parity:p.match};
  });

  await run('legacy localStorage journal write rejection fails closed and never creates an orphan V2 WAL entry',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const oldSnapshot=localStorage.getItem(core.STORAGE_KEY);
      const oldJournal=localStorage.getItem(core.PENDING_HABIT_DELTAS_KEY);
      const generation=window.TaskPointsStateRuntimeV2Generation.read();
      const original=Storage.prototype.setItem;
      let caught=null;
      Storage.prototype.setItem=function(key,value){
        if(this===localStorage && String(key)==='taskpoints_pending_habit_deltas_v1')
          throw new DOMException('Synthetic journal quota denial','QuotaExceededError');
        return original.call(this,key,value);
      };
      try {
        try { window.V2BrowserFixture.delta('h1','2026-10-20','full',1); }
        catch(err) { caught={name:err.name,message:err.message}; }
      } finally { Storage.prototype.setItem=original; }
      return {caught,legacyUnchanged:localStorage.getItem(core.STORAGE_KEY)===oldSnapshot,
        journalUnchanged:localStorage.getItem('taskpoints_pending_habit_deltas_v1')===oldJournal,
        generationUnchanged:window.TaskPointsStateRuntimeV2Generation.read()===generation,
        wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows()};
    });
    assert.equal(evidence.caught?.name,'QuotaExceededError');
    assert.equal(evidence.legacyUnchanged,true);
    assert.equal(evidence.journalUnchanged,true);
    assert.equal(evidence.generationUnchanged,true);
    assert.equal(evidence.wal.ok,true);
    assert.equal(evidence.wal.rows.length,0,'a failed V1 journal write must not create a V2-only mutation');
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,0);
    return {legacyWriteRejected:true,walOrphans:0,generationUnchanged:true,parity:p.match};
  });


  await run('verified legacy compaction clears durable sidecars only after retaining pilot completions',async context=>{
    const page=await open(context);
    await page.evaluate(()=>{
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      window.V2BrowserFixture.delta('h2','2026-10-20','half',2);
    });
    await settled(page,2);
    const evidence=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const prefix='taskpoints_v2_habit_journal_event_v1:';
      const keys=()=>Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(key=>key.startsWith(prefix));
      const before=keys().length;
      const pending=core.readPendingHabitDeltas();
      const candidate=window.V2BrowserFixture.rawLegacy();
      core.applyPendingHabitDeltas(candidate,pending);
      core.saveStateSnapshot(candidate,{immediateWrite:true,replaceCompletions:true,
        savePath:'habit-journal-compaction'});
      const saved=window.V2BrowserFixture.rawLegacy();
      const verified=pending.filter(d=>saved.completions.some(c=>c.habitId===d.habitId && c.dayKey===d.dayKey));
      const removed=core.clearCompactedHabitDeltas(verified);
      return {before,pending:pending.length,removed,after:keys().length,
        primary:core.readPendingHabitDeltas().length,
        completions:window.V2BrowserFixture.rawLegacy().completions.filter(c=>c.source==='habit').length};
    });
    assert.equal(evidence.pending,2);
    assert.equal(evidence.before,2);
    assert.equal(evidence.after,0);
    assert.equal(evidence.primary,0);
    assert.equal(evidence.completions,2);
    const p=await parity(page);
    return {clearedSidecars:2,remainingPilotCompletions:2,parity:p.match};
  });

  await run('two real V1 journal compactions preserve V2 completion epochs and Habit day order across reload',async context=>{
    const page=await open(context);
    // First journal epoch: newer timestamp commits before older timestamp.
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-18','full',9));
    await settled(page,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-19','full',1));
    await settled(page,2);
    const compact=async p=>p.evaluate(()=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      const snapshot=window.V2BrowserFixture.rawLegacy();
      core.applyPendingHabitDeltas(snapshot,pending);
      const saved=core.saveStateSnapshot(snapshot,{immediateWrite:true,replaceCompletions:true,
        savePath:'habit-journal-compaction'});
      if(saved?.blocked||saved?.skipped)throw Error('V1 compaction did not save');
      const persisted=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas
        ? core.verifyPersistedHabitDeltas(persisted,pending,pending)
        : pending.filter(d=>persisted.completions.some(c=>c.habitId===d.habitId && c.dayKey===d.dayKey));
      core.clearCompactedHabitDeltas(verified);
      return {journalRemaining:core.readPendingHabitDeltas().length,
        compacted:verified.length,doneKeys:persisted.habits.find(h=>h.id==='h1').doneKeys};
    });
    const first=await compact(page);
    assert.equal(first.journalRemaining,0);
    assert.equal(first.compacted,2);
    assert.deepEqual(first.doneKeys,['2026-10-19','2026-10-18']);
    assert.equal((await parity(page)).match,true);

    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',5));
    await settled(page,3);
    let state=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const snapshot=await runtime.buildCompatibilitySnapshot();
      const db=await runtime.open();
      const tx=db.transaction(['habits','meta','mutations'],'readonly');
      const get=name=>new Promise((resolve,reject)=>{
        const r=tx.objectStore(name).getAll();
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const [habits,meta,mutations]=await Promise.all(['habits','meta','mutations'].map(get));
      return {doneKeys:snapshot.habits.find(h=>h.id==='h1').doneKeys,
        completionDays:snapshot.completions.filter(c=>c.habitId==='h1').map(c=>c.dayKey),
        epoch:meta[0].completionOrderEpoch,
        hints:Object.keys(habits.find(h=>h.id==='h1').journalDayOrder||{}),
        mutations:mutations.length};
    });
    assert.deepEqual(state.doneKeys,['2026-10-19','2026-10-18','2026-10-20']);
    assert.deepEqual(state.completionDays,['2026-10-20','2026-10-18','2026-10-19']);
    assert.equal(state.epoch,1);
    assert.deepEqual(state.hints,['2026-10-20']);
    assert.equal(state.mutations,3);
    assert.equal((await parity(page)).match,true);
    await page.reload({waitUntil:'load'});
    assert.equal((await parity(page)).match,true);

    const second=await compact(page);
    assert.equal(second.journalRemaining,0);
    assert.equal(second.compacted,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-21','full',2));
    await settled(page,1);
    const result=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const snapshot=await runtime.buildCompatibilitySnapshot();
      const db=await runtime.open();
      const tx=db.transaction('meta','readonly');
      const request=tx.objectStore('meta').get('runtime');
      const meta=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      return {doneKeys:snapshot.habits.find(h=>h.id==='h1').doneKeys,
        completionDays:snapshot.completions.filter(c=>c.habitId==='h1').map(c=>c.dayKey),
        epoch:meta.completionOrderEpoch};
    });
    assert.deepEqual(result.doneKeys,['2026-10-19','2026-10-18','2026-10-20','2026-10-21']);
    assert.deepEqual(result.completionDays,['2026-10-21','2026-10-20','2026-10-18','2026-10-19']);
    assert.equal(result.epoch,2);
    assert.equal((await parity(page)).match,true);
    return {verifiedCompactions:2,epochs:result.epoch,reloaded:true,
      canonicalDayOrder:result.doneKeys,parity:true};
  });

  await run('unrelated V1 task-only save cannot advance cross-Habit journal completion epoch',async context=>{
    const page=await open(context);
    const coreCompaction=()=> {
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      const snapshot=window.V2BrowserFixture.rawLegacy();
      core.applyPendingHabitDeltas(snapshot,pending);
      const result=core.saveStateSnapshot(snapshot,{immediateWrite:true,replaceCompletions:true,
        savePath:'habit-journal-compaction'});
      if(result?.skipped||result?.blocked)throw Error('canonical V1 checkpoint was not persisted');
      const saved=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas(saved,pending,pending);
      core.clearCompactedHabitDeltas(verified);
      return {compacted:verified.length,remaining:core.readPendingHabitDeltas().length};
    };
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-19','full',1));
    await settled(page,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-19','full',2));
    await settled(page,2);
    const first=await page.evaluate(coreCompaction);
    assert.deepEqual(first,{compacted:2,remaining:0});
    assert.equal((await parity(page)).match,true);

    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',9));
    await settled(page,3);
    // This uses the existing production V1 save path and changes only a Task,
    // not a Habit/completion. It must not mint an additional V2 ordering epoch.
    const unrelated=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const snapshot=window.V2BrowserFixture.rawLegacy();
      snapshot.tasks[0].title='Task-only title changed';
      const save=core.saveStateSnapshot(snapshot,{immediateWrite:true,replaceCompletions:true,
        savePath:'task-only-unrelated-save'});
      if(save?.skipped||save?.blocked)throw Error('unrelated V1 save was not persisted');
      return {pending:core.readPendingHabitDeltas().length,
        taskTitle:window.V2BrowserFixture.rawLegacy().tasks[0].title};
    });
    assert.equal(unrelated.pending,1);
    assert.equal(unrelated.taskTitle,'Task-only title changed');

    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-20','full',5));
    await settled(page,4);
    const data=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const snapshot=await runtime.buildCompatibilitySnapshot();
      const db=await runtime.open();
      const tx=db.transaction(['meta','habits','mutations'],'readonly');
      const read=name=>new Promise((resolve,reject)=>{
        const r=tx.objectStore(name).getAll();
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const [meta,habits,mutations]=await Promise.all(['meta','habits','mutations'].map(read));
      return {epoch:meta[0].completionOrderEpoch,
        completionIds:snapshot.completions.filter(c=>c.source==='habit').map(c=>c.id),
        ledgerRows:mutations.length,
        journalDays:habits.map(row=>({
          habitId:row.id,days:Object.keys(row.journalDayOrder||{})
        }))};
    });
    assert.equal(data.epoch,1,
      'a task-only V1 save cannot impersonate another Habit checkpoint');
    assert.deepEqual(data.completionIds,[
      'habit:h1:2026-10-20','habit:h2:2026-10-20',
      'habit:h2:2026-10-19','habit:h1:2026-10-19'
    ]);
    assert.equal(data.ledgerRows,4);
    assert.deepEqual(data.journalDays.filter(r=>r.days.length).map(r=>r.habitId).sort(),['h1','h2']);
    assert.equal((await parity(page)).match,true);
    await page.reload({waitUntil:'load'});
    assert.equal((await parity(page)).match,true);
    return {checkpointEpoch:data.epoch,preservedMutations:data.ledgerRows,
      checkpointSafeAcrossTwoHabits:true,unrelatedTaskSave:true,reloaded:true};
  });

  await run('old-generation V2 sidecar remains inspectable but cannot replay into a new generation',async context=>{
    const page=await open(context);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h3','2026-10-20','full',1));
    await settled(page,1);
    const result=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const prefix='taskpoints_v2_habit_journal_event_v1:';
      const sidecarKeys=()=>Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(key=>key.startsWith(prefix));
      const before=window.TaskPointsStateRuntimeV2Generation.read();
      const saved=sidecarKeys();
      // Simulate the canonical journal reset performed by a destructive
      // import/restore, isolating the sidecar's own epoch guard.
      localStorage.setItem(core.PENDING_HABIT_DELTAS_KEY,'[]');
      window.TaskPointsStateRuntimeV2Generation.rotate('synthetic-generation-transition');
      return {before,after:window.TaskPointsStateRuntimeV2Generation.read(),
        sidecarsBefore:saved.length,sidecarsAfter:sidecarKeys().length,
        legacyRows:core.readPendingHabitDeltas().length};
    });
    assert.notEqual(result.before,result.after);
    assert.equal(result.sidecarsBefore,1);
    assert.equal(result.sidecarsAfter,1,'preserve old sidecar evidence without replaying it');
    assert.equal(result.legacyRows,0);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await page.waitForFunction(async()=> (await window.TaskPointsStateRuntimeV2.getCompletionsForHabit('h3')).length===0);
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,0);
    return {staleEvidencePreserved:true,ignoredAcrossGeneration:true,parity:p.match};
  });


  await run('repeated overlapping writes in two tabs preserve every distinct V1 Habit/day event',async context=>{
    const first=await open(context),second=await open(context);
    const expectedIds=new Set();
    for(let day=1;day<=8;day++){
      const key='2026-09-'+String(day).padStart(2,'0');
      const [left,right]=await Promise.all([
        first.evaluate(([date,n])=>window.V2BrowserFixture.delta('h1',date,'full',n),[key,2*day-1]),
        second.evaluate(([date,n])=>window.V2BrowserFixture.delta('h2',date,'full',n),[key,2*day])
      ]);
      assert.equal(left.id,'habit:h1:'+key);
      assert.equal(right.id,'habit:h2:'+key);
      expectedIds.add(left.id);expectedIds.add(right.id);
    }
    // Cross-tab localStorage visibility may lag the writer's synchronous
    // return. Require eventual agreement in BOTH browsing contexts, without
    // lowering the 16/16 durability gate or masking a missing sidecar.
    const sync=page=>page.waitForFunction(n=>{
      const core=window.TaskPointsCore;
      const rows=core.readPendingHabitDeltas();
      const sidecars=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(key=>key.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return rows.length===n&&sidecars.length===n;
    },16,{timeout:12000,polling:75});
    await Promise.all([sync(first),sync(second)]);
    const read=page=>page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const rows=core.readPendingHabitDeltas();
      const events=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(key=>key.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      const eventRows=events.flatMap(key=>JSON.parse(localStorage.getItem(key)||'[]'));
      return {journalCount:rows.length,distinctDeltas:new Set(rows.map(r=>r.id)).size,
        h1:rows.filter(r=>r.habitId==='h1').length,
        h2:rows.filter(r=>r.habitId==='h2').length,sidecarCount:events.length,
        journalIds:rows.map(row=>row.id).sort(),sidecarIds:eventRows.map(row=>row.id).sort()};
    });
    const evidence=await read(first),other=await read(second);
    for(const view of [evidence,other]){
      assert.equal(view.journalCount,16,'no concurrent V1 journal entry may disappear');
      assert.equal(view.distinctDeltas,16);
      assert.equal(view.h1,8);
      assert.equal(view.h2,8);
      assert.equal(view.sidecarCount,16,'every original tap retains its own independent event key');
      assert.deepEqual(view.journalIds,[...expectedIds].sort());
      assert.deepEqual(view.sidecarIds,[...expectedIds].sort(),
        'each tap must remain independently durable, not merely present in the shared V1 key');
    }
    return {rounds:8,concurrentTaps:16,
      durableIndependentEvents:evidence.sidecarCount,legacyReadCount:evidence.journalCount,
      bothTabsVerified:true};
  });

  await run('forty-eight overlapping two-tab Habit writes survive mid-session tab reopen without losing a sidecar',async context=>{
    let first=await open(context),second=await open(context);
    const expected=new Set();
    const check=page=>page.waitForFunction(count=>{
      const rows=window.TaskPointsCore.readPendingHabitDeltas();
      const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(k=>k.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return rows.length===count&&keys.length===count;
    },expected.size,{timeout:18000,polling:75});
    for(let n=1;n<=24;n++){
      const date=n<=20
        ? '2026-09-'+String(n).padStart(2,'0')
        : '2026-10-'+String(n-20).padStart(2,'0');
      const [a,b]=await Promise.all([
        first.evaluate(([day,x])=>window.V2BrowserFixture.delta('h1',day,'full',x),[date,2*n-1]),
        second.evaluate(([day,x])=>window.V2BrowserFixture.delta('h2',day,'full',x),[date,2*n])
      ]);
      assert.equal(a.id,'habit:h1:'+date);
      assert.equal(b.id,'habit:h2:'+date);
      expected.add(a.id);expected.add(b.id);
      if(n%8===0){
        await Promise.all([check(first),check(second)]);
        if(n<24){
          // Do not clear V1 or compact the journal during the tab handoff.
          // The other tab remains live, exercising shared localStorage sidecars
          // and V2 IndexedDB/WAL startup across separate browsing contexts.
          await first.close();
          first=await open(context);
          await Promise.all([check(first),check(second)]);
        }
      }
    }
    const evidence=await Promise.all([first,second].map(page=>page.evaluate(()=>{
      const journal=window.TaskPointsCore.readPendingHabitDeltas();
      const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(k=>k.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return {authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority,
        ids:journal.map(row=>row.id).sort(),
        independent:keys.flatMap(key=>JSON.parse(localStorage.getItem(key)||'[]')).map(r=>r.id).sort(),
        duplicates:keys.length-new Set(keys).size};
    })));
    for(const tab of evidence){
      assert.equal(tab.authority,'legacy_only');
      assert.equal(tab.ids.length,48);
      assert.deepEqual(tab.ids,[...expected].sort());
      assert.deepEqual(tab.independent,[...expected].sort(),
        'all 48 separate sidecars must survive a tab reopening mid-session');
      assert.equal(tab.duplicates,0);
    }
    return {writes:48,tabReopens:2,distinctSidecars:48,checkedInBothTabs:true};
  });

  await run('missing V1 during five repeated two-tab reloads preserves V2 WAL evidence for recovery',async context=>{
    const first=await open(context);
    await first.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',9));
    await settled(first,1);
    const baseline=await first.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
      const all=name=>new Promise((resolve,reject)=>{
        const request=tx.objectStore(name).getAll();
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const rows=await Promise.all(['meta','habits','completions','mutations'].map(all));
      return {snapshot:JSON.stringify(rows),counts:rows.map(x=>x.length),
        source:localStorage.getItem('taskpoints_v1')};
    });
    assert.equal(baseline.counts[2],1);
    assert.equal(baseline.counts[3],1);
    // Model browser storage eviction without invoking TaskPoints' intentional
    // Reset All hook (which rightly rotates the V2 generation).
    await first.evaluate(()=>Storage.prototype.__taskPointsV2GenerationOriginalRemoveItem
      .call(localStorage,'taskpoints_v1'));

    for(let attempt=0;attempt<5;attempt++){
      const other=await open(context);
      const evidence=await other.evaluate(async()=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        let error=null;
        try { await runtime.seedFromLegacy(); }
        catch(e){ error={code:e.code,message:e.message}; }
        const db=await runtime.open();
        const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
        const all=name=>new Promise((resolve,reject)=>{
          const request=tx.objectStore(name).getAll();
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error);
        });
        const rows=await Promise.all(['meta','habits','completions','mutations'].map(all));
        return {error,snapshot:JSON.stringify(rows),v1Missing:localStorage.getItem('taskpoints_v1')===null,
          authority:runtime.getStatus().readAuthority};
      });
      assert.equal(evidence.error?.code,'STATE_V2_LEGACY_MISSING_PRESERVED');
      assert.equal(evidence.v1Missing,true);
      assert.equal(evidence.snapshot,baseline.snapshot,
        'neither a second tab nor another reload may rewrite V2 evidence');
      assert.equal(evidence.authority,'legacy_only');
      await other.close();
    }

    await first.evaluate(value=>localStorage.setItem('taskpoints_v1',value),baseline.source);
    const recovery=await open(context);
    const state=await recovery.evaluate(async()=>{
      const result=await window.TaskPointsStateRuntimeV2.seedFromLegacy();
      const db=await window.TaskPointsStateRuntimeV2.open();
      const tx=db.transaction(['mutations','completions'],'readonly');
      const all=name=>new Promise((resolve,reject)=>{
        const request=tx.objectStore(name).getAll();
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const [mutations,completions]=await Promise.all([all('mutations'),all('completions')]);
      return {reason:result.reason,mutations:mutations.length,
        completions:completions.length};
    });
    const match=await parity(recovery);
    assert.equal(state.mutations,1);
    assert.equal(state.completions,1);
    assert.ok(['verified_current','already_current','already_seeded_this_page'].includes(state.reason),
      'an already-completed startup adoption is also a valid recovery result');
    return {repeatedReloads:5,tabs:2,mutationsPreserved:state.mutations,
      completionsPreserved:state.completions,parity:match.match};
  });


  await run('three V2-only commits survive eight cross-tab reloads and recover when V1 catches up',async context=>{
    const writer=await open(context);
    const legacyBefore=await writer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const committed=await writer.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const results=[];
      for(let day=11;day<=13;day++){
        const dayKey='2026-10-'+String(day).padStart(2,'0');
        results.push(await runtime.applyHabitDelta({
          id:'habit:h1:'+dayKey,habitId:'h1',dayKey,source:'habit',
          status:'full',done:true,failed:false,icy:false,
          completionFraction:1,completionPoints:3,
          updatedAtISO:dayKey+'T12:00:00.000Z',
          completedAtISO:dayKey+'T12:00:00.000Z'
        }));
      }
      return results;
    });
    assert.equal(committed.every(result=>result.committed),true);
    assert.equal(await writer.evaluate(()=>localStorage.getItem('taskpoints_v1')),legacyBefore);
    // In this synthetic failure, V2 committed but a legacy checkpoint rolled
    // back. Read both stores without modifying either one.
    const inspect=async page=>page.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
      const all=name=>new Promise((resolve,reject)=>{
        const request=tx.objectStore(name).getAll();
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const [meta,habits,completions,mutations]=await Promise.all(
        ['meta','habits','completions','mutations'].map(all));
      return {meta,habits,completions,mutations};
    });
    const before=await inspect(writer);
    assert.equal(before.completions.length,3);
    assert.equal(before.mutations.length,3);

    for(let attempt=0;attempt<8;attempt++){
      const tab=await open(context);
      const error=await tab.evaluate(async()=>{
        try{await window.TaskPointsStateRuntimeV2.seedFromLegacy();return null;}
        catch(e){return {code:e.code,evidence:e.evidence};}
      });
      assert.equal(error?.code,'STATE_V2_PARITY_MISMATCH_PRESERVED');
      assert.equal(error?.evidence?.destructiveReseedBlocked,true);
      assert.equal(error?.evidence?.v2OnlyCompletions,3);
      assert.deepEqual(await inspect(tab),before,
        'new tabs must not overwrite unmatched V2 completion and mutation evidence');
      assert.equal((await tab.evaluate(()=>window.TaskPointsStateRuntimeV2.getStatus())).readAuthority,'legacy_only');
      await tab.close();
    }

    await writer.evaluate(async()=>{
      const recovered=await window.TaskPointsStateRuntimeV2.buildCompatibilitySnapshot();
      localStorage.setItem('taskpoints_v1',JSON.stringify(recovered));
    });
    const recoveredTab=await open(context);
    const adopted=await recoveredTab.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const seed=await runtime.seedFromLegacy();
      return {reason:seed.reason,parity:await runtime.verifyParity()};
    });
    const after=await inspect(recoveredTab);
    assert.ok(['verified_current','already_current','already_seeded_this_page'].includes(adopted.reason));
    assert.equal(adopted.parity.match,true);
    assert.deepEqual(after.habits,before.habits);
    assert.deepEqual(after.completions,before.completions);
    assert.deepEqual(after.mutations,before.mutations,
      'recovery must reuse the original mutation ledger, not rewrite it');
    return {v2OnlyWrites:3,repeatedReopens:8,mutationsRecovered:after.mutations.length,
      parity:adopted.parity.match};
  });

} finally {
  await writeFile(join(artifacts,'results.json'),JSON.stringify({ failures, results },null,2));
  await browser.close();
  await new Promise(done=>server.close(done));
}
if (failures) {
  console.error('Real-browser V2 gate failed: ' + failures + ' scenario(s)');
  process.exitCode = 1;
} else {
  console.log('Real-browser V2 gate passed: ' + results.length + ' scenarios');
}
