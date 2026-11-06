const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function runBoot(){
 const start=html.indexOf('<script id="tp-early-matrix-bootstrap">');
 const end=html.indexOf('</script>',start);
 assert.ok(start>0&&end>start);
 const script=html.slice(start+'<script id="tp-early-matrix-bootstrap">'.length,end);
 const timers=[];
 const listeners=new Map();
 const classList=()=>({values:new Set(['tp-boot-pending']),add(){},remove(){},contains(name){return name==='tp-boot-pending';}});
 const splash={style:{},remove(){this.removed=true;},addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);}};
 const title={textContent:'W',innerHTML:'',classList:classList(),appendChild(){},addEventListener(){}};
 const root={style:{}};
 const head={appendChild(){}};
 const body={classList:classList(),appendChild(n){this.latest=n;}};
 const createElement=tag=>({tagName:tag,style:{setProperty(){}},classList:classList(),appendChild(){},append(){},setAttribute(){},addEventListener(){},textContent:''});
 const document={getElementById:id=>({bootSplash:splash,matrixTitle:title,appRoot:root}[id]||null),
   createElement,head,body,documentElement:{classList:classList()}};
 const sessionStorage={setItem(){}},performance={mark(){}};
 const window={TaskPointsHomeLiveState:undefined,__tpBootViewFinished:false,
   matchMedia:()=>({matches:false}),requestAnimationFrame(){},
   dispatchEvent(){},addEventListener(){}};
 const env={window,document,sessionStorage,performance,Event:class Event{constructor(type){this.type=type;}},
   setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},Math,Promise};
 vm.createContext(env);vm.runInContext(script,env);
 return {env,timers,window,splash,root,listeners};
}
test('startup watchdog reveals Home even if late bootstrap never runs',()=>{
 const h=runBoot();
 const timeout=h.timers.find(timer=>timer.ms===6500);
 assert.ok(timeout,'separate splash release timer');
 timeout.fn();
 assert.equal(h.window.__tpBootViewFinished,true);
 assert.equal(h.root.style.visibility,'visible');
 assert.equal(h.root.style.pointerEvents,'auto');
});
test('tap-to-skip remains available after title finishes',()=>{
 const h=runBoot();
 h.window.__tpForceMatrixCompletion();
 assert.equal(h.listeners.has('click'),true,'do not remove skip listeners while app remains hidden');
 h.listeners.get('click')();
 assert.equal(h.window.__tpBootViewFinished,true);
 assert.equal(h.root.style.visibility,'visible');
});
