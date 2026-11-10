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
  const families = new Set(['core', 'tasks', 'habits', 'game', 'season', 'storage', 'recovery', 'backup', 'settings', 'v2-preview']);
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
  assert.equal(inventory.firstPassInspected.length, inventory.sourceFiles.length);
  assert.equal(inventory.writerOwnershipAudit.status, 'incomplete');
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


test('M01 second-pass source evidence anchors all 30 inspected recovery and writer files', () => {
  const reviewed = inventory.reviewedSourceEvidence || [];
  const seen = new Set();
  const permitted = new Set(['read', 'write', 'bridge', 'entrypoint']);
  const families = new Set(['habits', 'game', 'season', 'settings', 'backup', 'recovery', 'storage', 'tasks', 'core', 'v2-preview']);
  assert.ok(reviewed.length >= 30, 'reviewed source evidence baseline regressed');
  assert.ok(inventory.firstPassInspected.length >= 72, 'inspected source baseline regressed');
  for (const row of reviewed) {
    assert.ok(inventory.firstPassInspected.includes(row.path),
      'review anchor not marked inspected: ' + row.path);
    assert.ok(!seen.has(row.path), 'duplicate review for: ' + row.path);
    seen.add(row.path);
    assert.ok(permitted.has(row.behavior), 'unclassified review behavior: ' + row.path);
    assert.ok(families.has(row.family), 'unclassified storage family: ' + row.path);
    assert.ok(typeof row.anchor === 'string' && row.anchor.length >= 12);
    const source = fs.readFileSync(path.join(root, row.path), 'utf8');
    assert.ok(source.includes(row.anchor),
      'reviewed source anchor moved or was removed: ' + row.path);
  }
  for (const file of [
    'flex_action_fast_path.js', 'season_result_integrity_guard.js',
    'storage_diagnostics_cleanup_controller.js',
    'storage_diagnostics_season_image_repair_controller.js',
    'inbox_count_badge.js', 'emergency_recovery_lock_authorization.js',
    'indexeddb_requalification_session_compat.js'
  ]) {
    assert.ok(seen.has(file), 'high-risk writer lacks reviewed source evidence: ' + file);
  }
  assert.ok(inventory.limitations.some(s => /not complete ownership\/fencing/.test(s)),
    'do not mistake anchors for comprehensive writer fencing');
});

test('M01 preserves both Flex journals and independent Season/photo repair writers', () => {
  const keys = new Set(inventory.keyEvidence.map(e => e.key + '|' + e.evidencePath));
  for (const key of [
    'taskpoints_pending_flex_completions_v1',
    'taskpoints_pending_flex_order_v1'
  ]) assert.ok(keys.has(key + '|flex_action_fast_path.js'),
    'untracked pending Flex journal ' + key);
  const paths = new Map(inventory.writerPathEvidence.map(e => [e.path + '|' + e.anchor, e]));
  for (const [file, anchor] of [
    ['flex_action_fast_path.js', 'storage.setItem(JOURNAL_KEY, JSON.stringify(normalized));'],
    ['flex_action_fast_path.js', 'storage.setItem(ORDER_JOURNAL_KEY, JSON.stringify(record));'],
    ['season_result_integrity_guard.js', "original.saveStateSnapshot(state, { immediateWrite: true, savePath: 'season-result-integrity-repair'"],
    ['storage_diagnostics_cleanup_controller.js', 'keys.forEach((key) => store.delete(key));'],
    ['storage_diagnostics_season_image_repair_controller.js', 'core.writeTaskPointsStoredState(nextState, {']
  ]) assert.ok(paths.has(file + '|' + anchor),
    'previously located legacy writer requires ownership before V2 cutover: ' + file);
});

