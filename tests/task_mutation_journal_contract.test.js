const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'task_mutation_journal.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
const browserFixtureSource = fs.readFileSync(path.join(__dirname, 'browser', 'v2-storage-fixture.html'), 'utf8');
const homeSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
const logSource = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');
const resetSource = fs.readFileSync(path.join(__dirname, '..', 'phase2_reset_hook.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_task_mutations_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows)); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function makeHarness(storageRows = {}, options = {}) {
  const baseline = {
    tasks: [{ id: 't1', title: 'Task', status: 'active', counts: 0 }],
    completions: [{ id: 'old', taskId: 't1', title: 'Old', points: 1, completedAtISO: '2026-08-09T12:00:00.000Z' }]
  };
  const storage = options.storage || new FakeStorage({ [STORAGE_KEY]: JSON.stringify(baseline), ...storageRows });
  const timers = [];
  const quietRuns = [];
  let saveCalls = 0;
  let maintenanceQuiet = true;
  let lastInteractionAgoMs = 10000;
  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readTaskPointsStoredState() { return JSON.parse(storage.getItem(STORAGE_KEY)); },
    loadAppState() { return { state: JSON.parse(storage.getItem(STORAGE_KEY)) }; },
    saveStateSnapshot(candidate) {
      saveCalls += 1;
      const committed = typeof options.saveTransform === 'function'
        ? options.saveTransform(clone(candidate))
        : clone(candidate);
      storage.setItem(STORAGE_KEY, JSON.stringify(committed));
      const returnedState = typeof options.returnedStateTransform === 'function'
        ? options.returnedStateTransform(clone(committed), clone(candidate))
        : clone(committed);
      return { state: returnedState };
    },
    whenStorageMaintenanceQuiet(run) { quietRuns.push(run); return Promise.resolve(run()); },
    isStorageMaintenanceQuiet() { return maintenanceQuiet; },
    getStorageMaintenanceIdleStatus() { return { lastInteractionAgoMs }; },
    noteStorageUserInteraction() {},
    clearStateHotCache() {}
  };
  const context = {
    console,
    TaskPointsCore: core,
    TaskPointsStateRuntimeV2Generation: options.generationApi,
    localStorage: storage,
    location:{hostname:options.hostname || ''},
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestIdleCallback(fn) { fn(); return 1; },
    structuredClone: clone,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    Math,
    Promise
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'task_mutation_journal.js' });
  return {
    context, core, storage, timers, quietRuns,
    getSaveCalls: () => saveCalls,
    setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); },
    setLastInteractionAgoMs(value) { lastInteractionAgoMs = Number(value) || 0; }
  };
}

async function runNextTimer(harness) {
  const callback = harness.timers.shift();
  assert.ok(callback, 'expected a scheduled timer');
  callback();
  await Promise.resolve();
  await Promise.resolve();
}

test('worker boots V2 generation before Task journal and preserves hot cache order', () => {
  const generationAt = workerSource.indexOf("'/state_runtime_v2_generation.js'");
  const journalAt = workerSource.indexOf("'/task_mutation_journal.js'");
  const hotCacheAt = workerSource.indexOf("'/state_hot_cache.js'");
  assert.ok(generationAt >= 0 && journalAt > generationAt,
    'preview Task epoch must be available before the journal captures it');
  assert.ok(hotCacheAt > journalAt,
    'the journal must still load before state hot cache');
  assert.match(workerSource, /taskMutationJournalSource/);
  const fixtureGeneration = browserFixtureSource.indexOf('src="../../state_runtime_v2_generation.js"');
  const fixtureRuntime = browserFixtureSource.indexOf('src="../../state_runtime_v2.js"');
  const fixtureJournal = browserFixtureSource.indexOf('src="../../task_mutation_journal.js"');
  assert.ok(fixtureGeneration >= 0 && fixtureGeneration < fixtureRuntime
    && fixtureRuntime < fixtureJournal,
    'real-browser fixture must match the shipped generation/runtime-before-Task-journal order');
});

test('task completion mutation is durable immediately and replays without a full snapshot save', () => {
  const h = makeHarness();
  const task = { id: 't1', title: 'Task', status: 'completed', counts: 1 };
  const completion = { id: 'c1', taskId: 't1', title: 'Task', points: 5, completedAtISO: '2026-08-10T12:00:00.000Z' };
  h.core.journalTaskMutation({ task, completionUpsert: completion });
  assert.equal(h.getSaveCalls(), 0);
  const journal = JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.equal(journal.tasks.length, 1);
  assert.equal(journal.completionUpserts.length, 1);
  const loaded = h.core.loadAppState().state;
  assert.equal(loaded.tasks[0].status, 'completed');
  assert.equal(loaded.completions[0].id, 'c1');
});


test('a silently ignored Task journal setItem cannot acknowledge a real edit or schedule compaction', () => {
  const h = makeHarness();
  const beforeTimers = h.timers.length;
  const original = h.storage.setItem.bind(h.storage);
  h.storage.setItem = (key, value) => {
    if (key === JOURNAL_KEY) return; // storage shim incorrectly claims success
    return original(key, value);
  };
  assert.throws(() => h.core.journalTaskMutation({
    task: { id: 't1', title: 'Not durable', status: 'completed' },
    completionUpsert: { id: 'unsaved', taskId: 't1', points: 5 }
  }), error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_WRITE');
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.getSaveCalls(), 0);
  assert.equal(h.timers.length, beforeTimers, 'failed edit cannot schedule successful compaction');
  const status = h.core.getTaskMutationJournalStatus();
  assert.equal(status.mutationGeneration, 0, 'failed edit cannot advance generation');
  assert.equal(status.journalWritesUnverified, 1);
  assert.equal(status.journalWritesVerified, 0);
  const baseline = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(baseline.tasks[0].status, 'active');
});

test('a silently ignored completion batch cannot claim pre-paint durability', () => {
  const h = makeHarness();
  const original = h.storage.setItem.bind(h.storage);
  h.storage.setItem = (key, value) => key === JOURNAL_KEY ? undefined : original(key, value);
  assert.throws(() => h.core.journalTaskCompletionBatch([
    { id: 'metric-a', taskId: 't1', points: 1 },
    { id: 'metric-b', taskId: 't1', points: 2 }
  ]), error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_WRITE');
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration, 0);
  assert.equal(h.getSaveCalls(), 0);
});

test('journal write detects silent overwrite refusal without losing the preexisting durable journal', () => {
  const originalRecord = {
    schemaVersion: 1, tasks: [{ id: 't1', title: 'Prior durable edit' }],
    completionUpserts: [], completionDeletes: [],
    updatedAtISO: '2026-11-11T09:00:00.000Z'
  };
  const originalRaw = JSON.stringify(originalRecord);
  const h = makeHarness({ [JOURNAL_KEY]: originalRaw });
  const original = h.storage.setItem.bind(h.storage);
  h.storage.setItem = (key, value) => key === JOURNAL_KEY ? undefined : original(key, value);
  assert.throws(() => h.core.journalTaskMutation({
    task: { id: 't1', title: 'Unconfirmed replacement' }
  }), error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_WRITE');
  assert.equal(h.storage.getItem(JOURNAL_KEY), originalRaw);
  assert.equal(h.core.readPendingTaskMutations().record.tasks[0].title, 'Prior durable edit');
});

test('reset journal clear refuses a silently ignored remove and succeeds when storage recovers', () => {
  const pendingRecord = JSON.stringify({
    schemaVersion: 1, tasks: [{ id: 't1', title: 'Pending before reset' }],
    completionUpserts: [], completionDeletes: [],
    updatedAtISO: '2026-11-11T09:00:00.000Z'
  });
  const h = makeHarness({ [JOURNAL_KEY]: pendingRecord });
  const original = h.storage.removeItem.bind(h.storage);
  h.storage.removeItem = key => key === JOURNAL_KEY ? undefined : original(key);
  assert.throws(() => h.core.clearPendingTaskMutations(),
    error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_CLEAR');
  assert.equal(h.storage.getItem(JOURNAL_KEY), pendingRecord,
    'the pending mutation must stay available for recovery');
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesUnverified, 1);
  h.storage.removeItem = original;
  assert.equal(h.core.clearPendingTaskMutations(), true);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 1);
});

test('reset Task-journal cleanup refuses a peer edit detected immediately before deletion', () => {
  const originalRecord = JSON.stringify({
    schemaVersion: 1, tasks: [{ id: 't1', title: 'Original pending edit' }],
    completionUpserts: [], completionDeletes: [], updatedAtISO: '2026-11-11T09:00:00.000Z'
  });
  const peerRecord = JSON.stringify({
    schemaVersion: 1, tasks: [
      { id: 't1', title: 'Original pending edit' },
      { id: 't2', title: 'New peer edit' }
    ],
    completionUpserts: [], completionDeletes: [], updatedAtISO: '2026-11-11T09:01:00.000Z'
  });
  const h = makeHarness({ [JOURNAL_KEY]: originalRecord });
  const realGet = h.storage.getItem.bind(h.storage);
  const realSet = h.storage.setItem.bind(h.storage);
  let reads = 0, removed = false;
  const realRemove = h.storage.removeItem.bind(h.storage);
  h.storage.removeItem = key => { if (key === JOURNAL_KEY) removed = true; return realRemove(key); };
  h.storage.getItem = key => {
    if (key === JOURNAL_KEY && ++reads === 2) realSet(JOURNAL_KEY, peerRecord);
    return realGet(key);
  };
  assert.throws(() => h.core.clearPendingTaskMutations(),
    error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_CLEAR_SOURCE_CHANGED');
  assert.equal(removed, false, 'no destructive remove should run after detecting the peer');
  assert.equal(realGet(JOURNAL_KEY), peerRecord, 'the newer peer journal remains durable');
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 0);
});

test('reset Task-journal cleanup refuses a denied source read rather than deleting blindly', () => {
  const pending = JSON.stringify({
    schemaVersion: 1, tasks: [{ id: 't1', title: 'Keep pending' }],
    completionUpserts: [], completionDeletes: [], updatedAtISO: null
  });
  for (const deniedRead of [1, 2]) {
    const h = makeHarness({ [JOURNAL_KEY]: pending });
    const realGet = h.storage.getItem.bind(h.storage);
    let reads = 0, removed = false;
    const realRemove = h.storage.removeItem.bind(h.storage);
    h.storage.removeItem = key => { removed = true; return realRemove(key); };
    h.storage.getItem = key => {
      if (key === JOURNAL_KEY && ++reads === deniedRead) throw Error('read denied');
      return realGet(key);
    };
    assert.throws(() => h.core.clearPendingTaskMutations(),
      error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_CLEAR_SOURCE_UNREADABLE');
    assert.equal(removed, false, 'no remove on read denial ' + deniedRead);
    assert.equal(realGet(JOURNAL_KEY), pending);
    assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts, 1);
    assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 0);
  }
});

test('reset clear continues to support intentional malformed-journal cleanup and verified absence', () => {
  const h = makeHarness({ [JOURNAL_KEY]: '{malformed-pending-evidence' });
  assert.equal(h.core.clearPendingTaskMutations(), true,
    'authorized destructive cleanup must retain its original malformed-journal capability');
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.core.clearPendingTaskMutations(), true, 'already absent journal remains safe to clear');
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 2);
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts, 0);
});

