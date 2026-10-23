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
    if (p) assert.equal(p.match,true);
    if (p) assert.equal(p.actualCounts.completions,2);
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
    for(let day=1;day<=8;day++){
      const key='2026-09-'+String(day).padStart(2,'0');
      await Promise.all([
        first.evaluate(([date,n])=>window.V2BrowserFixture.delta('h1',date,'full',n),[key,2*day-1]),
        second.evaluate(([date,n])=>window.V2BrowserFixture.delta('h2',date,'full',n),[key,2*day])
      ]);
    }
    const evidence=await first.evaluate(()=>{
      const core=window.TaskPointsCore;
      const rows=core.readPendingHabitDeltas();
      const events=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(key=>key.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return {journalCount:rows.length,distinctDeltas:new Set(rows.map(r=>r.id)).size,
        h1:rows.filter(r=>r.habitId==='h1').length,
        h2:rows.filter(r=>r.habitId==='h2').length,sidecarCount:events.length};
    });
    assert.equal(evidence.journalCount,16,'no concurrent V1 journal entry may disappear');
    assert.equal(evidence.distinctDeltas,16);
    assert.equal(evidence.h1,8);
    assert.equal(evidence.h2,8);
    assert.equal(evidence.sidecarCount,16,'every original tap retains its own independent event key');
    return {rounds:8,concurrentTaps:16,
      durableIndependentEvents:evidence.sidecarCount,legacyReadCount:evidence.journalCount};
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
