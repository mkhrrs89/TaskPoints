const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const generationSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_generation.js'), 'utf8');
const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  get length() { return this.rows.size; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
}

// A single simulated origin can have several independent tab runtimes.
// UUIDs must be unique across those runtimes, not restart at 1 per tab.
let nextFakeUuid = 0;

function install(initial = {}, sharedStorage = null) {
  const localStorage = sharedStorage || new FakeStorage(initial);
  const context = {
    localStorage,
    structuredClone,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    console,
    crypto: { randomUUID() { nextFakeUuid += 1; return `wal-test-${nextFakeUuid}`; } }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  return { api: context.TaskPointsStateRuntimeV2Wal, generation: context.TaskPointsStateRuntimeV2Generation, localStorage, context };
}

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const KEY = 'taskpoints_v2_pending_mutations_v1';
const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
const deltaA = { id: 'habit:h1:2026-08-31', habitId: 'h1', dayKey: '2026-08-31', status: 'full', done: true, updatedAtISO: '2026-08-31T12:00:00.000Z' };
const deltaB = { id: 'habit:h2:2026-08-31', habitId: 'h2', dayKey: '2026-08-31', status: 'half', done: true, completionFraction: 0.5, updatedAtISO: '2026-08-31T12:01:00.000Z' };

test('shared WAL recovery enumeration reads legacy sidecars and claims in one pass', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const rows = [deltaA, deltaB,
    { ...deltaA, id: 'habit:h3:2026-08-30', habitId: 'h3',
      dayKey: '2026-08-30', updatedAtISO: '2026-08-30T12:01:00.000Z' }];
  const admitted = rows.map(row => api.appendHabitDelta(row));
  assert.equal(api.getStatus().independentEventCount,3);
  assert.equal(api.getStatus().admissionClaimCount,3);
  const originalKey = localStorage.key.bind(localStorage);
  let scans = 0;
  localStorage.key = index => { scans++; return originalKey(index); };
  try {
    const n = localStorage.length;
    const read = api.getPendingRows();
    assert.equal(read.ok,true);
    assert.deepEqual(read.rows.map(row=>row.id).sort(),
      admitted.map(row=>row.mutationId).sort());
    assert.equal(scans,n,
      'read must inspect every localStorage key exactly once, not once per sidecar type');
    scans = 0;
    const status = api.getStatus();
    assert.equal(status.pendingCount,3);
    assert.equal(status.independentEventCount,3);
    assert.equal(status.admissionClaimCount,3);
    assert.equal(scans,2*n,
      'status must perform its own fresh verified read and a fresh independent inventory');
  } finally {
    localStorage.key = originalKey;
  }
  for (const admittedRow of admitted) {
    const cleared = api.removeMutation(admittedRow.mutationId,
      { generation: admittedRow.generation, delta: admittedRow.row.delta });
    assert.equal(cleared.removed,true);
  }
  const empty = api.getStatus();
  assert.equal(empty.pendingCount,0);
  assert.equal(empty.independentEventCount,0);
  assert.equal(empty.admissionClaimCount,0);
});

test('single-pass WAL inventory still blocks corrupt claims without rewriting evidence', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const admitted = api.appendHabitDelta(deltaA);
  const key = [...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  assert.ok(key);
  const original = localStorage.getItem(key);
  const invalid = JSON.stringify({
    ...JSON.parse(original),
    delta: {...JSON.parse(original).delta, clientMemo:'tampered-claim'}
  });
  localStorage.setItem(key,invalid);
  const sharedBefore = localStorage.getItem(KEY);
  const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+admitted.mutationId;
  const sidecarBefore=localStorage.getItem(sidecarKey);
  const read=api.getPendingRows();
  assert.equal(read.ok,false);
  assert.match(read.error,/wal_admission_claim_identity_conflict/);
  assert.throws(()=>api.appendHabitDelta(deltaB),/wal_admission_claim_identity_conflict/);
  assert.throws(()=>api.removeMutation(admitted.mutationId,
    {generation:admitted.generation,delta:admitted.row.delta}),
    /wal_admission_claim_identity_conflict/);
  assert.equal(localStorage.getItem(KEY),sharedBefore);
  assert.equal(localStorage.getItem(sidecarKey),sidecarBefore);
  assert.equal(localStorage.getItem(key),invalid);
  assert.equal(api.getStatus().pendingCount,null);
  localStorage.setItem(key,original);
  assert.equal(api.removeMutation(admitted.mutationId,
    {generation:admitted.generation,delta:admitted.row.delta}).removed,true);
});

