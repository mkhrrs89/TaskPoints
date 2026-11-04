'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {TextEncoder}=require('node:util');
const {FakeIndexedDB,FakeStorage}=require('./helpers/fake_indexeddb_v2');
const script=fs.readFileSync(path.join(__dirname,'..','state_runtime_v2.js'),'utf8');
const V1='taskpoints_v1',DARK='taskpoints_state_v2_dark_mode_v1';
const DB='taskpoints_v2_game_preview',SORT='taskpoints_player_sort_mode';
const GROUP='taskpoints_group_active_players',COLS='taskpoints_gallery_columns';
function legacy(){
  return {
    habits:[{id:'h1',name:'walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
    tasks:[],completions:[],notes:'keep my notes',
    players:[
      {id:'p2',name:'Player Two',rating:71,unfamiliarField:{x:[1,2]}},
      {id:'p1',name:'Player One',rivalId:'p2',nested:{keep:'entire blob'}}
    ],
    gameHistory:[{id:'gm1',scores:[6,7],custom:'game result'}],
    matchups:[{id:'m1',playerIds:['p2','p1']}],
    schedule:[{date:'2026-11-04',away:'p2',home:'p1'}],
    opponentDripSchedules:[{playerId:'p2',customDrip:[40,12]}],
    seasonHistory:[{id:'season3',locked:true,award:'Gold'}],
    currentSeason:{id:'season4',started:'2026-11-01',futureField:{x:1}},
    latestSeasonId:'season4',
    youName:'User Player',youNotes:'preserve private note',
    youImageId:'image-1',youRivalId:'p2',
    youPrimaryColor:'#c43e50',youSecondaryColor:'#3079ff'
  };
}
async function boot(opts={}){
  const localStorage=opts.localStorage||new FakeStorage({
    [DARK]:'1',[V1]:JSON.stringify(opts.state||legacy()),
    [COLS]:'{"portrait":3,"landscape":4}',
    [SORT]:'pid-asc',[GROUP]:'true'
  });
  const indexedDB=opts.indexedDB||new FakeIndexedDB();let count=0;
  const core={
    STORAGE_KEY:V1,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(V1))},
    writePendingHabitDelta(row){return {...row}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,
    crypto:opts.crypto||{subtle:webcrypto.subtle,
      randomUUID(){return 'game-'+(++count)}},
    location:{hostname:opts.hostname||'localhost'},
    JSON,Date,Math,String,Number,Boolean,Array,Object,Map,Set,Promise,
    TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  const token=()=>JSON.stringify(Array.from({length:localStorage.length},
    (_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]));
  return {api,ctx,localStorage,indexedDB,token};
}
const seed=(app,id='initial')=>app.api.rehearsePreviewGameCollectionSeed(app.token(),id);
const reconcile=(app,id='edit')=>app.api.rehearsePreviewGameCollectionReconcile(app.token(),id);

test('Game bundle atomic seed retains every player field, history, season and independent preference',async()=>{
  const app=await boot(),v1=app.token();
  const pilot=app.indexedDB.dump('taskpoints_state_v2');
  const outcome=await seed(app);
  assert.equal(outcome.reason,'game_preview_seed_verified',JSON.stringify(outcome));
  assert.equal(outcome.committed,true);
  assert.equal(outcome.confirmedDurable,true);
  assert.equal(outcome.collectionParityVerified,true);
  assert.equal(outcome.canPromote,false);
  assert.equal(outcome.readAuthority,'legacy_only');
  assert.equal(outcome.gameMigrated,false);
  const r=app.indexedDB.dump(DB);
  assert.equal(r.players.length,2);
  assert.deepEqual(r.players.map(row=>row.value),legacy().players);
  assert.equal(r.players[0].id,0);
  assert.equal(r.players[1].id,1);
  for(const field of ['gameHistory','matchups','schedule',
    'opponentDripSchedules','seasonHistory','currentSeason',
    'latestSeasonId','youName','youNotes','youImageId','youRivalId',
    'youPrimaryColor','youSecondaryColor'])
    assert.deepEqual(r.bundles[0].fields[field],legacy()[field],field);
  assert.equal(r.bundles[0].preferences[0],app.localStorage.getItem(COLS));
  assert.equal(r.bundles[0].preferences[1],app.localStorage.getItem(SORT));
  assert.equal(r.bundles[0].preferences[2],app.localStorage.getItem(GROUP));
  assert.equal(r.receipts[0].type,'game-preview-seed');
  assert.equal(r.meta[0].receiptId,r.receipts[0].id);
  const p=await app.api.inspectPreviewGameCollectionParity();
  assert.equal(p.match,true,JSON.stringify(p));
  assert.equal(app.token(),v1);
  assert.deepEqual(app.indexedDB.dump('taskpoints_state_v2'),pilot);
  assert.equal(JSON.stringify(outcome).includes('keep my notes'),false);
});

test('Game unchanged seed/reconcile are verified immutable no-ops across reload',async()=>{
  const app=await boot();
  assert.equal((await seed(app)).committed,true);
  const r=app.indexedDB.dump(DB);
  const again=await seed(app,'new-seed');
  assert.equal(again.reason,'game_preview_already_verified',JSON.stringify(again));
  assert.equal(again.committed,false);
  const noop=await reconcile(app,'noop');
  assert.equal(noop.reason,'game_preview_reconcile_no_change',JSON.stringify(noop));
  assert.equal(noop.committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),r);
  const restarted=await boot({indexedDB:app.indexedDB,localStorage:app.localStorage});
  assert.equal((await restarted.api.inspectPreviewGameCollectionParity()).match,true);
  assert.deepEqual(restarted.indexedDB.dump(DB),r);
});

test('Game reconcile handles player edit, addition, deletion, reordered roster and season metadata',async()=>{
  const app=await boot();
  await seed(app);
  const original=app.indexedDB.dump(DB);
  const value=JSON.parse(app.localStorage.getItem(V1));
  value.players=[{...value.players[1],name:'Updated Player'},
    {id:'p3',name:'New Player',futureData:{streaky:83}}];
  value.seasonHistory.push({id:'season4',unexpected:{retained:true}});
  value.currentSeason={id:'season4',awards:['GOLD'],unusual:'retained'};
  value.gameHistory.unshift({id:'gm2',points:{home:34,away:31}});
  app.localStorage.setItem(V1,JSON.stringify(value));
  const first=await reconcile(app,'roster-update');
  assert.equal(first.reason,'game_preview_reconcile_verified',JSON.stringify(first));
  assert.equal(first.committed,true);
  assert.equal(first.receiptCount,2);
  assert.equal((await app.api.inspectPreviewGameCollectionParity()).match,true);
  const rows=app.indexedDB.dump(DB);
  assert.deepEqual(rows.players.map(x=>x.value),value.players);
  assert.deepEqual(rows.bundles[0].fields.seasonHistory,value.seasonHistory);
  assert.deepEqual(rows.bundles[0].fields.currentSeason,value.currentSeason);
  assert.deepEqual(rows.bundles[0].fields.gameHistory,value.gameHistory);
  assert.deepEqual(rows.receipts.find(x=>x.id==='game-preview-seed:initial'),
    original.receipts[0]);
  const newer=rows.receipts.find(x=>x.id==='game-preview-reconcile:roster-update');
  assert.equal(newer.priorReceiptId,original.receipts[0].id);
  assert.equal(rows.meta[0].receiptId,newer.id);
  app.localStorage.setItem(SORT,'overall-desc');
  const prefs=await reconcile(app,'change-prefs');
  assert.equal(prefs.reason,'game_preview_reconcile_verified',JSON.stringify(prefs));
  assert.equal(prefs.changedPlayers,0);
  assert.equal(prefs.receiptCount,3);
  assert.equal(app.indexedDB.dump(DB).bundles[0].preferences[1],'overall-desc');
  assert.equal((await app.api.inspectPreviewGameCollectionParity()).match,true);
});

test('Game source changes remain stale until explicit reconciliation and never reseed',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem('tp_projects_v1','outside Game');
  const parity=await app.api.inspectPreviewGameCollectionParity();
  assert.equal(parity.match,false,JSON.stringify(parity));
  assert.equal((await seed(app,'should-refuse')).committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const fresh=await reconcile(app,'only-origin');
  assert.equal(fresh.collectionParityVerified,true,JSON.stringify(fresh));
  assert.equal(fresh.changedPlayers,0);
  assert.equal((await app.api.inspectPreviewGameCollectionParity()).match,true);
});

test('Game stale token refuses before preview database creation',async()=>{
  const app=await boot();
  const token=app.token();
  app.localStorage.setItem(SORT,'name-desc');
  const result=await app.api.rehearsePreviewGameCollectionSeed(token,'stale');
  assert.equal(result.reason,'full_origin_changed',JSON.stringify(result));
  assert.equal(result.committed,false);
  assert.equal(app.indexedDB.dump(DB),null);
});

test('Game seed refuses malformed snapshot, invalid field shape and Game preferences without mutation',async()=>{
  for(const mutate of [
    app=>app.localStorage.setItem(V1,'{invalid JSON'),
    app=>app.localStorage.setItem(V1,JSON.stringify({...legacy(),players:{}})),
    app=>app.localStorage.setItem(V1,JSON.stringify({...legacy(),players:[null]})),
    app=>app.localStorage.setItem(SORT,'not-a-valid-sort'),
    app=>app.localStorage.removeItem(V1)
  ]) {
    const app=await boot();mutate(app);
    const source=app.token();
    const result=await seed(app);
    assert.equal(result.committed,false,JSON.stringify(result));
    assert.equal(app.indexedDB.dump(DB),null);
    assert.equal(app.token(),source);
  }
});

test('Game seed and reconcile quota errors roll back every player, bundle, receipt and meta',async()=>{
  for(const [store,operation] of [
    ['players','put'],['bundles','put'],['receipts','add'],['meta','put']
  ]){
    const app=await boot();
    app.indexedDB.failNext({store,operation,error:new Error('QuotaExceededError')});
    const first=await seed(app,'quota-seed');
    assert.equal(first.committed,false,JSON.stringify(first));
    assert.equal(app.indexedDB.dump(DB)?.players?.length||0,0);
    assert.equal(app.indexedDB.dump(DB)?.receipts?.length||0,0);
    assert.equal((await seed(app,'safe-seed')).committed,true);
    const before=app.indexedDB.dump(DB);
    const state=JSON.parse(app.localStorage.getItem(V1));
    state.players[0].name='new Name';
    app.localStorage.setItem(V1,JSON.stringify(state));
    app.indexedDB.failNext({store,operation,error:new Error('QuotaExceededError')});
    const failed=await reconcile(app,'quota-reconcile');
    assert.equal(failed.committed,false,JSON.stringify(failed));
    assert.deepEqual(app.indexedDB.dump(DB),before);
    assert.equal((await reconcile(app,'safe-reconcile')).committed,true);
  }
});

test('Game source race under transaction refuses after old-tab localStorage edit',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(SORT,'name-desc');
  const db=app.indexedDB._databases.get(DB);
  const old=db.transaction.bind(db);let injected=false;
  db.transaction=(stores,mode)=>{
    if(!injected&&mode==='readwrite'){
      injected=true;
      app.localStorage.setItem(GROUP,'false');
    }
    return old(stores,mode);
  };
  const result=await reconcile(app,'race');
  assert.equal(injected,true);
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(result.reason,'legacy_game_changed_under_transaction',JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
  assert.equal(app.localStorage.getItem(GROUP),'false');
});

test('Game player or receipt tampering refuses reconciliation preserving evidence',async()=>{
  for(const mutate of [
    db=>{Array.from(db._stores.get('players').values())[0].value.name='poison';},
    db=>{db._stores.get('meta').get('game-source').bundleFingerprint='sha256:bad:0';},
    db=>{db._stores.get('receipts').get('game-preview-seed:initial').bundleFingerprint='bad';}
  ]){
    const app=await boot();await seed(app);
    const db=app.indexedDB._databases.get(DB);
    mutate(db);
    const prev=app.indexedDB.dump(DB);
    app.localStorage.setItem(SORT,'name-desc');
    const update=await reconcile(app,'tampered');
    assert.equal(update.committed,false,JSON.stringify(update));
    assert.deepEqual(app.indexedDB.dump(DB),prev);
    assert.equal((await app.api.inspectPreviewGameCollectionParity()).match,false);
  }
});

test('Game reconciliation refuses reused receipt IDs and overly large logical batches',async()=>{
  const app=await boot();await seed(app);
  app.localStorage.setItem(SORT,'name-desc');
  assert.equal((await reconcile(app,'same')).committed,true);
  const before=app.indexedDB.dump(DB);
  app.localStorage.setItem(SORT,'name-asc');
  const reused=await reconcile(app,'same');
  assert.equal(reused.reason,'game_preview_action_id_reused',JSON.stringify(reused));
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const state=JSON.parse(app.localStorage.getItem(V1));
  state.players=Array.from({length:70},(_,i)=>({id:'p'+i,name:'Player '+i}));
  app.localStorage.setItem(V1,JSON.stringify(state));
  const many=await reconcile(app,'many');
  assert.equal(many.reason,'game_preview_reconcile_batch_too_large',JSON.stringify(many));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Game digest race refuses stale source without touching V1 or preview receipts',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'race-uuid'},subtle:{
    digest:async(...args)=>{
      const hash=await webcrypto.subtle.digest(...args);
      if(armed){armed=false;app.localStorage.setItem(SORT,'name-desc');}
      return hash;
    }
  }};
  app=await boot({crypto});
  const prior=app.token();
  armed=true;
  const seedResult=await seed(app);
  assert.equal(seedResult.committed,false,JSON.stringify(seedResult));
  assert.notEqual(app.token(),prior);
  assert.equal(app.indexedDB.dump(DB),null);
});

