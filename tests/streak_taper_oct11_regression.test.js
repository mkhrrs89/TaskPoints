'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('scoring_core.js','utf8');
function extract(name) {
  const start = source.indexOf('function '+name+'(');
  assert.ok(start >= 0, 'missing production function '+name);
  const open = source.indexOf('{',start);
  let depth=0, quote='', escape=false;
  for(let i=open;i<source.length;i++){
    const c=source[i];
    if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='{')depth++;
    if(c==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw Error('unclosed '+name);
}
const context={Math,Number,Set,Array,Date, HABIT_STREAK_MULTIPLIER_RATE:1.01,HABIT_STREAK_TAPER_START_DATE_KEY:'2026-10-11'};
vm.createContext(context);
vm.runInContext([
  extract('habitStreakMultiplierForDay'),
  extract('getHabitStreakDayForKey'),
  extract('getHabitStreakMultiplierPoints')
].join('\n'),context);
context.addDaysToDateKey=(key,delta)=>{const d=new Date(key+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);};
context.getHabitForCompletion=(entry,state)=>state.habits.find(h=>h.id===entry.habitId);
context.getCompletionDayKey=entry=>entry.dayKey;
context.getHabitCompletionFraction=()=>1;
context.roundPoints=(x)=>Math.round((x+Number.EPSILON)*100)/100;
function streak(start,count){let d=new Date(start+'T12:00:00Z');const keys=[];for(let i=0;i<count;i++){keys.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()+1);}return keys;}
function score(dayKey,keys,base=10){const habit={id:'test',streakMultiplierEnabled:true,streakMultiplierStartDateKey:'2026-01-01',pointsPerDay:base,doneKeys:keys};return context.getHabitStreakMultiplierPoints({source:'habit',habitId:'test',dayKey,points:base},{habits:[habit]});}
const round=x=>Math.round((x+Number.EPSILON)*100)/100;
test('historical Oct 10 score remains old 1% for day 110',()=>{
  const keys=streak('2026-06-23',110);assert.equal(keys.at(-1),'2026-10-10');
  assert.equal(score('2026-10-10',keys),round(10*1.01**109));
});
test('grandfathered day 111 grows only 0.5% from earned day 110 multiplier',()=>{
  const keys=streak('2026-06-23',111);assert.equal(keys.at(-1),'2026-10-11');
  assert.equal(score('2026-10-11',keys),round(10*1.01**109*1.005));
});
test('taper boundaries and fresh streaks',()=>{
  for(const n of [99,100,101,110,111,199,200,201,300]){
    const expected=1.01**Math.min(n-1,99)*1.005**Math.min(Math.max(n-100,0),100)*1.0025**Math.max(n-200,0);
    assert.ok(Math.abs(context.habitStreakMultiplierForDay(n,'2026-10-11')-expected)<1e-9,'day '+n);
    assert.ok(Math.abs(context.habitStreakMultiplierForDay(n,'2026-10-10')-1.01**(n-1))<1e-9,'historical day '+n);
  }
});
test('half-point completion retains fractional base',()=>{
  const keys=streak('2026-06-23',111);
  assert.equal(score('2026-10-11',keys,5),round(5*1.01**109*1.005));
});
