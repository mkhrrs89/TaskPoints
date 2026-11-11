'use strict';
// M01: these are the actual inline page scripts from production HTML.
// They are exercised with disposable in-memory browser stand-ins.
// This documents existing V1 behavior only; it does NOT certify V2 authority,
// safe cross-tab admission, or a migration/cutover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clone = x => JSON.parse(JSON.stringify(x));
const KEY = 'taskpoints_v1';
const root = path.join(__dirname, '..');
function realPageScript(page, marker) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  const script = scripts.find(x => x.includes(marker));
  assert.ok(script && script.includes(marker), 'missing production inline script: ' + page);
  return script;
}

function fixture() {
  return {
    players: [{ id: 'npc', name: 'Alpha', baseline: 40, variance: 5,
      poise: 25, active: true }],
    playerBadges: {},
    tasks: [
      { id: 'trash-1', title: 'Old task', points: 6, status: 'trashed',
        prevStatus: 'paused', deletedAtISO: '2026-11-08T11:00:00Z' },
      { id: 'trash-2', title: 'Other task', points: 5, status: 'trashed',
        prevStatus: 'active', deletedAtISO: '2026-11-09T11:00:00Z' },
      { id: 'keep-task', title: 'Active task', status: 'active' }
    ],
    gameHistory: [{ id: 'game1', playerId: 'npc', score: 44 }],
    goldLedger: [{ id: 'gold1', playerId: 'YOU', amount: 7 }],
    seasonHistory: [{ id: 'season1' }],
    unusualImportedField: { retainMe: true }
  };
}
function harness(page, { normal = true, failPrimary = false, failDirect = false,
  confirmDelete = true } = {}) {
  const rows = new Map([[KEY, JSON.stringify(fixture())]]);
  const paths = { snapshots: [], direct: [], confirmations: 0, consoleErrors: [] };
  const storage = {
    getItem(key) { return rows.get(String(key)) ?? null; },
    setItem(key, raw) { rows.set(String(key), String(raw)); },
    removeItem(key) { rows.delete(String(key)); }
  };
  const core = {
    STORAGE_KEY: KEY,
    loadAppState() { return { state: JSON.parse(storage.getItem(KEY)) }; },
    readTaskPointsStoredState() { return JSON.parse(storage.getItem(KEY)); },
    writeTaskPointsStoredState(value, options) {
      paths.direct.push({ state: clone(value), options: clone(options) });
      if (failDirect) throw Error('raw V1 storage full');
      storage.setItem(KEY, JSON.stringify(value));
      return value;
    },
    saveStateSnapshot(value, options) {
      paths.snapshots.push({ state: clone(value), options: clone(options) });
      if (failPrimary) throw Error('protected snapshot refused');
      storage.setItem(KEY, JSON.stringify(value));
      return { state: clone(value) };
    }
  };
  if (normal) core.mergeAndSaveState = () => ({ state: JSON.parse(storage.getItem(KEY)) });
  const elements = new Map();
  function element(id='') {
    const x = {
      id, dataset: {}, children: [], classList: { toggle() {}, add() {}, remove() {} },
      attributes: {}, listeners: {}, innerHTML: '', disabled: false,
      addEventListener(kind,cb) { (this.listeners[kind] ||= []).push(cb); },
      setAttribute(key,value){ this.attributes[key] = value; },
      appendChild(child) { this.children.push(child); return child; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      focus() {}, select() {}, setCustomValidity() {}, reportValidity() {}
    };
    return x;
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id,element(id)); return elements.get(id); },
    createElement() { return element(); },
    addEventListener() {},
    querySelector() { return document.editor || null; },
    querySelectorAll() { return []; },
    editor: null
  };
  const logs = {
    debug() {}, warn() {}, info() {}, log() {},
    error(...args) { paths.consoleErrors.push(args.map(String).join(' ')); }
  };
  const context = {
    localStorage: storage, document, TaskPointsCore: core,
    console: logs, confirm() { paths.confirmations++; return confirmDelete; },
    alert() {}, setTimeout() {}, Date, JSON, Map, Set, Number, Math, String,
    Object, Array, Boolean
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  const marker = page === 'achievements.html' ? 'function saveAchievementsPageState'
    : page === 'trash.html' ? 'function saveState(nextState)'
    : 'function persistPlayersToStorage()';
  vm.runInContext(realPageScript(page,marker),context,{filename:page});
  return {
    context, core, storage, document, paths,
    saved() { return JSON.parse(storage.getItem(KEY)); },
    patchState(fn) {
      const state = this.saved();
      fn(state);
      storage.setItem(KEY,JSON.stringify(state));
    },
    eval(code) { return vm.runInContext(code,context,{filename:page+':test-invocation'}); }
  };
}

