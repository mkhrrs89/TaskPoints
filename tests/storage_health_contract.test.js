const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const health = fs.readFileSync(path.join(ROOT, 'storage_health.html'), 'utf8');
const codec = fs.readFileSync(path.join(ROOT, 'storage_health_codec.js'), 'utf8');
const readers = fs.readFileSync(path.join(ROOT, 'storage_health_readers.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'storage_health_ui.js'), 'utf8');
const script = [codec, readers, ui].join('\n');
const phase4 = fs.readFileSync(path.join(ROOT, 'phase4_storage_status.html'), 'utf8');

test('storage health page is read-only and self-contained', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(health, /scoring_core\.js/);
  assert.match(health, /storage_health_codec\.js/);
  assert.match(health, /storage_health_readers\.js/);
  assert.match(health, /storage_health_ui\.js/);
  assert.doesNotMatch(script, /localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(script, /\.transaction\([^\n]*['"]readwrite['"]/);
  assert.doesNotMatch(script, /\.put\s*\(|\.delete\s*\(|\.clear\s*\(/);
  assert.match(script, /decompressUtf16/);
  assert.match(script, /__taskpointsStorageEncoding === 'lz16-packed-v1'/);
});

test('panel covers restored state, guard, vault, journals, images, and browser quota', () => {
  for (const token of [
    'taskpoints_v1',
    'taskpoints_storage_data_loss_guard_v1',
    'taskpoints_safety_vault_v1',
    'taskpoints_phase5b_pending_changes_v1',
    'taskpoints_pending_habit_deltas_v1',
    'navigator.storage',
    'readImageReport',
    'missingReferences',
    'blockedWritesTotal',
    'phase5bLiveBundleDisabled'
  ]) assert.ok(script.includes(token), `missing ${token}`);
  assert.match(script, /db\.transaction\(VAULT_STORE, 'readonly'\)/);
  assert.match(script, /db\.transaction\(IMAGE_STORE_NAME, 'readonly'\)/);
  assert.match(script, /store\.getAllKeys\(\)/);
});

test('Phase 4 storage page links to the routine health panel without removing existing controls', () => {
  assert.match(phase4, /href="storage_health\.html"/);
  assert.match(phase4, /Emergency Data Recovery/);
  assert.match(phase4, /data-mode="off"/);
  assert.match(phase4, /data-mode="verify_primary_writes"/);
  assert.match(phase4, /data-mode="indexeddb_primary"/);
});

test('runtime scan decodes a compressed packed mirror and verifies referenced image IDs without writes', async () => {
  const fixture = Buffer.from('eyJfX3Rhc2twb2ludHNTdG9yYWdlRW5jb2RpbmciOiJsejE2LXBhY2tlZC12MSIsIl9fdGFza3BvaW50c1N0b3JhZ2VWZXJzaW9uIjoxLCJkYXRhIjoi4a+h4KGH5IiM4KyA5KSl5aCw5oKTxazjgKnkkKLnjrrLsNOT5JKowojigKHjgaDhhqF8zZvjgLviqKHkspDlgYPQoeO4oueXqFjDuOGGoeKApOeKheSrpOG3luChgeG8hOSWseWCkuKsiOKxr+WSu+KbgWzjuqLigKPnl63RgNmQ25HinaDgs4fihLLjtaDhqrTkjKLgoKDnm7jiupLil5Xlu7HmgKjhkrfjpqDmlaDnkKjZm+KxqCzmgaLkhLfig6vhqIXhpITjqprgoqrQrOalgSfjroTnjIjiqYDCmeG/keOBuuWKjuKAoeKutOKBq+eznOeIu9C84ZGlf+eZq+SBo+WGquOgrOCpl+G0oOGppcy24oSg4oKo4KCy4qOp0aXLmeGqseKRgUPnqZHnkaDmlrXhmbDgu67btuWCleSApeOMlOa8tOObjeGBp+SBm3fliKTkgYDngLQh4YGA4aOO4pKs26LkgonZq+GGgueJheOksueLiMWc47yn5Z2C4YKU4Lai5Iqh06nhsZPhm6nhh4XVreCuoOOFuOSgoeSFoOGMnuGhguCuk+KFuOKxneGFhuGEquOliueWsOeIrOOVl+SItSAgIn0=', 'base64').toString('utf8');
  const rows = new Map([
    ['taskpoints_v1', fixture],
    ['taskpoints_phase4_storage_mode_v1', 'off'],
    ['taskpoints_emergency_recovery_hold_v1', JSON.stringify({ active: true, enteredAtISO: '2026-07-27T12:00:00Z' })],
    ['taskpoints_storage_data_loss_guard_v1', JSON.stringify({ enabled: true, phase5bLiveBundleDisabled: true, installedAtISO: '2026-07-27T12:00:00Z' })]
  ]);
  const localStorage = {
    getItem: (key) => rows.has(String(key)) ? rows.get(String(key)) : null,
    setItem: () => { throw new Error('unexpected write'); },
    removeItem: () => { throw new Error('unexpected remove'); },
    clear: () => { throw new Error('unexpected clear'); }
  };
  class Element {
    constructor() { this.textContent = ''; this.innerHTML = ''; this.className = ''; this.disabled = false; }
    addEventListener() {}
  }
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); } };
  const request = (value) => {
    const result = {};
    queueMicrotask(() => { result.result = structuredClone(value); result.onsuccess?.(); });
    return result;
  };
  const vaultRows = new Map([['latest', { id: 'latest', createdAtISO: '2026-07-27T12:00:00Z', reason: 'test', counts: { tasks: 2, completions: 2, habits: 1, players: 2, gameHistory: 1, matchups: 1, seasonHistory: 1, majorTotal: 10 } }]]);
  const databases = {
    taskpoints_safety_vault_v1: { snapshots: vaultRows },
    taskpoints: { images: { keys: ['you-img','p1-img','orphan-img'] } }
  };
  const indexedDB = {
    databases: async () => Object.keys(databases).map((name) => ({ name })),
    open(name) {
      const openRequest = {};
      queueMicrotask(() => {
        const definition = databases[name];
        openRequest.result = {
          objectStoreNames: { contains: (store) => Object.hasOwn(definition, store) },
          transaction(store) {
            const tx = {
              objectStore() {
                if (store === 'snapshots') return { get: (id) => request(definition.snapshots.get(id)) };
                return { getAllKeys: () => request(definition.images.keys) };
              }
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
          close() {}
        };
        openRequest.onsuccess?.();
      });
      return openRequest;
    }
  };
  const context = {
    document,
    localStorage,
    indexedDB,
    navigator: { storage: { persisted: async () => true, estimate: async () => ({ usage: 1024, quota: 1024 * 1024 }) } },
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Set,
    Map,
    Date,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: 'storage_health.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const report = JSON.parse(elements.get('technicalReport').textContent);
  assert.equal(report.readOnly, true);
  assert.equal(report.currentMirror.readable, true);
  assert.equal(report.currentMirror.encoding, 'compressed packed JSON');
  assert.equal(report.currentMirror.counts.tasks, 2);
  assert.equal(report.currentMirror.counts.completions, 2);
  assert.equal(report.currentMirror.counts.players, 2);
  assert.equal(report.currentMirror.counts.majorTotal, 10);
  assert.equal(report.safetyVault.slots.length, 1);
  assert.equal(report.images.count, 3);
  assert.equal(report.images.referencedCount, 2);
  assert.deepEqual(report.images.missingReferences, []);
  assert.deepEqual(report.images.unreferenced, ['orphan-img']);
});