test('duplicate UUID candidate retries without overwriting an older admission claim',()=>{
  const {api,localStorage,context}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const originalClaimKey=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const originalClaim=localStorage.getItem(originalClaimKey);
  const collisionSuffix=originalClaimKey.slice(api.CLAIM_PREFIX.length);
  const nextSuffix='safe-unique-claim-after-collision';
  const originalRandom=context.crypto.randomUUID;
  const calls=[];
  context.crypto.randomUUID=()=>{
    const token=calls.length===0?collisionSuffix:nextSuffix;
    calls.push(token);
    return token;
  };
  let second;
  try{second=api.appendHabitDelta(deltaB);}
  finally{context.crypto.randomUUID=originalRandom;}
  assert.equal(second.written,true);
  assert.deepEqual(calls,[collisionSuffix,nextSuffix]);
  assert.equal(localStorage.getItem(originalClaimKey),originalClaim,
    'first claim must remain byte-for-byte unchanged');
  assert.ok(localStorage.getItem(api.CLAIM_PREFIX+nextSuffix));
  assert.deepEqual(api.getPendingRows().rows.map(row=>row.id).sort(),
    [first.mutationId,second.mutationId].sort());
  for(const entry of [first,second])
    assert.equal(api.removeMutation(entry.mutationId,
      {generation:entry.generation,delta:entry.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('exhausted duplicate claim UUIDs fail closed without corrupting older WAL',()=>{
  const {api,localStorage,context}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const claimKey=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const claimBefore=localStorage.getItem(claimKey);
  const sharedBefore=localStorage.getItem(KEY);
  const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+first.mutationId;
  const sidecarBefore=localStorage.getItem(sidecarKey);
  const originalRandom=context.crypto.randomUUID;
  let attempts=0;
  context.crypto.randomUUID=()=>{attempts++;return claimKey.slice(api.CLAIM_PREFIX.length);};
  try{assert.throws(()=>api.appendHabitDelta(deltaB),
    /state_runtime_v2_wal_claim_key_collision/);}
  finally{context.crypto.randomUUID=originalRandom;}
  assert.equal(attempts,8,'collision retries must have a finite safety bound');
  assert.equal(localStorage.getItem(claimKey),claimBefore);
  assert.equal(localStorage.getItem(KEY),sharedBefore);
  assert.equal(localStorage.getItem(sidecarKey),sidecarBefore);
  assert.equal(api.getStatus().pendingCount,1);
  assert.deepEqual(api.getPendingRows().rows.map(row=>row.id),[first.mutationId]);
  assert.equal(api.removeMutation(first.mutationId,
    {generation:first.generation,delta:first.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('V2 WAL fast append avoids repeated full-array JSON serialization without omitting rows', () => {
  const {api,localStorage,context}=install({[DARK]:'1'});
  const originalJson=context.JSON;
  let arraySerializations=0, rowSerializations=0;
  context.JSON={
    parse: originalJson.parse.bind(originalJson),
    stringify(value,...rest){
      if(Array.isArray(value)&&value.length>1) arraySerializations++;
      else if(value&&value.type==='habit-completion-set') rowSerializations++;
      return originalJson.stringify(value,...rest);
    }
  };
  const admitted=[];
  try{
    for(let n=0;n<15;n++){
      const day='2026-10-'+String(n+1).padStart(2,'0');
      const row={...deltaA,id:'habit:h1:'+day,dayKey:day,
        updatedAtISO:day+'T12:00:00.000Z'};
      admitted.push(api.appendHabitDelta(row));
    }
  }finally{context.JSON=originalJson;}
  assert.equal(admitted.filter(r=>r.written).length,15);
  assert.equal(arraySerializations,0,
    'admitting a complete shared WAL should serialize only the new row');
  assert.ok(rowSerializations>=15,'each appended row must still be serialized');
  assert.equal(JSON.parse(localStorage.getItem(KEY)).length,15);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    admitted.map(r=>r.mutationId).sort());
  assert.equal(api.getStatus().admissionClaimCount,15);
  assert.equal(api.getStatus().independentEventCount,15);
  for(const row of admitted)
    assert.equal(api.removeMutation(row.mutationId,
      {generation:row.generation,delta:row.row.delta}).removed,true);
  assert.equal(api.getStatus().pendingCount,0);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('fast append retains shared JSON whitespace and existing row order',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const a=api.appendHabitDelta(deltaA);
  const original='  \n'+localStorage.getItem(KEY)+'  \t';
  localStorage.setItem(KEY,original);
  const b=api.appendHabitDelta(deltaB);
  const raw=localStorage.getItem(KEY);
  assert.ok(raw.startsWith(original.slice(0,original.lastIndexOf(']'))));
  assert.ok(raw.endsWith(original.slice(original.lastIndexOf(']'))));
  assert.deepEqual(JSON.parse(raw).map(r=>r.id),[a.mutationId,b.mutationId]);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId,b.mutationId].sort());
});

test('incomplete shared WAL reconstructs all independently durable rows on append',()=>{
  const {api,localStorage,context}=install({[DARK]:'1'});
  const a=api.appendHabitDelta(deltaA);
  const b=api.appendHabitDelta(deltaB);
  localStorage.setItem(KEY,JSON.stringify([a.row]));
  const originalJson=context.JSON;
  let fullSerializations=0;
  context.JSON={parse:originalJson.parse.bind(originalJson),
    stringify(value,...rest){
      if(Array.isArray(value)&&value.length===3)fullSerializations++;
      return originalJson.stringify(value,...rest);
    }};
  const deltaC={...deltaA,id:'habit:h3:2026-10-19',habitId:'h3',
    dayKey:'2026-10-19',updatedAtISO:'2026-10-19T12:00:00.000Z'};
  let c;
  try{c=api.appendHabitDelta(deltaC);}
  finally{context.JSON=originalJson;}
  assert.equal(c.written,true);
  assert.equal(fullSerializations,1,
    'missing shared row must use full verified union serialization');
  assert.deepEqual(JSON.parse(localStorage.getItem(KEY)).map(r=>r.id).sort(),
    [a.mutationId,b.mutationId,c.mutationId].sort());
  assert.equal(api.getStatus().admissionClaimCount,3);
  assert.equal(api.getStatus().independentEventCount,3);
});

test('shared WAL race after durable admission refuses overwrite and retains both writes',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const originalGet=localStorage.getItem.bind(localStorage);
  const originalSet=localStorage.setItem.bind(localStorage);
  let sharedReads=0,changed=false;
  const competing={...deltaB,id:'habit:h4:2026-08-31',habitId:'h4'};
  const injected={...first.row,id:api.mutationIdForDelta(competing,first.generation),
    delta:competing};
  localStorage.getItem=key=>{
    // The second shared read now validates the inventory snapshot. Inject
    // after the new claim/sidecar are durable, at the third shared read.
    if(key===KEY&&++sharedReads===3){
      changed=true;
      originalSet(KEY,JSON.stringify([first.row,injected]));
    }
    return originalGet(key);
  };
  try{assert.throws(()=>api.appendHabitDelta(deltaB),
    /state_runtime_v2_wal_append_shared_changed|wal_shared_changed_during_read/);}
  finally{localStorage.getItem=originalGet;}
  assert.equal(changed,true);
  assert.deepEqual(JSON.parse(originalGet(KEY)).map(r=>r.id),
    [first.mutationId,injected.id]);
  const pending=api.getPendingRows();
  assert.equal(pending.ok,true);
  assert.deepEqual(pending.rows.map(r=>r.id).sort(),
    [first.mutationId,injected.id,api.mutationIdForDelta(deltaB,first.generation)].sort());
  assert.equal(api.getStatus().admissionClaimCount,2);
  assert.equal(api.getStatus().independentEventCount,2);
});

test('identical shared duplicates cannot conceal a different sidecar during fast append',()=>{
  const {api,localStorage,context}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const second=api.appendHabitDelta(deltaB);
  // Shared array length still equals the two DISTINCT recovered mutations,
  // but both shared entries describe the first one. Fast append is unsafe.
  const forgedShared=JSON.stringify([first.row,first.row]);
  localStorage.setItem(KEY,forgedShared);
  assert.equal(api.getPendingRows().ok,true,
    'identical shared duplicates are valid legacy data, not corruption');
  const original=context.JSON;
  let rebuilt=0;
  context.JSON={parse:original.parse.bind(original),
    stringify(value,...rest) {
      if(Array.isArray(value)&&value.length===3)rebuilt++;
      return original.stringify(value,...rest);
    }};
  const thirdDelta={...deltaA,id:'habit:h3:2026-10-21',
    habitId:'h3',dayKey:'2026-10-21',updatedAtISO:'2026-10-21T12:03:00.000Z'};
  let third;
  try{third=api.appendHabitDelta(thirdDelta);}
  finally{context.JSON=original;}
  assert.equal(third.written,true);
  assert.equal(rebuilt,1,'duplicate shared rows require full verified reconstruction');
  const rows=JSON.parse(localStorage.getItem(KEY));
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(r=>r.id).sort(),
    [first.mutationId,second.mutationId,third.mutationId].sort());
  assert.equal(new Set(rows.map(r=>r.id)).size,3);
  assert.equal(api.getStatus().admissionClaimCount,3);
  assert.equal(api.getStatus().independentEventCount,3);
  for(const row of [first,second,third])
    assert.equal(api.removeMutation(row.mutationId,
      {generation:row.generation,delta:row.row.delta}).removed,true);
  assert.equal(api.getStatus().pendingCount,0);
});

test('eighty held cross-tab WAL intents keep unique claims through shared rollback and cleanup',()=>{
  const storage=new FakeStorage({[DARK]:'1'});
  const first=install({},storage).api;
  const second=install({},storage).api;
  const all=[];
  for(let i=0;i<80;i++){
    const day='2026-'+String(1+Math.floor(i/25)).padStart(2,'0')
      +'-'+String(1+i%25).padStart(2,'0');
    const habitId=i%2===0?'h1':'h2';
    const delta={...deltaA,id:'habit:'+habitId+':'+day,
      habitId,dayKey:day,updatedAtISO:day+'T12:00:00.000Z'};
    const result=(i%2===0?first:second).appendHabitDelta(delta);
    assert.equal(result.written,true);
    all.push(result);
  }
  const claimKeys=[...storage.rows.keys()].filter(k=>k.startsWith(first.CLAIM_PREFIX));
  assert.equal(claimKeys.length,80,'different tab instances must not reuse claim UUIDs');
  assert.equal(first.getStatus().independentEventCount,80);
  assert.equal(second.getStatus().admissionClaimCount,80);
  assert.deepEqual(first.getPendingRows().rows.map(r=>r.id).sort(),
    all.map(r=>r.mutationId).sort());
  // Model an old Safari tab flushing its stale shared-array snapshot.
  storage.setItem(KEY,JSON.stringify(all.slice(0,5).map(r=>r.row)));
  assert.deepEqual(second.getPendingRows().rows.map(r=>r.id).sort(),
    all.map(r=>r.mutationId).sort(),'claim and sidecar union must recover all 80');
  const next={...deltaA,id:'habit:h3:2026-06-29',habitId:'h3',
    dayKey:'2026-06-29',updatedAtISO:'2026-06-29T12:01:00.000Z'};
  const last=second.appendHabitDelta(next);
  assert.equal(last.written,true);
  assert.equal(JSON.parse(storage.getItem(KEY)).length,81,
    'append must reconstruct the complete union after stale shared overwrite');
  assert.equal(first.getStatus().admissionClaimCount,81);
  for(const r of all.slice(0,8))
    assert.equal(first.removeMutation(r.mutationId,
      {generation:r.generation,delta:r.row.delta}).removed,true);
  assert.equal(second.getStatus().pendingCount,73);
  assert.equal(second.getStatus().admissionClaimCount,73);
  assert.equal(second.getStatus().independentEventCount,73);
  assert.deepEqual(second.getPendingRows().rows.map(r=>r.id).sort(),
    [...all.slice(8),last].map(r=>r.mutationId).sort());
});

test('V2 WAL is default-off and does not persist while dark mode is disabled', () => {
  const { api, localStorage } = install();
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'dark_disabled');
  assert.equal(localStorage.getItem(KEY), null);
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
});

test('V2 WAL synchronously persists a generation-stamped habit mutation under the dedicated key', () => {
  const { api, generation, localStorage } = install({ [DARK]: '1' });
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, true);
  const raw = localStorage.getItem(KEY);
  assert.ok(raw);
  const rows = JSON.parse(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.mutationId);
  assert.equal(rows[0].type, 'habit-completion-set');
  assert.equal(rows[0].delta.habitId, 'h1');
  assert.equal(rows[0].generation, generation.read());
  assert.equal(result.generation, generation.read());
});

test('duplicate mutation id is idempotent within the same generation', () => {
  const { api } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const second = api.appendHabitDelta(deltaA);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.mutationId, first.mutationId);
  assert.equal(api.getPendingRows().rows.length, 1);
});

test('same delta after a generation rotation gets a distinct mutation id', () => {
  const { api, generation } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  generation.rotate('reset-test');
  const second = api.appendHabitDelta(deltaA);
  assert.equal(second.written, true);
  assert.notEqual(second.generation, first.generation);
  assert.notEqual(second.mutationId, first.mutationId);
  assert.equal(api.getPendingRows().rows.length, 2);
});

test('verified commit cleanup removes only the matching WAL mutation', () => {
  const { api } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const second = api.appendHabitDelta(deltaB);
  const removed = api.removeMutation(first.mutationId);
  assert.equal(removed.removed, true);
  const pending = api.getPendingRows();
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.rows[0].id, second.mutationId);
});

test('malformed WAL is preserved and never silently cleared or overwritten', () => {
  const malformed = '{ definitely not valid json';
  const { api, localStorage } = install({ [DARK]: '1', [KEY]: malformed });
  const read = api.getPendingRows();
  assert.equal(read.ok, false);
  assert.equal(localStorage.getItem(KEY), malformed);
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(KEY), malformed);
  assert.throws(() => api.removeMutation('anything'), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(KEY), malformed);
});

test('mutation identity is stable for the same normalized delta and generation', () => {
  const { api, generation } = install({ [DARK]: '1' });
  const activeGeneration = generation.read();
  assert.equal(api.mutationIdForDelta(deltaA, activeGeneration), api.mutationIdForDelta({ ...deltaA }, activeGeneration));
});

test('source explicitly uses the contract WAL and generation keys with synchronous localStorage writes', () => {
  assert.match(walSource, /taskpoints_v2_pending_mutations_v1/);
  assert.match(walSource, /taskpoints_state_v2_generation_v1/);
  assert.match(walSource, /localStorage\?\.setItem/);
  assert.doesNotMatch(walSource, /setTimeout\([^)]*appendHabitDelta/s);
});

test('WAL preserves canonical completion time and distinguishes timestamp corrections', () => {
  const { api } = install({ [DARK]: '1' });
  const delta = { ...deltaA, completedAtISO: '2026-08-31T16:00:00.000Z' };
  const saved = api.appendHabitDelta(delta);
  assert.equal(saved.row.delta.completedAtISO, delta.completedAtISO);
  assert.notEqual(api.mutationIdForDelta(delta), api.mutationIdForDelta(deltaA));
});

test('independent WAL events survive a stale shared-key overwrite and selective cleanup', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA);
  const b = api.appendHabitDelta(deltaB);
  const sidecarPrefix = 'taskpoints_v2_pending_mutation_event_v1:';
  assert.equal(localStorage.getItem(sidecarPrefix + a.mutationId) !== null, true);
  assert.equal(localStorage.getItem(sidecarPrefix + b.mutationId) !== null, true);
  // Simulates another tab writing an obsolete view of the shared array.
  localStorage.setItem(KEY, JSON.stringify([a.row]));
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId,b.mutationId].sort());
  api.removeMutation(a.mutationId);
  assert.equal(localStorage.getItem(sidecarPrefix + a.mutationId), null);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.getPendingRows().rows[0].id, b.mutationId);
  api.removeMutation(b.mutationId);
  assert.equal(api.getPendingRows().rows.length, 0);
  assert.equal(api.getStatus().independentEventCount, 0);
});

