'use strict';
// Independent readback: no transfer codec/parser, no application normalization.
async function nativeSnapshot(page){return page.evaluate(async()=>{
 const req=q=>new Promise((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
 async function value(v){
  if(v instanceof Blob)return {nativeType:v instanceof File?'File':'Blob',mime:v.type,bytes:[...new Uint8Array(await v.arrayBuffer())],...(v instanceof File?{name:v.name,lastModified:v.lastModified}:{})};
  if(v instanceof ArrayBuffer)return {nativeType:'ArrayBuffer',bytes:[...new Uint8Array(v)]};
  if(v instanceof Error)return {nativeType:'Error',message:v.message};
  if(Array.isArray(v))return Promise.all(v.map(value));
  if(v&&typeof v==='object'){const out={};for(const k of Object.keys(v).sort())Object.defineProperty(out,k,{value:await value(v[k]),enumerable:true});return out;}
  return v;
 }
 const strings=s=>Object.keys(s).sort().map(k=>[k,s.getItem(k)]);
 const databases=[];
 for(const d of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
  if(d.name==='__taskpoints_transfer_rehearsal_control__')continue;
  const db=await req(indexedDB.open(d.name));
  try{
   const stores=[];
   for(const name of [...db.objectStoreNames]){
    const tx=db.transaction(name,'readonly'),s=tx.objectStore(name);
    const [keys,values]=await Promise.all([req(s.getAllKeys()),req(s.getAll())]);
    stores.push({name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,indexes:[...s.indexNames].map(n=>{const i=s.index(n);return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};}),keys:await value(keys),values:await value(values)});
   }databases.push({name:db.name,version:db.version,stores});
  }finally{db.close();}
 }
 return {local:strings(localStorage),session:strings(sessionStorage),databases};
});}
module.exports={nativeSnapshot};