test('reset clear refuses nonstandard unreadable journal values without destroying evidence', () => {
  const h = makeHarness();
  const realGet = h.storage.getItem.bind(h.storage);
  let removed = false;
  const realRemove = h.storage.removeItem.bind(h.storage);
  h.storage.removeItem = key => { removed = true; return realRemove(key); };
  h.storage.getItem = key => key === JOURNAL_KEY ? undefined : realGet(key);
  assert.throws(() => h.core.clearPendingTaskMutations(),
    error => error.code === 'TASKPOINTS_TASK_MUTATION_JOURNAL_CLEAR_SOURCE_CHANGED');
  assert.equal(removed, false);
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 0);
});

test('preview stale tab cannot erase a newer-generation Task journal during reset cleanup', () => {
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'}, {hostname:'localhost'});
  const first=JSON.stringify({schemaVersion:1,tasks:[{id:'a',title:'old'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  const later=JSON.stringify({schemaVersion:1,tasks:[{id:'b',title:'new peer edit'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  h.storage.setItem(JOURNAL_KEY,first);
  // A separate tab has completed an authorized reset and written a new Task.
  h.storage.setItem(generationKey,'epoch-B');
  h.storage.setItem(JOURNAL_KEY,later);
  let removed=false;
  const realRemove=h.storage.removeItem.bind(h.storage);
  h.storage.removeItem=key=>{if(key===JOURNAL_KEY)removed=true;return realRemove(key);};
  assert.throws(()=>h.core.clearPendingTaskMutations(),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(removed,false);
  assert.equal(h.storage.getItem(JOURNAL_KEY),later);
  assert.equal(h.core.getTaskMutationJournalStatus().previewGenerationBlocks,1);
});

test('verified same-page Reset All can clear only the witnessed pending Task bytes once', () => {
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const listeners=[];
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},
    {hostname:'localhost',generationApi:{subscribe(fn){listeners.push(fn);}}});
  const old=JSON.stringify({schemaVersion:1,tasks:[{id:'a',title:'Old before reset'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  h.storage.setItem(JOURNAL_KEY,old);
  h.storage.removeItem(STORAGE_KEY);
  h.storage.setItem(generationKey,'epoch-B');
  listeners[0]({source:'local',reason:'reset-all',
    previousGeneration:'epoch-A',generation:'epoch-B'});
  assert.equal(h.core.clearPendingTaskMutations(),true);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  assert.throws(()=>h.core.journalTaskMutation({task:{id:'z',title:'Stale callback'}}),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  // The authorization must not be reusable to erase a new-generation journal.
  const fresh=JSON.stringify({schemaVersion:1,tasks:[{id:'b',title:'New generation'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  h.storage.setItem(JOURNAL_KEY,fresh);
  assert.throws(()=>h.core.clearPendingTaskMutations(),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(h.storage.getItem(JOURNAL_KEY),fresh);
});

test('local Reset All witness refuses a peer Task edit added after the reset event', () => {
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const listeners=[];
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},
    {hostname:'localhost',generationApi:{subscribe(fn){listeners.push(fn);}}});
  const original=JSON.stringify({schemaVersion:1,tasks:[{id:'a',title:'Old'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  const peer=JSON.stringify({schemaVersion:1,tasks:[{id:'b',title:'Newer peer'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  h.storage.setItem(JOURNAL_KEY,original);
  h.storage.removeItem(STORAGE_KEY);
  h.storage.setItem(generationKey,'epoch-B');
  listeners[0]({source:'local',reason:'reset-all',
    previousGeneration:'epoch-A',generation:'epoch-B'});
  h.storage.setItem(JOURNAL_KEY,peer);
  let removed=false;
  const realRemove=h.storage.removeItem.bind(h.storage);
  h.storage.removeItem=key=>{if(key===JOURNAL_KEY)removed=true;return realRemove(key);};
  assert.throws(()=>h.core.clearPendingTaskMutations(),
    e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_CLEAR_SOURCE_CHANGED');
  assert.equal(removed,false);
  assert.equal(h.storage.getItem(JOURNAL_KEY),peer);
});

test('external/reset-impostor events never authorize stale preview Task cleanup', () => {
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  for(const [source,reason,snapshotPresent] of [
    ['storage','reset-all',false],
    ['local','settings-import',false],
    ['local','reset-all',true]
  ]){
    const listeners=[];
    const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},
      {hostname:'localhost',generationApi:{subscribe(fn){listeners.push(fn);}}});
    const pending=JSON.stringify({schemaVersion:1,tasks:[{id:'a',title:'Do not erase'}],
      completionUpserts:[],completionDeletes:[],updatedAtISO:null});
    h.storage.setItem(JOURNAL_KEY,pending);
    if(!snapshotPresent)h.storage.removeItem(STORAGE_KEY);
    h.storage.setItem(generationKey,'epoch-B');
    listeners[0]({source,reason,previousGeneration:'epoch-A',generation:'epoch-B'});
    assert.throws(()=>h.core.clearPendingTaskMutations(),
      e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
    assert.equal(h.storage.getItem(JOURNAL_KEY),pending,source+' '+reason);
  }
});

test('preview Task cleanup rechecks reset generation after source reads before removing', () => {
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},
    {hostname:'localhost'});
  const pending=JSON.stringify({schemaVersion:1,tasks:[{id:'a',title:'Keep on race'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:null});
  h.storage.setItem(JOURNAL_KEY,pending);
  const get=h.storage.getItem.bind(h.storage);
  let generationReads=0;
  h.storage.getItem=key=>{
    if(key===generationKey && ++generationReads===2)
      h.storage.setItem(generationKey,'epoch-B');
    return get(key);
  };
  let removed=false;
  const remove=h.storage.removeItem.bind(h.storage);
  h.storage.removeItem=key=>{if(key===JOURNAL_KEY)removed=true;return remove(key);};
  assert.throws(()=>h.core.clearPendingTaskMutations(),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(generationReads,2);
  assert.equal(removed,false);
  assert.equal(get(JOURNAL_KEY),pending);
});

test('successful synchronous Task journal write is verified before action acknowledgement', () => {
  const h = makeHarness();
  const returned = h.core.journalTaskMutation({
    task: { id: 't1', title: 'Committed real edit' }
  });
  assert.equal(returned.tasks[0].title, 'Committed real edit');
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesUnverified, 0);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration, 1);
  assert.equal(JSON.parse(h.storage.getItem(JOURNAL_KEY)).tasks[0].title, 'Committed real edit');
});

test('preview Task writer refuses old-tab edits and idle compaction after reset generation rotates',()=>{
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const shared=new FakeStorage({
    [STORAGE_KEY]:JSON.stringify({tasks:[{id:'t1',title:'Original',status:'active'}],completions:[]}),
    [generationKey]:'preview-generation-A',
    [darkKey]:'1'
  });
  const old=makeHarness({}, {storage:shared,hostname:'localhost'});
  assert.equal(old.core.getTaskMutationJournalStatus().previewGenerationEnforced,true);
  old.core.journalTaskMutation({task:{id:'t1',title:'Pending before rotation'}});
  const pending=shared.getItem(JOURNAL_KEY);
  const baseline=shared.getItem(STORAGE_KEY);
  // A reset/import in another cooperating tab rotated the generation.
  shared.setItem(generationKey,'preview-generation-B');
  assert.throws(()=>old.core.journalTaskMutation({task:{id:'t1',title:'Stale after rotation'}}),
    error=>error.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(old.core.flushPendingTaskMutations(),false);
  assert.equal(old.getSaveCalls(),0);
  assert.equal(shared.getItem(STORAGE_KEY),baseline);
  assert.equal(shared.getItem(JOURNAL_KEY),pending);
  const status=old.core.getTaskMutationJournalStatus();
  assert.equal(status.previewGenerationBlocks,2);
  assert.equal(status.mutationGeneration,1);
  // The valid reset path has quarantined/cleared old pending journal bytes.
  // A *newly loaded* preview tab binds to the rotated epoch and remains usable.
  shared.removeItem(JOURNAL_KEY);
  const fresh=makeHarness({}, {storage:shared,hostname:'localhost'});
  assert.equal(fresh.core.getTaskMutationJournalStatus().previewGenerationEnforced,true);
  fresh.core.journalTaskMutation({task:{id:'t1',title:'New epoch Task'}});
  assert.equal(fresh.core.flushPendingTaskMutations(),true);
  assert.equal(JSON.parse(shared.getItem(STORAGE_KEY)).tasks[0].title,'New epoch Task');
});

test('preview Task journal fences a rotation between read and the synchronous write',()=>{
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},{hostname:'localhost'});
  const before=h.storage.getItem(STORAGE_KEY);
  const get=h.storage.getItem.bind(h.storage);
  let generations=0;
  h.storage.getItem=key=>{
    if(key===generationKey && ++generations===2){
      h.storage.setItem(generationKey,'epoch-B');
    }
    return get(key);
  };
  assert.throws(()=>h.core.journalTaskMutation({task:{id:'t1',title:'Must not save'}}),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(generations,2);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  assert.equal(h.storage.getItem(STORAGE_KEY),before);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration,0);
});

test('preview Task compaction blocks a generation rotation during snapshot parsing',()=>{
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},{hostname:'localhost'});
  h.core.journalTaskMutation({task:{id:'t1',title:'Durable before reset'}});
  const before=h.storage.getItem(STORAGE_KEY);
  const pending=h.storage.getItem(JOURNAL_KEY);
  h.core.parseTaskPointsStorageJson=raw=>{
    h.storage.setItem(generationKey,'epoch-B');
    return JSON.parse(raw);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.storage.getItem(STORAGE_KEY),before);
  assert.equal(h.storage.getItem(JOURNAL_KEY),pending);
  assert.equal(h.core.getTaskMutationJournalStatus().previewGenerationBlocks,1);
});

test('verified same-page import rotation permits Habit checkpoints but never rebinds old Task journals', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = [];
  const generationApi = { subscribe(handler) { listeners.push(handler); return () => {}; } };
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost', generationApi });
  assert.equal(listeners.length, 1, 'the real Task journal listens for authorized local rotations');

  const commitImport = next => {
    const oldGeneration = h.storage.getItem(generationKey);
    const candidate = JSON.parse(h.storage.getItem(STORAGE_KEY));
    candidate.notes = 'Authorized import to ' + next;
    // Existing V1 validated import writes before its local generation rotation.
    const saved = h.core.saveStateSnapshot(candidate, {
      allowDestructiveOverwrite: true, source: 'settings-import'
    });
    assert.notEqual(saved.skipped, true);
    h.storage.setItem(generationKey, next);
    listeners[0]({ source: 'local', previousGeneration: oldGeneration,
      generation: next, reason: 'settings-import' });
    const after = { ...candidate, notes: 'Follow-up save in ' + next };
    const full = h.core.saveStateSnapshot(after, { savePath: 'habit-journal-compaction' });
    assert.notEqual(full.skipped, true,
      'authorized same-page import must not strand Habit V1 checkpoints');
    assert.throws(() => h.core.journalTaskMutation({
      task: { id: 't1', title: 'Pre-import Task tab must reload' }
    }), e => e.code === 'TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
    assert.equal(h.storage.getItem(JOURNAL_KEY), null,
      'older Task callbacks cannot save under the new generation');
  };

  commitImport('epoch-B');
  commitImport('epoch-C');
  assert.equal(h.core.getTaskMutationJournalStatus().previewGenerationBlocks, 2);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes,
    'Follow-up save in epoch-C');
});

test('external generation changes and mismatched local events cannot rebind an outdated preview tab', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = [];
  const generationApi = { subscribe(handler) { listeners.push(handler); return () => {}; } };
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost', generationApi });
  const before = h.storage.getItem(STORAGE_KEY);
  h.storage.setItem(generationKey, 'peer-epoch-B');
  listeners[0]({ source: 'storage', previousGeneration: 'epoch-A',
    generation: 'peer-epoch-B' });
  listeners[0]({ source: 'local', previousGeneration: 'not-epoch-A',
    generation: 'peer-epoch-B' });
  const stale = { ...JSON.parse(before), notes: 'Stale tab' };
  const rejected = h.core.saveStateSnapshot(stale, { savePath: 'home-save' });
  assert.equal(rejected.skipped, true);
  assert.equal(rejected.blockedByTaskPreviewGenerationChanged, true);
  assert.throws(() => h.core.journalTaskMutation({
    task: { id: 't1', title: 'Stale edit' }
  }), e => e.code === 'TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(h.storage.getItem(STORAGE_KEY), before);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});

test('preview local rotation must be durably readable before the current tab can rebind', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = [];
  const generationApi = { subscribe(handler) { listeners.push(handler); return () => {}; } };
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost', generationApi });
  const before = h.storage.getItem(STORAGE_KEY);
  // The event may be emitted or spoofed without its claimed token on disk.
  listeners[0]({ source: 'local', previousGeneration: 'epoch-A',
    generation: 'epoch-B' });
  h.storage.setItem(generationKey, 'epoch-B');
  assert.equal(h.core.saveStateSnapshot(
    { ...JSON.parse(before), notes: 'Unverified event' }, { savePath: 'habit-journal-compaction' }
  ).skipped, true);
  assert.equal(h.storage.getItem(STORAGE_KEY), before);
  // A subsequent verified and authorized import event can safely rebind
  // only the narrowly permitted post-import full-snapshot checkpoint path.
  listeners[0]({ source: 'local', previousGeneration: 'epoch-A',
    generation: 'epoch-B', reason: 'settings-import' });
  const result = h.core.saveStateSnapshot(
    { ...JSON.parse(before), notes: 'Verified event' }, { savePath: 'habit-journal-compaction' });
  assert.notEqual(result.skipped, true);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes, 'Verified event');
});

test('same-page reset-all cannot rebind even Habit checkpoint or Task writers', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = [];
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost', generationApi: { subscribe(fn) { listeners.push(fn); } } });
  const before = h.storage.getItem(STORAGE_KEY);
  h.storage.setItem(generationKey, 'epoch-B');
  listeners[0]({ source: 'local', previousGeneration: 'epoch-A',
    generation: 'epoch-B', reason: 'reset-all' });
  const refused = h.core.saveStateSnapshot(
    { ...JSON.parse(before), notes: 'Stale after reset' },
    { savePath: 'habit-journal-compaction' });
  assert.equal(refused.skipped, true);
  assert.equal(refused.blockedByTaskPreviewGenerationChanged, true);
  assert.throws(() => h.core.journalTaskMutation({
    task: { id: 't1', title: 'Old Task' }
  }), error => error.code === 'TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(h.storage.getItem(STORAGE_KEY), before);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});

test('verified local import does not authorize arbitrary old full-state callbacks', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = [];
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost', generationApi: { subscribe(fn) { listeners.push(fn); } } });
  const before = h.storage.getItem(STORAGE_KEY);
  h.storage.setItem(generationKey, 'epoch-B');
  listeners[0]({ source: 'local', previousGeneration: 'epoch-A',
    generation: 'epoch-B', reason: 'settings-import' });
  const rejected = h.core.saveStateSnapshot(
    { ...JSON.parse(before), notes: 'Old delayed Home snapshot' }, { savePath: 'home-save' });
  assert.equal(rejected.skipped, true);
  assert.equal(rejected.blockedByTaskPreviewGenerationChanged, true);
  assert.equal(h.storage.getItem(STORAGE_KEY), before);
  const allowed = h.core.saveStateSnapshot(
    { ...JSON.parse(before), notes: 'Fresh Habit checkpoint' },
    { savePath: 'habit-journal-compaction' });
  assert.notEqual(allowed.skipped, true);
});

test('production and explicitly disabled V2 preview keep unchanged V1 Task journal behavior',()=>{
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const production=makeHarness({[generationKey]:'A',[darkKey]:'1'},
    {hostname:'taskpoints.pages.dev'});
  assert.equal(production.core.getTaskMutationJournalStatus().previewGenerationEnforced,false);
  production.storage.setItem(generationKey,'B');
  production.core.journalTaskMutation({task:{id:'t1',title:'Production V1 still works'}});
  assert.equal(production.core.flushPendingTaskMutations(),true);
  const local=makeHarness({[generationKey]:'A',[darkKey]:'1'},{hostname:'localhost'});
  local.storage.setItem(darkKey,'0');
  local.storage.setItem(generationKey,'B');
  local.core.journalTaskMutation({task:{id:'t1',title:'Disabled preview is V1'}});
  assert.equal(local.core.flushPendingTaskMutations(),true);
});

test('unreadable preview generation blocks edits and cannot be mistaken for dark-mode disable',()=>{
  const generationKey='taskpoints_state_v2_generation_v1';
  const darkKey='taskpoints_state_v2_dark_mode_v1';
  const h=makeHarness({[generationKey]:'epoch-A',[darkKey]:'1'},{hostname:'localhost'});
  const prior=h.storage.getItem(STORAGE_KEY);
  const original=h.storage.getItem.bind(h.storage);
  h.storage.getItem=key=>{
    if(key===darkKey)throw Error('denied dark-mode read');
    return original(key);
  };
  assert.throws(()=>h.core.journalTaskMutation({task:{id:'t1',title:'Should refuse'}}),
    e=>e.code==='TASKPOINTS_TASK_PREVIEW_GENERATION_CHANGED');
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  assert.equal(h.storage.getItem(STORAGE_KEY),prior);
});

test('two real Task journal tabs reject a detectable peer edit instead of overwriting it', () => {
  const shared = new FakeStorage({
    [STORAGE_KEY]: JSON.stringify({
      tasks: [{id:'t1',title:'Base',status:'active'}],completions:[]
    })
  });
  const tabA = makeHarness({}, {storage:shared});
  const tabB = makeHarness({}, {storage:shared});
  const normalGet = shared.getItem.bind(shared);
  let journalReads = 0, injected = false;
  shared.getItem = key => {
    if (key === JOURNAL_KEY) {
      journalReads += 1;
      if (journalReads === 2 && !injected) {
        injected = true;
        tabB.core.journalTaskMutation({task:{
          id:'t1',title:'Saved by Tab B',status:'completed'
        }});
      }
    }
    return normalGet(key);
  };
  assert.throws(() => tabA.core.journalTaskMutation({task:{
    id:'t1',title:'Stale Tab A',status:'active'
  }}),e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_CHANGED');
  assert.equal(injected,true);
  assert.equal(JSON.parse(shared.getItem(JOURNAL_KEY)).tasks[0].title,'Saved by Tab B');
  assert.equal(tabA.core.getTaskMutationJournalStatus().mutationGeneration,0);
  assert.equal(tabA.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  assert.equal(tabA.core.getTaskMutationJournalStatus().journalWritesVerified,0);
  assert.equal(tabA.getSaveCalls(),0);
  assert.equal(tabB.core.getTaskMutationJournalStatus().journalWritesVerified,1);
  assert.equal(tabB.getSaveCalls(),0);
});

test('Task journal prewrite source check fails closed when peer source cannot be reread', () => {
  const h=makeHarness();
  const original=h.storage.getItem.bind(h.storage);
  let journalReads=0;
  h.storage.getItem=key=>{
    if(key===JOURNAL_KEY && ++journalReads===2) throw Error('read denied');
    return original(key);
  };
  assert.throws(()=>h.core.journalTaskMutation({
    task:{id:'t1',title:'Unconfirmed from unreadable source'}
  }),e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_UNREADABLE');
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration,0);
});

test('compaction cleanup does not erase an edit another tab saved after the cleanup read', () => {
  const initial={
    schemaVersion:1,
    tasks:[{id:'t1',title:'Task A from durable journal'}],
    completionUpserts:[],completionDeletes:[],
    updatedAtISO:'2026-11-11T12:00:00.000Z'
  };
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify(initial)});
  const original=h.storage.getItem.bind(h.storage);
  const set=h.storage.setItem.bind(h.storage);
  let reads=0,peerWritten=false;
  h.storage.getItem=key=>{
    // Pre-save compaction now performs a second read. Inject AFTER the
    // cleanup read, at the exact writeRecord source recheck.
    if(key===JOURNAL_KEY && ++reads===4 && !peerWritten){
      peerWritten=true;
      set(JOURNAL_KEY,JSON.stringify({
        ...initial,
        tasks:[
          {id:'t1',title:'Task A from durable journal'},
          {id:'t2',title:'Late Tab B edit'}
        ],
        updatedAtISO:'2026-11-11T12:00:01.000Z'
      }));
    }
    return original(key);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false,
    'compaction cannot declare cleanup complete after a peer journal change');
  assert.equal(peerWritten,true);
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  const after=JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.equal(after.tasks.length,2);
  assert.equal(after.tasks[1].title,'Late Tab B edit');
  assert.equal(h.getSaveCalls(),1,
    'snapshot may already contain original edit; newer journal stays durable for replay');
  assert.equal(h.core.readTaskPointsStoredState().tasks.some(t=>t.id==='t2'),true);
  assert.equal(h.core.getTaskMutationJournalStatus().compactionsCompleted,0);
});

test('compaction cannot report success if pending journal becomes malformed during snapshot write', () => {
  const pending={
    schemaVersion:1,
    tasks:[{id:'t1',title:'Pending original edit'}],
    completionUpserts:[],completionDeletes:[],
    updatedAtISO:'2026-11-11T12:00:00.000Z'
  };
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify(pending)});
  const originalSet=h.storage.setItem.bind(h.storage);
  h.storage.setItem=(key,value)=>{
    const result=originalSet(key,value);
    if(key===STORAGE_KEY) originalSet(JOURNAL_KEY,'{malformed:');
    return result;
  };
  assert.equal(h.core.flushPendingTaskMutations(),false,
    'a verified main snapshot cannot make an uncleaned journal look finished');
  assert.equal(h.getSaveCalls(),1);
  assert.equal(h.storage.getItem(JOURNAL_KEY),'{malformed:',
    'malformed evidence must be retained rather than removed or normalized');
  assert.equal(h.core.getTaskMutationJournalStatus().malformed,true);
  assert.equal(h.core.getTaskMutationJournalStatus().compactionsCompleted,0);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).tasks[0].title,
    'Pending original edit');
});

test('Task compaction refuses a stale candidate if a peer clears the journal after persisting a newer snapshot', () => {
  const pending={
    schemaVersion:1,
    tasks:[{id:'t1',title:'Task from old pending journal',status:'active'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:'2026-11-12T12:00:00.000Z'
  };
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify(pending)});
  const newer=JSON.parse(h.storage.getItem(STORAGE_KEY));
  newer.tasks[0]={id:'t1',title:'Peer already compacted newer edit',status:'completed'};
  newer.extraImportedField={keep:true};
  let injected=false;
  h.core.parseTaskPointsStorageJson=raw=>{
    if(!injected){
      injected=true;
      // Simulate another tab completing compaction while our tab is
      // decoding an older V1 snapshot for its own pending journal.
      h.storage.setItem(STORAGE_KEY,JSON.stringify(newer));
      h.storage.removeItem(JOURNAL_KEY);
    }
    return JSON.parse(raw);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(injected,true);
  assert.equal(h.getSaveCalls(),0,'stale compaction may not invoke the full-state writer');
  assert.deepEqual(JSON.parse(h.storage.getItem(STORAGE_KEY)),newer);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null,
    'a peer-verified cleanup must not be resurrected by stale compaction');
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  assert.equal(h.core.getTaskMutationJournalStatus().compactionsCompleted,0);
});

test('Task compaction retains newer peer edits and can safely retry after a source change', () => {
  const pending={
    schemaVersion:1,
    tasks:[{id:'t1',title:'First pending edit'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:'2026-11-12T12:00:00.000Z'
  };
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify(pending)});
  const newer={...pending,
    tasks:[...pending.tasks,{id:'t2',title:'New edit from other tab'}],
    updatedAtISO:'2026-11-12T12:00:01.000Z'
  };
  let injected=false;
  h.core.parseTaskPointsStorageJson=raw=>{
    if(!injected){
      injected=true;
      h.storage.setItem(JOURNAL_KEY,JSON.stringify(newer));
    }
    return JSON.parse(raw);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.getSaveCalls(),0);
  assert.deepEqual(JSON.parse(h.storage.getItem(JOURNAL_KEY)),newer);
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  h.core.parseTaskPointsStorageJson=raw=>JSON.parse(raw);
  assert.equal(h.core.flushPendingTaskMutations(),true,
    'fresh retry can compact both edits without losing the peer row');
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  const persisted=JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks.find(row=>row.id==='t1').title,'First pending edit');
  assert.equal(persisted.tasks.find(row=>row.id==='t2').title,'New edit from other tab');
});

test('Task compaction fails closed on an unreadable final pre-save journal check', () => {
  const pending={
    schemaVersion:1,
    tasks:[{id:'t1',title:'Still pending after denied read'}],
    completionUpserts:[],completionDeletes:[],updatedAtISO:'2026-11-12T12:00:00.000Z'
  };
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify(pending)});
  const oldGet=h.storage.getItem.bind(h.storage);
  let reads=0;
  h.storage.getItem=key=>{
    if(key===JOURNAL_KEY && ++reads===2)throw Error('injected unreadable source');
    return oldGet(key);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(JSON.parse(oldGet(JOURNAL_KEY)).tasks[0].title,
    'Still pending after denied read');
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,1);
  h.storage.getItem=oldGet;
  assert.equal(h.core.flushPendingTaskMutations(),true);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('Task compaction refuses a stale V1 snapshot when a peer saves while old bytes decode', () => {
  const h=makeHarness();
  h.core.journalTaskMutation({
    task:{id:'t1',title:'Pending Task edit',status:'completed'},
    completionUpsert:{id:'pending-completion',taskId:'t1',source:'task',points:7}
  });
  const originalJournal=h.storage.getItem(JOURNAL_KEY);
  const before=JSON.parse(h.storage.getItem(STORAGE_KEY));
  const peerSaved={...before,
    notes:'Newer unrelated Notes data from another tab',
    completions:[...before.completions,{
      id:'peer-completion',title:'Peer committed',source:'work',points:13
    }]
  };
  const peerRaw=JSON.stringify(peerSaved);
  let injected=0;
  h.core.parseTaskPointsStorageJson=raw=>{
    if(!injected++){
      // A peer commits *after* this tab read the raw V1 snapshot but
      // before decompression/parsing and journal compaction finish.
      h.storage.setItem(STORAGE_KEY,peerRaw);
    }
    return JSON.parse(raw);
  };
  const result=h.core.flushPendingTaskMutations();
  assert.equal(result,false);
  assert.equal(injected,1);
  assert.equal(h.getSaveCalls(),0,
    'a stale candidate must never reach the canonical full-state writer');
  assert.equal(h.storage.getItem(STORAGE_KEY),peerRaw);
  assert.equal(h.storage.getItem(JOURNAL_KEY),originalJournal,
    'the durable Task intent must remain for a safe retry');
  assert.equal(h.core.getTaskMutationJournalStatus().snapshotSourceConflicts,1);
  h.core.parseTaskPointsStorageJson=raw=>JSON.parse(raw);
  assert.equal(h.core.flushPendingTaskMutations(),true,
    'retry from the peer snapshot must preserve both sets of changes');
  const final=JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(final.notes,peerSaved.notes);
  assert.ok(final.completions.some(row=>row.id==='peer-completion'));
  assert.equal(final.completions.find(row=>row.id==='pending-completion').points,7);
  assert.equal(final.tasks.find(row=>row.id==='t1').title,'Pending Task edit');
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('Task compaction refuses V1 snapshot removal while preparing and retains pending edit', () => {
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'Not to lose'}});
  const originalJournal=h.storage.getItem(JOURNAL_KEY);
  const original=h.storage.getItem(STORAGE_KEY);
  h.core.parseTaskPointsStorageJson=raw=>{
    h.storage.removeItem(STORAGE_KEY);
    return JSON.parse(raw);
  };
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.storage.getItem(STORAGE_KEY),null);
  assert.equal(h.storage.getItem(JOURNAL_KEY),originalJournal);
  assert.equal(h.core.getTaskMutationJournalStatus().snapshotSourceConflicts,1);
  h.storage.setItem(STORAGE_KEY,original);
  h.core.parseTaskPointsStorageJson=raw=>JSON.parse(raw);
  assert.equal(h.core.flushPendingTaskMutations(),true);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('Task compaction refuses an unreadable V1 snapshot source without writing', () => {
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'Keep pending'}});
  const originalJournal=h.storage.getItem(JOURNAL_KEY);
  const realGet=h.storage.getItem.bind(h.storage);
  h.storage.getItem=key=>key===STORAGE_KEY?undefined:realGet(key);
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(realGet(JOURNAL_KEY),originalJournal);
  h.storage.getItem=realGet;
  assert.equal(h.core.flushPendingTaskMutations(),true);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('sequential same-tab Task journal updates still merge and flush without a conflict', () => {
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'First edit'}});
  h.core.journalTaskMutation({task:{id:'t2',title:'Second edit'}});
  const rows=JSON.parse(h.storage.getItem(JOURNAL_KEY)).tasks;
  assert.equal(rows.length,2);
  assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified,2);
  assert.equal(h.core.getTaskMutationJournalStatus().journalSourceConflicts,0);
  assert.equal(h.core.flushPendingTaskMutations(),true);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  assert.equal(h.core.getTaskMutationJournalStatus().compactionsCompleted,1);
});

test('fast Task journal skips invalid single-row arrays as the previous normalizer did',()=>{
  const h=makeHarness();
  const invalidTask=[]; invalidTask.id='array-task';
  const invalidCompletion=[]; invalidCompletion.id='array-completion';
  h.core.journalTaskMutation({task:invalidTask,completionUpsert:invalidCompletion});
  assert.equal(h.storage.getItem(JOURNAL_KEY),null,
    'an invalid array row may not become durable after the clone-pass optimization');
  assert.equal(h.getSaveCalls(),0);
});

test('pending completion journal rows are cloned once rather than twice per foreground save',()=>{
  const rows=Array.from({length:320},(_,i)=>({
    id:'existing-scwm-'+i,source:'work',points:7.2,workHours:8,
    completedAtISO:'2026-10-25T12:00:00.000Z'
  }));
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify({
    schemaVersion:1,tasks:[],completionUpserts:rows,
    completionDeletes:[],updatedAtISO:'2026-10-25T12:01:00.000Z'
  })});
  const initial=h.storage.getItem(JOURNAL_KEY);
  let cloneCalls=0;
  h.context.structuredClone=(value)=>{
    if(typeof value?.id==='string'&&value.id.startsWith('existing-scwm-'))cloneCalls++;
    return clone(value);
  };
  h.core.journalTaskCompletionBatch([{
    id:'new-fast-work',source:'work',points:8.4,workHours:8.25,
    completedAtISO:'2026-11-02T12:00:00.000Z'
  }]);
  assert.equal(cloneCalls,rows.length,
    'readRecord normalizes each pending row once; the writer must not clone all rows again');
  const after=JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.equal(after.completionUpserts.length,rows.length+1);
  assert.ok(after.completionUpserts.some(row=>row.id==='new-fast-work'));
  assert.notEqual(initial,h.storage.getItem(JOURNAL_KEY));
  assert.equal(h.getSaveCalls(),0,'no full-state serialization during journal append');
});

test('multi-row completion batch uses one durable journal write and one verified compaction',()=>{
  const h=makeHarness();
  let journalWrites=0;
  const originalSet=h.storage.setItem.bind(h.storage);
  h.storage.setItem=(key,value)=>{
    if(key===JOURNAL_KEY)journalWrites++;
    return originalSet(key,value);
  };
  const entries=[
    {id:'work-batch',source:'work',title:'Work Score',workHours:8.5,
      points:8.3,completedAtISO:'2026-11-02T12:00:00.000Z'},
    {id:'sleep-batch',source:'metric',title:'Sleep Score',sleepRested:7,
      points:9,completedAtISO:'2026-11-02T12:01:00.000Z'}
  ];
  const saved=h.core.journalTaskCompletionBatch(entries);
  assert.equal(journalWrites,1,'one user action must produce one synchronous journal write');
  assert.equal(h.getSaveCalls(),0);
  assert.equal(saved.completionUpserts.length,2);
  const pending=JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.equal(pending.completionUpserts.length,2);
  const effective=h.core.readTaskPointsStoredState();
  assert.ok(effective.completions.some(r=>r.id==='work-batch'&&r.workHours===8.5));
  assert.ok(effective.completions.some(r=>r.id==='sleep-batch'&&r.sleepRested===7));
  assert.equal(h.core.flushPendingTaskMutations(),true);
  assert.equal(h.getSaveCalls(),1);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
  const persisted=JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.ok(persisted.completions.some(r=>r.id==='work-batch'));
  assert.ok(persisted.completions.some(r=>r.id==='sleep-batch'));
});

test('large multi-row batch replaces all old matching rows in order and retains unrelated pending work',()=>{
  const existing=Array.from({length:480},(_,i)=>({
    id:'history-'+i,points:i,source:'work',
    completedAtISO:'2026-10-22T12:00:00.000Z'
  }));
  // Older, duplicated pending IDs must all disappear when one updated row
  // supersedes them, without reordering unrelated history.
  existing.splice(20,0,{id:'replace-a',points:1},{id:'replace-b',points:2});
  existing.splice(350,0,{id:'replace-a',points:3});
  const h=makeHarness({[JOURNAL_KEY]:JSON.stringify({
    schemaVersion:1,
    tasks:[{id:'older-pending-task',title:'Preserve me'}],
    completionUpserts:existing,
    completionDeletes:['replace-a','untouched-delete','replace-b'],
    updatedAtISO:'2026-10-22T12:00:00.000Z'
  })});
  const replacement=[
    {id:'replace-b',points:99,workHours:8.5,source:'work'},
    {id:'fresh-work',points:8,workHours:8,source:'work'},
    {id:'replace-a',points:98,workHours:7,source:'work'}
  ];
  let writes=0;
  const originalSet=h.storage.setItem.bind(h.storage);
  h.storage.setItem=(key,value)=>{
    if(key===JOURNAL_KEY)writes++;
    return originalSet(key,value);
  };
  h.core.journalTaskCompletionBatch(replacement);
  assert.equal(writes,1,'batch action still uses exactly one synchronous journal write');
  assert.equal(h.getSaveCalls(),0);
  const pending=JSON.parse(h.storage.getItem(JOURNAL_KEY));
  assert.deepEqual(Array.from(pending.completionUpserts,row=>row.id),[
    ...existing.filter(row=>row.id!=='replace-a'&&row.id!=='replace-b').map(row=>row.id),
    'replace-b','fresh-work','replace-a'
  ]);
  assert.deepEqual(Array.from(pending.completionDeletes),['untouched-delete']);
  assert.deepEqual(Array.from(pending.tasks,row=>row.id),['older-pending-task']);
  assert.equal(pending.completionUpserts.find(row=>row.id==='replace-b').points,99);
  assert.equal(pending.completionUpserts.find(row=>row.id==='replace-a').points,98);
  assert.equal(h.core.flushPendingTaskMutations(),true);
  const persisted=JSON.parse(h.storage.getItem(STORAGE_KEY));
  for(const row of replacement) {
    assert.equal(persisted.completions.filter(item=>item.id===row.id).length,1);
    assert.equal(persisted.completions.find(item=>item.id===row.id).points,row.points);
  }
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('multi-row batch preserves single-pass pending-journal merge contract',()=>{
  const start=moduleSource.indexOf("if (Object.prototype.hasOwnProperty.call(mutation, 'completionUpserts')) {");
  const end=moduleSource.indexOf('if (mutation.completionDeleteId)',start);
  assert.ok(start>=0&&end>start);
  const block=moduleSource.slice(start,end);
  assert.match(block,/const seen = new Set\(\)/);
  assert.equal((block.match(/record\.completionUpserts\s*=\s*record\.completionUpserts\.filter\(/g)||[]).length,1);
  assert.equal((block.match(/record\.completionDeletes\s*=\s*record\.completionDeletes\.filter\(/g)||[]).length,1);
  assert.doesNotMatch(block,/mergeById\(/,'batch must not rescan all pending rows for each update');
});

test('large pending completion replay exactly matches legacy order and duplicate semantics',()=>{
  const baseline={
    tasks:[{id:'t1',title:'Original'}],
    completions:Array.from({length:900},(_,i)=>({
      id:'history-'+i,points:i,source:'work'
    }))
  };
  // Legacy histories may have duplicated existing IDs. findIndex replaces
  // only the first one, leaving subsequent duplicates untouched.
  baseline.completions.splice(300,0,
    {id:'legacy-duplicate',points:1},
    {id:'legacy-duplicate',points:2});
  const record={
    schemaVersion:1,
    tasks:[{id:'t1',title:'Latest'}],
    completionDeletes:['history-40','history-41'],
    completionUpserts:[
      ...Array.from({length:25},(_,i)=>({id:'history-'+(i*9),points:1000+i})),
      {id:'legacy-duplicate',points:20},
      {id:'new-duplicate',points:1},
      ...Array.from({length:18},(_,i)=>({id:'new-'+i,points:2000+i})),
      {id:'new-duplicate',points:2},
      {id:'legacy-duplicate',points:22},
      {id:'new-2',points:4000}
    ]
  };
  const oldCompletions=clone(baseline.completions);
  const expected=oldCompletions.filter(row=>
    !record.completionDeletes.includes(String(row?.id||'')));
  for(const patch of record.completionUpserts){
    const at=expected.findIndex(row=>String(row?.id||'')===String(patch.id));
    if(at>=0)expected[at]=clone(patch);
    else expected.unshift(clone(patch));
  }
  const h=makeHarness();
  const result=h.core.applyPendingTaskMutations(baseline,record);
  // VM realm arrays have different prototypes; compare canonical row data.
  assert.deepEqual(clone(result.completions),expected);
  assert.deepEqual(baseline.completions,oldCompletions,'replay must not mutate original history');
  assert.equal(result.tasks[0].title,'Latest');
  assert.equal(result.completions.filter(row=>row.id==='legacy-duplicate').length,2);
  assert.equal(result.completions.find(row=>row.id==='new-duplicate').points,2);
  assert.equal(result.completions.find(row=>row.id==='new-2').points,4000);
});

test('many pending completion patches do not rescan historical row IDs for each patch',()=>{
  let reads=0;
  const rows=Array.from({length:600},(_,i)=>{
    const row={points:i};
    Object.defineProperty(row,'id',{
      enumerable:true,
      get(){reads++;return 'tracked-'+i;}
    });
    return row;
  });
  const h=makeHarness();
  const updates=Array.from({length:48},(_,i)=>({
    id:'tracked-'+(i*9),points:1000+i
  }));
  const result=h.core.applyPendingTaskMutations(
    {tasks:[],completions:rows},
    {schemaVersion:1,tasks:[],completionUpserts:updates,completionDeletes:[]}
  );
  const replayReads=reads;
  assert.equal(result.completions.length,600);
  for(const update of updates){
    assert.equal(result.completions.find(row=>row.id===update.id)?.points,update.points);
  }
  // Exclude the test's own lookups: 48 independent scans across 600 source
  // rows would exceed 12,000 ID reads. The indexed replay needs ~1,200.
  assert.ok(replayReads<2500,
    'large replay performed excessive historical ID scans: '+replayReads);
});

test('invalid multi-row completion batches reject all rows and preserve existing journal',()=>{
  const h=makeHarness();
  const base={id:'work-existing',source:'work',points:5};
  h.core.journalTaskMutation({completionUpsert:base});
  const raw=h.storage.getItem(JOURNAL_KEY);
  for(const rows of [[],[base,{id:'work-existing',points:7}],
    [base,null],[base,{points:1}],null,
    Array.from({length:65},(_,i)=>({id:'overflow-'+i,points:1}))]){
    assert.throws(()=>h.core.journalTaskCompletionBatch(rows),error=>
      error?.code==='TASKPOINTS_TASK_COMPLETION_BATCH_INVALID');
    assert.equal(h.storage.getItem(JOURNAL_KEY),raw);
  }
  assert.equal(h.getSaveCalls(),0);
});

test('quota failure during a multi-row batch leaves neither row persisted or acknowledged',()=>{
  const h=makeHarness();
  h.core.journalTaskMutation({completionUpsert:{id:'previous',points:3}});
  const raw=h.storage.getItem(JOURNAL_KEY);
  const generation=h.core.getTaskMutationJournalStatus().mutationGeneration;
  const originalSet=h.storage.setItem.bind(h.storage);
  let attempts=0;
  h.storage.setItem=(key,value)=>{
    if(key===JOURNAL_KEY){
      attempts++;
      throw Object.assign(new Error('Quota exceeded'),{name:'QuotaExceededError'});
    }
    return originalSet(key,value);
  };
  assert.throws(()=>h.core.journalTaskCompletionBatch([
    {id:'work-unsaved',points:8},{id:'sleep-unsaved',points:7}
  ]),/Quota exceeded/);
  assert.equal(attempts,1,'a failed batch must never fall through to per-row writes');
  assert.equal(h.storage.getItem(JOURNAL_KEY),raw);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration,generation);
  assert.equal(h.getSaveCalls(),0);
  const pending=h.core.readPendingTaskMutations();
  assert.deepEqual(Array.from(pending.record.completionUpserts,row=>row.id),['previous']);
});

test('task completion deletion replays and verified compaction clears the journal', () => {
  const h = makeHarness();
  const task = { id: 't1', title: 'Task', status: 'trashed', counts: 0 };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });
  let loaded = h.core.readTaskPointsStoredState();
  assert.equal(loaded.tasks[0].status, 'trashed');
  assert.equal(loaded.completions.length, 0);
  assert.equal(h.getSaveCalls(), 0);

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  loaded = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(loaded.tasks[0].status, 'trashed');
  assert.equal(loaded.completions.length, 0);
});

test('Task journal rejects non-array, incomplete and unknown-field records without loss',()=>{
 const examples=[
  {schemaVersion:1,tasks:[{id:'pending-edit',title:'Keep me'}],
   completionUpserts:'not-an-array',completionDeletes:[]},
  {schemaVersion:1,tasks:[{id:'pending-edit',title:'Keep me'}],
   completionUpserts:[]},
  {schemaVersion:1,tasks:[{id:'pending-edit',title:'Keep me'}],
   completionUpserts:[],completionDeletes:[],
   unknownNewMigrationPayload:{id:'must-remain'}},
  {schemaVersion:1,tasks:[{id:'pending-edit',title:'Keep me'},null],
   completionUpserts:[],completionDeletes:[]},
  {schemaVersion:1,tasks:[],completionUpserts:[{id:'important'},{}],
   completionDeletes:[]},
  {schemaVersion:1,tasks:[],completionUpserts:[],completionDeletes:[null]},
  {schemaVersion:1,tasks:[{id:0,title:'would-have-been-dropped'}],
   completionUpserts:[],completionDeletes:[]}
 ];
 for(const record of examples){
  const raw=JSON.stringify(record);
  const h=makeHarness({[JOURNAL_KEY]:raw});
  assert.equal(h.core.getTaskMutationJournalStatus().malformed,true,
    'unsupported stored journal must remain visible as malformed');
  assert.throws(()=>h.core.journalTaskMutation({
    task:{id:'t2',title:'Do not overwrite pending journal'}
  }),e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED');
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.storage.getItem(JOURNAL_KEY),raw,
    'unknown or malformed pending bytes must remain exactly unchanged');
  assert.equal(h.getSaveCalls(),0);
 }
});

test('blank but present Task journal is preserved as interrupted evidence, not replaced on an edit',()=>{
  const h=makeHarness({[JOURNAL_KEY]:''});
  assert.equal(h.core.readPendingTaskMutations().malformed,true);
  const beforeGeneration=h.core.getTaskMutationJournalStatus().mutationGeneration;
  const beforeTimers=h.timers.length;
  assert.throws(()=>h.core.journalTaskMutation({
    task:{id:'new-edit',title:'Must not overwrite blank journal'}
  }),e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED');
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration,beforeGeneration);
  assert.equal(h.timers.length,beforeTimers);
  assert.equal(h.storage.getItem(JOURNAL_KEY),'');
  assert.equal(h.getSaveCalls(),0);
});

test('undefined storage readback cannot be mistaken for a missing Task journal',()=>{
  const h=makeHarness();
  const get=h.storage.getItem.bind(h.storage);
  let attemptedWrites=0;
  const set=h.storage.setItem.bind(h.storage);
  h.storage.getItem=key=>key===JOURNAL_KEY ? undefined : get(key);
  h.storage.setItem=(key,value)=>{
    if(key===JOURNAL_KEY)attemptedWrites++;
    return set(key,value);
  };
  assert.equal(h.core.readPendingTaskMutations().malformed,true);
  assert.throws(()=>h.core.journalTaskMutation({
    task:{id:'new-edit',title:'Never claim storage was empty'}
  }),e=>e.code==='TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED');
  assert.equal(h.core.flushPendingTaskMutations(),false);
  assert.equal(attemptedWrites,0);
  assert.equal(get(JOURNAL_KEY),null);
  assert.equal(h.getSaveCalls(),0);
});

test('valid older Task journal without optional timestamp remains compatible',()=>{
 const raw=JSON.stringify({
  schemaVersion:1,tasks:[{id:'old-task',title:'Preserve'}],
  completionUpserts:[],completionDeletes:[]
 });
 const h=makeHarness({[JOURNAL_KEY]:raw});
 assert.equal(h.core.getTaskMutationJournalStatus().malformed,false);
 const value=h.core.journalTaskMutation({task:{id:'new-task',title:'New'}});
 assert.deepEqual(Array.from(value.tasks,t=>t.id),['old-task','new-task']);
 assert.equal(h.core.getTaskMutationJournalStatus().journalWritesVerified,1);
 assert.equal(JSON.parse(h.storage.getItem(JOURNAL_KEY)).tasks.length,2);
});

test('malformed journal is preserved and blocks a new journal mutation', () => {
  const h = makeHarness({ [JOURNAL_KEY]: '{bad-json' });
  assert.throws(() => h.core.assertTaskMutationJournalWritable(), /malformed and was preserved/);
  assert.throws(() => h.core.journalTaskMutation({ completionDeleteId: 'old' }), /malformed and was preserved/);
  assert.equal(h.storage.getItem(JOURNAL_KEY), '{bad-json');
  assert.equal(h.getSaveCalls(), 0);
});

test('ordinary full save refuses a peer Task journal edit during snapshot parsing',()=>{
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'First pending edit'}});
  const beforeSnapshot=h.storage.getItem(STORAGE_KEY);
  const initialRaw=h.storage.getItem(JOURNAL_KEY);
  const newer=JSON.parse(initialRaw);
  newer.tasks[0].title='Newer edit from peer tab';
  const peerRaw=JSON.stringify(newer);
  let injected=false;
  h.core.parseTaskPointsStorageJson=raw=>{
    if(!injected){
      injected=true;
      h.storage.setItem(JOURNAL_KEY,peerRaw);
    }
    return JSON.parse(raw);
  };
  const stale=JSON.parse(beforeSnapshot);
  stale.notes='Ordinary Home save';
  const result=h.core.saveStateSnapshot(stale,{savePath:'home-normal-save'});
  assert.equal(injected,true);
  assert.equal(result.skipped,true);
  assert.equal(result.blockedByTaskSourceChanged,true);
  assert.equal(result.taskJournalSourceChanged,true);
  assert.equal(result.taskSnapshotSourceChanged,false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.storage.getItem(STORAGE_KEY),beforeSnapshot);
  assert.equal(h.storage.getItem(JOURNAL_KEY),peerRaw);
  assert.equal(h.core.getTaskMutationJournalStatus().fullSaveSourceRefusals,1);
  h.core.parseTaskPointsStorageJson=raw=>JSON.parse(raw);
  const retried=h.core.saveStateSnapshot(stale,{savePath:'home-normal-retry'});
  assert.equal(retried.skipped,undefined);
  assert.equal(h.getSaveCalls(),1);
  const persisted=JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks.find(t=>t.id==='t1').title,'Newer edit from peer tab');
  assert.equal(persisted.notes,'Ordinary Home save');
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('ordinary full save refuses a peer full V1 snapshot save while Task journal is pending',()=>{
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'Pending Task'}});
  const pending=h.storage.getItem(JOURNAL_KEY);
  const initial=JSON.parse(h.storage.getItem(STORAGE_KEY));
  const newer={...initial,notes:'Peer Notes that must survive',
    completions:[...initial.completions,{id:'peer-history',source:'work',points:7}]};
  const newerRaw=JSON.stringify(newer);
  let injected=false;
  h.core.parseTaskPointsStorageJson=raw=>{
    if(!injected){
      injected=true;
      h.storage.setItem(STORAGE_KEY,newerRaw);
    }
    return JSON.parse(raw);
  };
  const stale={...initial,notes:'Stale Notes must not win'};
  const result=h.core.saveStateSnapshot(stale,{savePath:'home-normal-save'});
  assert.equal(result.skipped,true);
  assert.equal(result.blockedByTaskSourceChanged,true);
  assert.equal(result.taskSnapshotSourceChanged,true);
  assert.equal(result.taskJournalSourceChanged,false);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(h.storage.getItem(STORAGE_KEY),newerRaw);
  assert.equal(h.storage.getItem(JOURNAL_KEY),pending);
  h.core.parseTaskPointsStorageJson=raw=>JSON.parse(raw);
  const safeRetry=h.core.saveStateSnapshot({...newer,notes:'Peer Notes that must survive'},
    {savePath:'home-normal-retry'});
  assert.equal(safeRetry.skipped,undefined);
  const persisted=JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.notes,'Peer Notes that must survive');
  assert.equal(persisted.completions.find(x=>x.id==='peer-history').points,7);
  assert.equal(persisted.tasks.find(x=>x.id==='t1').title,'Pending Task');
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('ordinary full save fails closed when pending Task source cannot be rechecked',()=>{
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'Durable pending'}});
  const pending=h.storage.getItem(JOURNAL_KEY);
  const baseline=h.storage.getItem(STORAGE_KEY);
  const realGet=h.storage.getItem.bind(h.storage);
  let journalReads=0;
  h.storage.getItem=key=>{
    if(key===JOURNAL_KEY&&++journalReads===2)throw Error('denied read');
    return realGet(key);
  };
  const result=h.core.saveStateSnapshot(JSON.parse(baseline),{savePath:'home-normal-save'});
  assert.equal(result.skipped,true);
  assert.equal(result.blockedByTaskSourceChanged,true);
  assert.equal(result.taskJournalSourceChanged,true);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(realGet(JOURNAL_KEY),pending);
  assert.equal(realGet(STORAGE_KEY),baseline);
  h.storage.getItem=realGet;
  assert.equal(h.core.saveStateSnapshot(JSON.parse(baseline)).skipped,undefined);
  assert.equal(h.storage.getItem(JOURNAL_KEY),null);
});

test('stale preview tab cannot use an ordinary full-state save to overwrite a reset generation', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost' });
  const original = h.storage.getItem(STORAGE_KEY);
  h.storage.setItem(generationKey, 'epoch-B');
  const candidate = { ...JSON.parse(original), notes: 'Stale preview overwrite' };
  const blocked = h.core.saveStateSnapshot(candidate, { savePath: 'home-normal-save' });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.blockedByTaskPreviewGenerationChanged, true);
  assert.equal(h.getSaveCalls(), 0);
  assert.equal(h.storage.getItem(STORAGE_KEY), original);
  assert.equal(h.core.getTaskMutationJournalStatus().fullSaveSourceRefusals, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().previewGenerationBlocks, 1);

  // A fresh tab loaded after the reset binds to the new token and can save.
  const fresh = makeHarness({}, { storage: h.storage, hostname: 'localhost' });
  const allowed = fresh.core.saveStateSnapshot(candidate, { savePath: 'home-normal-save' });
  assert.notEqual(allowed.skipped, true);
  assert.equal(fresh.getSaveCalls(), 1);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes, 'Stale preview overwrite');
});

