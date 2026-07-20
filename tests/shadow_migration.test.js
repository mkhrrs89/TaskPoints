const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;

function fixture() {
  return {
    completions: [{ id: 'c1', points: 1 }, { id: 'c1', points: 2 }],
    matchups: [{ id: 'm1' }], gameHistory: [{ id: 'g1' }], seasonHistory: [{ id: 's1' }],
    tasks: [{ id: 't1' }], habits: [{ id: 'h1' }], players: [{ id: 'p1', imageId: 'player-image' }],
    youImageId: 'profile-image', currentSeason: { playerPool: [{ id: 'season-only', imageId: 'season-image' }] }, settings: { sound: true }, futureFlag: { enabled: true }, futureRows: [{ x: 1 }]
  };
}

test('shadow migration layout preserves all known and future top-level fields', () => {
  const state = fixture(); const layout = core.shadowSourceLayout(state);
  assert.deepEqual(layout.arrays.completions, state.completions);
  assert.deepEqual(layout.values.futureFlag, state.futureFlag);
  assert.deepEqual(layout.collections.futureRows, state.futureRows);
  assert.equal(layout.values.settings.sound, true);
});

test('shadow migration deterministic summary detects record changes and preserves duplicate source rows', () => {
  const state = fixture(); const first = core.shadowSourceSummary(state);
  assert.equal(first.counts.completions, 2);
  assert.equal(first.counts.futureRows, 1);
  const changed = structuredClone(state); changed.completions[1].points = 3;
  assert.notEqual(first.hashes.state, core.shadowSourceSummary(changed).hashes.state);
  assert.equal(core.shadowHash({ b: 1, a: 2 }), core.shadowHash({ a: 2, b: 1 }));
});

test('image verification inputs include profile/player references and can report missing images', () => {
  const refs = core.referencedImageIds(fixture());
  assert.deepEqual(refs, ['player-image', 'profile-image', 'season-image']);
  const available = new Set(['profile-image', 'orphan-image']);
  assert.deepEqual(refs.filter(id => !available.has(id)), ['player-image', 'season-image']);
  assert.deepEqual([...available].filter(id => !refs.includes(id)), ['orphan-image']);
});

test('shadow migration helpers do not mutate legacy source state on planning or verification', () => {
  const state = fixture(); const before = JSON.stringify(state);
  core.shadowSourceLayout(state); core.shadowSourceSummary(state); core.referencedImageIds(state);
  assert.equal(JSON.stringify(state), before);
});

test('shadow migration failure falls back without changing the supplied legacy state', async () => {
  const state = fixture(); const before = JSON.stringify(state);
  const result = await core.runShadowMigration({ state, indexedDB: null });
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(state), before);
});

test('restart planning uses deterministic index keys, preventing duplicate retry records', () => {
  const first = core.shadowSourceLayout(fixture()).arrays.completions.map((value, index) => ({ key: index, value }));
  const retry = core.shadowSourceLayout(fixture()).arrays.completions.map((value, index) => ({ key: index, value }));
  assert.deepEqual(retry, first);
  assert.equal(new Set(retry.map(row => row.key)).size, retry.length);
});

test('canonical migration summary preserves omitted known collections without mutating source', () => {
  const state = fixture(); delete state.seasonHistory; delete state.matchups;
  const layout = core.shadowSourceLayout(state);
  assert.deepEqual(layout.arrays.seasonHistory, []); assert.deepEqual(layout.arrays.matchups, []);
  assert.equal(Object.hasOwn(state, 'seasonHistory'), false); assert.equal(Object.hasOwn(state, 'matchups'), false);
  assert.equal(core.shadowSourceSummary(state).hashes.state, core.shadowSourceSummary({ ...state, seasonHistory: [], matchups: [] }).hashes.state);
});

