'use strict';
// Load the real experimental adapter AND unchanged V1 worker module graph.
// No Cloudflare deployment and no browser production data access.
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..');let entry,normal;const rewriteCalls=[];
before(async()=>{
 // Cloudflare's HTMLRewriter is unavailable in Node. Record its requested
 // handlers and return the response; this checks delegation, NOT HTML rewriting.
 const HTMLRewriter=class {on(selector,handler){rewriteCalls.push([selector,String(handler.element)]);return this;}transform(response){return response;}};
 const context=vm.createContext({Request,Response,Headers,URL,TextEncoder,crypto:globalThis.crypto,console,HTMLRewriter});
 const modules=new Map();
 async function load(file){
  if(modules.has(file))return modules.get(file);
  const m=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file});modules.set(file,m);
  await m.link((specifier,parent)=>load(path.resolve(path.dirname(parent.identifier),specifier)));return m;
 }
 const m=await load(path.join(__dirname,'entry-worker.mjs'));await m.evaluate();entry=m.namespace.default;
 normal=modules.get(path.join(root,'_worker.js')).namespace.default;
});
test('actual adapter module graph intercepts Home before the unchanged worker reads ordinary HTML',async()=>{
 const paths=[];const env={CAPTURE_EXPERIMENT:'synthetic-only',ASSETS:{fetch:async request=>{
  paths.push(new URL(request.url).pathname);
  assert.equal(new URL(request.url).pathname,'/experiments/v2-capture-entry/capture.html');
  return new Response(fs.readFileSync(path.join(__dirname,'capture.html')));
 }}};
 const response=await entry.fetch(new Request('http://localhost/?tp_capture=synthetic-v1'),env,{});
 assert.equal(response.status,200);assert.equal(response.headers.get('x-taskpoints-capture-entry'),'synthetic-v1');
 assert.doesNotMatch(await response.text(),/scoring_core|home_indexeddb_bootstrap/);assert.equal(paths.length,1);
});
test('actual adapter and original worker produce identical unselected responses and rewrite requests (HTMLRewriter recorded)',async()=>{
 for(const [method,pathname]of [['HEAD','/index.html'],['HEAD','/settings.html'],['GET','/unchanged.html'],['GET','/'],['GET','/settings.html']]){
  const req=new Request('http://localhost'+pathname,{method}),requests=[];
  const env={ASSETS:{fetch:async r=>{requests.push(r);return new Response(method==='HEAD'?null:fs.readFileSync(path.join(root,'index.html')),{headers:{'content-type':'text/html','x-fixture':'preserved'}});}}};
  const ctx={};rewriteCalls.length=0;const ordinary=await normal.fetch(req,env,ctx);const originalRewrites=[...rewriteCalls];rewriteCalls.length=0;const wrapped=await entry.fetch(req,env,ctx);assert.deepEqual(rewriteCalls,originalRewrites);
  assert.equal(wrapped.status,ordinary.status);assert.deepEqual([...wrapped.headers],[...ordinary.headers]);assert.equal(await wrapped.text(),await ordinary.text());
  assert.equal(requests.length,2);assert.equal(requests[0].url,requests[1].url);assert.equal(requests[0].method,requests[1].method);assert.deepEqual([...requests[0].headers],[...requests[1].headers]);
 }
});
test('actual adapter rejects non-local capture before any ordinary asset or writer could be delivered',async()=>{
 const env={CAPTURE_EXPERIMENT:'synthetic-only',ASSETS:{fetch:()=>assert.fail('should not reach source assets')}};
 const response=await entry.fetch(new Request('https://taskpoints.example/?tp_capture=synthetic-v1'),env,{});assert.equal(response.status,403);
});