test('preview full save refuses a reset rotation during full-snapshot preparation and retains pending Task edits', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost' });
  h.core.journalTaskMutation({ task: { id: 't1', title: 'Durable journal edit' } });
  const original = h.storage.getItem(STORAGE_KEY);
  const pending = h.storage.getItem(JOURNAL_KEY);
  let parsed = false;
  h.core.parseTaskPointsStorageJson = raw => {
    parsed = true;
    h.storage.setItem(generationKey, 'epoch-B');
    return JSON.parse(raw);
  };
  const blocked = h.core.saveStateSnapshot(
    { ...JSON.parse(original), notes: 'Must not overwrite restored state' },
    { savePath: 'home-normal-save' }
  );
  assert.equal(parsed, true, 'generation rotated after snapshot preparation began');
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.blockedByTaskPreviewGenerationChanged, true);
  assert.equal(h.getSaveCalls(), 0, 'do not invoke the underlying full-state writer');
  assert.equal(h.storage.getItem(STORAGE_KEY), original);
  assert.equal(h.storage.getItem(JOURNAL_KEY), pending,
    'uncompacted Task evidence must survive stale-tab refusal');
});

test('unreadable preview generation refuses ordinary full-state saves without entering a fallback', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
    { hostname: 'localhost' });
  const original = h.storage.getItem(STORAGE_KEY);
  const normalGet = h.storage.getItem.bind(h.storage);
  h.storage.getItem = key => {
    if (key === generationKey) throw new Error('generation read denied');
    return normalGet(key);
  };
  const blocked = h.core.saveStateSnapshot(
    { ...JSON.parse(original), notes: 'Must not save' },
    { savePath: 'home-normal-save' }
  );
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.blockedByTaskPreviewGenerationChanged, true);
  assert.equal(h.getSaveCalls(), 0);
  assert.equal(normalGet(STORAGE_KEY), original);
});

