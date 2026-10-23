import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const artifacts = join(root, 'v2-browser-artifacts');
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
const browser = await chromium.launch({ headless: true });
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
      f.delta('h1', '2026-10-21', 'full', 1);
      f.delta('h2', '2026-10-21', 'full', 2);
      f.delta('h3', '2026-10-21', 'full', 3);
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
    const p=await parity(first);
    assert.equal(p.actualCounts.completions,2);
    const status=await first.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.wal.pendingCount,0);
    const journal=await first.evaluate(()=>window.TaskPointsCore.readPendingHabitDeltas());
    assert.equal(journal.length,2);
    return {concurrentWrites:2,recoveryReplayCount:status.bridge.replayCleared,
      durableLegacyDeltas:journal.length,parity:p.match};
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
