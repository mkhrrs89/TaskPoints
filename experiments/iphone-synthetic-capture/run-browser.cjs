'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const site=path.join(__dirname,'site');let browser,server,url;
before(async()=>{
 server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(site,name==='/'?'index.html':'.'+name);
  if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.png')?'image/png':'text/html');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.BOUNDARY_CHROMIUM_PATH||'/usr/bin/chromium'});
 console.log('Chromium',browser.version(),'; mobile viewport 390x844; NOT iOS/WebKit');
});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function setup(t,seed=true){
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,hasTouch:true,isMobile:true});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#health').textContent!=='Checking…');
 if(seed){await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);assert.match(await page.locator('#health').textContent(),/^PASS/);}
 return {page,context};
}
const snapshot=p=>p.evaluate(async()=>JSON.stringify((await SyntheticCapture.inspect()).data));
async function prepare(p){await p.click('#capture');await p.waitForFunction(()=>!document.querySelector('#capture').disabled);}
const exported=p=>p.evaluate(()=>SyntheticCapture.capture());
const selectFile=(p,text)=>p.locator('#file').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(text)});

test('standalone assets, manifest scope and install icon work at iPhone-sized viewport',async t=>{
 const {page}=await setup(t);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const manifest=await page.evaluate(async()=>fetch('manifest.webmanifest').then(r=>r.json()));
 assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
 assert.equal(await page.evaluate(async()=>{const img=new Image();img.src='icon.png';await img.decode();return img.naturalWidth;}),180);
 assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
 assert.equal(await page.locator('#preview').isVisible(),true);
 await page.screenshot({path:'/tmp/iphone-synthetic-harness.png',fullPage:true});
});

test('UI download is reopened from its saved file and every record is verified without import',async t=>{
 const {page}=await setup(t);const before=await snapshot(page);await prepare(page);
 assert.match(await page.locator('#exportStatus').textContent(),/^PASS/);
 const event=page.waitForEvent('download');await page.click('#download');const download=await event;
 const text=fs.readFileSync(await download.path(),'utf8');await selectFile(page,text);
 await page.waitForFunction(()=>document.querySelector('#verifyStatus').textContent.startsWith('PASS'));
 assert.match(await page.locator('#details').textContent(),/"imageDecoded": true/);
 assert.equal(await snapshot(page),before);
});

test('capture and package validation use no source storage writes',async t=>{
 const {page}=await setup(t),before=await snapshot(page);
 const result=await page.evaluate(async()=>{
  let writes=0;
  for(const name of ['setItem','removeItem','clear'])Storage.prototype[name]=()=>{writes++;throw Error('unexpected source write');};
  const transaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(names,mode){if(mode&&mode!=='readonly'){writes++;throw Error('unexpected IDB write');}return transaction.call(this,names,mode);};
  const text=await SyntheticCapture.capture();await SyntheticCapture.verify(text);return {writes,text};
 });assert.equal(result.writes,0);assert.equal(await snapshot(page),before);assert.ok(result.text.includes('tp-iphone-synthetic-capture-1'));
});

test('page restart retains identity and source records; prior export readiness is never persisted',async t=>{
 const {page}=await setup(t),before=await snapshot(page);await prepare(page);await page.reload();
 await page.waitForFunction(()=>document.querySelector('#health').textContent.startsWith('PASS'));
 assert.equal(await snapshot(page),before);assert.equal(await page.locator('#download').isVisible(),false);
 assert.match(await page.locator('#verifyStatus').textContent(),/NOT TESTED/);
});

test('same storage identity across tabs and different identities across isolated contexts are displayed honestly',async t=>{
 const {page,context}=await setup(t),other=await context.newPage();await other.goto(url);
 const a=await page.evaluate(async()=>(await SyntheticCapture.inspect()).data.identity.id);
 assert.equal(await other.evaluate(async()=>(await SyntheticCapture.inspect()).data.identity.id),a);
 await page.fill('#other',a);await page.click('#compare');await page.waitForFunction(()=>!document.querySelector('#compare').disabled);
 assert.match(await page.locator('#comparison').textContent(),/same Storage ID/);
 const isolated=await setup(t);const b=await isolated.page.evaluate(async()=>(await SyntheticCapture.inspect()).data.identity.id);assert.notEqual(a,b);
 await page.fill('#other',b);await page.click('#compare');await page.waitForFunction(()=>!document.querySelector('#compare').disabled);
 assert.match(await page.locator('#comparison').textContent(),/different Storage IDs/);
});

