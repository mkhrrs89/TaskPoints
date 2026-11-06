'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {TextEncoder} = require('node:util');
const {FakeIndexedDB,FakeStorage} = require('./helpers/fake_indexeddb_v2');
const script = fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const V1 = 'taskpoints_v1', DARK = 'taskpoints_state_v2_dark_mode_v1';
const CACHE = 'taskpoints_notes_v1', DIRTY = 'taskpoints_notes_dirty_v1';
const AUTH = 'taskpoints_notes_authoritative_v1';
const DB = 'taskpoints_v2_notes_preview';
const legacy = (notes='snapshot secret') => ({
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  tasks:[],completions:[],notes
});
async function boot(opts={}) {
  const localStorage = opts.localStorage || new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify(legacy()),
    ...(opts.cache===undefined ? {} : {[CACHE]:opts.cache}),
    ...(opts.dirty===undefined ? {} : {[DIRTY]:opts.dirty}),
    ...(opts.authority===undefined ? {} : {[AUTH]:opts.authority})
  });
  const indexedDB = opts.indexedDB || new FakeIndexedDB();
  let uuid=0;
  const core = {
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},
    applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1))},
    writePendingHabitDelta(delta){return {...delta}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const ctx = {
    indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:opts.crypto||{subtle:webcrypto.subtle,
      randomUUID(){return 'notes-preview-'+(++uuid)}},
    location:{hostname:opts.hostname||'localhost'},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}
  };
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  const token=()=>JSON.stringify(Array.from({length:localStorage.length},
    (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));
  return {api,ctx,indexedDB,localStorage,token};
}

test('Notes dual-source bundle seed is atomic, independent of V1 and still never a live reader',async()=>{
  const app=await boot({cache:'',dirty:'1',authority:'1'});
  const before=app.localStorage.getItem(V1);
  const canonicalBefore=app.indexedDB.dump('taskpoints_state_v2');
  const tokenBefore=app.token();
  const seed=await app.api.rehearsePreviewNotesBundleSeed(tokenBefore,'notes-action-1');
  assert.equal(seed.reason,'notes_preview_bundle_seed_verified',JSON.stringify(seed));
  assert.equal(seed.committed,true);
  assert.equal(seed.confirmedDurable,true);
  assert.equal(seed.collectionParityVerified,true);
  assert.equal(seed.canPromote,false);
  assert.equal(seed.notesMigrated,false);
  assert.equal(seed.readAuthority,'legacy_only');
  assert.equal(JSON.stringify(seed).includes('snapshot secret'),false);
  assert.equal(app.localStorage.getItem(V1),before);
  assert.equal(app.localStorage.getItem(CACHE),'');
  assert.equal(app.localStorage.getItem(DIRTY),'1');
  assert.equal(app.token(),tokenBefore);
  assert.deepEqual(app.indexedDB.dump('taskpoints_state_v2'),canonicalBefore);
  const rows=app.indexedDB.dump(DB);
  assert.equal(rows.bundles.length,1);
  assert.equal(rows.bundles[0].stateNotes,'snapshot secret');
  assert.equal(rows.bundles[0].cacheNotes,'');
  assert.equal(rows.bundles[0].selectedSource,'marked_cache');
  assert.equal(rows.receipts[0].type,'notes-preview-seed');
  assert.equal(rows.meta[0].receiptId,rows.receipts[0].id);
  assert.match(rows.meta[0].bundleFingerprint,/^sha256:[a-f0-9]{64}:\d+$/);
  const proof=await app.api.inspectPreviewNotesBundleParity();
  assert.equal(proof.match,true,JSON.stringify(proof));
  assert.equal(proof.canPromote,false);
  assert.equal(JSON.stringify(proof).includes('snapshot secret'),false);
});

