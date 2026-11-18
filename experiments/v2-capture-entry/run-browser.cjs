'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');
const {seedTaskPoints}=require('../v2-transfer-roundtrip/seed-taskpoints.cjs');
const {read,root}=require('../v2-transfer-roundtrip/taskpoints-schemas.cjs');
const {nativeSnapshot}=require('./native-snapshot.cjs');
let browser,routeCapture;const servers=[],urls=[];
const transfer=read('experiments/v2-transfer-roundtrip/transfer.js');
const mode='/?tp_capture=synthetic-v1';
const type=file=>file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
before(async()=>{
 ({routeCapture}=await import(pathToFileURL(path.join(__dirname,'entry-router.mjs')).href));
 for(let i=0;i<2;i++){
  const s=http.createServer(async(q,r)=>{
   try{
    const request=new Request('http://'+q.headers.host+q.url,{method:q.method});
    const asset=async request=>{
     const name=new URL(request.url).pathname;
     if(name==='/fixture')return new Response('<!doctype html><title>Synthetic parked context</title><input id="unsaved">',{headers:{'content-type':'text/html'}});
     const file=path.resolve(root,'.'+name);
     if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return new Response('not found',{status:404});
     return new Response(fs.readFileSync(file),{headers:{'content-type':type(file),'cache-control':'no-store'}});
    };
    const response=await routeCapture(request,{CAPTURE_EXPERIMENT:'synthetic-only',ASSETS:{fetch:asset}},{},async req=>{return asset(req);});
    r.writeHead(response.status,Object.fromEntries(response.headers));r.end(Buffer.from(await response.arrayBuffer()));
   }catch(e){r.writeHead(500);r.end(String(e));}
  });await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);urls.push('http://127.0.0.1:'+s.address().port);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
 console.log('Chromium',browser.version(),'; synthetic localhost only; no actual iPhone delivery');
});
after(async()=>{await browser?.close();for(const s of servers)await new Promise(r=>s.close(r));});
function audit(){
 if(location.search!=='?tp_capture=synthetic-v1')return;
 window.__sourceWrites=[];
 const observe=(proto,name,label=name)=>{const old=proto[name];proto[name]=function(...args){window.__sourceWrites.push(label);return old.apply(this,args);};};
 for(const name of ['setItem','removeItem','clear'])observe(Storage.prototype,name);
 for(const name of ['put','add','delete','clear','createIndex','deleteIndex'])observe(IDBObjectStore.prototype,name);
 for(const name of ['createObjectStore','deleteObjectStore'])observe(IDBDatabase.prototype,name);
 observe(IDBFactory.prototype,'deleteDatabase');
 const tx=IDBDatabase.prototype.transaction;
 IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode&&mode!=='readonly')window.__sourceWrites.push('IDB '+mode);const t=tx.call(this,names,mode,...rest);if(window.__abortRead&&mode==='readonly')t.abort();return t;};
 const open=IDBFactory.prototype.open;
 IDBFactory.prototype.open=function(...args){const q=open.apply(this,args);q.addEventListener('upgradeneeded',()=>window.__sourceWrites.push('IDB upgrade'));return q;};
 // Explicit test-only failure injection for independent detector calibration.
 const nativeStorage=localStorage,put=Storage.prototype.setItem;
 window.__injectNativeWriter=()=>put.call(nativeStorage,'unexpected-native-write','synthetic fault injection');
 const digest=crypto.subtle.digest.bind(crypto.subtle);
 crypto.subtle.digest=async(...args)=>{if(window.__pauseDigest){window.__digestWaiting=true;await new Promise(r=>window.__releaseDigest=r);}return digest(...args);};
}
async function fixture(t,{enter=true,mutate}={}){
 const ctx=await browser.newContext();t.after(()=>ctx.close());await ctx.addInitScript(audit);
 const page=await ctx.newPage();await page.goto(urls[0]+'/fixture');await seedTaskPoints(page);
 const inventory=JSON.parse(read('docs/state-runtime-v2-storage-source-inventory.json'));
 await page.evaluate(keys=>{
  for(const key of keys)if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify({synthetic:true,unknownEvidence:key}));
  localStorage.setItem('taskpoints_emergency_recovery_hold_v1','{malformed preserved hold');
  localStorage.setItem('taskpoints_pending_player_edits_v1','{malformed preserved pending edit');
  localStorage.setItem('unknown_future_storage','\u0000\ud800 unknown raw bytes');
  sessionStorage.setItem('tpBootSeenThisSession','0');sessionStorage.setItem('pending_unsaved_evidence','SYNTHETIC session evidence');
 },[...new Set(inventory.keyEvidence.map(r=>r.key))]);
 if(mutate)await mutate(page);
 // Stop the fixture's actual legacy seed-module timers before taking the baseline.
 await page.goto(urls[0]+'/fixture');
 const baseline=await nativeSnapshot(page);
 if(enter)await navigate(page);
 return {ctx,page,baseline};
}
async function navigate(page){await page.goto(urls[0]+mode);await page.waitForFunction(()=>!document.querySelector('#entry').textContent.startsWith('Checking'));}
async function assertReadOnly(f){
 assert.deepEqual(await nativeSnapshot(f.page),f.baseline,'native source bytes/schema changed');
 assert.deepEqual(await f.page.evaluate(()=>__sourceWrites),[],'native source write API invoked');
 assert.deepEqual(await f.page.evaluate(()=>CaptureReadOnly.attempts()),[],'source write attempted');
}
async function prepare(page){await page.click('#capture');await page.waitForFunction(()=>!document.querySelector('#capture').disabled);}
const capture=page=>page.evaluate(()=>TaskPointsCaptureOnly.capture());
const file=(page,text)=>page.locator('#file').setInputFiles({name:'source-package.json',mimeType:'application/json',buffer:Buffer.from(text)});
function checkedEnvelope(text){const e=JSON.parse(text);assert.equal(crypto.createHash('sha256').update(e.body).digest('hex'),e.sha256);return JSON.parse(e.body);}

