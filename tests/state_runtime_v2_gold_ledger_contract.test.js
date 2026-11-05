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
const DB='taskpoints_state_v2',DARK='taskpoints_state_v2_dark_mode_v1';
const KEY='taskpoints_v1';
const rows=()=>[
  {id:'gold:opening:A',type:'opening_balance',playerId:'A',amount:50,
    balanceAfter:50,dateKey:'2026-09-03',unexpected:{keep:'exactly'}},
  {id:'gold:theft:B:A',type:'theft',playerId:'B',counterpartyId:'A',
    amount:7,balanceAfter:57,details:{pair:['B','A']}}
];
const economy=()=>({version:1,launchDateKey:'2026-09-03',
  settledMatchupKeys:['old-win'],ignoredChampionKeys:[],
  customMetadata:{neverDrop:true}});
const state=()=>({
  habits:[{id:'h1',name:'Walk',doneKeys:[],failedKeys:[],iceKeys:[]}],
  completions:[],tasks:[{id:'task1',title:'Retain'}],
  goldLedger:rows(),goldEconomy:economy(),
  matchups:[],gameHistory:[],seasonHistory:[]
});
async function boot(data=state(),options={}){
  const indexedDB=options.indexedDB||new FakeIndexedDB();
  const localStorage=options.localStorage||new FakeStorage({
    [DARK]:'1',[KEY]:JSON.stringify(data)
  });
  let n=0;
  const core={
    STORAGE_KEY:KEY,
    parseTaskPointsStorageJson(raw){return JSON.parse(raw)},
    readPendingHabitDeltas(){return []},
    applyPendingHabitDeltas(){},
    readPendingTaskMutations(){return {malformed:false,record:{
      tasks:[],completionUpserts:[],completionDeletes:[]}}},
    readTaskPointsStoredState(){return JSON.parse(localStorage.getItem(KEY))},
    writePendingHabitDelta(delta){return {...delta}},
    habitCompletionId(a,b){return 'habit:'+a+':'+b}
  };
  const crypto=options.crypto||{subtle:webcrypto.subtle,
    randomUUID(){return 'gold-'+ ++n}};
  const ctx={indexedDB,localStorage,structuredClone,TextEncoder,crypto,
    location:{hostname:'localhost'},JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,Promise,TaskPointsCore:core,
    document:{readyState:'loading',addEventListener(){}},
    console:{log(){},warn(){},error(){}}};
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.runInNewContext(script,ctx,{filename:'state_runtime_v2.js'});
  const api=ctx.TaskPointsStateRuntimeV2;
  await api.seedFromLegacy();
  return {api,ctx,indexedDB,localStorage,
    token(){return JSON.stringify(Array.from({length:localStorage.length},
      (_,i)=>localStorage.key(i)).sort().map(
      key=>[key,localStorage.getItem(key)]))},
    snapshot(){return localStorage.getItem(KEY)},
    put(next){localStorage.setItem(KEY,JSON.stringify(next))}
  };
}
const seed=app=>app.api.rehearsePreviewGoldLedgerSeed(app.token(),'initial');

test('V6 isolates ordered Gold rows with an atomic receipt; never writes V1 or changes existing pilot records',async()=>{
  const app=await boot();
  const prior=app.indexedDB.dump(DB),v1=app.snapshot(),origin=app.token();
  const result=await seed(app);
  assert.equal(result.reason,'gold_preview_seed_verified',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.goldMigrated,false);
  assert.equal(result.canPromote,false);
  const db=await app.api.open();
  assert.equal(db.version,6);
  assert.equal(db.objectStoreNames.contains('goldLedger'),true);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.goldLedger.map(x=>x.value),rows());
  assert.deepEqual(after.goldLedger.map(x=>x.id),['gold-row:0','gold-row:1']);
  assert.deepEqual(after.habits,prior.habits);
  assert.deepEqual(after.completions,prior.completions);
  assert.deepEqual(after.tasks,prior.tasks);
  assert.deepEqual(after.projects,prior.projects);
  assert.deepEqual(after.todayDays,prior.todayDays);
  assert.deepEqual(after.meta.find(x=>x.id==='gold-preview').metadata,economy());
  assert.equal(after.mutations.some(x=>x.id==='gold-preview-seed:initial'),true);
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).match,true);
  assert.equal(app.token(),origin);
  assert.equal(app.snapshot(),v1);
});

