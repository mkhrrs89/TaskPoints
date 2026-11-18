'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const code=fs.readFileSync(path.join(__dirname,'transfer.js'),'utf8');
let browser; const servers=[], urls=[];
before(async()=>{
  for(let i=0;i<3;i++){
    const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
      r.end('<!doctype html><title>Synthetic transfer rehearsal — no application</title>');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r)); servers.push(server);
    urls.push('http://127.0.0.1:'+server.address().port);
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
  console.log('Browser:',browser.version());
});
after(async()=>{await browser?.close();for(const s of servers)await new Promise(r=>s.close(r));});
async function page(ctx,index){const p=await ctx.newPage();await p.goto(urls[index]);await p.addScriptTag({content:code});return p;}
async function fixture(t){
  const ctx=await browser.newContext(); t.after(()=>ctx.close());
  const source=await page(ctx,0),target=await page(ctx,1);
  await source.evaluate(async()=>{
    const snapshot={tasks:[{id:'t1',title:'Original',unknownTask:{future:true}}],habits:[],completions:[],
      unknownRoot:{keep:['everything',null]},notes:'Saved notes',players:[{id:'p1',imageId:'portrait'}]};
    const local={
      taskpoints_v1:JSON.stringify(snapshot),
      taskpoints_pending_task_mutations_v1:JSON.stringify({schemaVersion:1,tasks:[{id:'t1',title:'Pending edit'}],completionUpserts:[{id:'c1',taskId:'t1',points:7}],completionDeletes:['deleted-c']}),
      taskpoints_pending_habit_deltas_v1:'[{"habitId":"h1","dayKey":"2026-11-17","unknown":true}]',
      taskpoints_pending_inbox_state_v1:'{"messages":[{"id":"m1"}]}',
      taskpoints_pending_flex_completions_v1:'[{"id":"f1"}]',
      taskpoints_pending_flex_order_v1:'["f1"]',
      taskpoints_v2_pending_mutations_v1:'{"preservedUninterpreted":true}',
      taskpoints_notes_v1:'Newer unsynchronized notes',taskpoints_notes_dirty_v1:'1',taskpoints_notes_authoritative_v1:'1',
      tp_projects_v1:'[{"id":"project","unknown":"retain"}]',
      taskpoints_today_view_v1:'{"days":{"2026-11-17":[]},"extra":null}',
      taskpoints_backup_slot_1:'{"previous":"backup"}',taskpoints_quarantine_v1:'{malformed but valuable raw evidence',
      taskpoints_recovery_hold_v1:'1',taskpoints_state_v2_generation_v1:'old-generation-evidence',
      taskpoints_state_v2_dark_mode_v1:'0',unknown_future_key:'\u0000\ud800 exact text',empty:'',
    };
    for(const [k,v] of Object.entries(local))localStorage.setItem(k,v);
    localStorage.setItem('__proto__','literal key');
    sessionStorage.setItem('unknown_session_marker','preserve but do not activate');
    sessionStorage.setItem('recovery_attempt','unfinished old attempt');
    async function db(name,version,setup,fill){
      const database=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);
        r.onupgradeneeded=()=>setup(r.result);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const tx=database.transaction(Array.from(database.objectStoreNames),'readwrite');fill(tx);
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});database.close();
    }
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    await db('taskpoints',1,d=>d.createObjectStore('images'),tx=>{
      tx.objectStore('images').put(new Blob([png],{type:'image/png'}),'portrait');
      tx.objectStore('images').put(new Blob([new Uint8Array([0,255,7,9])],{type:'application/octet-stream'}),'orphan');
    });
    for(const name of ['taskpoints_shadow_state_v1','taskpoints_verified_secondary_v1','unknown_recovery_vault'])
      await db(name,2,d=>{const s=d.createObjectStore('snapshots',{keyPath:'id'});s.createIndex('byKind','kind',{unique:false});},tx=>{
        tx.objectStore('snapshots').put({id:'backup',kind:'recovery',raw:'exact backup bytes',unknown:{nested:['keep']}});
      });
    await db('unknown_future_database',3,d=>{
      const s=d.createObjectStore('records');s.createIndex('tags','tags',{multiEntry:true});
      d.createObjectStore('compound',{keyPath:['a','b']});
      d.createObjectStore('empty');
    },tx=>{
      const shared={label:'same object'},cycle={};cycle.self=cycle;
      const sparse=new Array(4);sparse[2]=undefined;
      const value={sharedA:shared,sharedB:shared,cycle,sparse,missing:undefined,big:12345678901234567890n,
        negativeZero:-0,nan:NaN,infinity:Infinity,date:new Date('2020-01-01'),regexp:/a+/gi,
        map:new Map([[shared,new Set([1,'two'])]]),tags:['a','b'],
        buffer:new Uint8Array([1,2,255,4]).buffer};
      value.view=new Uint8Array(value.buffer,1,2);value.dataView=new DataView(value.buffer,1,2);
      value.file=new File(['file bytes'],'old.bin',{type:'application/octet-stream',lastModified:12345});
      Object.defineProperty(value,'__proto__',{value:{literal:true},enumerable:true});
      tx.objectStore('records').put(value,['compound',new Date('2020-02-01')]);
      tx.objectStore('records').put('binary key',new Uint8Array([9,8]).buffer);
      tx.objectStore('compound').put({a:'A',b:2,unknown:3});
    });
  });
  const original=await source.evaluate(()=>TransferRehearsal.exportPackage());
  return {ctx,source,target,original};
}
const inspect=p=>p.evaluate(()=>TransferRehearsal.inspect());
const restore=(p,text)=>p.evaluate(text=>TransferRehearsal.restore(text),text);
const capture=p=>p.evaluate(()=>TransferRehearsal.capture(true));
async function reopen(ctx,p,index){await p.close();return page(ctx,index);}
function data(text){return JSON.parse(JSON.parse(text).body).data;}
function durable(d){return {local:d.local,databases:d.databases};}