test('Game preview unavailable on production hosts and when dark mode disabled',async()=>{
  const app=await boot();app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await seed(app)).reason,'preview_host_required');
  assert.equal((await app.api.inspectPreviewGameCollectionParity()).reason,'preview_host_required');
  app.ctx.location.hostname='localhost';app.localStorage.removeItem(DARK);
  assert.equal((await seed(app)).reason,'dark_disabled');
  assert.equal(app.indexedDB.dump(DB),null);
});


test('Game preview reconstructed projection preserves every Game field and all unrelated snapshot fields',async()=>{
  const app=await boot();
  const s=JSON.parse(app.localStorage.getItem(V1));
  s.futureGameFeature={id:'experimental',nested:{custom:[1,2,3]}};
  s.tasks=[{id:'t1',name:'Keep original Task and its metadata'}];
  app.localStorage.setItem(V1,JSON.stringify(s));
  await seed(app);
  const before=app.token();
  const result=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(result.gameProjectionVerified,true,JSON.stringify(result));
  assert.equal(result.match,true);
  assert.equal(result.playersPresent,true);
  assert.equal(result.playerCount,2);
  assert.equal(result.fullExportVerified,false);
  assert.equal(result.canPromote,false);
  assert.equal(result.readAuthority,'legacy_only');
  assert.equal(app.token(),before);
  assert.equal(JSON.stringify(result).includes('Keep original Task'),false);
});