test('mode label recognizes standalone flag without claiming a real iOS installation',async t=>{
 const {page}=await setup(t,false);await page.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));await page.reload();
 await page.waitForFunction(()=>document.querySelector('#mode').textContent==='Home Screen');
 await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);
 assert.equal(await page.locator('#createdMode').textContent(),'Home Screen');
});

test('cancelled capture offers no file and retry preserves source records',async t=>{
 const {page}=await setup(t),before=await snapshot(page);
 await page.click('#capture');await page.waitForFunction(()=>!document.querySelector('#cancel').disabled);await page.click('#cancel');
 await page.waitForFunction(()=>!document.querySelector('#capture').disabled);
 assert.match(await page.locator('#exportStatus').textContent(),/interrupted/);assert.equal(await page.locator('#download').isVisible(),false);
 assert.equal(await snapshot(page),before);await prepare(page);assert.equal(await page.locator('#download').isVisible(),true);
});

test('background event and page closure discard in-flight exports without persistent success markers',async t=>{
 const {page,context}=await setup(t),before=await snapshot(page);
 await page.click('#capture');await page.waitForFunction(()=>!document.querySelector('#cancel').disabled);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>!document.querySelector('#capture').disabled);assert.equal(await page.locator('#download').isVisible(),false);
 await page.reload();await page.click('#capture');await page.waitForFunction(()=>!document.querySelector('#cancel').disabled);await page.close();
 const reopened=await context.newPage();await reopened.goto(url);assert.equal(await snapshot(reopened),before);assert.equal(await reopened.locator('#download').isVisible(),false);
});

for(const kind of ['quota','dropped write','transaction abort'])test('partial creation after '+kind+' refuses export and resumes without replacing evidence',async t=>{
 const {page}=await setup(t,false);
 await page.evaluate(kind=>{
  if(kind==='transaction abort'){
   const add=IDBObjectStore.prototype.add;let once=true;
   IDBObjectStore.prototype.add=function(...args){if(once){once=false;this.transaction.abort();return;}return add.apply(this,args);};
  }else{
   const put=Storage.prototype.setItem;
   Storage.prototype.setItem=function(k,v){if(k.endsWith(':pending')){if(kind==='quota')throw new DOMException('synthetic quota','QuotaExceededError');return;}return put.call(this,k,v);};
  }
 },kind);
 await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);assert.match(await page.locator('#health').textContent(),/^FAIL/);
 const identity=await page.evaluate(()=>localStorage.getItem('tp_synthetic_capture_v1:identity'));
 await prepare(page);assert.equal(await page.locator('#download').isVisible(),false);assert.match(await page.locator('#exportStatus').textContent(),/incomplete/);
 await page.reload();await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);
 assert.match(await page.locator('#health').textContent(),/^PASS/);assert.equal(await page.evaluate(()=>localStorage.getItem('tp_synthetic_capture_v1:identity')),identity);
});

for(const kind of ['unrelated localStorage','unrelated database','session storage','service worker','missing catalog'])test('refuses '+kind+' without exporting or deleting it',async t=>{
 const {page}=await setup(t,false);
 await page.evaluate(async kind=>{
  if(kind==='unrelated localStorage')localStorage.setItem('taskpoints_v1','DO NOT READ OR EXPORT');
  if(kind==='session storage')sessionStorage.setItem('unrelated','DO NOT EXPORT');
  if(kind==='missing catalog')Object.defineProperty(indexedDB,'databases',{value:undefined});
  if(kind==='service worker')navigator.serviceWorker.getRegistrations=async()=>[{}];
  if(kind==='unrelated database')await new Promise((resolve,reject)=>{const q=indexedDB.open('foreign');q.onsuccess=()=>{q.result.close();resolve();};q.onerror=()=>reject(q.error);});
 },kind);
 await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);assert.match(await page.locator('#health').textContent(),/^FAIL/);
 await prepare(page);assert.equal(await page.locator('#download').isVisible(),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('tp_synthetic_capture_v1:identity')),null);
 if(kind==='unrelated localStorage')assert.equal(await page.evaluate(()=>localStorage.getItem('taskpoints_v1')),'DO NOT READ OR EXPORT');
});

