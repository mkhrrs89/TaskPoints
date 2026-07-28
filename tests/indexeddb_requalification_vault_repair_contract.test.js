const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'indexeddb_requalification_vault_repair.js');
const HTML_PATH = path.join(__dirname, '..', 'indexeddb_requalification.html');
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

function rawHash(raw) {
  const text = String(raw || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function countsFor(state) {
  const keys = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders',
    'weightHistory', 'vo2MaxHistory'
  ];
  const major = ['tasks', 'completions', 'habits', 'players', 'gameHistory', 'matchups', 'seasonHistory'];
  const counts = Object.fromEntries(keys.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = keys.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = major.reduce((sum, key) => sum + counts[key], 0);
  return counts;
}

function createElement() {
  const classes = new Set(['hidden']);
  const listeners = new Map();
  return {
    disabled: true,
    textContent: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name)
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    click() { return listeners.get('click')?.({ preventDefault() {}, stopImmediatePropagation() {} }); }
  };
}

function createIndexedDB(initialRecord) {
  const rows = new Map([['latest', structuredClone(initialRecord)]]);
  const request = (work) => {
    const result = {};
    queueMicrotask(() => {
      try { result.result = work(); result.onsuccess?.(); }
      catch (error) { result.error = error; result.onerror?.(); }
    });
    return result;
  };
  const db = {
    objectStoreNames: { contains: (name) => name === 'snapshots' },
    transaction() {
      const transaction = {
        error: null,
        aborted: false,
        abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); },
        objectStore() {
          return {
            get: (id) => request(() => structuredClone(rows.get(id))),
            put: (value) => request(() => { rows.set(value.id, structuredClone(value)); return value.id; })
          };
        }
      };
      setTimeout(() => { if (!transaction.aborted) transaction.oncomplete?.(); }, 0);
      return transaction;
    },
    close() {}
  };
  return {
    databases: async () => [{ name: 'taskpoints_safety_vault_v1' }],
    open() {
      const result = {};
      queueMicrotask(() => { result.result = db; result.onsuccess?.(); });
      return result;
    },
    read() { return structuredClone(rows.get('latest')); }
  };
}

function wait(ms = 20) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('setup page loads metadata repair before the read-only loader and includes an explicit hidden button', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(html.indexOf('storage_health_codec.js') < html.indexOf('indexeddb_requalification_vault_repair.js'));
  assert.ok(html.indexOf('indexeddb_requalification_vault_repair.js') < html.indexOf('indexeddb_requalification_loader.js'));
  assert.match(html, /id="repairVaultCountsBtn"/);
  assert.match(html, /Repair emergency backup check/);
  assert.match(html, /hidden/);
});

test('metadata-only repair preserves vault raw data and fingerprint while correcting stored totals', async () => {
  const state = {
    tasks: [{ id: 't1' }],
    completions: Array.from({ length: 40 }, (_, id) => ({ id })),
    habits: [{ id: 'h1' }],
    players: Array.from({ length: 12 }, (_, id) => ({ id })),
    gameHistory: Array.from({ length: 20 }, (_, id) => ({ id })),
    matchups: Array.from({ length: 20 }, (_, id) => ({ id })),
    seasonHistory: [{ id: 's1' }],
    weightHistory: [{ id: 'w1' }],
    vo2MaxHistory: [{ id: 'v1' }]
  };
  const raw = JSON.stringify(state);
  const original = {
    id: 'latest',
    schemaVersion: 1,
    createdAtISO: '2026-07-27T12:00:00.000Z',
    reason: 'startup-known-good',
    raw,
    rawHash: rawHash(raw),
    counts: { tasks: 0, completions: 0, habits: 0, players: 0, flexActions: 0, gameHistory: 0, matchups: 0, schedule: 0, seasonHistory: 0, reminders: 0, total: 0, majorTotal: 0 }
  };
  const indexedDB = createIndexedDB(original);
  const repairButton = createElement();
  const actionMessage = createElement();
  const refreshButton = createElement();
  let refreshes = 0;
  refreshButton.click = () => { refreshes += 1; };
  const elements = {
    repairVaultCountsBtn: repairButton,
    actionMessage,
    refreshBtn: refreshButton
  };
  let readyHandler = null;
  const document = {
    getElementById: (id) => elements[id] || null,
    addEventListener(type, handler) { if (type === 'DOMContentLoaded') readyHandler = handler; }
  };
  const context = {
    TaskPointsStorageHealth: {
      countsFor,
      parseStoredRaw: (value) => ({ state: JSON.parse(value), encoding: 'plain JSON' }),
      rawHash
    },
    document,
    indexedDB,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    Promise,
    Error,
    console
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_vault_repair.js' });
  readyHandler();
  await wait();
  assert.equal(repairButton.classList.contains('hidden'), false);
  assert.equal(repairButton.disabled, false);

  await repairButton.click();
  await wait();

  const repaired = indexedDB.read();
  assert.equal(repaired.raw, original.raw);
  assert.equal(repaired.rawHash, original.rawHash);
  assert.equal(repaired.createdAtISO, original.createdAtISO);
  assert.equal(repaired.reason, original.reason);
  assert.equal(repaired.counts.tasks, 1);
  assert.equal(repaired.counts.completions, 40);
  assert.equal(repaired.counts.players, 12);
  assert.equal(repaired.counts.majorTotal, 95);
  assert.equal(repaired.counts.total, 95);
  assert.equal(Object.hasOwn(repaired.counts, 'weightHistory'), false);
  assert.equal(Object.hasOwn(repaired.counts, 'vo2MaxHistory'), false);
  assert.equal(repaired.metadataRepairReason, 'verified-raw-count-recalculation');
  assert.ok(repaired.metadataRepairedAtISO);
  assert.equal(refreshes, 1);
});

test('repair control stays hidden when the vault fingerprint is invalid', async () => {
  const raw = JSON.stringify({ completions: Array.from({ length: 40 }, (_, id) => ({ id })) });
  const indexedDB = createIndexedDB({
    id: 'latest', raw, rawHash: 'wrong:1', counts: { completions: 0, majorTotal: 0, total: 0 }
  });
  const repairButton = createElement();
  const elements = { repairVaultCountsBtn: repairButton };
  let readyHandler = null;
  const document = {
    getElementById: (id) => elements[id] || null,
    addEventListener(type, handler) { if (type === 'DOMContentLoaded') readyHandler = handler; }
  };
  const context = {
    TaskPointsStorageHealth: {
      countsFor,
      parseStoredRaw: (value) => ({ state: JSON.parse(value), encoding: 'plain JSON' }),
      rawHash
    },
    document,
    indexedDB,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    Promise,
    Error,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_vault_repair.js' });
  readyHandler();
  await wait();
  assert.equal(repairButton.classList.contains('hidden'), true);
  assert.equal(repairButton.disabled, true);
});