test('lossless cross-origin round-trip includes all raw keys, every DB/store/record, image bytes, unknown types and recovery evidence',async t=>{
  const {source,target,original}=await fixture(t);
  const before=await source.evaluate(()=>TransferRehearsal.capture());
  assert.deepEqual(await restore(target,original),{verified:true,applicationEnabled:false});
  assert.deepEqual(durable(await capture(target)),durable(data(original)));
  assert.deepEqual(await source.evaluate(()=>TransferRehearsal.capture()),before);
  const status=await inspect(target);assert.equal(status.verified,true);assert.equal(status.original,original);
  assert.deepEqual(status.sessionArchive,data(original).session);
  assert.equal(await target.evaluate(()=>sessionStorage.length),0);
});

test('close and reopen destination verifies restored bytes and exact original package',async t=>{
  const f=await fixture(t);await restore(f.target,f.original);
  const target=await reopen(f.ctx,f.target,1);
  const state=await inspect(target);assert.equal(state.verified,true);assert.equal(state.original,f.original);
  assert.deepEqual(durable(await capture(target)),durable(data(f.original)));
});

test('actual tab closure after staging leaves incomplete restore; restart retries same immutable package',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(text=>{window.paused=false;window.work=TransferRehearsal.restore(text,async phase=>{
    if(phase==='staged'){window.paused=true;await new Promise(()=>{});}
  });},f.original);
  await f.target.waitForFunction(()=>window.paused);const target=await reopen(f.ctx,f.target,1);
  const state=await inspect(target);assert.equal(state.verified,false);assert.equal(state.original,f.original);
  await restore(target,f.original);assert.equal((await inspect(target)).verified,true);
});

test('actual tab closure after first database commit resumes exact partial contents without dropping journals',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(text=>{window.paused=false;window.work=TransferRehearsal.restore(text,async phase=>{
    if(phase.startsWith('database:')){window.paused=true;await new Promise(()=>{});}
  });},f.original);
  await f.target.waitForFunction(()=>window.paused);const target=await reopen(f.ctx,f.target,1);
  assert.equal((await inspect(target)).verified,false);
  await restore(target,f.original);assert.deepEqual(durable(await capture(target)),durable(data(f.original)));
});