test('production and explicitly disabled preview preserve the existing ordinary V1 full-save path', () => {
  const generationKey = 'taskpoints_state_v2_generation_v1';
  const darkKey = 'taskpoints_state_v2_dark_mode_v1';
  for (const hostname of ['taskpoints.pages.dev', 'localhost']) {
    const h = makeHarness({ [generationKey]: 'epoch-A', [darkKey]: '1' },
      { hostname });
    if (hostname === 'localhost') h.storage.setItem(darkKey, '0');
    h.storage.setItem(generationKey, 'epoch-B');
    const candidate = { ...JSON.parse(h.storage.getItem(STORAGE_KEY)), notes: hostname };
    const result = h.core.saveStateSnapshot(candidate, { savePath: 'home-normal-save' });
    assert.notEqual(result.skipped, true, hostname);
    assert.equal(h.getSaveCalls(), 1, hostname);
    assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes, hostname);
  }
});

test('full saves without pending Task journal still retain ordinary V1 save behavior',()=>{
  const h=makeHarness();
  const state=JSON.parse(h.storage.getItem(STORAGE_KEY));
  state.notes='Unrelated fresh Notes save';
  const result=h.core.saveStateSnapshot(state,{savePath:'home-normal-save'});
  assert.equal(result.skipped,undefined);
  assert.equal(h.getSaveCalls(),1);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes,'Unrelated fresh Notes save');
  assert.equal(h.core.getTaskMutationJournalStatus().fullSaveSourceRefusals,0);
});