test('independent WAL event survives a shared-key write failure before the tab closes', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key) === KEY) throw new Error('simulated full WAL array quota error');
    return original(key, value);
  };
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_write_failed/);
  localStorage.setItem = original;
  const surviving = api.getPendingRows();
  assert.equal(surviving.ok, true);
  assert.equal(surviving.rows.length, 1);
  assert.equal(surviving.rows[0].delta.habitId, 'h1');
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('malformed independently durable WAL event fails closed and preserves its bytes', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const key = 'taskpoints_v2_pending_mutation_event_v1:corrupted';
  const original = '{"incomplete":';
  localStorage.setItem(key, original);
  const read = api.getPendingRows();
  assert.equal(read.ok, false);
  assert.match(read.error, /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(key), original);
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_malformed/);
  assert.throws(() => api.removeMutation('corrupted'), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(key), original);
});


test('two independent browser contexts preserve WAL events when a stale shared array replaces newer rows', () => {
  const storage = new FakeStorage({ [DARK]: '1' });
  const tabA = install({}, storage).api;
  const tabB = install({}, storage).api;
  const first = tabA.appendHabitDelta(deltaA);
  const staleShared = storage.getItem(KEY);
  const second = tabB.appendHabitDelta(deltaB);
  storage.setItem(KEY, staleShared);
  const expected = [first.mutationId, second.mutationId].sort();
  assert.deepEqual(tabA.getPendingRows().rows.map(r=>r.id).sort(), expected);
  assert.deepEqual(tabB.getPendingRows().rows.map(r=>r.id).sort(), expected);
  tabA.removeMutation(first.mutationId);
  assert.deepEqual(tabB.getPendingRows().rows.map(r=>r.id), [second.mutationId]);
  tabB.removeMutation(second.mutationId);
  assert.equal(tabA.getPendingRows().rows.length, 0);
});