test('Gold preview refuses to overwrite a prior seal, including after reload',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  const again=await app.api.rehearsePreviewGoldLedgerSeed(app.token(),'other');
  assert.equal(again.reason,'gold_preview_existing_evidence_preserved',JSON.stringify(again));
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const reload=await boot(undefined,{indexedDB:app.indexedDB,
    localStorage:app.localStorage});
  assert.equal((await reload.api.inspectPreviewGoldLedgerParity()).match,true);
  assert.equal((await reload.api.rehearsePreviewGoldLedgerSeed(
    reload.token(),'reload')).reason,'gold_preview_existing_evidence_preserved');
});

test('Gold preview distinguishes absent, present-empty, and partially lost metadata',async()=>{
  const absent=await boot({habits:[],completions:[]});
  const result=await seed(absent);
  assert.equal(result.collectionParityVerified,true,JSON.stringify(result));
  assert.equal(absent.indexedDB.dump(DB).meta.find(x=>x.id==='gold-preview').present,false);
  assert.equal(absent.indexedDB.dump(DB).meta.find(x=>x.id==='gold-preview').metaPresent,false);
  const present=await boot({habits:[],completions:[],goldLedger:[],
    goldEconomy:{...economy(),settledMatchupKeys:[]}});
  assert.equal((await seed(present)).collectionParityVerified,true);
  assert.equal(present.indexedDB.dump(DB).meta.find(x=>x.id==='gold-preview').present,true);
  const broken=await boot({habits:[],completions:[],
    matchups:[{goldOutcome:{settled:true}}]});
  const rejected=await seed(broken);
  assert.equal(rejected.reason,'gold_source_preflight_required');
  assert.equal(rejected.prerequisiteReason,'gold_settlement_missing_ledger_or_metadata');
  assert.equal(broken.indexedDB.dump(DB).goldLedger.length,0);
});

test('malformed Gold ledger, duplicate IDs, and invalid economy metadata all refuse seeding',async()=>{
  for(const change of [
    {goldLedger:{bad:true}},
    {goldLedger:[rows()[0],rows()[0]]},
    {goldLedger:[{id:9,amount:3}]},
    {goldEconomy:{version:'invalid'}},
    {goldLedger:null}
  ]){
    const app=await boot({...state(),...change}),before=app.indexedDB.dump(DB);
    const outcome=await seed(app);
    assert.equal(outcome.reason,'gold_source_preflight_required',JSON.stringify(outcome));
    assert.deepEqual(app.indexedDB.dump(DB),before);
  }
});

test('Gold parity refuses stale V1 Gold edits but leaves all sealed V2 history intact',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  const revised=state();revised.goldLedger[1].amount=999;
  app.put(revised);
  const result=await app.api.inspectPreviewGoldLedgerParity();
  assert.equal(result.match,false);
  assert.equal(result.reason,'gold_preview_source_stale',JSON.stringify(result));
  assert.equal((await app.api.rehearsePreviewGoldLedgerSeed(
    app.token(),'stale')).committed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold parity rejects tampered rows, missing receipts and changed metadata',async()=>{
  const app=await boot();await seed(app);
  const db=app.indexedDB._databases.get(DB);
  const ledger=db._stores.get('goldLedger');
  const first=ledger.get('gold-row:0');
  ledger.set('gold-row:0',{...first,value:{...first.value,amount:777}});
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).reason,
    'gold_preview_record_mismatch');
  ledger.set('gold-row:0',first);
  const evidence=db._stores.get('meta').get('gold-preview');
  db._stores.get('meta').set('gold-preview',{...evidence,
    metadata:{version:1,settledMatchupKeys:[]}});
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).reason,
    'gold_preview_source_stale');
  db._stores.get('meta').set('gold-preview',evidence);
  db._stores.get('mutations').delete(evidence.receiptId);
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).reason,
    'gold_preview_receipt_missing_or_invalid');
});

