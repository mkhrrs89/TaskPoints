from pathlib import Path

path = Path('phase2_dual_write.js')
src = path.read_text()

src = src.replace(
"  const HOME_LONG_QUIET_MS = 8000;\n",
"  const HOME_LONG_QUIET_MS = 8000;\n  const INTERNAL_DETACHED_SOURCE = Symbol('taskpointsPhase2DetachedSource');\n",
1,
)
src = src.replace(
"  let homeLongQuietDeferred = false;\n",
"  let homeLongQuietDeferred = false;\n  let sourceCloneCount = 0;\n  let detachedSourceReuseCount = 0;\n",
1,
)
src = src.replace(
"""  function cloneState(state) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
  }
""",
"""  function cloneState(state) {
    sourceCloneCount += 1;
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
  }
""",
1,
)
old = """  async function writeSnapshot(state, options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const source = cloneState(state && typeof state === 'object' ? state : {});
    const startedAt = new Date().toISOString();
"""
new = """  async function writeSnapshot(state, options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const sourceInput = state && typeof state === 'object' ? state : {};
    const source = options[INTERNAL_DETACHED_SOURCE] === true
      ? (detachedSourceReuseCount += 1, sourceInput)
      : cloneState(sourceInput);
    const startedAt = new Date().toISOString();
"""
if old not in src:
    raise SystemExit('writeSnapshot source block not found')
src = src.replace(old, new, 1)
old = """        const source = snapshot || stateFromLatestStoredRaw(options.serializedCandidate);
        return writeSnapshot(source, { ...options, sequence: writeSequence });
"""
new = """        const source = snapshot || stateFromLatestStoredRaw(options.serializedCandidate);
        // Both branches above are already detached from caller-owned/live state:
        // `snapshot` was cloned when queued, while the raw path was freshly parsed.
        // Reuse that private snapshot instead of cloning the entire multi-megabyte
        // state a second time immediately before the shadow write.
        return writeSnapshot(source, {
          ...options,
          sequence: writeSequence,
          [INTERNAL_DETACHED_SOURCE]: true
        });
"""
if old not in src:
    raise SystemExit('queueWrite block not found')
src = src.replace(old, new, 1)
old = """    homeLongQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
    homeLongQuietDeferred
  });
"""
new = """    homeLongQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
    homeLongQuietDeferred,
    sourceCloneCount,
    detachedSourceReuseCount
  });
"""
if old not in src:
    raise SystemExit('status block not found')
src = src.replace(old, new, 1)
path.write_text(src)

test_path = Path('tests/phase2_dual_write.test.js')
test = test_path.read_text()
append = r'''

test('coalesced authoritative raw reuses its detached parsed state instead of cloning the full snapshot again', async () => {
  localRows.clear();
  const idb = createFakeIndexedDb({ strictTransactions: true });
  global.indexedDB = idb;
  await seedVerifiedShadow(idb);

  const before = core.getShadowDualWriteQueueStatus();
  const state = fixture(21);
  const raw = JSON.stringify(state);
  global.localStorage.setItem(core.STORAGE_KEY, raw);
  await core.flushShadowDualWrites();
  const after = core.getShadowDualWriteQueueStatus();

  assert.equal(after.sourceCloneCount - before.sourceCloneCount, 0,
    'the freshly parsed coalesced authoritative snapshot is already detached and should not be cloned again');
  assert.equal(after.detachedSourceReuseCount - before.detachedSourceReuseCount, 1);
  assert.equal(global.localStorage.getItem(core.STORAGE_KEY), raw);

  const status = await core.getShadowDualWriteStatus({ indexedDB: idb });
  assert.equal(status.status, 'passed_verification', JSON.stringify(status));
  assert.equal(status.verification.countsMatch, true);
  assert.equal(status.verification.hashesMatch, true);
});

test('public direct shadow snapshot writes still defensively clone caller-owned state', async () => {
  const idb = createFakeIndexedDb({ strictTransactions: true });
  await seedVerifiedShadow(idb);
  const before = core.getShadowDualWriteQueueStatus();
  const state = fixture(22);
  const result = await core.writeShadowDualWriteSnapshot(state, { indexedDB: idb });
  const after = core.getShadowDualWriteQueueStatus();

  assert.equal(result.status, 'passed_verification', JSON.stringify(result));
  assert.equal(after.sourceCloneCount - before.sourceCloneCount, 1,
    'public direct writes must preserve the defensive clone boundary');
  assert.equal(after.detachedSourceReuseCount - before.detachedSourceReuseCount, 0);
});
'''
test_path.write_text(test + append)
