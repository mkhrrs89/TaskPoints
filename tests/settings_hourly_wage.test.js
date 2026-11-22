const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'settings.html'),'utf8');
const source = fs.readFileSync(path.join(root,'hourly_wage_settings.js'),'utf8');
const core = fs.readFileSync(path.join(root,'scoring_core.js'),'utf8');
const copy = o => JSON.parse(JSON.stringify(o));

function fixture() {
  let state={tasks:[{id:'t'}],completions:[{id:'c'}],habits:[{id:'h'}],
    matchups:[{id:'m'}],goldEconomy:{interestRatePercent:6}};
  let writes=0,failedRead=false,failedWrite=false;
  const dom={
    hourlyWageInput:{value:'',events:{},addEventListener(type,fn){this.events[type]=fn;}},
    hourlyWageForm:{dataset:{},events:{},addEventListener(type,fn){this.events[type]=fn;}},
    hourlyWageStatus:{textContent:'',style:{}}
  };
  const coreApi={
    STORAGE_KEY:'taskpoints_v1',
    loadAppState(){if(failedRead)throw Error('load failed');return {state:copy(state)};},
    readTaskPointsStoredState(){return copy(state);},
    saveAppState(patch,opts){
      assert.equal(opts.immediateWrite,true);
      assert.equal(opts.userInitiated,true);
      writes++;
      if(!failedWrite)state={...state,...patch};
      return{state:copy(state)};
    }
  };
  const context={
    document:{readyState:'complete',getElementById:id=>dom[id]||null},
    TaskPointsCore:coreApi,console:{warn(){}},module:{exports:{}}
  };
  context.window=context;
  vm.runInNewContext(source,context,{filename:'hourly_wage_settings.js'});
  return {api:context.TaskPointsHourlyWageSettings,dom,get:()=>copy(state),
    count:()=>writes,failedRead:v=>{failedRead=v;},failedWrite:v=>{failedWrite=v;},
    submit(){dom.hourlyWageForm.events.submit({preventDefault(){}});}};
}

test('Dedicated wage editor preserves existing Settings panels',()=>{
  assert.match(html,/id="hourlyWageSettingsSection"/);
  assert.match(html,/id="hourlyWageInput" type="number" inputmode="decimal" min="0" step="0.01"/);
  assert.match(html,/hourly_wage_settings\.js\?v=/);
  for(const id of ['dataManagementSection','goldInterestSettingsSection',
    'scoringSettingsSection','healthDataManagerSection','settingsImportInput']) assert.ok(html.includes(id));
});

test('Wage saves without altering other state; zero and reload are supported',()=>{
  const h=fixture(),initial=h.get();
  assert.equal(h.dom.hourlyWageInput.value,'');
  h.dom.hourlyWageInput.value='29.50';h.submit();
  assert.equal(h.get().hourlyWage,29.5);
  assert.match(h.dom.hourlyWageStatus.textContent,/saved: \$29\.50/);
  for(const key of ['tasks','completions','habits','matchups','goldEconomy'])
    assert.deepEqual(h.get()[key],initial[key]);
  assert.equal(h.api.init(),false);
  h.dom.hourlyWageInput.value='0';h.submit();
  assert.equal(h.get().hourlyWage,0);
});

test('Invalid inputs do not write, and blank entry clears wage',()=>{
  const h=fixture();
  for(const invalid of ['-5','1.234','abc','1e3']) {
    h.dom.hourlyWageInput.value=invalid;h.submit();
    assert.equal(h.count(),0,invalid);
  }
  h.dom.hourlyWageInput.value='19.25';h.submit();
  h.dom.hourlyWageInput.value='';h.submit();
  assert.equal(h.get().hourlyWage,null);
  assert.match(h.dom.hourlyWageStatus.textContent,/cleared/);
});

test('Unavailable storage and rejected saves fail closed',()=>{
  const h=fixture();
  h.failedRead(true);h.dom.hourlyWageInput.value='42';h.submit();
  assert.equal(h.count(),0);
  h.failedRead(false);h.failedWrite(true);h.submit();
  assert.match(h.dom.hourlyWageStatus.textContent,/Could not verify/);
  assert.equal(h.get().hourlyWage,undefined);
});

test('Existing full-app state normalization and merge preserve scalar fields',()=>{
  assert.match(core,/function normalizeState\(s\)\s*\{[\s\S]*?const normalized = \{\s*\.\.\.src,/);
  assert.match(core,/const mergedSnapshot = deepMerge\(existing, nextState \|\| \{\}\)/);
  assert.match(core,/function normalizeImportedFullBackupState\(/);
  assert.match(core,/function compactStateForLocalStorage\(/);
});