test('Gold preview seed aborts every write atomically on quota failure',async()=>{
  const app=await boot(),before=app.indexedDB.dump(DB);
  app.indexedDB.failNext({store:'goldLedger',operation:'add',
    error:new Error('QuotaExceededError')});
  const result=await seed(app);
  assert.equal(result.committed,false,JSON.stringify(result));
  assert.equal(result.confirmedDurable,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('V1 Gold write during asynchronous SHA fingerprint refuses the stale seed',async()=>{
  let app,armed=false;
  const crypto={randomUUID(){return 'gold-race'},subtle:{
    digest:async(...args)=>{
      const hash=await webcrypto.subtle.digest(...args);
      if(armed){
        armed=false;
        const changed=state();changed.goldLedger[0].amount=1000;
        app.put(changed);
      }
      return hash;
    }
  }};
  app=await boot(state(),{crypto});
  const before=app.indexedDB.dump(DB);
  armed=true;
  const result=await seed(app);
  assert.equal(result.reason,'gold_source_preflight_required',JSON.stringify(result));
  assert.equal(result.prerequisiteReason,'gold_source_changed_during_hash');
  assert.equal(armed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold seed refuses preview-off, production-host, and stale full-origin tokens',async()=>{
  const app=await boot(),token=app.token();
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await seed(app)).reason,'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await seed(app)).reason,'dark_disabled');
  app.localStorage.setItem(DARK,'1');
  app.localStorage.setItem('tp_notes_v1','unrelated old-tab update');
  assert.equal((await app.api.rehearsePreviewGoldLedgerSeed(
    token,'stale')).reason,'full_origin_changed');
});

test('V5 mirror upgrades add Gold store without deleting any preexisting pilot or Projects rows',async()=>{
  const app=await boot();
  const db=app.indexedDB._databases.get(DB);
  const before=app.indexedDB.dump(DB);
  db.version=5;
  db._stores.delete('goldLedger');
  db._indexes.delete('goldLedger');
  const reload=await boot(undefined,{indexedDB:app.indexedDB,
    localStorage:app.localStorage});
  assert.equal((await reload.api.open()).version,6);
  const after=app.indexedDB.dump(DB);
  for(const key of ['habits','completions','tasks','projects','todayDays','mutations','meta'])
    assert.deepEqual(after[key],before[key],key);
  assert.equal(after.goldLedger.length,0);
});


test('Gold preview refuses mismatched ledger/economy presence and recorded settlements without rows',async()=>{
  const missingEconomy=state();delete missingEconomy.goldEconomy;
  const missingLedger=state();delete missingLedger.goldLedger;
  const lostHistory=state();lostHistory.goldLedger=[];
  for(const [candidate,expected] of [
    [missingEconomy,'gold_ledger_economy_presence_mismatch'],
    [missingLedger,'gold_ledger_economy_presence_mismatch'],
    [lostHistory,'gold_settlements_without_ledger_rows']
  ]){
    const app=await boot(candidate),before=app.indexedDB.dump(DB);
    const result=await seed(app);
    assert.equal(result.reason,'gold_source_preflight_required',JSON.stringify(result));
    assert.equal(result.prerequisiteReason,expected);
    assert.deepEqual(app.indexedDB.dump(DB),before);
  }
});

test('orphaned Gold receipt without any rows is never silently replaced with a fresh seed',async()=>{
  const app=await boot();
  const db=app.indexedDB._databases.get(DB);
  db._stores.get('mutations').set('gold-preview-seed:old-tab',{
    id:'gold-preview-seed:old-tab',type:'gold-preview-seed',
    sourceFingerprint:'orphaned-snapshot'
  });
  const before=app.indexedDB.dump(DB);
  const result=await seed(app);
  assert.equal(result.reason,'gold_preview_existing_evidence_preserved',JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});


const reconcile=(app,id='new-gold-action',options={})=>
  app.api.rehearsePreviewGoldLedgerReconcile(app.token(),id,options);

test('Gold reconciliation appends transactions and seals an independently verifiable receipt chain',async()=>{
  const app=await boot();await seed(app);
  const prior=app.indexedDB.dump(DB),snapshot=state();
  snapshot.goldLedger.push({id:'gold:margin:B',type:'matchup_margin',
    playerId:'B',opponentId:'A',amount:4,balanceAfter:61,
    details:{nested:['retain',true]}});
  snapshot.goldEconomy.settledMatchupKeys.push('new-win');
  app.put(snapshot);
  const origin=app.token(),v1=app.snapshot();
  const result=await reconcile(app);
  assert.equal(result.reason,'gold_preview_reconciled',JSON.stringify(result));
  assert.equal(result.committed,true);
  assert.equal(result.confirmedDurable,true);
  assert.equal(result.collectionParityVerified,true);
  assert.equal(result.rowCount,3);
  assert.equal(result.addedRows,1);
  assert.equal(result.correctedRows,0);
  assert.equal(result.goldMigrated,false);
  assert.equal(result.canPromote,false);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.goldLedger.map(row=>row.value),snapshot.goldLedger);
  assert.deepEqual(after.goldLedger.slice(0,2),prior.goldLedger);
  assert.deepEqual(after.tasks,prior.tasks);
  assert.deepEqual(after.completions,prior.completions);
  assert.equal(after.meta.find(row=>row.id==='gold-preview').metadata
    .settledMatchupKeys.includes('new-win'),true);
  const receipt=after.mutations.find(row=>row.id==='gold-preview-reconcile:new-gold-action');
  assert.equal(receipt.type,'gold-preview-reconcile');
  assert.equal(receipt.priorReceiptId,'gold-preview-seed:initial');
  assert.equal(receipt.addedRows,1);
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).match,true);
  assert.equal(app.token(),origin);
  assert.equal(app.snapshot(),v1);
});

test('Gold reconciliation supports multiple append generations and survives full runtime recreation',async()=>{
  const app=await boot();await seed(app);
  const a=state();a.goldLedger.push({id:'gold:three',amount:3,playerId:'A'});
  app.put(a);
  assert.equal((await reconcile(app,'step-one')).collectionParityVerified,true);
  const b=JSON.parse(JSON.stringify(a));
  b.goldLedger.push({id:'gold:four',amount:4,playerId:'A'});
  b.goldEconomy.futureRule={effective:true};
  app.put(b);
  const second=await reconcile(app,'step-two');
  assert.equal(second.collectionParityVerified,true,JSON.stringify(second));
  const stored=app.indexedDB.dump(DB);
  const secondReceipt=stored.mutations.find(row=>row.id==='gold-preview-reconcile:step-two');
  assert.equal(secondReceipt.priorReceiptId,'gold-preview-reconcile:step-one');
  const reloaded=await boot(undefined,{indexedDB:app.indexedDB,
    localStorage:app.localStorage});
  assert.equal((await reloaded.api.inspectPreviewGoldLedgerParity()).match,true);
  const before=app.indexedDB.dump(DB);
  const noop=await reconcile(reloaded,'not-written');
  assert.equal(noop.reason,'gold_preview_already_current',JSON.stringify(noop));
  assert.equal(noop.committed,false);
  assert.equal(noop.confirmedDurable,true);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold reconciliation performs metadata-only changes without rewriting any ledger rows',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  const s=state();s.goldEconomy.newSeasonBonus={amount:30,reason:'retain'};
  app.put(s);
  const result=await reconcile(app,'metadata-change');
  assert.equal(result.reason,'gold_preview_reconciled',JSON.stringify(result));
  assert.equal(result.changedRows,0);
  assert.equal(result.addedRows,0);
  const after=app.indexedDB.dump(DB);
  assert.deepEqual(after.goldLedger,before.goldLedger);
  assert.equal(after.meta.find(x=>x.id==='gold-preview')
    .metadata.newSeasonBonus.amount,30);
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).match,true);
});

