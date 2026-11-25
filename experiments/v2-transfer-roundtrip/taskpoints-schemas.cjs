'use strict';
// Schema fixtures derived from checked-in creation code, never from user data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const core=read('scoring_core.js'),v2=read('state_runtime_v2.js');
const constant=(text,name)=>{const m=text.match(new RegExp('const '+name+"\\s*=\\s*['\"]([^'\"]+)['\"]"));assert.ok(m,name);return m[1];};
const stores=(names,keyPath)=>names.map(name=>({name,keyPath,autoIncrement:false,indexes:[]}));
const shadow=JSON.parse(core.match(/const SHADOW_ARRAY_STORES = (\[[^;]+\]);/)[1]);
const v2stores=[...v2.slice(v2.indexOf('function ensureStores('),v2.indexOf('function open()')).matchAll(/createObjectStore\('([^']+)'/g)].map(m=>m[1]);
const previewStores=constantName=>{
 const start=v2.indexOf('const '+constantName),part=v2.slice(start,start+3000);
 const m=part.match(/for\s*\(const name of (\[[^\]]+\])/);assert.ok(m,constantName);
 return [...m[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
};
const schemas=[
 {name:constant(core,'IMAGE_DB_NAME'),version:1,stores:stores(['images'],null)},
 {name:constant(core,'SHADOW_MIGRATION_DB_NAME'),version:1,stores:[...stores([...shadow,'collections'],'key'),...stores(['values'],'field'),...stores(['metadata'],'id')]},
 {name:constant(read('phase2_reset_hook.js'),'VAULT_DB_NAME'),version:1,stores:stores(['snapshots'],'id')},
 {name:constant(read('phase5b_deferred_mirror.js'),'DB'),version:1,stores:stores(['snapshots'],'id')},
 {name:constant(v2,'DB_NAME'),version:Number(v2.match(/const DB_VERSION = (\d+)/)[1]),stores:stores(v2stores,'id')},
 {name:constant(v2,'PREVIEW_RECOVERY_DB'),version:1,stores:stores([constant(v2,'PREVIEW_RECOVERY_STORE')],'id')},
 ...['NOTES_PREVIEW_DB','HABIT_ORDER_PREVIEW_DB','GAME_PREVIEW_DB'].map(k=>({name:constant(v2,k),version:1,stores:stores(previewStores(k),'id')})),
 {name:constant(v2,'FROZEN_ORIGIN_WITNESS_DB'),version:1,stores:stores(['witnesses'],'id')},
 {name:'taskpoints_v2_writer_fence_preview_v1',version:1,stores:stores(['control'],'id')},
];
schemas.find(d=>d.name==='taskpoints_state_v2').stores.find(s=>s.name==='completions').indexes.push({name:constant(v2,'COMPLETION_HABIT_INDEX'),keyPath:'habitIds',multiEntry:true,unique:false});
module.exports={schemas,read,root};
