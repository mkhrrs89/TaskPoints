const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const journal = fs.readFileSync(path.join(__dirname, '..', 'task_mutation_journal.js'), 'utf8');

function extract(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end,a);
  assert.ok(a>=0 && b>a, 'Home helper not found: '+start);
  return html.slice(a,b);
}
const apply = extract('function applyPostponeToTask(task)', '  function postponeTask(id)');
const bulk = extract('function postponeAllOverdueTasks()', 'function wontDoMain(id)');
const action = apply+'\n'+bulk+'\nthis.postponeAllOverdueTasks=postponeAllOverdueTasks;';

function harness(options={}) {
  const tasks = [
    {id:'a',title:'A',dueDateISO:'2026-11-17',postponedDays:1,updatedAtISO:'old'},
    {id:'b',title:'B',dueDateISO:'2026-11-20',postponedDays:0},
    {id:'today',dueDateISO:'2026-11-22'},
    {id:'future',dueDateISO:'2026-11-25'},
    {id:'hidden',dueDateISO:'2026-11-10',hidden:true},
    {id:'done',dueDateISO:'2026-11-10',completedAtISO:'2026-11-10T17:00:00Z'},
    {id:'trashed',dueDateISO:'2026-11-10',status:'trashed'},
    {id:'wontdo',dueDateISO:'2026-11-10',status:'wontdo'}
  ];
  const state={tasks};
  let renderCount=0,criticalCount=0,saveCount=0,writeCount=0,alerts=0;
  const writes=[];
  const context = {
    state,
    todayKey:()=> '2026-11-22',
    isTaskTrashed:t=>t.status==='trashed',
    getTaskStatus:t=>t.status||'active',
    trackDueDatePush(task,from,to) {
      if(!task.originalDueDateISO)task.originalDueDateISO=to||from||null;
      const delta=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000;
      if(delta>0)task.postponedDays=(Number(task.postponedDays)||0)+delta;
    },
    assertTaskActionMutationWritable:()=>options.preflightFails !== true,
    TaskPointsCore:options.noJournal ? {} : {
      journalTaskMutations(rows) {
        writeCount++;
        if(options.failWrite)throw Error('unavailable');
        writes.push(JSON.parse(JSON.stringify(rows)));
      }
    },
    save:()=>{saveCount++;return true;},
    renderTasks:()=>{renderCount++;},
    window:{updateCriticalTasksIsland:()=>{criticalCount++;},TaskPointsPerf:{mark(){}}},
    console:{warn(){}},
    alert(){alerts++;}
  };
  vm.runInNewContext(action,context,{filename:'HomePostponeAll.js'});
  return {state,run:context.postponeAllOverdueTasks,writes,
    metrics:()=>({renderCount,criticalCount,saveCount,writeCount,alerts})};
}

test('Postpone All journals just eligible overdue tasks in one write before UI update',()=>{
  const h=harness();
  h.run();
  const m=h.metrics();
  assert.deepEqual({writes:m.writeCount,fullSaves:m.saveCount,renders:m.renderCount,critical:m.criticalCount},
    {writes:1,fullSaves:0,renders:1,critical:1});
  assert.deepEqual(Array.from(h.writes[0],t=>t.id),['a','b']);
  assert.equal(h.state.tasks[0].dueDateISO,'2026-11-22');
  assert.equal(h.state.tasks[0].originalDueDateISO,'2026-11-22');
  assert.equal(h.state.tasks[0].postponedDays,6);
  assert.equal(h.state.tasks[1].postponedDays,2);
  for(const task of h.state.tasks.slice(2))assert.notEqual(task.dueDateISO,'2026-11-22',task.id);
});

test('Failed preflight or journal write never leaves a partially postponed task',()=>{
  for(const config of [{preflightFails:true},{failWrite:true}]){
    const h=harness(config),before=JSON.stringify(h.state.tasks);
    h.run();
    assert.equal(JSON.stringify(h.state.tasks),before);
    assert.equal(h.metrics().renderCount,0);
    assert.equal(h.metrics().saveCount,0);
  }
});

test('Journal-free environments keep the original full save fallback',()=>{
  const h=harness({noJournal:true});h.run();
  assert.equal(h.metrics().saveCount,1);
  assert.equal(h.metrics().writeCount,0);
  assert.equal(h.metrics().renderCount,1);
});

test('Postpone All remains connected to mobile button and atomic batch journal',()=>{
  assert.match(html,/data-task-action="postpone-all-overdue"/);
  assert.match(html,/case 'postpone-all-overdue':\s*postponeAllOverdueTasks\(\)/);
  assert.match(bulk,/TaskPointsCore\.journalTaskMutations\(postponedTasks\)/);
  assert.doesNotMatch(bulk,/postponedTasks\.forEach[\s\S]*?journalTaskMutation\(/);
  assert.match(journal,/core\.journalTaskMutations = journalTaskMutations;/);
});