test('quota-denied legacy WAL sidecar leaves a unique admission claim without changing shared WAL', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const before = localStorage.getItem(KEY);
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key).startsWith('taskpoints_v2_pending_mutation_event_v1:'))
      throw new Error('synthetic WAL sidecar QuotaExceededError');
    return original(key, value);
  };
  assert.throws(() => api.appendHabitDelta(deltaA),
    /state_runtime_v2_wal_independent_write_failed/);
  localStorage.setItem = original;
  assert.equal(localStorage.getItem(KEY), before,
    'shared WAL must never claim durability when the independent record failed');
  assert.equal(api.getPendingRows().rows.length, 1,
    'the unique claim independently preserves the rejected sidecar event');
  assert.equal(api.getStatus().admissionClaimCount, 1);
  assert.equal(api.getStatus().independentEventCount, 0);
  assert.equal(api.appendHabitDelta(deltaA).duplicate, true);
  assert.equal(api.getStatus().independentEventCount, 1,
    'a retry may repair the missing legacy per-ID sidecar');
  assert.equal(api.removeMutation(api.getPendingRows().rows[0].id).removed, true);
  assert.equal(api.getStatus().admissionClaimCount, 0);
});

test('interrupted shared WAL cleanup retains independent evidence and can retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA), b = api.appendHabitDelta(deltaB);
  const before = localStorage.getItem(KEY);
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key) === KEY) throw new Error('synthetic shared WAL cleanup quota');
    return original(key, value);
  };
  assert.throws(() => api.removeMutation(a.mutationId), /state_runtime_v2_wal_write_failed/);
  localStorage.setItem = original;
  assert.equal(localStorage.getItem(KEY), before);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId, b.mutationId].sort());
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id), [b.mutationId]);
});

test('interrupted independent WAL cleanup retains evidence after shared cleanup until retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA), b = api.appendHabitDelta(deltaB);
  const prefix = 'taskpoints_v2_pending_mutation_event_v1:';
  const original = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (String(key) === prefix + a.mutationId)
      throw new Error('synthetic WAL sidecar removal interruption');
    return original(key);
  };
  assert.throws(() => api.removeMutation(a.mutationId),
    /state_runtime_v2_wal_independent_remove_failed/);
  localStorage.removeItem = original;
  assert.ok(localStorage.getItem(prefix+a.mutationId),
    'unremoved sidecar is retained as recoverable evidence');
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId,b.mutationId].sort());
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id), [b.mutationId]);
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('three generation rotations retain stale evidence without cross-generation mutation identity collision', () => {
  const { api, generation, localStorage } = install({ [DARK]: '1' });
  const events = [];
  for (let round=0;round<4;round++) {
    if (round) generation.rotate('simulated-import-'+round);
    const item=api.appendHabitDelta(deltaA);
    assert.equal(item.written,true);
    assert.equal(item.generation,generation.read());
    events.push(item);
  }
  assert.equal(new Set(events.map(e=>e.mutationId)).size,4);
  assert.equal(api.getStatus().independentEventCount,4);
  assert.equal(api.getPendingRows().rows.length,4);
  const all=api.getPendingRows().rows;
  assert.equal(all.filter(x=>x.generation===generation.read()).length,1);
  // Earlier-generation rows must remain inspectable, not silently migrated.
  const keyPrefix='taskpoints_v2_pending_mutation_event_v1:';
  for (const row of events.slice(0,-1))
    assert.ok(localStorage.getItem(keyPrefix+row.mutationId));
  assert.equal(api.removeMutation(events[3].mutationId).removed,true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    events.slice(0,-1).map(e=>e.mutationId).sort());
  assert.equal(api.getStatus().independentEventCount,3);
});