test('Home Weight and VO2 entry dialogs never acknowledge a skipped guarded full save',()=>{
  for(const {start,end,resultName,modalClose} of [
    {start:'function submitWeightEntry()',end:'function openVo2MaxModal()',
      resultName:'weightSave',modalClose:'closeWeightModal()'},
    {start:'function submitVo2MaxEntry()',end:'function drawDailyTrend(',
      resultName:'vo2Save',modalClose:'closeVo2MaxModal()'}
  ]){
    const first=homeSource.indexOf(start);
    const last=homeSource.indexOf(end,first);
    assert.ok(first>=0&&last>first,'expected Home dialog: '+start);
    const handler=homeSource.slice(first,last);
    const guard=handler.indexOf('if ('+resultName+'?.skipped || '+resultName+'?.blockedByQuotaCircuit)');
    const success=handler.indexOf('state = normalizeState('+resultName+'.state)');
    const close=handler.indexOf(modalClose);
    assert.ok(guard>=0&&success>guard&&close>guard,
      resultName+' must refuse a skipped guarded save before updating UI or closing modal');
    assert.match(handler.slice(guard,success),/return;/,
      resultName+' must stop the success path after a skipped save');
  }
});

test('ordinary full save cannot bypass a denied Task journal read through Home fallback',()=>{
  const h=makeHarness();
  h.core.journalTaskMutation({task:{id:'t1',title:'Durable pending edit'}});
  const pending=h.storage.getItem(JOURNAL_KEY);
  const originalSnapshot=h.storage.getItem(STORAGE_KEY);
  const get=h.storage.getItem.bind(h.storage);
  let readAttempts=0;
  h.storage.getItem=key=>{
    if(key===JOURNAL_KEY){
      readAttempts++;
      throw new Error('Task journal access denied');
    }
    return get(key);
  };
  const candidate=JSON.parse(originalSnapshot);
  candidate.notes='Should not save without pending Task overlay';
  let outcome,thrown=false;
  try{outcome=h.core.saveStateSnapshot(candidate,{savePath:'home-save'});}
  catch(_){thrown=true;}
  assert.equal(thrown,false,'blocked ordinary save must not enter Home exception fallback');
  assert.equal(outcome.skipped,true);
  assert.equal(outcome.blockedByTaskJournalUnreadable,true);
  assert.equal(readAttempts,1);
  assert.equal(h.getSaveCalls(),0);
  assert.equal(get(STORAGE_KEY),originalSnapshot);
  assert.equal(get(JOURNAL_KEY),pending);
  h.storage.getItem=get;
  assert.equal(h.core.getTaskMutationJournalStatus().fullSaveSourceRefusals,1);
  assert.equal(h.core.saveStateSnapshot(candidate,{savePath:'home-save-retry'}).skipped,undefined);
  const saved=JSON.parse(get(STORAGE_KEY));
  assert.equal(saved.tasks.find(t=>t.id==='t1').title,'Durable pending edit');
  assert.equal(saved.notes,'Should not save without pending Task overlay');
  assert.equal(get(JOURNAL_KEY),null);
});

