'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {root,source}=require('./home-source.cjs');
const prefix='/experiments/v2-home-plus-one-day/';
function createServer(){return http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 const allowed=new Set(['/scoring_core.js','/state_runtime_v2.js',prefix+'index.html',prefix+'isolation.js',prefix+'app.js',prefix+'style.css',prefix+'real-home.js']);
 if(!allowed.has(name)){res.writeHead(404);res.end('Outside the isolated Task experiment');return;}
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
 res.end(name===prefix+'real-home.js'?source():fs.readFileSync(path.join(root,name)));
 });}
if(require.main===module)createServer().listen(8766,'127.0.0.1',()=>console.log('Synthetic-only Home Task slice: http://127.0.0.1:8766'+prefix+'index.html'));
module.exports={createServer,prefix};
