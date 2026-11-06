const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const countModules = [
  'phase3_read_path.js',
  'phase3_navigation_cache.js',
  'phase4_primary_read_path.js',
  'phase4_storage_coordinator.js',
  'phase4_cache_guard.js',
  'phase5a_native_snapshot.js',
  'save_pipeline_shared_work.js',
  'storage_maintenance_idle.js'
];

test('all Phase 3/4 and secondary snapshot guards refuse stale primary caches while player edits remain journaled', () => {
  for (const file of countModules) {
    const src = read(file);
    assert.ok(src.includes('readPendingPlayerEdits'), file + ' must count pending player edits');
    assert.ok(src.includes('readPendingHabitDeltas'), file + ' must retain habit journal protection');
  }
});

test('navigation, hot cache, and primary snapshot guards invalidate when player journal changes', () => {
  const key = 'taskpoints_pending_player_edits_v1';
  for (const file of ['state_hot_cache.js', 'phase3_navigation_cache.js',
    'phase4_primary_read_path.js', 'phase4_storage_coordinator.js', 'phase4_cache_guard.js']) {
    assert.ok(read(file).includes(key), file + ' must observe the player journal key');
  }
  const primary = read('phase4_primary_read_path.js');
  assert.match(primary, /journalCount\(\) > 0/);
  const phase3 = read('phase3_read_path.js');
  assert.match(phase3, /pendingHabitDeltas === 0/);
  assert.match(phase3, /readPendingPlayerEdits/);
});

test('emergency recovery replays pending player edits before verifying restored snapshot', () => {
  const html = read('emergency_recovery.html');
  const pendingPlayer = html.indexOf('core.readPendingPlayerEdits()');
  const normalize = html.indexOf('state = core?.normalizeState ? core.normalizeState(state) : state');
  const readback = html.indexOf('Recovery verification failed; the restored counts did not match.');
  assert.ok(pendingPlayer >= 0 && pendingPlayer < normalize && normalize < readback);
});

test('Game editor preserves ordinary full saves for photo changes, deletion and roster moves', () => {
  const game = read('game.html');
  assert.match(game, /!imageData && wasActive === nextActive/);
  assert.match(game, /state = saveState\(result\.state\)/);
  assert.match(game, /await deleteImageById\(player\?\.imageId\)/);
});