test('quota failure preserves staged original and refuses readiness; retry after restart succeeds',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(()=>{const put=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
    if(this===localStorage&&k==='taskpoints_v1')throw new DOMException('forced quota','QuotaExceededError');
    return put.call(this,k,v);
  };});
  await assert.rejects(restore(f.target,f.original),/forced quota/);
  assert.equal((await inspect(f.target)).verified,false);assert.equal((await inspect(f.target)).original,f.original);
  const target=await reopen(f.ctx,f.target,1);await restore(target,f.original);
  assert.equal((await inspect(target)).verified,true);
});

test('aborted IndexedDB import transaction is never verified; schema-only partial database can be retried',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(()=>{const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);
      if(this.name==='taskpoints'&&args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};});
  await assert.rejects(restore(f.target,f.original),/abort|transaction/i);
  assert.equal((await inspect(f.target)).verified,false);
  const target=await reopen(f.ctx,f.target,1);await restore(target,f.original);
  assert.equal((await inspect(target)).verified,true);
});

test('truncated or corrupted package is rejected before any destination writes',async t=>{
  const f=await fixture(t);
  for(const bad of [f.original.slice(0,-3),f.original.replace('Original','Tampered')])
    await assert.rejects(restore(f.target,bad));
  assert.deepEqual(await capture(f.target),{local:[],session:[],databases:[]});
});

test('missing record or changed image after import invalidates readiness on restart',async t=>{
  const f=await fixture(t);await restore(f.target,f.original);
  await f.target.evaluate(async()=>{
    const db=await new Promise(r=>{const q=indexedDB.open('taskpoints');q.onsuccess=()=>r(q.result);});
    const tx=db.transaction('images','readwrite');tx.objectStore('images').put(new Blob(['corrupted']),'portrait');
    await new Promise(r=>tx.oncomplete=r);db.close();
  });
  const target=await reopen(f.ctx,f.target,1);assert.equal((await inspect(target)).verified,false);
  await assert.rejects(restore(target,f.original),/destination_record_conflict/);
  assert.equal((await inspect(target)).original,f.original);
});

test('nonblank destinations and conflicting partial data are preserved rather than overwritten',async t=>{
  const f=await fixture(t);await f.target.evaluate(()=>localStorage.setItem('existing','keep'));
  await assert.rejects(restore(f.target,f.original),/destination_not_blank/);
  assert.equal(await f.target.evaluate(()=>localStorage.getItem('existing')),'keep');
  const clean=await page(f.ctx,2);
  await assert.rejects(clean.evaluate(text=>TransferRehearsal.restore(text,phase=>{
    if(phase==='staged')throw Error('interrupt');}),f.original),/interrupt/);
  await clean.evaluate(()=>localStorage.setItem('unexpected','preserve'));
  await assert.rejects(restore(clean,f.original),/destination_conflict/);
  assert.equal(await clean.evaluate(()=>localStorage.getItem('unexpected')),'preserve');
});

test('original package cannot be replaced on resume; new-package rollback preserves latest edit and original archive',async t=>{
  const f=await fixture(t);await restore(f.target,f.original);
  await f.target.evaluate(()=>{const s=JSON.parse(localStorage.getItem('taskpoints_v1'));
    s.tasks[0].title='Latest isolated edit';localStorage.setItem('taskpoints_v1',JSON.stringify(s));});
  const latest=await f.target.evaluate(()=>TransferRehearsal.exportWorkingCopy());
  assert.notEqual(latest,f.original);await assert.rejects(restore(f.target,latest),/different_package_refused/);
  const rollback=await page(f.ctx,2);await restore(rollback,latest);
  assert.equal((await inspect(rollback)).verified,true);
  assert.deepEqual(durable(await capture(rollback)),durable(data(latest)));
  assert.equal(await rollback.evaluate(()=>JSON.parse(localStorage.getItem('taskpoints_v1')).tasks[0].title),'Latest isolated edit');
  assert.equal((await inspect(f.target)).original,f.original);
  assert.equal(await f.source.evaluate(()=>TransferRehearsal.exportPackage()),f.original);
});

