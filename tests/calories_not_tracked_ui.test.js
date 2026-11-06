const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
test('SCWM explicit skip appears under +2, allows blank values and zero points',()=>{
 const a=html.indexOf('id="caloriesLogBonusToggle"'),b=html.indexOf('id="caloriesNotTrackedToggle"');
 assert.ok(a>0&&b>a&&b-a<500);
 assert.match(html,/if \(!caloriesNotTracked && rawStr === ''\)/);
 assert.match(html,/caloriesNotTracked \? 0 : caloriesToPoints\(raw\)/);
 assert.match(html,/caloriesTotalImpactPoints\(raw, calLogBonusEnabled, caloriesNotTracked\)/);
});
test('editing and re-enabling calories persists explicit tracking flag',()=>{
 assert.match(html,/id="caloriesEditNotTrackedToggle"/);
 assert.equal((html.match(/\.caloriesNotTracked = caloriesNotTracked;/g)||[]).length,5);
 assert.equal((html.match(/calLogBonusDisabled: !calLogBonusEnabled,\s*caloriesNotTracked/g)||[]).length,3);
 assert.equal((html.match(/currentNotTracked: caloriesNotTrackedForEntry\(/g)||[]).length,4);
});
test('skipped days are shown honestly and excluded from numeric trends',()=>{
 assert.match(html,/if \(!entry \|\| caloriesNotTrackedForEntry\(entry\)\) return null/);
 assert.match(html,/todayValueEl\.textContent = 'Not tracked'/);
 assert.match(html,/const cal = caloriesNotTrackedForEntry\(entry\)/);
 assert.match(css,/calories-not-tracked-value/);
});

test('SCWM save cycle: blank skip -> real calories -> skip again, with one completion',()=>{
 const vm=require('node:vm');
 const start=html.indexOf('function saveCalories(){');
 const end=html.indexOf('function formatCaloriesDateLabel(',start);
 assert.ok(start>=0&&end>start);
 const state={completions:[]};
 const els={
  caloriesInput:{value:''},caloriesNotTrackedToggle:{checked:true},
  caloriesLogBonusToggle:{checked:false},caloriesDate:{value:'2026-11-03'}
 };
 const toasts=[];
 let saves=0;
 const calc=raw=>Math.max(0,Math.min(10,Math.round((2400-raw)/100)));
 const env={
  state,Date,crypto:{randomUUID:()=> 'test-calorie-id'},
  $:id=>els[id],
  dateKey:d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),
  caloriesToPoints:calc,
  getCalLogBonusAmount:()=>2,
  isCalLogBonusEnabledForEntry:e=>e?.calLogBonusEnabled!==false&&!e?.caloriesNotTracked,
  caloriesTotalImpactPoints:(raw,bonus,skip)=>skip?0:calc(raw)+(bonus?2:0),
  toastPointsDeltaTodayAware:(next,old)=>toasts.push({next,old}),
  markCompletionsDirty(){},
  syncCaloriesNotTrackedEntryToggle(){
   els.caloriesInput.disabled=els.caloriesNotTrackedToggle.checked;
   els.caloriesLogBonusToggle.disabled=els.caloriesNotTrackedToggle.checked;
   els.caloriesLogBonusToggle.checked=!els.caloriesNotTrackedToggle.checked;
  },
  save(){saves++;},scheduleRender(){},renderAll(){},alert:message=>{throw Error(message)}
 };
 vm.createContext(env);
 vm.runInContext(html.slice(start,end)+'\nthis.__saveCalories = saveCalories;',env);
 env.__saveCalories();
 assert.equal(state.completions.length,1);
 assert.equal(state.completions[0].caloriesNotTracked,true);
 assert.equal(state.completions[0].points,0);
 assert.equal(state.completions[0].calories,null);
 assert.equal(state.completions[0].title,'Calories (Not tracked)');
 assert.equal(toasts[0].next,0);
 els.caloriesInput.value='2000';els.caloriesNotTrackedToggle.checked=false;
 els.caloriesLogBonusToggle.checked=true;
 env.__saveCalories();
 assert.equal(state.completions.length,1);
 assert.equal(state.completions[0].caloriesNotTracked,false);
 assert.equal(state.completions[0].points,4);
 assert.equal(state.completions[0].calories,2000);
 assert.equal(toasts[1].next,6);
 els.caloriesInput.value='';els.caloriesNotTrackedToggle.checked=true;
 els.caloriesLogBonusToggle.checked=false;
 env.__saveCalories();
 assert.equal(state.completions.length,1);
 assert.equal(state.completions[0].points,0);
 assert.equal(state.completions[0].caloriesNotTracked,true);
 assert.equal(toasts[2].next,0);
 assert.equal(saves,3);
});