test('Game preview preserves absent players property, not just an empty array',async()=>{
  for(const present of [false,true]) {
    const state=legacy();
    if(present)state.players=[];
    else delete state.players;
    const app=await boot({state});
    const init=await seed(app);
    assert.equal(init.collectionParityVerified,true,JSON.stringify(init));
    const rows=app.indexedDB.dump(DB);
    assert.equal(rows.players.length,0);
    assert.equal(rows.bundles[0].playersPresent,present);
    const result=await app.api.inspectPreviewGameCompatibilityProjection();
    assert.equal(result.match,true,JSON.stringify(result));
    assert.equal(result.playersPresent,present);
    assert.equal(result.playerCount,0);
    assert.equal(app.localStorage.getItem(V1),JSON.stringify(state));
  }
});

test('Game projection detects newer V1 state, then verifies explicit preview reconcile',async()=>{
  const app=await boot();
  await seed(app);
  const initial=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(initial.match,true);
  const state=JSON.parse(app.localStorage.getItem(V1));
  state.players[0].name='New saved player';
  state.currentSeason={id:'season5',scores:{one:10}};
  state.futureTopLevel={untouched:true};
  app.localStorage.setItem(V1,JSON.stringify(state));
  const stale=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(stale.match,false,JSON.stringify(stale));
  const updated=await reconcile(app,'new-source');
  assert.equal(updated.collectionParityVerified,true,JSON.stringify(updated));
  const fresh=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(fresh.match,true,JSON.stringify(fresh));
  assert.notEqual(fresh.snapshotFingerprint,initial.snapshotFingerprint);
});

