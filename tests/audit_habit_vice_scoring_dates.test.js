;(function testSuite() {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const audit = require('../audit_habit_vice_scoring_dates.js');
  const toDay = date => date.toISOString().slice(0,10);
  const day = '2026-11-03';
  const vice = (stamp, more = {}) => ({id:'habit:vice3:'+day,source:'vice',habitId:'vice3',dayKey:day,points:2,completedAtISO:stamp,...more});
  const verify = (active,saved,extras={}) => audit.buildHabitViceScoringDateAudit({completions:active},{dateKey:toDay,selectedDateKey:day,savedCompletions:saved,...extras});
  test('backdated vice: saved timestamp is exposed even when loaded totals are repaired',()=>{
    const wrong=vice('2026-11-04T12:00:00Z'), repaired=vice('2026-11-03T12:00:00Z');
    const result=verify([repaired],[wrong]);
    assert.equal(result.status,'WARN');
    assert.match(result.details.join(' '),/SAVED RECORD.*2 pts.*2026-11-03.*2026-11-04/);
    assert.equal(wrong.completedAtISO,'2026-11-04T12:00:00Z');
  });
  test('active date mismatch is a failure',()=>{
    const result=verify([vice('2026-11-04T12:00:00Z')],[vice('2026-11-04T12:00:00Z')]);
    assert.equal(result.status,'FAIL');
    assert.match(result.details[0],/ACTIVE ERROR/);
  });
  test('correct timestamps pass',()=>{
    assert.equal(verify([vice('2026-11-03T12:00:00Z')],[vice('2026-11-03T12:00:00Z')]).status,'PASS');
  });
  test('missing timestamp and explicit dateKey fallback fail, unrelated task source ignored',()=>{
    const missing=vice(null,{dayKey:undefined,dateKey:day,source:'habit'});
    const task=vice('2026-11-04T12:00:00Z',{source:'task'});
    const result=verify([missing,task],[]);
    assert.equal(result.status,'FAIL');
    assert.equal(result.details.length,1);
    assert.match(result.details[0],/missing\/invalid/);
  });
  test('history-wide scan catches affected days other than selected date',()=>{
    const historic=vice('2026-10-28T12:00:00Z',{dayKey:'2026-10-27',points:4});
    const result=verify([],[historic]);
    assert.equal(result.status,'WARN');
    assert.match(result.actual,/Affecting 2026-11-03: 0/);
    assert.match(result.details[0],/2026-10-27.*2026-10-28/);
  });
  test('unreadable saved scan produces warning instead of silent pass',()=>{
    const result=verify([],null,{savedReadError:'decode failed'});
    assert.equal(result.status,'WARN');
    assert.match(result.details.join(' '),/decode failed/);
  });
  test('audit page wires the check and preserves previous parity checks',()=>{
    const html=fs.readFileSync(path.join(__dirname,'..','audit.html'),'utf8');
    assert.match(html,/<script src="audit_habit_vice_scoring_dates\.js"><\/script>/);
    assert.match(html,/checks\.push\(window\.TaskPointsAuditHabitViceScoringDates\.buildHabitViceScoringDateAudit/);
    assert.match(html,/daily-total-parity/);
    assert.match(html,/you-matchup-scores/);
    assert.match(html,/buildHabitLedgerConsistencyAudit/);
  });
})();
