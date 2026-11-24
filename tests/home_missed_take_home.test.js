const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function extract(name) {
  const begin = home.indexOf('function ' + name + '(');
  assert.notEqual(begin, -1, name + ' exists');
  const start = home.indexOf('{', begin);
  let depth = 0;
  for (let i = start; i < home.length; i++) {
    if (home[i] === '{') depth++;
    if (home[i] === '}' && --depth === 0) return home.slice(begin, i + 1);
  }
  throw Error('Unclosed helper: ' + name);
}
const context = {
  dateKey: d => [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),
  console
};
vm.createContext(context);
vm.runInContext([
  'const HOME_WORK_HOURS_GOAL=40;',
  extract('calculateHomeWeeklyWorkHours'),
  extract('calculateHomeMissedTakeHome'),
  'this.weekly=calculateHomeWeeklyWorkHours;',
  'this.missed=calculateHomeMissedTakeHome;'
].join('\n'),context);

const entry=(day,hours,score=5)=>({
 title:'Work Score ('+score+') — Hours '+hours,
 source:'work', workHours:hours, completedAtISO:day+'T12:00:00.000Z'
});
const weekly=(entries,day='2026-11-28')=>context.weekly(entries,new Date(day+'T12:00:00'));

test('New missed-pay amount appears immediately beside logged hours while existing controls remain',()=>{
  const widget = home.match(/<section id="homeWorkHoursSection"[\s\S]*?<\/section>/)?.[0]||'';
  for(const id of ['homeWorkHoursLogged','homeWorkMissedTakeHome',
    'homeWorkHoursRemaining','homeWorkHoursProgress','homeWorkHoursAverage',
    'homeWorkHoursWeek','homeWorkHoursStatus'])
    assert.match(widget,new RegExp('id="'+id+'"'));
  assert.ok(widget.indexOf('homeWorkHoursLogged')<widget.indexOf('homeWorkMissedTakeHome'));
  assert.ok(widget.indexOf('homeWorkMissedTakeHome')<widget.indexOf('homeWorkHoursRemaining'));
  assert.match(css,/\.home-work-hours-missed-value\s*\{/);
  assert.match(css,/grid-template-columns:\s*minmax\(0,\s*0\.8fr\)\s*minmax\(0,\s*1\.2fr\)\s*minmax\(0,\s*0\.85fr\)/);
});

test('Unworked hours times after-tax hourly wage, not entire 40-hour paycheck',()=>{
  const result=weekly([entry('2026-11-23',8),entry('2026-11-24',8),
    entry('2026-11-25',8),entry('2026-11-26',8),entry('2026-11-27',5)]);
  assert.equal(result.logged,37);
  assert.equal(result.remaining,3);
  assert.equal(context.missed(result.remaining,25,20),60);
  assert.equal(context.missed(1,25,20),20);
});

test('Missing wage or tax is unknown rather than zero; explicit zero values are valid',()=>{
  assert.equal(context.missed(40,null,20),null);
  assert.equal(context.missed(40,25,undefined),null);
  assert.equal(context.missed(40,'',20),null);
  assert.equal(context.missed(40,25,''),null);
  assert.equal(context.missed(40,0,20),0);
  assert.equal(context.missed(40,25,0),1000);
});

test('40 hours and overtime including 79 hours never show negative missed money',()=>{
  for(const hours of [40,42.5,79]){
    const result=weekly([entry('2026-11-28',hours)]);
    assert.equal(result.remaining,0);
    assert.equal(context.missed(result.remaining,30,18.5),0);
  }
});

test('Fractional hours, withholding boundaries and invalid rates',()=>{
  const result=weekly([entry('2026-11-25',8),entry('2026-11-26',7.75)]);
  assert.equal(result.remaining,24.25);
  assert.equal(context.missed(result.remaining,29.75,22.5),559.11);
  assert.equal(context.missed(40,25,100),0);
  for(const args of [[-1,25,20],[8,-3,20],[8,25,-1],[8,25,101],[8,NaN,10]]){
    assert.equal(context.missed(...args),null);
  }
});

test('Live display updates for changed logged hours and pay settings without any writes',()=>{
  class FixedDate extends Date {
    constructor(...args){super(...(args.length?args:[new Date('2026-11-28T12:00:00')]));}
  }
  const entries=[entry('2026-11-27',39)];
  const state={hourlyWage:30,takeHomeTaxPercent:20};
  const nodes=new Map(['homeWorkHoursLogged','homeWorkMissedTakeHome','homeWorkHoursRemaining',
    'homeWorkHoursProgress','homeWorkHoursProgressTrack','homeWorkHoursWeek',
    'homeWorkHoursAverage','homeWorkHoursStatus'].map(id=>[id,{
      textContent:'',style:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;}
    }]));
  const document={documentElement:{classList:{toggle(){}}}};
  const render=new Function('Date','document','$','getDerived','state',
    'calculateHomeWeeklyWorkHours','calculateHomeMissedTakeHome','formatHomeWorkHours',
    extract('renderHomeWorkHours')+'\nreturn renderHomeWorkHours;')(
      FixedDate,document,id=>nodes.get(id),()=>({workEntries:entries}),state,
      context.weekly,context.missed,v=>Number(v.toFixed(2)).toLocaleString('en-US',{maximumFractionDigits:2})
    );
  render();
  assert.equal(nodes.get('homeWorkHoursLogged').textContent,'39');
  assert.equal(nodes.get('homeWorkMissedTakeHome').textContent,'$24.00');
  entries[0].workHours=37;
  render();
  assert.equal(nodes.get('homeWorkMissedTakeHome').textContent,'$72.00');
  state.takeHomeTaxPercent=25;
  render();
  assert.equal(nodes.get('homeWorkMissedTakeHome').textContent,'$67.50');
  state.hourlyWage=null;
  render();
  assert.equal(nodes.get('homeWorkMissedTakeHome').textContent,'—');
  assert.doesNotMatch(extract('renderHomeWorkHours'),/\blocalStorage\b|\bsave\s*\(/);
});

test('Sunday hiding, 40-hour goal and midnight re-render remain intact',()=>{
  assert.match(home,/html\.tp-home-sunday #homeWorkHoursSection/);
  assert.match(home,/function startHomeWorkHoursWeekRollover\(\)/);
  assert.match(home,/renderHomeWorkHours\(\)/);
  assert.match(home,/const HOME_WORK_HOURS_GOAL = 40/);
});