function createFakeIndexedDb({ strictTransactions = false } = {}) {
  const databases = new Map();
  const request = (run) => { const req = {}; queueMicrotask(() => { try { req.result = run(); req.onsuccess?.(); } catch (error) { req.error = error; req.onerror?.(); } }); return req; };
  class Store {
    constructor(def) { this.def = def; this.rows = new Map(); }
    key(value, key) { return key ?? value[this.def.keyPath]; }
  }
  class Database {
    constructor(name, version) { this.name = name; this.version = version; this.stores = new Map(); this.objectStoreNames = { contains: name => this.stores.has(name) }; }
    createObjectStore(name, def = {}) { const store = new Store(def); this.stores.set(name, store); return store; }
    transaction(names) { const db = this; const list = Array.isArray(names) ? names : [names]; let active = true; const inactiveRequest = () => { if (!active) throw new Error('TransactionInactiveError'); }; const strictRequest = (run) => { inactiveRequest(); const req = {}; queueMicrotask(() => { try { req.result = run(); req.onsuccess?.(); active = false; } catch (error) { req.error = error; req.onerror?.(); } }); return req; }; const makeRequest = run => strictTransactions ? strictRequest(run) : request(run); const tx = { error: null, objectStore(name) { if (!list.includes(name)) throw new Error('store not in transaction'); const store = db.stores.get(name); if (!store) throw new Error('missing store'); return { put(value, key) { inactiveRequest(); store.rows.set(store.key(value, key), structuredClone(value)); return makeRequest(() => key); }, clear() { inactiveRequest(); store.rows.clear(); return makeRequest(() => undefined); }, get(key) { return makeRequest(() => structuredClone(store.rows.get(key))); }, getAll() { return makeRequest(() => [...store.rows.values()].map(value => structuredClone(value))); }, getAllKeys() { return makeRequest(() => [...store.rows.keys()]); } }; } };
      setTimeout(() => tx.oncomplete?.(), 0); return tx;
    }
    close() {}
  }
  return {
    databases: async () => [...databases.values()].map(db => ({ name: db.name, version: db.version })),
    open(name, version) {
      const req = {}; queueMicrotask(() => { try { let db = databases.get(name); const requested = version ?? db?.version ?? 1; if (db && requested < db.version) throw new Error('VersionError'); const upgrade = !db || requested > db.version; if (!db) { db = new Database(name, requested); databases.set(name, db); } else if (upgrade) db.version = requested; req.result = db; if (upgrade) req.onupgradeneeded?.(); req.onsuccess?.(); } catch (error) { req.error = error; req.onerror?.(); } }); return req;
    },
    _db(name) { return databases.get(name); }
  };
}
async function openFakeDb(idb, name, version, upgrade) { await new Promise((resolve, reject) => { const req = idb.open(name, version); req.onupgradeneeded = () => upgrade(req.result); req.onsuccess = resolve; req.onerror = () => reject(req.error); }); }
async function fakeRows(db, store) { const tx = db.transaction(store, 'readonly'); return await new Promise((resolve, reject) => { const req = tx.objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

test('IndexedDB integration migrates records, future fields, images, and remains idempotent', async () => {
  const idb = createFakeIndexedDb({ strictTransactions: true });
  await openFakeDb(idb, core.IMAGE_DB_NAME, 7, db => db.createObjectStore(core.IMAGE_STORE_NAME));
  const imageDb = idb._db(core.IMAGE_DB_NAME); const imageTx = imageDb.transaction(core.IMAGE_STORE_NAME, 'readwrite');
  imageTx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['profile']), 'profile-image');
  imageTx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['player']), 'player-image');
  imageTx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['orphan']), 'orphan-image');
  imageTx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['season']), 'season-image');
  await new Promise(resolve => { imageTx.oncomplete = resolve; });
  const state = fixture(); const rawBefore = JSON.stringify(state);
  const result = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(result.status, 'passed_verification', JSON.stringify(result));
  assert.equal(result.verification.countsMatch, true); assert.equal(result.verification.hashesMatch, true);
  assert.equal(result.verification.images.total, 4); assert.equal(result.verification.images.totalBytes, 25);
  assert.deepEqual(result.verification.images.unreferencedImageIds, ['orphan-image']);
  const shadow = idb._db(core.SHADOW_MIGRATION_DB_NAME);
  assert.equal((await fakeRows(shadow, 'completions')).length, 2);
  assert.deepEqual((await fakeRows(shadow, 'collections')).map(row => row.field), ['futureRows']);
  assert.equal((await fakeRows(shadow, 'values')).find(row => row.field === 'futureFlag').value.enabled, true);
  assert.equal(JSON.stringify(state), rawBefore);
  const again = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(again.status, 'passed_verification'); assert.equal((await fakeRows(shadow, 'completions')).length, 2);
  assert.equal(idb._db(core.IMAGE_DB_NAME).version, 7); assert.equal((await fakeRows(imageDb, core.IMAGE_STORE_NAME)).length, 4);
});