test('ordinary full save with missing Task journal still succeeds without source refusal',()=>{
  const h=makeHarness();
  const before=h.storage.getItem(STORAGE_KEY);
  const candidate=JSON.parse(before);
  candidate.notes='Normal operation unchanged';
  const result=h.core.saveStateSnapshot(candidate,{savePath:'home-save'});
  assert.notEqual(result.skipped,true);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).notes,'Normal operation unchanged');
  assert.equal(h.core.getTaskMutationJournalStatus().fullSaveSourceRefusals,0);
});

test('Settings game reset and skills clear reject skipped guarded Task-safe snapshots',()=>{
  const validatedSaveAt=settingsSource.indexOf('const resetValidated = TaskPointsCore.saveValidatedSnapshot(');
  const validatedGuardAt=settingsSource.indexOf('if (resetValidated?.blocked || resetValidated?.skipped');
  assert.ok(validatedSaveAt>0&&validatedGuardAt>validatedSaveAt,
    'Settings validated Game reset must also reject blocked or skipped snapshots');
  const resetAt=settingsSource.indexOf('function resetOldGameStats');
  const resetSaveAt=settingsSource.indexOf('const resetSaved = TaskPointsCore.saveStateSnapshot(');
  const resetGuardAt=settingsSource.indexOf('if (resetSaved?.skipped || resetSaved?.blockedByQuotaCircuit)');
  assert.ok(resetSaveAt>0&&resetGuardAt>resetSaveAt,
    'Settings Game reset must test the guarded full-save result');
  assert.match(settingsSource.slice(resetGuardAt,resetGuardAt+270),
    /throw new Error/,
    'Settings Game reset must not show success after a skipped save');
  const clearStart=settingsSource.indexOf('function saveSkillsClearedState(');
  const clearEnd=settingsSource.indexOf('function handleClearAllSkills()',clearStart);
  assert.ok(clearStart>0&&clearEnd>clearStart);
  const clearSource=settingsSource.slice(clearStart,clearEnd);
  assert.match(clearSource,/if \(saved\?\.skipped \|\| saved\?\.blockedByQuotaCircuit\)/,
    'Settings Skills clear must notice a skipped full save');
  assert.match(clearSource,/throw new Error\('Skills clear was not saved/,
    'Settings Skills clear must use its existing user-visible error path');
});

test('full saves automatically include pending mutations before verification clears them', () => {
  const h = makeHarness();
  h.core.journalTaskMutation({ completionDeleteId: 'old' });
  const stale = JSON.parse(h.storage.getItem(STORAGE_KEY));
  h.core.saveStateSnapshot(stale, { savePath: 'unrelated-save' });
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.length, 0);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});


