/* Defense against accidental writers in this new capture document, not a lock
 * over other tabs, stale HTML or a malicious script in another realm. */
(() => {
  'use strict';
  const attempts=[];
  const block=name=>{attempts.push(name);throw Error('Source write refused: '+name);};
  const deny=(proto,name)=>{if(proto&&typeof proto[name]==='function')Object.defineProperty(proto,name,{value:function(){return block(name);},writable:false,configurable:false});};
  for(const name of ['setItem','removeItem','clear'])deny(Storage.prototype,name);
  for(const name of ['localStorage','sessionStorage']){
    const storage=window[name];
    const proxy=new Proxy(storage,{
      get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},
      set(){return block(name+' property assignment');},deleteProperty(){return block(name+' property deletion');},defineProperty(){return block(name+' defineProperty');}
    });
    Object.defineProperty(window,name,{get:()=>proxy,configurable:false});
  }
  for(const name of ['createObjectStore','deleteObjectStore'])deny(IDBDatabase.prototype,name);
  for(const name of ['put','add','delete','clear','createIndex','deleteIndex'])deny(IDBObjectStore.prototype,name);
  for(const name of ['update','delete'])deny(IDBCursor.prototype,name);
  deny(IDBFactory.prototype,'deleteDatabase');
  const transaction=IDBDatabase.prototype.transaction;
  Object.defineProperty(IDBDatabase.prototype,'transaction',{value:function(names,mode,...rest){
    if(mode&&mode!=='readonly')return block('IDB '+mode+' transaction');
    return transaction.call(this,names,mode,...rest);
  },writable:false,configurable:false});
  const open=IDBFactory.prototype.open;let knownDatabases=null;
  Object.defineProperty(IDBFactory.prototype,'open',{value:function(name,version){
    if(!knownDatabases?.has(name)||version!==undefined)return block('IDB create/upgrade');
    const q=open.call(this,name);
    q.addEventListener('upgradeneeded',()=>{q.transaction.abort();attempts.push('database vanished before open');});
    return q;
  },writable:false,configurable:false});
  Object.defineProperty(document,'cookie',{get:()=>'',set:()=>block('cookie write'),configurable:false});
  if(window.CacheStorage)for(const name of ['open','delete'])deny(CacheStorage.prototype,name);
  if(window.Cache)for(const name of ['put','add','addAll','delete'])deny(Cache.prototype,name);
  if(window.ServiceWorkerContainer)deny(ServiceWorkerContainer.prototype,'register');
  let entryError=null;
  const ready=(async()=>{
    if(!['localhost','127.0.0.1'].includes(location.hostname)||!['/','/index.html'].includes(location.pathname)||location.search!=='?tp_capture=synthetic-v1')
      throw Error('Synthetic capture entry only; no production access.');
    if(!isSecureContext||!crypto.subtle||typeof indexedDB.databases!=='function')throw Error('Required safe capture APIs unavailable.');
    if(navigator.serviceWorker&&(navigator.serviceWorker.controller||(await navigator.serviceWorker.getRegistrations()).length))
      throw Error('Existing service worker: capture startup cannot be certified.');
    knownDatabases=new Set((await indexedDB.databases()).map(d=>d.name));
  })().catch(e=>{entryError=e;});
  const assertClean=()=>{if(entryError)throw entryError;if(attempts.length)throw Error('Source write attempt detected; no package may be released: '+attempts.join(', '));};
  window.CaptureReadOnly=Object.freeze({ready,assertClean,attempts:()=>[...attempts]});
})();
