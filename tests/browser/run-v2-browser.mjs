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

  await run('blocked V2 upgrade safely refuses stale open and retries after other tab releases v1', async context => {
    const legacyPage=await context.newPage();
    const seedUrl=url.replace('v2-storage-fixture.html','v2-upgrade-seed.html');
    await legacyPage.goto(seedUrl,{waitUntil:'load'});
    await legacyPage.evaluate(()=>window.makeOldV2Fixture());
    const legacyBefore=await legacyPage.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const held=await legacyPage.evaluate(async ()=>{
      window.__v1VersionChanges=0;
      window.__v1Connection=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_state_v2',1);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      window.__v1Connection.onversionchange=()=>{window.__v1VersionChanges++;};
      return window.__v1Connection.version;
    });
    assert.equal(held,1);
    const candidatePage=await context.newPage();
    await candidatePage.goto(seedUrl,{waitUntil:'load'});
    // Load runtime with dark mode off: no background seed races with the
    // explicit upgrade attempt held by the other tab.
    await candidatePage.evaluate(()=>localStorage.setItem('taskpoints_state_v2_dark_mode_v1','0'));
    await candidatePage.addScriptTag({url:'/state_runtime_v2.js'});
    const refused=await candidatePage.evaluate(async()=>{
      localStorage.setItem('taskpoints_state_v2_dark_mode_v1','1');
      try {
        await window.TaskPointsStateRuntimeV2.open();
        return {refused:false};
      } catch(error) {
        return {refused:true,reason:String(error?.message||error),
          authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority,
          legacy:localStorage.getItem('taskpoints_v1')};
      }
    });
    assert.equal(refused.refused,true,JSON.stringify(refused));
    assert.equal(refused.reason,'state_runtime_v2_open_blocked');
    assert.equal(refused.authority,'legacy_only');
    assert.equal(refused.legacy,legacyBefore);
    await legacyPage.waitForFunction(()=>window.__v1VersionChanges>0,null,{timeout:12000});
    await legacyPage.evaluate(()=>window.__v1Connection.close());
    // Once the aborted late upgrade is resolved, the next explicit attempt
    // must still be able to acquire the V2 database and repair legacy packs.
    const retry=await candidatePage.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const read=req=>new Promise((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const all=await read(db.transaction('completions','readonly').objectStore('completions').getAll());
      const fromIndex=await read(db.transaction('completions','readonly')
        .objectStore('completions').index('by_habit_ids').getAll('h2'));
      return {version:db.version,habitIds:all[0]?.habitIds,
        sharedIndexRows:fromIndex.map(row=>row.id),
        legacy:localStorage.getItem('taskpoints_v1'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(retry.version,2);
    assert.deepEqual(retry.habitIds,['h1','h2']);
    assert.deepEqual(retry.sharedIndexRows,['shared-old']);
    assert.equal(retry.legacy,legacyBefore);
    assert.equal(retry.authority,'legacy_only');
    return {blockedUpgradeRejected:true,recoveredAfterClose:true,
      crossHabitDuplicatesRetained:true,legacyAuthorityPreserved:true};
  });

  await run('cross-tab V2 schema update invalidates stale reader while retaining V1', async context => {
    const page=await open(context);
    const before=await page.evaluate(async()=>{
      return {candidate:await window.TaskPointsStateRuntimeV2.readPilotHabitCandidate('h1'),
        legacy:localStorage.getItem('taskpoints_v1'),
        wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length};
    });
    assert.equal(before.candidate.eligible,true);
    const upgrader=await context.newPage();
    await upgrader.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),{waitUntil:'load'});
    const newVersion=await upgrader.evaluate(()=>new Promise((resolve,reject)=>{
      const req=indexedDB.open('taskpoints_state_v2',3);
      req.onupgradeneeded=()=>{};
      req.onsuccess=()=>{const v=req.result.version;req.result.close();resolve(v);};
      req.onerror=()=>reject(req.error);
      req.onblocked=()=>reject(Error('existing V2 runtime refused to close for upgrade'));
    }));
    assert.equal(newVersion,3);
    await page.waitForFunction(()=>window.TaskPointsStateRuntimeV2.getStatus().externalRevisionInvalidated,
      null,{timeout:10000});
    const stale=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const candidate=await runtime.readPilotHabitCandidate('h1');
      let openFailure=null;
      try{await runtime.open();}
      catch(error){openFailure=String(error?.name||error);}
      return {candidate,openFailure,
        legacy:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority,
        wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length};
    });
    assert.equal(stale.candidate.eligible,false);
    assert.equal(stale.candidate.reason,'external_revision_invalidated');
    assert.equal(Object.hasOwn(stale.candidate,'habit'),false);
    assert.ok(stale.openFailure,'stale version-2 open must not reopen a version-3 database');
    assert.equal(stale.legacy,before.legacy);
    assert.equal(stale.wal,before.wal);
    assert.equal(stale.authority,'legacy_only');
    return {oldConnectionReleased:true,staleReaderRejected:true,
      newerSchemaUntouched:true,v1Retained:true};
  });

  await run('real IndexedDB v1-to-v2 upgrade backfills cross-Habit completion index atomically', async context => {
    const page=await context.newPage();
    page.on('pageerror',err=>console.warn('Upgrade fixture error: '+err.message));
    await page.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),{waitUntil:'load'});
    await page.evaluate(()=>window.makeOldV2Fixture());
    const before=await page.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    // Keep dark disabled while the runtime script loads so only this test,
    // not background startup seeding, initiates and observes the upgrade.
    await page.addScriptTag({url:'/state_runtime_v2.js'});
    const changed=await page.evaluate(async ()=>{
      localStorage.setItem('taskpoints_state_v2_dark_mode_v1','1');
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const tx=db.transaction('completions','readonly');
      const store=tx.objectStore('completions');
      const get=(req)=>new Promise((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error);
      });
      const all=await get(store.getAll());
      const h1=await get(db.transaction('completions','readonly')
        .objectStore('completions').index('by_habit_ids').getAll('h1'));
      const h2=await get(db.transaction('completions','readonly')
        .objectStore('completions').index('by_habit_ids').getAll('h2'));
      return {version:db.version,indexPresent:store.indexNames.contains('by_habit_ids'),
        entries:all[0].entries,habitIds:all[0].habitIds,
        h1:h1.map(r=>r.id),h2:h2.map(r=>r.id),
        authority:runtime.getStatus().readAuthority,
        legacy:localStorage.getItem('taskpoints_v1')};
    });
    assert.equal(changed.version,2);
    assert.equal(changed.indexPresent,true);
    assert.deepEqual(changed.habitIds,['h1','h2']);
    assert.deepEqual(changed.h1,['shared-old']);
    assert.deepEqual(changed.h2,['shared-old']);
    assert.deepEqual(changed.entries.map(e=>e.value.points),[4,5]);
    assert.equal(changed.legacy,before);
    assert.equal(changed.authority,'legacy_only');
    return {oldVersionUpgraded:true,crossHabitDuplicatePreserved:true,
      indexedBothHabits:true,legacyUnchanged:true};
  });

  await run('completion pack index metadata remains nonauthoritative and reports legacy gaps', async context => {
    const page = await open(context);
    const initial = await page.evaluate(() => window.TaskPointsStateRuntimeV2.inspectPilotCompletionIndexCoverage());
    assert.equal(initial.indexReady, true, JSON.stringify(initial));
    assert.deepEqual(initial.counts, {total:0,complete:0,missing:0,mismatched:0});
    await page.evaluate(() => {
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      window.V2BrowserFixture.delta('h2','2026-10-20','half',2);
    });
    await settled(page, 2);
    const saved = await page.evaluate(async () => {
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const req=db.transaction('completions','readonly').objectStore('completions').getAll();
      const rows=await new Promise((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      return {report:await runtime.inspectPilotCompletionIndexCoverage(),
        rows:rows.map(r=>({id:r.id,habitIds:r.habitIds})),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(saved.report.indexReady,true,JSON.stringify(saved.report));
    assert.equal(saved.report.counts.total,2);
    assert.deepEqual(saved.rows.map(row=>row.habitIds).sort(),[['h1'],['h2']]);
    assert.equal(saved.authority,'legacy_only');
    const indexed=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.readPilotHabitCandidate('h1'));
    assert.equal(indexed.eligible,true,JSON.stringify(indexed));
    assert.equal(indexed.lookupMode,'indexed');
    const legacyGap=await page.evaluate(async ()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const store=db.transaction('completions','readonly').objectStore('completions');
      const row=await new Promise((resolve,reject)=>{
        const req=store.get('habit:h1:2026-10-20');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      delete row.habitIds;
      const tx=db.transaction('completions','readwrite');
      tx.objectStore('completions').put(row);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      return {report:await runtime.inspectPilotCompletionIndexCoverage(),
        candidate:await runtime.readPilotHabitCandidate('h1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(legacyGap.report.indexReady,false);
    assert.equal(legacyGap.report.reason,'metadata_backfill_required');
    assert.equal(legacyGap.report.counts.missing,1);
    assert.equal(legacyGap.candidate.eligible,true,
      'legacy completion scan must continue working before metadata backfill');
    assert.equal(legacyGap.candidate.lookupMode,'legacy_scan');
    assert.deepEqual(legacyGap.candidate.completions.map(c=>c.id),['habit:h1:2026-10-20']);
    assert.equal(legacyGap.authority,'legacy_only');
    return {metadataCreated:true,legacyGapsDiagnosed:true,oldReadersUnchanged:true};
  });

  await run('pilot read readiness is preview-only, read-only, and refuses pending WAL', async context => {
    const page = await open(context);
    const before = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      const db = await runtime.open();
      const getMeta = () => new Promise((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get('runtime');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return {
        result: await runtime.inspectPilotReadiness(),
        meta: await getMeta(),
        legacy: localStorage.getItem(window.TaskPointsCore.STORAGE_KEY),
        authority: runtime.getStatus().readAuthority
      };
    });
    assert.equal(before.result.eligible, true, JSON.stringify(before.result));
    assert.equal(before.result.reason, 'pilot_consistent');
    assert.equal(before.result.readAuthority, 'legacy_only');
    assert.equal(before.authority, 'legacy_only');
    assert.equal(before.result.counts.habits, 3);
    const held = await page.evaluate(async () => {
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1', '1');
      window.V2BrowserFixture.delta('h1', '2026-10-20', 'full', 1);
      const pending = window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      return { pending: pending.rows.length,
        gate: await window.TaskPointsStateRuntimeV2.inspectPilotReadiness(),
        authority: window.TaskPointsStateRuntimeV2.getStatus().readAuthority };
    });
    assert.equal(held.pending, 1);
    assert.equal(held.gate.eligible, false);
    assert.equal(held.gate.reason, 'wal_pending');
    assert.equal(held.authority, 'legacy_only');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.V2BrowserFixture?.status()?.wal.pendingCount === 0,
      null, { timeout: 25000 });
    const after = await page.evaluate(async () =>
      window.TaskPointsStateRuntimeV2.inspectPilotReadiness());
    assert.equal(after.eligible, true, JSON.stringify(after));
    assert.equal(after.readAuthority, 'legacy_only');
    return {healthyPilotEligible:true, pendingWalRefused:true,
      restartRecovered:true, authorityUnchanged:true};
  });

  await run('pilot read gate refuses same-generation V1 differences and unreadable WAL without writes', async context => {
    const page = await open(context);
    const checked = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      const core = window.TaskPointsCore;
      const originalRaw = localStorage.getItem(core.STORAGE_KEY);
      const first = await runtime.inspectPilotReadiness();
      const changed = core.parseTaskPointsStorageJson(originalRaw, {});
      changed.habits[0].name = 'Synthetic external V1 edit';
      const changedRaw = JSON.stringify(changed);
      localStorage.setItem(core.STORAGE_KEY, changedRaw);
      const mismatch = await runtime.inspectPilotReadiness();
      const preserved = localStorage.getItem(core.STORAGE_KEY) === changedRaw;
      localStorage.setItem(core.STORAGE_KEY, originalRaw);
      const sharedKey = 'taskpoints_v2_pending_mutations_v1';
      const originalGet = Storage.prototype.getItem;
      let unreadable = null;
      Storage.prototype.getItem = function(key) {
        if (this === localStorage && String(key) === sharedKey)
          throw new DOMException('Synthetic WAL inspection failure', 'SecurityError');
        return originalGet.call(this, key);
      };
      try { unreadable = await runtime.inspectPilotReadiness(); }
      finally { Storage.prototype.getItem = originalGet; }
      const recovered = await runtime.inspectPilotReadiness();
      return {first, mismatch, preserved, unreadable, recovered,
        legacyUnchanged: localStorage.getItem(core.STORAGE_KEY) === originalRaw,
        authority: runtime.getStatus().readAuthority};
    });
    assert.equal(checked.first.eligible, true);
    assert.equal(checked.mismatch.eligible, false);
    assert.equal(checked.mismatch.reason, 'pilot_parity_mismatch');
    assert.equal(checked.preserved, true);
    assert.equal(checked.unreadable.eligible, false);
    assert.equal(checked.unreadable.reason, 'wal_unreadable');
    assert.equal(checked.recovered.eligible, true, JSON.stringify(checked.recovered));
    assert.equal(checked.legacyUnchanged, true);
    assert.equal(checked.authority, 'legacy_only');
    return {parityMismatchBlocked:true, storageDenialBlocked:true,
      recoveredWithoutReseeding:true, authorityUnchanged:true};
  });

  await run('persisted cross-tab revision signal denies preview even with no storage event delivery', async context => {
    const page=await open(context);
    const evidence=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      runtime.setPilotReadProbeEnabled(true);
      const healthy=await runtime.probePilotHabitRead('h1');
      const before=runtime.getStatus();
      const legacy=localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      // Same-tab setItem does NOT dispatch a storage event to its origin;
      // only the durable revision probe can detect this foreign signal.
      localStorage.setItem(before.revisionSignalKey,JSON.stringify({
        sourceId:'synthetic-other-tab-notification-lost',
        revision:Number(before.lastKnownRevision||0)+1,
        generation:before.currentGeneration,
        epochMs:Date.now()+10000,
        atISO:new Date().toISOString()
      }));
      const inspection=await runtime.inspectPilotReadiness();
      const candidate=await runtime.probePilotHabitRead('h1');
      return {healthy,inspection,candidate,status:runtime.getStatus(),
        v1Unchanged:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)===legacy};
    });
    assert.equal(evidence.healthy.matched,true,JSON.stringify(evidence.healthy));
    assert.equal(evidence.inspection.eligible,false);
    assert.equal(evidence.inspection.reason,'external_revision_invalidated');
    assert.equal(evidence.candidate.matched,false);
    assert.equal(evidence.candidate.reason,'external_revision_invalidated');
    assert.equal(evidence.candidate.selectedSource,'legacy_only');
    assert.equal(Object.hasOwn(evidence.candidate,'habit'),false);
    assert.equal(evidence.status.externalRevisionSource,'persisted_signal');
    assert.equal(evidence.status.readAuthority,'legacy_only');
    assert.equal(evidence.v1Unchanged,true);
    return {missedNotificationDetected:true,staleReadRejected:true,noAuthorityChange:true};
  });

  await run('denied persisted revision signal reads refuse preview and recover when storage returns', async context => {
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const originalV1=localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      const initial=await runtime.inspectPilotReadiness();
      const signalKey=runtime.getStatus().revisionSignalKey;
      const originalGet=Storage.prototype.getItem;
      let denied,blockedCandidate;
      Storage.prototype.getItem=function(key){
        if(this===localStorage && String(key)===signalKey)
          throw new DOMException('synthetic revision key denial','SecurityError');
        return originalGet.call(this,key);
      };
      try{
        denied=await runtime.inspectPilotReadiness();
        blockedCandidate=await runtime.readPilotHabitCandidate('h1');
      }finally{Storage.prototype.getItem=originalGet;}
      return {initial,denied,blockedCandidate,
        healthy:await runtime.inspectPilotReadiness(),
        v1Unchanged:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)===originalV1,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.initial.eligible,true);
    assert.equal(proof.denied.eligible,false);
    assert.equal(proof.denied.reason,'revision_signal_unreadable');
    assert.equal(proof.blockedCandidate.eligible,false);
    assert.equal(proof.blockedCandidate.reason,'revision_signal_unreadable');
    assert.equal(Object.hasOwn(proof.blockedCandidate,'habit'),false);
    assert.equal(proof.healthy.eligible,true,JSON.stringify(proof.healthy));
    assert.equal(proof.v1Unchanged,true);
    assert.equal(proof.authority,'legacy_only');
    return {deniedReadFailsClosed:true,recoveryWithoutRebuild:true,legacyOnly:true};
  });

  await run('exclusive-writer lock rehearsal denies competing tabs and releases safely without promotion', async context => {
    const candidate=await open(context);
    const initial=await candidate.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      return {source:localStorage.getItem('taskpoints_v1'),
        lockSupported:typeof navigator.locks?.request==='function',
        rollback:await runtime.inspectLegacyRollbackSource(),
        before:await runtime.inspectPilotReadiness()};
    });
    assert.equal(initial.rollback.sourceStable,true);
    assert.equal(initial.before.eligible,true,JSON.stringify(initial.before));
    if(!initial.lockSupported){
      const failClosed=await candidate.evaluate(()=>
        window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
      assert.equal(failClosed.reason,'lock_manager_unavailable');
      assert.equal(failClosed.canPromote,false);
      assert.equal(failClosed.mutationAuthority,'legacy_only');
      return {unsupportedSafely:true,authority:'legacy_only'};
    }
    const holder=await context.newPage();
    await holder.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    await holder.evaluate(()=>new Promise((resolve,reject)=>{
      window.__lockRehearsalReleased=false;
      navigator.locks.request('taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive'},async(lock)=>{
          window.__releaseExclusiveTestLock=null;
          resolve(true);
          await new Promise(done=>{window.__releaseExclusiveTestLock=done;});
        }).then(()=>{window.__lockRehearsalReleased=true;}).catch(reject);
    }));
    const busy=await candidate.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
    assert.equal(busy.lockAcquired,false);
    assert.equal(busy.reason,'lock_held_elsewhere',JSON.stringify(busy));
    assert.equal(busy.mutationAuthority,'legacy_only');
    assert.equal(busy.canPromote,false);
    await holder.evaluate(()=>window.__releaseExclusiveTestLock());
    await holder.waitForFunction(()=>window.__lockRehearsalReleased===true,null,{timeout:12000});
    // Once the other tab relinquishes the lock, a fresh read-only proof
    // may run. It must release immediately and never turn into a live lease.
    const successful=await candidate.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
    assert.equal(successful.lockAcquired,true,JSON.stringify(successful));
    assert.equal(successful.lockHeldAfterReturn,false);
    assert.equal(successful.canPromote,false);
    assert.equal(successful.rollbackSourceStable,true);
    assert.equal(successful.mutationAuthority,'legacy_only');
    const after=await candidate.evaluate(()=>({
      source:localStorage.getItem('taskpoints_v1'),
      status:window.TaskPointsStateRuntimeV2.getStatus()
    }));
    assert.equal(after.source,initial.source);
    assert.equal(after.status.readAuthority,'legacy_only');
    return {lockConflictDetected:true,releaseRecovered:true,
      v1Unchanged:true,noAuthorityPromotion:true};
  });

  await run('explicit serialized lease protects a real V1 snapshot save against participating peers',async context=>{
    const writer=await open(context),peer=await open(context);
    const legacy=await context.newPage();
    await legacy.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const supported=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const refused=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(refused.reason,'lock_manager_unavailable');
      assert.equal(refused.canPromote,false);
      return {unsupportedFailClosed:true};
    }
    const initial=await peer.evaluate(()=>window.V2BrowserFixture.rawLegacy());
    assert.equal(initial.tasks.length,1);
    assert.equal(initial.completions.length,1);
    const expectedRaw=await writer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=writer.evaluate(expectedRaw=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_serialized_snapshot_holder_ready','ready');
        await new Promise(resolve=>{window.__releaseV2SnapshotWriter=resolve;});
        // Read the latest legacy snapshot *inside* the exclusive lock.
        // Existing synchronous save behavior and safety wrappers are reused.
        const core=window.TaskPointsCore;
        const candidate=window.V2BrowserFixture.rawLegacy();
        candidate.tasks.push({id:'v2-serialized-fixture-task',title:'Serialized fixture task'});
        guard.assertPreviewLegacySnapshotUnchanged(expectedRaw);
        const result=core.saveStateSnapshot(candidate,{
          storageKey:core.STORAGE_KEY,immediateWrite:true,userInitiated:true,
          savePath:'v2-explicit-serialized-fixture'
        });
        if(result?.skipped || result?.blocked || result?.saved===false)
          throw Error('synthetic_snapshot_save_rejected');
        const saved=window.V2BrowserFixture.rawLegacy();
        if(!saved.tasks.some(task=>task.id==='v2-serialized-fixture-task'))
          throw Error('synthetic_snapshot_save_not_durable');
      }),expectedRaw);
    await peer.waitForFunction(()=>
      localStorage.getItem('v2_serialized_snapshot_holder_ready')==='ready',
      null,{timeout:12000});
    const busyShared=await peer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
    const busyExclusive=await peer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
    assert.equal(busyShared.reason,'lock_held_elsewhere');
    assert.equal(busyShared.operationRan,false);
    assert.equal(busyExclusive.reason,'lock_held_elsewhere');
    assert.equal(busyExclusive.operationRan,false);
    // Existing uncooperative pages are not fenced by this prototype.
    await legacy.evaluate(()=>
      localStorage.setItem('tp_projects_v1','legacy-only-unfenced-project-update'));
    await writer.evaluate(()=>window.__releaseV2SnapshotWriter());
    const completed=await pending;
    assert.equal(completed.reason,'serialized_snapshot_rehearsed',JSON.stringify(completed));
    assert.equal(completed.exclusiveLockAcquired,true);
    assert.equal(completed.operationRan,true);
    assert.equal(completed.lockHeldAfterReturn,false);
    assert.equal(completed.canPromote,false);
    assert.equal(completed.productionWritersFenced,false);
    assert.equal(completed.allLegacyWritersKnown,false);
    const after=await peer.evaluate(()=>({
      state:window.V2BrowserFixture.rawLegacy(),
      project:localStorage.getItem('tp_projects_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.state.tasks.length,2);
    assert.equal(after.state.tasks[0].id,initial.tasks[0].id);
    assert.ok(after.state.tasks.some(task=>task.id==='v2-serialized-fixture-task'));
    assert.equal(after.state.completions.length,initial.completions.length);
    assert.equal(after.state.completions[0].id,initial.completions[0].id);
    assert.equal(after.project,'legacy-only-unfenced-project-update');
    assert.equal(after.authority,'legacy_only');
    return {realSnapshotSavePersisted:true,originalTaskAndCompletionKept:true,
      sharedAndExclusivePeersBlocked:true,unfencedLegacyPageStillWrites:true,
      noAuthorityChange:true};
  });

  await run('serialized legacy snapshot rehearsal aborts before V1 write after cross-tab generation rotation',async context=>{
    const writer=await open(context),other=await open(context);
    const supported=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const original=await other.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_serialized_generation_holder_ready','ready');
        await new Promise(resolve=>{window.__releaseV2SerializedGeneration=resolve;});
        const core=window.TaskPointsCore;
        const candidate=window.V2BrowserFixture.rawLegacy();
        candidate.tasks.push({id:'stale-serialized-fixture-task',title:'Must not persist'});
        guard.assertPreviewGenerationCurrent();
        core.saveStateSnapshot(candidate,{
          storageKey:core.STORAGE_KEY,immediateWrite:true,userInitiated:true,
          savePath:'v2-stale-serialized-fixture'
        });
      }));
    await other.waitForFunction(()=>
      localStorage.getItem('v2_serialized_generation_holder_ready')==='ready',
      null,{timeout:12000});
    const newGeneration=await other.evaluate(()=>{
      const next='v2-serialized-generation-change:'+crypto.randomUUID();
      localStorage.setItem('taskpoints_state_v2_generation_v1',next);
      return next;
    });
    // A completed storage write from another WebKit document does not
    // guarantee that this suspended document sees it immediately.
    await writer.waitForFunction(expected=>
      localStorage.getItem('taskpoints_state_v2_generation_v1')===expected,
      newGeneration,{timeout:12000});
    await writer.evaluate(()=>window.__releaseV2SerializedGeneration());
    const blocked=await pending;
    assert.equal(blocked.reason,'serialized_operation_generation_invalidated',
      JSON.stringify(blocked));
    assert.equal(blocked.exclusiveLockAcquired,true);
    assert.equal(blocked.operationRan,true);
    assert.equal(blocked.lockHeldAfterReturn,false);
    assert.equal(blocked.canPromote,false);
    assert.equal(blocked.productionWritersFenced,false);
    const after=await other.evaluate(async()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      released:await navigator.locks.request(
        'taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive',ifAvailable:true},lock=>Boolean(lock)),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.raw,original);
    assert.equal(after.released,true);
    assert.equal(after.authority,'legacy_only');
    return {staleSnapshotNotWritten:true,exclusiveLockReleased:true,
      legacyStateByteIdentical:true,noAuthorityChange:true};
  });

  await run('serialized snapshot source guard rejects stale writer after unfenced V1 save',async context=>{
    const writer=await open(context),legacy=await open(context);
    const supported=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const rejected=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(rejected.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const sourceRaw=await writer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=writer.evaluate(raw=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_stale_snapshot_guard_waiting','ready');
        await new Promise(resolve=>{window.__resumeStaleSnapshotWriter=resolve;});
        const core=window.TaskPointsCore;
        const staleCandidate=core.parseTaskPointsStorageJson(raw,{});
        staleCandidate.tasks.push({id:'stale-overwriter',title:'Must never overwrite'});
        guard.assertPreviewLegacySnapshotUnchanged(raw);
        core.saveStateSnapshot(staleCandidate,{
          storageKey:core.STORAGE_KEY,immediateWrite:true,userInitiated:true,
          savePath:'v2-stale-overwriter-should-never-save'
        });
      }),sourceRaw);
    await legacy.waitForFunction(()=>
      localStorage.getItem('v2_stale_snapshot_guard_waiting')==='ready',
      null,{timeout:12000});
    // A separate Home-like save intentionally DOES NOT participate in the
    // Web Lock. It must persist, and the older snapshot must not clobber it.
    const current=await legacy.evaluate(()=>{
      const core=window.TaskPointsCore;
      const fresh=core.readTaskPointsStoredState();
      fresh.tasks.push({id:'unfenced-latest-task',title:'Fresh legacy task'});
      const outcome=core.saveStateSnapshot(fresh,{
        storageKey:core.STORAGE_KEY,immediateWrite:true,userInitiated:true,
        savePath:'v2-unfenced-legacy-fixture'
      });
      return {skipped:outcome?.skipped===true,
        raw:localStorage.getItem(core.STORAGE_KEY)};
    });
    assert.equal(current.skipped,false);
    assert.notEqual(current.raw,sourceRaw);
    await writer.evaluate(()=>window.__resumeStaleSnapshotWriter());
    const result=await pending;
    assert.equal(result.reason,'serialized_operation_snapshot_changed',JSON.stringify(result));
    assert.equal(result.exclusiveLockAcquired,true);
    assert.equal(result.operationRan,true);
    assert.equal(result.lockHeldAfterReturn,false);
    assert.equal(result.canPromote,false);
    assert.equal(result.productionWritersFenced,false);
    const after=await legacy.evaluate(async()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      state:window.V2BrowserFixture.rawLegacy(),
      lockFree:await navigator.locks.request(
        'taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive',ifAvailable:true},lock=>Boolean(lock)),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.raw,current.raw);
    assert.ok(after.state.tasks.some(t=>t.id==='unfenced-latest-task'));
    assert.ok(!after.state.tasks.some(t=>t.id==='stale-overwriter'));
    assert.equal(after.state.completions[0].id,'synthetic-task-completion');
    assert.equal(after.lockFree,true);
    assert.equal(after.authority,'legacy_only');
    return {staleSnapshotRefused:true,unfencedV1SavePreserved:true,
      unrelatedCompletionRetained:true,lockReleased:true};
  });

  await run('serialized snapshot source guard denies unreadable state and missing tokens',async context=>{
    const page=await open(context);
    const supported=await page.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const rejected=await page.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(rejected.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const checks=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const storage=localStorage;
      const originalRaw=storage.getItem('taskpoints_v1');
      const noToken=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
        guard.assertPreviewLegacySnapshotUnchanged(null));
      const originalGet=Storage.prototype.getItem;
      let denied;
      Storage.prototype.getItem=function(key){
        if(this===storage && key==='taskpoints_v1')
          throw new DOMException('synthetic v1 storage denial','SecurityError');
        return originalGet.call(this,key);
      };
      try{
        denied=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
          guard.assertPreviewLegacySnapshotUnchanged(originalRaw));
      }finally{Storage.prototype.getItem=originalGet;}
      return {noToken,denied,
        v1Unchanged:storage.getItem('taskpoints_v1')===originalRaw,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(checks.noToken.reason,'serialized_operation_snapshot_token_required');
    assert.equal(checks.denied.reason,'serialized_operation_snapshot_unreadable');
    assert.equal(checks.denied.canPromote,false);
    assert.equal(checks.denied.exclusiveLockAcquired,true);
    assert.equal(checks.v1Unchanged,true);
    assert.equal(checks.authority,'legacy_only');
    return {missingSnapshotTokenFailsClosed:true,unreadableSourceFailsClosed:true,
      v1Unchanged:true,noAuthorityPromotion:true};
  });

  await run('serialized snapshot guard refuses newer Task journal without a snapshot change',async context=>{
    const writer=await open(context),legacy=await open(context);
    const supported=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const tokens=await writer.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1')
    }));
    const pending=writer.evaluate(source=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_pending_task_snapshot_guard_waiting','ready');
        await new Promise(resolve=>{window.__resumePendingTaskGuard=resolve;});
        const stale=window.TaskPointsCore.parseTaskPointsStorageJson(source.raw,{});
        stale.tasks.push({id:'stale-overwriting-task',title:'Must not persist'});
        guard.assertPreviewLegacySnapshotUnchanged(source.raw);
        guard.assertPreviewPrimaryJournalsUnchanged(source);
        window.TaskPointsCore.saveStateSnapshot(stale,{
          storageKey:'taskpoints_v1',immediateWrite:true,userInitiated:true,
          savePath:'v2-stale-task-journal-guard-fixture'
        });
      }),tokens);
    await legacy.waitForFunction(()=>
      localStorage.getItem('v2_pending_task_snapshot_guard_waiting')==='ready',
      null,{timeout:12000});
    const added=await legacy.evaluate(()=>{
      window.TaskPointsCore.journalTaskMutation({task:{
        id:'newer-uncompacted-task',title:'Newer journal-only Task',
        points:17,status:'active'
      }});
      return localStorage.getItem('taskpoints_pending_task_mutations_v1');
    });
    assert.ok(added && added!==tokens.taskJournalRaw,'Task mutation must change durable V1 task journal');
    // Do not assume one tab's setItem is visible immediately in WebKit.
    await writer.waitForFunction(before=>
      localStorage.getItem('taskpoints_pending_task_mutations_v1')!==before,
      tokens.taskJournalRaw,{timeout:12000});
    await writer.evaluate(()=>window.__resumePendingTaskGuard());
    const rejected=await pending;
    assert.equal(rejected.reason,'serialized_operation_primary_journals_changed',
      JSON.stringify(rejected));
    assert.equal(rejected.exclusiveLockAcquired,true);
    assert.equal(rejected.canPromote,false);
    assert.equal(rejected.productionWritersFenced,false);
    const final=await legacy.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      taskJournal:window.TaskPointsCore.readPendingTaskMutations?.()?.record,
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.raw,tokens.raw,'Stale snapshot must not be committed');
    assert.equal(final.taskJournalRaw,added,'Newer Task journal must not be erased');
    assert.ok(final.taskJournal?.tasks?.some(t=>t.id==='newer-uncompacted-task'));
    assert.equal(final.authority,'legacy_only');
    return {realTaskJournalWriteRetained:true,staleSnapshotAborted:true,
      snapshotStillByteIdentical:true,nonauthoritative:true};
  });

  await run('serialized snapshot guard refuses newer Habit journal while V1 snapshot is unchanged',async context=>{
    const writer=await open(context),legacy=await open(context);
    const supported=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const tokens=await writer.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1')
    }));
    const pending=writer.evaluate(source=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_pending_habit_snapshot_guard_waiting','ready');
        await new Promise(resolve=>{window.__resumePendingHabitGuard=resolve;});
        const stale=window.TaskPointsCore.parseTaskPointsStorageJson(source.raw,{});
        stale.tasks.push({id:'stale-after-habit',title:'Must not persist'});
        guard.assertPreviewLegacySnapshotUnchanged(source.raw);
        guard.assertPreviewPrimaryJournalsUnchanged(source);
        window.TaskPointsCore.saveStateSnapshot(stale,{
          storageKey:'taskpoints_v1',immediateWrite:true,userInitiated:true,
          savePath:'v2-stale-habit-journal-guard-fixture'
        });
      }),tokens);
    await legacy.waitForFunction(()=>
      localStorage.getItem('v2_pending_habit_snapshot_guard_waiting')==='ready',
      null,{timeout:12000});
    await legacy.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-24','full',47));
    const changed=await legacy.evaluate(()=>
      localStorage.getItem('taskpoints_pending_habit_deltas_v1'));
    assert.ok(changed && changed!==tokens.habitJournalRaw);
    await writer.waitForFunction(before=>
      localStorage.getItem('taskpoints_pending_habit_deltas_v1')!==before,
      tokens.habitJournalRaw,{timeout:12000});
    await writer.evaluate(()=>window.__resumePendingHabitGuard());
    const rejected=await pending;
    assert.equal(rejected.reason,'serialized_operation_primary_journals_changed',
      JSON.stringify(rejected));
    assert.equal(rejected.canPromote,false);
    assert.equal(rejected.exclusiveLockAcquired,true);
    assert.equal(rejected.lockHeldAfterReturn,false);
    const final=await legacy.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      journal:window.TaskPointsCore.readPendingHabitDeltas(),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.raw,tokens.raw);
    assert.ok(final.journal.some(d=>d.habitId==='h1'&&d.dayKey==='2026-10-24'));
    assert.equal(final.authority,'legacy_only');
    return {realHabitJournalRetained:true,staleSnapshotAborted:true,
      legacySnapshotUnchanged:true,noAuthoritySwitch:true};
  });

  await run('primary journal guard rejects missing tokens and denied journal access',async context=>{
    const page=await open(context);
    const supported=await page.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supported){
      const refused=await page.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(refused.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const before=localStorage.getItem('taskpoints_v1');
      const missing=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
        guard.assertPreviewPrimaryJournalsUnchanged({taskJournalRaw:null}));
      const expected={taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1')};
      const get=Storage.prototype.getItem;
      let unreadable;
      Storage.prototype.getItem=function(key){
        if(this===localStorage && key==='taskpoints_pending_task_mutations_v1')
          throw new DOMException('synthetic denied task journal','SecurityError');
        return get.call(this,key);
      };
      try{
        unreadable=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
          guard.assertPreviewPrimaryJournalsUnchanged(expected));
      }finally{Storage.prototype.getItem=get;}
      return {missing,unreadable,
        unchanged:localStorage.getItem('taskpoints_v1')===before,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.missing.reason,'serialized_operation_primary_journal_tokens_required');
    assert.equal(proof.unreadable.reason,'serialized_operation_primary_journal_unreadable');
    assert.equal(proof.unreadable.exclusiveLockAcquired,true);
    assert.equal(proof.unreadable.canPromote,false);
    assert.equal(proof.unchanged,true);
    assert.equal(proof.authority,'legacy_only');
    return {missingTokenRejected:true,deniedJournalReadRejected:true,
      noSnapshotWrite:true,legacyAuthorityUnchanged:true};
  });

  await run('serialized writer rejects a new independent Habit sidecar despite unchanged primary journals',async context=>{
    const writer=await open(context),legacy=await open(context);
    const hasLocks=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!hasLocks){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const source=await writer.evaluate(()=>{
      const prefix='taskpoints_v2_habit_journal_event_v1:';
      const sidecars=[];
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key?.startsWith(prefix))sidecars.push([key,localStorage.getItem(key)]);
      }
      return {raw:localStorage.getItem('taskpoints_v1'),
        taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1'),
        sidecars:sidecars.sort((a,b)=>a[0].localeCompare(b[0]))};
    });
    const pending=writer.evaluate(expected=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_independent_sidecar_writer_waiting','ready');
        await new Promise(resolve=>window.__releaseIndependentSidecarWriter=resolve);
        const candidate=window.TaskPointsCore.parseTaskPointsStorageJson(expected.raw,{});
        candidate.tasks.push({id:'stale-sidecar-overwrite',title:'Do not persist'});
        guard.assertPreviewLegacySnapshotUnchanged(expected.raw);
        guard.assertPreviewPrimaryJournalsUnchanged(expected);
        guard.assertPreviewHabitSidecarsUnchanged(expected.sidecars);
        window.TaskPointsCore.saveStateSnapshot(candidate,{
          immediateWrite:true,userInitiated:true,savePath:'v2-stale-sidecar-test'
        });
      }),source);
    await legacy.waitForFunction(()=>
      localStorage.getItem('v2_independent_sidecar_writer_waiting')==='ready',
      null,{timeout:12000});
    // A valid independent event is allowed to exist without a new primary
    // journal write, e.g. following concurrent legacy RMW journal races.
    const added=await legacy.evaluate(()=>{
      const key='taskpoints_v2_habit_journal_event_v1:'+crypto.randomUUID();
      const row={id:'habit:h2:2026-10-23',habitId:'h2',dayKey:'2026-10-23',
        source:'habit',status:'full',done:true,completionPoints:4,
        updatedAtISO:'2026-10-23T12:00:00.000Z',
        __v2JournalGeneration:localStorage.getItem('taskpoints_state_v2_generation_v1')};
      localStorage.setItem(key,JSON.stringify([row]));
      return {key,value:localStorage.getItem(key),
        merged:window.TaskPointsCore.readPendingHabitDeltas()
          .some(delta=>delta.habitId==='h2'&&delta.dayKey==='2026-10-23')};
    });
    assert.equal(added.merged,true);
    await writer.waitForFunction(pair=>
      localStorage.getItem(pair.key)===pair.value,added,{timeout:12000});
    await writer.evaluate(()=>window.__releaseIndependentSidecarWriter());
    const denied=await pending;
    assert.equal(denied.reason,'serialized_operation_habit_sidecars_changed',JSON.stringify(denied));
    assert.equal(denied.exclusiveLockAcquired,true);
    assert.equal(denied.operationRan,true);
    assert.equal(denied.lockHeldAfterReturn,false);
    assert.equal(denied.canPromote,false);
    assert.equal(denied.productionWritersFenced,false);
    const after=await legacy.evaluate(key=>({
      raw:localStorage.getItem('taskpoints_v1'),
      taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1'),
      sidecar:localStorage.getItem(key),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }),added.key);
    assert.equal(after.raw,source.raw);
    assert.equal(after.taskJournalRaw,source.taskJournalRaw);
    assert.equal(after.habitJournalRaw,source.habitJournalRaw);
    assert.equal(after.sidecar,added.value);
    assert.equal(after.authority,'legacy_only');
    return {independentEventDetected:true,staleSaveRefused:true,
      bothPrimaryJournalsUnchanged:true,eventRetained:true};
  });

  await run('serialized writer detects Habit sidecar removal by verified-row cleanup helper',async context=>{
    const writer=await open(context),cleaner=await open(context);
    const hasLocks=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!hasLocks){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const setup=await cleaner.evaluate(()=>{
      const core=window.TaskPointsCore;
      const delta=core.writePendingHabitDelta({
        habitId:'h3',dayKey:'2026-10-24',source:'habit',status:'full',
        done:true,completionPoints:5,completionFraction:1,
        completedAtISO:'2026-10-24T12:00:00.000Z',
        updatedAtISO:'2026-10-24T12:00:00.000Z'
      });
      const candidate=core.readTaskPointsStoredState();
      core.applyPendingHabitDeltas(candidate,[delta]);
      const save=core.saveStateSnapshot(candidate,{
        immediateWrite:true,userInitiated:true,replaceCompletions:true,
        savePath:'v2-sidecar-compaction-prep'
      });
      if(save?.skipped)throw Error('sidecar_compaction_prep_save_skipped');
      const persisted=core.readTaskPointsStoredState();
      const verified=core.verifyPersistedHabitDeltas(persisted,[delta]);
      if(verified.length!==1)throw Error('sidecar_row_not_verified_in_v1');
      return {delta,verified};
    });
    const prefix='taskpoints_v2_habit_journal_event_v1:';
    const expected=await writer.evaluate(prefix=>{
      const sidecars=[];
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key?.startsWith(prefix))sidecars.push([key,localStorage.getItem(key)]);
      }
      return sidecars.sort((a,b)=>a[0].localeCompare(b[0]));
    },prefix);
    assert.ok(expected.length>=1);
    const pending=writer.evaluate(previous=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_sidecar_compaction_guard_waiting','ready');
        await new Promise(resolve=>window.__resumeSidecarCompactionGuard=resolve);
        guard.assertPreviewHabitSidecarsUnchanged(previous);
      }),expected);
    await cleaner.waitForFunction(()=>
      localStorage.getItem('v2_sidecar_compaction_guard_waiting')==='ready',
      null,{timeout:12000});
    const cleared=await cleaner.evaluate(verified=>{
      const core=window.TaskPointsCore;
      const count=core.clearCompactedHabitDeltas(verified);
      const prefix='taskpoints_v2_habit_journal_event_v1:';
      const remaining=[];
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key?.startsWith(prefix))remaining.push(key);
      }
      return {count,remaining};
    },setup.verified);
    assert.ok(cleared.count>=1,'Verified Habit cleanup should clear its primary row');
    assert.equal(cleared.remaining.length,0,'Verified sidecar should be removed');
    await writer.waitForFunction(old=>{
      for(const pair of old)if(localStorage.getItem(pair[0])!==pair[1])return true;
      return false;
    },expected,{timeout:12000});
    await writer.evaluate(()=>window.__resumeSidecarCompactionGuard());
    const denied=await pending;
    assert.equal(denied.reason,'serialized_operation_habit_sidecars_changed',JSON.stringify(denied));
    assert.equal(denied.canPromote,false);
    assert.equal(denied.exclusiveLockAcquired,true);
    const after=await cleaner.evaluate(()=>({
      done:window.TaskPointsCore.readTaskPointsStoredState()
        .completions.some(c=>c.habitId==='h3'&&c.dayKey==='2026-10-24'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.done,true);
    assert.equal(after.authority,'legacy_only');
    return {verifiedCompactionCleanupObserved:true,sidecarRemovalDetected:true,
      persistedCompletionPreserved:true,noAuthorityChange:true};
  });

  await run('Habit sidecar guard fails closed on malformed tokens and denied reads',async context=>{
    const page=await open(context);
    const hasLocks=await page.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!hasLocks){
      const denied=await page.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const before=localStorage.getItem('taskpoints_v1');
      const malformed=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
        guard.assertPreviewHabitSidecarsUnchanged([['not-a-sidecar','fake']]));
      const key='taskpoints_v2_habit_journal_event_v1:denied-test';
      localStorage.setItem(key,'fixture-sidecar');
      const get=Storage.prototype.getItem;
      Storage.prototype.getItem=function(value){
        if(this===localStorage&&value===key)
          throw new DOMException('synthetic denied sidecar','SecurityError');
        return get.call(this,value);
      };
      let unreadable;
      try{
        unreadable=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
          guard.assertPreviewHabitSidecarsUnchanged([[key,'fixture-sidecar']]));
      }finally{Storage.prototype.getItem=get;}
      return {malformed,unreadable,unchanged:localStorage.getItem('taskpoints_v1')===before,
        sidecar:localStorage.getItem(key),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.malformed.reason,'serialized_operation_habit_sidecar_token_invalid');
    assert.equal(proof.unreadable.reason,'serialized_operation_habit_sidecars_unreadable');
    assert.equal(proof.unreadable.exclusiveLockAcquired,true);
    assert.equal(proof.unreadable.canPromote,false);
    assert.equal(proof.unchanged,true);
    assert.equal(proof.sidecar,'fixture-sidecar');
    assert.equal(proof.authority,'legacy_only');
    return {malformedTokenDenied:true,sidecarReadDenied:true,
      noLegacySnapshotWrite:true,sidecarRetained:true};
  });

  await run('complete preview source guard rejects an unfenced deferred-compression snapshot save',async context=>{
    const writer=await open(context),legacy=await open(context);
    const supportsLocks=await writer.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supportsLocks){
      const refused=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(refused.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const tokens=await writer.evaluate(()=>{
      const prefix='taskpoints_v2_habit_journal_event_v1:';
      const sidecarEntries=[];
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key?.startsWith(prefix))sidecarEntries.push([key,localStorage.getItem(key)]);
      }
      return {schemaVersion:1,snapshotRaw:localStorage.getItem('taskpoints_v1'),
        taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1'),
        sidecarEntries:sidecarEntries.sort((a,b)=>a[0].localeCompare(b[0]))};
    });
    const pending=writer.evaluate(expected=>
      window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(async guard=>{
        localStorage.setItem('v2_complete_sources_snapshot_waiting','ready');
        await new Promise(resolve=>window.__resumeCompleteSourceWriter=resolve);
        const core=window.TaskPointsCore;
        const stale=core.parseTaskPointsStorageJson(expected.snapshotRaw,{});
        stale.tasks.push({id:'obsolete-compression-task',title:'Must never persist'});
        guard.assertPreviewCompleteWriterSourcesUnchanged(expected);
        core.saveStateSnapshot(stale,{immediateWrite:true,userInitiated:true,
          savePath:'v2-stale-complete-source-rehearsal'});
      }),tokens);
    await legacy.waitForFunction(()=>
      localStorage.getItem('v2_complete_sources_snapshot_waiting')==='ready',
      null,{timeout:12000});
    // Real TaskPoints interactive packed save followed by the existing
    // pagehide/idle recompression flush. It does NOT honor the preview lock.
    const saved=await legacy.evaluate(()=>{
      const core=window.TaskPointsCore;
      const fresh=core.readTaskPointsStoredState();
      fresh.tasks.push({id:'newer-background-packed-task',title:'Newer real V1 save'});
      const result=core.saveStateSnapshot(fresh,{interactive:true,deferCompression:true,
        immediateWrite:true,userInitiated:true,savePath:'v2-unfenced-deferred-compression-fixture'});
      if(result?.skipped)throw Error('real_packed_save_was_skipped');
      const pendingBefore=core.getPendingInteractiveRecompressCount();
      core.flushPendingInteractiveRecompresses();
      return {raw:localStorage.getItem('taskpoints_v1'),
        pendingBefore,afterCount:core.getPendingInteractiveRecompressCount(),
        tasks:core.readTaskPointsStoredState().tasks.map(t=>t.id)};
    });
    assert.ok(saved.tasks.includes('newer-background-packed-task'));
    assert.notEqual(saved.raw,tokens.snapshotRaw);
    assert.ok(saved.pendingBefore>=1,'Existing deferred recompression should be scheduled');
    assert.equal(saved.afterCount,0,'Existing deferred recompression should flush');
    await writer.waitForFunction(raw=>
      localStorage.getItem('taskpoints_v1')===raw,
      saved.raw,{timeout:12000});
    await writer.evaluate(()=>window.__resumeCompleteSourceWriter());
    const refused=await pending;
    assert.equal(refused.reason,'serialized_operation_snapshot_changed',JSON.stringify(refused));
    assert.equal(refused.exclusiveLockAcquired,true);
    assert.equal(refused.lockHeldAfterReturn,false);
    assert.equal(refused.canPromote,false);
    assert.equal(refused.productionWritersFenced,false);
    const final=await legacy.evaluate(async()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      tasks:window.TaskPointsCore.readTaskPointsStoredState().tasks.map(t=>t.id),
      completions:window.TaskPointsCore.readTaskPointsStoredState().completions.map(c=>c.id),
      lockFree:await navigator.locks.request(
        'taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive',ifAvailable:true},lock=>Boolean(lock)),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.raw,saved.raw);
    assert.ok(final.tasks.includes('newer-background-packed-task'));
    assert.ok(!final.tasks.includes('obsolete-compression-task'));
    assert.ok(final.completions.includes('synthetic-task-completion'));
    assert.equal(final.lockFree,true);
    assert.equal(final.authority,'legacy_only');
    return {realDeferredRecompressionFlushed:true,newerV1Saved:true,
      staleCompleteSourceRejected:true,taskAndCompletionPreserved:true,
      noProductionAuthoritySwitch:true};
  });

  await run('complete source guard refuses invalid tokens and independent sidecars',async context=>{
    const page=await open(context);
    const supportsLocks=await page.evaluate(()=>typeof navigator.locks?.request==='function');
    if(!supportsLocks){
      const refused=await page.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewSerializedSnapshotLease(()=>{}));
      assert.equal(refused.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const snapshotRaw=localStorage.getItem('taskpoints_v1');
      const noToken=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
        guard.assertPreviewCompleteWriterSourcesUnchanged({
          snapshotRaw,taskJournalRaw:null,habitJournalRaw:null,sidecarEntries:[]
        }));
      const source={schemaVersion:1,snapshotRaw,
        taskJournalRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        habitJournalRaw:localStorage.getItem('taskpoints_pending_habit_deltas_v1'),
        sidecarEntries:[]};
      const key='taskpoints_v2_habit_journal_event_v1:complete-guard-test';
      localStorage.setItem(key,'synthetic-independent-event');
      const changed=await runtime.exercisePreviewSerializedSnapshotLease(guard=>
        guard.assertPreviewCompleteWriterSourcesUnchanged(source));
      return {noToken,changed,
        originalSnapshotRetained:localStorage.getItem('taskpoints_v1')===snapshotRaw,
        independentEventRetained:localStorage.getItem(key)==='synthetic-independent-event',
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.noToken.reason,'serialized_operation_complete_tokens_required');
    assert.equal(proof.changed.reason,'serialized_operation_habit_sidecars_changed',
      JSON.stringify(proof.changed));
    assert.equal(proof.changed.canPromote,false);
    assert.equal(proof.changed.exclusiveLockAcquired,true);
    assert.equal(proof.originalSnapshotRetained,true);
    assert.equal(proof.independentEventRetained,true);
    assert.equal(proof.authority,'legacy_only');
    return {combinedTokenRequired:true,sidecarChangeCannotBeSkipped:true,
      snapshotUnchanged:true,noAuthoritySwitch:true};
  });

  await run('preview IndexedDB fence atomically freezes cooperating writers across tabs and reload',async context=>{
    const first=await open(context),second=await open(context);
    const v1=await first.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const initial=await first.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(initial.reason,'fence_read_only',JSON.stringify(initial));
    assert.equal(initial.fence.epoch,0);
    assert.equal(initial.fence.frozen,false);
    assert.equal(initial.canPromote,false);
    const one=await first.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'preview-writer-one'}));
    assert.equal(one.reason,'preview_writer_recorded',JSON.stringify(one));
    assert.equal(one.fence.writersCommitted,1);
    assert.equal(one.atomicPreviewTransaction,true);
    const old=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(old.fence.epoch,0);
    // Simultaneous same-epoch freezes can never both win the IDB CAS.
    const [a,b]=await Promise.all([
      first.evaluate(()=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('freeze',{expectedEpoch:0})),
      second.evaluate(()=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('freeze',{expectedEpoch:0}))
    ]);
    const reasons=[a.reason,b.reason].sort();
    assert.deepEqual(reasons,['fence_epoch_stale','preview_fence_frozen'],
      JSON.stringify([a,b]));
    const after=await first.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(after.fence.frozen,true);
    assert.equal(after.fence.epoch,1);
    assert.equal(after.fence.writersCommitted,1);
    assert.equal(after.fence.lastWriterMarker,'preview-writer-one');
    const stale=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'stale-must-not-commit'}));
    assert.equal(stale.reason,'fence_epoch_stale',JSON.stringify(stale));
    const newer=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:1,marker:'frozen-must-not-commit'}));
    assert.equal(newer.reason,'fence_frozen',JSON.stringify(newer));
    await second.close();
    const reopened=await open(context);
    const persisted=await reopened.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(persisted.fence.epoch,1);
    assert.equal(persisted.fence.frozen,true);
    assert.equal(persisted.fence.writersCommitted,1);
    assert.equal(persisted.canPromote,false);
    // A legacy tab that doesn't know the protocol is still NOT fenced.
    await reopened.evaluate(()=>
      localStorage.setItem('taskpoints_old_tab_ignores_preview_fence','legacy-write'));
    const final=await first.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      unfenced:localStorage.getItem('taskpoints_old_tab_ignores_preview_fence'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.v1,v1);
    assert.equal(final.unfenced,'legacy-write');
    assert.equal(final.authority,'legacy_only');
    return {singleAtomicFreeze:true,staleAndFrozenWritersDenied:true,
      freezeSurvivesReload:true,oldLegacyTabStillUnfenced:true};
  });

  await run('preview durable writer fence rejects stale generations without touching legacy data',async context=>{
    const writer=await open(context),other=await open(context);
    const before=await writer.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      generation:localStorage.getItem('taskpoints_state_v2_generation_v1')
    }));
    const recorded=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'before-rotation'}));
    assert.equal(recorded.reason,'preview_writer_recorded',JSON.stringify(recorded));
    const rotated=await other.evaluate(()=>{
      const newGeneration='v2-fence-test-rotation:'+crypto.randomUUID();
      localStorage.setItem('taskpoints_state_v2_generation_v1',newGeneration);
      return newGeneration;
    });
    await writer.waitForFunction(expected=>
      localStorage.getItem('taskpoints_state_v2_generation_v1')===expected,
      rotated,{timeout:12000});
    const denied=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'different-generation'}));
    assert.equal(denied.reason,'fence_generation_mismatch',JSON.stringify(denied));
    assert.equal(denied.canPromote,false);
    assert.equal(denied.productionWritersFenced,false);
    assert.equal(denied.fence.writersCommitted,1);
    const invalid=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:-1,marker:'nope'}));
    assert.equal(invalid.reason,'expected_epoch_required');
    const missing=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0}));
    assert.equal(missing.reason,'writer_marker_required');
    const final=await other.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.v1,before.raw);
    assert.equal(final.authority,'legacy_only');
    return {oldEpochPersistsWithoutRebinding:true,generationMismatchDenied:true,
      invalidCallersRefused:true,noV1Mutation:true};
  });

  await run('preview durable IDB writer refuses an aborted transaction and allows clean retry',async context=>{
    const page=await open(context);
    const checked=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const originalV1=localStorage.getItem('taskpoints_v1');
      // Create only the developer-owned database schema, with NO marker.
      const initial=await runtime.rehearsePreviewDurableWriterFence('read');
      const originalPut=IDBObjectStore.prototype.put;
      let refused;
      IDBObjectStore.prototype.put=function(record,...rest){
        if(this.name==='control'&&record?.id==='writer_fence')
          throw new DOMException('synthetic IDB write denial','QuotaExceededError');
        return originalPut.call(this,record,...rest);
      };
      try{
        refused=await runtime.rehearsePreviewDurableWriterFence('writer',{
          expectedEpoch:0,marker:'must-not-commit'});
      }finally{IDBObjectStore.prototype.put=originalPut;}
      const afterFailure=await runtime.rehearsePreviewDurableWriterFence('read');
      const failedMarker=await runtime.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'must-not-commit'});
      const retry=await runtime.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'clean-retry'});
      const afterRetry=await runtime.rehearsePreviewDurableWriterFence('read');
      // The first put of the failed transaction would have inserted the
      // marker if the second put did not fail. Its absence proves rollback
      // covered BOTH records rather than only the aggregate control row.
      const markerRows=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('taskpoints_v2_writer_fence_preview_v1',1);
        req.onerror=()=>reject(req.error);
        req.onsuccess=()=>{
          const db=req.result;
          const tx=db.transaction('control','readonly');
          const store=tx.objectStore('control');
          const keys=['writer_marker:must-not-commit','writer_marker:clean-retry'];
          const rows={};
          keys.forEach(key=>{
            const get=store.get(key);
            get.onsuccess=()=>{rows[key]=get.result??null;};
            get.onerror=()=>{try{tx.abort();}catch(_){}};
          });
          tx.oncomplete=()=>{db.close();resolve(rows);};
          tx.onabort=()=>{db.close();reject(Error('synthetic marker inspection aborted'));};
        };
      });
      return {initial,refused,afterFailure,failedMarker,retry,afterRetry,markerRows,
        originalV1,
        v1After:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(checked.initial.initialized,false);
    assert.equal(checked.refused.reason,'fence_transaction_aborted',
      JSON.stringify(checked.refused));
    assert.equal(checked.refused.canPromote,false);
    assert.equal(checked.afterFailure.initialized,false);
    assert.equal(checked.afterFailure.fence.writersCommitted,0);
    assert.equal(checked.failedMarker.reason,'preview_writer_marker_absent');
    assert.equal(checked.failedMarker.readOnlyMarkerInspection,true);
    assert.equal(checked.retry.reason,'preview_writer_recorded',JSON.stringify(checked.retry));
    assert.equal(checked.afterRetry.fence.writersCommitted,1);
    assert.equal(checked.afterRetry.fence.lastWriterMarker,'clean-retry');
    assert.equal(checked.markerRows['writer_marker:must-not-commit'],null,
      'Aborted marker must not survive an aborted aggregate control write');
    assert.equal(checked.markerRows['writer_marker:clean-retry']?.epoch,0);
    assert.equal(checked.v1After,checked.originalV1);
    assert.equal(checked.authority,'legacy_only');
    return {abortedMarkerNotCommitted:true,cleanRetrySucceeds:true,
      originalV1Unchanged:true,noProductionAuthority:true};
  });

  await run('preview durable IDB markers commit exactly once across concurrent tabs and reload',async context=>{
    const first=await open(context),second=await open(context);
    const oldV1=await first.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const attempt=()=>({expectedEpoch:0,marker:'shared-stable-marker'});
    const [one,two]=await Promise.all([
      first.evaluate(options=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('writer',options),attempt()),
      second.evaluate(options=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('writer',options),attempt())
    ]);
    assert.deepEqual([one.reason,two.reason].sort(),
      ['preview_writer_recorded','preview_writer_replayed'],JSON.stringify([one,two]));
    assert.ok([one,two].every(report=>report.canPromote===false));
    const firstRead=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(firstRead.fence.writersCommitted,1);
    assert.equal(firstRead.fence.lastWriterMarker,'shared-stable-marker');
    const different=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'different-marker'}));
    assert.equal(different.reason,'preview_writer_recorded');
    assert.equal(different.fence.writersCommitted,2);
    await first.close();
    const restarted=await open(context);
    const replay=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'shared-stable-marker'}));
    assert.equal(replay.reason,'preview_writer_replayed',JSON.stringify(replay));
    assert.equal(replay.alreadyRecorded,true);
    assert.equal(replay.fence.writersCommitted,2);
    assert.equal(replay.fence.lastWriterMarker,'different-marker');
    const frozen=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('freeze',{
        expectedEpoch:0}));
    assert.equal(frozen.reason,'preview_fence_frozen');
    const oldReplay=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'shared-stable-marker'}));
    assert.equal(oldReplay.reason,'fence_epoch_stale');
    const currentReplay=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:1,marker:'shared-stable-marker'}));
    assert.equal(currentReplay.reason,'fence_frozen');
    const final=await restarted.evaluate(async()=>({
      control:await window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'),
      legacy:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    const current=final.control;
    assert.equal(current.fence.writersCommitted,2);
    assert.equal(current.fence.epoch,1);
    assert.equal(current.fence.frozen,true);
    assert.equal(final.legacy,oldV1);
    assert.equal(final.authority,'legacy_only');
    return {sameMarkerExactlyOnce:true,nonAdjacentReplayExactlyOnce:true,
      replaySurvivesTabRestart:true,frozenEpochRejectsReplays:true,
      legacySnapshotUnchanged:true};
  });

  await run('preview durable IDB writer-versus-freeze race has a single serial order',async context=>{
    const writer=await open(context),freezer=await open(context);
    const oldV1=await writer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const [write,freeze]=await Promise.all([
      writer.evaluate(()=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('writer',{
          expectedEpoch:0,marker:'racing-writer'})),
      freezer.evaluate(()=>window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('freeze',{expectedEpoch:0}))
    ]);
    assert.equal(freeze.reason,'preview_fence_frozen',JSON.stringify(freeze));
    assert.ok(['preview_writer_recorded','fence_epoch_stale']
      .includes(write.reason),JSON.stringify(write));
    const after=await freezer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('read'));
    assert.equal(after.fence.epoch,1);
    assert.equal(after.fence.frozen,true);
    assert.equal(after.fence.writersCommitted,
      write.reason==='preview_writer_recorded'?1:0);
    const late=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:1,marker:'late-writer'}));
    assert.equal(late.reason,'fence_frozen');
    const v1After=await writer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    assert.equal(v1After,oldV1);
    assert.equal(write.canPromote,false);
    assert.equal(freeze.canPromote,false);
    assert.equal(late.productionWritersFenced,false);
    return {singleSerializedWriterFreezeOrder:true,
      writerWon:write.reason==='preview_writer_recorded',
      committedWriters:after.fence.writersCommitted,legacyV1Unchanged:true};
  });

  await run('preview durable writer detects generation rotation during IDB marker lookup',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const before=localStorage.getItem('taskpoints_v1');
      const previousGeneration=localStorage.getItem('taskpoints_state_v2_generation_v1');
      const originalGet=IDBObjectStore.prototype.get;
      let rotated=null,intercepted=false,report;
      IDBObjectStore.prototype.get=function(key,...rest){
        const request=originalGet.call(this,key,...rest);
        if(this.name==='control' && typeof key==='string'
          && key.startsWith('writer_marker:') && !intercepted){
          intercepted=true;
          rotated='v2-mid-marker-lookup:'+crypto.randomUUID();
          localStorage.setItem('taskpoints_state_v2_generation_v1',rotated);
        }
        return request;
      };
      try{
        report=await runtime.rehearsePreviewDurableWriterFence('writer',{
          expectedEpoch:0,marker:'must-not-write-after-epoch-rotation'});
      }finally{IDBObjectStore.prototype.get=originalGet;}
      // Read the isolated preview database directly; the interrupted
      // transaction must not leave even the synthetic marker behind.
      const rows=await new Promise((resolve,reject)=>{
        const opening=indexedDB.open('taskpoints_v2_writer_fence_preview_v1',1);
        opening.onerror=()=>reject(opening.error);
        opening.onsuccess=()=>{
          const db=opening.result;
          const tx=db.transaction('control','readonly');
          const control=tx.objectStore('control');
          const check=['writer_fence','writer_marker:must-not-write-after-epoch-rotation'];
          const records={};
          for(const key of check){
            const request=control.get(key);
            request.onsuccess=()=>{records[key]=request.result??null;};
            request.onerror=()=>{try{tx.abort();}catch(_){}};
          }
          tx.oncomplete=()=>{db.close();resolve(records);};
          tx.onabort=()=>{db.close();reject(Error('fence record inspection failed'));};
        };
      });
      return {report,rows,rotated,intercepted,previousGeneration,
        finalGeneration:localStorage.getItem('taskpoints_state_v2_generation_v1'),
        before,after:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.intercepted,true,'Marker lookup must be intercepted');
    assert.notEqual(proof.rotated,proof.previousGeneration);
    assert.equal(proof.finalGeneration,proof.rotated);
    assert.equal(proof.report.reason,'preview_or_generation_changed_in_transaction',
      JSON.stringify(proof.report));
    assert.equal(proof.report.canPromote,false);
    assert.equal(proof.rows.writer_fence,null);
    assert.equal(proof.rows['writer_marker:must-not-write-after-epoch-rotation'],null);
    assert.equal(proof.before,proof.after);
    assert.equal(proof.authority,'legacy_only');
    return {midLookupGenerationChangeDenied:true,noMarkerOrCounterCommitted:true,
      originalV1Unchanged:true,authorityUnchanged:true};
  });

  await run('read-only fence marker lookup resolves lost-response writer after tab close and freeze',async context=>{
    const origin=await open(context),observer=await open(context);
    const originalV1=await observer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const empty=await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'uncertain-commit'}));
    assert.equal(empty.reason,'preview_writer_marker_absent',JSON.stringify(empty));
    assert.equal(empty.readOnlyMarkerInspection,true);
    assert.equal(empty.markerEpoch,null);
    // Deliberately abandon the result instead of awaiting it: this models a
    // page/renderer that loses its response after a transaction has committed.
    const launched=await origin.evaluate(()=>{
      window.__unobservedWriterResult =
        window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
          'writer',{expectedEpoch:0,marker:'uncertain-commit'});
      return 'launched_without_await';
    });
    assert.equal(launched,'launched_without_await');
    await observer.waitForFunction(async()=>{
      const report=await window.TaskPointsStateRuntimeV2
        .rehearsePreviewDurableWriterFence('inspect_marker',{marker:'uncertain-commit'});
      return report.reason==='preview_writer_marker_present';
    },null,{timeout:12000});
    await origin.close();
    const restarted=await open(context);
    const evidence=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'uncertain-commit'}));
    assert.equal(evidence.reason,'preview_writer_marker_present',JSON.stringify(evidence));
    assert.equal(evidence.markerEpoch,0);
    assert.equal(evidence.fence.writersCommitted,1);
    assert.equal(evidence.fence.lastWriterMarker,'uncertain-commit');
    assert.equal(evidence.canPromote,false);
    const repeat=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'writer',{expectedEpoch:0,marker:'uncertain-commit'}));
    assert.equal(repeat.reason,'preview_writer_replayed');
    assert.equal(repeat.fence.writersCommitted,1);
    const freeze=await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'freeze',{expectedEpoch:0}));
    assert.equal(freeze.reason,'preview_fence_frozen');
    const stillThere=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'uncertain-commit'}));
    assert.equal(stillThere.reason,'preview_writer_marker_present');
    assert.equal(stillThere.markerEpoch,0);
    assert.equal(stillThere.fence.epoch,1);
    assert.equal(stillThere.fence.frozen,true);
    const noNew=await restarted.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'not-committed'}));
    assert.equal(noNew.reason,'preview_writer_marker_absent');
    assert.equal(noNew.fence.writersCommitted,1);
    const final=await observer.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.v1,originalV1);
    assert.equal(final.authority,'legacy_only');
    return {unobservedCommitRecoveredReadOnly:true,
      retryDoesNotDuplicate:true,markerStillVisibleAfterFreeze:true,
      nonrecordedMarkerRemainsAbsent:true,noV1Write:true};
  });

  await run('preview fence aborts both queued writes before commit and recovers after tab close',async context=>{
    const origin=await open(context),observer=await open(context);
    const before=await observer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const interrupted=await origin.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const originalPut=IDBObjectStore.prototype.put;
      let puts=0,aborted=false,result;
      IDBObjectStore.prototype.put=function(value,...args){
        if(this.name==='control' &&
          (value?.id==='writer_marker:aborted-after-queue'
            || (value?.id==='writer_fence'
              && value?.lastWriterMarker==='aborted-after-queue'))) {
          puts++;
          const request=originalPut.call(this,value,...args);
          if(value?.id==='writer_fence') {
            this.transaction.abort();
            aborted=true;
          }
          return request;
        }
        return originalPut.call(this,value,...args);
      };
      try {
        result=await runtime.rehearsePreviewDurableWriterFence('writer',{
          expectedEpoch:0,marker:'aborted-after-queue'
        });
      } finally {
        IDBObjectStore.prototype.put=originalPut;
      }
      return {puts,aborted,result};
    });
    assert.equal(interrupted.puts,2,'Both marker and count puts must have been queued');
    assert.equal(interrupted.aborted,true);
    assert.equal(interrupted.result.reason,'fence_transaction_aborted',
      JSON.stringify(interrupted.result));
    assert.equal(interrupted.result.canPromote,false);
    const inspection=await observer.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      return {
        marker:await runtime.rehearsePreviewDurableWriterFence(
          'inspect_marker',{marker:'aborted-after-queue'}),
        fence:await runtime.rehearsePreviewDurableWriterFence('read')
      };
    });
    assert.equal(inspection.marker.reason,'preview_writer_marker_absent');
    assert.equal(inspection.fence.initialized,false);
    assert.equal(inspection.fence.fence.writersCommitted,0);
    await origin.close();
    const reopened=await open(context);
    const afterRestart=await reopened.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'aborted-after-queue'}));
    assert.equal(afterRestart.reason,'preview_writer_marker_absent');
    const retried=await reopened.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'aborted-after-queue'}));
    assert.equal(retried.reason,'preview_writer_recorded',JSON.stringify(retried));
    assert.equal(retried.fence.writersCommitted,1);
    const replay=await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'aborted-after-queue'}));
    assert.equal(replay.reason,'preview_writer_replayed');
    assert.equal(replay.fence.writersCommitted,1);
    const final=await observer.evaluate(()=>({
      raw:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.raw,before);
    assert.equal(final.authority,'legacy_only');
    return {bothQueuedPutsRolledBack:true,unacknowledgedAbortRecovered:true,
      safeRetryAfterReload:true,noDuplicateMarker:true,originalV1Untouched:true};
  });

  await run('preview fence refuses orphan marker and contradictory control evidence without repair',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const before=localStorage.getItem('taskpoints_v1');
      await runtime.rehearsePreviewDurableWriterFence('read');
      const generation=localStorage.getItem('taskpoints_state_v2_generation_v1');
      const writeTestRows=rows=>new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_v2_writer_fence_preview_v1',1);
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{
          const db=request.result;
          const tx=db.transaction('control','readwrite');
          const store=tx.objectStore('control');
          for(const row of rows)store.put(row);
          tx.oncomplete=()=>{db.close();resolve();};
          tx.onabort=()=>{db.close();reject(Error('fixture corruption transaction aborted'));};
        };
      });
      await writeTestRows([{id:'writer_marker:orphan',generation,epoch:0}]);
      const orphanInspect=await runtime.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'orphan'});
      const orphanRetry=await runtime.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'orphan'
      });
      const controlBefore=await runtime.rehearsePreviewDurableWriterFence('read');
      // Simulate malformed durable control independently of the prototype;
      // normal runtime APIs must NEVER repair or consume this evidence.
      await writeTestRows([{
        id:'writer_fence',generation,epoch:0,frozen:false,
        writersCommitted:0,lastWriterMarker:'ghost-without-counter'
      }]);
      const malformedRead=await runtime.rehearsePreviewDurableWriterFence('read');
      const malformedInspect=await runtime.rehearsePreviewDurableWriterFence(
        'inspect_marker',{marker:'orphan'});
      const malformedWriter=await runtime.rehearsePreviewDurableWriterFence('writer',{
        expectedEpoch:0,marker:'new-after-corruption'
      });
      const verify=await new Promise((resolve,reject)=>{
        const openDb=indexedDB.open('taskpoints_v2_writer_fence_preview_v1',1);
        openDb.onerror=()=>reject(openDb.error);
        openDb.onsuccess=()=>{
          const db=openDb.result,tx=db.transaction('control','readonly');
          const store=tx.objectStore('control'),rows={};
          for(const key of ['writer_fence','writer_marker:orphan',
            'writer_marker:new-after-corruption']){
            const r=store.get(key);
            r.onsuccess=()=>{rows[key]=r.result??null;};
            r.onerror=()=>{try{tx.abort();}catch(_){}};
          }
          tx.oncomplete=()=>{db.close();resolve(rows);};
          tx.onabort=()=>{db.close();reject(Error('fixture evidence inspection aborted'));};
        };
      });
      return {orphanInspect,orphanRetry,controlBefore,malformedRead,
        malformedInspect,malformedWriter,verify,
        before,after:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.orphanInspect.reason,'fence_writer_marker_conflict',
      JSON.stringify(proof.orphanInspect));
    assert.equal(proof.orphanRetry.reason,'fence_writer_marker_conflict');
    assert.equal(proof.controlBefore.initialized,false);
    assert.equal(proof.malformedRead.reason,'fence_record_malformed');
    assert.equal(proof.malformedInspect.reason,'fence_record_malformed');
    assert.equal(proof.malformedWriter.reason,'fence_record_malformed');
    assert.equal(proof.verify.writer_fence.lastWriterMarker,'ghost-without-counter');
    assert.equal(proof.verify['writer_marker:orphan']?.epoch,0);
    assert.equal(proof.verify['writer_marker:new-after-corruption'],null);
    assert.equal(proof.before,proof.after);
    assert.equal(proof.authority,'legacy_only');
    assert.equal(proof.malformedWriter.canPromote,false);
    return {orphanNeverCertifiesCommit:true,contradictoryControlPreserved:true,
      noImplicitRepair:true,noNewMarker:true,unchangedV1:true};
  });

  await run('cooperative shared writer locks coexist and block exclusive handoff while legacy tabs remain unfenced',async context=>{
    const first=await open(context),second=await open(context);
    const silent=await context.newPage();
    await silent.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const supported=await first.evaluate(()=>
      typeof navigator.locks?.request==='function');
    if(!supported){
      const refusal=await first.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
      assert.equal(refusal.reason,'lock_manager_unavailable');
      assert.equal(refusal.canPromote,false);
      return {unsupportedFailClosed:true,legacyOnly:true};
    }
    const original=await first.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const held=first.evaluate(async()=>{
      return window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(async()=>{
        localStorage.setItem('v2_shared_writer_fixture_held','ready');
        await new Promise(resolve=>{window.__releaseV2SharedWriter=resolve;});
        localStorage.setItem('taskpoints_shared_writer_fixture_one','committed');
      });
    });
    await second.waitForFunction(()=>
      localStorage.getItem('v2_shared_writer_fixture_held')==='ready',
      null,{timeout:12000});
    // Two cooperating writers may hold a *shared* browser lock together.
    const concurrent=await second.evaluate(async()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(async()=>{
        localStorage.setItem('taskpoints_shared_writer_fixture_two','committed');
      }));
    assert.equal(concurrent.sharedLockAcquired,true,JSON.stringify(concurrent));
    assert.equal(concurrent.operationRan,true);
    assert.equal(concurrent.canPromote,false);
    // An exclusive handoff cannot start while either cooperating writer is
    // inside its callback. This is real browser-level shared/exclusive locking.
    const exclusive=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
    assert.equal(exclusive.lockAcquired,false,JSON.stringify(exclusive));
    assert.equal(exclusive.reason,'lock_held_elsewhere');
    assert.equal(exclusive.canPromote,false);
    // A legacy-only tab is *not* forced to honor this new protocol.
    await silent.evaluate(()=>localStorage.setItem(
      'taskpoints_unfenced_during_cooperative_lease','outside shared writer lock'));
    await first.evaluate(()=>window.__releaseV2SharedWriter());
    const completed=await held;
    assert.equal(completed.sharedLockAcquired,true,JSON.stringify(completed));
    assert.equal(completed.operationRan,true);
    assert.equal(completed.lockHeldAfterReturn,false);
    assert.equal(completed.canPromote,false);
    const after=await second.evaluate(async()=>{
      const proof=await window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease();
      return {proof,
        v1:localStorage.getItem('taskpoints_v1'),
        one:localStorage.getItem('taskpoints_shared_writer_fixture_one'),
        two:localStorage.getItem('taskpoints_shared_writer_fixture_two'),
        silent:localStorage.getItem('taskpoints_unfenced_during_cooperative_lease'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(after.proof.lockAcquired,true,JSON.stringify(after.proof));
    assert.equal(after.proof.canPromote,false);
    assert.equal(after.v1,original);
    assert.equal(after.one,'committed');
    assert.equal(after.two,'committed');
    assert.equal(after.silent,'outside shared writer lock');
    assert.equal(after.authority,'legacy_only');
    return {concurrentSharedWriters:2,exclusiveBlockedWhileHeld:true,
      exclusiveRehearsalAfterRelease:true,silentLegacyWriterStillUnfenced:true,
      noProductionAuthorityChange:true};
  });

  await run('releases a preview cooperative lock after its holder tab closes',async context=>{
    const holder=await open(context),observer=await open(context);
    const supported=await observer.evaluate(()=>
      typeof navigator.locks?.request==='function');
    if(!supported){
      const refusal=await observer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
      assert.equal(refusal.reason,'lock_manager_unavailable');
      assert.equal(refusal.canPromote,false);
      return {unsupportedFailClosed:true,authorityUnchanged:true};
    }
    const originalV1=await observer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    // Simulate a browser tab disappearing with an unfinished cooperative
    // operation. This tests document teardown, not a physical OS/PWA kill.
    const pending=holder.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(
        async()=>{
          localStorage.setItem('v2_closing_writer_lock_held','ready');
          await new Promise(()=>{});
        })).catch(error=>String(error.message||error));
    await observer.waitForFunction(()=>
      localStorage.getItem('v2_closing_writer_lock_held')==='ready',
      null,{timeout:12000});
    const blocked=await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
    assert.equal(blocked.lockAcquired,false,JSON.stringify(blocked));
    assert.equal(blocked.reason,'lock_held_elsewhere');
    assert.equal(blocked.canPromote,false);
    await holder.close({runBeforeUnload:false});
    await pending; // A closed page may reject its outstanding evaluate promise.
    // Real browser lock ownership must end with the closed document, not
    // depend on a callback/finally running in the destroyed page.
    // Run each rehearsal serially from Playwright instead of polling with
    // overlapping async page callbacks: WebKit can replace the saved
    // successful result with a subsequent in-flight denied result.
    let proof;
    for(let attempt=0;attempt<20;attempt++){
      proof=await observer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
      if(proof.lockAcquired===true)break;
      assert.equal(proof.reason,'lock_held_elsewhere',JSON.stringify(proof));
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(proof.lockAcquired,true,JSON.stringify(proof));
    const after=await observer.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(proof.lockHeldAfterReturn,false);
    assert.equal(proof.canPromote,false);
    assert.equal(proof.mutationAuthority,'legacy_only');
    assert.equal(proof.readAuthority,'legacy_only');
    assert.equal(after.v1,originalV1);
    assert.equal(after.authority,'legacy_only');
    return {tabCloseReleasesSharedLock:true,exclusiveRehearsalRecovered:true,
      v1Unchanged:true,authorityUnchanged:true,physicalPwaKillStillRequired:true};
  });

  await run('preview callback guard refuses stale generation before controlled fixture write',async context=>{
    const writer=await open(context),other=await open(context);
    const supportsLocks=await writer.evaluate(()=>
      typeof navigator.locks?.request==='function');
    if(!supportsLocks){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      assert.equal(denied.canPromote,false);
      return {unsupportedFailClosed:true};
    }
    const originalV1=await other.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const fresh=await writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(
        ({assertPreviewGenerationCurrent})=>{
          assertPreviewGenerationCurrent();
          localStorage.setItem('v2_guarded_preview_fresh','ok');
        }));
    assert.equal(fresh.sharedLockAcquired,true,JSON.stringify(fresh));
    assert.equal(fresh.reason,'cooperative_shared_lock_rehearsed');
    assert.equal(fresh.canPromote,false);
    const pending=writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(
        async ({assertPreviewGenerationCurrent})=>{
          localStorage.setItem('v2_guarded_preview_waiting','ready');
          await new Promise(resolve=>{window.__releaseV2GuardedFixture=resolve;});
          // No authoritative write is allowed until the voluntary
          // pre-side-effect generation check succeeds.
          assertPreviewGenerationCurrent();
          localStorage.setItem('v2_guarded_preview_stale_write','unsafe');
        }));
    await other.waitForFunction(()=>
      localStorage.getItem('v2_guarded_preview_waiting')==='ready',
      null,{timeout:12000});
    const rotated=await other.evaluate(()=>{
      const next='v2-guarded-fixture-rotation:'+crypto.randomUUID();
      localStorage.setItem('taskpoints_state_v2_generation_v1',next);
      return next;
    });
    // A completed localStorage write in one WebKit document is not a
    // synchronization barrier for a suspended document in another process.
    // Wait until that writer itself observes the new generation before
    // releasing its voluntary pre-side-effect check.
    await writer.waitForFunction(expected=>
      localStorage.getItem('taskpoints_state_v2_generation_v1')===expected,
      rotated,{timeout:12000});
    await writer.evaluate(()=>window.__releaseV2GuardedFixture());
    const denied=await pending;
    assert.equal(denied.reason,'cooperative_operation_generation_invalidated',
      JSON.stringify(denied));
    assert.equal(denied.operationRan,true);
    assert.equal(denied.sharedLockAcquired,true);
    assert.equal(denied.lockHeldAfterReturn,false);
    assert.equal(denied.canPromote,false);
    assert.equal(denied.productionWritersFenced,false);
    assert.equal(denied.allLegacyWritersKnown,false);
    const after=await other.evaluate(async()=>({
      staleWrite:localStorage.getItem('v2_guarded_preview_stale_write'),
      freshWrite:localStorage.getItem('v2_guarded_preview_fresh'),
      v1:localStorage.getItem('taskpoints_v1'),
      lockAvailable:await navigator.locks.request(
        'taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive',ifAvailable:true},lock=>Boolean(lock)),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.freshWrite,'ok');
    assert.equal(after.staleWrite,null);
    assert.equal(after.lockAvailable,true);
    assert.equal(after.v1,originalV1);
    assert.equal(after.authority,'legacy_only');
    return {freshGuardAllowsFixture:true,staleGuardAbortsBeforeWrite:true,
      lockReleased:true,legacyAuthorityPreserved:true};
  });

  await run('cooperative lease rejects a generation change while callback is pending',async context=>{
    const writer=await open(context),resetTab=await open(context);
    const supported=await writer.evaluate(()=>
      typeof navigator.locks?.request==='function');
    if(!supported){
      const denied=await writer.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      assert.equal(denied.canPromote,false);
      return {unsupportedFailClosed:true};
    }
    const originalV1=await resetTab.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=writer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(async()=>{
        localStorage.setItem('v2_cooperative_generation_race_held','ready');
        await new Promise(resolve=>window.__releaseGenerationRaceWriter=resolve);
      }));
    await resetTab.waitForFunction(()=>
      localStorage.getItem('v2_cooperative_generation_race_held')==='ready',
      null,{timeout:12000});
    // Synthetic generation rotation: this is NOT an app Reset All or import.
    // It models a different tab changing the persistent generation while
    // the existing preview-only writer callback is suspended.
    const rotated=await resetTab.evaluate(()=>{
      const key='taskpoints_state_v2_generation_v1';
      const before=localStorage.getItem(key);
      const after='v2-browser-rotation-fixture:'+crypto.randomUUID();
      localStorage.setItem(key,after);
      return {before,after};
    });
    assert.notEqual(rotated.before,rotated.after);
    // Safari/WebKit can deliver localStorage updates across documents
    // asynchronously. Prove the suspended tab has *observed* the new
    // generation before releasing it, instead of assuming the other tab's
    // setItem() return establishes cross-process visibility.
    await writer.waitForFunction(expected=>
      localStorage.getItem('taskpoints_state_v2_generation_v1')===expected,
      rotated.after,{timeout:12000});
    await writer.evaluate(()=>window.__releaseGenerationRaceWriter());
    const refused=await pending;
    assert.equal(refused.reason,'generation_or_preview_changed_under_lock',
      JSON.stringify(refused));
    assert.equal(refused.sharedLockAcquired,true);
    assert.equal(refused.operationRan,true);
    assert.equal(refused.lockHeldAfterReturn,false);
    assert.equal(refused.canPromote,false);
    assert.equal(refused.productionWritersFenced,false);
    assert.equal(refused.allLegacyWritersKnown,false);
    assert.equal(refused.mutationAuthority,'legacy_only');
    // The shared lease must be released even when the generation changed.
    // This direct lock probe is fixture-only; it never claims authority.
    const free=await resetTab.evaluate(()=>
      navigator.locks.request('taskpoints_v2_writer_handoff_rehearsal_v1',
        {mode:'exclusive',ifAvailable:true},lock=>Boolean(lock)));
    assert.equal(free,true);
    const final=await resetTab.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.v1,originalV1);
    assert.equal(final.authority,'legacy_only');
    return {generationRaceRejected:true,sharedLockReleased:true,
      v1Unchanged:true,noAuthorityChange:true,physicalPwaTestStillRequired:true};
  });

  await run('exclusive rehearsal blocks a new cooperative writer and releases after callback failure',async context=>{
    const first=await open(context),second=await open(context);
    const supported=await first.evaluate(()=>
      typeof navigator.locks?.request==='function');
    if(!supported){
      const denied=await second.evaluate(()=>
        window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
      assert.equal(denied.reason,'lock_manager_unavailable');
      return {unsupportedFailClosed:true};
    }
    const exclusiveHolder=first.evaluate(async()=>navigator.locks.request(
      'taskpoints_v2_writer_handoff_rehearsal_v1',{mode:'exclusive'},async()=>{
        localStorage.setItem('v2_exclusive_fixture_held','ready');
        await new Promise(resolve=>{window.__releaseV2ExclusiveFixture=resolve;});
      }));
    await second.waitForFunction(()=>
      localStorage.getItem('v2_exclusive_fixture_held')==='ready',
      null,{timeout:12000});
    const busy=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
    assert.equal(busy.reason,'lock_held_elsewhere');
    assert.equal(busy.operationRan,false);
    await first.evaluate(()=>window.__releaseV2ExclusiveFixture());
    await exclusiveHolder;
    const failed=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{
        throw Error('synthetic callback failure');
      }));
    assert.equal(failed.reason,'cooperative_operation_failed');
    assert.equal(failed.sharedLockAcquired,true);
    assert.equal(failed.operationRan,true);
    const recovered=await second.evaluate(()=>
      window.TaskPointsStateRuntimeV2.exercisePreviewCooperativeWriterLease(()=>{}));
    assert.equal(recovered.reason,'cooperative_shared_lock_rehearsed');
    assert.equal(recovered.sharedLockAcquired,true);
    assert.equal(recovered.canPromote,false);
    return {exclusiveBlocksCooperator:true,errorReleasesSharedLock:true,
      recoveredSafely:true,noPromotion:true};
  });

  await run('preview writer peer handshake sees cooperating V2 tabs but cannot certify silent legacy writer',async context=>{
    const observer=await open(context),cooperator=await open(context);
    // A real same-origin V1 page can still mutate localStorage without
    // importing V2 or participating in any BroadcastChannel handshake.
    const legacyPage=await context.newPage();
    await legacyPage.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const initial=await observer.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      supportsChannel:typeof BroadcastChannel==='function'
    }));
    const probe=await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectPreviewWriterPeers());
    assert.equal(probe.checked,true);
    assert.equal(probe.canPromote,false);
    assert.equal(probe.allLegacyWritersKnown,false);
    assert.equal(probe.productionWritersFenced,false);
    assert.equal(probe.mutationAuthority,'legacy_only');
    if(!initial.supportsChannel){
      assert.equal(probe.reason,'coordination_channel_unavailable');
      assert.equal(probe.observedPeerCount,0);
      return {unsupportedFailClosed:true,writerCoverageUnproven:true};
    }
    assert.equal(probe.reason,'observational_probe_only',JSON.stringify(probe));
    assert.equal(probe.observedPeerCount,1,JSON.stringify(probe));
    assert.equal(probe.peers[0].previewEnabled,true);
    assert.equal(probe.peers[0].sameGeneration,true);
    const opposite=await cooperator.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectPreviewWriterPeers());
    assert.equal(opposite.observedPeerCount,1,JSON.stringify(opposite));
    assert.equal(opposite.canPromote,false);
    await legacyPage.evaluate(()=>
      localStorage.setItem('taskpoints_silent_unfenced_writer','saved without V2 API'));
    const after=await observer.evaluate(async()=>({
      probe:await window.TaskPointsStateRuntimeV2.inspectPreviewWriterPeers(),
      v1:localStorage.getItem('taskpoints_v1'),
      silentValue:localStorage.getItem('taskpoints_silent_unfenced_writer'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.probe.observedPeerCount,1,
      'a silent V1 page is not registered as a cooperating peer');
    assert.equal(after.probe.allLegacyWritersKnown,false,
      'receiving all visible responses must never imply exhaustive writer membership');
    assert.equal(after.probe.productionWritersFenced,false);
    assert.equal(after.probe.canPromote,false);
    assert.equal(after.v1,initial.v1);
    assert.equal(after.silentValue,'saved without V2 API');
    assert.equal(after.authority,'legacy_only');
    return {respondingPreviewPeers:1,silentWriterUnfenced:true,
      explicitCoverageLimit:true,legacyDataPreserved:true,authority:'legacy_only'};
  });

  await run('noncooperating browser tab changes unrelated V1 settings during writer lock preflight',async context=>{
    const contender=await open(context),legacyTab=await open(context);
    const initial=await contender.evaluate(()=>({
      legacy:localStorage.getItem('taskpoints_v1'),
      supported:typeof navigator.locks?.request==='function'
    }));
    if(!initial.supported){
      const denied=await contender.evaluate(()=>
        window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
      assert.equal(denied.reason,'lock_manager_unavailable');
      assert.equal(denied.canPromote,false);
      return {lockUnavailableSafely:true,authority:'legacy_only'};
    }
    const pending=contender.evaluate(async()=>{
      const original=SubtleCrypto.prototype.digest;
      let paused=false;
      SubtleCrypto.prototype.digest=function(){
        if(!paused){
          paused=true;
          const self=this,args=arguments;
          localStorage.setItem('v2_browser_writer_preflight_paused','ready');
          return new Promise((resolve,reject)=>{
            window.__resumeV2WriterPreflight=()=>
              Promise.resolve(original.apply(self,args)).then(resolve,reject);
          });
        }
        return original.apply(this,arguments);
      };
      try{return await window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease();}
      finally{
        SubtleCrypto.prototype.digest=original;
        delete window.__resumeV2WriterPreflight;
      }
    });
    await legacyTab.waitForFunction(()=>
      localStorage.getItem('v2_browser_writer_preflight_paused')==='ready',
      null,{timeout:12000});
    // Deliberately change a V1-owned, non-pilot preference. The V2 Habit
    // revision and parity stay unchanged, so the full namespace check is
    // the safeguard that must reject this simulated authority handoff.
    await legacyTab.evaluate(()=>
      localStorage.setItem('taskpoints_legacy_settings_unfenced','changed by old tab'));
    await contender.evaluate(()=>window.__resumeV2WriterPreflight());
    const refused=await pending;
    assert.equal(refused.lockAcquired,false,JSON.stringify(refused));
    assert.equal(refused.reason,'legacy_changed_under_lock');
    assert.equal(refused.canPromote,false);
    assert.equal(refused.mutationAuthority,'legacy_only');
    const retry=await contender.evaluate(async()=>{
      const proof=await window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease();
      return {proof,legacy:localStorage.getItem('taskpoints_v1'),
        preference:localStorage.getItem('taskpoints_legacy_settings_unfenced'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(retry.proof.lockAcquired,true,JSON.stringify(retry.proof));
    assert.equal(retry.proof.canPromote,false);
    assert.equal(retry.legacy,initial.legacy);
    assert.equal(retry.preference,'changed by old tab');
    assert.equal(retry.authority,'legacy_only');
    return {unfencedLegacyWriteDetected:true,writerHandoffRefused:true,
      stableRetrySafe:true,authority:'legacy_only'};
  });

  await run('pending legacy journal blocks writer-lock rehearsal despite matching pilot storage',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const core=window.TaskPointsCore;
      const originalRead=core.readPendingHabitDeltas;
      const originalApply=core.applyPendingHabitDeltas;
      const legacy=localStorage.getItem('taskpoints_v1');
      let readiness,report,blocked;
      // Keep the synthetic pending journal visible to the handoff audit
      // while holding effective V1 pilot state unchanged. This isolates
      // the missing-compaction safety gate from ordinary parity failures.
      core.applyPendingHabitDeltas=()=>({appliedDeltas:[]});
      core.readPendingHabitDeltas=()=>[{
        id:'habit:h1:2026-10-23',habitId:'h1',dayKey:'2026-10-23',
        source:'habit',status:'full',done:true,
        updatedAtISO:'2026-10-23T12:00:00.000Z'
      }];
      try{
        readiness=await runtime.inspectPilotReadiness();
        report=await runtime.inspectMutationHandoffPrerequisites();
        blocked=await runtime.rehearseExclusiveWriterLease();
      }finally{
        core.readPendingHabitDeltas=originalRead;
        core.applyPendingHabitDeltas=originalApply;
      }
      const restored=await runtime.inspectPilotReadiness();
      return {readiness,report,blocked,restored,
        legacyUnchanged:localStorage.getItem('taskpoints_v1')===legacy,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(evidence.readiness.eligible,true,JSON.stringify(evidence.readiness));
    assert.equal(evidence.report.checks.pilotConsistent,true,JSON.stringify(evidence.report));
    assert.equal(evidence.report.checks.legacyJournalEmpty,false);
    assert.equal(evidence.blocked.reason,'handoff_prerequisites_blocked');
    assert.equal(evidence.blocked.lockAcquired,false);
    assert.equal(evidence.blocked.canPromote,false);
    assert.equal(evidence.restored.eligible,true);
    assert.equal(evidence.legacyUnchanged,true);
    assert.equal(evidence.authority,'legacy_only');
    return {pilotParityStillGreen:true,uncompactedLegacyJournalDetected:true,
      handoffRefused:true,authority:'legacy_only'};
  });

  await run('separate V1 tab writing during in-lock SHA-256 is rejected without promotion',async context=>{
    const candidate=await open(context),otherTab=await open(context);
    const start=await candidate.evaluate(()=>({
      legacy:localStorage.getItem('taskpoints_v1'),
      locksSupported:typeof navigator.locks?.request==='function'
    }));
    if(!start.locksSupported){
      const denied=await candidate.evaluate(()=>
        window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease());
      assert.equal(denied.reason,'lock_manager_unavailable');
      assert.equal(denied.canPromote,false);
      return {unsupportedFailClosed:true};
    }
    const pending=candidate.evaluate(async()=>{
      const original=SubtleCrypto.prototype.digest;
      let calls=0;
      SubtleCrypto.prototype.digest=function(){
        const self=this,args=arguments;
        calls++;
        if(calls===2){
          // The second hash is inside the lock. Delay its response while
          // a noncooperating legacy tab changes an unrelated V1 setting.
          localStorage.setItem('v2_writer_inside_digest_pause','ready');
          return new Promise((resolve,reject)=>{
            window.__resumeV2InsideDigest=()=>
              Promise.resolve(original.apply(self,args)).then(resolve,reject);
          });
        }
        return original.apply(self,args);
      };
      try{return {proof:await window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease(),
        digests:calls};}
      finally{
        SubtleCrypto.prototype.digest=original;
        delete window.__resumeV2InsideDigest;
      }
    });
    await otherTab.waitForFunction(()=>
      localStorage.getItem('v2_writer_inside_digest_pause')==='ready',
      null,{timeout:12000});
    await otherTab.evaluate(()=>
      localStorage.setItem('taskpoints_settings_change_inside_digest','outside V2 lock'));
    await candidate.evaluate(()=>window.__resumeV2InsideDigest());
    const result=await pending;
    assert.equal(result.digests,2);
    assert.equal(result.proof.lockAcquired,false,JSON.stringify(result));
    assert.equal(result.proof.reason,'legacy_changed_during_lock_verification');
    assert.equal(result.proof.canPromote,false);
    assert.equal(result.proof.mutationAuthority,'legacy_only');
    const final=await candidate.evaluate(async()=>{
      const proof=await window.TaskPointsStateRuntimeV2.rehearseExclusiveWriterLease();
      return {proof,v1:localStorage.getItem('taskpoints_v1'),
        newSetting:localStorage.getItem('taskpoints_settings_change_inside_digest'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(final.proof.lockAcquired,true,JSON.stringify(final.proof));
    assert.equal(final.proof.canPromote,false);
    assert.equal(final.v1,start.legacy);
    assert.equal(final.newSetting,'outside V2 lock');
    assert.equal(final.authority,'legacy_only');
    return {crossTabInLockHashRaceBlocked:true,retrySafe:true,
      legacyDataPreserved:true,authority:'legacy_only'};
  });

  await run('read-only parity forensics inspects a V1/V2 divergence without changing either copy',async context=>{
    const observer=await open(context);
    const writer=await open(context);
    const readMirror=async page=>page.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
      const read=name=>new Promise((resolve,reject)=>{
        const req=tx.objectStore(name).getAll();
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const [meta,habits,completions,mutations]=await Promise.all(
        ['meta','habits','completions','mutations'].map(read));
      return {meta,habits,completions,mutations};
    });
    // A WebKit document may see a newly written V1 value before all
    // asynchronous forensic observation boundaries settle. Refusals must
    // remain non-destructive; retry only this explicitly expected transient
    // reason, never an unrelated integrity or generation failure.
    const inspectStable=async expectedV1=>{
      let proof;
      for(let attempt=0;attempt<5;attempt++){
        await observer.waitForFunction(raw=>
          localStorage.getItem('taskpoints_v1')===raw,
          expectedV1,{timeout:12000});
        proof=await observer.evaluate(()=>
          window.TaskPointsStateRuntimeV2.inspectPreservedParityMismatch());
        if(proof.stable===true)return proof;
        assert.equal(proof.reason,'inspection_window_changed',JSON.stringify(proof));
        assert.equal(proof.canRepair,false);
        assert.equal(proof.evidencePreserved,true);
        assert.equal(proof.readAuthority,'legacy_only');
      }
      return proof;
    };
    const baseline=await observer.evaluate(async()=>({
      report:await window.TaskPointsStateRuntimeV2.inspectPreservedParityMismatch(),
      originalV1:localStorage.getItem('taskpoints_v1')
    }));
    assert.equal(baseline.report.stable,true,JSON.stringify(baseline.report));
    assert.equal(baseline.report.mismatch,false);
    const originalMirror=await readMirror(observer);
    const newer=await writer.evaluate(()=>{
      const state=JSON.parse(localStorage.getItem('taskpoints_v1'));
      state.habits.find(h=>h.id==='h1').name='Legacy-tab edit not mirrored to V2';
      localStorage.setItem('taskpoints_v1',JSON.stringify(state));
      return localStorage.getItem('taskpoints_v1');
    });
    assert.notEqual(newer,baseline.originalV1);
    const report=await inspectStable(newer);
    assert.equal(report.stable,true,JSON.stringify(report));
    assert.equal(report.mismatch,true);
    assert.equal(report.evidencePreserved,true);
    assert.equal(report.canRepair,false);
    assert.equal(report.evidence.changedHabits,1);
    assert.equal(report.evidence.destructiveReseedBlocked,true);
    assert.equal(report.readAuthority,'legacy_only');
    assert.equal(await observer.evaluate(()=>localStorage.getItem('taskpoints_v1')),newer);
    assert.deepEqual(await readMirror(observer),originalMirror,
      'inspection must leave all V2 stores and mutation ledger untouched');
    await writer.evaluate(raw=>localStorage.setItem('taskpoints_v1',raw),baseline.originalV1);
    const matched=await inspectStable(baseline.originalV1);
    assert.equal(matched.stable,true);
    assert.equal(matched.mismatch,false);
    assert.deepEqual(await readMirror(observer),originalMirror);
    assert.equal((await observer.evaluate(()=>
      window.TaskPointsStateRuntimeV2.getStatus())).readAuthority,'legacy_only');
    return {crossTabMismatchDetected:true,noImplicitReseed:true,
      allFourV2StoresPreserved:true,legacyRestorationNotAutomatic:true};
  });

  await run('cross-tab V2-only IndexedDB write during forensic read is refused without overwriting either side',async context=>{
    const observer=await open(context),rival=await open(context);
    const original=await observer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=observer.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const oldGetAll=IDBObjectStore.prototype.getAll;
      let intercepted=false;
      IDBObjectStore.prototype.getAll=function(){
        const req=oldGetAll.apply(this,arguments);
        if(!intercepted && this.name==='habits'){
          intercepted=true;
          // Pause the first V2 Habits read after the IDB request succeeds.
          // The request's original result has already been captured; a
          // separate tab can now write a newer value before the inspector's
          // second read, without changing the V2 revision marker.
          Object.defineProperty(req,'onsuccess',{
            configurable:true,
            set(callback){
              req.addEventListener('success',event=>{
                localStorage.setItem('v2_forensics_first_read_held','yes');
                window.__resumeV2Forensics=()=>callback(event);
              },{once:true});
            }
          });
        }
        return req;
      };
      try{return await runtime.inspectPreservedParityMismatch();}
      finally{
        IDBObjectStore.prototype.getAll=oldGetAll;
        delete window.__resumeV2Forensics;
      }
    });
    await rival.waitForFunction(()=>
      localStorage.getItem('v2_forensics_first_read_held')==='yes',
      null,{timeout:12000});
    const foreign=await rival.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const oldMeta=await new Promise((resolve,reject)=>{
        const req=db.transaction('meta','readonly').objectStore('meta').get('runtime');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const tx=db.transaction('habits','readwrite');
      const store=tx.objectStore('habits');
      const row=await new Promise((resolve,reject)=>{
        const req=store.get('h1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      store.put({...row,value:{...row.value,name:'Independent V2 forensic race'}});
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      return {oldRevision:oldMeta.revision,changedHabit:'h1'};
    });
    await observer.evaluate(()=>window.__resumeV2Forensics());
    const refused=await pending;
    assert.equal(refused.stable,false,JSON.stringify(refused));
    assert.equal(refused.mismatch,null);
    assert.equal(refused.reason,'v2_collections_changed_during_inspection');
    assert.equal(refused.canRepair,false);
    assert.equal(refused.mutationAuthority,'legacy_only');
    const after=await observer.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const report=await runtime.inspectPreservedParityMismatch();
      const db=await runtime.open();
      const row=await new Promise((resolve,reject)=>{
        const req=db.transaction('habits','readonly').objectStore('habits').get('h1');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const meta=await new Promise((resolve,reject)=>{
        const req=db.transaction('meta','readonly').objectStore('meta').get('runtime');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      return {report,habitName:row.value.name,revision:meta.revision,
        legacy:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(after.report.stable,true,JSON.stringify(after.report));
    assert.equal(after.report.mismatch,true);
    assert.equal(after.report.evidence.changedHabits,1);
    assert.equal(after.report.canRepair,false);
    assert.equal(after.habitName,'Independent V2 forensic race');
    assert.equal(after.revision,foreign.oldRevision,
      'an independent store edit with no meta revision must still be caught');
    assert.equal(after.legacy,original);
    assert.equal(after.authority,'legacy_only');
    return {independentIndexedDbMutationDetected:true,revisionBypassRejected:true,
      v2EvidencePreserved:true,v1Unchanged:true,authority:'legacy_only'};
  });

  await run('independent immutable SHA-256 checkpoint survives reload and detects tampering without restore',async context=>{
    const page=await open(context);
    const created=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      localStorage.setItem('taskpoints_preview_fixture_note','preserved from before reload');
      const savedV1=localStorage.getItem('taskpoints_v1');
      const mirrorBefore=await runtime.verifyParity();
      const created=await runtime.createPreviewRecoveryCheckpoint();
      return {created,savedV1,mirrorBefore,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(created.created.saved,true,JSON.stringify(created.created));
    assert.equal(created.created.verified,true);
    assert.equal(created.created.sourceStable,true);
    assert.equal(created.created.canAutoRestore,false);
    assert.equal(created.authority,'legacy_only');
    await page.reload({waitUntil:'load'});
    await page.evaluate(()=>window.V2BrowserFixture.start());
    const after=await page.evaluate(async id=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const inspected=await runtime.inspectPreviewRecoveryCheckpoint(id);
      const db=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const tx=db.transaction('snapshots','readonly');
      const snapshot=await new Promise((resolve,reject)=>{
        const req=tx.objectStore('snapshots').get(id);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      db.close();
      return {inspected,rawV1:new Map(snapshot.entries).get('taskpoints_v1'),
        fixtureNote:new Map(snapshot.entries).get('taskpoints_preview_fixture_note'),
        independentDatabase:runtime.getStatus().databaseName!=='taskpoints_v2_recovery_checkpoints_preview',
        authority:runtime.getStatus().readAuthority};
    },created.created.checkpointId);
    assert.equal(after.inspected.intact,true,JSON.stringify(after.inspected));
    assert.equal(after.inspected.integrityCoverage,'metadata_and_payload');
    assert.match(after.inspected.fingerprint,/^sha256:[0-9a-f]{64}:\d+$/);
    assert.equal(after.rawV1,created.savedV1);
    assert.equal(after.fixtureNote,'preserved from before reload');
    assert.equal(after.independentDatabase,true);
    assert.equal(after.authority,'legacy_only');
    const corrupted=await page.evaluate(async id=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const get=()=>new Promise((resolve,reject)=>{
        const req=db.transaction('snapshots','readonly').objectStore('snapshots').get(id);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const row=await get();
      row.entries[0][1]='corrupted checkpoint payload';
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put(row);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      db.close();
      return {verdict:await runtime.inspectPreviewRecoveryCheckpoint(id),
        v1:localStorage.getItem('taskpoints_v1'),
        authority:runtime.getStatus().readAuthority};
    },created.created.checkpointId);
    assert.equal(corrupted.verdict.intact,false);
    assert.equal(corrupted.verdict.reason,'checkpoint_integrity_failed');
    assert.equal(corrupted.verdict.canAutoRestore,false);
    assert.equal(corrupted.v1,created.savedV1);
    assert.equal(corrupted.authority,'legacy_only');
    return {independentSave:true,persistsAcrossReload:true,
      integritySha256:true,corruptionRejected:true,authority:'legacy_only'};
  });

  await run('torn multi-key legacy capture is refused before writing an immutable checkpoint',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const key='taskpoints_preview_capture_race_note';
      localStorage.setItem(key,'snapshot-before');
      const originalV1=localStorage.getItem('taskpoints_v1');
      const originalGet=Storage.prototype.getItem;
      let injected=false;
      Storage.prototype.getItem=function(name){
        const value=originalGet.call(this,name);
        // This key was already read into the capture before it changed.
        // A single-pass snapshot would permanently preserve stale bytes.
        if(this===localStorage&&name===key&&!injected){
          injected=true;
          localStorage.setItem(key,'snapshot-after');
        }
        return value;
      };
      let torn;
      try{torn=await runtime.createPreviewRecoveryCheckpoint();}
      finally{Storage.prototype.getItem=originalGet;}
      const retry=await runtime.createPreviewRecoveryCheckpoint();
      const db=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const records=await new Promise((resolve,reject)=>{
        const req=db.transaction('snapshots','readonly').objectStore('snapshots').getAll();
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      db.close();
      return {injected,torn,retry,recordCount:records.length,
        capturedNote:new Map(records[0]?.entries||[]).get(key),
        legacyUnchanged:localStorage.getItem('taskpoints_v1')===originalV1,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(evidence.injected,true);
    assert.equal(evidence.torn.saved,false);
    assert.equal(evidence.torn.reason,'legacy_changed_during_capture');
    assert.equal(evidence.retry.saved,true,JSON.stringify(evidence.retry));
    assert.equal(evidence.retry.sourceStable,true);
    assert.equal(evidence.recordCount,1,'no torn checkpoint should survive as a recovery source');
    assert.equal(evidence.capturedNote,'snapshot-after');
    assert.equal(evidence.legacyUnchanged,true);
    assert.equal(evidence.authority,'legacy_only');
    return {tornInventoryRejected:true,noBadRecoveryCopy:true,
      stableRetrySucceeded:true,legacyUntouched:true};
  });

  await run('second-tab edit during SHA-256 capture rejects stale recovery copy',async context=>{
    const writer=await open(context);
    const rival=await open(context);
    const initial=await writer.evaluate(()=>{
      localStorage.setItem('taskpoints_preview_cross_tab_capture','before');
      return localStorage.getItem('taskpoints_v1');
    });
    const pending=writer.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const originalDigest=SubtleCrypto.prototype.digest;
      let held=false;
      SubtleCrypto.prototype.digest=function(){
        if(!held){
          held=true;
          localStorage.setItem('v2_browser_checkpoint_digest_paused','yes');
          return new Promise((resolve,reject)=>{
            window.__releaseCheckpointDigest=()=>{
              Promise.resolve(originalDigest.apply(this,arguments)).then(resolve,reject);
            };
          });
        }
        return originalDigest.apply(this,arguments);
      };
      try{return await runtime.createPreviewRecoveryCheckpoint();}
      finally{
        SubtleCrypto.prototype.digest=originalDigest;
        window.__releaseCheckpointDigest=null;
      }
    });
    await rival.waitForFunction(()=>
      localStorage.getItem('v2_browser_checkpoint_digest_paused')==='yes',
      null,{timeout:12000});
    await rival.evaluate(()=>
      localStorage.setItem('taskpoints_preview_cross_tab_capture','written-by-rival'));
    await writer.evaluate(()=>window.__releaseCheckpointDigest());
    const rejected=await pending;
    assert.equal(rejected.saved,false,JSON.stringify(rejected));
    assert.equal(rejected.reason,'legacy_changed_during_capture');
    const after=await writer.evaluate(async()=>{
      const saved=await window.TaskPointsStateRuntimeV2.createPreviewRecoveryCheckpoint();
      return {saved,current:localStorage.getItem('taskpoints_preview_cross_tab_capture'),
        legacy:localStorage.getItem('taskpoints_v1'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(after.saved.saved,true,JSON.stringify(after.saved));
    assert.equal(after.saved.sourceStable,true);
    assert.equal(after.current,'written-by-rival');
    assert.equal(after.legacy,initial);
    assert.equal(after.authority,'legacy_only');
    return {crossTabMutationDetected:true,staleCheckpointRefused:true,
      cleanRetrySaved:true,legacyUntouched:true};
  });

  await run('checkpoint generation tampering is detected without restoring or erasing V1',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const saved=await runtime.createPreviewRecoveryCheckpoint();
      const rawV1=localStorage.getItem('taskpoints_v1');
      const db=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const get=()=>new Promise((resolve,reject)=>{
        const req=db.transaction('snapshots','readonly').objectStore('snapshots').get(saved.checkpointId);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const row=await get();
      row.generation='forged-origin-generation';
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put(row);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      db.close();
      return {saved,verdict:await runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId),
        plan:await runtime.inspectPreviewRollbackPlan(saved.checkpointId),
        intactV1:localStorage.getItem('taskpoints_v1')===rawV1,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.saved.saved,true,JSON.stringify(proof.saved));
    assert.equal(proof.verdict.intact,false);
    assert.equal(proof.verdict.reason,'checkpoint_integrity_failed');
    assert.equal(proof.plan.planValid,false);
    assert.equal(proof.plan.canApply,false);
    assert.equal(proof.intactV1,true);
    assert.equal(proof.authority,'legacy_only');
    return {generationTamperingDetected:true,zeroRestoreWrites:true};
  });

  await run('historical payload-only checkpoint is inspectable but cannot justify rollback',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const made=await runtime.createPreviewRecoveryCheckpoint();
      if(!made.saved)throw Error('Checkpoint fixture failed: '+made.reason);
      const v1=localStorage.getItem('taskpoints_v1');
      const db=await new Promise((resolve,reject)=>{
        const r=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const source=await new Promise((resolve,reject)=>{
        const r=db.transaction('snapshots','readonly')
          .objectStore('snapshots').get(made.checkpointId);
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const old={...source};
      delete old.integrityVersion;
      old.generation='legacy-unsigned-claimed-generation';
      const payload=new TextEncoder().encode(JSON.stringify(old.entries));
      const hash=await crypto.subtle.digest('SHA-256',payload);
      old.fingerprint='sha256:'+Array.from(new Uint8Array(hash),
        b=>b.toString(16).padStart(2,'0')).join('')+':'+payload.byteLength;
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put(old);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      db.close();
      return {inspected:await runtime.inspectPreviewRecoveryCheckpoint(made.checkpointId),
        plan:await runtime.inspectPreviewRollbackPlan(made.checkpointId),
        v1Unchanged:localStorage.getItem('taskpoints_v1')===v1,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.inspected.intact,true,JSON.stringify(proof.inspected));
    assert.equal(proof.inspected.integrityCoverage,'legacy_payload_only');
    assert.equal(proof.plan.planValid,false);
    assert.equal(proof.plan.canApply,false);
    assert.equal(proof.plan.reason,'checkpoint_provenance_unverified');
    assert.equal(proof.v1Unchanged,true);
    assert.equal(proof.authority,'legacy_only');
    return {historicalPreserved:true,provenanceBlocked:true,noRestore:true};
  });

  await run('checkpoint rollback preview survives reload and reports differences without writing V1',async context=>{
    const page=await open(context);
    const saved=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      localStorage.setItem('taskpoints_preview_older_note','saved');
      localStorage.setItem('taskpoints_preview_removed_note','to be missing later');
      const checkpoint=await runtime.createPreviewRecoveryCheckpoint();
      return {checkpoint,v1:localStorage.getItem('taskpoints_v1')};
    });
    assert.equal(saved.checkpoint.saved,true,JSON.stringify(saved.checkpoint));
    await page.evaluate(()=>{
      localStorage.setItem('taskpoints_preview_older_note','updated');
      localStorage.removeItem('taskpoints_preview_removed_note');
      localStorage.setItem('taskpoints_preview_new_note','new data must remain untouched');
    });
    await page.reload({waitUntil:'load'});
    await page.evaluate(()=>window.V2BrowserFixture.start());
    const preview=await page.evaluate(async id=>{
      const before={
        v1:localStorage.getItem('taskpoints_v1'),
        newer:localStorage.getItem('taskpoints_preview_new_note'),
        edited:localStorage.getItem('taskpoints_preview_older_note'),
        old:localStorage.getItem('taskpoints_preview_removed_note')
      };
      const runtime=window.TaskPointsStateRuntimeV2;
      return {plan:await runtime.inspectPreviewRollbackPlan(id),before,
        after:{
          v1:localStorage.getItem('taskpoints_v1'),
          newer:localStorage.getItem('taskpoints_preview_new_note'),
          edited:localStorage.getItem('taskpoints_preview_older_note'),
          old:localStorage.getItem('taskpoints_preview_removed_note')
        },authority:runtime.getStatus().readAuthority};
    },saved.checkpoint.checkpointId);
    assert.equal(preview.plan.planValid,true,JSON.stringify(preview.plan));
    assert.equal(preview.plan.canApply,false);
    assert.equal(preview.plan.counts.replaceChanged,1);
    assert.equal(preview.plan.counts.removeNewer,1);
    assert.equal(preview.plan.counts.restoreMissing,1);
    assert.deepEqual(preview.after,preview.before);
    assert.equal(preview.after.v1,saved.v1);
    assert.equal(preview.authority,'legacy_only');
    return {survivedReload:true,differencesDetected:true,zeroRestoreWrites:true};
  });

  await run('failed second preview checkpoint leaves first independent checkpoint intact',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const first=await runtime.createPreviewRecoveryCheckpoint();
      const oldAdd=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(){
        if(this.name==='snapshots')
          throw new DOMException('synthetic full disk','QuotaExceededError');
        return oldAdd.apply(this,arguments);
      };
      let second;
      try{second=await runtime.createPreviewRecoveryCheckpoint();}
      finally{IDBObjectStore.prototype.add=oldAdd;}
      return {first,second,
        intact:await runtime.inspectPreviewRecoveryCheckpoint(first.checkpointId),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.first.saved,true,JSON.stringify(proof.first));
    assert.equal(proof.second.saved,false);
    assert.equal(proof.second.reason,'checkpoint_write_failed');
    assert.equal(proof.intact.intact,true);
    assert.equal(proof.authority,'legacy_only');
    return {quotaFailureContained:true,existingCheckpointPreserved:true};
  });

  await run('two tabs writing explicit recovery checkpoints retain both immutable copies',async context=>{
    const left=await open(context);
    const right=await open(context);
    const v1=await left.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const [a,b]=await Promise.all([
      left.evaluate(()=>window.TaskPointsStateRuntimeV2.createPreviewRecoveryCheckpoint()),
      right.evaluate(()=>window.TaskPointsStateRuntimeV2.createPreviewRecoveryCheckpoint())
    ]);
    assert.equal(a.saved,true,JSON.stringify(a));
    assert.equal(b.saved,true,JSON.stringify(b));
    assert.notEqual(a.checkpointId,b.checkpointId);
    const reports=await left.evaluate(async ids=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      return Promise.all(ids.map(id=>runtime.inspectPreviewRecoveryCheckpoint(id)));
    },[a.checkpointId,b.checkpointId]);
    assert.equal(reports.length,2);
    assert.ok(reports.every(row=>row.intact===true));
    assert.ok(reports.every(row=>row.canAutoRestore===false));
    const saved=await right.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const rows=await new Promise((resolve,reject)=>{
        const req=db.transaction('snapshots','readonly').objectStore('snapshots').getAll();
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      db.close();
      return {ids:rows.map(row=>row.id),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority,
        legacy:localStorage.getItem('taskpoints_v1')};
    });
    assert.ok(saved.ids.includes(a.checkpointId));
    assert.ok(saved.ids.includes(b.checkpointId));
    assert.equal(saved.ids.length,2,'neither simultaneous IndexedDB transaction may drop the other copy');
    assert.equal(saved.legacy,v1);
    assert.equal(saved.authority,'legacy_only');
    return {twoDistinctImmutableSnapshots:true,crossTabWritesSerialized:true,
      legacyDataUnchanged:true,authority:'legacy_only'};
  });

  await run('mutation-handoff preflight inventories pilot readiness but cannot promote V2', async context => {
    const page=await open(context);
    const baseline=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const oldV1=localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      return {report:await runtime.inspectMutationHandoffPrerequisites(),
        v1Unchanged:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)===oldV1,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(baseline.report.canPromote,false);
    assert.equal(baseline.report.checks.pilotConsistent,true,JSON.stringify(baseline.report));
    assert.equal(baseline.report.checks.completionIndexReady,true);
    assert.equal(baseline.report.counts.nonPilotLegacyCompletions,1);
    assert.ok(baseline.report.blockers.includes('exclusive_writer_lease_not_implemented'));
    assert.ok(baseline.report.blockers.includes('durable_authority_rollback_not_implemented'));
    assert.ok(baseline.report.blockers.includes('nonpilot_collections_not_migrated'));
    assert.equal(baseline.v1Unchanged,true);
    assert.equal(baseline.authority,'legacy_only');
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-23','full',1));
    await settled(page,1);
    const after=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      return {report:await runtime.inspectMutationHandoffPrerequisites(),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(after.report.canPromote,false);
    assert.equal(after.authority,'legacy_only');
    assert.equal(after.report.checks.pilotConsistent,true,JSON.stringify(after.report));
    assert.ok(after.report.blockers.includes('legacy_journal_pending'),
      'uncompacted V1 journal must block a mutation handoff');
    assert.ok(after.report.counts.legacyJournalPending>0);
    return {immutableHandoffGate:true,retainsNonPilotData:true,
      journalBlockerObserved:true,authority:'legacy_only'};
  });

  await run('Task journal with pending task and completion changes explicitly blocks cutover',async context=>{
    const page=await open(context);
    const originalV1=await page.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const before=await page.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers());
    assert.equal(before.taskJournal.reason,'absent',JSON.stringify(before));
    assert.equal(before.checks.taskJournalEmpty,true);
    const added=await page.evaluate(()=>{
      const task={id:'pending-cutover-task',title:'Must be replayed',
        updatedAtISO:'2026-10-28T12:00:00.000Z'};
      const completion={id:'pending-cutover-completion',taskId:task.id,
        source:'task',points:8,completedAtISO:'2026-10-28T12:00:00.000Z'};
      window.TaskPointsCore.journalTaskMutation({
        task,completionUpsert:completion,completionDeleteId:'removed-completion'
      });
      return window.TaskPointsCore.readPendingTaskMutations();
    });
    assert.equal(added.malformed,false);
    assert.equal(added.record.tasks.length,1);
    assert.equal(added.record.completionUpserts.length,1);
    assert.equal(added.record.completionDeletes.length,1);
    const blocked=await page.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers());
    assert.equal(blocked.reason,'authority_cutover_blocked',JSON.stringify(blocked));
    assert.equal(blocked.taskJournal.reason,'pending');
    assert.equal(blocked.taskJournal.pendingCount,3);
    assert.equal(blocked.taskJournal.tasks,1);
    assert.equal(blocked.taskJournal.completionUpserts,1);
    assert.equal(blocked.taskJournal.completionDeletes,1);
    assert.equal(blocked.checks.taskJournalEmpty,false);
    assert.ok(blocked.blockers.includes('task_mutation_journal_pending'));
    assert.ok(blocked.blockers.includes('all_legacy_writers_not_fenced'));
    assert.equal(blocked.canPromote,false);
    const after=await page.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      raw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.v1,originalV1);
    assert.equal(after.raw,added.raw);
    assert.equal(after.authority,'legacy_only');
    return {pendingTaskJournalVisible:true,allThreeMutationKindsCounted:true,
      pendingJournalRetained:true,cutoverStillBlocked:true};
  });

  await run('malformed Task journal blocks handoff without repair or stale snapshot overwrite',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const previous=localStorage.getItem('taskpoints_v1');
      const raw='{"schemaVersion":1,"tasks":[null],"completionUpserts":[],"completionDeletes":[]}';
      localStorage.setItem('taskpoints_pending_task_mutations_v1',raw);
      const report=await window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers();
      return {report,raw,
        currentJournal:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        snapshotBefore:previous,snapshotAfter:localStorage.getItem('taskpoints_v1'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(proof.report.reason,'authority_cutover_blocked',JSON.stringify(proof.report));
    assert.equal(proof.report.taskJournal.reason,'malformed');
    assert.equal(proof.report.taskJournal.pendingCount,null);
    assert.equal(proof.report.checks.taskJournalEmpty,false);
    assert.ok(proof.report.blockers.includes('task_mutation_journal_malformed'));
    assert.equal(proof.report.canPromote,false);
    assert.equal(proof.currentJournal,proof.raw);
    assert.equal(proof.snapshotBefore,proof.snapshotAfter);
    assert.equal(proof.authority,'legacy_only');
    return {malformedJournalNotMisreadAsEmpty:true,
      corruptEvidenceUnchanged:true,legacySnapshotPreserved:true};
  });

  await run('unfenced Task mutation during cutover peer probe invalidates inspection',async context=>{
    const observer=await open(context),writer=await open(context);
    const originalV1=await observer.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=observer.evaluate(async()=>{
      const original=BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage=function(message){
        if(message?.type==='writer_probe_v1')
          window.__taskJournalCutoverProbeActive=true;
        return original.apply(this,arguments);
      };
      try{return await window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers();}
      finally{BroadcastChannel.prototype.postMessage=original;}
    });
    await observer.waitForFunction(()=>
      window.__taskJournalCutoverProbeActive===true,null,{timeout:12000});
    const source=await writer.evaluate(()=>{
      window.TaskPointsCore.journalTaskMutation({
        task:{id:'racing-task-cutover',title:'From unfenced V1 tab',
          updatedAtISO:'2026-10-28T12:00:00.000Z'}
      });
      return localStorage.getItem('taskpoints_pending_task_mutations_v1');
    });
    const report=await pending;
    assert.equal(report.reason,'inventory_changed_during_check',JSON.stringify(report));
    assert.equal(report.canPromote,false);
    assert.ok(report.blockers.includes('legacy_or_preview_inventory_changed_during_check'));
    assert.equal(report.checks.allLegacyWritersFenced,false);
    const after=await writer.evaluate(()=>({
      snapshot:localStorage.getItem('taskpoints_v1'),
      journal:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.snapshot,originalV1);
    assert.equal(after.journal,source);
    assert.equal(after.authority,'legacy_only');
    return {realTaskJournalCrossTabRaceObserved:true,
      taskMutationStillDurable:true,noSnapshotReplacement:true};
  });

  await run('real Task journal flush persists edits before clearing its source but cannot authorize cutover',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const core=window.TaskPointsCore;
      const runtime=window.TaskPointsStateRuntimeV2;
      const base=localStorage.getItem('taskpoints_v1');
      const task={id:'flush-proof-task',title:'Compacted actual Task journal',
        updatedAtISO:'2026-10-28T12:00:00.000Z'};
      const completion={id:'flush-proof-completion',taskId:task.id,
        title:'Actual compaction completion',source:'task',points:7,
        completedAtISO:'2026-10-28T12:00:00.000Z'};
      core.journalTaskMutation({task,completionUpsert:completion});
      const before=await runtime.inspectAuthorityCutoverBarriers();
      const rawBefore=localStorage.getItem('taskpoints_pending_task_mutations_v1');
      const flushed=core.flushPendingTaskMutations();
      const persisted=core.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'),{});
      const journalAfter=core.readPendingTaskMutations();
      const after=await runtime.inspectAuthorityCutoverBarriers();
      return {base,before,rawBefore,flushed,persisted,journalAfter,after,
        remainingRaw:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.before.taskJournal.reason,'pending');
    assert.equal(proof.before.taskJournal.pendingCount,2);
    assert.equal(proof.flushed,true,'Real synchronous compaction should report success');
    assert.ok(proof.persisted.tasks.some(t=>t.id==='flush-proof-task'));
    assert.ok(proof.persisted.completions.some(c=>c.id==='flush-proof-completion'));
    assert.equal(proof.journalAfter.malformed,false);
    assert.equal(proof.journalAfter.record.tasks.length,0);
    assert.equal(proof.journalAfter.record.completionUpserts.length,0);
    assert.equal(proof.remainingRaw,null,'Only verified compacted rows can be removed');
    assert.equal(proof.after.taskJournal.reason,'absent');
    assert.equal(proof.after.checks.taskJournalEmpty,true);
    assert.equal(proof.after.canPromote,false);
    assert.equal(proof.after.checks.allLegacyWritersFenced,false);
    assert.ok(proof.after.blockers.includes('all_legacy_writers_not_fenced'));
    assert.equal(proof.authority,'legacy_only');
    return {taskAndCompletionPersisted:true,verifiedJournalCleared:true,
      journalEmptyNotWriterFencing:true,cutoverBlocked:true};
  });

  await run('failed real Task journal compaction keeps pending mutation and blocks cutover',async context=>{
    const page=await open(context);
    const proof=await page.evaluate(async()=>{
      const core=window.TaskPointsCore;
      const runtime=window.TaskPointsStateRuntimeV2;
      const initial=localStorage.getItem('taskpoints_v1');
      core.journalTaskMutation({task:{
        id:'failed-compaction-task',title:'Keep after blocked save',
        updatedAtISO:'2026-10-28T12:00:00.000Z'
      }});
      const raw=localStorage.getItem('taskpoints_pending_task_mutations_v1');
      const originalSet=Storage.prototype.setItem;
      let rejected=0,flushed;
      Storage.prototype.setItem=function(key,value){
        if(this===localStorage&&key==='taskpoints_v1'){
          rejected++;
          throw new DOMException('Injected snapshot quota denial','QuotaExceededError');
        }
        return originalSet.call(this,key,value);
      };
      try{flushed=core.flushPendingTaskMutations();}
      finally{Storage.prototype.setItem=originalSet;}
      const report=await runtime.inspectAuthorityCutoverBarriers();
      return {initial,raw,flushed,rejected,report,
        after:localStorage.getItem('taskpoints_v1'),
        pending:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        visible:core.readPendingTaskMutations(),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.flushed,false,'Injected quota failure must not count as compaction');
    assert.ok(proof.rejected>=1,'The real V1 snapshot writer must have been exercised');
    assert.equal(proof.after,proof.initial);
    assert.equal(proof.pending,proof.raw);
    assert.equal(proof.visible.malformed,false);
    assert.equal(proof.visible.record.tasks.length,1);
    assert.equal(proof.report.taskJournal.reason,'pending');
    assert.equal(proof.report.taskJournal.pendingCount,1);
    assert.equal(proof.report.checks.taskJournalEmpty,false);
    assert.ok(proof.report.blockers.includes('task_mutation_journal_pending'));
    assert.equal(proof.report.canPromote,false);
    assert.equal(proof.authority,'legacy_only');
    return {quotaDeniedCompaction:true,pendingTaskPreserved:true,
      snapshotNotOverwritten:true,cutoverBlocked:true};
  });

  await run('stale Home-like Task save after other tab compacted a newer Task edit preserves that row',async context=>{
    const stale=await open(context),writer=await open(context);
    const seed=await stale.evaluate(()=>{
      const core=window.TaskPointsCore;
      const current=core.readTaskPointsStoredState();
      current.tasks=current.tasks.map(t=>t.id==='synthetic-task'
        ? {...t,updatedAtISO:'2026-10-20T10:00:00.000Z'}:t);
      const saved=core.saveStateSnapshot(current,{
        immediateWrite:true,userInitiated:true,savePath:'v2-stale-task-base'});
      if(saved?.skipped)throw Error('Base snapshot write skipped');
      return {raw:localStorage.getItem('taskpoints_v1'),
        state:core.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'),{})};
    });
    const fresh=await writer.evaluate(()=>{
      const core=window.TaskPointsCore;
      core.journalTaskMutation({task:{
        id:'synthetic-task',title:'NEWER JOURNAL TASK EDIT',
        updatedAtISO:'2026-10-28T12:00:00.000Z'
      }});
      const flushed=core.flushPendingTaskMutations();
      return {flushed,raw:localStorage.getItem('taskpoints_v1'),
        journal:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        task:core.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'),{})
          .tasks.find(t=>t.id==='synthetic-task')};
    });
    assert.equal(fresh.flushed,true);
    assert.equal(fresh.journal,null);
    assert.equal(fresh.task.title,'NEWER JOURNAL TASK EDIT');
    await stale.waitForFunction(raw=>localStorage.getItem('taskpoints_v1')===raw,
      fresh.raw,{timeout:12000});
    const attempted=await stale.evaluate(oldState=>{
      const core=window.TaskPointsCore;
      const prior=oldState.tasks.find(t=>t.id==='synthetic-task');
      const result=core.saveStateSnapshot(oldState,{
        immediateWrite:true,userInitiated:true,savePath:'home-stale-task-fixture'});
      const after=core.parseTaskPointsStorageJson(localStorage.getItem('taskpoints_v1'),{});
      return {oldTitle:prior.title,afterTask:after.tasks.find(t=>t.id==='synthetic-task'),
        completionIds:after.completions.map(c=>c.id),
        resultSkipped:result?.skipped===true,
        journal:localStorage.getItem('taskpoints_pending_task_mutations_v1'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    },seed.state);
    assert.equal(attempted.oldTitle,'Synthetic task');
    assert.equal(attempted.afterTask.title,'NEWER JOURNAL TASK EDIT',
      'A previously compacted Task edit must survive a stale tab save');
    assert.equal(attempted.journal,null);
    assert.ok(attempted.completionIds.includes('synthetic-task-completion'));
    assert.equal(attempted.authority,'legacy_only');
    const gate=await stale.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers());
    assert.equal(gate.checks.taskJournalEmpty,true);
    assert.equal(gate.canPromote,false);
    assert.ok(gate.blockers.includes('all_legacy_writers_not_fenced'));
    return {newerTaskRowSurvivedStaleWriter:true,existingCompletionPreserved:true,
      journalAlreadyEmpty:true,oldTabsStillBlockCutover:true};
  });

  await run('full cutover inventory refuses a green pilot and silent legacy writer',async context=>{
    const inspector=await open(context),participant=await open(context);
    const silent=await context.newPage();
    await silent.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const v1Before=await inspector.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const report=await inspector.evaluate(()=>
      window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers());
    assert.equal(report.checked,true);
    assert.equal(report.reason,'authority_cutover_blocked',JSON.stringify(report));
    assert.equal(report.canPromote,false);
    assert.equal(report.mutationAuthority,'legacy_only');
    assert.equal(report.readAuthority,'legacy_only');
    assert.equal(report.checks.pilotConsistent,true,JSON.stringify(report));
    assert.equal(report.checks.allLegacyWritersFenced,false);
    assert.equal(report.checks.allAuthoritativeCollectionsMigrated,false);
    assert.equal(report.checks.independentOffDeviceRollbackVerified,false);
    assert.equal(report.checks.physicalSafariPwaLifecycleValidated,false);
    assert.equal(report.checks.productionMultiContextHandoffValidated,false);
    assert.equal(report.rollback.canRestoreFromCheckpoint,false);
    assert.equal(report.knownUnfencedWriterFamilies.length,7);
    for(const blocker of [
      'all_legacy_writers_not_fenced',
      'nonpilot_authoritative_collections_not_migrated',
      'independent_off_device_rollback_not_verified',
      'physical_safari_pwa_lifecycle_not_validated',
      'production_multi_context_handoff_not_validated'
    ])assert.ok(report.blockers.includes(blocker),blocker);
    const after=await inspector.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.v1,v1Before);
    assert.equal(after.authority,'legacy_only');
    return {greenPilotStillBlocked:true,sevenWriterFamiliesEnumerated:true,
      existingLegacyStatePreserved:true,nonpilotCutoverProhibited:true};
  });

  await run('full cutover inventory catches unrelated V1 key changed during peer probe',async context=>{
    const inspector=await open(context),legacy=await context.newPage();
    await legacy.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const v1Before=await inspector.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const pending=inspector.evaluate(async()=>{
      const original=BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage=function(message){
        // Test-only, in-memory synchronization; do not alter the storage
        // inventory being observed before the legacy-only tab writes.
        if(message?.type==='writer_probe_v1')
          window.__v2CutoverPeerProbeActive=true;
        return original.apply(this,arguments);
      };
      try{return await window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers();}
      finally{BroadcastChannel.prototype.postMessage=original;}
    });
    await inspector.waitForFunction(()=>
      window.__v2CutoverPeerProbeActive===true,
      null,{timeout:12000});
    const edited=await legacy.evaluate(()=>{
      localStorage.setItem('taskpoints_notes_v1','legacy-only tab edited notes');
      return localStorage.getItem('taskpoints_notes_v1');
    });
    const report=await pending;
    assert.equal(edited,'legacy-only tab edited notes');
    assert.equal(report.reason,'inventory_changed_during_check',JSON.stringify(report));
    assert.ok(report.blockers.includes('legacy_or_preview_inventory_changed_during_check'));
    assert.equal(report.canPromote,false);
    assert.equal(report.checks.allLegacyWritersFenced,false);
    const final=await inspector.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      notes:localStorage.getItem('taskpoints_notes_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(final.v1,v1Before);
    assert.equal(final.notes,'legacy-only tab edited notes');
    assert.equal(final.authority,'legacy_only');
    return {nonpilotWriteRaceDetected:true,oldLegacyNotesPreserved:true,
      pilotStateNotClobbered:true,noAuthorityPromotion:true};
  });

  await run('full cutover audit observes tp_projects key outside checkpoint namespace',async context=>{
    const inspector=await open(context),legacy=await context.newPage();
    await legacy.goto(url.replace('v2-storage-fixture.html','v2-upgrade-seed.html'),
      {waitUntil:'load'});
    const before=await inspector.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      projects:localStorage.getItem('tp_projects_v1')
    }));
    const pending=inspector.evaluate(async()=>{
      const original=BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage=function(message){
        if(message?.type==='writer_probe_v1')
          window.__v2ProjectsProbeStarted=true;
        return original.apply(this,arguments);
      };
      try{return await window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers();}
      finally{BroadcastChannel.prototype.postMessage=original;}
    });
    await inspector.waitForFunction(()=>window.__v2ProjectsProbeStarted===true,
      null,{timeout:12000});
    const changed=await legacy.evaluate(()=>{
      const value='[{"id":"project-from-unfenced-legacy-tab"}]';
      localStorage.setItem('tp_projects_v1',value);
      return localStorage.getItem('tp_projects_v1');
    });
    const result=await pending;
    assert.equal(result.reason,'inventory_changed_during_check',JSON.stringify(result));
    assert.ok(result.blockers.includes('legacy_or_preview_inventory_changed_during_check'));
    assert.equal(result.canPromote,false);
    assert.equal(result.checks.allLegacyWritersFenced,false);
    assert.equal(result.mutationAuthority,'legacy_only');
    const after=await inspector.evaluate(()=>({
      v1:localStorage.getItem('taskpoints_v1'),
      projects:localStorage.getItem('tp_projects_v1'),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.v1,before.v1);
    assert.equal(after.projects,changed);
    assert.notEqual(after.projects,before.projects);
    assert.equal(after.authority,'legacy_only');
    return {unprefixedLegacyProjectsRaceDetected:true,
      projectWritePreserved:true,legacySnapshotUnchanged:true,cutoverStillBlocked:true};
  });

  await run('cutover inspection fails closed when full-origin storage key read is denied',async context=>{
    const page=await open(context);
    await page.evaluate(()=>localStorage.setItem('tp_projects_v1','synthetic-original-projects'));
    const proof=await page.evaluate(async()=>{
      const originalV1=localStorage.getItem('taskpoints_v1');
      const originalProject=localStorage.getItem('tp_projects_v1');
      const original=Storage.prototype.getItem;
      let report;
      Storage.prototype.getItem=function(key){
        if(this===localStorage && key==='tp_projects_v1')
          throw new DOMException('synthetic project access denial','SecurityError');
        return original.call(this,key);
      };
      try{report=await window.TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers();}
      finally{Storage.prototype.getItem=original;}
      return {report,
        originalV1,originalProject,
        afterV1:localStorage.getItem('taskpoints_v1'),
        afterProject:localStorage.getItem('tp_projects_v1'),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(proof.report.reason,'inspection_unreadable',JSON.stringify(proof.report));
    assert.ok(proof.report.blockers.includes('authority_cutover_inventory_unreadable'));
    assert.equal(proof.report.canPromote,false);
    assert.equal(proof.report.checks.allLegacyWritersFenced,false);
    assert.equal(proof.originalV1,proof.afterV1);
    assert.equal(proof.originalProject,proof.afterProject);
    assert.equal(proof.authority,'legacy_only');
    return {deniedProjectKeyAbortsInspection:true,
      noLegacyWrites:true,productionAuthorityUnchanged:true};
  });

  await run('guarded V2 Habit candidate reads prove data without changing V1 authority', async context => {
    const page = await open(context);
    const before = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      const rawV1 = localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      const candidate = await runtime.readPilotHabitCandidate('h1');
      const invalid = await runtime.readPilotHabitCandidate(' ');
      return { candidate, invalid, legacyUnchanged: rawV1 === localStorage.getItem(window.TaskPointsCore.STORAGE_KEY),
        authority: runtime.getStatus().readAuthority };
    });
    assert.equal(before.candidate.eligible, true, JSON.stringify(before.candidate));
    assert.equal(before.candidate.source, 'v2_preview_only');
    assert.equal(before.candidate.habit.name, 'Synthetic h1');
    assert.deepEqual(before.candidate.completions, []);
    assert.equal(before.invalid.eligible, false);
    assert.equal(before.invalid.reason, 'habit_id_required');
    assert.equal(before.legacyUnchanged, true);
    assert.equal(before.authority, 'legacy_only');
    await page.evaluate(() => window.V2BrowserFixture.delta('h1', '2026-10-20', 'full', 1));
    await settled(page, 1);
    const completed = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      return { candidate: await runtime.readPilotHabitCandidate('h1'),
        authority: runtime.getStatus().readAuthority };
    });
    assert.equal(completed.candidate.eligible, true, JSON.stringify(completed.candidate));
    assert.deepEqual(completed.candidate.completions.map(c => c.id), ['habit:h1:2026-10-20']);
    assert.equal(completed.authority, 'legacy_only');
    await parity(page);
    return {previewHabitRead:true,completionRead:true,legacyAuthorityUnchanged:true};
  });

  await run('preview Habit reader refuses out-of-scope V2 completion without deleting it', async context => {
    const page = await open(context);
    const state = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      const db = await runtime.open();
      const candidate = {id:'unexpected:task',value:{
        id:'unexpected:task',habitId:'h1',source:'task',points:1,
        completedAtISO:'2026-10-20T12:00:00.000Z'
      },sequence:999};
      const tx = db.transaction('completions', 'readwrite');
      tx.objectStore('completions').put(candidate);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
      const legacyRaw = localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      const readiness = await runtime.inspectPilotReadiness();
      const habitRead = await runtime.readPilotHabitCandidate('h1');
      const request = db.transaction('completions','readonly')
        .objectStore('completions').get(candidate.id);
      const preserved = await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {readiness,habitRead,preserved,
        sameV1:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)===legacyRaw,
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(state.readiness.eligible,false);
    assert.equal(state.readiness.reason,'unexpected_nonpilot_completions');
    assert.equal(state.habitRead.eligible,false);
    assert.equal(state.habitRead.reason,'unexpected_nonpilot_completions');
    assert.equal(Object.hasOwn(state.habitRead,'habit'),false);
    assert.equal(state.preserved.id,'unexpected:task');
    assert.equal(state.sameV1,true);
    assert.equal(state.authority,'legacy_only');
    return {outOfScopeRejected:true,diagnosticEvidenceRetained:true,v1Unchanged:true};
  });

  await run('guarded V2 Habit candidate rejects mid-read V1 change without exposing stale records', async context => {
    const page = await open(context);
    const result = await page.evaluate(async () => {
      const runtime = window.TaskPointsStateRuntimeV2;
      const storageKey = window.TaskPointsCore.STORAGE_KEY;
      const original = Storage.prototype.getItem;
      let reads = 0;
      Storage.prototype.getItem = function(key) {
        if (this === localStorage && String(key) === storageKey && ++reads === 3) {
          const changed = window.V2BrowserFixture.rawLegacy();
          changed.habits[0].name = 'Mid-read external edit';
          localStorage.setItem(storageKey, JSON.stringify(changed));
        }
        return original.call(this, key);
      };
      let candidate;
      try { candidate = await runtime.readPilotHabitCandidate('h1'); }
      finally { Storage.prototype.getItem = original; }
      return {candidate, reads, v1Name:window.V2BrowserFixture.rawLegacy().habits[0].name,
        readAuthority:runtime.getStatus().readAuthority};
    });
    assert.ok(result.reads >= 3, 'must recheck V1 after IDB candidate read');
    assert.equal(result.candidate.eligible, false);
    assert.equal(result.candidate.source, 'none');
    assert.equal(result.candidate.reason, 'pilot_parity_mismatch');
    assert.equal(Object.hasOwn(result.candidate, 'habit'), false);
    assert.equal(result.v1Name, 'Mid-read external edit');
    assert.equal(result.readAuthority, 'legacy_only');
    return {midReadChangeBlocked:true,noStaleV2DataReturned:true,v1EditPreserved:true};
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

  await run('ephemeral V1-only pilot read probe resets across five reloads and keeps WAL recovery intact', async context => {
    const page=await open(context);
    const first=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const disabled=await runtime.probePilotHabitRead('h1');
      runtime.setPilotReadProbeEnabled(true);
      const enabled=await runtime.probePilotHabitRead('h1');
      return {disabled,enabled,status:runtime.getStatus(),
        originalV1:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)};
    });
    assert.equal(first.disabled.reason,'probe_disabled');
    assert.equal(first.enabled.matched,true,JSON.stringify(first.enabled));
    assert.equal(first.enabled.selectedSource,'legacy_only');
    assert.equal(first.status.readAuthority,'legacy_only');
    for(let i=0;i<5;i++){
      await page.reload({waitUntil:'load'});
      await page.evaluate(()=>window.V2BrowserFixture.start());
      const before=await page.evaluate(async()=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        const status=runtime.getStatus();
        return {active:status.pilotReadProbeEnabled,
          disabled:await runtime.probePilotHabitRead('h1'),
          rawV1:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)};
      });
      assert.equal(before.active,false,'read probe must not persist across reloads');
      assert.equal(before.disabled.reason,'probe_disabled');
      assert.equal(before.disabled.selectedSource,'legacy_only');
      assert.equal(before.rawV1,first.originalV1);
      await page.evaluate(()=>window.TaskPointsStateRuntimeV2.setPilotReadProbeEnabled(true));
      const proof=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.probePilotHabitRead('h1'));
      assert.equal(proof.matched,true,JSON.stringify(proof));
      assert.equal(proof.lookupMode,'indexed');
      assert.equal(proof.selectedSource,'legacy_only');
      assert.equal((await parity(page)).match,true);
      assert.equal((await page.evaluate(()=>window.TaskPointsStateRuntimeV2.getStatus())).readAuthority,'legacy_only');
    }
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-22','full',1));
    await settled(page,1);
    const after=await page.evaluate(()=>window.TaskPointsStateRuntimeV2.probePilotHabitRead('h1'));
    assert.equal(after.matched,true,JSON.stringify(after));
    assert.equal(after.counts.candidateCompletions,1);
    assert.equal(after.counts.legacyCompletions,1);
    await parity(page);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.setPilotReadProbeEnabled(false));
    assert.equal((await page.evaluate(()=>window.TaskPointsStateRuntimeV2.probePilotHabitRead('h1'))).reason,'probe_disabled');
    return {reloads:5,probeDefaultsOff:true,legacyOnly:true,postReloadCompletionCompared:true};
  });

  await run('cross-tab V2 revision invalidates probe until refreshed V1 and V2 match again', async context => {
    const first=await open(context);
    const stale=await open(context);
    const ready=await stale.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      runtime.setPilotReadProbeEnabled(true);
      return runtime.probePilotHabitRead('h2');
    });
    assert.equal(ready.matched,true,JSON.stringify(ready));
    await first.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-22','full',2));
    await settled(first,1);
    await stale.waitForFunction(()=>window.TaskPointsStateRuntimeV2.getStatus().externalRevisionInvalidated===true,
      null,{timeout:12000});
    const refused=await stale.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const before=await runtime.probePilotHabitRead('h2');
      return {before,rawLegacy:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)};
    });
    assert.equal(refused.before.matched,false);
    assert.equal(refused.before.reason,'external_revision_invalidated');
    assert.equal(refused.before.selectedSource,'legacy_only');
    assert.equal(Object.hasOwn(refused.before,'habit'),false);
    await stale.reload({waitUntil:'load'});
    await stale.evaluate(()=>window.V2BrowserFixture.start());
    const recovered=await stale.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const off=await runtime.probePilotHabitRead('h2');
      runtime.setPilotReadProbeEnabled(true);
      const result=await runtime.probePilotHabitRead('h2');
      return {off,result,status:runtime.getStatus()};
    });
    assert.equal(recovered.off.reason,'probe_disabled');
    assert.equal(recovered.result.matched,true,JSON.stringify(recovered.result));
    assert.equal(recovered.result.counts.candidateCompletions,1);
    assert.equal(recovered.status.readAuthority,'legacy_only');
    assert.equal((await parity(stale)).match,true);
    return {staleTabRefused:true,refreshedTabMatched:true,readAuthority:'legacy_only'};
  });

  await run('three repeated same-generation V1 mismatch reloads preserve V2 evidence without auto-repair', async context => {
    const page=await open(context);
    const baseline=await page.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const inspect=async()=>{
        const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
        const read=name=>new Promise((resolve,reject)=>{
          const req=tx.objectStore(name).getAll();
          req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
        });
        return JSON.stringify(await Promise.all(['meta','habits','completions','mutations'].map(read)));
      };
      return {original:localStorage.getItem('taskpoints_v1'),mirror:await inspect(),
        generation:window.TaskPointsStateRuntimeV2Generation.read()};
    });
    await page.evaluate(()=>{
      const key='taskpoints_v1';
      const edited=JSON.parse(localStorage.getItem(key));
      edited.habits[0].name='Synthetic V1-only external correction';
      localStorage.setItem(key,JSON.stringify(edited));
    });
    for(let attempt=0;attempt<3;attempt++){
      await page.reload({waitUntil:'load'});
      await page.evaluate(()=>window.V2BrowserFixture.start());
      const proof=await page.evaluate(async()=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        runtime.setPilotReadProbeEnabled(true);
        const verdict=await runtime.probePilotHabitRead('h1');
        const db=await runtime.open();
        const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
        const read=name=>new Promise((resolve,reject)=>{
          const req=tx.objectStore(name).getAll();
          req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
        });
        const mirror=JSON.stringify(await Promise.all(
          ['meta','habits','completions','mutations'].map(read)));
        return {verdict,mirror,
          legacyName:JSON.parse(localStorage.getItem('taskpoints_v1')).habits[0].name,
          generation:window.TaskPointsStateRuntimeV2Generation.read(),
          readAuthority:runtime.getStatus().readAuthority};
      });
      assert.equal(proof.verdict.matched,false);
      assert.equal(proof.verdict.reason,'pilot_parity_mismatch');
      assert.equal(proof.verdict.selectedSource,'legacy_only');
      assert.equal(Object.hasOwn(proof.verdict,'habit'),false);
      assert.equal(proof.mirror,baseline.mirror,
        'failed parity cannot silently replace V2 mirror evidence after reload');
      assert.equal(proof.legacyName,'Synthetic V1-only external correction');
      assert.equal(proof.generation,baseline.generation);
      assert.equal(proof.readAuthority,'legacy_only');
    }
    await page.evaluate(raw=>localStorage.setItem('taskpoints_v1',raw),baseline.original);
    await page.reload({waitUntil:'load'});
    await page.evaluate(()=>window.V2BrowserFixture.start());
    const recovered=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      runtime.setPilotReadProbeEnabled(true);
      return {probe:await runtime.probePilotHabitRead('h1'),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(recovered.probe.matched,true,JSON.stringify(recovered.probe));
    assert.equal(recovered.authority,'legacy_only');
    return {repeatedMismatchesPreserved:3,legacyCorrectionRetained:true,
      recoveryWithoutRepair:true,readAuthority:'legacy_only'};
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

  await run('two suspended writers recover across verified V1 compaction without losing either WAL mutation',async context=>{
    const survivor=await open(context);
    const expected=[
      {habitId:'h1',day:'2026-10-14',n:14},
      {habitId:'h2',day:'2026-10-15',n:15}
    ];
    const initial=await survivor.evaluate(()=>({
      generation:window.TaskPointsStateRuntimeV2.getStatus().currentGeneration
    }));
    // All three browsing contexts must finish initial startup BEFORE any
    // WAL is held. Opening writer two after writer one closes would itself
    // replay writer one's WAL, so that is a different single-row scenario.
    const writers=await Promise.all(expected.map(()=>open(context)));
    for(const [index,event] of expected.entries()){
      const writer=writers[index];
      const held=await writer.evaluate(({habitId,day,n})=>{
        sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
        const result=window.V2BrowserFixture.delta(habitId,day,'full',n);
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pagehide'));
        return {id:result.id,wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length,
          journal:window.TaskPointsCore.readPendingHabitDeltas().length};
      },event);
      assert.equal(held.id,'habit:'+event.habitId+':'+event.day);
      assert.equal(held.wal,expected.indexOf(event)+1);
      assert.equal(held.journal,expected.indexOf(event)+1);
      await writer.close();
    }
    // All independently durable rows must be visible before compaction.
    // WebKit can dispatch a cross-tab storage update after the writer page
    // closes, so an immediate read is not a stable observation point.
    await survivor.waitForFunction(()=>{
      const wal=window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      const journal=window.TaskPointsCore.readPendingHabitDeltas();
      return wal.ok && wal.rows.length===2
        && new Set(wal.rows.map(r=>r.id)).size===2
        && journal.length===2;
    },null,{timeout:12000,polling:50});
    const checkpoint=await survivor.evaluate(()=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      const walBefore=window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      const originalGeneration=window.TaskPointsStateRuntimeV2.getStatus().currentGeneration;
      const raw=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(raw,pending);
      const saved=core.saveStateSnapshot(raw,{immediateWrite:true,replaceCompletions:true,
        savePath:'habit-journal-compaction'});
      if(saved?.blocked||saved?.skipped)throw Error('V1 verified checkpoint save blocked');
      const persisted=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas(persisted,pending,applied.appliedDeltas);
      core.clearCompactedHabitDeltas(verified);
      return {walIds:walBefore.rows.map(r=>r.id).sort(),
        verified:verified.length,remaining:core.readPendingHabitDeltas().length,
        walAfter:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length,
        pilotIds:persisted.completions.filter(c=>c.source==='habit').map(c=>c.id).sort(),
        generationUnchanged:originalGeneration===window.TaskPointsStateRuntimeV2.getStatus().currentGeneration};
    });
    assert.equal(checkpoint.verified,2,'both V1 journal deltas must be verified before cleanup');
    assert.equal(checkpoint.remaining,0,'verified V1 journal must be compacted');
    // Verify the durable sidecars are still present *after* the verified V1
    // cleanup, not just transiently visible during a concurrent storage event.
    // Keep the exact-set check: a genuinely lost row still fails the gate.
    await survivor.waitForFunction(expectedIds=>{
      const wal=window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      const ids=wal.rows.map(r=>r.id).sort();
      return wal.ok && ids.length===expectedIds.length
        && ids.every((id,i)=>id===expectedIds[i])
        && window.TaskPointsStateRuntimeV2Wal.getStatus().independentEventCount===2;
    },checkpoint.walIds,{timeout:12000,polling:50});
    assert.equal(checkpoint.walIds.length,2);
    assert.deepEqual(checkpoint.pilotIds,['habit:h1:2026-10-14','habit:h2:2026-10-15']);
    assert.equal(checkpoint.generationUnchanged,true);
    await survivor.reload({waitUntil:'load'});
    await survivor.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s&&s.wal.pendingCount===0&&s.bridge.replayCleared>=2;
    },null,{timeout:25000});
    const recovered=await parity(survivor);
    assert.equal(recovered.actualCounts.completions,2);
    const status=await survivor.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.bridge.failures,0);
    assert.equal(status.runtime.readAuthority,'legacy_only');
    assert.equal(status.bridge.lastStartupOrder,'wal_then_seed');
    // An additional post-compaction event must not be lost or misplaced by
    // leftover checkpoint metadata from the earlier held WAL.
    await survivor.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-16','full',16));
    await settled(survivor,1);
    assert.equal((await parity(survivor)).actualCounts.completions,3);
    await survivor.reload({waitUntil:'load'});
    assert.equal((await parity(survivor)).actualCounts.completions,3);
    const proof=await survivor.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const tx=db.transaction(['mutations','completions'],'readonly');
      const get=name=>new Promise((resolve,reject)=>{
        const r=tx.objectStore(name).getAll();
        r.onsuccess=()=>resolve(r.result);
        r.onerror=()=>reject(r.error);
      });
      const [mutations,rows]=await Promise.all(['mutations','completions'].map(get));
      return {mutations:mutations.map(x=>x.id).sort(),
        completionIds:rows.flatMap(x=>Array.isArray(x.entries)
          ?x.entries.map(y=>y.value.id):x.value?.id?[x.value.id]:[]).sort(),
        order:(await runtime.buildCompatibilitySnapshot()).completions
          .filter(c=>c.source==='habit').map(c=>c.id),
        generation:runtime.getStatus().currentGeneration};
    });
    assert.equal(proof.mutations.length,3);
    assert.equal(new Set(proof.mutations).size,3);
    assert.deepEqual(proof.completionIds,[
      'habit:h1:2026-10-14','habit:h1:2026-10-16','habit:h2:2026-10-15']);
    assert.equal(proof.order[0],'habit:h1:2026-10-16');
    assert.equal(proof.generation,initial.generation);
    return {suspendedWriters:2,verifiedV1Compaction:true,replayedWal:2,
      laterWriteRetained:true,mutations:3,parity:true};
  });

  await run('suspended pre-import WAL stays quarantined through two authorized generations and new writes',async context=>{
    // Both tabs already exist before the old-generation WAL event. Keeping
    // writer alive simulates an iPhone tab suspended through two restores.
    const active=await open(context),sleeping=await open(context);
    const previous=await active.evaluate(()=>window.TaskPointsStateRuntimeV2Generation.read());
    const held=await sleeping.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      const row=window.V2BrowserFixture.delta('h1','2026-10-14','full',1);
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      return {id:row.id,wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows()};
    });
    assert.equal(held.wal.ok,true);
    assert.equal(held.wal.rows.length,1);
    assert.equal(held.wal.rows[0].generation,previous);
    const staleId=held.wal.rows[0].id;
    // Make the V1 journal entry a verified canonical completion, preserving
    // the real user's data rather than throwing away it during the restore.
    const firstCheckpoint=await active.evaluate(async()=>{
      const core=window.TaskPointsCore;
      let verified=null;
      let attempts=0;
      // A concurrent suspended-tab save can race the verified V1 checkpoint
      // in WebKit. Never clear the journal on an unverified attempt. Re-read
      // the retained durable journal and retry the idempotent compaction in
      // bounded fashion; fail if no attempt actually persists its completion.
      while(attempts<3){
        attempts++;
        const journal=core.readPendingHabitDeltas();
        if(journal.length!==1)throw Error('Old-generation journal not preserved for retry');
        const canonical=window.V2BrowserFixture.rawLegacy();
        const applied=core.applyPendingHabitDeltas(canonical,journal);
        const saved=core.saveStateSnapshot(canonical,{
          immediateWrite:true,replaceCompletions:true,savePath:'habit-journal-compaction'});
        if(saved?.blocked||saved?.skipped)throw Error('V1 checkpoint failed');
        verified=core.verifyPersistedHabitDeltas(
          window.V2BrowserFixture.rawLegacy(),journal,applied.appliedDeltas);
        if(verified.length===1){
          core.clearCompactedHabitDeltas(verified);
          return {remaining:core.readPendingHabitDeltas().length,
            completed:window.V2BrowserFixture.rawLegacy().completions.filter(c=>c.source==='habit').length};
        }
        // An unverified save MUST NOT remove the pending WAL or sidecar.
        if(core.readPendingHabitDeltas().length!==1)
          throw Error('Old-generation unverified journal was lost');
        await new Promise(done=>setTimeout(done,25*attempts));
      }
      throw Error('Old-generation V1 checkpoint not verified after three preserved-journal attempts');
    });
    assert.deepEqual(firstCheckpoint,{remaining:0,completed:1});
    const rotate=async name=>active.evaluate(async label=>{
      const core=window.TaskPointsCore;
      const incoming=window.V2BrowserFixture.rawLegacy();
      incoming.habits.find(h=>h.id==='h3').name=label;
      const saved=core.saveValidatedSnapshot(incoming,{
        allowDestructiveOverwrite:true,source:'settings-import',immediateWrite:true});
      if(saved?.blocked||saved?.skipped)throw Error('Authorized V1 import rejected');
      const generation=window.TaskPointsStateRuntimeV2Generation.read();
      await window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror();
      return {generation,name:window.V2BrowserFixture.rawLegacy().habits.find(h=>h.id==='h3').name};
    },name);
    const first=await rotate('Imported h3 generation one');
    assert.notEqual(first.generation,previous);
    assert.equal(first.name,'Imported h3 generation one');
    const inspect=page=>page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const wal=window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      const db=await runtime.open();
      const tx=db.transaction(['mutations','meta'],'readonly');
      const get=name=>new Promise((resolve,reject)=>{
        const request=tx.objectStore(name).getAll();
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const [mutations,meta]=await Promise.all(['mutations','meta'].map(get));
      return {rows:wal.rows.map(r=>({id:r.id,generation:r.generation})),
        mutations:mutations.map(m=>({id:m.id,generation:m.resetGeneration})),
        meta:meta[0],authority:runtime.getStatus().readAuthority};
    });
    let state=await inspect(active);
    assert.equal(state.meta.resetGeneration,first.generation);
    assert.equal(state.meta.completionOrderEpoch||0,0);
    assert.deepEqual(state.rows,[{id:staleId,generation:previous}]);
    assert.deepEqual(state.mutations,[],'import must not replay old generation mutation');
    assert.equal((await parity(active)).actualCounts.completions,1);
    const resume=await sleeping.evaluate(async()=>{
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
      return await window.TaskPointsStateRuntimeV2WalBridge.replayPending();
    });
    assert.equal(resume.cleared,0);
    assert.equal(resume.stale,1);
    assert.equal((await inspect(active)).rows.length,1);
    await active.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-15','full',2));
    await active.waitForFunction(()=> {
      const s=window.V2BrowserFixture.status();
      return s.bridge.confirmationsCleared>=1&&s.wal.pendingCount===1;
    },null,{timeout:20000});
    state=await inspect(active);
    assert.deepEqual(state.mutations.map(x=>x.generation),[first.generation]);
    assert.equal(state.mutations.some(x=>x.id===staleId),false);
    assert.equal((await parity(active)).actualCounts.completions,2);
    // Compact the post-import edit before another authorized replacement.
    const secondCheckpoint=await active.evaluate(()=>{
      const core=window.TaskPointsCore,journal=core.readPendingHabitDeltas();
      const canonical=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(canonical,journal);
      const save=core.saveStateSnapshot(canonical,{
        immediateWrite:true,replaceCompletions:true,savePath:'habit-journal-compaction'});
      if(save?.blocked||save?.skipped)throw Error('Second V1 checkpoint rejected');
      const verified=core.verifyPersistedHabitDeltas(
        window.V2BrowserFixture.rawLegacy(),journal,applied.appliedDeltas);
      core.clearCompactedHabitDeltas(verified);
      return {verified:verified.length,pending:core.readPendingHabitDeltas().length};
    });
    assert.deepEqual(secondCheckpoint,{verified:1,pending:0});
    const second=await rotate('Imported h3 generation two');
    assert.notEqual(second.generation,first.generation);
    state=await inspect(active);
    assert.equal(state.meta.resetGeneration,second.generation);
    assert.equal(state.meta.completionOrderEpoch||0,0);
    assert.deepEqual(state.mutations,[],'second generation must not inherit old mutations');
    assert.deepEqual(state.rows,[{id:staleId,generation:previous}],
      'old WAL evidence remains inspectable through both rotations');
    assert.equal((await parity(active)).actualCounts.completions,2);
    // Restart the formerly suspended tab in the newest generation. Startup
    // must still preserve rather than replay or delete the old WAL.
    await sleeping.reload({waitUntil:'load'});
    const reopened=await sleeping.evaluate(async()=>{
      const result=await window.TaskPointsStateRuntimeV2WalBridge.replayPending();
      return {replay:result,authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority,
        wal:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows
          .map(r=>({id:r.id,generation:r.generation}))};
    });
    assert.equal(reopened.replay.cleared,0);
    assert.equal(reopened.replay.stale,1);
    assert.equal(reopened.authority,'legacy_only');
    assert.deepEqual(reopened.wal,[{id:staleId,generation:previous}]);
    await active.evaluate(()=>window.V2BrowserFixture.delta('h3','2026-10-16','full',3));
    await active.waitForFunction(()=>{
      const s=window.V2BrowserFixture.status();
      return s.wal.pendingCount===1&&s.bridge.confirmationsCleared>=2;
    },null,{timeout:20000});
    state=await inspect(active);
    assert.deepEqual(state.mutations.map(m=>m.generation),[second.generation]);
    assert.equal(state.rows.length,1);
    assert.equal((await parity(active)).actualCounts.completions,3);
    await active.reload({waitUntil:'load'});
    assert.equal((await parity(active)).actualCounts.completions,3);
    const afterReload=await inspect(active);
    assert.deepEqual(afterReload.rows,[{id:staleId,generation:previous}]);
    assert.deepEqual(afterReload.mutations.map(x=>x.generation),[second.generation]);
    return {authorizedRotations:2,suspendedTabResumed:true,staleWalRowsPreserved:1,
      crossGenerationReplays:0,oldMutationsReintroduced:0,
      newGenerationWrites:2,completionRows:3,parity:true};
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


  await run('silent independent WAL write denial cannot claim durability or lose V1',async context=>{
    const page=await open(context);
    const outcome=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const prefix='taskpoints_v2_pending_mutation_event_v1:';
      const shared='taskpoints_v2_pending_mutations_v1';
      const original=Storage.prototype.setItem;
      let swallowed=0;
      Storage.prototype.setItem=function(key,value){
        if(this===localStorage&&String(key).startsWith(prefix)){
          swallowed+=1;return;
        }
        return original.call(this,key,value);
      };
      try{window.V2BrowserFixture.delta('h1','2026-10-20','full',1);}
      finally{Storage.prototype.setItem=original;}
      return {swallowed,shared:localStorage.getItem(shared),
        pending:wal.getPendingRows(),journal:core.readPendingHabitDeltas(),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(outcome.swallowed,1);
    assert.equal(outcome.shared,null);
    assert.equal(outcome.pending.ok,true);
    assert.equal(outcome.pending.rows.length,0);
    assert.equal(outcome.journal.length,1);
    assert.equal(outcome.journal[0].status,'full');
    assert.equal(outcome.authority,'legacy_only');
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s&&s.bridge.failures>=1&&s.runtime.mirroredMutations>=1;
    },null,{timeout:18000});
    await page.reload({waitUntil:'load'});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    return {silentSidecarIgnored:true,noFalseWalDurability:true,
      v1Persisted:true,parity:p.match};
  });

  await run('silent WAL removal preserves committed event until retry',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const row=wal.getPendingRows().rows[0];
      if(!row)throw Error('Expected one held WAL event');
      const sharedKey='taskpoints_v2_pending_mutations_v1';
      const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+row.id;
      const original=Storage.prototype.removeItem;
      const cases=[];
      for(const blockedKey of [sharedKey,sidecarKey]){
        let swallowed=0,blocked=false;
        Storage.prototype.removeItem=function(key){
          if(this===localStorage&&String(key)===blockedKey){swallowed++;return;}
          return original.call(this,key);
        };
        try{
          try{wal.removeMutation(row.id);}
          catch(error){blocked=/unverified_remove/.test(String(error));}
        }finally{Storage.prototype.removeItem=original;}
        cases.push({which:blockedKey===sharedKey?'shared':'sidecar',
          swallowed,blocked,remaining:wal.getPendingRows().rows.map(r=>r.id)});
      }
      return {cases,
        shared:localStorage.getItem(sharedKey),
        sidecar:localStorage.getItem(sidecarKey),
        journal:window.TaskPointsCore.readPendingHabitDeltas().length,
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.deepEqual(evidence.cases.map(c=>c.which),['shared','sidecar']);
    for(const trial of evidence.cases){
      assert.equal(trial.swallowed,1);
      assert.equal(trial.blocked,true,JSON.stringify(trial));
      assert.equal(trial.remaining.length,1);
    }
    assert.equal(evidence.shared,null,'shared key can be removed on the later attempt');
    assert.ok(evidence.sidecar,'silent cleanup cannot delete the independent record');
    assert.equal(evidence.journal,1);
    assert.equal(evidence.authority,'legacy_only');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s?.wal.pendingCount===0&&s.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    return {silentSharedAndSidecarDeletesBlocked:true,
      eventRecoveredAfterRestart:true,parity:p.match};
  });

  await run('independent WAL quota denial preserves V1 journal and cannot claim an orphan V2 mutation',async context=>{
    const page=await open(context);
    const result=await page.evaluate(()=>{
      const original=Storage.prototype.setItem;
      const prefix='taskpoints_v2_pending_mutation_event_v1:';
      let rejected=0;
      Storage.prototype.setItem=function(key,value){
        if(this===localStorage && String(key).startsWith(prefix)){
          rejected++;
          throw new DOMException('Synthetic sidecar quota denial','QuotaExceededError');
        }
        return original.call(this,key,value);
      };
      try { window.V2BrowserFixture.delta('h1','2026-10-20','full',1); }
      finally { Storage.prototype.setItem=original; }
      const wal=window.TaskPointsStateRuntimeV2Wal.getPendingRows();
      const legacy=window.TaskPointsCore.readPendingHabitDeltas();
      return {rejected,walOk:wal.ok,walRows:wal.rows.length,
        legacyCount:legacy.length,legacyStatus:legacy[0]?.status,
        generation:window.TaskPointsStateRuntimeV2Generation.read(),
        readAuthority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(result.rejected,1);
    assert.equal(result.walOk,true);
    assert.equal(result.walRows,0,'V2 must never report a WAL mutation whose sidecar could not be saved');
    assert.equal(result.legacyCount,1);
    assert.equal(result.legacyStatus,'full');
    assert.equal(result.readAuthority,'legacy_only');
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.bridge.failures>=1 && s.runtime.mirroredMutations>=1;
    },null,{timeout:18000});
    // Only V1 is authoritative: the independent WAL failure must not make a
    // new generation or strand the successful independent V2 mirror.
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>window.V2BrowserFixture?.status()?.runtime.installed,
      null,{timeout:18000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    const status=await page.evaluate(()=>window.V2BrowserFixture.status());
    assert.equal(status.wal.pendingCount,0);
    assert.equal(status.runtime.currentGeneration,result.generation);
    assert.equal(status.runtime.readAuthority,'legacy_only');
    return {quotaDeniedSidecar:true,v1AuthoritativeJournalPreserved:true,
      orphanWalRows:0,generationUnchanged:true,parity:true};
  });

  await run('standalone WAL fallback rejects denied generation reads and retains epoch through restart',async context=>{
    const page=await open(context);
    const before=await page.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const originalRow=wal.getPendingRows().rows[0];
      if(!originalRow) throw Error('Expected held WAL before generation access denial');
      const generationKey='taskpoints_state_v2_generation_v1';
      const sharedKey='taskpoints_v2_pending_mutations_v1';
      const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+originalRow.id;
      const storedGeneration=window.TaskPointsStateRuntimeV2Generation.read();
      const originalShared=localStorage.getItem(sharedKey);
      const originalSidecar=localStorage.getItem(sidecarKey);
      const storedV1=localStorage.getItem(window.TaskPointsCore.STORAGE_KEY);
      const originalGet=Storage.prototype.getItem;
      const originalModule=window.TaskPointsStateRuntimeV2Generation;
      let attempts=0,readsDenied=0,diagnostic=null;
      try{
        window.TaskPointsStateRuntimeV2Generation=null;
        Storage.prototype.getItem=function(key){
          if(this===localStorage&&String(key)===generationKey){
            readsDenied++;
            throw new DOMException('Synthetic WAL fallback epoch read denied','SecurityError');
          }
          return originalGet.call(this,key);
        };
        for(const fn of [
          ()=>wal.ensureGeneration(),
          ()=>wal.mutationIdForDelta({id:'habit:h2:2026-10-21',habitId:'h2',
            dayKey:'2026-10-21',status:'full',source:'habit',done:true}),
          ()=>wal.appendHabitDelta({id:'habit:h2:2026-10-21',habitId:'h2',
            dayKey:'2026-10-21',status:'full',source:'habit',done:true})
        ]){
          try{fn();}catch(error){
            if(/wal_storage_read_failed/.test(String(error))) attempts++;
          }
        }
        diagnostic=wal.getStatus();
      }finally{
        Storage.prototype.getItem=originalGet;
        window.TaskPointsStateRuntimeV2Generation=originalModule;
      }
      return {attempts,readsDenied,
        unreadable:diagnostic.generationReadable===false&&diagnostic.pendingCount===null,
        originalGeneration:storedGeneration,
        restoredGeneration:window.TaskPointsStateRuntimeV2Generation.read(),
        originalId:originalRow.id,
        rawSharedUnchanged:localStorage.getItem(sharedKey)===originalShared,
        sidecarUnchanged:localStorage.getItem(sidecarKey)===originalSidecar,
        v1Unchanged:localStorage.getItem(window.TaskPointsCore.STORAGE_KEY)===storedV1,
        rows:wal.getPendingRows().rows.map(row=>row.id),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(before.attempts,3);
    assert.ok(before.readsDenied>=4);
    assert.equal(before.unreadable,true);
    assert.equal(before.restoredGeneration,before.originalGeneration);
    assert.equal(before.rawSharedUnchanged,true);
    assert.equal(before.sidecarUnchanged,true);
    assert.equal(before.v1Unchanged,true);
    assert.deepEqual(before.rows,[before.originalId]);
    assert.equal(before.authority,'legacy_only');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const status=window.V2BrowserFixture?.status();
      return status?.wal.pendingCount===0&&status.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const report=await parity(page);
    assert.equal(report.actualCounts.completions,1);
    return {deniedFallbackGenerationReads:true,originalEpochRetained:true,
      v1AndWalUnchanged:true,replayedExactlyOnceAfterRestart:true,parity:true};
  });

  await run('temporary shared and sidecar WAL read denial preserves mutation evidence through reload',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const pending=wal.getPendingRows();
      if(!pending.ok||pending.rows.length!==1) throw Error('Expected one held WAL mutation');
      const mutationId=pending.rows[0].id;
      const sharedKey='taskpoints_v2_pending_mutations_v1';
      const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+mutationId;
      const originalGet=Storage.prototype.getItem;
      const sharedBefore=originalGet.call(localStorage,sharedKey);
      const sidecarBefore=originalGet.call(localStorage,sidecarKey);
      const denied=[];
      for(const blockedKey of [sharedKey,sidecarKey]){
        let readsDenied=0;
        Storage.prototype.getItem=function(key){
          if(this===localStorage && String(key)===blockedKey){
            readsDenied++;
            throw new DOMException('Synthetic WAL read denied','SecurityError');
          }
          return originalGet.call(this,key);
        };
        try{
          const read=wal.getPendingRows();
          let appendBlocked=false,cleanupBlocked=false;
          try{
            wal.appendHabitDelta({id:'habit:h2:2026-10-21',habitId:'h2',
              dayKey:'2026-10-21',source:'habit',status:'full',done:true,
              updatedAtISO:'2026-10-21T12:00:00.000Z'});
          }catch(error){ appendBlocked=/wal_storage_read_failed/.test(String(error)); }
          try{wal.removeMutation(mutationId);}
          catch(error){cleanupBlocked=/wal_storage_read_failed/.test(String(error));}
          denied.push({target:blockedKey===sharedKey?'shared':'sidecar',
            readFailed:read.ok===false && /wal_storage_read_failed/.test(read.error||''),
            appendBlocked,cleanupBlocked,readsDenied});
        }finally{Storage.prototype.getItem=originalGet;}
      }
      return {denied,
        sameShared:localStorage.getItem(sharedKey)===sharedBefore,
        sameSidecar:localStorage.getItem(sidecarKey)===sidecarBefore,
        pendingAfter:wal.getPendingRows().rows.map(r=>r.id),
        v1Journal:window.TaskPointsCore.readPendingHabitDeltas().length,
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.deepEqual(evidence.denied.map(x=>x.target),['shared','sidecar']);
    for(const attempt of evidence.denied){
      assert.equal(attempt.readFailed,true,JSON.stringify(attempt));
      assert.equal(attempt.appendBlocked,true,JSON.stringify(attempt));
      assert.equal(attempt.cleanupBlocked,true,JSON.stringify(attempt));
      assert.ok(attempt.readsDenied>=3,JSON.stringify(attempt));
    }
    assert.equal(evidence.sameShared,true);
    assert.equal(evidence.sameSidecar,true);
    assert.equal(evidence.pendingAfter.length,1);
    assert.equal(evidence.v1Journal,1);
    assert.equal(evidence.authority,'legacy_only');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount===0 && s.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    return {deniedTargets:2,durableWalPreserved:true,
      restoredReadAndReplayed:true,legacyAuthorityRetained:true,parity:p.match};
  });

  await run('denied WAL sidecar enumeration stays diagnosable and recovers on restart',async context=>{
    const page=await open(context);
    const blocked=await page.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const originalRow=wal.getPendingRows().rows[0];
      if(!originalRow) throw Error('Missing held WAL event');
      const originalKey=Storage.prototype.key;
      let denials=0,readOk=null,status=null,removeFailed=false;
      Storage.prototype.key=function(index){
        if(this===localStorage){
          denials++;
          throw new DOMException('Synthetic WAL enumeration refused','SecurityError');
        }
        return originalKey.call(this,index);
      };
      try{
        readOk=wal.getPendingRows().ok;
        status=wal.getStatus();
        try{wal.removeMutation(originalRow.id);}
        catch(error){removeFailed=/state_runtime_v2_wal_malformed/.test(String(error));}
      }finally{Storage.prototype.key=originalKey;}
      return {
        denials,readOk,malformed:status.malformed,pendingCount:status.pendingCount,
        sidecars:status.independentEventCount,
        diagnostic:/state_runtime_v2_wal_inventory_unreadable/.test(status.lastError||''),
        removeFailed,originalId:originalRow.id,
        retained:wal.getPendingRows().rows.map(row=>row.id),
        legacyJournal:window.TaskPointsCore.readPendingHabitDeltas().length
      };
    });
    assert.ok(blocked.denials>=3);
    assert.equal(blocked.readOk,false);
    assert.equal(blocked.malformed,true);
    assert.equal(blocked.pendingCount,null);
    assert.equal(blocked.sidecars,null);
    assert.equal(blocked.diagnostic,true);
    assert.equal(blocked.removeFailed,true);
    assert.deepEqual(blocked.retained,[blocked.originalId]);
    assert.equal(blocked.legacyJournal,1);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s&&s.wal.pendingCount===0&&s.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    return {inventoryDenied:true,diagnosticsStayedAvailable:true,
      eventPreserved:true,replayedOnRestart:true,parity:p.match};
  });

  await run('generation read denial preserves epoch and held WAL until restart',async context=>{
    const page=await open(context);
    const evidence=await page.evaluate(()=>{
      sessionStorage.setItem('taskpoints_state_v2_wal_test_armed_v1','1');
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      const gen=window.TaskPointsStateRuntimeV2Generation;
      const wal=window.TaskPointsStateRuntimeV2Wal;
      const epoch=gen.read();
      const rows=wal.getPendingRows().rows;
      if(rows.length!==1) throw Error('Expected held recovery mutation');
      const originalGet=Storage.prototype.getItem;
      const sharedKey=wal.KEY;
      const sharedBefore=localStorage.getItem(sharedKey);
      const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+rows[0].id;
      const sidecarBefore=localStorage.getItem(sidecarKey);
      let denied=0;
      const blocked={};
      Storage.prototype.getItem=function(key){
        if(this===localStorage && String(key)===gen.KEY){
          denied++;
          throw new DOMException('Synthetic generation read denied','SecurityError');
        }
        return originalGet.call(this,key);
      };
      try{
        for(const [name,fn] of [
          ['read',()=>gen.read()],
          ['ensure',()=>gen.ensure()],
          ['rotate',()=>gen.rotate('should-not-rotate')],
          ['walAppend',()=>wal.appendHabitDelta({
            habitId:'h2',dayKey:'2026-10-21',source:'habit',status:'full',done:true,
            updatedAtISO:'2026-10-21T12:00:00.000Z'
          })]
        ]){
          try{fn();blocked[name]=false;}
          catch(error){blocked[name]=/state_runtime_v2_generation_read_failed/.test(String(error));}
        }
        const generationStatus=gen.getStatus();
        const walStatus=wal.getStatus();
        blocked.status={generationReadable:generationStatus.generationReadable,
          rotations:generationStatus.rotations,
          walGenerationReadable:walStatus.generationReadable,
          walPendingCount:walStatus.pendingCount,
          walMalformed:walStatus.malformed};
      }finally{Storage.prototype.getItem=originalGet;}
      return {epoch,denied,blocked,
        sameEpoch:gen.read()===epoch,
        sameShared:localStorage.getItem(sharedKey)===sharedBefore,
        sameSidecar:localStorage.getItem(sidecarKey)===sidecarBefore,
        pending:wal.getPendingRows().rows.map(row=>row.id),
        originalId:rows[0].id,
        legacyJournal:window.TaskPointsCore.readPendingHabitDeltas().length,
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.ok(evidence.denied>=6);
    for(const op of ['read','ensure','rotate','walAppend']){
      assert.equal(evidence.blocked[op],true,op+' must fail closed');
    }
    assert.deepEqual(evidence.blocked.status,{
      generationReadable:false,rotations:0,walGenerationReadable:false,
      walPendingCount:null,walMalformed:true
    });
    assert.equal(evidence.sameEpoch,true);
    assert.equal(evidence.sameShared,true);
    assert.equal(evidence.sameSidecar,true);
    assert.deepEqual(evidence.pending,[evidence.originalId]);
    assert.equal(evidence.legacyJournal,1);
    assert.equal(evidence.authority,'legacy_only');
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount===0 && s.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    const after=await page.evaluate(()=>({
      epoch:window.TaskPointsStateRuntimeV2Generation.read(),
      authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority
    }));
    assert.equal(after.epoch,evidence.epoch);
    assert.equal(after.authority,'legacy_only');
    return {generationRetained:true,walPreserved:true,replayedAfterReadRecovered:true,
      authority:'legacy_only',parity:p.match};
  });

  await run('interrupted independent WAL cleanup replays exactly once after browser restart',async context=>{
    const page=await open(context);
    const injected=await page.evaluate(()=>{
      const prefix='taskpoints_v2_pending_mutation_event_v1:';
      const original=Storage.prototype.removeItem;
      window.__walRemoveOriginal=original;
      let blocked=0;
      Storage.prototype.removeItem=function(key){
        if(this===localStorage && String(key).startsWith(prefix)){
          blocked++;
          throw new DOMException('Synthetic WAL cleanup interrupted','QuotaExceededError');
        }
        return original.call(this,key);
      };
      window.V2BrowserFixture.delta('h1','2026-10-20','full',1);
      return {initial:window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows.length,
        generation:window.TaskPointsStateRuntimeV2Generation.read(),
        blockedNow:blocked};
    });
    assert.equal(injected.initial,1);
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s?.bridge.failures>0
        && s.wal.pendingCount===1
        && s.wal.independentEventCount===1;
    },null,{timeout:20000});
    const evidence=await page.evaluate(()=>{
      const s=window.V2BrowserFixture.status();
      const rows=window.TaskPointsStateRuntimeV2Wal.getPendingRows().rows;
      const pending=window.TaskPointsCore.readPendingHabitDeltas();
      const source=window.V2BrowserFixture.rawLegacy();
      return {failures:s.bridge.failures,
        preserved:rows.map(r=>r.id),sidecars:s.wal.independentEventCount,
        v1Journal:pending.filter(r=>r.habitId==='h1').length,
        canonicalGeneration:window.TaskPointsStateRuntimeV2Generation.read(),
        v1Pilot:source.completions.filter(c=>c.source==='habit').length};
    });
    assert.equal(evidence.preserved.length,1);
    assert.equal(evidence.sidecars,1);
    assert.equal(evidence.v1Journal,1);
    assert.equal(evidence.canonicalGeneration,injected.generation);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s&&s.wal.pendingCount===0
        && s.wal.independentEventCount===0
        && s.bridge.replayCleared>=1;
    },null,{timeout:25000});
    const p=await parity(page);
    assert.equal(p.actualCounts.completions,1);
    const final=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const db=await runtime.open();
      const request=db.transaction('mutations','readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {mutations:mutations.map(m=>m.id),
        generation:window.TaskPointsStateRuntimeV2Generation.read(),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(final.mutations.length,1);
    assert.equal(new Set(final.mutations).size,1);
    assert.equal(final.generation,injected.generation);
    assert.equal(final.authority,'legacy_only');
    return {interruptedSidecarCleanup:true,retainedUntilRecovery:true,
      replayedExactlyOnce:true,mutationCount:1,generationUnchanged:true,parity:true};
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

  await run('late Habit correction survives V1 compaction cleanup and stale shared-journal overwrite',async context=>{
    // The delayed tab is opened before any write. The compactor and the
    // suspended tab must see the same origin while V1 remains authoritative.
    const compactor=await open(context), delayed=await open(context);
    await compactor.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-18','full',1));
    await settled(compactor,1);
    const checkpoint=await compactor.evaluate(()=>{
      const core=window.TaskPointsCore;
      const old=core.readPendingHabitDeltas();
      if(old.length!==1)throw Error('Expected one pre-compaction delta');
      const state=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(state,old);
      const save=core.saveStateSnapshot(state,{immediateWrite:true,replaceCompletions:true,
        savePath:'habit-journal-compaction'});
      if(save?.blocked||save?.skipped)throw Error('V1 compaction save blocked');
      const persisted=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas(persisted,old,applied.appliedDeltas);
      if(verified.length!==1)throw Error('V1 checkpoint failed verification');
      const original=Storage.prototype.setItem;
      let injected=false;
      try{
        Storage.prototype.setItem=function(key,value){
          if(this===localStorage && key===core.PENDING_HABIT_DELTAS_KEY && !injected){
            injected=true;
            // Synchronously place two later events at the precise boundary
            // between verification and the compactor's primary-key cleanup.
            // The outer clear overwrites their shared-key copy, as a stale
            // cross-tab storage write could; unique sidecars must protect both.
            window.V2BrowserFixture.delta('h1','2026-10-18','half',9);
            window.V2BrowserFixture.delta('h2','2026-10-19','full',10);
          }
          return original.call(this,key,value);
        };
        core.clearCompactedHabitDeltas(verified);
      }finally{Storage.prototype.setItem=original;}
      const primary=JSON.parse(localStorage.getItem(core.PENDING_HABIT_DELTAS_KEY)||'[]');
      const merged=core.readPendingHabitDeltas();
      const sidecarKeys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(k=>k.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return {injected,primary:primary.map(x=>x.id),
        merged:merged.map(x=>({id:x.id,status:x.status})).sort((a,b)=>a.id.localeCompare(b.id)),
        sidecars:sidecarKeys.length,
        rawCommitted:persisted.completions.filter(c=>c.source==='habit').map(c=>c.id),
        v1Generation:window.TaskPointsStateRuntimeV2Generation.read()};
    });
    assert.equal(checkpoint.injected,true);
    assert.deepEqual(checkpoint.primary,[],
      'the test must actually reproduce the stale shared-key overwrite');
    assert.deepEqual(checkpoint.merged,[
      {id:'habit:h1:2026-10-18',status:'half'},
      {id:'habit:h2:2026-10-19',status:'full'}
    ]);
    assert.equal(checkpoint.sidecars,2,
      'compaction must remove only the verified old sidecar, retaining both delayed writes');
    assert.deepEqual(checkpoint.rawCommitted,['habit:h1:2026-10-18']);
    // No initial page restart hides a failed async mirror operation.
    await compactor.waitForFunction(()=>{
      const s=window.V2BrowserFixture.status();
      return s.wal.pendingCount===0 && s.bridge.confirmationsCleared>=3;
    },null,{timeout:20000});
    let p=await parity(compactor);
    assert.equal(p.actualCounts.completions,2);
    await Promise.all([compactor.reload({waitUntil:'load'}),delayed.reload({waitUntil:'load'})]);
    const proof=async page=>{
      await page.evaluate(()=>window.V2BrowserFixture.start());
      const report=await parity(page);
      const values=await page.evaluate(()=>{
        const core=window.TaskPointsCore;
        const snapshot=window.V2BrowserFixture.rawLegacy();
        core.applyPendingHabitDeltas(snapshot);
        const h1=snapshot.habits.find(h=>h.id==='h1');
        const h2=snapshot.habits.find(h=>h.id==='h2');
        return {h1Half:snapshot.completions.find(c=>c.habitId==='h1'
            && c.dayKey==='2026-10-18')?.completionFraction,
          h2Done:h2.doneKeys.includes('2026-10-19'),
          h1Done:h1.doneKeys.includes('2026-10-18'),
          generation:window.TaskPointsStateRuntimeV2Generation.read(),
          authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
      });
      return {parity:report.match,counts:report.actualCounts.completions,...values};
    };
    const observations=await Promise.all([proof(compactor),proof(delayed)]);
    for(const r of observations){
      assert.equal(r.parity,true);
      assert.equal(r.counts,2);
      assert.equal(r.h1Half,0.5);
      assert.equal(r.h1Done,true);
      assert.equal(r.h2Done,true);
      assert.equal(r.authority,'legacy_only');
      assert.equal(r.generation,checkpoint.v1Generation);
    }
    return {lateEvents:2,stalePrimaryOverwrite:true,sidecarsPreserved:2,
      correctedFraction:0.5,checkedAfterTwoTabReload:true,parity:true};
  });

  await run('two backgrounded tabs deliver late updates during another tabs verified V1 cleanup',async context=>{
    // Pre-open every context before the first write: opening a tab after
    // holding a WAL entry would trigger startup recovery and change the race.
    const compactor=await open(context);
    const delayed=await open(context);
    const secondDelayed=await open(context);
    const target='2026-10-18';
    await compactor.evaluate(day=>window.V2BrowserFixture.delta('h1',day,'full',1),target);
    await settled(compactor,1);
    const prepared=await compactor.evaluate(()=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      const snapshot=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(snapshot,pending);
      const result=core.saveStateSnapshot(snapshot,{
        immediateWrite:true,replaceCompletions:true,savePath:'habit-journal-compaction'
      });
      if(result?.blocked||result?.skipped)throw Error('V1 compaction save failed');
      const persisted=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas(persisted,pending,applied.appliedDeltas);
      // Hold the verified list while other tabs record late corrections.
      window.__v2PendingVerifiedCompaction=verified;
      return {verified:verified.map(v=>v.id),
        checkpointCompletions:persisted.completions.filter(c=>c.source==='habit').map(c=>c.id),
        generation:window.TaskPointsStateRuntimeV2Generation.read()};
    });
    assert.deepEqual(prepared.verified,['habit:h1:2026-10-18']);
    assert.deepEqual(prepared.checkpointCompletions,['habit:h1:2026-10-18']);
    // Both independent writers are backgrounded. Dispatch lifecycle events
    // and then model their queued user actions arriving after verification.
    await Promise.all([delayed,secondDelayed].map(page=>page.evaluate(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    })));
    const [correction,other]=await Promise.all([
      delayed.evaluate(day=>window.V2BrowserFixture.delta('h1',day,'half',9),target),
      secondDelayed.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-19','full',10))
    ]);
    assert.equal(correction.id,'habit:h1:2026-10-18');
    assert.equal(other.id,'habit:h2:2026-10-19');
    await compactor.waitForFunction(()=>{
      const core=window.TaskPointsCore;
      const pending=core.readPendingHabitDeltas();
      return pending.length===2 &&
        pending.some(d=>d.id==='habit:h1:2026-10-18'&&d.status==='half') &&
        pending.some(d=>d.id==='habit:h2:2026-10-19'&&d.status==='full');
    },null,{timeout:14000,polling:75});
    const cleaned=await compactor.evaluate(()=>{
      const core=window.TaskPointsCore;
      const verified=window.__v2PendingVerifiedCompaction;
      const removed=core.clearCompactedHabitDeltas(verified);
      const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
        .filter(k=>k.startsWith('taskpoints_v2_habit_journal_event_v1:'));
      return {removed,keys:keys.length,
        sidecarEvents:keys.flatMap(k=>JSON.parse(localStorage.getItem(k)||'[]'))
          .map(r=>({id:r.id,status:r.status})).sort((a,b)=>a.id.localeCompare(b.id)),
        merged:core.readPendingHabitDeltas()
          .map(r=>({id:r.id,status:r.status})).sort((a,b)=>a.id.localeCompare(b.id)),
        generation:window.TaskPointsStateRuntimeV2Generation.read()};
    });
    const expected=[
      {id:'habit:h1:2026-10-18',status:'half'},
      {id:'habit:h2:2026-10-19',status:'full'}
    ];
    assert.equal(cleaned.removed,0,
      'the newer same-day correction is not a byte-for-byte verified old event');
    assert.equal(cleaned.keys,2,'cleanup must preserve both late independent sidecars');
    assert.deepEqual(cleaned.sidecarEvents,expected);
    assert.deepEqual(cleaned.merged,expected);
    assert.equal(cleaned.generation,prepared.generation);
    await Promise.all([delayed.close(),secondDelayed.close()]);
    await compactor.reload({waitUntil:'load'});
    await compactor.evaluate(()=>window.V2BrowserFixture.start());
    await compactor.waitForFunction(()=>{
      const s=window.V2BrowserFixture?.status();
      return s && s.wal.pendingCount===0;
    },null,{timeout:22000});
    let proof;
    try {
      proof=await parity(compactor);
    } catch(error) {
      // A same-generation mismatch is intentionally fail-closed. Keep the gate
      // failing, but print both durable stores without triggering another seed
      // so that engine-specific ordering or missing-data causes can be fixed.
      const detail=await compactor.evaluate(async()=>{
        const core=window.TaskPointsCore,runtime=window.TaskPointsStateRuntimeV2;
        const expected=window.V2BrowserFixture.rawLegacy();
        core.applyPendingHabitDeltas(expected);
        const db=await runtime.open();
        const tx=db.transaction(['meta','habits','completions','mutations'],'readonly');
        const get=name=>new Promise((resolve,reject)=>{
          const r=tx.objectStore(name).getAll();
          r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
        });
        const [meta,habits,completions,mutations]=await Promise.all(
          ['meta','habits','completions','mutations'].map(get));
        return {expectedHabits:expected.habits.map(h=>({id:h.id,doneKeys:h.doneKeys,
            updatedAtISO:h.updatedAtISO})),
          expectedPilot:expected.completions.filter(c=>c.source==='habit')
            .map(c=>({id:c.id,points:c.points,completionFraction:c.completionFraction})),
          actualHabits:habits.map(h=>({id:h.id,doneKeys:h.value?.doneKeys,
            updatedAtISO:h.value?.updatedAtISO})),
          actualPilot:completions.flatMap(c=>Array.isArray(c.entries)
            ?c.entries.map(e=>e.value):c.value?[c.value]:[])
            .map(c=>({id:c.id,points:c.points,completionFraction:c.completionFraction})),
          meta,mutations:mutations.map(m=>({id:m.id,delta:m.delta,
            revision:m.revision})),runtime:runtime.getStatus()};
      });
      console.warn('DELAYED_CROSS_TAB_MISMATCH_DIAGNOSTIC '+JSON.stringify(detail));
      throw error;
    }
    assert.equal(proof.actualCounts.completions,2);
    const saved=await compactor.evaluate(async()=>{
      const core=window.TaskPointsCore;
      const effective=window.V2BrowserFixture.rawLegacy();
      core.applyPendingHabitDeltas(effective);
      const db=await window.TaskPointsStateRuntimeV2.open();
      const r=db.transaction('mutations','readonly').objectStore('mutations').getAll();
      const mutations=await new Promise((resolve,reject)=>{
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      return {h1Fraction:effective.completions.find(c=>c.habitId==='h1'
          && c.dayKey==='2026-10-18')?.completionFraction,
        h2Complete:effective.habits.find(h=>h.id==='h2').doneKeys.includes('2026-10-19'),
        mutationIds:mutations.map(m=>m.id),
        authority:window.TaskPointsStateRuntimeV2.getStatus().readAuthority};
    });
    assert.equal(saved.h1Fraction,0.5);
    assert.equal(saved.h2Complete,true);
    assert.equal(saved.authority,'legacy_only');
    assert.equal(new Set(saved.mutationIds).size,saved.mutationIds.length);
    assert.equal(saved.mutationIds.length,3,
      'both delayed writes and the original completion must remain in the V2 ledger');
    return {lateIndependentTabs:2,interleavedCompaction:true,
      correctedHalfCompletion:true,independentSidecarsRetained:2,
      distinctMutations:3,parity:proof.match};
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

  await run('three canonical V1 compactions and a cosmetic Habit edit advance only real completion epochs',async context=>{
    const page=await open(context);
    const readMeta=()=>page.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const request=db.transaction('meta','readonly').objectStore('meta').get('runtime');
      const m=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {epoch:Number(m.completionOrderEpoch||0),
        signature:m.canonicalCompletionCheckpointSignature,
        generation:m.resetGeneration};
    });
    const compact=()=>page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const journal=core.readPendingHabitDeltas();
      if(!journal.length)throw Error('No V1 journal rows to compact');
      const snapshot=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(snapshot,journal);
      const saved=core.saveStateSnapshot(snapshot,{
        immediateWrite:true,replaceCompletions:true,savePath:'habit-journal-compaction'});
      if(saved?.blocked||saved?.skipped)throw Error('Compaction checkpoint save blocked');
      const persisted=window.V2BrowserFixture.rawLegacy();
      const verified=core.verifyPersistedHabitDeltas(persisted,journal,applied.appliedDeltas);
      if(verified.length!==journal.length)throw Error('Not all V1 journal rows verified');
      core.clearCompactedHabitDeltas(verified);
      if(core.readPendingHabitDeltas().length)throw Error('V1 journal remained after verified compaction');
      return {verified:verified.length,
        pilotCompletions:persisted.completions.filter(c=>c.source==='habit').length};
    });
    const firstMeta=await readMeta();
    assert.ok(firstMeta.signature,'bootstrap needs a durable canonical baseline marker');
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-17','full',1));
    await settled(page,1);
    assert.equal((await compact()).verified,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-18','full',2));
    await settled(page,2);
    const afterFirst=await readMeta();
    assert.equal(afterFirst.epoch,1);
    assert.notEqual(afterFirst.signature,firstMeta.signature);
    assert.equal((await parity(page)).actualCounts.completions,2);
    // Change a real display field through the existing V1 save and V2 Habit
    // edit mirror. It is not a completion checkpoint and must not mint an epoch.
    const cosmetic=await page.evaluate(async()=>{
      const core=window.TaskPointsCore,runtime=window.TaskPointsStateRuntimeV2;
      const stored=window.V2BrowserFixture.rawLegacy();
      stored.habits.find(h=>h.id==='h3').name='Renamed Synthetic h3';
      const saved=core.saveStateSnapshot(stored,{
        immediateWrite:true,replaceCompletions:true,savePath:'habit-cosmetic-edit'});
      if(saved?.blocked||saved?.skipped)throw Error('V1 cosmetic save blocked');
      await runtime.enqueueHabitEditFromLegacy('h3',{source:'synthetic-cosmetic-edit'});
      const mirrored=await runtime.getHabit('h3');
      return {name:mirrored?.name,authority:runtime.getStatus().readAuthority};
    });
    assert.equal(cosmetic.name,'Renamed Synthetic h3');
    assert.equal(cosmetic.authority,'legacy_only');
    assert.deepEqual(await readMeta(),{...afterFirst,epoch:1});
    await page.evaluate(()=>window.V2BrowserFixture.delta('h3','2026-10-19','full',3));
    await settled(page,3);
    assert.equal((await readMeta()).epoch,1,'cosmetic name change did not create a new epoch');
    assert.equal((await parity(page)).actualCounts.completions,3);
    assert.equal((await compact()).verified,2);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',4));
    await settled(page,4);
    const second=await readMeta();
    assert.equal(second.epoch,2);
    assert.notEqual(second.signature,afterFirst.signature);
    // Derived Habit presentation caches may be persisted by Home but are not
    // canonical completion state. Their save must not advance the checkpoint.
    await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const snapshot=window.V2BrowserFixture.rawLegacy();
      snapshot.habits.find(h=>h.id==='h1').__streak=87;
      const saved=core.saveStateSnapshot(snapshot,{
        immediateWrite:true,replaceCompletions:true,savePath:'habit-derived-display-cache'});
      if(saved?.blocked||saved?.skipped)throw Error('Derived cache save blocked');
    });
    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-21','full',5));
    await settled(page,5);
    assert.equal((await readMeta()).epoch,2,'derived display cache did not mint a checkpoint');
    assert.equal((await parity(page)).actualCounts.completions,5);
    assert.equal((await compact()).verified,2);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h3','2026-10-22','full',6));
    await settled(page,6);
    const third=await readMeta();
    assert.equal(third.epoch,3);
    assert.notEqual(third.signature,second.signature);
    const finalParity=await parity(page);
    assert.equal(finalParity.actualCounts.completions,6);
    await page.reload({waitUntil:'load'});
    const afterReload=await readMeta();
    assert.deepEqual(afterReload,third);
    assert.equal((await parity(page)).actualCounts.completions,6);
    const state=await page.evaluate(async()=>{
      const r=window.TaskPointsStateRuntimeV2;
      const snapshot=await r.buildCompatibilitySnapshot();
      return {ids:snapshot.completions.filter(c=>c.source==='habit').map(c=>c.id),
        name:snapshot.habits.find(h=>h.id==='h3')?.name};
    });
    assert.equal(state.name,'Renamed Synthetic h3');
    assert.equal(new Set(state.ids).size,6);
    return {verifiedCompactions:3,epochs:[afterFirst.epoch,second.epoch,third.epoch],
      nameEditPreserved:true,derivedCacheSafe:true,completionRows:state.ids.length,
      generationUnchanged:third.generation===firstMeta.generation,reloadParity:true};
  });

  await run('authorized import and restore reset canonical checkpoint epochs without inheriting previous generation ranks',async context=>{
    const page=await open(context);
    const readMeta=()=>page.evaluate(async()=>{
      const db=await window.TaskPointsStateRuntimeV2.open();
      const request=db.transaction('meta','readonly').objectStore('meta').get('runtime');
      const meta=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      return {generation:meta.resetGeneration,
        epoch:Number(meta.completionOrderEpoch||0),
        marker:meta.canonicalCompletionCheckpointSignature,
        revision:meta.revision};
    });
    const compact=()=>page.evaluate(()=>{
      const core=window.TaskPointsCore,rows=core.readPendingHabitDeltas();
      if(!rows.length)throw Error('No pending V1 Habit updates to compact');
      const snapshot=window.V2BrowserFixture.rawLegacy();
      const applied=core.applyPendingHabitDeltas(snapshot,rows);
      const saved=core.saveStateSnapshot(snapshot,{immediateWrite:true,
        replaceCompletions:true,savePath:'habit-journal-compaction'});
      if(saved?.skipped||saved?.blocked)throw Error('V1 checkpoint save rejected');
      const verified=core.verifyPersistedHabitDeltas(
        window.V2BrowserFixture.rawLegacy(),rows,applied.appliedDeltas);
      if(verified.length!==rows.length)throw Error('Compaction unverified');
      core.clearCompactedHabitDeltas(verified);
      if(core.readPendingHabitDeltas().length)throw Error('Journal remains after compaction');
      return {verified:verified.length};
    });
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-17','full',1));
    await settled(page,1);
    assert.equal((await compact()).verified,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h2','2026-10-18','full',2));
    await settled(page,2);
    assert.equal((await readMeta()).epoch,1);
    assert.equal((await compact()).verified,1);
    assert.equal((await parity(page)).actualCounts.completions,2);
    const before=await readMeta();
    const imported=await page.evaluate(()=>{
      const core=window.TaskPointsCore;
      const backup=window.V2BrowserFixture.rawLegacy();
      const replacement=structuredClone(backup);
      replacement.habits.find(h=>h.id==='h3').name='Imported generation Habit';
      const result=core.saveValidatedSnapshot(replacement,{
        allowDestructiveOverwrite:true,source:'settings-import',immediateWrite:true});
      return {blocked:result?.blocked===true,backup,
        generation:window.TaskPointsStateRuntimeV2Generation.read()};
    });
    assert.equal(imported.blocked,false);
    assert.notEqual(imported.generation,before.generation);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    const fresh=await readMeta();
    assert.equal(fresh.generation,imported.generation);
    assert.equal(fresh.epoch,0,'authorized generation change must not inherit previous epoch');
    assert.ok(fresh.marker,'authorized import must store a fresh canonical marker');
    assert.notEqual(fresh.marker,before.marker,
      'new generation baseline includes the second verified Habit checkpoint');
    assert.equal((await parity(page)).actualCounts.completions,2);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h3','2026-10-19','full',3));
    await settled(page,3);
    assert.equal((await readMeta()).epoch,0,
      'first mutation after fresh import uses fresh baseline without phantom compaction');
    assert.equal((await compact()).verified,1);
    await page.evaluate(()=>window.V2BrowserFixture.delta('h1','2026-10-20','full',4));
    await settled(page,4);
    assert.equal((await readMeta()).epoch,1);
    assert.equal((await parity(page)).actualCounts.completions,4);
    const restored=await page.evaluate(backup=>{
      const core=window.TaskPointsCore;
      const result=core.saveValidatedSnapshot(backup,{
        allowDestructiveOverwrite:true,source:'settings-restore',immediateWrite:true});
      return {blocked:result?.blocked===true,
        generation:window.TaskPointsStateRuntimeV2Generation.read()};
    },imported.backup);
    assert.equal(restored.blocked,false);
    assert.notEqual(restored.generation,imported.generation);
    await page.evaluate(()=>window.TaskPointsStateRuntimeV2.startCoordinatedDarkMirror());
    await page.reload({waitUntil:'load'});
    const final=await readMeta();
    assert.equal(final.generation,restored.generation);
    assert.equal(final.epoch,0,'authorized restore resets the completion ordering baseline');
    assert.ok(final.marker);
    const report=await parity(page);
    const proof=await page.evaluate(async()=>{
      const core=window.TaskPointsCore;
      const runtime=window.TaskPointsStateRuntimeV2;
      const snapshot=await runtime.buildCompatibilitySnapshot();
      const source=window.V2BrowserFixture.rawLegacy();
      core.applyPendingHabitDeltas(source);
      return {name:snapshot.habits.find(h=>h.id==='h3').name,
        completed:snapshot.completions.filter(c=>c.source==='habit').map(c=>c.id).sort(),
        authoritativeCompletions:source.completions.filter(c=>c.source==='habit')
          .map(c=>c.id).sort(),
        authority:runtime.getStatus().readAuthority};
    });
    assert.equal(proof.name,'Synthetic h3');
    // Production V1 restore uses merge-preserving completion semantics, not
    // an implicit delete of entries written after the backup. Assert the
    // exact authoritative set rather than presuming an older backup's length.
    assert.deepEqual(proof.completed,proof.authoritativeCompletions);
    assert.equal(proof.completed.length,report.actualCounts.completions);
    for(const id of ['habit:h1:2026-10-17','habit:h2:2026-10-18'])
      assert.ok(proof.completed.includes(id),'restored baseline completion must survive');
    assert.equal(proof.authority,'legacy_only');
    return {authorizedGenerationRotations:2,
      originalEpoch:before.epoch,importedEpoch:fresh.epoch,
      postImportCompactionEpoch:1,restoredEpoch:final.epoch,
      restoredCompletions:proof.completed.length,
      v1MergeSemanticsPreserved:true,legacyAuthorityPreserved:true,parity:true};
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


  await run('explicit preview rollback checkpoint persists through two tabs and reload without restoring V1', async context => {
    const page=await open(context);
    const initial=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const original=localStorage.getItem('taskpoints_v1');
      const baseline=await runtime.inspectLegacyRollbackSource();
      const saved=await runtime.createPreviewRecoveryCheckpoint();
      const inspection=await runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId);
      return {original,baseline,saved,inspection};
    });
    assert.equal(initial.baseline.sourceStable,true);
    assert.equal(initial.saved.saved,true,JSON.stringify(initial.saved));
    assert.equal(initial.saved.verified,true);
    assert.equal(initial.saved.sourceStable,true);
    assert.equal(initial.saved.mutationAuthority,'legacy_only');
    assert.equal(initial.inspection.intact,true,JSON.stringify(initial.inspection));
    assert.equal(initial.inspection.integrityCoverage,'metadata_and_payload');
    assert.match(initial.inspection.fingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
    const changed=await page.evaluate(()=>{
      const original=JSON.parse(localStorage.getItem('taskpoints_v1'));
      original.notes='SYNTHETIC EDIT AFTER CHECKPOINT';
      localStorage.setItem('taskpoints_v1',JSON.stringify(original));
      return localStorage.getItem('taskpoints_v1');
    });
    assert.notEqual(changed,initial.original);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>Boolean(window.V2BrowserFixture?.status().runtime.installed));
    const another=await open(context);
    const observations=[];
    for(const active of [page,another]){
      const result=await active.evaluate(async id=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        const inspected=await runtime.inspectPreviewRecoveryCheckpoint(id);
        const rehearsal=await runtime.inspectPreviewRollbackPlan(id);
        const recovered=await new Promise((resolve,reject)=>{
          const request=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error);
        });
        const checkpoint=await new Promise((resolve,reject)=>{
          const request=recovered.transaction('snapshots','readonly')
            .objectStore('snapshots').get(id);
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error);
        });
        recovered.close();
        return {inspected,rehearsal,storedV1:checkpoint.entries
          .find(entry=>entry[0]==='taskpoints_v1')?.[1],
          currentV1:localStorage.getItem('taskpoints_v1'),
          authority:runtime.getStatus().readAuthority};
      },initial.saved.checkpointId);
      observations.push(result);
      assert.equal(result.inspected.intact,true);
      assert.equal(result.inspected.integrityCoverage,'metadata_and_payload');
      assert.equal(result.storedV1,initial.original,
        'checkpoint must retain independent pre-edit V1 bytes');
      assert.equal(result.currentV1,changed,
        'startup/inspection/rehearsal must never auto-restore saved V1');
      assert.equal(result.rehearsal.planValid,true,JSON.stringify(result.rehearsal));
      assert.equal(result.rehearsal.canApply,false);
      assert.equal(result.rehearsal.counts.replaceChanged>=1,true);
      assert.ok(result.rehearsal.blockers.includes('production_writer_fencing_not_implemented'));
      assert.equal(result.authority,'legacy_only');
    }
    return {durableCheckpoint:true,readbacks:observations.length,
      checksumVerified:true,nonMutatingRehearsal:true,autoRestore:false};
  });

  await run('preview rollback checkpoint rejects tampered payload and capture metadata across reload', async context => {
    const page=await open(context);
    const originalV1=await page.evaluate(()=>localStorage.getItem('taskpoints_v1'));
    const created=await page.evaluate(async()=>{
      const runtime=window.TaskPointsStateRuntimeV2;
      const first=await runtime.createPreviewRecoveryCheckpoint();
      const second=await runtime.createPreviewRecoveryCheckpoint();
      return {first,second};
    });
    for(const saved of [created.first,created.second]){
      assert.equal(saved.saved,true,JSON.stringify(saved));
      assert.equal(saved.verified,true);
    }
    const tampered=await page.evaluate(async ids=>{
      const db=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const tx=db.transaction('snapshots','readwrite');
      const store=tx.objectStore('snapshots');
      const read=id=>new Promise((resolve,reject)=>{
        const request=store.get(id);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      const first=await read(ids[0]),second=await read(ids[1]);
      first.entries=first.entries.map(entry=>entry[0]==='taskpoints_v1'
        ? ['taskpoints_v1','{"notes":"CORRUPTED CHECKPOINT"}'] : entry);
      second.capturedAtISO='1999-01-01T00:00:00.000Z';
      store.put(first);
      store.put(second);
      await new Promise((resolve,reject)=>{
        tx.oncomplete=resolve;
        tx.onabort=()=>reject(tx.error||Error('checkpoint tamper transaction aborted'));
        tx.onerror=()=>reject(tx.error||Error('checkpoint tamper failed'));
      });
      db.close();
      return true;
    },[created.first.checkpointId,created.second.checkpointId]);
    assert.equal(tampered,true);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>Boolean(window.V2BrowserFixture?.status().runtime.installed));
    for(const saved of [created.first,created.second]){
      const result=await page.evaluate(async id=>{
        const runtime=window.TaskPointsStateRuntimeV2;
        return {inspection:await runtime.inspectPreviewRecoveryCheckpoint(id),
          plan:await runtime.inspectPreviewRollbackPlan(id),
          legacy:localStorage.getItem('taskpoints_v1'),
          authority:runtime.getStatus().readAuthority};
      },saved.checkpointId);
      assert.equal(result.inspection.intact,false);
      assert.equal(result.inspection.reason,'checkpoint_integrity_failed');
      assert.equal(result.plan.planValid,false);
      assert.equal(result.plan.canApply,false);
      assert.equal(result.plan.reason,'checkpoint_integrity_failed');
      assert.equal(result.legacy,originalV1,'failed checksum must never touch V1');
      assert.equal(result.authority,'legacy_only');
    }
    return {payloadCorruptionRejected:true,metadataCorruptionRejected:true,
      reloadVerified:true,legacyUnchanged:true};
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