test('IndexedDB integration safely reports absent image DB and retries after an interrupted migration', async () => {
  const idb = createFakeIndexedDb(); const state = fixture();
  const absent = await core.getImageInventory(idb);
  assert.equal(absent.exists, false); assert.equal(idb._db(core.IMAGE_DB_NAME), undefined);
  const failed = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(failed.status, 'failed');
  await openFakeDb(idb, core.IMAGE_DB_NAME, 3, db => db.createObjectStore(core.IMAGE_STORE_NAME));
  const imageDb = idb._db(core.IMAGE_DB_NAME); let tx = imageDb.transaction(core.IMAGE_STORE_NAME, 'readwrite');
  tx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['ok']), 'profile-image'); tx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['ok']), 'season-image'); await new Promise(resolve => { tx.oncomplete = resolve; });
  const missing = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(missing.status, 'failed'); assert.deepEqual(missing.verification.images.missingImageIds, ['player-image']);
  tx = imageDb.transaction(core.IMAGE_STORE_NAME, 'readwrite'); tx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['ok']), 'player-image'); await new Promise(resolve => { tx.oncomplete = resolve; });
  const retried = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(retried.status, 'passed_verification', JSON.stringify(retried));
});

test('full migration passes when legacy source omits known empty stores', async () => {
  const idb = createFakeIndexedDb({ strictTransactions: true }); const state = fixture(); delete state.seasonHistory; delete state.matchups;
  await openFakeDb(idb, core.IMAGE_DB_NAME, 1, db => db.createObjectStore(core.IMAGE_STORE_NAME));
  const imageDb = idb._db(core.IMAGE_DB_NAME); const tx = imageDb.transaction(core.IMAGE_STORE_NAME, 'readwrite');
  ['profile-image', 'player-image', 'season-image'].forEach(id => tx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['ok']), id)); await new Promise(resolve => { tx.oncomplete = resolve; });
  const result = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(result.status, 'passed_verification', JSON.stringify(result));
  assert.equal(Object.hasOwn(state, 'seasonHistory'), false); assert.equal(Object.hasOwn(state, 'matchups'), false);
  assert.equal((await fakeRows(idb._db(core.SHADOW_MIGRATION_DB_NAME), 'seasonHistory')).length, 0);
});

test('verification reports count mismatches with source and destination counts', () => {
  const source = core.shadowSourceSummary(fixture());
  const destinationState = fixture(); destinationState.completions.pop();
  const destination = core.shadowSourceSummary(destinationState);
  const mismatches = core.shadowVerificationMismatches(source, destination);
  assert.deepEqual(mismatches.find(item => item.type === 'count' && item.field === 'completions'), { type: 'count', field: 'completions', sourceCount: 2, destinationCount: 1 });
});

test('verification reports per-collection hash mismatches and missing collections', () => {
  const source = core.shadowSourceSummary(fixture());
  const changed = fixture(); changed.futureRows[0].x = 2;
  const mismatches = core.shadowVerificationMismatches(source, core.shadowSourceSummary(changed));
  const rowMismatch = mismatches.find(item => item.type === 'hash' && item.field === 'futureRows');
  assert.ok(rowMismatch); assert.notEqual(rowMismatch.sourceHash, rowMismatch.destinationHash);
  assert.equal(typeof rowMismatch.sourceCanonicalLength, 'number');
  const missing = fixture(); delete missing.futureRows;
  assert.equal(core.shadowVerificationMismatches(source, core.shadowSourceSummary(missing)).some(item => item.type === 'missing_collection' && item.field === 'futureRows'), true);
});

test('verification reports an overall hash mismatch even when counts match', () => {
  const source = core.shadowSourceSummary(fixture());
  const changed = fixture(); changed.completions[0].points = 99;
  const destination = core.shadowSourceSummary(changed);
  assert.deepEqual(source.counts, destination.counts);
  const mismatches = core.shadowVerificationMismatches(source, destination);
  assert.ok(mismatches.some(item => item.type === 'hash' && item.field === 'overallState'));
});