test('Game projection fails closed on changed or corrupted preview player evidence',async()=>{
  const app=await boot();
  await seed(app);
  const old=app.indexedDB.dump(DB);
  const db=app.indexedDB._databases.get(DB);
  Array.from(db._stores.get('players').values())[0].value.name='untrusted tampering';
  const prior=app.indexedDB.dump(DB);
  const proof=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(proof.match,false,JSON.stringify(proof));
  assert.equal(proof.canPromote,false);
  assert.deepEqual(app.indexedDB.dump(DB),prior);
  assert.notDeepEqual(prior,old);
});

function enableRecoveryWal(app) {
  app.ctx.TaskPointsStateRuntimeV2Wal={
    getPendingRows(){return {ok:true,rows:[]}}
  };
}
async function checkpoint(app, scope='full_origin'){
  enableRecoveryWal(app);
  const proof=await app.api.createPreviewRecoveryCheckpoint({scope});
  assert.equal(proof.saved,true,JSON.stringify(proof));
  assert.equal(proof.canAutoRestore,false);
  return proof.checkpointId;
}

test('Game full-origin checkpoint confirms exact snapshot, preferences and preview lineage',async()=>{
  const app=await boot();
  const cp=await checkpoint(app);
  await seed(app);
  const source=app.token();
  const old=app.indexedDB.dump(DB);
  const result=await app.api.inspectPreviewGameCheckpointCoverage(cp);
  assert.equal(result.reason,'checkpoint_game_coverage_verified',JSON.stringify(result));
  assert.equal(result.checkpointVerified,true);
  assert.equal(result.gameBundleVerified,true);
  assert.equal(result.checkpointMatchesPreviewOrigin,true);
  assert.equal(result.checkpointMatchesPreviewGameState,true);
  assert.equal(result.checkpointMatchesCurrentV1,true);
  assert.equal(result.fullOriginLocalStorageCovered,true);
  assert.equal(result.offDeviceBackupVerified,false);
  assert.equal(result.coversImages,false);
  assert.equal(result.coversIndexedDB,false);
  assert.equal(result.canApply,false);
  assert.equal(result.canPromote,false);
  assert.equal(app.token(),source);
  assert.deepEqual(app.indexedDB.dump(DB),old);
});