test('Gold reconciliation never overwrites old amounts without correction opt-in',async()=>{
  const app=await boot();await seed(app);
  const before=app.indexedDB.dump(DB);
  const edited=state();edited.goldLedger[1].amount=11;
  edited.goldLedger[1].details.futureExplanation='legitimate adjustment';
  app.put(edited);
  const denied=await reconcile(app,'without-consent');
  assert.equal(denied.reason,'gold_preview_historical_correction_requires_optin',
    JSON.stringify(denied));
  assert.equal(denied.changedHistoricalRows,1);
  assert.deepEqual(app.indexedDB.dump(DB),before);
  const accepted=await reconcile(app,'with-consent',{allowHistoricalCorrections:true});
  assert.equal(accepted.reason,'gold_preview_reconciled',JSON.stringify(accepted));
  assert.equal(accepted.correctedRows,1);
  assert.equal(accepted.addedRows,0);
  assert.deepEqual(app.indexedDB.dump(DB).goldLedger[1].value,edited.goldLedger[1]);
  assert.deepEqual(app.indexedDB.dump(DB).goldLedger[0],before.goldLedger[0]);
  assert.equal((await app.api.inspectPreviewGoldLedgerParity()).match,true);
});

test('Gold reconciliation blocks deletion, reordering and replacement even with correction opt-in',async()=>{
  for(const make of [
    s=>{s.goldLedger.pop();},
    s=>{s.goldLedger.reverse();},
    s=>{s.goldLedger[0]={...s.goldLedger[0],id:'fabricated-replacement'};}
  ]){
    const app=await boot();await seed(app);
    const prior=app.indexedDB.dump(DB),edited=state();
    make(edited);app.put(edited);
    const result=await reconcile(app,'refuse-loss',{allowHistoricalCorrections:true});
    assert.equal(result.reason,edited.goldLedger.length<2
      ?'gold_preview_history_deletion_requires_review'
      :'gold_preview_history_reorder_or_replacement',JSON.stringify(result));
    assert.deepEqual(app.indexedDB.dump(DB),prior);
  }
});