test('M01 reviewed legacy entrypoints stay tracked and explicitly unfenced', () => {
  const reviewed = (inventory.reviewedSourceEvidence || [])
    .filter(row => row.auditPass === 'm01-legacy-entrypoints');
  const writers = (inventory.writerPathEvidence || [])
    .filter(row => row.auditPass === 'm01-legacy-entrypoints');
  assert.ok(reviewed.length >= 36);
  assert.ok(writers.length >= 26);
  for (const row of writers) {
    assert.equal(row.fencingStatus, 'not_proven');
    assert.equal(row.ownerStatus, 'awaiting_full_callgraph');
    assert.ok(reviewed.some(r => r.path === row.path),
      'legacy writer was not source inspected: ' + row.path);
  }
  for (const [file, needle] of [
    ['achievements.html', 'writeTaskPointsStoredState(nextState'],
    ['game_ratings.html', 'writeTaskPointsStoredState(parsed'],
    ['log.html', 'writeTaskPointsStoredState(merged'],
    ['trash.html', 'writeTaskPointsStoredState(nextState'],
    ['audit.html', 'season-repair-sync-results'],
    ['tournament.html', 'const saved = TaskPointsCore.saveStateSnapshot(nextState'],
    ['task_delete_fast_path.js', 'function taskDeleteFastPathSaveStateSnapshot']
  ]) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(code.includes(needle), 'high-risk V1 writer moved: ' + file);
    assert.ok(writers.some(w => w.path === file && w.anchor.includes(needle.slice(0, 18))),
      'legacy writer not added to inventory: ' + file);
  }
  for (const key of ['taskpoints_ratings_show_inactive',
    'taskpoints_rankings_scope_v1', 'taskpoints_rankings_scope_season4_rollover_v1']) {
    assert.ok(inventory.keyEvidence.some(row => row.key === key),
      'untracked auxiliary key: ' + key);
  }
  assert.equal(inventory.firstPassInspected.length, inventory.sourceFiles.length);
  assert.equal(inventory.writerOwnershipAudit.productionWritersFenced, false,
    'root source inspection does not satisfy migration/cutover');
});

test('M01 all root sources inspected without certifying live writer admission', () => {
  const inspected = inventory.firstPassInspected.slice().sort();
  const declared = inventory.sourceFiles.slice().sort();
  assert.deepEqual(inspected, declared, 'root source first-pass incomplete');
  const reviews = inventory.reviewedSourceEvidence || [];
  const finalRows = reviews.filter(r => r.auditPass === 'm01-final-root-source-pass');
  assert.equal(finalRows.length, 62, 'final root source review baseline changed');
  for(const row of finalRows) {
    assert.equal(row.ownerVerification, 'unverified');
    assert.ok(declared.includes(row.path), 'unknown reviewed source: ' + row.path);
    assert.ok(fs.readFileSync(path.join(root,row.path),'utf8').includes(row.anchor),
      'source-level evidence changed: ' + row.path);
  }
  const audit = inventory.writerOwnershipAudit;
  assert.equal(audit.firstPassRootInspectionComplete,true);
  assert.equal(audit.productionAuthority,'v1');
  assert.equal(audit.productionWritersFenced,false);
  assert.equal(audit.status,'incomplete');
  assert.equal(audit.sourceFilesInspected,declared.length);
  assert.ok(audit.unresolvedPassConditions.length>=5);
  for(const key of [
    'taskpoints_v2_pending_mutations_v1',
    'taskpoints_state_v2_generation_v1',
    'taskpoints_home_targeted_render_disabled_v1',
    'taskpoints_skills_level_config',
    'taskpoints_standings_scope_v1'
  ]) assert.ok(inventory.keyEvidence.some(e => e.key === key),
    'new auxiliary key cannot disappear: ' + key);
  for(const [file, fragment] of [
    ['skills.html', 'writeTaskPointsStoredState(nextState'],
    ['season_bracket_builder.js', 'saveStateSnapshot(nextState'],
    ['state_runtime_v2_wal.js', 'setWalStorageVerified(KEY'],
    ['state_v2_preview_cleanup.html', 'indexedDB.deleteDatabase(databases[index])'],
    ['verified_secondary_restore.html', 'taskpoints_emergency_recovery_hold_v1']
  ]) assert.ok(inventory.writerPathEvidence.some(e=>e.path===file && e.anchor.includes(fragment)),
    'critical V1/V2 writer route cannot be dropped: ' + file);
});
