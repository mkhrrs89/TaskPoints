from pathlib import Path

path = Path('phase4_storage_coordinator.js')
text = path.read_text()
old = "        snapshot: null,\n        phase2Snapshot,\n        phase2DualMetadata: dualMetadata,\n"
new = "        snapshot: null,\n        phase2Snapshot: dualSnapshot,\n        phase2DualMetadata: dualMetadata,\n"
if old not in text:
    raise SystemExit('Phase 4 alias block not found')
path.write_text(text.replace(old, new, 1))

# The Phase 5A contract still described the older monolithic _worker.js bundle.
# Current production splits that responsibility: _worker.js fingerprints the
# ordered asset list while _worker_core.js owns the guarded Phase 5A install.
test_path = Path('tests/phase5a_native_snapshot_contract.test.js')
test_text = test_path.read_text()
old_test = """test('worker loads Phase 5A only after the complete Phase 4 bundle and keeps generated navigation JavaScript valid', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /'\\/phase5a_native_snapshot\\.js'/);
  assert.match(worker, /completePhase5A/);
  assert.match(worker, /5a-native-indexeddb-snapshot/);
  assert.match(worker, /Phase 5A native snapshot failed to install; Phase 4 remains active/);
  assert.match(worker, /try \\{ result\\.set\\(name, Object\\.getOwnPropertyDescriptor\\(target, name\\) \\|\\| null\\); \\}/);
});
"""
new_test = """test('worker loads Phase 5A only after the complete Phase 4 bundle and keeps guarded install semantics', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  const workerCore = fs.readFileSync(path.join(__dirname, '..', '_worker_core.js'), 'utf8');
  const phase4Assets = [
    '/phase4_storage_coordinator.js',
    '/phase4_primary_read_path.js',
    '/indexeddb_requalification_guard.js',
    '/phase4_cache_guard.js',
    '/phase4_diagnostics.js'
  ];
  const phase5aIndex = worker.indexOf("'/phase5a_native_snapshot.js'");
  assert.ok(phase5aIndex >= 0, 'Phase 5A must remain in the versioned core asset list');
  phase4Assets.forEach((asset) => {
    const index = worker.indexOf(`'${asset}'`);
    assert.ok(index >= 0, `${asset} must remain in the versioned core asset list`);
    assert.ok(index < phase5aIndex, `${asset} must precede Phase 5A`);
  });
  const phase5bIndex = worker.indexOf("'/phase5b_deferred_mirror.js'");
  assert.ok(phase5bIndex > phase5aIndex, 'Phase 5A must still precede Phase 5B');
  assert.match(workerCore, /completePhase5A/);
  assert.match(workerCore, /5a-native-indexeddb-snapshot/);
  assert.match(workerCore, /Phase 5A native snapshot failed to install; Phase 4 remains active/);
  assert.match(workerCore, /try \\{ result\\.set\\(name, Object\\.getOwnPropertyDescriptor\\(target, name\\) \\|\\| null\\); \\}/);
});
"""
if old_test not in test_text:
    raise SystemExit('stale Phase 5A worker contract block not found')
test_path.write_text(test_text.replace(old_test, new_test, 1))