test('Gold reconciliation detects a tampered stored row before it can become the prior revision',async()=>{
  const app=await boot();await seed(app);
  const db=app.indexedDB._databases.get(DB);
  const rows=db._stores.get('goldLedger'),row=rows.get('gold-row:1');
  rows.set('gold-row:1',{...row,value:{...row.value,amount:900}});
  const before=app.indexedDB.dump(DB),updated=state();
  updated.goldLedger.push({id:'append-after-tamper',amount:9,playerId:'B'});
  app.put(updated);
  const result=await reconcile(app,'tampered');
  assert.equal(result.reason,'gold_preview_existing_parity_mismatch',
    JSON.stringify(result));
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold reconciliation rejects tampered metadata and lost or disconnected receipts',async()=>{
  for(const disturb of [
    db=>db._stores.get('meta').set('gold-preview',{
      ...db._stores.get('meta').get('gold-preview'),
      metadata:{...economy(),customMetadata:{neverDrop:false}}
    }),
    db=>db._stores.get('mutations').delete('gold-preview-seed:initial'),
    db=>db._stores.get('mutations').set('gold-preview-seed:orphan',{
      id:'gold-preview-seed:orphan',type:'gold-preview-seed',
      sourceFingerprint:'other-snapshot'
    })
  ]){
    const app=await boot();await seed(app);
    disturb(app.indexedDB._databases.get(DB));
    const before=app.indexedDB.dump(DB),edited=state();
    edited.goldLedger.push({id:'new-one',amount:1,playerId:'B'});
    app.put(edited);
    const result=await reconcile(app,'suspicious');
    assert.ok([
      'gold_preview_existing_parity_mismatch',
      'gold_preview_receipt_missing_or_invalid',
      'gold_preview_orphan_receipts_preserved'
    ].includes(result.reason),JSON.stringify(result));
    assert.deepEqual(app.indexedDB.dump(DB),before);
  }
});