test('Badges normal route saves the entire imported state through protected V1 snapshot',()=>{
  const h=harness('achievements.html');
  h.eval("togglePlayerBadge({id:'npc',name:'Alpha'},'retroWinner')");
  assert.deepEqual(h.saved().playerBadges.npc,['retroWinner']);
  assert.equal(h.paths.snapshots.length,1);
  assert.equal(h.paths.snapshots[0].options.savePath,'achievements-player-badge');
  assert.equal(h.paths.snapshots[0].options.immediateWrite,true);
  assert.equal(h.paths.snapshots[0].options.userInitiated,true);
  assert.equal(h.paths.direct.length,0);
  assert.equal(h.saved().tasks.length,3);
  assert.equal(h.saved().unusualImportedField.retainMe,true);
  h.eval("togglePlayerBadge({id:'npc',name:'Alpha'},'retroWinner')");
  assert.deepEqual(h.saved().playerBadges.npc,[]);
  assert.equal(h.paths.snapshots.length,2);
});
test('Badges direct-write fallback runs only when protected writer throws or is unavailable',()=>{
  const h=harness('achievements.html',{failPrimary:true});
  h.eval("togglePlayerBadge({id:'npc',name:'Alpha'},'retroWinner')");
  assert.equal(h.paths.snapshots.length,1);
  assert.equal(h.paths.direct.length,1);
  assert.equal(h.paths.direct[0].options.storageKey,KEY);
  assert.deepEqual(h.saved().playerBadges.npc,['retroWinner']);
  assert.equal(h.saved().goldLedger[0].id,'gold1');
  assert.equal(h.saved().unusualImportedField.retainMe,true);
  const x=harness('achievements.html',{failPrimary:true,failDirect:true});
  const previous=x.saved();
  assert.throws(()=>x.eval("togglePlayerBadge({id:'npc',name:'Alpha'},'retroWinner')"),
    /raw V1 storage full/);
  assert.deepEqual(x.saved(),previous,'double-failed badge save must not persist anything');
});

test('Trash protected writer restores a deleted task without deleting other records',()=>{
  const h=harness('trash.html');
  h.eval("restoreTask('trash-1')");
  assert.equal(h.paths.snapshots.length,1);
  assert.equal(h.paths.snapshots[0].options.immediateWrite,true);
  assert.equal(h.paths.snapshots[0].options.storageKey,KEY);
  assert.equal(h.paths.direct.length,0);
  const task=h.saved().tasks.find(x=>x.id==='trash-1');
  assert.equal(task.status,'paused');
  assert.equal(task.prevStatus,null);
  assert.equal(task.deletedAtISO,null);
  assert.equal(h.saved().tasks.length,3);
  assert.equal(h.saved().goldLedger[0].id,'gold1');
  assert.equal(h.saved().unusualImportedField.retainMe,true);
});
test('Trash protected writer deletes forever only after confirmation and preserves other tasks',()=>{
  const declined=harness('trash.html',{confirmDelete:false});
  declined.eval("deleteForever('trash-1')");
  assert.equal(declined.paths.snapshots.length,0);
  assert.equal(declined.saved().tasks.length,3);
  const h=harness('trash.html');
  h.eval("deleteForever('trash-1')");
  assert.equal(h.paths.confirmations,1);
  assert.equal(h.paths.snapshots.length,1);
  assert.equal(h.saved().tasks.some(x=>x.id==='trash-1'),false);
  assert.equal(h.saved().tasks.some(x=>x.id==='trash-2'),true);
  assert.equal(h.saved().tasks.some(x=>x.id==='keep-task'),true);
  assert.equal(h.saved().gameHistory[0].id,'game1');
});

