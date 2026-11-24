const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'settings.html'),'utf8');
const source = fs.readFileSync(path.join(root,'tax_withholding_settings.js'),'utf8');
const wageSource = fs.readFileSync(path.join(root,'hourly_wage_settings.js'),'utf8');
const coreSource = fs.readFileSync(path.join(root,'scoring_core.js'),'utf8');
const clone = x => JSON.parse(JSON.stringify(x));

function harness(initial={}) {
  let state = {
    tasks:[{id:'t'}], completions:[{id:'c'}], habits:[{id:'h'}],
    matchups:[{id:'m'}], goldEconomy:{interestRatePercent:6},
    hourlyWage:28.5, ...initial
  };
  let writes=0, failRead=false, failWrite=false;
  const elements = {
    takeHomeTaxPercentInput:{value:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}},
    takeHomeTaxPercentForm:{dataset:{},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}},
    takeHomeTaxPercentStatus:{textContent:'',style:{}}
  };
  const core={
    STORAGE_KEY:'taskpoints_v1',
    loadAppState(){if(failRead)throw Error('unreadable state');return{state:clone(state)};},
    readTaskPointsStoredState(){return clone(state);},
    saveAppState(patch,options){
      assert.equal(options.userInitiated,true);
      assert.equal(options.immediateWrite,true);
      assert.deepEqual(Object.keys(patch),['takeHomeTaxPercent']);
      writes++;
      if(!failWrite)state={...state,...patch};
      return{state:clone(state)};
    }
  };
  const context={
    document:{readyState:'complete',getElementById:id=>elements[id]||null},
    TaskPointsCore:core,console:{warn(){}},module:{exports:{}}
  };
  context.window=context;
  vm.runInNewContext(source,context,{filename:'tax_withholding_settings.js'});
  return{
    api:context.TaskPointsTaxWithholdingSettings, elements,
    state:()=>clone(state),writes:()=>writes,
    failRead(v){failRead=v;},failWrite(v){failWrite=v;},
    submit(){elements.takeHomeTaxPercentForm.listeners.submit({preventDefault(){}});}
  };
}

test('Tax withholding input is alongside Hourly Wage, retaining existing wage form',()=>{
  assert.match(html,/id="hourlyWageSettingsSection"/);
  assert.match(html,/id="hourlyWageSaveBtn"[^>]*>Save Wage/);
  assert.match(html,/id="takeHomeTaxPercentInput" type="number" inputmode="decimal" min="0" max="100" step="0.01"/);
  assert.match(html,/id="takeHomeTaxPercentSaveBtn"[^>]*>Save Tax Rate/);
  assert.match(html,/tax_withholding_settings\.js\?v=/);
  assert.match(wageSource,/hourlyWage: parsed\.amount/);
});

test('Tax save retains wage and other protected data',()=>{
  const h=harness(),before=h.state();
  h.elements.takeHomeTaxPercentInput.value='23.75';h.submit();
  assert.equal(h.state().takeHomeTaxPercent,23.75);
  assert.equal(h.state().hourlyWage,28.5);
  assert.match(h.elements.takeHomeTaxPercentStatus.textContent,/saved: 23\.75%/);
  for(const key of ['tasks','completions','habits','matchups','goldEconomy'])
    assert.deepEqual(h.state()[key],before[key]);
  assert.equal(h.api.init(),false,'no duplicate listeners');
  const again=harness(h.state());
  assert.equal(again.elements.takeHomeTaxPercentInput.value,'23.75');
});

test('Invalid tax percentages do not write',()=>{
  const h=harness();
  for(const invalid of ['-2','100.01','19.999','1e3','abc']){
    h.elements.takeHomeTaxPercentInput.value=invalid;h.submit();
    assert.equal(h.writes(),0,invalid);
  }
  h.elements.takeHomeTaxPercentInput.value='0';h.submit();
  assert.equal(h.state().takeHomeTaxPercent,0);
  h.elements.takeHomeTaxPercentInput.value='100';h.submit();
  assert.equal(h.state().takeHomeTaxPercent,100);
  h.elements.takeHomeTaxPercentInput.value='';h.submit();
  assert.equal(h.state().takeHomeTaxPercent,null);
  assert.equal(h.state().hourlyWage,28.5);
  assert.match(h.elements.takeHomeTaxPercentStatus.textContent,/cleared/);
});

test('Read failures and unverified writes do not claim success',()=>{
  const h=harness({takeHomeTaxPercent:12});
  h.failRead(true);h.elements.takeHomeTaxPercentInput.value='30';h.submit();
  assert.equal(h.writes(),0);
  h.failRead(false);h.failWrite(true);h.submit();
  assert.equal(h.state().takeHomeTaxPercent,12);
  assert.match(h.elements.takeHomeTaxPercentStatus.textContent,/Could not verify/);
});

test('Full app backup normalization preserves independent wage and tax fields',()=>{
  assert.match(coreSource,/function normalizeState\(s\)\s*\{[\s\S]*?const normalized = \{\s*\.\.\.src,/);
  assert.match(coreSource,/const mergedSnapshot = deepMerge\(existing, nextState \|\| \{\}\)/);
  assert.match(coreSource,/function normalizeImportedFullBackupState\(/);
  assert.match(coreSource,/function compactStateForLocalStorage\(/);
  assert.match(source,/saveAppState\(\{ takeHomeTaxPercent: parsed\.percent \}/);
});