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
