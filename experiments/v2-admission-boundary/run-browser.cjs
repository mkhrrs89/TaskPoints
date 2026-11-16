'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const pageSource = fs.readFileSync(path.join(ROOT, 'projects.html'), 'utf8');
// Execute the actual legacy writer, not a replacement/mock of its behavior.
const writer = pageSource.match(/function saveProjects\(\)\{[\s\S]*?\n\}/)?.[0];
assert.equal(writer, 'function saveProjects(){\n  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.projects));\n}');
const LEGACY = 'tp_projects_v1';
const original = [{id:'p', name:'Original'}];
const newer = [{id:'p', name:'New admitted edit'}];
const oldEdit = [{id:'p', name:'Edit in old tab'}];
const gateway = fs.readFileSync(path.join(__dirname, 'gateway.js'), 'utf8');
let server, browser, url;
before(async () => {
  server = http.createServer((req,res) => {
    res.writeHead(200, {'Content-Type':'text/html', 'Cache-Control':'no-store'});
    res.end('<!doctype html><title>Isolated admission experiment</title>');
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true, ...(process.env.BOUNDARY_CHROMIUM_PATH ? {executablePath:process.env.BOUNDARY_CHROMIUM_PATH} : {})});
});
after(async () => { await browser?.close(); if(server) await new Promise(r=>server.close(r)); });
async function tab(context, modern=true) {
  const p = await context.newPage(); await p.goto(url);
  if (modern) await p.addScriptTag({content:gateway});
  else await p.addScriptTag({content:`const STORAGE_KEY=${JSON.stringify(LEGACY)}; const state={projects:[]}; ${writer}
    window.legacySave=rows=>{state.projects=rows;saveProjects();};`});
  return p;
}
async function fixture(t) {
  const context = await browser.newContext();
  t.after(()=>context.close());
  const modern=await tab(context), old=await tab(context,false);
  await old.evaluate(rows=>legacySave(rows),original);
  await modern.waitForFunction(k=>localStorage.getItem(k)!==null,LEGACY);
  await modern.evaluate(()=>BoundaryExperiment.seed());
  return {context,modern,old};
}
const intent=(id,payload=newer,revision=0,generation=0)=>({id,payload,revision,generation});
const admit=(p,i)=>p.evaluate(i=>BoundaryExperiment.admit(i),i);
const read=p=>p.evaluate(()=>BoundaryExperiment.read());
const legacySave=(p,rows)=>p.evaluate(rows=>legacySave(rows),rows);
async function visible(p, rows) {
  await p.waitForFunction(({key,raw})=>localStorage.getItem(key)===raw,
    {key:LEGACY,raw:JSON.stringify(rows)});
}

test('cooperating tabs: one competing edit commits; retry is idempotent and payload substitution refused', async t=>{
  const {context,modern}=await fixture(t), peer=await tab(context);
  const results=await Promise.all([admit(modern,intent('a')),admit(peer,intent('b',oldEdit))]);
  assert.deepEqual(results.map(x=>x.reason).sort(),['committed','stale_revision']);
  const winner=results[0].reason==='committed'?intent('a'):intent('b',oldEdit);
  assert.equal((await admit(modern,winner)).reason,'duplicate');
  assert.equal((await admit(modern,{...winner,payload:[]})).reason,'conflicting_retry');
  assert.equal((await read(modern)).revision,1);
});

test('counterexample: old writer ignores a held admission lock and overwrites a shared compatibility key', async t=>{
  const {modern,old}=await fixture(t);
  await modern.evaluate(async rows=>{
    localStorage.setItem('tp_projects_v1',JSON.stringify(rows));
    window.lockHeld=false;
    window.holding=navigator.locks.request(BoundaryExperiment.LOCK,async()=>{
      window.lockHeld=true; await new Promise(r=>window.release=r);
    });
  },newer);
  await modern.waitForFunction(()=>window.lockHeld);
  await legacySave(old,oldEdit);
  await visible(modern,oldEdit);
  assert.deepEqual(await modern.evaluate(()=>JSON.parse(localStorage.getItem('tp_projects_v1'))),oldEdit);
  await modern.evaluate(async()=>{release();await holding;});
});