test('unapproved HTTPS origin is refused before any storage access',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());
 await context.addInitScript(()=>{window.storageTouches=0;Object.defineProperty(window,'localStorage',{get(){storageTouches++;throw Error('access forbidden');}});indexedDB.databases=()=>{storageTouches++;throw Error('access forbidden');};});
 await context.route('https://not-approved.invalid/**',route=>{
  const name=new URL(route.request().url()).pathname;const file=path.join(site,name==='/'?'index.html':path.basename(name));
  return route.fulfill({status:200,contentType:file.endsWith('.js')?'text/javascript':'text/html',body:fs.existsSync(file)?fs.readFileSync(file):''});
 });const page=await context.newPage();await page.goto('https://not-approved.invalid/');
 await page.waitForFunction(()=>document.querySelector('#health').textContent.startsWith('FAIL'));
 assert.match(await page.locator('#health').textContent(),/not approved/);assert.equal(await page.evaluate(()=>storageTouches),0);
});

test('damaged, missing and unexpected synthetic source data are preserved and cannot be exported',async t=>{
 const {page}=await setup(t);await page.evaluate(()=>localStorage.setItem('tp_synthetic_capture_v1:note','unexpected real-looking text'));
 await prepare(page);assert.equal(await page.locator('#download').isVisible(),false);assert.match(await page.locator('#exportStatus').textContent(),/unrecognized/);
 await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);
 assert.equal(await page.evaluate(()=>localStorage.getItem('tp_synthetic_capture_v1:note')),'unexpected real-looking text');
});

test('concurrent source change invalidates capture instead of offering partial data',async t=>{
 const {page}=await setup(t);
 const error=await page.evaluate(async()=>{try{await SyntheticCapture.capture(undefined,()=>localStorage.setItem('tp_synthetic_capture_v1:note','changed during capture'));return null;}catch(e){return e.message;}});
 assert.match(error,/unrecognized|changed/i);
});

test('concurrent creation in two tabs reuses one identity under the shared lock',async t=>{
 const {page,context}=await setup(t,false),other=await context.newPage();await other.goto(url);
 const results=await Promise.all([page.evaluate(()=>SyntheticCapture.seed()),other.evaluate(()=>SyntheticCapture.seed())]);
 assert.equal(results[0].complete,true);assert.equal(results[1].complete,true);assert.deepEqual(results[0].data,results[1].data);
});

for(const kind of ['truncated','checksum','missing record','unknown field','oversized'])test('saved-file verification refuses '+kind+' and clears any previous PASS',async t=>{
 const {page}=await setup(t),before=await snapshot(page),good=await exported(page);
 await selectFile(page,good);await page.waitForFunction(()=>document.querySelector('#verifyStatus').textContent.startsWith('PASS'));
 let bad;
 if(kind==='truncated')bad=good.slice(0,-12);
 else if(kind==='oversized')bad='x'.repeat(65537);
 else{
  bad=await page.evaluate(async({good,kind})=>{
   const envelope=JSON.parse(good);
   if(kind==='checksum')envelope.sha256='0'.repeat(64);
   else{const body=JSON.parse(envelope.body);if(kind==='missing record')body.data.local.pop();else body.data.unexpected='not synthetic';envelope.body=JSON.stringify(body);
    envelope.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(envelope.body))),n=>n.toString(16).padStart(2,'0')).join('');}
   return JSON.stringify(envelope);
  },{good,kind});
 }
 await selectFile(page,bad);await page.waitForFunction(()=>document.querySelector('#verifyStatus').textContent.startsWith('FAIL'));
 assert.equal(await page.locator('#details').textContent(),'');assert.equal(await snapshot(page),before);
});

test('saved package verifies in an empty independent context without restoring its contents',async t=>{
 const {page}=await setup(t),text=await exported(page),target=await setup(t,false);
 await selectFile(target.page,text);await target.page.waitForFunction(()=>document.querySelector('#verifyStatus').textContent.startsWith('PASS'));
 assert.equal(await target.page.evaluate(()=>localStorage.length),0);
 assert.deepEqual(await target.page.evaluate(()=>indexedDB.databases()),[]);
});

