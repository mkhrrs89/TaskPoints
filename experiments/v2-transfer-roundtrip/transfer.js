/* Isolated synthetic rehearsal only. Never loaded by TaskPoints.
 * No application activation, journal replay, or production storage access.
 */
(() => {
  'use strict';
  if(!['localhost','127.0.0.1'].includes(location.hostname))
    throw Error('synthetic_localhost_rehearsal_only');
  const CONTROL = '__taskpoints_transfer_rehearsal_control__';
  const LIMIT = 32 * 1024 * 1024;
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const fail = message => { throw Error(message); };
  const req = r => new Promise((resolve,reject) => {
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  const done = tx => new Promise((resolve,reject) => {
    tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error || Error('transaction_aborted'));
    tx.onerror=()=>{};
  });
  const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
  const b64 = buffer => {
    const bytes=new Uint8Array(buffer); let text='';
    for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(text);
  };
  const unb64 = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0)).buffer;

  // Graph codec preserves cycles, sharing, sparse arrays, special numbers,
  // binary data and common structured-clone types. Unsupported types refuse.
  async function encode(value) {
    const seen=new Map(), nodes=[];
    async function visit(x) {
      if(x===null || typeof x==='string' || typeof x==='boolean') return ['v',x];
      if(typeof x==='number') return ['n',Number.isNaN(x)?'NaN':Object.is(x,-0)?'-0':String(x)];
      if(typeof x==='undefined') return ['u'];
      if(typeof x==='bigint') return ['big',String(x)];
      if(typeof x!=='object') fail('unsupported_value');
      if(seen.has(x)) return ['ref',seen.get(x)];
      const id=nodes.length; seen.set(x,id); nodes.push(null);
      let node;
      if(x instanceof File) node=['file',b64(await x.arrayBuffer()),x.type,x.name,x.lastModified];
      else if(x instanceof Blob) node=['blob',b64(await x.arrayBuffer()),x.type];
      else if(x instanceof Date) node=['date',String(x.getTime())];
      else if(x instanceof RegExp) node=['regexp',x.source,x.flags];
      else if(x instanceof ArrayBuffer) node=['buffer',b64(x)];
      else if(ArrayBuffer.isView(x)) node=['view',x.constructor.name,await visit(x.buffer),x.byteOffset,
        x instanceof DataView?x.byteLength:x.length];
      else if(x instanceof Map) {
        const entries=[]; for(const [k,v] of x) entries.push([await visit(k),await visit(v)]);
        node=['map',entries];
      } else if(x instanceof Set) {
        const entries=[]; for(const v of x) entries.push(await visit(v)); node=['set',entries];
      } else {
        if(!Array.isArray(x) && Object.getPrototypeOf(x)!==Object.prototype && Object.getPrototypeOf(x)!==null)
          fail('unsupported_object_type');
        const entries=[];
        const keys=Reflect.ownKeys(x);
        if(keys.some(k=>typeof k!=='string')) fail('unsupported_symbol');
        for(const key of keys.sort()) {
          if(Array.isArray(x) && key==='length') continue;
          if(typeof key!=='string') fail('unsupported_symbol');
          const descriptor=Object.getOwnPropertyDescriptor(x,key);
          if(!descriptor.enumerable || !('value' in descriptor)) fail('unsupported_property');
          entries.push([key,await visit(descriptor.value)]);
        }
        entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
        node=Array.isArray(x)?['array',x.length,entries]:['object',entries];
      }
      nodes[id]=node; return ['ref',id];
    }
    const root=await visit(value); return {root,nodes};
  }
  function decode(graph) {
    const made=new Map();
    const views={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,
      Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,DataView};
    function visit(token) {
      if(token[0]==='v') return token[1];
      if(token[0]==='n') return Number(token[1]);
      if(token[0]==='u') return undefined;
      if(token[0]==='big') return BigInt(token[1]);
      if(token[0]!=='ref') fail('invalid_graph_token');
      const id=token[1]; if(made.has(id)) return made.get(id);
      const n=graph.nodes[id]; if(!n) fail('invalid_graph_reference');
      let x;
      switch(n[0]) {
        case 'blob': x=new Blob([unb64(n[1])],{type:n[2]}); break;
        case 'file': x=new File([unb64(n[1])],n[3],{type:n[2],lastModified:n[4]}); break;
        case 'date': x=new Date(Number(n[1])); break;
        case 'regexp': x=new RegExp(n[1],n[2]); break;
        case 'buffer': x=unb64(n[1]); break;
        case 'view': if(!Object.hasOwn(views,n[1])) fail('unsupported_view');
          x=new views[n[1]](visit(n[2]),n[3],n[4]); break;
        case 'map': x=new Map(); break;
        case 'set': x=new Set(); break;
        case 'array': x=new Array(n[1]); break;
        case 'object': x={}; break;
        default: fail('unsupported_graph_type');
      }
      made.set(id,x);
      if(n[0]==='map') for(const [k,v] of n[1]) x.set(visit(k),visit(v));
      if(n[0]==='set') for(const v of n[1]) x.add(visit(v));
      if(n[0]==='array'||n[0]==='object') for(const [k,v] of n[n[0]==='array'?2:1])
        Object.defineProperty(x,k,{value:visit(v),enumerable:true,writable:true,configurable:true});
      return x;
    }
    return visit(graph.root);
  }
  async function catalog() {
    if(typeof indexedDB.databases!=='function') fail('database_catalog_unavailable');
    return (await indexedDB.databases()).map(({name,version})=>({name,version}))
      .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  }
  async function openExisting(name) {
    return new Promise((resolve,reject)=>{
      const r=indexedDB.open(name);
      r.onupgradeneeded=()=>r.transaction.abort(); // never create during capture
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('database_blocked'));
    });
  }
  async function database(name) {
    const db=await openExisting(name);
    try {
      const names=Array.from(db.objectStoreNames).sort(), stores=[];
      if(!names.length) return {name,version:db.version,stores};
      const tx=db.transaction(names,'readonly'), completion=done(tx);
      // Read every store within one DB snapshot; binary encoding occurs later.
      const reads=names.map(async name=>{
        const s=tx.objectStore(name);
        const indexes=Array.from(s.indexNames).sort().map(name=>{
          const i=s.index(name); return {name,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};
        });
        const [keys,values]=await Promise.all([req(s.getAllKeys()),req(s.getAll())]);
        return {name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,indexes,keys,values};
      });
      const raw=(await Promise.all([...reads,completion])).slice(0,-1);
      for(const s of raw) {
        // Deleted generated keys leave an invisible high-water mark. Guessing
        // it from current keys would not be lossless: refuse these stores.
        if(s.autoIncrement) fail('unsupported_auto_increment_generator');
        const rows=[];
        for(let i=0;i<s.keys.length;i++) rows.push({key:await encode(s.keys[i]),value:await encode(s.values[i])});
        stores.push({name:s.name,keyPath:s.keyPath,autoIncrement:false,indexes:s.indexes,rows});
      }
      return {name,version:db.version,stores};
    } finally {db.close();}
  }
  function strings(storage) {
    const keys=[]; for(let i=0;i<storage.length;i++) keys.push(storage.key(i));
    return keys.sort().map(k=>[k,storage.getItem(k)]);
  }
  async function capture(skipControl=false) {
    const before=await catalog();
    if(!skipControl && before.some(x=>x.name===CONTROL)) fail('reserved_database_collision');
    const local=strings(localStorage), session=strings(sessionStorage), databases=[];
    for(const {name} of before) if(!skipControl || name!==CONTROL) databases.push(await database(name));
    if(!equal(before,await catalog()) || !equal(local,strings(localStorage)) || !equal(session,strings(sessionStorage)))
      fail('source_changed_during_capture');
    return {local,session,databases};
  }
  async function exportPackage() {
    const first=await capture(), second=await capture();
    if(!equal(first,second)) fail('source_changed_between_captures');
    const body=JSON.stringify({format:'tp-transfer-rehearsal-1',sourceOrigin:location.origin,data:first});
    if(new TextEncoder().encode(body).length>LIMIT) fail('package_size_limit');
    return JSON.stringify({body,sha256:await digest(body)});
  }
  async function validate(text) {
    if(typeof text!=='string'||new TextEncoder().encode(text).length>LIMIT*2) fail('package_size_limit');
    const envelope=JSON.parse(text);
    if(typeof envelope.body!=='string'||await digest(envelope.body)!==envelope.sha256) fail('package_checksum_mismatch');
    const p=JSON.parse(envelope.body);
    if(p.format!=='tp-transfer-rehearsal-1'||typeof p.sourceOrigin!=='string') fail('unsupported_package');
    const unique=(rows,key)=>{const a=rows.map(key);if(new Set(a).size!==a.length)fail('duplicate_identity');};
    for(const entries of [p.data.local,p.data.session]) {
      if(!Array.isArray(entries)||entries.some(r=>!Array.isArray(r)||r.length!==2||r.some(v=>typeof v!=='string')))
        fail('invalid_string_entries');
      unique(entries,r=>r[0]);
    }
    unique(p.data.databases,d=>d.name);
    for(const d of p.data.databases) {
      if(typeof d.name!=='string'||d.name===CONTROL||!Number.isSafeInteger(d.version)||d.version<1) fail('invalid_database');
      unique(d.stores,s=>s.name);
      for(const s of d.stores) {
        if(s.autoIncrement!==false) fail('unsupported_auto_increment_generator');
        unique(s.indexes,i=>i.name);
        unique(s.rows,r=>JSON.stringify(r.key));
        for(const r of s.rows) {
          const key=decode(r.key); indexedDB.cmp(key,key);
          if(!equal(await encode(key),r.key)||!equal(await encode(decode(r.value)),r.value)) fail('noncanonical_graph');
        }
      }
    }
    return p;
  }
  async function control(write) {
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(CONTROL,1);
      r.onupgradeneeded=()=>r.result.createObjectStore('control');
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
    });
    try {
      const tx=db.transaction('control',write?'readwrite':'readonly'), completion=done(tx);
      const store=tx.objectStore('control');
      const value=write?(store.put(write,'attempt'),write):await req(store.get('attempt'));
      await completion; return value;
    }finally{db.close();}
  }
  // Permit restart only over exact subsets of the original package. Never
  // delete unrelated destination data or overwrite a conflicting partial row.
  function subset(actual,expected) {
    for(const kind of ['local']) {
      const map=new Map(expected[kind]);
      for(const [k,v] of actual[kind]) if(!map.has(k)||map.get(k)!==v) fail('destination_conflict');
    }
    for(const d of actual.databases) {
      const e=expected.databases.find(x=>x.name===d.name);
      if(!e||e.version!==d.version||!equal(d.stores.map(({rows,...s})=>s),e.stores.map(({rows,...s})=>s)))
        fail('destination_schema_conflict');
      for(const s of d.stores) {
        const rows=new Map(e.stores.find(x=>x.name===s.name).rows.map(r=>[JSON.stringify(r.key),r.value]));
        for(const r of s.rows) if(!rows.has(JSON.stringify(r.key))||!equal(rows.get(JSON.stringify(r.key)),r.value))
          fail('destination_record_conflict');
      }
    }
  }
  async function writeDatabase(d) {
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(d.name,d.version);
      r.onupgradeneeded=()=>{
        for(const s of d.stores){const store=r.result.createObjectStore(s.name,{keyPath:s.keyPath});
          for(const i of s.indexes) store.createIndex(i.name,i.keyPath,{unique:i.unique,multiEntry:i.multiEntry});}
      };
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('database_blocked'));
    });
    try {
      if(!d.stores.length) return;
      const tx=db.transaction(d.stores.map(s=>s.name),'readwrite'), completion=done(tx);
      try {
        for(const s of d.stores) for(const r of s.rows) {
          const store=tx.objectStore(s.name), value=decode(r.value);
          if(s.keyPath===null) store.put(value,decode(r.key)); else store.put(value);
        }
      }catch(e){tx.abort();await completion.catch(()=>{});throw e;}
      await completion;
    } finally {db.close();}
  }
  function durable(data) {return {local:data.local,databases:data.databases};}
  async function restore(text, hook=async()=>{}) {
    const p=await validate(text); // preflight before any destination writes
    return navigator.locks.request(CONTROL,async()=>{
      const cats=await catalog();
      let prior=cats.some(d=>d.name===CONTROL)?await control():null;
      if(!prior && (cats.length || localStorage.length || sessionStorage.length)) fail('destination_not_blank');
      if(prior && prior.original!==text) fail('different_package_refused');
      if(prior) subset(await capture(true),p.data);
      const record={original:text,status:'incomplete'};
      await control(record); // original exact package persists BEFORE materialization
      await hook('staged');
      for(const [k,v] of p.data.local){
        const current=localStorage.getItem(k);
        if(current!==null && current!==v) fail('destination_conflict');
        localStorage.setItem(k,v);await hook('local:'+k);
      }
      for(const d of p.data.databases){await writeDatabase(d);await hook('database:'+d.name);}
      // Session markers are archived in original, not installed as active
      // locks/mode flags in a new tab. They remain available on every restart.
      const after=await capture(true);
      if(!equal(durable(after),durable(p.data))) fail('restore_verification_failed');
      await hook('verified');
      await control({...record,status:'verified'});
      return {verified:true,applicationEnabled:false};
    });
  }
  async function inspect() {
    if(!(await catalog()).some(d=>d.name===CONTROL)) return {verified:false,applicationEnabled:false};
    const record=await control();
    if(!record) return {verified:false,applicationEnabled:false};
    try {
      const p=await validate(record.original);
      const current=await capture(true);
      return {verified:record.status==='verified'&&equal(durable(current),durable(p.data)),
        original:record.original,sessionArchive:p.data.session,applicationEnabled:false};
    }catch(e){return {verified:false,original:record.original,error:e.message,applicationEnabled:false};}
  }
  // Snapshot a completed isolated destination for a NEW package after edits.
  // The original transfer remains immutable inside the control DB.
  async function exportWorkingCopy() {
    const record=await control();
    if(record?.status!=='verified') fail('incomplete_working_copy');
    const first=await capture(true), second=await capture(true);
    if(!equal(first,second)) fail('source_changed_between_captures');
    const original=await validate(record.original);
    const body=JSON.stringify({format:'tp-transfer-rehearsal-1',sourceOrigin:location.origin,
      data:{...first,session:original.data.session}});
    if(new TextEncoder().encode(body).length>LIMIT) fail('package_size_limit');
    return JSON.stringify({body,sha256:await digest(body)});
  }
  window.TransferRehearsal={capture,exportPackage,verifyPackage:validate,restore,inspect,exportWorkingCopy,CONTROL};
})();