test('a malformed shared record conflicts with an intact independent row without deleting evidence', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const mutation=api.appendHabitDelta(deltaA);
  const sidecar='taskpoints_v2_pending_mutation_event_v1:'+mutation.mutationId;
  const saved=localStorage.getItem(sidecar);
  localStorage.setItem(KEY, JSON.stringify([{...mutation.row,
    delta:{...mutation.row.delta,status:'off'}}]));
  const read=api.getPendingRows();
  assert.equal(read.ok,false);
  assert.match(read.error,/wal_shared_independent_identity_conflict/);
  assert.equal(localStorage.getItem(sidecar),saved);
  assert.throws(()=>api.removeMutation(mutation.mutationId), /wal_shared_independent_identity_conflict/);
  assert.equal(localStorage.getItem(sidecar),saved);
});

test('shared WAL read denial is not mistaken for an empty log or permission to clear evidence', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const originalShared = localStorage.getItem(KEY);
  const originalSidecar = localStorage.getItem(sidecarKey);
  const originalGet = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (String(key) === KEY) throw new Error('synthetic WAL shared read SecurityError');
    return originalGet(key);
  };

  try {
    const unreadable = api.getPendingRows();
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.removeMutation(first.mutationId), /wal_storage_read_failed/);
  } finally {
    localStorage.getItem = originalGet;
  }

  assert.equal(localStorage.getItem(KEY), originalShared, 'shared bytes survive denied reads');
  assert.equal(localStorage.getItem(sidecarKey), originalSidecar, 'sidecar bytes survive denied reads');
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId],
    'recovery can inspect the original WAL again when reads resume');
});

test('independent sidecar read denial blocks replay and selective cleanup without losing a row', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const originalShared = localStorage.getItem(KEY);
  const originalSidecar = localStorage.getItem(sidecarKey);
  const originalGet = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (String(key) === sidecarKey) throw new Error('synthetic WAL sidecar read SecurityError');
    return originalGet(key);
  };

  try {
    const unreadable = api.getPendingRows();
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.removeMutation(first.mutationId), /wal_storage_read_failed/);
  } finally {
    localStorage.getItem = originalGet;
  }

  assert.equal(localStorage.getItem(KEY), originalShared);
  assert.equal(localStorage.getItem(sidecarKey), originalSidecar);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(api.removeMutation(first.mutationId).removed, true,
    'selective cleanup resumes only once both durable records are readable');
  assert.equal(api.getPendingRows().rows.length, 0);
});

test('changing key count during WAL enumeration fails closed and preserves all claims',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const saved=api.appendHabitDelta(deltaA);
  const baseline=api.getPendingRows();
  const beforeShared=localStorage.getItem(KEY);
  const eventKey='taskpoints_v2_pending_mutation_event_v1:'+saved.mutationId;
  const claimKey=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const beforeEvent=localStorage.getItem(eventKey);
  const beforeClaim=localStorage.getItem(claimKey);
  const original=localStorage.key.bind(localStorage);
  let added=0;
  localStorage.key=index=>{
    if(index===0)localStorage.setItem('synthetic-tab-race:'+ ++added,'irrelevant');
    return original(index);
  };
  try{
    const read=api.getPendingRows();
    assert.equal(read.ok,false);
    assert.match(read.error,/wal_storage_inventory_changed/);
    const status=api.getStatus();
    assert.equal(status.malformed,true);
    assert.equal(status.pendingCount,null);
    assert.equal(status.admissionClaimCount,null);
    assert.equal(status.independentEventCount,null);
    assert.match(status.lastError,/state_runtime_v2_wal_inventory_unreadable/);
    assert.throws(()=>api.appendHabitDelta(deltaB),/wal_storage_inventory_changed/);
    assert.throws(()=>api.removeMutation(saved.mutationId,
      {generation:saved.generation,delta:saved.row.delta}),
      /wal_storage_inventory_changed/);
  }finally{localStorage.key=original}
  assert.ok(added>=4);
  assert.equal(localStorage.getItem(KEY),beforeShared);
  assert.equal(localStorage.getItem(eventKey),beforeEvent);
  assert.equal(localStorage.getItem(claimKey),beforeClaim);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id),baseline.rows.map(r=>r.id));
  assert.equal(api.removeMutation(saved.mutationId,
    {generation:saved.generation,delta:saved.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('shrinking storage inventory mid-scan never produces a falsely healthy WAL',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const saved=api.appendHabitDelta(deltaA);
  localStorage.setItem('synthetic-volatile-key','1');
  const original=localStorage.key.bind(localStorage);
  let removed=false;
  localStorage.key=index=>{
    if(!removed){removed=true;localStorage.removeItem('synthetic-volatile-key');}
    return original(index);
  };
  try{
    const result=api.getPendingRows();
    assert.equal(result.ok,false);
    assert.match(result.error,/wal_storage_inventory_(changed|missing_key)/,
      'shrinking inventory must fail closed whether detected by length or indexed gap');
  }finally{localStorage.key=original}
  assert.equal(removed,true);
  assert.equal(api.getPendingRows().rows.length,1);
  assert.equal(api.getStatus().admissionClaimCount,1);
  assert.equal(api.removeMutation(saved.mutationId,
    {generation:saved.generation,delta:saved.row.delta}).removed,true);
});

test('duplicate or missing indexed keys refuse WAL read without clearing evidence',()=>{
  for(const mode of ['duplicate','missing']){
    const {api,localStorage}=install({[DARK]:'1'});
    const saved=api.appendHabitDelta(deltaA);
    const before=localStorage.getItem(KEY);
    const original=localStorage.key.bind(localStorage);
    localStorage.key=index=>{
      if(index===1)return mode==='duplicate'?original(0):null;
      return original(index);
    };
    try{
      const read=api.getPendingRows();
      assert.equal(read.ok,false);
      assert.match(read.error,new RegExp('wal_storage_inventory_'+(mode==='duplicate'?'duplicate_key':'missing_key')));
      assert.equal(api.getStatus().pendingCount,null);
      assert.throws(()=>api.appendHabitDelta(deltaB),/wal_storage_inventory_/);
    }finally{localStorage.key=original}
    assert.equal(localStorage.getItem(KEY),before);
    assert.equal(api.getStatus().admissionClaimCount,1);
    assert.equal(api.removeMutation(saved.mutationId,
      {generation:saved.generation,delta:saved.row.delta}).removed,true);
  }
});

test('WAL refuses key count growth after inventory while independent payloads are read',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const saved=api.appendHabitDelta(deltaA);
  const beforeShared=localStorage.getItem(KEY);
  const sidecar='taskpoints_v2_pending_mutation_event_v1:'+saved.mutationId;
  const beforeSidecar=localStorage.getItem(sidecar);
  const claim=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const beforeClaim=localStorage.getItem(claim);
  const get=localStorage.getItem.bind(localStorage);
  let touched=0;
  localStorage.getItem=key=>{
    if(key===sidecar){
      touched++;
      localStorage.setItem('synthetic-concurrent-tab-unrelated-key:'+touched,'still-here');
    }
    return get(key);
  };
  try{
    const result=api.getPendingRows();
    assert.equal(result.ok,false);
    assert.match(result.error,/wal_recovery_inventory_changed_after_read/);
    assert.throws(()=>api.appendHabitDelta(deltaB),/wal_recovery_inventory_changed_after_read/);
  }finally{localStorage.getItem=get;}
  assert.ok(touched>=2);
  assert.equal(localStorage.getItem(KEY),beforeShared);
  assert.equal(localStorage.getItem(sidecar),beforeSidecar);
  assert.equal(localStorage.getItem(claim),beforeClaim);
  assert.equal(api.getPendingRows().rows.length,1);
  assert.equal(api.removeMutation(saved.mutationId,
    {generation:saved.generation,delta:saved.row.delta}).removed,true);
});

test('WAL refuses changed shared bytes after the stable key inventory',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const saved=api.appendHabitDelta(deltaA);
  const previous=localStorage.getItem(KEY);
  const sidecar='taskpoints_v2_pending_mutation_event_v1:'+saved.mutationId;
  const get=localStorage.getItem.bind(localStorage);
  let injected=false;
  localStorage.getItem=key=>{
    if(key===sidecar&&!injected){
      injected=true;
      localStorage.setItem(KEY,'  '+previous+' ');
    }
    return get(key);
  };
  try{
    const pending=api.getPendingRows();
    assert.equal(pending.ok,false);
    assert.match(pending.error,/wal_shared_changed_during_read/);
  }finally{localStorage.getItem=get;}
  assert.equal(injected,true);
  assert.equal(localStorage.getItem(KEY),'  '+previous+' ');
  assert.equal(api.getPendingRows().rows.length,1);
  assert.equal(api.removeMutation(saved.mutationId,
    {generation:saved.generation,delta:saved.row.delta}).removed,true);
});