test('Notes bundle no-op never overwrites old immutable receipt, including reload',async()=>{
  const app=await boot({cache:'cache-only',authority:'1'});
  assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'original')).committed,true);
  const before=app.indexedDB.dump(DB);
  const second=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'different-id');
  assert.equal(second.reason,'notes_preview_bundle_already_verified',JSON.stringify(second));
  assert.equal(second.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const reload=await boot({indexedDB:app.indexedDB,localStorage:app.localStorage});
  const check=await reload.api.inspectPreviewNotesBundleParity();
  assert.equal(check.match,true,JSON.stringify(check));
  assert.deepEqual(reload.indexedDB.dump(DB),before);
});

test('Stale Notes cache, marker, or unrelated full-origin write is refused without overwriting a bundle',async()=>{
  for (const change of [
    app=>app.localStorage.setItem(CACHE,'newer text'),
    app=>app.localStorage.setItem(DIRTY,'1'),
    app=>app.localStorage.setItem('tp_projects_v1','{"newer":true}')
  ]) {
    const app=await boot({cache:'original',authority:'1'});
    assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'first')).committed,true);
    const before=app.indexedDB.dump(DB);
    change(app);
    const parity=await app.api.inspectPreviewNotesBundleParity();
    assert.equal(parity.match,false,JSON.stringify(parity));
    const retry=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'second');
    assert.equal(retry.committed,false,JSON.stringify(retry));
    assert.deepEqual(app.indexedDB.dump(DB),before);
  }
});

test('A stale full-origin token is rejected before creating an isolated Notes database',async()=>{
  const app=await boot({cache:'before',authority:'1'});
  const token=app.token();
  app.localStorage.setItem(CACHE,'after');
  const result=await app.api.rehearsePreviewNotesBundleSeed(token,'stale');
  assert.equal(result.reason,'full_origin_changed',JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(app.indexedDB.dump(DB),null);
});

test('Quota denial rolls back Notes bundle, receipt and metadata as one transaction',async()=>{
  for (const store of ['bundles','receipts','meta']) {
    const app=await boot({cache:'dirty cache',dirty:'1'});
    app.indexedDB.failNext({store,operation:'add',
      error:new Error('QuotaExceededError')});
    const failed=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'quota');
    assert.equal(failed.committed,false,JSON.stringify(failed));
    const rows=app.indexedDB.dump(DB);
    assert.deepEqual(rows.bundles,[]);
    assert.deepEqual(rows.receipts,[]);
    assert.deepEqual(rows.meta,[]);
    const retry=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'safe-retry');
    assert.equal(retry.collectionParityVerified,true,JSON.stringify(retry));
  }
});

test('Missing marked cache or invalid marker cannot seed a Notes bundle',async()=>{
  const cases=[{dirty:'1'},{cache:'text',authority:'bad'}];
  for (const opts of cases) {
    const app=await boot(opts);
    const result=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'bad');
    assert.equal(result.reason,'notes_source_preflight_required',JSON.stringify(result));
    assert.equal(result.committed,false);
    assert.equal(app.indexedDB.dump(DB),null);
  }
});

test('Production host and disabled dark mode never open the Notes preview database',async()=>{
  const app=await boot({cache:'text',hostname:'taskpoints.pages.dev'});
  assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'blocked')).reason,
    'preview_host_required');
  assert.equal((await app.api.inspectPreviewNotesBundleParity()).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'blocked')).reason,
    'dark_disabled');
  assert.equal(app.indexedDB.dump(DB),null);
});

test('Notes bundle digest race does not create preview DB or touch newer V1 cache',async()=>{
  let app, armed=false;
  const crypto={randomUUID(){return 'race'},subtle:{
    digest:async(...args)=>{
      const out=await webcrypto.subtle.digest(...args);
      if(armed) {
        armed=false;
        app.localStorage.setItem(CACHE,'newer typed text');
      }
      return out;
    }
  }};
  app=await boot({cache:'old cache',authority:'1',crypto});
  armed=true;
  const result=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'race');
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(app.localStorage.getItem(CACHE),'newer typed text');
  assert.equal(app.indexedDB.dump(DB),null);
});


