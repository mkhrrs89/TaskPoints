'use strict';
// M01: actual V1/V2 preview and recovery source executed in isolated Node VMs.
// These are compatibility behavior witnesses, NOT live production owner/fence proofs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const V1_KEY = 'taskpoints_v1';
const V1_VALUE = JSON.stringify({
  tasks: [{id: 'keep'}], goldLedger: [{id: 'gold'}],
  unknownImportedField: {preserve: true}
});
const PREVIEW_KEY = 'taskpoints_state_v2_dark_mode_v1';
const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
const WAL_ARM_KEY = 'taskpoints_state_v2_wal_test_armed_v1';
const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';

function production(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function htmlInline(file, index = 0) {
  const scripts = [...production(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  assert.ok(scripts[index], 'expected real inline script missing: ' + file + ' #' + index);
  return scripts[index];
}
function bodyBetween(file, start, end) {
  const s = production(file);
  const first = s.indexOf(start);
  const last = s.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'real source anchor moved: ' + file);
  return s.slice(first, last);
}
function makeStorage(seed = {}, options = {}) {
  const entries = new Map(Object.entries(seed));
  const writes = [];
  const s = {
    entries, writes,
    getItem(key) {
      if (options.failRead === key) throw new Error('read denied');
      return entries.get(String(key)) ?? null;
    },
    setItem(key, value) {
      const k = String(key), v = String(value);
      if (options.failWrite === k) throw new Error('QuotaExceededError');
      writes.push({op: 'set', key: k, value: v});
      if (options.ignoreWrite !== k) entries.set(k, v);
    },
    removeItem(key) {
      const k = String(key);
      if (options.failRemove === k) throw new Error('storage removal denied');
      writes.push({op: 'remove', key: k});
      entries.delete(k);
    }
  };
  return s;
}
function assertMainUnchanged(s) {
  assert.equal(s.entries.get(V1_KEY), V1_VALUE, 'must never touch authoritative V1 snapshot');
  assert.ok(!s.writes.some(x => x.key === V1_KEY), 'no writes against V1');
}
function execute(src, supplied = {}, filename = 'actual-production-source') {
  const ctx = {
    console: {error() {}, warn() {}, log() {}},
    URLSearchParams, Date, JSON, String, Number, Math, Set, Map, Promise,
    ...supplied
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, {filename});
  return ctx;
}
function pageContext(host, localStorage, sessionStorage = makeStorage(), extras = {}) {
  const status = {className: '', textContent: '', innerHTML: ''};
  const redirects = [], timers = [];
  const location = {
    hostname: host, search: '', pathname: '/preview', hash: '',
    replace(url) {redirects.push(url);}
  };
  const ctx = {localStorage, sessionStorage, location,
    document: {getElementById(id) {return id === 'status' ? status : null;}},
    setTimeout(callback, delay) {timers.push({callback, delay}); return timers.length;},
    ...extras
  };
  return {ctx, status, redirects, timers};
}

// Route 1 — preview-only opt-in flag.
test('preview opt-in persists dark flag only on branch preview; carries one-time redirect signal', () => {
  const s = makeStorage({[V1_KEY]: V1_VALUE}), session = makeStorage();
  const h = pageContext('arch-state-runtime-v2-plan.taskpoints.pages.dev', s, session);
  h.ctx.location.search = '?perf=1';
  execute(htmlInline('state_v2_preview_enable.html'), h.ctx, 'state_v2_preview_enable.html');
  assert.equal(s.getItem(PREVIEW_KEY), '1');
  assert.equal(session.getItem('tp_perf_trace_enabled_v1'), '1');
  assert.equal(h.status.className, 'ok');
  assert.equal(h.timers.length, 1);
  h.timers[0].callback();
  assert.equal(h.redirects[0], '/?v2dark=1&perf=1');
  assertMainUnchanged(s);
});
test('preview opt-in refuses production/unknown hosts and failed flag writes', () => {
  for (const host of ['taskpoints.pages.dev', 'www.taskpoints.pages.dev', 'unrelated.example']) {
    const s = makeStorage({[V1_KEY]: V1_VALUE, [PREVIEW_KEY]: '1'});
    const h = pageContext(host, s);
    execute(htmlInline('state_v2_preview_enable.html'), h.ctx);
    assert.equal(h.status.className, 'bad');
    assert.equal(h.redirects.length, 0);
    if (host.includes('taskpoints.pages.dev')) assert.equal(s.getItem(PREVIEW_KEY), null);
    assertMainUnchanged(s);
  }
  const blocked = makeStorage({[V1_KEY]: V1_VALUE}, {failWrite: PREVIEW_KEY});
  const h = pageContext('localhost', blocked);
  execute(htmlInline('state_v2_preview_enable.html'), h.ctx);
  assert.equal(h.status.className, 'bad');
  assert.equal(blocked.getItem(PREVIEW_KEY), null);
  assert.equal(h.timers.length, 0);
  assertMainUnchanged(blocked);
});

const V2_KEYS = [
  'taskpoints_state_v2_dark_mode_v1',
  'taskpoints_state_v2_generation_v1',
  'taskpoints_v2_pending_mutations_v1'
];
const V2_DBS = [
  'taskpoints_state_v2', 'taskpoints_v2_notes_preview',
  'taskpoints_v2_game_preview', 'taskpoints_v2_habit_order_preview'
];
function cleanupHarness({host = 'branch.taskpoints.pages.dev', failRemove, requestError, missingIndexedDb = false} = {}) {
  const s = makeStorage({[V1_KEY]: V1_VALUE,
    'taskpoints_pending_habit_deltas_v1': 'uncompacted',
    [PREVIEW_KEY]: '1', [GENERATION_KEY]: 'epoch', 'taskpoints_v2_pending_mutations_v1': 'wal'
  }, {failRemove});
  const dbCalls = [], requests = [];
  const indexedDB = missingIndexedDb ? undefined : {
    deleteDatabase(name) {
      dbCalls.push(name);
      if (requestError === 'throw') throw Error('database busy');
      const request = {};
      requests.push(request);
      return request;
    }
  };
  const h = pageContext(host, s, makeStorage(), {indexedDB});
  execute(htmlInline('state_v2_preview_cleanup.html'), h.ctx, 'state_v2_preview_cleanup.html');
  return {s, ...h, dbCalls, requests};
}
// Route 2 — isolated preview-key removal.
test('preview cleanup removes three V2-only keys and leaves live, backups and Habit journal untouched', () => {
  const h = cleanupHarness();
  for (const key of V2_KEYS) assert.equal(h.s.getItem(key), null);
  assert.equal(h.s.getItem('taskpoints_pending_habit_deltas_v1'), 'uncompacted');
  assert.ok(h.s.writes.every(op => V2_KEYS.includes(op.key)));
  assert.equal(h.dbCalls[0], V2_DBS[0]);
  assertMainUnchanged(h.s);
});
test('preview cleanup refuses production, stops on a failed key removal, preserves V1', () => {
  const prod = cleanupHarness({host: 'taskpoints.pages.dev'});
  assert.equal(prod.s.getItem(PREVIEW_KEY), '1');
  assert.equal(prod.dbCalls.length, 0);
  assert.equal(prod.status.className, 'bad');
  assert.equal(prod.s.writes.length, 0);
  const denied = cleanupHarness({failRemove: GENERATION_KEY});
  assert.equal(denied.s.getItem(GENERATION_KEY), 'epoch');
  assert.equal(denied.s.getItem('taskpoints_v2_pending_mutations_v1'), 'wal');
  assert.equal(denied.dbCalls.length, 0, 'must not proceed to IDB after a refused flag deletion');
  assert.equal(denied.status.className, 'bad');
  assertMainUnchanged(prod.s);
  assertMainUnchanged(denied.s);
});
// Route 3 — isolated V2/preview IndexedDB deletion.
test('preview cleanup deletes exactly four isolated V2 databases, never live V1 image databases', () => {
  const h = cleanupHarness();
  for (let i = 0; i < V2_DBS.length; i++) {
    assert.equal(h.dbCalls[i], V2_DBS[i]);
    assert.equal(h.requests.length, i + 1);
    h.requests[i].onsuccess();
  }
  assert.equal(h.status.className, 'ok');
  assert.deepEqual(h.dbCalls, V2_DBS);
  assert.ok(!h.dbCalls.includes('taskpoints'));
  assert.ok(!h.dbCalls.includes('taskpoints_verified_secondary_v1'));
  assertMainUnchanged(h.s);
});
test('preview DB deletion blocked or unavailable is reported rather than claiming cleanup', () => {
  for (const kind of ['blocked', 'error']) {
    const h = cleanupHarness();
    h.requests[0][kind === 'blocked' ? 'onblocked' : 'onerror']();
    assert.equal(h.status.className, 'bad');
    assert.equal(h.dbCalls.length, 1);
    assertMainUnchanged(h.s);
  }
  const unavailable = cleanupHarness({missingIndexedDb: true});
  assert.equal(unavailable.status.className, 'bad');
  assert.equal(unavailable.dbCalls.length, 0);
  assertMainUnchanged(unavailable.s);
});

// Routes 4 and 5 — recovery preload hold and faster-storage forced-off.
function verifiedRestoreHarness(options = {}) {
  const s = makeStorage({
    [V1_KEY]: V1_VALUE, [MODE_KEY]: 'indexeddb_primary',
    'taskpoints_pending_habit_deltas_v1': '[{"id":"pending"}]',
    'taskpoints_phase5b_pending_changes_v1': '[{"id":"old"}]'
  }, options);
  const c = execute(htmlInline('verified_secondary_restore.html'), {localStorage: s}, 'verified_secondary_restore.html');
  return {s, c};
}
test('verified-secondary preload captures both journals before establishing recovery hold', () => {
  const {s, c} = verifiedRestoreHarness();
  const captured = c.__taskPointsVerifiedSecondaryRestorePreload;
  assert.equal(captured.habitJournalRaw, '[{"id":"pending"}]');
  assert.equal(captured.legacyJournalRaw, '[{"id":"old"}]');
  const hold = JSON.parse(s.getItem(HOLD_KEY));
  assert.equal(hold.active, true);
  assert.equal(hold.reason, 'verified_secondary_manual_restore_preview');
  assert.ok(s.writes.findIndex(w => w.key === HOLD_KEY) < s.writes.findIndex(w => w.key === MODE_KEY));
  assertMainUnchanged(s);
});
test('verified-secondary preload forces IndexedDB primary mode off; failed hold cannot falsely certify the mode', () => {
  const success = verifiedRestoreHarness();
  assert.equal(success.s.getItem(MODE_KEY), 'off');
  assert.equal(success.s.getItem(HOLD_KEY) !== null, true);
  const blocked = verifiedRestoreHarness({failWrite: HOLD_KEY});
  assert.equal(blocked.s.getItem(HOLD_KEY), null);
  assert.equal(blocked.s.getItem(MODE_KEY), 'indexeddb_primary',
    'initial try block aborts before mode-off; important unresolved fail-closed safety risk');
  assertMainUnchanged(success.s);
  assertMainUnchanged(blocked.s);
});

// Route 6 — emergency recovery must establish hold before loading V1.
test('emergency recovery first script immediately engages hold and disables faster storage without writing V1', () => {
  const s = makeStorage({[V1_KEY]: V1_VALUE, [MODE_KEY]: 'indexeddb_primary'});
  execute(htmlInline('emergency_recovery.html'), {localStorage: s}, 'emergency_recovery.html');
  const hold = JSON.parse(s.getItem(HOLD_KEY));
  assert.equal(hold.active, true);
  assert.equal(hold.reason, 'manual_emergency_recovery');
  assert.equal(s.getItem(MODE_KEY), 'off');
  assert.deepEqual(s.writes.map(x => x.key), [HOLD_KEY, MODE_KEY]);
  assertMainUnchanged(s);
});
test('emergency recovery hold refusal does not silently claim that storage protection was installed', () => {
  const s = makeStorage({[V1_KEY]: V1_VALUE, [MODE_KEY]: 'indexeddb_primary'}, {failWrite: HOLD_KEY});
  execute(htmlInline('emergency_recovery.html'), {localStorage: s});
  assert.equal(s.getItem(HOLD_KEY), null);
  assert.equal(s.getItem(MODE_KEY), 'indexeddb_primary',
    'fail-closed path requires a separate runtime guard before restore can be approved');
  assertMainUnchanged(s);
});

// Route 7 — V2 generation-key writer must verify readback and avoid false rotation.
function generationHarness(options = {}) {
  const s = makeStorage({[V1_KEY]: V1_VALUE, [PREVIEW_KEY]: '1'}, options);
  let seq = 0;
  const c = execute(production('state_runtime_v2_generation.js'), {
    localStorage: s, sessionStorage: makeStorage(),
    location: {hostname: 'localhost', search: '', pathname: '/'},
    crypto: {randomUUID() {return 'fresh-' + (++seq);}},
    URLSearchParams
  }, 'state_runtime_v2_generation.js');
  return {s, c, api: c.TaskPointsStateRuntimeV2Generation};
}
test('V2 generation writer creates a durable epoch, then rotates to a distinct verified epoch', () => {
  const h = generationHarness();
  const first = h.s.getItem(GENERATION_KEY);
  assert.match(first, /^v2-bootstrap:fresh-/);
  assert.equal(h.api.read(), first);
  const events = [];
  h.api.subscribe(e => events.push(e));
  const rotated = h.api.rotate('restored');
  assert.equal(rotated.rotated, true);
  assert.notEqual(h.s.getItem(GENERATION_KEY), first);
  assert.equal(events.length, 1);
  assert.equal(events[0].previousGeneration, first);
  assertMainUnchanged(h.s);
});
test('V2 generation rejects quota-denied or silently ignored epoch writes', () => {
  for (const options of [{failWrite: GENERATION_KEY}, {ignoreWrite: GENERATION_KEY}]) {
    const h = generationHarness(options);
    assert.throws(() => h.api.ensure(), /state_runtime_v2_generation_write_failed/);
    assert.equal(h.s.getItem(GENERATION_KEY), null);
    assert.equal(h.api.getStatus().rotations, 0);
    assertMainUnchanged(h.s);
  }
});

// Route 8 — WAL kill-test arming is expressly preview-only.
function liveReviewHarness({host = 'localhost', dark = true, failWrite = false} = {}) {
  const local = makeStorage({[V1_KEY]: V1_VALUE, ...(dark ? {[PREVIEW_KEY]: '1'} : {})});
  const session = makeStorage({}, {failWrite: failWrite ? WAL_ARM_KEY : null});
  const actual = bodyBetween('state_runtime_v2_live_review.js',
    "  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';",
    '  function escapeHtml(value) {');
  const c = execute('(function (global) {\n' + actual +
    '\nglobal.__armWalKillTest = armWalKillTest;\n})(window);', {
      localStorage: local, sessionStorage: session, location: {hostname: host}
    }, 'state_runtime_v2_live_review.js');
  return {local, session, c};
}
test('WAL test arm writes one-use session marker only on a dark preview', () => {
  const h = liveReviewHarness();
  assert.equal(h.c.__armWalKillTest(), true);
  assert.equal(h.session.getItem(WAL_ARM_KEY), '1');
  assertMainUnchanged(h.local);
});
test('WAL test arming refuses production, disabled preview and quota denial', () => {
  for (const opts of [
    {host: 'taskpoints.pages.dev'}, {dark: false}, {failWrite: true}
  ]) {
    const h = liveReviewHarness(opts);
    assert.throws(() => h.c.__armWalKillTest(), /preview-only|not enabled|QuotaExceeded/);
    assert.equal(h.session.getItem(WAL_ARM_KEY), null);
    assertMainUnchanged(h.local);
  }
});

// Route 9 — WAL bridge consumes the one-use test marker at most once.
function walBridgeHarness({host = 'localhost', arm = true, failRemove = false} = {}) {
  const local = makeStorage({[V1_KEY]: V1_VALUE, [PREVIEW_KEY]: '1'});
  const session = makeStorage(arm ? {[WAL_ARM_KEY]: '1'} : {},
    {failRemove: failRemove ? WAL_ARM_KEY : null});
  const markers = [];
  const actual = bodyBetween('state_runtime_v2_wal_bridge.js',
    "  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';",
    '  function isPreviewWalTestHoldActive() {');
  const c = execute('(function (global) {\n' + actual +
    '\nglobal.__consumeWalTestArm = activatePreviewWalTestHold;\n})(window);', {
      localStorage: local, sessionStorage: session, location: {hostname: host},
      TaskPointsPerf: {mark(name, value) {markers.push({name, value});}}
    }, 'state_runtime_v2_wal_bridge.js');
  return {c, local, session, markers};
}
test('WAL bridge consumes armed marker, enters page-local hold, and cannot replay arm twice', () => {
  const h = walBridgeHarness();
  assert.equal(h.c.__consumeWalTestArm('mut-1'), true);
  assert.equal(h.session.getItem(WAL_ARM_KEY), null);
  assert.equal(h.c.__taskpointsStateV2WalKillHoldV1, true);
  assert.equal(h.c.__consumeWalTestArm('mut-2'), false);
  assert.equal(h.markers.length, 1);
  assert.equal(h.markers[0].value.mutationId, 'mut-1');
  assertMainUnchanged(h.local);
});
test('WAL bridge does not consume marker on production or when remove fails', () => {
  for (const opts of [{host: 'taskpoints.pages.dev'}, {failRemove: true}, {arm: false}]) {
    const h = walBridgeHarness(opts);
    assert.equal(h.c.__consumeWalTestArm('mut'), false);
    assert.equal(h.c.__taskpointsStateV2WalKillHoldV1, undefined);
    if (opts.arm !== false) assert.equal(h.session.getItem(WAL_ARM_KEY), '1');
    assertMainUnchanged(h.local);
  }
});