test('capture request is selected before V1 worker, HTML, preload or startup scripts are consulted',async t=>{
 const f=await fixture(t,{enter:false});let requests=[];f.page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await navigate(f.page);
 assert.match(await f.page.locator('#entry').textContent(),/^PASS/);
 assert.equal(await f.page.evaluate(()=>typeof TaskPointsCore),'undefined');assert.equal(await f.page.evaluate(()=>typeof TaskPointsStateRuntimeV2),'undefined');
 assert.equal(await f.page.evaluate(()=>typeof TransferRehearsal),'undefined');
 assert.deepEqual(requests.sort(),['/','/experiments/v2-capture-entry/capture.css','/experiments/v2-capture-entry/readonly-guard.js','/experiments/v2-capture-entry/capture.js','/experiments/v2-transfer-roundtrip/transfer.js'].sort());
 await assertReadOnly(f);
});

test('all actual storage layouts, every inventoried key, images and malformed recovery evidence survive capture and independent restore readback',async t=>{
 const f=await fixture(t);const text=await capture(f.page),p=checkedEnvelope(text);
 assert.equal(p.format,'tp-transfer-rehearsal-1');assert.equal(p.data.databases.length,11);
 assert.equal(p.data.databases.reduce((n,d)=>n+d.stores.length,0),34);
 const keys=new Set(p.data.local.map(x=>x[0]));for(const row of JSON.parse(read('docs/state-runtime-v2-storage-source-inventory.json')).keyEvidence)assert.ok(keys.has(row.key));
 assert.ok(p.data.session.some(([k])=>k==='pending_unsaved_evidence'));await assertReadOnly(f);
 const target=await f.ctx.newPage();await target.goto(urls[1]+'/fixture');await target.addScriptTag({content:transfer});await target.evaluate(text=>TransferRehearsal.restore(text),text);
 const actual=await nativeSnapshot(target);assert.deepEqual(actual.local,f.baseline.local);assert.deepEqual(actual.databases,f.baseline.databases);
 assert.deepEqual(actual.session,[]); // archived, never activated in another context
 assert.deepEqual((await target.evaluate(()=>TransferRehearsal.inspect())).sessionArchive,f.baseline.session);
 assert.equal((await target.evaluate(()=>TransferRehearsal.inspect())).applicationEnabled,false);
 await assertReadOnly(f);
});