test('diagnostic export contains metadata only, never raw records or sensitive values', () => {
  const source = core.shadowSourceSummary(fixture());
  const changed = fixture(); changed.completions[0].note = 'private note';
  const destination = core.shadowSourceSummary(changed);
  const report = core.shadowDiagnosticExport({ status: 'failed', sourceCounts: source.counts, destinationCounts: destination.counts, verification: { countsMatch: true, hashesMatch: false, source: { counts: source.counts, hashes: source.hashes, hashDetails: source.hashDetails }, destination: { counts: destination.counts, hashes: destination.hashes, hashDetails: destination.hashDetails }, mismatches: core.shadowVerificationMismatches(source, destination), images: { total: 2, totalBytes: 20, missingImageIds: ['secret-image'], unreferencedImageIds: ['other-image'] } } });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('private note'), false); assert.equal(serialized.includes('secret-image'), false);
  assert.equal(serialized.includes('completions'), true); assert.equal(Object.hasOwn(report.verification, 'mismatches'), true);
});

test('diagnostic formatter identifies counts, overall hashes, and abbreviated hash mismatches', () => {
  const text = core.formatShadowMigrationDiagnostics({ verification: { countsMatch: false, hashesMatch: false, mismatches: [{ type: 'count', field: 'completions', sourceCount: 5, destinationCount: 4 }, { type: 'hash', field: 'overallState', sourceHash: '12345678:10', destinationHash: 'abcdefgh:10' }] } });
  assert.match(text, /Counts matched: no/); assert.match(text, /Overall hash matched: no/); assert.match(text, /completions \(5 source \/ 4 destination\)/); assert.match(text, /overallState \(12345678 \/ abcdefgh\)/);
});

test('successful verification reports no mismatches and includes complete hash metadata', async () => {
  const idb = createFakeIndexedDb(); const state = fixture();
  await openFakeDb(idb, core.IMAGE_DB_NAME, 1, db => db.createObjectStore(core.IMAGE_STORE_NAME));
  const tx = idb._db(core.IMAGE_DB_NAME).transaction(core.IMAGE_STORE_NAME, 'readwrite');
  ['profile-image', 'player-image', 'season-image'].forEach(id => tx.objectStore(core.IMAGE_STORE_NAME).put(new Blob(['ok']), id)); await new Promise(resolve => { tx.oncomplete = resolve; });
  const result = await core.runShadowMigration({ state, indexedDB: idb, localStorage: { getItem: () => '' } });
  assert.equal(result.status, 'passed_verification'); assert.deepEqual(result.verification.mismatches, []);
  assert.equal(result.verification.source.hashDetails.arrays.completions.canonicalLength > 0, true);
  assert.equal(result.verification.destination.hashDetails.values.canonicalLength > 0, true);
});

test('in-memory failed migration metadata is retained for diagnostic export when status rereading is not started', async () => {
  const failed = { status: 'failed', sourceCounts: { completions: 2 }, destinationCounts: { completions: 2 }, verification: { countsMatch: true, hashesMatch: false, source: { counts: { completions: 2 }, hashes: { state: 'aaaa:1' }, hashDetails: { state: { hash: 'aaaa:1', canonicalLength: 1 }, arrays: {}, collections: {}, values: { hash: 'bbbb:1', canonicalLength: 1 } } }, destination: { counts: { completions: 2 }, hashes: { state: 'cccc:1' }, hashDetails: { state: { hash: 'cccc:1', canonicalLength: 1 }, arrays: {}, collections: {}, values: { hash: 'dddd:1', canonicalLength: 1 } } }, mismatches: [{ type: 'hash', field: 'overallState', sourceHash: 'aaaa:1', destinationHash: 'cccc:1' }], images: { total: 165, totalBytes: 4938619, referenced: 100, missingImageIds: [], unreferencedImageIds: [] } } };
  let rereads = 0;
  const selected = await core.resolveShadowMigrationDiagnosticMetadata(failed, async () => { rereads++; return { status: 'not_started' }; });
  assert.equal(selected, failed); assert.equal(rereads, 0);
  const report = core.shadowDiagnosticExport(selected);
  assert.equal(report.status, 'failed'); assert.equal(report.verification.images.total, 165);
  assert.equal(report.verification.mismatches[0].field, 'overallState');
});
