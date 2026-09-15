from pathlib import Path

shared_path = Path('save_pipeline_shared_work.js')
shared = shared_path.read_text()
shared = shared.replace(
"  let clonePropagationCount = 0;\n",
"  let clonePropagationCount = 0;\n  let sourcePackageReuseCount = 0;\n  let sourcePackageMissCount = 0;\n",
1,
)
marker = """  core.clearSharedSaveWork = function clearSharedSaveWork() {
    recentParse = null;
  };
"""
insert = """  core.getSharedSaveSourcePackage = function getSharedSaveSourcePackage(raw = null) {
    const targetRaw = typeof raw === 'string'
      ? raw
      : (() => {
          try { return global.localStorage?.getItem?.(core.STORAGE_KEY) ?? null; }
          catch (_) { return null; }
        })();

    const verified = core.getSharedVerifiedSavePackage?.(targetRaw);
    if (verified) {
      sourcePackageReuseCount += 1;
      return { ...verified, sourceKind: 'verified_primary' };
    }

    if (typeof targetRaw === 'string'
      && targetRaw
      && recentParse
      && recentParse.raw === targetRaw
      && recentParse.snapshot
      && recentParse.summary
      && pendingJournalCount() === 0) {
      sourcePackageReuseCount += 1;
      return {
        schemaVersion: 1,
        sequence: 0,
        raw: targetRaw,
        state: recentParse.snapshot,
        summary: recentParse.summary,
        mirrorHash: null,
        verifiedAt: null,
        status: 'exact_source_parse',
        sourceKind: 'recent_exact_parse'
      };
    }

    sourcePackageMissCount += 1;
    return null;
  };

""" + marker
if marker not in shared:
    raise SystemExit('shared clear marker not found')
shared = shared.replace(marker, insert, 1)
shared = shared.replace(
"""    clonePropagationCount,
    recentRawPresent: Boolean(recentParse?.raw),
""",
"""    clonePropagationCount,
    sourcePackageReuseCount,
    sourcePackageMissCount,
    recentRawPresent: Boolean(recentParse?.raw),
""",
1,
)
shared_path.write_text(shared)

phase5_path = Path('phase5b_deferred_mirror.js')
phase5 = phase5_path.read_text()
phase5 = phase5.replace(
"  let homeLongQuietTimer = 0;\n",
"  let homeLongQuietTimer = 0;\n  let sharedSourceReuseCount = 0;\n  let sharedSourceFallbackCount = 0;\n",
1,
)
parse_marker = """  const parse = (raw) => typeof core.parseTaskPointsStorageJson === 'function'
    ? core.parseTaskPointsStorageJson(raw, null)
    : JSON.parse(raw);
"""
parse_insert = parse_marker + """  const sharedSourcePackage = (raw) => {
    try {
      const sourcePackage = core.getSharedSaveSourcePackage?.(raw);
      if (sourcePackage
        && sourcePackage.raw === raw
        && sourcePackage.state
        && typeof sourcePackage.state === 'object'
        && !Array.isArray(sourcePackage.state)
        && sourcePackage.summary?.hashes?.state) {
        sharedSourceReuseCount += 1;
        return sourcePackage;
      }
    } catch (_) {}
    sharedSourceFallbackCount += 1;
    return null;
  };
"""
if parse_marker not in phase5:
    raise SystemExit('phase5 parse marker not found')
phase5 = phase5.replace(parse_marker, parse_insert, 1)
old_source = """      const state = parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('secondary_unreadable');
      const sourceCounts = counts(state);
      const sourceFingerprint = fingerprint(raw);
      const sourceStateHash = stateHash(state);
"""
new_source = """      // Reuse an exact source parse/hash already produced by an earlier backup
      // layer when available. The IndexedDB readback below is still parsed and
      // hashed independently, so secondary verification remains independent.
      const sharedSource = sharedSourcePackage(raw);
      const state = sharedSource?.state || parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('secondary_unreadable');
      const sourceCounts = counts(state);
      const sourceFingerprint = fingerprint(raw);
      const sourceStateHash = sharedSource?.summary?.hashes?.state || stateHash(state);
"""
if old_source not in phase5:
    raise SystemExit('phase5 source block not found')
