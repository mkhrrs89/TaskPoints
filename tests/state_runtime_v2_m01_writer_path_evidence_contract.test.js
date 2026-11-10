'use strict';
// M01 review guard. This is source-anchor evidence, NOT live V2 writer fencing
// or a claim that all indirect/dynamic call paths are covered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(
  root, 'docs/state-runtime-v2-storage-source-inventory.json'), 'utf8'));

test('M01 cross-page writer evidence is attached to reviewed existing sources', () => {
  const reviewed = new Set(inventory.firstPassInspected);
  const families = new Set(['core', 'tasks', 'habits', 'game', 'season', 'storage', 'recovery']);
  const seen = new Set();
  assert.ok(inventory.writerPathEvidence.length >= 16, 'reviewed writer baselines lost');
  for (const entry of inventory.writerPathEvidence) {
    assert.ok(reviewed.has(entry.path), 'unreviewed writer source: ' + entry.path);
    assert.ok(families.has(entry.family), 'unknown writer family: ' + entry.family);
    assert.ok(typeof entry.kind === 'string' && entry.kind.length >= 5);
    assert.ok(typeof entry.description === 'string' && entry.description.length >= 20);
    assert.ok(typeof entry.anchor === 'string' && entry.anchor.length >= 16);
    const identity = entry.path + '|' + entry.anchor;
    assert.ok(!seen.has(identity), 'duplicate source anchor: ' + identity);
    seen.add(identity);
    const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
    assert.ok(source.includes(entry.anchor), 'reviewed writer anchor moved/removed: ' + identity);
  }
  // A read-only inventory cannot satisfy M01's full ownership / live admission gate.
  assert.ok(inventory.firstPassInspected.length < inventory.sourceFiles.length);
  assert.ok(inventory.limitations.some(x => /not a complete callgraph/.test(x)));
});

test('M01 preserves the separately journaled Inbox and recovery/mirror ownership questions', () => {
  const keyProof = new Set(inventory.keyEvidence.map(e => e.key + '|' + e.evidencePath));
  for (const [key, source] of [
    ['taskpoints_pending_inbox_state_v1', 'task_create_fast_path.js'],
    ['taskpoints_inbox_scan_checkpoint_v1', 'toolbar.js'],
    ['taskpoints_recovery_write_lock_v1', 'verified_secondary_restore.js'],
    ['taskpoints_emergency_recovery_hold_v1', 'emergency_recovery.html'],
    ['taskpoints_phase3_read_mode_v1', 'phase3_read_path.js'],
    ['taskpoints_verified_secondary_v1', 'phase5b_deferred_mirror.js']
  ]) {
    assert.ok(keyProof.has(key + '|' + source),
      'separate key owner still requires tracking: ' + key);
  }
  assert.ok(inventory.dbEvidence.some(db =>
    db.db === 'taskpoints_verified_secondary_v1' &&
    db.store === 'snapshots' && db.state === 'live' &&
    db.evidencePath === 'phase5b_deferred_mirror.js'));
});