test('Game checkpoint correctly identifies older source versus reconciled preview and fresh checkpoint',async()=>{
  const app=await boot();
  const cp0=await checkpoint(app);
  await seed(app);
  app.localStorage.setItem(SORT,'created-asc');
  const before=await app.api.inspectPreviewGameCheckpointCoverage(cp0);
  assert.equal(before.checkpointVerified,true);
  assert.equal(before.checkpointMatchesPreviewOrigin,true);
  assert.equal(before.checkpointMatchesPreviewGameState,true);
  assert.equal(before.checkpointMatchesCurrentV1,false);
  assert.equal(before.reason,'checkpoint_older_than_current_origin');
  assert.equal((await reconcile(app,'new-sort')).collectionParityVerified,true);
  const old=await app.api.inspectPreviewGameCheckpointCoverage(cp0);
  assert.equal(old.checkpointMatchesPreviewOrigin,false);
  assert.equal(old.checkpointMatchesPreviewGameState,false);
  assert.equal(old.reason,'checkpoint_game_bundle_differs');
  const cp1=await checkpoint(app);
  const latest=await app.api.inspectPreviewGameCheckpointCoverage(cp1);
  assert.equal(latest.reason,'checkpoint_game_coverage_verified',JSON.stringify(latest));
  assert.equal(latest.canApply,false);
});