test('WAL refuses a disappearing sidecar or claim rather than claiming a complete snapshot',()=>{
  for(const kind of ['sidecar','claim']){
    const {api,localStorage}=install({[DARK]:'1'});
    const saved=api.appendHabitDelta(deltaA);
    const key=kind==='sidecar'
      ?'taskpoints_v2_pending_mutation_event_v1:'+saved.mutationId
      :[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
    const original=localStorage.getItem.bind(localStorage);
    let denied=0;
    localStorage.getItem=which=>{
      if(which===key){denied++;return null;}
      return original(which);
    };
    try{
      const unreadable=api.getPendingRows();
      assert.equal(unreadable.ok,false);
      assert.match(unreadable.error,/wal_recovery_entry_disappeared_during_read/);
      assert.throws(()=>api.removeMutation(saved.mutationId,
        {generation:saved.generation,delta:saved.row.delta}),
        /wal_recovery_entry_disappeared_during_read/);
    }finally{localStorage.getItem=original;}
    assert.ok(denied>=2);
    assert.equal(api.getStatus().pendingCount,1);
    assert.equal(api.removeMutation(saved.mutationId,
      {generation:saved.generation,delta:saved.row.delta}).removed,true);
  }
});

test('WAL cleanup refuses a claim disappearing after the initial stable recovery read',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const saved=api.appendHabitDelta(deltaA);
  const claimKey=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const sidecarKey='taskpoints_v2_pending_mutation_event_v1:'+saved.mutationId;
  const previous={shared:localStorage.getItem(KEY),sidecar:localStorage.getItem(sidecarKey),
    claim:localStorage.getItem(claimKey)};
  const originalGet=localStorage.getItem.bind(localStorage);
  let claimReads=0;
  localStorage.getItem=key=>{
    // The WAL's first verified read succeeds; cleanup's own claim read
    // observes a vanished key, as can happen between tab operations.
    if(key===claimKey && ++claimReads===2) return null;
    return originalGet(key);
  };
  try{
    assert.throws(()=>api.removeMutation(saved.mutationId,
      {generation:saved.generation,delta:saved.row.delta}),
      /state_runtime_v2_wal_cleanup_claim_disappeared/);
  }finally{localStorage.getItem=originalGet;}
  assert.equal(claimReads,2);
  assert.equal(localStorage.getItem(KEY),previous.shared);
  assert.equal(localStorage.getItem(sidecarKey),previous.sidecar);
  assert.equal(localStorage.getItem(claimKey),previous.claim);
  assert.equal(api.getStatus().pendingCount,1);
  assert.equal(api.removeMutation(saved.mutationId,
    {generation:saved.generation,delta:saved.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('WAL cleanup refuses recovery-key growth during claim inspection',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const second=api.appendHabitDelta(deltaB);
  const claimKey=[...localStorage.rows.keys()].find(k=>k.startsWith(api.CLAIM_PREFIX));
  const originalGet=localStorage.getItem.bind(localStorage);
  const originalShared=localStorage.getItem(KEY);
  const firstSidecar='taskpoints_v2_pending_mutation_event_v1:'+first.mutationId;
  const originalSidecar=localStorage.getItem(firstSidecar);
  const volatileKey='synthetic-new-tab-key-during-cleanup';
  let claimReads=0,inserted=false;
  localStorage.getItem=key=>{
    if(key===claimKey && ++claimReads===2){
      localStorage.setItem(volatileKey,'new concurrent key');
      inserted=true;
    }
    return originalGet(key);
  };
  try{
    assert.throws(()=>api.removeMutation(first.mutationId,
      {generation:first.generation,delta:first.row.delta}),
      /state_runtime_v2_wal_cleanup_claim_inventory_changed/);
  }finally{localStorage.getItem=originalGet;}
  assert.equal(inserted,true);
  assert.equal(localStorage.getItem(KEY),originalShared);
  assert.equal(localStorage.getItem(firstSidecar),originalSidecar);
  assert.equal(api.getStatus().pendingCount,2);
  assert.equal(api.getStatus().admissionClaimCount,2);
  localStorage.removeItem(volatileKey);
  assert.equal(api.removeMutation(first.mutationId,
    {generation:first.generation,delta:first.row.delta}).removed,true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id),[second.mutationId]);
  assert.equal(api.removeMutation(second.mutationId,
    {generation:second.generation,delta:second.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('WAL cleanup catches same-count cross-tab admission-claim key replacement',()=>{
  const {api,localStorage}=install({[DARK]:'1'});
  const first=api.appendHabitDelta(deltaA);
  const second=api.appendHabitDelta(deltaB);
  const claimKey=[...localStorage.rows.keys()].find(key=>
    key.startsWith(api.CLAIM_PREFIX) &&
    JSON.parse(localStorage.getItem(key)).id===second.mutationId);
  assert.ok(claimKey);
  const replacementKey=api.CLAIM_PREFIX+'same-size-cross-tab-replacement';
  assert.equal(localStorage.getItem(replacementKey),null);
  const oldShared=localStorage.getItem(KEY);
  const oldSidecar=localStorage.getItem(
    'taskpoints_v2_pending_mutation_event_v1:'+first.mutationId);
  const startingLength=localStorage.length;
  const get=localStorage.getItem.bind(localStorage);
  let claimReads=0,swapped=false;
  localStorage.getItem=key=>{
    const value=get(key);
    if(key===claimKey && ++claimReads===2){
      // Return the previously read bytes, then simulate a different tab
      // moving the same durable claim to a fresh UUID-addressed key.
      localStorage.removeItem(claimKey);
      localStorage.setItem(replacementKey,value);
      swapped=true;
    }
    return value;
  };
  try{
    assert.throws(()=>api.removeMutation(first.mutationId,
      {generation:first.generation,delta:first.row.delta}),
      /state_runtime_v2_wal_cleanup_keys_changed/);
  }finally{localStorage.getItem=get;}
  assert.equal(swapped,true);
  assert.equal(localStorage.length,startingLength,
    'the race has no observable key-count change');
  assert.equal(localStorage.getItem(KEY),oldShared,
    'shared recovery evidence must survive denied cleanup');
  assert.equal(localStorage.getItem(
    'taskpoints_v2_pending_mutation_event_v1:'+first.mutationId),oldSidecar);
  assert.equal(api.getStatus().pendingCount,2);
  assert.equal(api.getStatus().admissionClaimCount,2);
  assert.equal(api.removeMutation(first.mutationId,
    {generation:first.generation,delta:first.row.delta}).removed,true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id),[second.mutationId]);
  assert.equal(api.removeMutation(second.mutationId,
    {generation:second.generation,delta:second.row.delta}).removed,true);
  assert.equal(api.getStatus().admissionClaimCount,0);
});

test('denied WAL key enumeration fails closed without crashing status or dropping sidecars', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sharedBefore = localStorage.getItem(KEY);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const sidecarBefore = localStorage.getItem(sidecarKey);
  const originalKey = localStorage.key;
  localStorage.key = () => { throw new Error('synthetic localStorage.key SecurityError'); };
  try {
    const pending = api.getPendingRows();
    assert.equal(pending.ok, false);
    assert.match(pending.error, /synthetic localStorage\.key SecurityError/);
    const status = api.getStatus();
    assert.equal(status.malformed, true);
    assert.equal(status.pendingCount, null);
    assert.equal(status.independentEventCount, null);
    assert.match(status.lastError, /state_runtime_v2_wal_inventory_unreadable/);
    assert.throws(() => api.appendHabitDelta(deltaB), /state_runtime_v2_wal_malformed/);
    assert.throws(() => api.removeMutation(first.mutationId), /state_runtime_v2_wal_malformed/);
  } finally {
    localStorage.key = originalKey;
  }
  assert.equal(localStorage.getItem(KEY), sharedBefore);
  assert.equal(localStorage.getItem(sidecarKey), sidecarBefore);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(api.getStatus().malformed, false);
  assert.equal(api.removeMutation(first.mutationId).removed, true);
});

test('denied localStorage length inventory keeps pending WAL unknown rather than falsely zero', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sharedBefore = localStorage.getItem(KEY);
  Object.defineProperty(localStorage, 'length', {
    configurable: true,
    get() { throw new Error('synthetic localStorage.length SecurityError'); }
  });
  try {
    const status = api.getStatus();
    assert.equal(status.malformed, true);
    assert.equal(status.pendingCount, null);
    assert.equal(status.independentEventCount, null);
    assert.match(status.lastError, /state_runtime_v2_wal_inventory_unreadable/);
    assert.equal(api.getPendingRows().ok, false);
    assert.throws(() => api.removeMutation(first.mutationId), /state_runtime_v2_wal_malformed/);
  } finally {
    delete localStorage.length;
  }
  assert.equal(localStorage.getItem(KEY), sharedBefore);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('standalone WAL fallback never manufactures a new epoch when generation read is denied', () => {
  const oldEpoch = 'original-stored-generation';
  const first = install({ [DARK]: '1', [GENERATION_KEY]: oldEpoch });
  const { api, localStorage, context } = first;
  const saved = api.appendHabitDelta(deltaA);
  assert.equal(saved.generation, oldEpoch);
  const walBefore = localStorage.getItem(KEY);
  const sidecarBefore = localStorage.getItem('taskpoints_v2_pending_mutation_event_v1:' + saved.mutationId);
  // Simulate recovery while the generation module is unavailable. The WAL
  // module must not interpret transient storage denial as an absent epoch.
  context.TaskPointsStateRuntimeV2Generation = null;
  const get = localStorage.getItem.bind(localStorage);
  localStorage.getItem = key => {
    if (String(key) === GENERATION_KEY) throw new Error('generation key SecurityError');
    return get(key);
  };
  try {
    assert.throws(() => api.ensureGeneration(), /wal_storage_read_failed/);
    assert.throws(() => api.mutationIdForDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    const status = api.getStatus();
    assert.equal(status.generationReadable, false);
    assert.equal(status.pendingCount, null);
    assert.equal(status.malformed, true);
  } finally {
    localStorage.getItem = get;
  }
  assert.equal(localStorage.getItem(GENERATION_KEY), oldEpoch);
  assert.equal(localStorage.getItem(KEY), walBefore);
  assert.equal(localStorage.getItem('taskpoints_v2_pending_mutation_event_v1:' + saved.mutationId),
    sidecarBefore);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [saved.mutationId]);
  assert.equal(api.ensureGeneration(), oldEpoch);
  assert.equal(api.appendHabitDelta(deltaB).written, true);
  assert.equal(api.getPendingRows().rows.length, 2);
});

test('standalone WAL generation fallback refuses silently swallowed epoch writes',()=>{
  const {api,context,localStorage}=install({[DARK]:'1'});
  const oldEpoch=localStorage.getItem(GENERATION_KEY);
  const original=localStorage.setItem.bind(localStorage);
  // Only the standalone WAL fallback is under test: remove the generation
  // module and its key without touching older V1/WAL recovery data.
  context.TaskPointsStateRuntimeV2Generation=null;
  localStorage.removeItem(GENERATION_KEY);
  let refused=0;
  localStorage.setItem=(key,value)=>{
    if(String(key)===GENERATION_KEY){refused++;return;}
    return original(key,value);
  };
  try{
    assert.throws(()=>api.appendHabitDelta(deltaA),
      /state_runtime_v2_wal_generation_write_failed:unverified_write/);
    assert.equal(refused,1);
    assert.equal(localStorage.getItem(GENERATION_KEY),null);
    assert.equal(localStorage.getItem(KEY),null);
    assert.equal(api.getPendingRows().rows.length,0);
    assert.equal(api.getStatus().admissionClaimCount,0);
  }finally{localStorage.setItem=original;}
  const recovered=api.appendHabitDelta(deltaA);
  assert.equal(recovered.written,true);
  assert.notEqual(recovered.generation,oldEpoch);
  assert.equal(localStorage.getItem(GENERATION_KEY),recovered.generation);
  assert.equal(api.removeMutation(recovered.mutationId,
    {generation:recovered.generation,delta:recovered.row.delta}).removed,true);
});

test('standalone WAL fallback creates an epoch only when storage proves key is missing', () => {
  const { api, context, localStorage } = install({ [DARK]: '1' });
  // The full generation module creates its bootstrap epoch during setup.
  // Remove it deliberately to model a truly absent key with verified reads.
  localStorage.removeItem(GENERATION_KEY);
  context.TaskPointsStateRuntimeV2Generation = null;
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, true);
  assert.equal(result.generation, localStorage.getItem(GENERATION_KEY));
  assert.equal(api.getPendingRows().rows.length, 1);
});

test('WAL never bypasses an installed generation authority that declines to provide an epoch', () => {
  const { api, context, localStorage } = install({ [DARK]: '1' });
  const original = context.TaskPointsStateRuntimeV2Generation;
  const existingEpoch = localStorage.getItem(GENERATION_KEY);
  assert.ok(existingEpoch, 'normal setup automatically bootstraps the original epoch');
  context.TaskPointsStateRuntimeV2Generation = {
    ensure() { return { enabled: false, generation: null }; },
    read() { return null; }
  };
  assert.throws(() => api.appendHabitDelta(deltaA), /wal_generation_unavailable/);
  assert.equal(localStorage.getItem(GENERATION_KEY), existingEpoch,
    'declined authority must not replace or erase its existing generation');
  assert.equal(localStorage.getItem(KEY), null);
  context.TaskPointsStateRuntimeV2Generation = original;
  assert.equal(api.appendHabitDelta(deltaA).written, true);
});

test('silent legacy sidecar refusal preserves a verified unique claim for safe retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const before = localStorage.getItem(KEY);
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key).startsWith('taskpoints_v2_pending_mutation_event_v1:')) return;
    return original(key, value);
  };
  try {
    assert.throws(() => api.appendHabitDelta(deltaA), /wal_independent_write_failed:unverified_write/);
    assert.equal(localStorage.getItem(KEY), before);
    assert.equal(api.getPendingRows().rows.length, 1);
    assert.equal(api.getStatus().admissionClaimCount, 1);
    assert.equal(api.getStatus().independentEventCount, 0);
  } finally { localStorage.setItem = original; }
  assert.equal(api.appendHabitDelta(deltaA).duplicate, true);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.getStatus().independentEventCount, 1);
  assert.equal(api.removeMutation(api.getPendingRows().rows[0].id).removed, true);
  assert.equal(api.getStatus().admissionClaimCount, 0);
});

test('silent shared WAL write retains the verified sidecar for later recovery', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key) === KEY) return;
    return original(key, value);
  };
  try {
    assert.throws(() => api.appendHabitDelta(deltaA), /wal_write_failed:unverified_write/);
    assert.equal(localStorage.getItem(KEY), null);
    const pending = api.getPendingRows();
    assert.equal(pending.ok, true);
    assert.equal(pending.rows.length, 1);
  } finally { localStorage.setItem = original; }
  assert.equal(api.appendHabitDelta(deltaA).duplicate, true);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.removeMutation(api.getPendingRows().rows[0].id).removed, true);
  assert.equal(api.getPendingRows().rows.length, 0);
});

