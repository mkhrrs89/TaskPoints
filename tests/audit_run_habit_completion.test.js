const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'audit_run_habit_completion.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'audit.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
  return {
    habits: [{id: 'audit-habit', name: 'Run Audit', category: 'habit', pointsPerDay: 3,
      doneKeys: [], failedKeys: [], iceKeys: [], ...overrides}],
    completions: [{id: 'prior', source: 'habit', habitId: 'audit-habit', dayKey: '2026-11-17', points: 3}],
    tasks: [{id: 'keep-task'}], goldLedger: [{id: 'keep-gold', amount: 22}]
  };
}

function install(state = fixture(), options = {}) {
  const original = clone(state);
  let saved = clone(state), day = options.today || '2026-11-18';
  const pending = [], calls = {writes: 0, compact: 0, reads: 0};
  const core = {
    todayKey: () => day,
    habitCompletionId: (habitId, date) => 'habit:' + habitId + ':' + date,
    loadAppState() {
      calls.reads++;
      const copy = clone(saved);
      for (const delta of pending) {
        const habit = copy.habits.find(h => h.id === delta.habitId);
        if (!habit) continue;
        habit.doneKeys = [...new Set([...(habit.doneKeys || []), delta.dayKey])];
        habit.failedKeys = (habit.failedKeys || []).filter(x => x !== delta.dayKey);
        copy.completions = copy.completions.filter(c => c.habitId !== delta.habitId || c.dayKey !== delta.dayKey);
        copy.completions.unshift({
          id: 'habit:' + delta.habitId + ':' + delta.dayKey,
          habitId: delta.habitId, dayKey: delta.dayKey,
          source: 'habit', points: delta.completionPoints,
          completionFraction: delta.completionFraction
        });
      }
      return {state: copy};
    },
    writePendingHabitDelta(delta) {
      if (options.failWrite) throw new Error('simulated storage failure');
      calls.writes++;
      const idx = pending.findIndex(x => x.id === delta.id);
      if (idx >= 0) pending[idx] = clone(delta); else pending.push(clone(delta));
    },
    readPendingHabitDeltas() {return clone(pending);},
    schedulePendingHabitDeltaCompaction() {calls.compact++;}
  };
  const context = {console: {warn() {}}, TaskPointsCore: core, Date, String, Number, Array, Object, JSON};
  context.window = context; context.globalThis = context;
  vm.runInNewContext(source, context, {filename: 'audit_run_habit_completion.js'});
  return {api: context.TaskPointsAuditRunHabitCompletion, original, calls, pending,
    setDay: value => {day = value;}, saved: () => saved, core};
}

test('manual completed audit marks only active Run Audit habit for local today through verified journal', () => {
  const h = install(fixture({name: '  RUN   Audit  '}));
  const result = h.api.markForToday();
  assert.equal(result.status, 'completed');
  assert.equal(result.dayKey, '2026-11-18');
  assert.equal(h.calls.writes, 1);
  assert.equal(h.calls.compact, 1);
  assert.deepEqual(h.pending.map(x => ({
    id: x.id, habitId: x.habitId, dayKey: x.dayKey, source: x.source,
    status: x.status, done: x.done, completionFraction: x.completionFraction, points: x.completionPoints
  })), [{
    id: 'habit:audit-habit:2026-11-18', habitId: 'audit-habit', dayKey: '2026-11-18',
    source: 'habit', status: 'full', done: true, completionFraction: 1, points: 3
  }]);
  assert.deepEqual(h.saved(), h.original, 'journal-first process must not modify other saved records');
});

test('rerunning Audit the same day does not duplicate journal writes or award points twice', () => {
  const h = install();
  assert.equal(h.api.markForToday().status, 'completed');
  assert.equal(h.api.markForToday().status, 'already-complete');
  assert.equal(h.calls.writes, 1);
  assert.equal(h.pending.length, 1);
  assert.equal(h.calls.compact, 1);
});

test('completion is credited to the day the audit finishes, not the selected audited date', () => {
  const h = install();
  h.setDay('2026-11-19');
  assert.equal(h.api.markForToday().dayKey, '2026-11-19');
  assert.equal(h.pending[0].dayKey, '2026-11-19');
});

