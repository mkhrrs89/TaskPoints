const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,'..','season.js'),'utf8');
function install() {
  const core = {normalizeState: s => s, dateKey: d => d.toISOString().slice(0,10),
    getChampionSummary: s => s?.derivedFinalsSummary || {championId:'',championName:''} };
  const ctx = { TaskPointsCore: core, console, URL, Date };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx, {filename:'season.js'});
  return ctx.TaskPointsSeason;
}
const archived = (id,champion,date) => ({
  id, name:'Season '+id, status:'finalized',
  startDate:date.slice(0,7)+'-01', endDate:date,
  championSummary:{championId:'p-'+id,championName:champion},
  series:{},finalPlacements:[]
});
const current = (status,start='2026-10-01',end='2026-10-31')=>({
  id:'s3',name:'Season Three',status,startDate:start,endDate:end,series:{},meta:{}
});

test('Off-season shows all past champions newest first while keeping current season tools',()=>{
  const ui=install(), html=ui.renderSeasonView({
    currentSeason:current('active'),
    seasonHistory:[archived('one','Alpha','2026-06-30'),archived('two','Beta','2026-08-31')]
  },{effectiveDateKey:'2026-11-23'});
  assert.match(html,/Trophy Case/);
  assert.ok(html.indexOf('Beta')<html.indexOf('Alpha'));
  assert.match(html,/Season Three/);
  assert.match(html,/Season Header/);
  assert.doesNotMatch(html,/Create New Season/);
});

test('During tournament, show current season instead of the trophy case',()=>{
  const html=install().renderSeasonView({
    currentSeason:current('locked'),
    seasonHistory:[archived('one','Alpha','2026-06-30')]
  },{effectiveDateKey:'2026-10-12'});
  assert.doesNotMatch(html,/Trophy Case/);
  assert.match(html,/Current Season/);
  assert.match(html,/Season Header/);
});

test('Future preview still permits tournament setup but shows past champions first',()=>{
  const html=install().renderSeasonView({
    currentSeason:current('preview','2026-12-01','2026-12-31'),
    seasonHistory:[archived('one','Alpha','2026-06-30')]
  },{effectiveDateKey:'2026-11-23'});
  assert.match(html,/Trophy Case/);
  assert.match(html,/Alpha/);
  assert.match(html,/Season Three/);
  assert.doesNotMatch(html,/Create New Season/);
});

test('Champion crowned but not yet archived gets one trophy, never a duplicate',()=>{
  const ui=install();
  const champion={...current('champion_crowned'),championSummary:{championId:'p3',championName:'Gamma'}};
  const html=ui.renderSeasonView({currentSeason:champion,
    seasonHistory:[archived('one','Alpha','2026-06-30')]
  },{effectiveDateKey:'2026-10-29'});
  assert.match(html,/Trophy Case/);
  assert.ok(html.indexOf('Gamma')<html.indexOf('Alpha'));
  const duplicate=ui.renderSeasonView({currentSeason:champion,
    seasonHistory:[archived('one','Alpha','2026-06-30'),{...champion}]
  },{effectiveDateKey:'2026-11-23'});
  const cards=duplicate.match(/class="glass season-card season-trophy-card"/g)||[];
  assert.equal(cards.length,2);
});

test('Never invent a winner from unfinished games; original current controls remain',()=>{
  const html=install().renderSeasonView({currentSeason:current('active'),seasonHistory:[]},
    {effectiveDateKey:'2026-11-23'});
  assert.doesNotMatch(html,/Trophy Case/);
  assert.match(html,/Season Header/);
});

test('Archive-only case preserves Create New Season and expansion',()=>{
  const html=install().renderSeasonView({currentSeason:null,
    seasonHistory:[archived('one','Alpha','2026-06-30')]
  },{effectiveDateKey:'2026-11-23'});
  assert.match(html,/Trophy Case/);
  assert.match(html,/Create New Season/);
  assert.match(html,/season-trophy-card/);
});

test('Read-only rendering never mutates live or archived season records',()=>{
  const ui=install(),state={currentSeason:current('preview'),
    seasonHistory:[archived('one','Alpha','2026-06-30')]};
  const original=JSON.stringify(state);
  ui.renderSeasonView(state,{effectiveDateKey:'2026-11-23'});
  assert.equal(JSON.stringify(state),original);
});
