/* Standalone synthetic-only experiment. No TaskPoints imports or production access. */
(() => {
  'use strict';
  const DB='tp_synthetic_capture_v1', PREFIX=DB+':', LOCK=DB+':lock';
  const FORMAT='tp-iphone-synthetic-capture-1', MAX=64*1024;
  const PNG='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAQklEQVR4nGMQ83PGil5tsseKSFXPMGrBqAVDwAJqGYRL/agFoxYMBQuoZRAu9aMWjFowFCyglkG41I9aMGrBELAAABBlBEy05yLfAAAAAElFTkSuQmCC';
  const mode=()=>navigator.standalone===true||matchMedia('(display-mode: standalone)').matches?'Home Screen':'Safari / browser';
  const fail=message=>{throw Error(message);};
  const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  const equal=(a,b)=>stable(a)===stable(b);
  const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Storage transaction interrupted'));tx.onerror=()=>{};});
  const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  const bytes=()=>Uint8Array.from(atob(PNG),c=>c.charCodeAt(0));
  const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
  function validIdentity(x){
    return x&&equal(Object.keys(x).sort(),['createdAs','createdAt','id','syntheticOnly'].sort())&&x.syntheticOnly===true
      &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.id)
      &&['Home Screen','Safari / browser'].includes(x.createdAs)&&typeof x.createdAt==='string'
      &&Number.isFinite(Date.parse(x.createdAt))&&new Date(x.createdAt).toISOString()===x.createdAt;
  }
  function expected(identity){
    validIdentity(identity)||fail('Unrecognized identity; no source data will be exported');
    return {
      identity,
      local:[
        [PREFIX+'identity',JSON.stringify(identity)],
        [PREFIX+'note','SYNTHETIC ONLY — a made-up note'],
        [PREFIX+'pending',JSON.stringify({syntheticOnly:true,pending:[{id:'practice-edit',title:'SYNTHETIC pending edit'}]})]
      ],
      database:{name:DB,version:1,stores:[
        {name:'images',keyPath:'id',autoIncrement:false,indexes:[],records:[{id:'synthetic-image',syntheticOnly:true,type:'image/png',base64:PNG}]},
        {name:'records',keyPath:'id',autoIncrement:false,indexes:[],records:[
          {id:'synthetic-backup',syntheticOnly:true,evidence:'SYNTHETIC malformed recovery evidence: {unfinished',unknown:{keep:true}},
          {id:'synthetic-task',syntheticOnly:true,title:'SYNTHETIC Task',contextId:identity.id,unknown:{futureField:['keep',null,7]}}
        ]}
      ]}
    };
  }
  async function guard(){
    const local=['localhost','127.0.0.1'].includes(location.hostname);
    const approved=window.SYNTHETIC_CAPTURE_ORIGIN;
    if(!local&&!(location.protocol==='https:'&&location.origin===approved&&location.hostname.startsWith('tp-synthetic-capture-')))
      fail('This origin is not approved for the synthetic test. No storage was accessed.');
    if(!isSecureContext||!crypto.subtle||!crypto.randomUUID||!navigator.locks?.request||!indexedDB.databases)
      fail('Required safe capture APIs are unavailable. This browser is not supported; no fallback export.');
    if(sessionStorage.length)fail('Unrelated session storage found. Use a fresh dedicated test website.');
    const allowed=new Set(['identity','note','pending'].map(k=>PREFIX+k));
    for(let i=0;i<localStorage.length;i++)if(!allowed.has(localStorage.key(i)))fail('Unrelated localStorage found. Refusing this website.');
    const catalog=await indexedDB.databases();
    if(catalog.some(d=>d.name!==DB||d.version!==1))fail('Unrelated or unsupported database found. Refusing this website.');
    if(navigator.serviceWorker&&(navigator.serviceWorker.controller||(await navigator.serviceWorker.getRegistrations()).length))
      fail('An unexpected service worker controls this website. Use a fresh test website.');
    return catalog.some(d=>d.name===DB);
  }
  async function open(create=false){
    return new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,1);
      q.onupgradeneeded=()=>{
        if(!create){q.transaction.abort();return;}
        q.result.createObjectStore('records',{keyPath:'id'});q.result.createObjectStore('images',{keyPath:'id'});
      };
      q.onerror=()=>reject(q.error||Error('Database unavailable'));
      q.onblocked=()=>reject(Error('Database blocked by another session; close the other test session and retry'));
      q.onsuccess=()=>resolve(q.result);
    });
  }
  async function readDatabase(){
    const db=await open();
    try{
      if(!equal([...db.objectStoreNames],['images','records']))fail('Unsupported synthetic store layout');
      const tx=db.transaction(['images','records'],'readonly'),done=finished(tx);
      const pending=[...db.objectStoreNames].map(async name=>{
        const store=tx.objectStore(name);
        if(store.keyPath!=='id'||store.autoIncrement||store.indexNames.length)fail('Unsupported synthetic store schema');
        const records=await request(store.getAll());
        return {name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:[],records};
      });
      const stores=(await Promise.all([...pending,done])).slice(0,-1);
      const imageStore=stores.find(s=>s.name==='images');
      imageStore.records=await Promise.all(imageStore.records.map(async r=>{
        if(!equal(Object.keys(r).sort(),['bytes','id','syntheticOnly'])||!(r.bytes instanceof Blob)||r.bytes.size>1024)fail('Unrecognized image record');
        return {id:r.id,syntheticOnly:r.syntheticOnly,type:r.bytes.type,base64:b64(await r.bytes.arrayBuffer())};
      }));
      return {name:db.name,version:db.version,stores};
    }finally{db.close();}
  }
  async function inspect(){
    const exists=await guard();
    const local=[...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).sort().map(k=>[k,localStorage.getItem(k)]);
    const raw=localStorage.getItem(PREFIX+'identity');
    if(raw===null){if(exists||local.length)fail('Incomplete records have no identity. Refusing to invent replacement data.');return {complete:false,empty:true};}
    let identity;try{identity=JSON.parse(raw);}catch(_){fail('Damaged synthetic identity');}
    const want=expected(identity);
    for(const [key,value]of local)if(!want.local.some(([k,v])=>k===key&&v===value))fail('Changed or unrecognized synthetic record; source preserved');
    const database=exists?await readDatabase():null;
    if(database){
      for(const store of database.stores){const wanted=want.database.stores.find(s=>s.name===store.name);
        for(const record of store.records)if(!wanted.records.some(r=>equal(r,record)))fail('Changed or unrecognized database record; source preserved');
      }
    }
    const data={identity,local,database};
    return {complete:equal(data,want),empty:false,data};
  }
  async function seed(){
    return navigator.locks.request(LOCK,async()=>{
      let current=await inspect();
      if(current.complete)return current;
      let identity=current.data?.identity;
      if(!identity){identity={syntheticOnly:true,id:crypto.randomUUID(),createdAt:new Date().toISOString(),createdAs:mode()};
        const raw=JSON.stringify(identity);localStorage.setItem(PREFIX+'identity',raw);
        if(localStorage.getItem(PREFIX+'identity')!==raw)fail('Identity write did not persist');
      }
      const want=expected(identity);
      for(const [k,v]of want.local){const old=localStorage.getItem(k);if(old===null)localStorage.setItem(k,v);else if(old!==v)fail('Source changed during creation');}
      const db=await open(true);
      try{
        const tx=db.transaction(['images','records'],'readwrite'),done=finished(tx);
        for(const s of want.database.stores){const store=tx.objectStore(s.name);
          for(const r of s.records){const q=store.get(r.id);q.onsuccess=()=>{
            if(q.result===undefined)store.add(s.name==='images'?{id:r.id,syntheticOnly:true,bytes:new Blob([bytes()],{type:r.type})}:r);
          };}
        }await done;
      }finally{db.close();}
      current=await inspect();if(!current.complete)fail('Creation incomplete. Source retained; resume creation to retry.');return current;
    });
  }
  async function verify(text){
    if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX)fail('File is too large or unreadable');
    let envelope,body;try{envelope=JSON.parse(text);body=JSON.parse(envelope.body);}catch(_){fail('Incomplete or malformed package');}
    if(!equal(Object.keys(envelope).sort(),['body','sha256'])||typeof envelope.sha256!=='string'||await hash(envelope.body)!==envelope.sha256)fail('Package checksum does not match');
    if(!equal(Object.keys(body).sort(),['capturedAs','data','format','sourceOrigin','syntheticOnly'].sort())||body.format!==FORMAT||body.syntheticOnly!==true
      ||!['Home Screen','Safari / browser'].includes(body.capturedAs))fail('Unsupported synthetic package');
    const origin=new URL(body.sourceOrigin);
    if(origin.origin!==body.sourceOrigin||!(['127.0.0.1','localhost'].includes(origin.hostname)||(origin.protocol==='https:'&&origin.hostname.startsWith('tp-synthetic-capture-'))))fail('Not a synthetic source origin');
    if(!equal(body.data,expected(body.data?.identity)))fail('Incomplete or unexpected synthetic contents');
    return body;
  }
  async function capture(signal,onProgress=()=>{}){
    const active=()=>{if(signal?.aborted)fail('Capture interrupted. No package is ready; retry.');};
    return navigator.locks.request(LOCK,{signal},async()=>{
      active();const first=await inspect();if(!first.complete)fail('Synthetic records are incomplete; no export is allowed');
      onProgress('Checking source again. You may cancel now.');
      // Gives the owner a deliberate window to test Cancel/background interruption.
      await new Promise(r=>setTimeout(r,1000));active();
      const second=await inspect();
      if(!second.complete||!equal(first.data,second.data))fail('Source changed during capture; no package is ready');
      const body=JSON.stringify({format:FORMAT,syntheticOnly:true,sourceOrigin:location.origin,capturedAs:mode(),data:first.data});
      const text=JSON.stringify({body,sha256:await hash(body)});
      await verify(text);active();
      // Check again after hashing. No marker, checkpoint, replay or storage write.
      const last=await inspect();if(!last.complete||!equal(last.data,first.data))fail('Source changed before export completed');
      active();return text;
    });
  }
  window.SyntheticCapture=Object.freeze({guard,inspect,seed,verify,capture,mode,MAX,PNG});
})();