test('Notes reconciliation preserves both text copies, including shortened and erased authoritative cache',async()=>{
  const app=await boot({cache:'longer cached document',authority:'1'});
  const v1=app.localStorage.getItem(V1);
  const start=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  assert.equal(start.collectionParityVerified,true,JSON.stringify(start));
  const original=app.indexedDB.dump(DB);
  app.localStorage.setItem(CACHE,'short');
  app.localStorage.setItem(DIRTY,'1');
  const updated=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'edit-1');
  assert.equal(updated.reason,'notes_preview_reconcile_verified',JSON.stringify(updated));
  assert.equal(updated.committed,true);
  assert.equal(updated.receiptCount,2);
  const rows=app.indexedDB.dump(DB);
  assert.equal(rows.bundles[0].stateNotes,'snapshot secret');
  assert.equal(rows.bundles[0].cacheNotes,'short');
  assert.equal(rows.bundles[0].selectedSource,'marked_cache');
  assert.equal(rows.receipts.length,2);
  const initialReceipt=original.receipts[0];
  assert.deepEqual(rows.receipts.find(r=>r.id===initialReceipt.id),initialReceipt);
  const second=rows.receipts.find(r=>r.type==='notes-preview-reconcile');
  assert.equal(second.priorReceiptId,initialReceipt.id);
  assert.equal(second.priorBundleFingerprint,initialReceipt.bundleFingerprint);
  assert.equal(rows.meta[0].receiptId,second.id);
  assert.equal((await app.api.inspectPreviewNotesBundleParity()).match,true);
  app.localStorage.setItem(CACHE,'');
  const cleared=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'edit-empty');
  assert.equal(cleared.collectionParityVerified,true,JSON.stringify(cleared));
  assert.equal(cleared.receiptCount,3);
  assert.equal(app.indexedDB.dump(DB).bundles[0].cacheNotes,'');
  assert.equal(app.localStorage.getItem(V1),v1);
  assert.equal(app.localStorage.getItem(DIRTY),'1');
  assert.equal(app.localStorage.getItem(AUTH),'1');
  assert.equal(JSON.stringify(updated).includes('short'),false);
  assert.equal(updated.readAuthority,'legacy_only');
  assert.equal(updated.canPromote,false);
});

test('Notes reconcile no-op, multiple updates and reload preserve receipt lineage',async()=>{
  const app=await boot({cache:'cache A',authority:'1'});
  assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed')).committed,true);
  const before=app.indexedDB.dump(DB);
  const noOp=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'no-op');
  assert.equal(noOp.reason,'notes_preview_reconcile_no_change',JSON.stringify(noOp));
  assert.equal(noOp.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  for(const [i,content] of ['cache B','cache C','cache D'].entries()){
    app.localStorage.setItem(CACHE,content);
    const update=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'update-'+i);
    assert.equal(update.reason,'notes_preview_reconcile_verified',JSON.stringify(update));
    assert.equal(update.receiptCount,2+i);
  }
  const snapshot=app.indexedDB.dump(DB);
  assert.equal(snapshot.receipts.length,4);
  const newSeed=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'same-new-seed-id');
  assert.equal(newSeed.reason,'notes_preview_bundle_already_verified');
  assert.deepEqual(app.indexedDB.dump(DB),snapshot);
  const restarted=await boot({localStorage:app.localStorage,indexedDB:app.indexedDB});
  assert.equal((await restarted.api.inspectPreviewNotesBundleParity()).match,true);
  assert.deepEqual(restarted.indexedDB.dump(DB),snapshot);
});

