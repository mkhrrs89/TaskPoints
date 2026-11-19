(() => {
 'use strict';
 if(!['localhost','127.0.0.1'].includes(location.hostname)||!location.pathname.startsWith('/experiments/v2-home-plus-one-day/'))throw Error('Synthetic localhost experiment only');
 window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__=true;
 // No implicit V1 save is permitted after fixture setup. Count even swallowed
 // write attempts so automated checks cannot mistake a blocked V1 save for proof.
 const native=Storage.prototype.setItem,remove=Storage.prototype.removeItem,clear=Storage.prototype.clear;
 let writable=false;const attempts=[];
 const reject=k=>{attempts.push(k);throw Error('V1 storage is read-only in this isolated V2 Task experiment');};
 Storage.prototype.setItem=function(k,v){if(this===localStorage&&!writable)return reject(k);return native.call(this,k,v);};
 Storage.prototype.removeItem=function(k){if(this===localStorage&&!writable)return reject(k);return remove.call(this,k);};
 Storage.prototype.clear=function(){if(this===localStorage&&!writable)return reject('clear');return clear.call(this);};
 window.OwnedTaskIsolation={attempts,async createFixture(fn){
  if(localStorage.length||(await indexedDB.databases()).length)throw Error('Fixture creation requires empty disposable storage; existing data preserved');
  writable=true;try{return await fn();}finally{writable=false;}
 }};
})();