phase5 = phase5.replace(old_source, new_source, 1)
phase5 = phase5.replace(
"""      homeLongQuietEnabled,
      homeLongQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
      homeLongQuietDeferred
""",
"""      homeLongQuietEnabled,
      homeLongQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
      homeLongQuietDeferred,
      sharedSourceReuseCount,
      sharedSourceFallbackCount
""",
1,
)
phase5_path.write_text(phase5)

shared_test_path = Path('tests/save_pipeline_shared_work_contract.test.js')
shared_test = shared_test_path.read_text()
shared_test += r'''

test('exact recent parse and summary can be reused as a read-only source package without reparsing', () => {
  const harness = install({ cacheEnabled: false });
  const parsed = harness.core.parseTaskPointsStorageJson(harness.raw, {});
  const summary = harness.core.shadowSourceSummary(parsed);
  const beforeParseCalls = harness.parseCalls();
  const beforeSummaryCalls = harness.summaryCalls();

  const sourcePackage = harness.core.getSharedSaveSourcePackage(harness.raw);
  assert.equal(sourcePackage.sourceKind, 'recent_exact_parse');
  assert.equal(sourcePackage.raw, harness.raw);
  assert.deepEqual(sourcePackage.state, parsed);
  assert.notEqual(sourcePackage.state, parsed, 'the shared package owns the private detached snapshot, not the caller object');
  assert.equal(sourcePackage.summary.hashes.state, summary.hashes.state);
  assert.equal(harness.parseCalls(), beforeParseCalls);
  assert.equal(harness.summaryCalls(), beforeSummaryCalls);
  assert.equal(harness.core.getSharedSaveWorkStatus().sourcePackageReuseCount, 1);
});
'''
shared_test_path.write_text(shared_test)

phase5_test_path = Path('tests/phase5c_verified_secondary_contract.test.js')
phase5_test = phase5_test_path.read_text()
phase5_test = phase5_test.replace('function install() {', 'function install(options = {}) {', 1)
phase5_test = phase5_test.replace(
"  let loadCalls = 0;\n  const core = {\n",
"  let loadCalls = 0;\n  let parseCalls = 0;\n  const core = {\n",
1,
)
phase5_test = phase5_test.replace(
"    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },\n",
"    parseTaskPointsStorageJson(raw, fallback) { parseCalls += 1; try { return JSON.parse(raw); } catch (_) { return fallback; } },\n",
1,
)
phase5_test = phase5_test.replace(
"""    loadAppState() { loadCalls += 1; return {}; }
  };
""",
"""    loadAppState() { loadCalls += 1; return {}; }
  };
  if (typeof options.getSharedSaveSourcePackage === 'function') {
    core.getSharedSaveSourcePackage = options.getSharedSaveSourcePackage;
  }
""",
1,
)
phase5_test = phase5_test.replace(
"  return { core, localStorage, indexedDB, loadCalls: () => loadCalls };\n",
"  return { core, localStorage, indexedDB, loadCalls: () => loadCalls, parseCalls: () => parseCalls };\n",
1,
)
phase5_test += r'''

test('reuses an exact shared source package while still parsing the IndexedDB readback independently', async () => {
  const sourceState = makeState('shared-source');
  const raw = JSON.stringify(sourceState);
  let packageCalls = 0;
  const harness = install({
    getSharedSaveSourcePackage(candidateRaw) {
      packageCalls += 1;
      if (candidateRaw !== raw) return null;
      return {
        raw,
        state: sourceState,
        summary: summary(sourceState),
        sourceKind: 'recent_exact_parse'
      };
    }
  });

  const beforeParseCalls = harness.parseCalls();
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase5CVerifiedSecondaryWrites();
  const parseDelta = harness.parseCalls() - beforeParseCalls;

  assert.ok(packageCalls >= 1);
  assert.equal(parseDelta, 1,
    'the source parse should be reused, but the IndexedDB candidate readback must still be independently parsed');
  const latest = harness.indexedDB.read(DB_NAME, 'latest');
  assert.equal(latest.raw, raw);
  assert.equal(latest.status, 'passed_verification');
  const status = harness.core.getPhase5CVerifiedSecondaryStatus();
  assert.ok(status.sharedSourceReuseCount >= 1);
  assert.equal(status.lastStatus, 'passed_verification');
});
'''
phase5_test_path.write_text(phase5_test)