test('silent shared WAL cleanup cannot remove its independently durable row', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA);
  const savedShared = localStorage.getItem(KEY);
  const sidecar = 'taskpoints_v2_pending_mutation_event_v1:' + a.mutationId;
  const savedSidecar = localStorage.getItem(sidecar);
  const original = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (String(key) === KEY) return;
    return original(key);
  };
  try {
    assert.throws(() => api.removeMutation(a.mutationId), /wal_remove_failed:unverified_remove/);
    assert.equal(localStorage.getItem(KEY), savedShared);
    assert.equal(localStorage.getItem(sidecar), savedSidecar);
  } finally { localStorage.removeItem = original; }
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.equal(api.getPendingRows().rows.length, 0);
});

test('silent sidecar cleanup preserves replayable evidence and supports retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA);
  const sidecar = 'taskpoints_v2_pending_mutation_event_v1:' + a.mutationId;
  const original = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (String(key) === sidecar) return;
    return original(key);
  };
  try {
    assert.throws(() => api.removeMutation(a.mutationId),
      /wal_independent_remove_failed:unverified_remove/);
    assert.equal(localStorage.getItem(KEY), null);
    assert.ok(localStorage.getItem(sidecar));
    assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [a.mutationId]);
  } finally { localStorage.removeItem = original; }
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.equal(api.getPendingRows().rows.length, 0);
});

test('failed sidecar write verification read fails closed without erasing a durable event', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const get = localStorage.getItem.bind(localStorage);
  const set = localStorage.setItem.bind(localStorage);
  let denyNextRead = false;
  localStorage.setItem = (key, value) => {
    set(key, value);
    if (String(key).startsWith('taskpoints_v2_pending_mutation_event_v1:')) denyNextRead = true;
  };
  localStorage.getItem = key => {
    if (denyNextRead && String(key).startsWith('taskpoints_v2_pending_mutation_event_v1:')) {
      denyNextRead = false;
      throw Error('readback SecurityError');
    }
    return get(key);
  };
  try {
    assert.throws(() => api.appendHabitDelta(deltaA), /wal_storage_read_failed/);
    assert.equal(localStorage.getItem(KEY), null);
  } finally {
    localStorage.setItem = set;
    localStorage.getItem = get;
  }
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.appendHabitDelta(deltaA).duplicate, true);
});