test('Trash direct fallback writes restored/deleted task when merge API is absent',()=>{
  const h=harness('trash.html',{normal:false});
  h.eval("restoreTask('trash-1')");
  assert.equal(h.paths.direct.length,1);
  assert.equal(h.paths.snapshots.length,0);
  assert.equal(h.saved().tasks.find(x=>x.id==='trash-1').status,'paused');
  h.eval("deleteForever('trash-2')");
  assert.equal(h.paths.direct.length,2);
  assert.equal(h.saved().tasks.some(x=>x.id==='trash-2'),false);
  assert.equal(h.saved().tasks.some(x=>x.id==='keep-task'),true);
  assert.equal(h.saved().unusualImportedField.retainMe,true);
});
test('Trash raw fallback refuses false success when direct storage write fails',()=>{
  const h=harness('trash.html',{normal:false,failDirect:true});
  const previous=h.saved();
  assert.throws(()=>h.eval("restoreTask('trash-1')"),/raw V1 storage full/);
  assert.deepEqual(h.saved(),previous);
  assert.equal(h.paths.direct.length,1);
  assert.equal(h.paths.snapshots.length,0);
});

test('Ratings direct V1 writer replaces only NPC players and preserves unrelated snapshot fields',()=>{
  const h=harness('game_ratings.html');
  h.eval("players.find(x=>x.id==='npc').poise=42");
  const saved=h.eval('persistPlayersToStorage()');
  assert.equal(saved,true);
  assert.equal(h.paths.direct.length,1);
  assert.equal(h.paths.snapshots.length,0);
  assert.equal(h.paths.direct[0].options.storageKey,KEY);
  assert.equal(h.saved().players.length,1,'synthetic YOU row cannot become a persisted NPC');
  assert.equal(h.saved().players[0].poise,42);
  assert.equal(h.saved().gameHistory[0].id,'game1');
  assert.equal(h.saved().goldLedger[0].id,'gold1');
  assert.equal(h.saved().unusualImportedField.retainMe,true);
});
test('Ratings actual edit validates input before direct write, and reports failed raw storage',()=>{
  const h=harness('game_ratings.html');
  h.eval('renderTable=()=>{}');
  const editor={ value:'-5', invalid:'', reported:false,
    setCustomValidity(message){this.invalid=message;}, reportValidity(){this.reported=true;},
    focus(){} };
  h.document.editor=editor;
  h.eval("editingState.playerId='npc';editingState.field='variance';saveCurrentEdit()");
  assert.equal(editor.reported,true);
  assert.match(editor.invalid,/non-negative/);
  assert.equal(h.paths.direct.length,0);
  editor.value='12';
  h.eval("saveCurrentEdit()");
  assert.equal(h.saved().players[0].variance,12);
  assert.equal(h.paths.direct.length,1);
  const failed=harness('game_ratings.html',{failDirect:true});
  failed.eval("players.find(x=>x.id==='npc').poise=91");
  assert.equal(failed.eval('persistPlayersToStorage()'),false);
  assert.equal(failed.saved().players[0].poise,25);
  assert.equal(failed.paths.direct.length,1);
});

test('M01 badges, Trash and Ratings behavior witness coverage cannot grant cutover',()=>{
  const inv=JSON.parse(fs.readFileSync(path.join(root,
    'docs/state-runtime-v2-storage-source-inventory.json'),'utf8'));
  const rows=inv.writerBehaviorWitnesses.filter(row=>
    row.testPath==='tests/state_runtime_v2_m01_badges_trash_ratings_writer_behavior_contract.test.js');
  assert.equal(rows.length,5);
  assert.deepEqual(rows.map(row=>row.path).sort(),[
    'achievements.html','achievements.html','game_ratings.html','trash.html','trash.html'
  ]);
  for(const row of rows){
    assert.ok(inv.writerPathEvidence.some(x=>x.path===row.path&&x.anchor===row.anchor));
    assert.ok(row.observedBehaviors.length>=4);
    assert.equal(row.productionOwnerVerified,false);
    assert.equal(row.productionFenceVerified,false);
    assert.equal(row.cutoverPermission,false);
  }
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsedWriterRoutes,28);
  assert.equal(inv.writerOwnershipAudit.behaviorRehearsalDenominator,78);
  assert.equal(inv.writerOwnershipAudit.verifiedOwnerAssignments,0);
  assert.equal(inv.writerOwnershipAudit.productionWritersFenced,false);
  assert.equal(inv.writerOwnershipAudit.status,'incomplete');
  assert.equal(inv.writerOwnershipAudit.directV1PageWriterEvidence.productionWriterAdmissionVerified,false);
  assert.equal(inv.writerOwnershipAudit.directV1PageWriterEvidence.oldTabGenerationFenceVerified,false);
});