test('Gold reconciliation refuses reused action IDs for a different source revision',async()=>{
  const app=await boot();await seed(app);
  const next=state();next.goldLedger.push({id:'third',amount:3,playerId:'A'});
  app.put(next);
  assert.equal((await reconcile(app,'do-once')).committed,true);
  const later=JSON.parse(JSON.stringify(next));
  later.goldLedger.push({id:'fourth',amount:4,playerId:'A'});
  app.put(later);
  const before=app.indexedDB.dump(DB);
  const repeat=await reconcile(app,'do-once');
  assert.equal(repeat.reason,'gold_preview_action_id_already_used');
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold reconciliation makes appended rows, metadata and receipt one abortable transaction',async()=>{
  for(const failedStore of ['goldLedger','mutations','meta']){
    const app=await boot();await seed(app);
    const next=state();next.goldLedger.push({id:'third',amount:3,playerId:'A'});
    app.put(next);
    const before=app.indexedDB.dump(DB);
    app.indexedDB.failNext({
      store:failedStore,operation:failedStore==='goldLedger'?'put':
        failedStore==='mutations'?'add':'put',
      error:new Error('QuotaExceededError')
    });
    const result=await reconcile(app,'quota-'+failedStore);
    assert.equal(result.committed,false,JSON.stringify(result));
    assert.equal(result.confirmedDurable,false);
    assert.deepEqual(app.indexedDB.dump(DB),before,failedStore);
  }
});

test('Concurrent V2 row insertion under reconciliation transaction preserves foreign data',async()=>{
  const app=await boot();await seed(app);
  const updated=state();updated.goldLedger.push({id:'third',amount:3,playerId:'A'});
  app.put(updated);
  const db=app.indexedDB._databases.get(DB);
  const original=db.transaction.bind(db);
  let raced=false;
  db.transaction=(stores,mode)=>{
    if(!raced&&mode==='readwrite'&&Array.isArray(stores)
      &&stores.includes('goldLedger')){
      raced=true;
      db._stores.get('goldLedger').set('stranded-record',{
        id:'stranded-record',legacyIndex:22,
        value:{id:'unknown-v2-only',amount:90}
      });
    }
    return original(stores,mode);
  };
  const result=await reconcile(app,'v2-race');
  assert.equal(raced,true);
  assert.equal(result.reason,'gold_preview_concurrent_change',JSON.stringify(result));
  const after=app.indexedDB.dump(DB);
  assert.equal(after.goldLedger.some(row=>row.id==='stranded-record'),true);
  assert.equal(after.mutations.some(row=>row.id==='gold-preview-reconcile:v2-race'),false);
});

test('Gold reconciliation refuses a new V1 edit while SHA verification is in flight',async()=>{
  let app,armed=false,digests=0;
  const crypto={randomUUID(){return 'reconcile-source-race'},subtle:{
    digest:async(...args)=>{
      const output=await webcrypto.subtle.digest(...args);
      if(armed&&++digests===2){
        armed=false;
        const changed=JSON.parse(app.snapshot());
        changed.goldLedger[0].amount=1000;
        app.put(changed);
      }
      return output;
    }
  }};
  app=await boot(state(),{crypto});await seed(app);
  const next=state();next.goldLedger.push({id:'third',amount:3,playerId:'A'});
  app.put(next);
  const before=app.indexedDB.dump(DB);
  armed=true;
  const result=await reconcile(app,'v1-race');
  assert.equal(result.reason,'gold_source_changed_during_reconcile',
    JSON.stringify(result));
  assert.equal(armed,false);
  assert.deepEqual(app.indexedDB.dump(DB),before);
});

test('Gold reconciliation refuses stale full-origin tokens, production host and dark-off mode',async()=>{
  const app=await boot();await seed(app);
  const token=app.token(),next=state();
  next.goldLedger.push({id:'third',amount:3,playerId:'A'});
  app.put(next);
  assert.equal((await app.api.rehearsePreviewGoldLedgerReconcile(
    token,'stale')).reason,'full_origin_changed');
  app.ctx.location.hostname='taskpoints.pages.dev';
  assert.equal((await reconcile(app,'prod')).reason,'preview_host_required');
  app.ctx.location.hostname='localhost';
  app.localStorage.removeItem(DARK);
  assert.equal((await reconcile(app,'off')).reason,'dark_disabled');
});