test('A stale full-origin token cannot reconcile a newer Notes cache or unrelated V1 change',async()=>{
  const app=await boot({cache:'original',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem(CACHE,'changed before operation');
  const token=app.token();
  app.localStorage.setItem('tp_projects_v1','external edit');
  const prior=app.indexedDB.dump(DB);
  const reject=await app.api.rehearsePreviewNotesBundleReconcile(token,'stale');
  assert.equal(reject.reason,'full_origin_changed',JSON.stringify(reject));
  assert.equal(reject.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});

test('Notes reconcile quota failures on bundle, receipt and metadata always roll back',async()=>{
  for(const [store,operation] of [['bundles','put'],['receipts','add'],['meta','put']]){
    const app=await boot({cache:'first',authority:'1'});
    await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
    const before=app.indexedDB.dump(DB);
    app.localStorage.setItem(CACHE,'second');
    app.indexedDB.failNext({store,operation,error:new Error('QuotaExceededError')});
    const failed=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'quota-'+store);
    assert.equal(failed.committed,false,JSON.stringify(failed));
    assert.deepEqual(app.indexedDB.dump(DB),before);
    assert.equal((await app.api.inspectPreviewNotesBundleParity()).match,false);
    const retry=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'retry-'+store);
    assert.equal(retry.collectionParityVerified,true,JSON.stringify(retry));
    assert.equal(app.indexedDB.dump(DB).receipts.length,2);
  }
});

test('Notes reconcile does not reuse action ID across distinct source versions',async()=>{
  const app=await boot({cache:'first',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem(CACHE,'second');
  assert.equal((await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'same-action')).committed,true);
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(CACHE,'third');
  const failed=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'same-action');
  assert.equal(failed.reason,'notes_preview_action_id_reused',JSON.stringify(failed));
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal((await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'new-action')).committed,true);
});

test('Notes lineage digest and receipt tampering refuse reconciliation without modifying evidence',async()=>{
  for (const corruption of [
    rows=>{rows.bundles.get('notes-source').stateNotes='tampered';},
    rows=>{rows.meta.get('notes-source').bundleFingerprint='sha256:bad:123';},
    rows=>{rows.receipts.get('notes-preview-seed:seed').originFingerprint='sha256:bad:123';}
  ]) {
    const app=await boot({cache:'first',authority:'1'});
    await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
    const db=app.indexedDB._databases.get(DB);
    const rows={
      bundles:db._stores.get('bundles'),
      meta:db._stores.get('meta'),
      receipts:db._stores.get('receipts')
    };
    corruption(rows);
    const prior=app.indexedDB.dump(DB);
    app.localStorage.setItem(CACHE,'later');
    const failed=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'reject');
    assert.equal(failed.committed,false,JSON.stringify(failed));
    assert.deepEqual(app.indexedDB.dump(DB),prior);
    const parity=await app.api.inspectPreviewNotesBundleParity();
    assert.equal(parity.match,false,JSON.stringify(parity));
  }
});

test('Notes reconciliation aborts transaction when V1 source changes after preflight',async()=>{
  const app=await boot({cache:'one',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem(CACHE,'two');
  const before=app.indexedDB.dump(DB);
  const db=app.indexedDB._databases.get(DB);
  const original=db.transaction.bind(db);
  let injected=false;
  db.transaction=(stores,mode)=>{
    if (!injected && mode==='readwrite' && stores.includes('bundles')){
      injected=true;
      app.localStorage.setItem(CACHE,'three from old tab');
    }
    return original(stores,mode);
  };
  const result=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'race');
  assert.equal(injected,true);
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(result.reason,'legacy_notes_changed_under_reconcile',JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal(app.localStorage.getItem(CACHE),'three from old tab');
});

test('Notes reconcile denies changed generation and production host, retaining previous V2 bundle',async()=>{
  const app=await boot({cache:'old',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const prior=app.indexedDB.dump(DB);
  app.localStorage.setItem(CACHE,'new');
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'deny')).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.setItem('taskpoints_state_v2_generation_v1','another-generation');
  const result=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'old-gen');
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),prior);
});

