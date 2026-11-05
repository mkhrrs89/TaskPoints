const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* Quick mobile task rescheduling:');
const end = html.indexOf('// Mobile-only left-swipe gesture.', start);
assert.ok(start >= 0 && end > start, 'reschedule calendar and date-apply helpers exist');
const source = html.slice(start, end);

function fixture() {
  const task = {
    id: 'one', title: 'Pay bill', dueDateISO: '2026-11-04',
    originalDueDateISO: '2026-11-04', postponedDays: 0,
    updatedAtISO: '2026-11-04T10:00:00.000Z', recurrence: { mode: 'weekly' }
  };
  const frames = [];
  const timers = new Map();
  let nextTimer = 1;
  const calls = { saves: [], renders: 0, critical: 0, alerts: 0, writable: true, throwSave: false };
  const context = {
    state: {tasks:[task]}, Date, Math, console, escapeHtml: x => x,
    fromKey: key => {
      const [y,m,d] = key.split('-').map(Number);
      return new Date(y,m-1,d);
    },
    dateKey: date => [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-'),
    todayKey: () => '2026-11-04',
    addDays: (date,days) => new Date(date.getFullYear(),date.getMonth(),date.getDate()+days),
    isTaskTrashed:()=>false, getTaskStatus:()=> 'active',
    assertTaskActionMutationWritable:()=>calls.writable,
    trackDueDatePush(t,oldDay,newDay) { if(newDay>oldDay) t.postponedDays+=5; },
    persistTaskActionMutation(t,action) {
      if(calls.throwSave)throw new Error('storage locked');
      calls.saves.push({action,date:t.dueDateISO});
    },
    renderTasks(){calls.renders++;},
    alert(){calls.alerts++;},
    window:{
      requestAnimationFrame(callback){ frames.push(callback); },
      updateCriticalTasksIsland(){calls.critical++;}
    },
    setTimeout(callback,delay) { const id=nextTimer++; timers.set(id,{callback,delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: {getElementById:()=>null},
    $:()=>null
  };
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'task-reschedule-calendar.js'});
  vm.runInContext("taskRescheduleTaskId='one';",context);
  const flushFrame = () => { for(const cb of frames.splice(0)) cb(); };
  const flushTimers = () => {
    const queued=Array.from(timers.values());
    timers.clear();
    queued.forEach(x=>x.callback());
  };
  return {context,task,calls,frames,timers,flushFrame,flushTimers};
}

test('one tap reschedules via existing journal and rerenders task list',()=>{
 const f=fixture();
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-09'),true);
 assert.equal(f.task.dueDateISO,'2026-11-04', 'do not block the first paint with persistence');
 assert.equal(f.calls.saves.length,0, 'selected-day feedback paints before journal work');
 f.flushFrame();
 assert.equal(f.calls.saves.length,0, 'first frame only draws the acknowledgement');
 f.flushFrame();
 assert.equal(f.task.dueDateISO,'2026-11-09');
 assert.equal(f.task.postponedDays,5);
 assert.equal(f.task.recurrence.mode,'weekly');
 assert.deepEqual(f.calls.saves,[{action:'swipe-right-reschedule',date:'2026-11-09'}]);
 assert.equal(f.calls.renders,1);
 assert.equal(f.calls.critical,1);
 assert.equal(f.timers.size,1, 'brief saved feedback stays visible before closing');
 f.flushTimers();
});

test('invalid calendar date never changes task or writes',()=>{
 const f=fixture();
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-31'),false);
 assert.equal(f.task.dueDateISO,'2026-11-04');
 assert.equal(f.calls.saves.length,0);
});

test('unchanged date closes without writes',()=>{
 const f=fixture();
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-04'),true);
 assert.equal(f.calls.saves.length,0);
 assert.equal(f.calls.renders,0);
 assert.equal(f.timers.size,1, 'unchanged date is acknowledged before closing');
 f.flushTimers();
});

test('write lock blocks rescheduling without changing task',()=>{
 const f=fixture();f.calls.writable=false;
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-09'),true);
 f.flushFrame(); f.flushFrame();
 assert.equal(f.task.dueDateISO,'2026-11-04');
 assert.equal(f.calls.saves.length,0);
});

test('journal failure rolls the due date and metadata back',()=>{
 const f=fixture();f.calls.throwSave=true;
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-09'),true);
 f.flushFrame(); f.flushFrame();
 assert.equal(f.task.dueDateISO,'2026-11-04');
 assert.equal(f.task.postponedDays,0);
 assert.equal(f.task.originalDueDateISO,'2026-11-04');
 assert.equal(f.task.updatedAtISO,'2026-11-04T10:00:00.000Z');
 assert.equal(f.calls.alerts,1);
});

test('completed and trashed tasks cannot be rescheduled',()=>{
 const f=fixture();f.task.completedAtISO='2026-11-04T15:00:00Z';
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-09'),false);
 assert.equal(f.calls.saves.length,0);
});

test('calendar offers month navigation, day buttons and immediate save',()=>{
 assert.match(source,/data-task-reschedule-action="previous"/);
 assert.match(source,/data-task-reschedule-action="next"/);
 assert.match(source,/data-task-reschedule-date/);
 assert.match(source,/applyTaskRescheduleDate\(chosen\)/);
 assert.match(source,/aria-modal="true"/);
 assert.match(html,/styles\.css\?v=20261104-task-swipe-feedback-2/);
 assert.match(source,/id="taskRescheduleFeedback"/);
 assert.match(source,/setTaskRescheduleFeedback\(newDateKey, 'saved'\)/);
 assert.match(source,/queueTaskRescheduleAfterPaint/);
});

test('double-taps cannot queue duplicate writes while selected-date animation plays', () => {
 const f=fixture();
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-09'),true);
 assert.equal(f.context.applyTaskRescheduleDate('2026-11-10'),false);
 f.flushFrame();f.flushFrame();
 assert.equal(f.calls.saves.length,1);
 assert.equal(f.task.dueDateISO,'2026-11-09');
});

test('calendar keeps durable result hidden until guarded save succeeds', () => {
 const f=fixture();
 f.context.applyTaskRescheduleDate('2026-11-09');
 f.flushFrame();
 assert.equal(f.task.dueDateISO,'2026-11-04');
 assert.equal(f.calls.saves.length,0);
 f.flushFrame();
 assert.equal(f.calls.saves.length,1);
 assert.equal(f.timers.size,1);
});

test('feedback pulse honors reduced-motion preference without removing confirmation', () => {
 const style=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
 assert.match(style,/task-reschedule-day\.is-picking/);
 assert.match(style,/@keyframes task-reschedule-tap/);
 assert.match(style,/@media \(prefers-reduced-motion: reduce\)/);
 assert.match(style,/task-reschedule-day\.is-saved/);
});

test('calendar cannot close during the short pre-save paint window', () => {
 const f=fixture();
 f.context.applyTaskRescheduleDate('2026-11-09');
 f.context.closeTaskRescheduleCalendar();
 f.flushFrame(); f.flushFrame();
 assert.equal(f.calls.saves.length,1);
 assert.equal(f.task.dueDateISO,'2026-11-09');
});

test('unsaved selections do not show a success checkmark', () => {
 const style=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
 assert.match(style,/task-reschedule-day\.is-saved::after/);
 assert.doesNotMatch(style,/task-reschedule-day\.is-picking::after/);
 assert.match(source,/if \(stage === 'error'\) \{/);
 assert.match(source,/chosen\.classList\.remove\('is-picking', 'is-saved'\)/);
});