test('unknown auto-increment stores refuse export instead of guessing deleted-key generator state',async t=>{
  const f=await fixture(t);await f.source.evaluate(async()=>{
    const db=await new Promise(r=>{const q=indexedDB.open('unsupported-generator',1);
      q.onupgradeneeded=()=>q.result.createObjectStore('rows',{autoIncrement:true});q.onsuccess=()=>r(q.result);});db.close();
  });
  await assert.rejects(f.source.evaluate(()=>TransferRehearsal.exportPackage()),/unsupported_auto_increment_generator/);
  assert.deepEqual(await capture(f.target),{local:[],session:[],databases:[]});
});

test('unsupported stored object type refuses export; catalog failure cannot masquerade as empty storage',async t=>{
  const f=await fixture(t);
  await f.source.evaluate(async()=>{
    const db=await new Promise(r=>{const q=indexedDB.open('taskpoints');q.onsuccess=()=>r(q.result);});
    const tx=db.transaction('images','readwrite');tx.objectStore('images').put(new Error('unhandled type'),'error-evidence');
    await new Promise(r=>tx.oncomplete=r);db.close();
  });
  await assert.rejects(f.source.evaluate(()=>TransferRehearsal.exportPackage()),/unsupported_object_type/);
  await f.source.evaluate(()=>{indexedDB.databases=async()=>{throw Error('catalog denied');};});
  await assert.rejects(f.source.evaluate(()=>TransferRehearsal.exportPackage()),/catalog denied/);
});

test('late old-origin writes and resets cannot change the restored isolated destination',async t=>{
  const f=await fixture(t);await restore(f.target,f.original);
  await f.source.evaluate(()=>{localStorage.setItem('taskpoints_v1','late legacy edit');localStorage.removeItem('tp_projects_v1');});
  assert.equal((await inspect(f.target)).verified,true);
  assert.deepEqual(durable(await capture(f.target)),durable(data(f.original)));
});

test('disk package and destination storage survive full destination browser shutdown/restart',async t=>{
  const f=await fixture(t);
  const os=require('node:os');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tp-transfer-restart-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const packageFile=path.join(folder,'original-package.json');
  fs.writeFileSync(packageFile,f.original,{flag:'wx'});
  assert.equal(fs.readFileSync(packageFile,'utf8'),f.original);
  await f.ctx.close(); // source session is gone; only exported bytes are used
  const launch=()=>chromium.launchPersistentContext(path.join(folder,'profile'),{
    headless:true,executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
  let ctx=await launch();
  try{const target=await page(ctx,1);await restore(target,fs.readFileSync(packageFile,'utf8'));}
  finally{await ctx.close();}
  ctx=await launch();
  try{
    const target=await page(ctx,1), status=await inspect(target);
    assert.equal(status.verified,true);assert.equal(status.original,f.original);
    assert.deepEqual(durable(await capture(target)),durable(data(f.original)));
    assert.equal(fs.readFileSync(packageFile,'utf8'),f.original);
  }finally{await ctx.close();}
});

test('interruption after complete data verification but before status commit remains incomplete until verified retry',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(text=>{window.paused=false;window.work=TransferRehearsal.restore(text,async phase=>{
    if(phase==='verified'){window.paused=true;await new Promise(()=>{});}
  });},f.original);
  await f.target.waitForFunction(()=>window.paused);const target=await reopen(f.ctx,f.target,1);
  assert.equal((await inspect(target)).verified,false);
  assert.deepEqual(durable(await capture(target)),durable(data(f.original)));
  await restore(target,f.original);assert.equal((await inspect(target)).verified,true);
});

test('silent dropped localStorage write cannot report verified restoration',async t=>{
  const f=await fixture(t);
  await f.target.evaluate(()=>{const put=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
    if(this===localStorage&&k==='unknown_future_key')return;return put.call(this,k,v);};});
  await assert.rejects(restore(f.target,f.original),/restore_verification_failed/);
  assert.equal((await inspect(f.target)).verified,false);
  const target=await reopen(f.ctx,f.target,1);await restore(target,f.original);
  assert.equal((await inspect(target)).verified,true);
});