test('Current Notes source is rechecked after SHA work: no stale V2 commit on digest race',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'race'},subtle:{
    digest:async(...args)=>{
      const result=await webcrypto.subtle.digest(...args);
      if(armed){
        armed=false;
        app.localStorage.setItem(CACHE,'newest text');
      }
      return result;
    }
  }};
  app=await boot({cache:'old',authority:'1',crypto});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(CACHE,'intermediate');
  armed=true;
  const result=await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'digest-race');
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(app.localStorage.getItem(CACHE),'newest text');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});


function enableSyntheticRecoveryWal(app) {
  app.ctx.TaskPointsStateRuntimeV2Wal={
    getPendingRows(){return {ok:true,rows:[]};}
  };
}
async function fullOriginCheckpoint(app) {
  enableSyntheticRecoveryWal(app);
  const result=await app.api.createPreviewRecoveryCheckpoint({scope:'full_origin'});
  assert.equal(result.saved,true,JSON.stringify(result));
  assert.equal(result.captureScope,'full_origin');
  assert.equal(result.canAutoRestore,false);
  return result.checkpointId;
}

test('Notes checkpoint coverage binds verified dual-source bundle to full-origin localStorage checkpoint',async()=>{
  const app=await boot({cache:'',dirty:'1',authority:'1'});
  const cp=await fullOriginCheckpoint(app);
  assert.equal((await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed')).collectionParityVerified,true);
  const v1=app.token(),notesDb=app.indexedDB.dump(DB);
  const audit=await app.api.inspectPreviewNotesCheckpointCoverage(cp);
  assert.equal(audit.reason,'checkpoint_notes_coverage_verified',JSON.stringify(audit));
  assert.equal(audit.checkpointVerified,true);
  assert.equal(audit.notesBundleVerified,true);
  assert.equal(audit.checkpointMatchesPreviewBundle,true);
  assert.equal(audit.checkpointMatchesCurrentV1,true);
  assert.equal(audit.fullOriginLocalStorageCovered,true);
  assert.equal(audit.coversIndexedDB,false);
  assert.equal(audit.coversImages,false);
  assert.equal(audit.offDeviceBackupVerified,false);
  assert.equal(audit.canApply,false);
  assert.equal(audit.canPromote,false);
  assert.equal(audit.readAuthority,'legacy_only');
  assert.equal(JSON.stringify(audit).includes('snapshot secret'),false);
  assert.equal(app.token(),v1);
  assert.deepEqual(app.indexedDB.dump(DB),notesDb);
});

test('Notes checkpoint refuses false freshness after later Notes edit and reconciliation',async()=>{
  const app=await boot({cache:'first',authority:'1'});
  const checkpointOld=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem(CACHE,'later');
  const stale=await app.api.inspectPreviewNotesCheckpointCoverage(checkpointOld);
  assert.equal(stale.checkpointVerified,true,JSON.stringify(stale));
  assert.equal(stale.checkpointMatchesPreviewBundle,true);
  assert.equal(stale.checkpointMatchesCurrentV1,false);
  assert.equal(stale.reason,'checkpoint_older_than_current_origin');
  assert.equal(stale.canApply,false);
  assert.equal((await app.api.rehearsePreviewNotesBundleReconcile(
    app.token(),'later-edit')).collectionParityVerified,true);
  const olderAfterReconcile=await app.api.inspectPreviewNotesCheckpointCoverage(checkpointOld);
  assert.equal(olderAfterReconcile.checkpointMatchesPreviewBundle,false);
  assert.equal(olderAfterReconcile.checkpointMatchesCurrentV1,false);
  assert.equal(olderAfterReconcile.reason,'checkpoint_notes_bundle_differs');
  const checkpointNew=await fullOriginCheckpoint(app);
  const fresh=await app.api.inspectPreviewNotesCheckpointCoverage(checkpointNew);
  assert.equal(fresh.reason,'checkpoint_notes_coverage_verified',JSON.stringify(fresh));
  assert.equal(fresh.checkpointMatchesPreviewBundle,true);
  assert.equal(fresh.checkpointMatchesCurrentV1,true);
});

test('Notes checkpoint detects same-generation V1 restore without promoting stale V2',async()=>{
  const app=await boot({cache:'first',authority:'1'});
  const checkpoint=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem(CACHE,'second');
  await app.api.rehearsePreviewNotesBundleReconcile(app.token(),'update');
  const current=app.localStorage.getItem(CACHE);
  const saved=app.indexedDB._databases.get('taskpoints_v2_recovery_checkpoints_preview');
  const record=saved._stores.get('snapshots').get(checkpoint);
  const savedKeys=new Map(record.entries);
  // A synthetic import/restore replay replaces the V1 Notes cache only.
  // It does not call any V2 writer, and therefore must never grant authority.
  app.localStorage.setItem(CACHE,savedKeys.get(CACHE));
  const audit=await app.api.inspectPreviewNotesCheckpointCoverage(checkpoint);
  assert.equal(audit.checkpointMatchesCurrentV1,true,JSON.stringify(audit));
  assert.equal(audit.checkpointMatchesPreviewBundle,false);
  assert.equal(audit.canApply,false);
  assert.equal(audit.canPromote,false);
  assert.equal(app.localStorage.getItem(CACHE),'first');
  assert.equal(current,'second');
});

test('A taskpoints-only checkpoint is insufficient for full-origin Notes rollback proof',async()=>{
  const app=await boot({cache:'notes',authority:'1'});
  enableSyntheticRecoveryWal(app);
  const cp=await app.api.createPreviewRecoveryCheckpoint();
  assert.equal(cp.saved,true,JSON.stringify(cp));
  assert.equal(cp.captureScope,'taskpoints_namespace');
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const audit=await app.api.inspectPreviewNotesCheckpointCoverage(cp.checkpointId);
  assert.equal(audit.reason,'checkpoint_full_origin_required',JSON.stringify(audit));
  assert.equal(audit.checkpointVerified,true);
  assert.equal(audit.fullOriginLocalStorageCovered,false);
  assert.equal(audit.canApply,false);
});

test('Tampered checkpoint, missing record, and unknown ID are all denied read-only',async()=>{
  const app=await boot({cache:'notes',authority:'1'});
  const cp=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  assert.equal((await app.api.inspectPreviewNotesCheckpointCoverage(
    'v1-preview:does-not-exist')).reason,'checkpoint_missing');
  assert.equal((await app.api.inspectPreviewNotesCheckpointCoverage(
    'not-a-checkpoint')).reason,'checkpoint_id_required');
  const db=app.indexedDB._databases.get('taskpoints_v2_recovery_checkpoints_preview');
  db._stores.get('snapshots').get(cp).entries[0][1]='untrusted altered data';
  const before=app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview');
  const result=await app.api.inspectPreviewNotesCheckpointCoverage(cp);
  assert.equal(result.reason,'checkpoint_integrity_failed',JSON.stringify(result));
  assert.equal(result.canApply,false);
  assert.deepEqual(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),before);
});

test('Rotated V2 generation denies even an intact full-origin Notes checkpoint',async()=>{
  const app=await boot({cache:'notes',authority:'1'});
  const cp=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.localStorage.setItem('taskpoints_state_v2_generation_v1','restore:new-generation');
  const notesBefore=app.indexedDB.dump(DB);
  const result=await app.api.inspectPreviewNotesCheckpointCoverage(cp);
  assert.equal(result.reason,'checkpoint_generation_mismatch',JSON.stringify(result));
  assert.equal(result.checkpointVerified,true);
  assert.equal(result.canApply,false);
  assert.deepEqual(app.indexedDB.dump(DB),notesBefore);
});

test('Notes checkpoint audit detects cross-tab source write while hashing',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'checkpoint-race'},subtle:{
    digest:async(...args)=>{
      const hash=await webcrypto.subtle.digest(...args);
      if(armed){
        armed=false;
        app.localStorage.setItem(CACHE,'newer text from another tab');
      }
      return hash;
    }
  }};
  app=await boot({cache:'old',authority:'1',crypto});
  const cp=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const before=app.indexedDB.dump(DB);
  armed=true;
  const check=await app.api.inspectPreviewNotesCheckpointCoverage(cp);
  assert.equal(check.reason,'notes_checkpoint_origin_changed_during_audit',
    JSON.stringify(check));
  assert.equal(check.canApply,false);
  assert.equal(app.localStorage.getItem(CACHE),'newer text from another tab');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Notes checkpoint proof is unavailable on production hosts or with dark mode off',async()=>{
  const app=await boot({cache:'notes',authority:'1'});
  const cp=await fullOriginCheckpoint(app);
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewNotesCheckpointCoverage(cp)).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.inspectPreviewNotesCheckpointCoverage(cp)).reason,
    'dark_disabled');
});