test('saved download reopens in capture mode after restart; original package retained outside source storage',async t=>{
 const f=await fixture(t);await prepare(f.page);assert.match(await f.page.locator('#status').textContent(),/^PASS/);
 const downloadPromise=f.page.waitForEvent('download');await f.page.click('#download');const download=await downloadPromise;
 const text=fs.readFileSync(await download.path(),'utf8');checkedEnvelope(text);await assertReadOnly(f);
 await navigate(f.page);assert.equal(await f.page.locator('#download').isVisible(),false);
 await file(f.page,text);await f.page.waitForFunction(()=>document.querySelector('#verification').textContent.startsWith('PASS'));
 await assertReadOnly(f);
});

test('unselected requests return the exact existing worker response and original request/env/context identities',async()=>{
 const body=fs.readFileSync(path.join(root,'index.html'));const response=new Response(body,{headers:{'x-normal':'unchanged'}});
 const env={},ctx={};let count=0;
 for(const suffix of ['/','/index.html','/settings.html','/scoring_core.js?v=old','/?unrelated=1']){
  const request=new Request('http://localhost'+suffix);
  const result=await routeCapture(request,env,ctx,(r,e,c)=>{count++;assert.equal(r,request);assert.equal(e,env);assert.equal(c,ctx);return response;});
  assert.equal(result,response);
 }assert.equal(count,5);assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
 const adapter=fs.readFileSync(path.join(__dirname,'entry-worker.mjs'),'utf8');assert.match(adapter,/import normalWorker from '\.\.\/\.\.\/_worker\.js'/);assert.match(adapter,/normalWorker\.fetch\(r,e,c\)/);
});

for(const suffix of ['/?tp_capture=wrong','/?tp_capture=synthetic-v1&tp_capture=synthetic-v1','/settings.html?tp_capture=synthetic-v1'])test('invalid selected entry never falls back: '+suffix,async()=>{
 const r=await routeCapture(new Request('http://localhost'+suffix),{CAPTURE_EXPERIMENT:'synthetic-only'},{},()=>assert.fail('normal startup invoked'));assert.equal(r.status,400);
});

test('production hostname, disabled experiment and missing capture HTML all refuse without ordinary startup',async()=>{
 const normal=()=>assert.fail('ordinary startup fallback');
 for(const [url,env,code]of [
  ['https://taskpoints.example/?tp_capture=synthetic-v1',{CAPTURE_EXPERIMENT:'synthetic-only'},403],
  ['http://localhost/?tp_capture=synthetic-v1',{},403],
  ['http://localhost/?tp_capture=synthetic-v1',{CAPTURE_EXPERIMENT:'synthetic-only',ASSETS:{fetch:async()=>new Response('missing',{status:404})}},503]
 ]){const r=await routeCapture(new Request(url),env,{},normal);assert.equal(r.status,code);}
});

for(const fault of ['local method','local assignment','session delete','IDB readwrite','database deletion','database creation','cookie','cache','service worker'])test('a swallowed '+fault+' writer is detected and forbids a package',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(fault=>{
  try{
   if(fault==='local method')localStorage.setItem('bad','write');
   if(fault==='local assignment')localStorage.bad='write';
   if(fault==='session delete')delete sessionStorage.pending_unsaved_evidence;
   if(fault==='IDB readwrite')indexedDB.open('taskpoints').onsuccess=e=>{const db=e.target.result;try{db.transaction('images','readwrite');}catch(_){}finally{db.close();}};
   if(fault==='database deletion')indexedDB.deleteDatabase('taskpoints');
   if(fault==='database creation')indexedDB.open('unexpected');
   if(fault==='cookie')document.cookie='bad=write';
   if(fault==='cache')caches.open('unexpected');
   if(fault==='service worker')navigator.serviceWorker.register('/unexpected.js');
  }catch(_){}
 },fault);
 await f.page.waitForFunction(()=>CaptureReadOnly.attempts().length>0);
 await assert.rejects(capture(f.page),/write attempt/);
 assert.deepEqual(await nativeSnapshot(f.page),f.baseline);assert.equal(await f.page.locator('#download').isVisible(),false);
});