test('+1 Day stays durable after journal compaction even if an older delayed full save fires later', () => {
  const baseline = {
    tasks: [{
      id: 't1',
      title: 'Task',
      status: 'active',
      counts: 0,
      dueDateISO: '2026-10-06',
      updatedAtISO: '2026-10-06T18:00:00.000Z'
    }],
    completions: []
  };
  const h = makeHarness({ [STORAGE_KEY]: JSON.stringify(baseline) });
  const staleBeforeBump = clone(baseline);
  const bumped = {
    ...baseline.tasks[0],
    dueDateISO: '2026-10-07',
    postponedDays: 1,
    updatedAtISO: '2026-10-06T20:00:00.000Z'
  };

  h.core.journalTaskMutation({ task: bumped });
  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'verified compaction should clear the pending journal');
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).tasks[0].dueDateISO, '2026-10-07');

  // Reproduce the reported failure mode: an unrelated delayed save still holds
  // the pre-bump task snapshot and runs only after the journal already cleared.
  h.core.saveStateSnapshot(staleBeforeBump, { savePath: 'delayed-stale-full-save' });

  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].dueDateISO, '2026-10-07');
  assert.equal(persisted.tasks[0].updatedAtISO, '2026-10-06T20:00:00.000Z');
});

test('newer intentional task edits still win after stale-task protection is installed', () => {
  const baseline = {
    tasks: [{
      id: 't1',
      title: 'Task',
      status: 'active',
      counts: 0,
      dueDateISO: '2026-10-07',
      updatedAtISO: '2026-10-06T20:00:00.000Z'
    }],
    completions: []
  };
  const h = makeHarness({ [STORAGE_KEY]: JSON.stringify(baseline) });
  const newerCorrection = clone(baseline);
  newerCorrection.tasks[0].dueDateISO = '2026-10-06';
  newerCorrection.tasks[0].updatedAtISO = '2026-10-06T21:00:00.000Z';

  h.core.saveStateSnapshot(newerCorrection, { savePath: 'newer-user-task-edit' });

  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].dueDateISO, '2026-10-06');
  assert.equal(persisted.tasks[0].updatedAtISO, '2026-10-06T21:00:00.000Z');
});

test('explicit destructive import can intentionally replace a newer persisted task row', () => {
  const current = {
    tasks: [{
      id: 't1',
      title: 'Current',
      status: 'active',
      counts: 0,
      dueDateISO: '2026-10-07',
      updatedAtISO: '2026-10-06T20:00:00.000Z'
    }],
    completions: []
  };
  const imported = {
    tasks: [{
      id: 't1',
      title: 'Imported backup',
      status: 'active',
      counts: 0,
      dueDateISO: '2026-10-06',
      updatedAtISO: '2026-10-05T20:00:00.000Z'
    }],
    completions: []
  };
  const h = makeHarness({ [STORAGE_KEY]: JSON.stringify(current) });

  h.core.saveStateSnapshot(imported, {
    savePath: 'toolbar-import',
    allowDestructiveOverwrite: true
  });

  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].title, 'Imported backup');
  assert.equal(persisted.tasks[0].dueDateISO, '2026-10-06');
});

test('Home and Log use the tiny journal instead of immediate full-state saves for targeted interactions', () => {
  assert.match(homeSource, /journalTaskMutation\(\{ task: liveTask, completionUpsert: completion \}\)/);
  assert.match(logSource, /completionDeleteId: c\.id \|\| key/);
  assert.match(resetSource, /core\.clearPendingTaskMutations\(\) !== true/,
    'shadow reset must require confirmed Task journal cleanup before mirroring an empty state');
});


test('scheduled compaction waits until at least seven seconds since the latest interaction', async () => {
  const h = makeHarness();
  h.setLastInteractionAgoMs(1400);
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup-replay timer; compaction is already scheduled
  await runNextTimer(h); // shared quiet gate -> remaining time to seven seconds idle
  assert.equal(h.getSaveCalls(), 0, 'shared quiet alone must not start full-state compression');
  assert.ok(h.timers.length >= 1, 'the sustained-idle timer should be pending');

  h.setLastInteractionAgoMs(7000);
  await runNextTimer(h); // seven seconds idle -> idle callback -> compaction
  await Promise.resolve();
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.core.getTaskMutationJournalStatus().minIdleBeforeCompactionMs, 7000);
});

test('a user interaction during the extra grace period defers compaction instead of entering compression', async () => {
  const h = makeHarness();
  h.setLastInteractionAgoMs(1400);
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup-replay timer
  await runNextTimer(h); // shared gate passes; sustained-idle timer is now pending
  h.setLastInteractionAgoMs(200);
  h.setMaintenanceQuiet(false);
  await runNextTimer(h); // wait expires after a newer interaction
  await Promise.resolve();

  assert.equal(h.getSaveCalls(), 0, 'full-state save must yield when quiet was broken');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'durable journal must remain pending');
  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);
});


test('a newer journal mutation invalidates an older startup preflight countdown', async () => {
  const h = makeHarness();
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup timer cannot replace the already scheduled mutation run
  await runNextTimer(h); // existing run passes shared quiet and begins extra grace

  h.core.journalTaskMutation({ task: { id: 't1', title: 'Task', status: 'trashed', counts: 0 } });
  await runNextTimer(h); // old grace expires; generation mismatch must abort it
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.getSaveCalls(), 0, 'an older preflight must not compact a newer mutation');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'newer mutation must remain durable in the journal');
  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration, 2);
});

test('verification accepts the save pipeline normalized task row and clears the journal', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) delete task.deletedAt; // representative legacy alias stripped by normalization
      return candidate;
    }
  });
  const task = {
    id: 't1', title: 'Task', status: 'trashed', counts: 0,
    deletedAtISO: '2026-08-11T12:00:00.000Z',
    deletedAt: '2026-08-11T12:00:00.000Z',
    completedAtISO: null,
    hidden: false
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'verified normalized persistence should not retry forever');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].status, 'trashed');
  assert.equal(persisted.tasks[0].deletedAtISO, task.deletedAtISO);
  assert.equal('deletedAt' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});


test('verification accepts canonical task defaults omitted by compact localStorage', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (!task) return candidate;
      if (task.originalDueDateISO === task.dueDateISO) delete task.originalDueDateISO;
      if (task.recurrence?.mode === 'none' && Object.keys(task.recurrence).length === 1) delete task.recurrence;
      if (Array.isArray(task.tags) && task.tags.length === 0) delete task.tags;
      if (Array.isArray(task.skipDates) && task.skipDates.length === 0) delete task.skipDates;
      if (Array.isArray(task.skills) && task.skills.length === 2 && task.skills.every((slot) => slot?.skill === '' && slot?.pts === '')) delete task.skills;
      if (task.hidden === false) delete task.hidden;
      ['deletedAt', 'deletedFrom', 'prevStatus', 'completedAtISO'].forEach((key) => {
        if (task[key] == null) delete task[key];
      });
      if (Number(task.postponedDays) === 0) delete task.postponedDays;
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  const task = {
    id: 't1',
    title: 'Task',
    status: 'active',
    counts: 0,
    dueDateISO: '2026-08-12',
    originalDueDateISO: '2026-08-12',
    recurrence: { mode: 'none' },
    tags: [],
    skipDates: [],
    skills: [{ skill: '', pts: '' }, { skill: '', pts: '' }],
    hidden: false,
    deletedAt: null,
    deletedAtISO: null,
    deletedFrom: null,
    prevStatus: null,
    completedAtISO: null,
    postponedDays: 0
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'canonical compact omissions must verify and clear the journal');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.__storageCompactVersion, 1);
  assert.equal(persisted.tasks[0].dueDateISO, task.dueDateISO);
  assert.equal('originalDueDateISO' in persisted.tasks[0], false);
  assert.equal('hidden' in persisted.tasks[0], false);
  assert.equal('postponedDays' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});

