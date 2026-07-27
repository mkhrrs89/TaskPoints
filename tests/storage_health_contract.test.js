const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const health = fs.readFileSync(path.join(ROOT, 'storage_health.html'), 'utf8');
const phase4 = fs.readFileSync(path.join(ROOT, 'phase4_storage_status.html'), 'utf8');
const script = health.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

test('storage health page is read-only and self-contained', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(health, /scoring_core\.js/);
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
    'readImageCount',
    'blockedWritesTotal',
    'phase5bLiveBundleDisabled'
  ]) assert.ok(script.includes(token), `missing ${token}`);
  assert.match(script, /db\.transaction\(VAULT_STORE, 'readonly'\)/);
  assert.match(script, /db\.transaction\(IMAGE_STORE_NAME, 'readonly'\)/);
});

test('Phase 4 storage page links to the routine health panel without removing existing controls', () => {
  assert.match(phase4, /href="storage_health\.html"/);
  assert.match(phase4, /Emergency Data Recovery/);
  assert.match(phase4, /data-mode="off"/);
  assert.match(phase4, /data-mode="verify_primary_writes"/);
  assert.match(phase4, /data-mode="indexeddb_primary"/);
});