test('independent source-write detector fails even if a writer bypasses the page guard using an earlier native reference',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>__injectNativeWriter());
 await assert.rejects(assertReadOnly(f),/native source bytes\/schema changed/);
});

for(const kind of ['auto-increment','unsupported value','missing catalog','aborted read'])test('refuses '+kind+' without source changes',async t=>{
 const f=await fixture(t,{mutate:async page=>{
  if(kind==='auto-increment')await page.evaluate(()=>new Promise((resolve,reject)=>{const q=indexedDB.open('synthetic_unsupported');q.onupgradeneeded=()=>q.result.createObjectStore('rows',{autoIncrement:true});q.onsuccess=()=>{q.result.close();resolve();};q.onerror=()=>reject(q.error);}));
  if(kind==='unsupported value')await page.evaluate(()=>new Promise((resolve,reject)=>{const q=indexedDB.open('taskpoints');q.onsuccess=()=>{const db=q.result,tx=db.transaction('images','readwrite');tx.objectStore('images').put(new Error('synthetic unsupported evidence'),'unsupported');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}));
 }});
 if(kind==='missing catalog')await f.page.evaluate(()=>indexedDB.databases=undefined);
 if(kind==='aborted read')await f.page.evaluate(()=>window.__abortRead=true);
 await assert.rejects(capture(f.page));assert.equal(await f.page.locator('#download').isVisible(),false);
 if(['missing catalog','aborted read'].includes(kind))await navigate(f.page);
 await assertReadOnly(f);
});

for(const action of ['cancel','background','close'])test(action+' during hashing cannot release a package; restart/retry works',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>window.__pauseDigest=true);
 await f.page.click('#capture');await f.page.waitForFunction(()=>window.__digestWaiting);
 if(action==='close'){await f.page.close();f.page=await f.ctx.newPage();await navigate(f.page);}
 else{
  if(action==='cancel')await f.page.click('#cancel');
  else await f.page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  await f.page.waitForFunction(()=>!document.querySelector('#capture').disabled); // cancellation does not await the stalled read/hash
  await f.page.evaluate(()=>{window.__pauseDigest=false;window.__releaseDigest();});assert.match(await f.page.locator('#status').textContent(),/^REFUSED/);
  await navigate(f.page);
 }
 // SessionStorage belongs to the capturing tab: tab closure loses that tab's
 // archive; same-tab restart retains it. Do not invent the lost session values.
 if(action==='close')f.baseline.session=[];
 assert.equal(await f.page.locator('#download').isVisible(),false);checkedEnvelope(await capture(f.page));await assertReadOnly(f);
});

test('observed external-tab edit during hashing refuses the package and retains that edit',async t=>{
 const f=await fixture(t);const other=await f.ctx.newPage();await other.goto(urls[0]+'/fixture');
 await f.page.evaluate(()=>window.__pauseDigest=true);await f.page.click('#capture');await f.page.waitForFunction(()=>window.__digestWaiting);
 await other.evaluate(()=>localStorage.setItem('unknown_future_storage','SYNTHETIC newer edit'));
 await f.page.evaluate(()=>{window.__pauseDigest=false;__releaseDigest();});await f.page.waitForFunction(()=>!document.querySelector('#capture').disabled);
 assert.match(await f.page.locator('#status').textContent(),/Source changed/);assert.equal(await f.page.locator('#download').isVisible(),false);
 assert.equal(await other.evaluate(()=>localStorage.getItem('unknown_future_storage')),'SYNTHETIC newer edit');
});