test('compact task verification still rejects substantive field corruption', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) task.status = 'trashed';
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  h.core.journalTaskMutation({
    task: { id: 't1', title: 'Task', status: 'active', counts: 0 },
    completionDeleteId: 'old'
  });

  assert.equal(h.core.flushPendingTaskMutations(), false);
  assert.equal(h.getSaveCalls(), 1);
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'journal must remain durable after substantive verification failure');
});

test('stale Home Season save cannot erase previously committed Sleep and Mood entries after journal clears', () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const when = now.toISOString();
  const sleep = { id: 'sleep-committed', title: 'Sleep Score (87) — Rest 6', points: 9.3, completedAtISO: when, source: 'metric', sleepRested: 6 };
  const mood = { id: 'mood-committed', title: 'Mood Score (3.75)', points: 3.75, completedAtISO: when, source: 'metric', moodNotes: 'Important private note' };
  const h = makeHarness();
  const saved = JSON.parse(h.storage.getItem(STORAGE_KEY));
  saved.completions.unshift(sleep, mood);
  h.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const oldHome = { ...saved, completions: saved.completions.filter((c) => c.id !== sleep.id && c.id !== mood.id) };
  const result = h.core.saveStateSnapshot(oldHome, { savePath: 'home-season-slate-idle-materialization' });
  assert.ok(result.state.completions.some((c) => c.id === sleep.id));
  assert.ok(result.state.completions.some((c) => c.id === mood.id));
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.deepEqual(persisted.completions.find((c) => c.id === sleep.id), sleep);
  assert.deepEqual(persisted.completions.find((c) => c.id === mood.id), mood);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'no pending journal exists to rescue lost rows');
});

test('stale Home save protects recent SCWM once but does not duplicate previously matching entries', () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const row = { id: 'mood-saved', title: 'Mood Score (4)', points: 4, source: 'metric', completedAtISO: now.toISOString() };
  const h = makeHarness();
  const state = JSON.parse(h.storage.getItem(STORAGE_KEY));
  state.completions.push(row);
  h.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  h.core.saveStateSnapshot({ ...state, completions: state.completions.filter((c) => c.id !== row.id) });
  let result = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(result.completions.filter((c) => c.id === row.id).length, 1);
  h.core.saveStateSnapshot(result);
  result = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(result.completions.filter((c) => c.id === row.id).length, 1);
});

test('SCWM guard allows explicit import/reset and Log deletion, never resurrecting intentionally replaced same-day rows', () => {
  const when = new Date().toISOString();
  const row = { id: 'mood-before', title: 'Mood Score (2)', points: 2, source: 'metric', completedAtISO: when };
  const h = makeHarness();
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  persisted.completions.push(row);
  h.storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  const replacement = { ...row, id: 'mood-after', title: 'Mood Score (4)', points: 4 };
  const replaced = { ...persisted, completions: [...persisted.completions.filter(c => c.id !== row.id), replacement] };
  h.core.saveStateSnapshot(replaced, { savePath: 'general-scwm-user-edit' });
  assert.ok(!JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.some(c => c.id === row.id));

  h.storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  h.context.location = { pathname: '/log.html' };
  h.core.saveStateSnapshot({ ...persisted, completions: persisted.completions.filter(c => c.id !== row.id) }, { savePath: 'log-delete' });
  assert.ok(!JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.some(c => c.id === row.id));

  h.storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  h.context.location = { pathname: '/' };
  h.core.saveStateSnapshot({ ...persisted, completions: persisted.completions.filter(c => c.id !== row.id) }, { allowDestructiveOverwrite: true });
  assert.ok(!JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.some(c => c.id === row.id));
});


test('V2 Home maintenance keeps newer persisted Habit completion after its journal already compacted', () => {
  const h = makeHarness();
  const newer = { id: 'habit-1', name: 'Morning', doneKeys: ['2026-10-14'], failedKeys: [], iceKeys: [], updatedAtISO: '2026-10-14T23:32:00.000Z' };
  const completion = { id: 'habit:habit-1:2026-10-14', habitId: 'habit-1', dayKey: '2026-10-14', source: 'habit', points: 3, completedAtISO: '2026-10-14T18:00:00.000Z' };
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  persisted.habits = [newer];
  persisted.completions.unshift(completion);
  h.storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  const stale = clone(persisted);
  stale.habits[0] = { ...newer, doneKeys: [], updatedAtISO: '2026-10-14T23:30:00.000Z' };
  stale.completions = stale.completions.filter(row => row.id !== completion.id);
  stale.liveDiffHistory = { '2026-10-14': [{ score: 4 }] };
  const unrelated = { id: 'new-task-completion', source: 'task', points: 12 };
  stale.completions.push(unrelated);
  const result = h.core.saveStateSnapshot(stale, { savePath: 'home-season-slate-idle-materialization' });
  assert.deepEqual(result.state.habits[0], newer);
  assert.deepEqual(result.state.completions[0], completion);
  assert.deepEqual(result.state.liveDiffHistory, stale.liveDiffHistory);
  assert.ok(result.state.completions.some(x => x.id === unrelated.id), 'unrelated new task completion must not be overwritten');
  assert.equal(result.state.completions.filter(x => x.id === completion.id).length, 1, 'no pilot completion duplicated');
  assert.deepEqual(JSON.parse(h.storage.getItem(STORAGE_KEY)).completions[0], completion);
});

test('V2 Home background maintenance preserves an authoritative off-toggle instead of resurrecting it', () => {
  const h = makeHarness();
  const latest = JSON.parse(h.storage.getItem(STORAGE_KEY));
  latest.habits = [{ id: 'habit-1', doneKeys: [], failedKeys: [], iceKeys: [], updatedAtISO: '2026-10-14T23:35:00.000Z' }];
  h.storage.setItem(STORAGE_KEY, JSON.stringify(latest));
  const stale = clone(latest);
  stale.habits[0].doneKeys = ['2026-10-14'];
  stale.habits[0].updatedAtISO = '2026-10-14T23:30:00.000Z';
  stale.completions.unshift({ id: 'habit:habit-1:2026-10-14', habitId: 'habit-1', dayKey: '2026-10-14', source: 'habit', points: 3 });
  const result = h.core.saveStateSnapshot(stale, { savePath: 'home-live-diff-capture' });
  assert.deepEqual(result.state.habits[0].doneKeys, []);
  assert.equal(result.state.completions.some(x => x.habitId === 'habit-1'), false);
});

test('V2 Home background maintenance overlays an un-compacted Habit tap after rebasing', () => {
  const h = makeHarness();
  const state = JSON.parse(h.storage.getItem(STORAGE_KEY));
  state.habits = [{ id: 'habit-1', name: 'Morning', doneKeys: [], failedKeys: [], iceKeys: [], updatedAtISO: '2026-10-14T23:31:00.000Z' }];
  h.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  const pending = [{ id: 'habit:habit-1:2026-10-14', habitId: 'habit-1', dayKey: '2026-10-14', source: 'habit', status: 'full', updatedAtISO: '2026-10-14T23:35:00.000Z', completedAtISO: '2026-10-14T18:00:00.000Z', completionPoints: 3, completionFraction: 1 }];
  h.storage.setItem('taskpoints_pending_habit_deltas_v1', JSON.stringify(pending));
  h.core.readPendingHabitDeltas = () => JSON.parse(h.storage.getItem('taskpoints_pending_habit_deltas_v1') || '[]');
  h.core.applyPendingHabitDeltas = (target, deltas) => {
    for (const d of deltas) {
      const habit = target.habits.find(row => row.id === d.habitId);
      habit.doneKeys = [d.dayKey];
      habit.updatedAtISO = d.updatedAtISO;
      target.completions.unshift({ id: 'habit:habit-1:2026-10-14', habitId: d.habitId, dayKey: d.dayKey, source: 'habit', points: d.completionPoints, completedAtISO: d.completedAtISO });
    }
    return { state: target };
  };
  const result = h.core.saveStateSnapshot(clone(state), { savePath: 'home-season-slate-idle-materialization' });
  assert.deepEqual(result.state.habits[0].doneKeys, ['2026-10-14']);
  assert.equal(result.state.completions.filter(row => row.habitId === 'habit-1').length, 1);
  assert.equal(h.core.readPendingHabitDeltas().length, 1, 'background maintenance may not discard the durable journal');
});

test('V2 snapshot protection does not hijack intentional edits, delete, or import/restore', () => {
  const h = makeHarness();
  const saved = JSON.parse(h.storage.getItem(STORAGE_KEY));
  saved.habits = [{ id: 'habit-1', doneKeys: ['2026-10-14'], updatedAtISO: '2026-10-14T23:35:00.000Z' }];
  saved.completions.unshift({ id: 'habit:habit-1:2026-10-14', habitId: 'habit-1', dayKey: '2026-10-14', source: 'habit' });
  h.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const stale = { ...saved, habits: [{ ...saved.habits[0], doneKeys: [] }], completions: saved.completions.filter(x => !x.habitId) };
  let result = h.core.saveStateSnapshot(stale, { savePath: 'habit-journal-compaction' });
  assert.equal(result.state.completions.some(x => x.habitId === 'habit-1'), false);
  h.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  result = h.core.saveStateSnapshot(stale, { savePath: 'home-season-slate-idle-materialization', allowDestructiveOverwrite: true });
  assert.equal(result.state.completions.some(x => x.habitId === 'habit-1'), false);
});


test('V2 Home maintenance fails closed on malformed Habit journal without reaching raw snapshot fallback', () => {
  const h = makeHarness();
  const original = h.storage.getItem(STORAGE_KEY);
  const candidate = JSON.parse(original);
  candidate.liveDiffHistory = { newPoint: [{ score: 4 }] };
  h.core.readPendingHabitDeltas = () => { throw new Error('malformed Habit journal'); };
  const result = h.core.saveStateSnapshot(candidate, { savePath: 'home-live-diff-capture' });
  assert.equal(result.skipped, true);
  assert.equal(result.blockedByHabitJournal, true);
  assert.equal(h.storage.getItem(STORAGE_KEY), original, 'the persisted snapshot must not change');
  assert.equal(h.getSaveCalls(), 0, 'no unguarded underlying save');
});

test('V2 Home maintenance refuses to rebuild without an authoritative persisted pilot', () => {
  const h = makeHarness();
  const original = h.storage.getItem(STORAGE_KEY);
  const candidate = JSON.parse(original);
  candidate.habits = [{ id: 'habit-1', doneKeys: ['2026-10-14'] }];
  const result = h.core.saveStateSnapshot(candidate, { savePath: 'home-season-slate-idle-materialization' });
  assert.equal(result.skipped, true);
  assert.equal(h.storage.getItem(STORAGE_KEY), original);
});
