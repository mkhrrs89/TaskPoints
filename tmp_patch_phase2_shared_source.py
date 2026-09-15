from pathlib import Path

path = Path('phase2_dual_write.js')
src = path.read_text()

src = src.replace(
"  const INTERNAL_DETACHED_SOURCE = Symbol('taskpointsPhase2DetachedSource');\n",
"  const INTERNAL_DETACHED_SOURCE = Symbol('taskpointsPhase2DetachedSource');\n  const INTERNAL_SOURCE_SUMMARY = Symbol('taskpointsPhase2SourceSummary');\n",
1,
)

src = src.replace(
"  let legacyRowWriteCount = 0;\n",
"  let legacyRowWriteCount = 0;\n  let sharedSourceReuseCount = 0;\n  let sharedSourceFallbackCount = 0;\n",
1,
)

clone_block = """  function cloneState(state) {
    sourceCloneCount += 1;
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
  }
"""
if clone_block not in src:
    raise SystemExit('cloneState block not found')
shared_helper = clone_block + """
  function exactSharedSourcePackage(raw) {
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
  }
"""
src = src.replace(clone_block, shared_helper, 1)

src = src.replace(
"      const sourceSummary = core.shadowSourceSummary(source);\n",
"""      const reusableSummary = options[INTERNAL_SOURCE_SUMMARY];
      const sourceSummary = reusableSummary?.hashes?.state
        ? reusableSummary
        : core.shadowSourceSummary(source);
""",
1,
)

old_source = """  function sourceFromLatestStoredRaw(capturedRaw) {
    try {
      const latestRaw = global.localStorage?.getItem?.(core.STORAGE_KEY);
      // A confirmed missing authoritative key represents an empty state. Never
      // fall back to an older captured payload, which could resurrect data
      // after Reset All in this page or another open TaskPoints tab.
      if (latestRaw === null) return { state: {}, raw: '{}' };
      if (typeof latestRaw === 'string') {
        return {
          state: latestRaw ? core.parseTaskPointsStorageJson(latestRaw, {}) : {},
          raw: latestRaw || '{}'
        };
      }
    } catch (_) {
      // If localStorage cannot be read, the captured successful setItem payload
      // is the safest fallback available for this single write.
    }
    const fallbackRaw = typeof capturedRaw === 'string' && capturedRaw ? capturedRaw : '{}';
    return {
      state: fallbackRaw === '{}' ? {} : core.parseTaskPointsStorageJson(fallbackRaw, {}),
      raw: fallbackRaw
    };
  }
"""
new_source = """  function sourceForExactRaw(raw) {
    const normalizedRaw = typeof raw === 'string' && raw ? raw : '{}';
    const shared = exactSharedSourcePackage(normalizedRaw);
    if (shared) {
      return {
        state: shared.state,
        raw: normalizedRaw,
        summary: shared.summary
      };
    }
    return {
      state: normalizedRaw === '{}' ? {} : core.parseTaskPointsStorageJson(normalizedRaw, {}),
      raw: normalizedRaw,
      summary: null
    };
  }

  function sourceFromLatestStoredRaw(capturedRaw) {
    try {
      const latestRaw = global.localStorage?.getItem?.(core.STORAGE_KEY);
      // A confirmed missing authoritative key represents an empty state. Never
      // fall back to an older captured payload, which could resurrect data
      // after Reset All in this page or another open TaskPoints tab.
      if (latestRaw === null) return { state: {}, raw: '{}', summary: null };
      if (typeof latestRaw === 'string') return sourceForExactRaw(latestRaw);
    } catch (_) {
      // If localStorage cannot be read, the captured successful setItem payload
      // is the safest fallback available for this single write.
    }
    return sourceForExactRaw(capturedRaw);
  }
"""
if old_source not in src:
    raise SystemExit('sourceFromLatestStoredRaw block not found')
src = src.replace(old_source, new_source, 1)

old_resolved = """        const resolved = snapshot
          ? { state: snapshot, raw: null }
          : sourceFromLatestStoredRaw(options.serializedCandidate);
"""
new_resolved = """        const resolved = snapshot
          ? { state: snapshot, raw: null, summary: null }
          : sourceFromLatestStoredRaw(options.serializedCandidate);
"""
if old_resolved not in src:
    raise SystemExit('queue resolved block not found')
src = src.replace(old_resolved, new_resolved, 1)

src = src.replace(
"""          serializedSourceRaw: resolved.raw,
          [INTERNAL_DETACHED_SOURCE]: true
""",
"""          serializedSourceRaw: resolved.raw,
          [INTERNAL_SOURCE_SUMMARY]: resolved.summary,
          [INTERNAL_DETACHED_SOURCE]: true
""",
1,
)

src = src.replace(
"""    metadataSnapshotWriteCount,
    legacyRowWriteCount
  });
""",
"""    metadataSnapshotWriteCount,
    legacyRowWriteCount,
    sharedSourceReuseCount,
    sharedSourceFallbackCount
  });
""",
1,
)

path.write_text(src)

# Add a regression that proves source-side work is reused while IndexedDB
# readback verification remains independent.
test_path = Path('tests/phase2_dual_write.test.js')
test_src = test_path.read_text()
append = """

test('coalesced authoritative write reuses an exact shared source package but still parses the IndexedDB readback', async () => {
  localRows.clear();
  const idb = createFakeIndexedDb({ strictTransactions: true });
  global.indexedDB = idb;
  await seedVerifiedShadow(idb);

  const state = fixture(31);
  const raw = JSON.stringify(state);
  const sharedState = structuredClone(state);
  const sharedSummary = core.shadowSourceSummary(sharedState);
  const originalPackage = core.getSharedSaveSourcePackage;
  const originalParse = core.parseTaskPointsStorageJson;
  let packageCalls = 0;
  let parseCalls = 0;

  try {
    core.getSharedSaveSourcePackage = (candidateRaw) => {
      packageCalls += 1;
      if (candidateRaw !== raw) return null;
      return {
        raw,
        state: sharedState,
        summary: sharedSummary,
        sourceKind: 'recent_exact_parse'
      };
    };
    core.parseTaskPointsStorageJson = (...args) => {
      parseCalls += 1;
      return originalParse(...args);
    };

    const before = core.getShadowDualWriteQueueStatus();
    global.localStorage.setItem(core.STORAGE_KEY, raw);
    await core.flushShadowDualWrites();
    const after = core.getShadowDualWriteQueueStatus();

    assert.ok(packageCalls >= 1);
    assert.equal(after.sharedSourceReuseCount - before.sharedSourceReuseCount, 1);
    assert.equal(after.sharedSourceFallbackCount - before.sharedSourceFallbackCount, 0);
    assert.equal(parseCalls, 1,
      'the shared package should remove the source parse while the IndexedDB readback remains independently parsed');
    const status = await core.getShadowDualWriteStatus({ indexedDB: idb });
    assert.equal(status.status, 'passed_verification', JSON.stringify(status));
    assert.equal(status.verification.hashesMatch, true);
    assert.equal(status.verification.rawMatches, true);
  } finally {
    core.getSharedSaveSourcePackage = originalPackage;
    core.parseTaskPointsStorageJson = originalParse;
  }
});
"""
if "coalesced authoritative write reuses an exact shared source package" in test_src:
    raise SystemExit('shared source regression already present')
test_path.write_text(test_src + append)