test('separate IDB retains admitted data; visible old edit blocks further admission and both versions remain', async t=>{
  const {modern,old}=await fixture(t);
  assert.equal((await admit(modern,intent('a'))).reason,'committed');
  await legacySave(old,oldEdit); await visible(modern,oldEdit);
  assert.equal((await admit(modern,intent('b',[],1))).reason,'legacy_diverged');
  assert.deepEqual((await read(modern)).payload,newer);
  assert.deepEqual(await old.evaluate(()=>JSON.parse(localStorage.getItem('tp_projects_v1'))),oldEdit);
});

test('decisive counterexample: old acknowledged edit disappears while modern clients are closed; restart cannot detect it', async t=>{
  const {context,modern,old}=await fixture(t);
  await admit(modern,intent('a'));
  const durableBefore=await read(modern);
  await modern.close();
  await legacySave(old,oldEdit);
  assert.deepEqual(await old.evaluate(()=>JSON.parse(localStorage.getItem('tp_projects_v1'))),oldEdit);
  // Another stale old tab rewrites the original snapshot. No modern listener exists.
  const stale=await tab(context,false);
  await legacySave(stale,original);
  await old.close(); await stale.close();
  const reopened=await tab(context);
  await visible(reopened,original);
  assert.deepEqual(await read(reopened),durableBefore);
  // All durable inputs equal a history with NO old edit. The gateway admits:
  // it has no evidence from which it could recover or flag the lost edit.
  assert.equal((await admit(reopened,intent('b',newer,1))).reason,'committed');
  assert.equal(JSON.stringify(await read(reopened)).includes('Edit in old tab'),false);
});

test('reset fences participating old generation; legacy writer can still resurrect its old document', async t=>{
  const {context,modern,old}=await fixture(t);
  await admit(modern,intent('a'));
  await modern.evaluate(()=>BoundaryExperiment.reset());
  await legacySave(old,oldEdit); await visible(modern,oldEdit);
  assert.equal((await admit(modern,intent('late',oldEdit,1,0))).reason,'stale_generation');
  assert.equal((await admit(modern,intent('fresh',newer,0,1))).reason,'legacy_diverged');
  await modern.close(); const reopened=await tab(context);
  assert.equal((await read(reopened)).generation,1);
  assert.deepEqual((await read(reopened)).payload,[]);
  assert.deepEqual(await old.evaluate(()=>JSON.parse(localStorage.getItem('tp_projects_v1'))),oldEdit);
});

test('transaction interruption before commit leaves no receipt or changed record on restart', async t=>{
  const {context,modern}=await fixture(t);
  await assert.rejects(admit(modern,{...intent('abort'),abort:true}),/interrupted_before_commit/);
  await modern.close(); const reopened=await tab(context);
  const state=await read(reopened);
  assert.equal(state.revision,0); assert.deepEqual(state.payload,original);
  assert.deepEqual(state.receipts,{});
  assert.equal((await admit(reopened,intent('abort'))).reason,'committed');
});

test('interruption after commit before caller acknowledgement: restart retry applies exactly once', async t=>{
  const {context,modern}=await fixture(t);
  await modern.evaluate(i=>{
    window.inFlight=BoundaryExperiment.admit(i).then(()=>new Promise(()=>{}));
  },intent('a'));
  // Independent context observes durable commit; caller never receives its acknowledgement.
  const observer=await tab(context);
  for(let n=0;n<100 && (await read(observer)).revision!==1;n++)
    await new Promise(r=>setTimeout(r,10));
  assert.equal((await read(observer)).revision,1);
  await modern.close(); const reopened=await tab(context);
  assert.equal((await admit(reopened,intent('a'))).reason,'duplicate');
  assert.equal((await read(reopened)).revision,1);
  assert.deepEqual((await read(reopened)).payload,newer);
});