test('Independent Notes preview proof survives lost source but never restores it',async()=>{
  const app=await boot({cache:'My edited Notes text',dirty:'1',authority:'1'});
  const seeded=await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  assert.equal(seeded.confirmedDurable,true,JSON.stringify(seeded));
  const saved=app.indexedDB.dump(DB);
  assert.equal((await app.api.inspectPreviewNotesRecoveryEvidence()).evidenceVerified,true);
  app.localStorage.removeItem(CACHE);
  app.localStorage.setItem(V1,'{broken snapshot');
  const result=await app.api.inspectPreviewNotesRecoveryEvidence();
  assert.equal(result.evidenceVerified,true,JSON.stringify(result));
  assert.equal(result.sourceCompared,false);
  assert.equal(result.safeToRestore,false);
  assert.equal(result.canPromote,false);
  assert.equal(JSON.stringify(result).includes('My edited Notes'),false);
  assert.equal((await app.api.inspectPreviewNotesBundleParity()).match,false);
  assert.deepEqual(app.indexedDB.dump(DB),saved);
  assert.equal(app.localStorage.getItem(CACHE),null);
  assert.equal(app.localStorage.getItem(V1),'{broken snapshot');
});

test('Independent Notes preview proof fails closed for altered saved evidence',async()=>{
  const app=await boot({cache:'Hello',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const db=app.indexedDB._databases.get(DB);
  const store=db._stores.get('bundles'),record=store.get('notes-source');
  store.set('notes-source',{...record,selectedSource:'unmarked_snapshot_longer'});
  const denied=await app.api.inspectPreviewNotesRecoveryEvidence();
  assert.equal(denied.evidenceVerified,false);
  assert.equal(denied.canPromote,false);
  assert.equal(store.get('notes-source').selectedSource,'unmarked_snapshot_longer');
  store.set('notes-source',record);
  assert.equal((await app.api.inspectPreviewNotesRecoveryEvidence()).evidenceVerified,true);
});

test('Independent Notes preview proof respects production and generation fences',async()=>{
  const app=await boot({cache:'My text',authority:'1'});
  await app.api.rehearsePreviewNotesBundleSeed(app.token(),'seed');
  const saved=app.indexedDB.dump(DB);
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewNotesRecoveryEvidence()).reason,'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.inspectPreviewNotesRecoveryEvidence()).reason,'dark_disabled');
  app.localStorage.setItem(DARK,'1');
  app.localStorage.setItem('taskpoints_state_v2_generation_v1','another-generation');
  assert.equal((await app.api.inspectPreviewNotesRecoveryEvidence()).evidenceVerified,false);
  assert.deepEqual(app.indexedDB.dump(DB),saved);
});