for(const kind of ['truncated','checksum','unsupported version'])test('reopening '+kind+' package refuses without touching source',async t=>{
 const f=await fixture(t),text=await capture(f.page);let bad;
 if(kind==='truncated')bad=text.slice(0,-20);
 else{const e=JSON.parse(text);if(kind==='checksum')e.sha256='bad';else{const p=JSON.parse(e.body);p.format='unsupported';e.body=JSON.stringify(p);e.sha256=crypto.createHash('sha256').update(e.body).digest('hex');}bad=JSON.stringify(e);}
 await file(f.page,bad);await f.page.waitForFunction(()=>document.querySelector('#verification').textContent.startsWith('REFUSED'));await assertReadOnly(f);
});

test('delivery blocker: navigation retains same-tab storage but cannot preserve an unsaved form automatically',async t=>{
 const f=await fixture(t,{enter:false});await f.page.fill('#unsaved','SYNTHETIC unsaved idea');await navigate(f.page);
 const text=await capture(f.page);assert.equal(text.includes('SYNTHETIC unsaved idea'),false);await assertReadOnly(f);
});


test('existing service-worker evidence disables capture before source databases can be opened',async t=>{
 const f=await fixture(t,{enter:false});
 await f.page.addInitScript(()=>{navigator.serviceWorker.getRegistrations=async()=>[{}];});
 await navigate(f.page);assert.match(await f.page.locator('#entry').textContent(),/REFUSED.*service worker/);
 assert.equal(await f.page.locator('#capture').isDisabled(),true);assert.deepEqual(await f.page.evaluate(()=>__sourceWrites),[]);
 await f.page.goto(urls[0]+'/fixture');assert.deepEqual(await nativeSnapshot(f.page),f.baseline);
});

test('delivery blocker: legacy HTML served instead of the new entry can run an actual legacy writer despite the capture URL',async t=>{
 const f=await fixture(t,{enter:false});
 await f.page.route(urls[0]+mode,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><title>Simulated stale legacy document</title><script src="/scoring_core.js"></script><script>
 TaskPointsCore.writePendingHabitDelta({habitId:'h1',dayKey:'2026-11-18',source:'habit',status:'full',done:true});window.legacyRan=true;
 </script>`}));
 await f.page.goto(urls[0]+mode);await f.page.waitForFunction(()=>window.legacyRan);
 assert.equal(await f.page.evaluate(()=>typeof TaskPointsCaptureOnly),'undefined');
 assert.ok((await f.page.evaluate(()=>__sourceWrites)).includes('setItem'));
 assert.notDeepEqual(await nativeSnapshot(f.page),f.baseline);
});


test('an empty source context cannot produce a misleading successful package',async t=>{
 const ctx=await browser.newContext();t.after(()=>ctx.close());await ctx.addInitScript(audit);
 const page=await ctx.newPage();await navigate(page);
 await assert.rejects(capture(page),/canonical key absent/);
 assert.equal(await page.locator('#download').isVisible(),false);
 assert.deepEqual(await nativeSnapshot(page),{local:[],session:[],databases:[]});assert.deepEqual(await page.evaluate(()=>__sourceWrites),[]);
});

test('unknown supported database and binary records are included rather than filtered by the TaskPoints inventory',async t=>{
 const f=await fixture(t,{mutate:async page=>page.evaluate(()=>new Promise((resolve,reject)=>{
  const q=indexedDB.open('synthetic_future_database',3);
  q.onupgradeneeded=()=>{const s=q.result.createObjectStore('future');s.createIndex('by_unknown','unknown',{unique:false});};
  q.onsuccess=()=>{const db=q.result,tx=db.transaction('future','readwrite');tx.objectStore('future').put({unknown:'retain',binary:new Uint8Array([9,8,7]).buffer},'future-row');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};q.onerror=()=>reject(q.error);
 }))});
 const text=await capture(f.page);assert.equal(checkedEnvelope(text).data.databases.length,12);await assertReadOnly(f);
 const target=await f.ctx.newPage();await target.goto(urls[1]+'/fixture');await target.addScriptTag({content:transfer});await target.evaluate(text=>TransferRehearsal.restore(text),text);
 assert.deepEqual((await nativeSnapshot(target)).databases,f.baseline.databases);
});