test('observed source edit during capture refuses package creation',async t=>{
  const f=await fixture(t);
  await f.source.evaluate(()=>{const list=indexedDB.databases.bind(indexedDB);let calls=0;
    indexedDB.databases=async()=>{const result=await list();if(++calls===2)localStorage.setItem('peer-edit','retain');return result;};});
  await assert.rejects(f.source.evaluate(()=>TransferRehearsal.exportPackage()),/source_changed_during_capture/);
  assert.equal(await f.source.evaluate(()=>localStorage.getItem('peer-edit')),'retain');
});

test('independent readback checks real Blob bytes, indexes, cycles, sharing, typed views and sparse values without the package codec',async t=>{
  const f=await fixture(t);await restore(f.target,f.original);
  const facts=await f.target.evaluate(async()=>{
    const open=name=>new Promise(r=>{const q=indexedDB.open(name);q.onsuccess=()=>r(q.result);});
    const db=await open('unknown_future_database');
    const tx=db.transaction(['records','compound','empty']);
    const store=tx.objectStore('records');
    const get=store.get(['compound',new Date('2020-02-01')]);
    const v=await new Promise(r=>get.onsuccess=()=>r(get.result));
    const result={version:db.version,cycle:v.cycle.self===v.cycle,shared:v.sharedA===v.sharedB,
      mapShared:v.map.has(v.sharedA),mapValues:[...v.map.get(v.sharedA)],
      sparse:[v.sparse.length,0 in v.sparse,2 in v.sparse,v.sparse[2]===undefined],
      big:v.big.toString(),negativeZero:Object.is(v.negativeZero,-0),nan:Number.isNaN(v.nan),
      infinity:v.infinity===Infinity,date:v.date.toISOString(),regexp:String(v.regexp),
      bytes:[...new Uint8Array(v.buffer)],view:[...v.view],sharedBuffer:v.view.buffer===v.buffer,
      dataView:v.dataView.getUint8(0),literalProto:Object.hasOwn(v,'__proto__')&&v.__proto__.literal,
      file:[v.file.name,v.file.type,v.file.lastModified,await v.file.text()]};
    db.close();
    const images=await open('taskpoints'), imageTx=images.transaction('images');
    const request=imageTx.objectStore('images').get('orphan');
    const blob=await new Promise(r=>request.onsuccess=()=>r(request.result));
    result.orphan={type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]};images.close();
    const schema=await open('unknown_future_database');
    const t=schema.transaction('records'), index=t.objectStore('records').index('tags');
    result.index={keyPath:index.keyPath,multiEntry:index.multiEntry,unique:index.unique};
    const count=index.count('a');result.indexMatches=await new Promise(r=>count.onsuccess=()=>r(count.result));schema.close();
    return result;
  });
  assert.deepEqual(facts,{version:3,cycle:true,shared:true,mapShared:true,mapValues:[1,'two'],
    sparse:[4,false,true,true],big:'12345678901234567890',negativeZero:true,nan:true,infinity:true,
    date:'2020-01-01T00:00:00.000Z',regexp:'/a+/gi',bytes:[1,2,255,4],view:[2,255],sharedBuffer:true,
    dataView:2,literalProto:true,file:['old.bin','application/octet-stream',12345,'file bytes'],
    orphan:{type:'application/octet-stream',bytes:[0,255,7,9]},
    index:{keyPath:'tags',multiEntry:true,unique:false},indexMatches:1});
});