test('a failed recheck revokes an earlier prepared download',async t=>{
 const {page}=await setup(t);await prepare(page);assert.equal(await page.locator('#download').isVisible(),true);
 await page.evaluate(()=>localStorage.setItem('unexpected','preserve'));
 await prepare(page);assert.match(await page.locator('#exportStatus').textContent(),/^FAIL/);assert.equal(await page.locator('#download').isVisible(),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('unexpected')),'preserve');
});

test('aborted readonly database transaction cannot produce an export',async t=>{
 const {page}=await setup(t),before=await snapshot(page);
 await page.evaluate(()=>{const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode){const tx=transaction.call(this,names,mode);if(mode==='readonly')tx.abort();return tx;};});
 await prepare(page);assert.match(await page.locator('#exportStatus').textContent(),/^FAIL/);assert.equal(await page.locator('#download').isVisible(),false);
 await page.reload();assert.equal(await snapshot(page),before);
});

test('unexpected image bytes are retained and refuse capture',async t=>{
 const {page}=await setup(t);
 await page.evaluate(async()=>{
  const db=await new Promise(r=>{const q=indexedDB.open('tp_synthetic_capture_v1');q.onsuccess=()=>r(q.result);});
  const tx=db.transaction('images','readwrite');tx.objectStore('images').put({id:'synthetic-image',syntheticOnly:true,bytes:new Blob(['changed'],{type:'image/png'})});
  await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});db.close();
 });await prepare(page);assert.match(await page.locator('#exportStatus').textContent(),/^FAIL/);assert.equal(await page.locator('#download').isVisible(),false);
});

test('optional share path receives only the verified synthetic file and does not write source records',async t=>{
 const {page}=await setup(t),before=await snapshot(page);
 await page.evaluate(()=>{navigator.canShare=()=>true;navigator.share=async({files})=>{window.sharedText=await files[0].text();};});
 await prepare(page);await page.click('#share');await page.waitForFunction(()=>!document.querySelector('#share').disabled);
 const shared=await page.evaluate(()=>sharedText);assert.ok(shared.includes('tp-iphone-synthetic-capture-1'));
 assert.equal(await snapshot(page),before);await selectFile(page,shared);await page.waitForFunction(()=>document.querySelector('#verifyStatus').textContent.startsWith('PASS'));
});

test('a dedicated approved HTTPS origin is usable; repository config remains undeployed',async t=>{
 assert.match(fs.readFileSync(path.join(site,'config.js'),'utf8'),/SYNTHETIC_CAPTURE_ORIGIN = ''/);
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 const origin='https://tp-synthetic-capture-test.invalid';
 await context.route(origin+'/**',route=>{
  const name=new URL(route.request().url()).pathname,file=path.join(site,name==='/'?'index.html':path.basename(name));
  const body=name==='/config.js'?`window.SYNTHETIC_CAPTURE_ORIGIN = '${origin}';`:fs.existsSync(file)?fs.readFileSync(file):'';
  return route.fulfill({status:200,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.png')?'image/png':'text/html',body});
 });const page=await context.newPage();await page.goto(origin);await page.click('#seed');await page.waitForFunction(()=>!document.querySelector('#seed').disabled);
 assert.match(await page.locator('#health').textContent(),/^PASS/);
 const text=await exported(page);assert.equal(JSON.parse(JSON.parse(text).body).sourceOrigin,origin);
});

test('checking a now-incomplete fixture clears earlier export readiness without filling missing records',async t=>{
 const {page}=await setup(t);await prepare(page);
 await page.evaluate(()=>localStorage.removeItem('tp_synthetic_capture_v1:pending'));
 await page.click('#inspect');await page.waitForFunction(()=>!document.querySelector('#inspect').disabled);
 assert.match(await page.locator('#health').textContent(),/incomplete/);assert.match(await page.locator('#exportStatus').textContent(),/NOT READY/);
 assert.equal(await page.locator('#download').isVisible(),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('tp_synthetic_capture_v1:pending')),null);
});