test('Game checkpoint distinguishes unchanged Game metadata from unrelated origin drift',async()=>{
  const app=await boot();
  const cp=await checkpoint(app);
  await seed(app);
  app.localStorage.setItem('tp_projects_v1','separate unrelated Project key');
  const report=await app.api.inspectPreviewGameCheckpointCoverage(cp);
  assert.equal(report.checkpointMatchesPreviewOrigin,true);
  assert.equal(report.checkpointMatchesPreviewGameState,true);
  assert.equal(report.checkpointMatchesCurrentV1,false);
  assert.equal(report.reason,'checkpoint_older_than_current_origin');
  assert.equal(report.canApply,false);
});

test('Game recovery rehearsal rejects stale V2 evidence after synthetic same-generation V1 restore',async()=>{
  const app=await boot();
  const cp=await checkpoint(app);
  await seed(app);
  const original=app.token();
  const updated=JSON.parse(app.localStorage.getItem(V1));
  updated.players[0].name='newer';
  app.localStorage.setItem(V1,JSON.stringify(updated));
  await reconcile(app,'edit-before-restore');
  assert.equal((await app.api.inspectPreviewGameCompatibilityProjection()).match,true);
  // Simulate restore of the exact initial V1 snapshot. No V2 writer runs.
  app.localStorage.setItem(V1,JSON.parse(original).find(([k])=>k===V1)[1]);
  const report=await app.api.inspectPreviewGameCheckpointCoverage(cp);
  assert.equal(report.checkpointMatchesCurrentV1,true,JSON.stringify(report));
  assert.equal(report.checkpointMatchesPreviewOrigin,false);
  assert.equal(report.canApply,false);
  const parity=await app.api.inspectPreviewGameCollectionParity();
  assert.equal(parity.match,false);
  assert.equal(app.localStorage.getItem(V1),JSON.parse(original).find(([k])=>k===V1)[1]);
});

test('Game checkpoint partial scope, missing record, tampered payload and rotation fail closed',async()=>{
  const app=await boot();
  const local=await checkpoint(app,'taskpoints_namespace');
  await seed(app);
  const smaller=await app.api.inspectPreviewGameCheckpointCoverage(local);
  assert.equal(smaller.reason,'checkpoint_full_origin_required',JSON.stringify(smaller));
  assert.equal(smaller.canApply,false);
  assert.equal((await app.api.inspectPreviewGameCheckpointCoverage(
    'v1-preview:missing')).reason,'checkpoint_missing');
  const cp=await checkpoint(app);
  const before=await app.api.inspectPreviewGameCheckpointCoverage(cp);
  assert.equal(before.checkpointVerified,true);
  const recovery=app.indexedDB._databases.get('taskpoints_v2_recovery_checkpoints_preview');
  recovery._stores.get('snapshots').get(cp).entries[0][1]='tampered';
  const invalid=await app.api.inspectPreviewGameCheckpointCoverage(cp);
  assert.equal(invalid.reason,'checkpoint_integrity_failed',JSON.stringify(invalid));
  const fresh=await checkpoint(app);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1','new:epoch');
  const rotated=await app.api.inspectPreviewGameCheckpointCoverage(fresh);
  assert.equal(rotated.reason,'checkpoint_generation_mismatch',JSON.stringify(rotated));
  assert.equal(rotated.canApply,false);
});

test('Game checkpoint and projection are preview-host-only and dark-only',async()=>{
  const app=await boot();
  const cp=await checkpoint(app);
  await seed(app);
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await app.api.inspectPreviewGameCheckpointCoverage(cp)).reason,
    'preview_host_required');
  assert.equal((await app.api.inspectPreviewGameCompatibilityProjection()).reason,
    'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await app.api.inspectPreviewGameCheckpointCoverage(cp)).reason,
    'dark_disabled');
  assert.equal((await app.api.inspectPreviewGameCompatibilityProjection()).reason,
    'dark_disabled');
});