test('a half-completed Run Audit habit upgrades to full once', () => {
  const s = fixture({doneKeys: ['2026-11-18']});
  s.completions.push({id:'habit:audit-habit:2026-11-18',source:'habit',
    habitId:'audit-habit',dayKey:'2026-11-18',completionFraction:0.5,points:1.5});
  const h=install(s);
  assert.equal(h.api.markForToday().status,'completed');
  assert.equal(h.pending[0].completionFraction,1);
  assert.equal(h.api.markForToday().status,'already-complete');
  assert.equal(h.calls.writes,1);
});

test('already complete habit with a full canonical entry remains untouched', () => {
  const s=fixture({doneKeys:['2026-11-18']});
  s.completions.push({id:'habit:audit-habit:2026-11-18',source:'habit',
    habitId:'audit-habit',dayKey:'2026-11-18',completionFraction:1,points:3});
  const h=install(s);
  assert.equal(h.api.markForToday().status,'already-complete');
  assert.equal(h.calls.writes,0);
});

test('missing, retired, vice, or duplicate habit names fail closed without creating habits or completions', () => {
  for (const state of [
    fixture({name:'Unrelated'}),
    fixture({retired:true}),
    fixture({category:'vice'}),
    {...fixture(),habits:[fixture().habits[0],{...fixture().habits[0],id:'other'}]}
  ]) {
    const h=install(state);
    const outcome=h.api.markForToday();
    assert.ok(['missing','ambiguous'].includes(outcome.status));
    assert.equal(h.calls.writes,0);
    assert.deepEqual(h.saved(),h.original);
  }
});

test('invalid points and journal write failure cannot falsely mark the habit', () => {
  const bad=install(fixture({pointsPerDay:'not-a-number'}));
  assert.equal(bad.api.markForToday().status,'error');
  assert.equal(bad.calls.writes,0);
  const broken=install(fixture(),{failWrite:true});
  assert.equal(broken.api.markForToday().status,'error');
  assert.equal(broken.calls.writes,0);
  assert.equal(broken.pending.length,0);
});

test('Audit page loads helper and only user-initiated successful audit triggers habit completion', () => {
  assert.match(page, /<script src="audit_run_habit_completion\.js\?v=/);
  assert.match(page, /bindPress\('runAuditBtn', \(\) => runAudit\(\{ userInitiated: true \}\)\)/);
  assert.match(page, /\/\/ Auto-run on load for convenience\s+runAudit\(\)/);
  assert.match(page, /id="auditHabitCreditStatus"/);
  const start=page.indexOf('    function runAudit(options = {}) {');
  const end=page.indexOf('    function storeLastReport(',start);
  assert.ok(start>=0&&end>start);
  const block=page.slice(start,end);
  const seen=[];
  const elements={auditSummaryMeta:{textContent:''},auditHabitCreditStatus:{textContent:''}};
  let fail=false;
  const context={
    window:{TaskPointsAuditRunHabitCompletion:{markForToday(){seen.push('habit');return {status:'completed'};}}},
    $:id=>elements[id]||null,
    setAuditControlsDisabled:v=>seen.push('disabled:'+v),
    setStatus:v=>seen.push('status:'+v),
    setAuditProgressState:v=>seen.push('progress:'+v),
    executeAudit(){seen.push('audit');if(fail)throw Error('injected audit failure');},
    requestAnimationFrame:cb=>cb(),setTimeout:cb=>cb(),
    console:{error(){},warn(){}},String
  };
  vm.runInNewContext(block+';this.runAudit=runAudit;',context);
  context.runAudit();
  assert.equal(seen.filter(x=>x==='habit').length,0,'automatic page-load audit must not mark habit');
  seen.length=0;
  context.runAudit({userInitiated:true});
  assert.ok(seen.indexOf('progress:complete')>=0);
  assert.ok(seen.indexOf('habit')>seen.indexOf('progress:complete'));
  assert.equal(elements.auditHabitCreditStatus.textContent,'Run Audit habit marked complete for today.');
  seen.length=0;fail=true;
  context.runAudit({userInitiated:true});
  assert.ok(seen.includes('progress:error'));
  assert.ok(!seen.includes('habit'),'failed audits must never credit the habit');
});
