const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_completion_backup_recovery.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function install() {
  const context = { console, JSON, Date, Map, Set, Number, String, Object, Array, structuredClone: clone, module:{exports:{}}, setTimeout(){} };
  context.window = context; context.globalThis = context;
  vm.runInNewContext(source, context, { filename:'habit_completion_backup_recovery.js' });
  return context.TaskPointsHabitCompletionBackupRecovery;
}
function fixture() {
  return {
    habits:[
      { id:'h1', name:'Art', category:'habit', pointsPerDay:0.5, doneKeys:['2026-07-01','2026-07-02'], failedKeys:[], iceKeys:[] },
      { id:'v1', name:'No Weed', category:'vice', doneKeys:['2026-07-03'], failedKeys:[], iceKeys:[] }
    ],
    completions:[{ id:'existing', source:'habit', habitId:'h1', dayKey:'2026-07-02', completedAtISO:'2026-07-02T12:00:00.000Z', points:0.5 }],
    matchups:[{id:'m'}], gameHistory:[{id:'g'}]
  };
}

test('restores exact historical points instead of current habit value', () => {
  const api=install(), current=fixture();
  const row={ id:'old', source:'habit', habitId:'h1', dayKey:'2026-07-01', completedAtISO:'2026-07-01T12:00:00.000Z', points:2 };
  const plan=api.buildRecoveryPlan(current,[{id:'backup',label:'Backup',state:{completions:[row]}}]);
  assert.equal(plan.missingCount,2);
  assert.equal(plan.recoverable.length,1);
  assert.equal(plan.recoverable[0].points,2);
  const result=api.applyRecoveryPlan(current,plan);
  assert.equal(result.added,1);
  assert.deepEqual(result.state.completions.find((item)=>item.id==='old'),row);
  assert.deepEqual(result.state.matchups,current.matchups);
  assert.deepEqual(result.state.gameHistory,current.gameHistory);
});

test('identical backup copies agree while differing exact rows are blocked', () => {
  const api=install(), current=fixture();
  const row={ id:'old', source:'habit', habitId:'h1', dayKey:'2026-07-01', points:2 };
  let plan=api.buildRecoveryPlan(current,[{id:'a',state:{completions:[row]}},{id:'b',state:{completions:[clone(row)]}}]);
  assert.equal(plan.recoverable.length,1);
  plan=api.buildRecoveryPlan(current,[{id:'a',state:{completions:[row]}},{id:'b',state:{completions:[{...row,points:1}]}}]);
  assert.equal(plan.recoverable.length,0);
  assert.equal(plan.conflicts.length,1);
});

test('failed-date and ID-collision recovery are blocked', () => {
  const api=install(), current=fixture();
  const row={ id:'old', source:'habit', habitId:'h1', dayKey:'2026-07-01', points:2 };
  current.habits[0].failedKeys.push('2026-07-01');
  let plan=api.buildRecoveryPlan(current,[{id:'a',state:{completions:[row]}}]);
  assert.equal(plan.recoverable.length,0);
  assert.match(plan.conflicts[0].reason,/marked failed/);
  current.habits[0].failedKeys=[];
  current.completions.push({id:'old',source:'task',taskId:'t1',points:3,completedAtISO:'2026-07-04T12:00:00.000Z'});
  plan=api.buildRecoveryPlan(current,[{id:'a',state:{completions:[row]}}]);
  assert.equal(plan.recoverable.length,0);
  assert.match(plan.conflicts[0].reason,/already used/);
});

test('missing rows are never manufactured when backups do not contain them', () => {
  const api=install(), current=fixture();
  const plan=api.buildRecoveryPlan(current,[{id:'empty',state:{completions:[]}}]);
  assert.equal(plan.recoverable.length,0);
  assert.equal(plan.notFound.length,2);
});

test('apply refuses stale preview after habit/completion state changes', () => {
  const api=install(), current=fixture();
  const row={ id:'old', source:'habit', habitId:'h1', dayKey:'2026-07-01', points:2 };
  const plan=api.buildRecoveryPlan(current,[{id:'a',state:{completions:[row]}}]);
  const changed=clone(current); changed.habits[0].doneKeys.push('2026-07-05');
  assert.throws(()=>api.applyRecoveryPlan(changed,plan),/changed after the scan/);
});

test('audit page injects backup recovery after the habit ledger stack', () => {
  assert.match(worker, /habit_completion_backup_recovery\.js\?v=20260921-1/);
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_stale_guard.js?v=20260803-3')
      < worker.indexOf('/habit_completion_backup_recovery.js?v=20260921-1')
  );
});