test('Game projection catches V1 change during asynchronous digest and declines positive verdict',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'hash-race'},subtle:{
    digest:async(...args)=>{
      const digest=await webcrypto.subtle.digest(...args);
      if(armed){armed=false;app.localStorage.setItem(SORT,'name-desc');}
      return digest;
    }
  }};
  app=await boot({crypto});
  await seed(app);
  armed=true;
  const report=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(report.match,false,JSON.stringify(report));
  assert.equal(app.localStorage.getItem(SORT),'name-desc');
  assert.equal(report.canPromote,false);
});


async function digestGamePreview(value) {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const digest=await webcrypto.subtle.digest('SHA-256',bytes);
  return 'sha256:'+Array.from(new Uint8Array(digest),
    byte=>byte.toString(16).padStart(2,'0')).join('')+':'+bytes.length;
}
async function emulateLegacyGamePreviewWithoutPlayerPresence(app) {
  const db=app.indexedDB._databases.get(DB);
  const bundle=db._stores.get('bundles').get('game-source');
  assert.equal(typeof bundle.playersPresent,'boolean');
  delete bundle.playersPresent;
  const rows=Array.from(db._stores.get('players').values()).sort((a,b)=>a.id-b.id);
  const fingerprint=await digestGamePreview({bundle,rows});
  db._stores.get('meta').get('game-source').bundleFingerprint=fingerprint;
  db._stores.get('receipts').get('game-preview-seed:initial')
    .bundleFingerprint=fingerprint;
}
test('Historical Game seed receipts remain inspectable and upgrade without evidence deletion',async()=>{
  const app=await boot();
  assert.equal((await seed(app)).committed,true);
  await emulateLegacyGamePreviewWithoutPlayerPresence(app);
  const original=app.indexedDB.dump(DB);
  const parity=await app.api.inspectPreviewGameCollectionParity();
  assert.equal(parity.match,true,JSON.stringify(parity));
  assert.equal(parity.canPromote,false);
  const projection=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(projection.match,false);
  assert.equal(projection.reason,'game_preview_player_presence_unsealed');
  const duplicate=await seed(app,'duplicate');
  assert.equal(duplicate.reason,'game_preview_already_verified',JSON.stringify(duplicate));
  assert.deepEqual(app.indexedDB.dump(DB),original);
  const upgraded=await reconcile(app,'seal-player-presence');
  assert.equal(upgraded.reason,'game_preview_reconcile_verified',JSON.stringify(upgraded));
  assert.equal(upgraded.changedPlayers,0);
  assert.equal(upgraded.receiptCount,2);
  const rows=app.indexedDB.dump(DB);
  assert.equal(rows.bundles[0].playersPresent,true);
  assert.deepEqual(rows.receipts.find(x=>x.id==='game-preview-seed:initial'),
    original.receipts[0]);
  assert.equal((await app.api.inspectPreviewGameCompatibilityProjection()).match,true);
});
test('Empty roster upgrades from historical source and preserves presence semantics',async()=>{
  const state=legacy();delete state.players;
  const app=await boot({state});
  await seed(app);
  await emulateLegacyGamePreviewWithoutPlayerPresence(app);
  assert.equal((await app.api.inspectPreviewGameCollectionParity()).match,true);
  assert.equal((await app.api.inspectPreviewGameCompatibilityProjection()).match,false);
  const result=await reconcile(app,'seal-empty-absent');
  assert.equal(result.collectionParityVerified,true,JSON.stringify(result));
  const projection=await app.api.inspectPreviewGameCompatibilityProjection();
  assert.equal(projection.match,true,JSON.stringify(projection));
  assert.equal(projection.playersPresent,false);
  assert.equal(app.indexedDB.dump(DB).players.length,0);
  assert.equal(Object.prototype.hasOwnProperty.call(
    JSON.parse(app.localStorage.getItem(V1)),'players'),false);
});
