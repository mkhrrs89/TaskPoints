from pathlib import Path

# ---------------- Phase 2: write one verified metadata snapshot ----------------
path = Path('phase2_dual_write.js')
src = path.read_text()

src = src.replace(
"  const METADATA_ID = 'dual_write';\n",
"  const METADATA_ID = 'dual_write';\n  const SNAPSHOT_ID = 'phase2_dual_write_snapshot';\n  const SNAPSHOT_FORMAT = 'metadata_raw_v1';\n",
1,
)

# Add request counters so the performance change is observable.
src = src.replace(
"  let detachedSourceReuseCount = 0;\n",
"  let detachedSourceReuseCount = 0;\n  let metadataSnapshotWriteCount = 0;\n  let legacyRowWriteCount = 0;\n",
1,
)

insert_after_readstores = """  async function readStores(db) {
    const stores = [...ARRAY_STORES, 'collections', 'values'];
    const tx = db.transaction(stores, 'readonly');

    // Create every request before the first await so Safari cannot deactivate
    // the transaction between asynchronous continuations.
    const arrayReads = Object.fromEntries(ARRAY_STORES.map((field) => [
      field,
      requestPromise(tx.objectStore(field).getAll())
    ]));
    const collectionRead = requestPromise(tx.objectStore('collections').getAll());
    const valuesRead = requestPromise(tx.objectStore('values').getAll());
    const [arrayRows, collectionRows, valuesRows] = await Promise.all([
      Promise.all(ARRAY_STORES.map((field) => arrayReads[field])),
      collectionRead,
      valuesRead
    ]);

    const rebuilt = {};
    ARRAY_STORES.forEach((field, index) => {
      rebuilt[field] = arrayRows[index]
        .sort((a, b) => a.key - b.key)
        .map((row) => row.value);
    });
    collectionRows
      .filter((row) => row.kind === 'manifest')
      .forEach((row) => { rebuilt[row.field] = []; });
    collectionRows
      .filter((row) => row.kind === 'item')
      .forEach((row) => { (rebuilt[row.field] ||= [])[row.index] = row.value; });
    valuesRows.forEach((row) => { rebuilt[row.field] = row.value; });
    return rebuilt;
  }
"""
if insert_after_readstores not in src:
    raise SystemExit('Phase 2 readStores block not found')
metadata_helpers = insert_after_readstores + """
  async function writeMetadataSnapshotCandidate(db, serializedState, sourceSummary, startedAt, writeSequence) {
    const snapshot = {
      id: SNAPSHOT_ID,
      schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
      phase: 'dual_write',
      snapshotFormat: SNAPSHOT_FORMAT,
      status: 'candidate_written',
      sequence: writeSequence,
      startedAt,
      completionTime: null,
      serializedState,
      stateHash: sourceSummary.hashes.state,
      sourceCounts: sourceSummary.counts,
      errors: []
    };
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({
      id: METADATA_ID,
      schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
      phase: 'dual_write',
      status: 'running',
      startedAt,
      completionTime: null,
      sequence: writeSequence,
      snapshotId: SNAPSHOT_ID,
      snapshotFormat: SNAPSHOT_FORMAT,
      errors: [],
      sourceCounts: sourceSummary.counts,
      destinationCounts: {},
      verification: null
    });
    tx.objectStore('metadata').put(snapshot);
    metadataSnapshotWriteCount += 1;
    await transactionPromise(tx);
    return snapshot;
  }

  async function readMetadataSnapshot(db) {
    const tx = db.transaction('metadata', 'readonly');
    return (await requestPromise(tx.objectStore('metadata').get(SNAPSHOT_ID))) || null;
  }

  async function finalizeMetadataSnapshot(db, snapshot, metadata) {
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({
      ...snapshot,
      status: metadata.status,
      completionTime: metadata.completionTime,
      errors: metadata.errors || []
    });
    tx.objectStore('metadata').put({ id: METADATA_ID, ...metadata });
    await transactionPromise(tx);
  }
"""
src = src.replace(insert_after_readstores, metadata_helpers, 1)

# Replace the expensive row-write/readback section with one raw metadata snapshot + independent parse verification.
old_write_body = """      const sourceSummary = core.shadowSourceSummary(source);
      await putMetadata(db, METADATA_ID, {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status: 'running',
        startedAt,
        completionTime: null,
        sequence: writeSequence,
        errors: [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: {},
        verification: null
      });

      await writeStores(db, source);
      const rebuilt = await readStores(db);
      const destinationSummary = core.shadowSourceSummary(rebuilt);
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const status = countsMatch && hashesMatch ? 'passed_verification' : 'failed';
      const metadata = {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status,
        startedAt,
        completionTime: new Date().toISOString(),
        sequence: writeSequence,
        errors: status === 'failed' ? ['Dual-write verification did not pass.'] : [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        verification: {
          countsMatch,
          hashesMatch,
          source: {
            counts: sourceSummary.counts,
            hashes: sourceSummary.hashes,
            hashDetails: sourceSummary.hashDetails
          },
          destination: {
            counts: destinationSummary.counts,
            hashes: destinationSummary.hashes,
            hashDetails: destinationSummary.hashDetails
          },
          mismatches
        }
      };
      await putMetadata(db, METADATA_ID, metadata);
      return metadata;
"""
new_write_body = """      const sourceSummary = core.shadowSourceSummary(source);
      const serializedState = typeof options.serializedSourceRaw === 'string'
        ? options.serializedSourceRaw
        : JSON.stringify(source);
      const snapshotCandidate = await writeMetadataSnapshotCandidate(
        db,
        serializedState,
        sourceSummary,
        startedAt,
        writeSequence
      );
      const readBack = await readMetadataSnapshot(db);
      if (!readBack
        || readBack.snapshotFormat !== SNAPSHOT_FORMAT
        || typeof readBack.serializedState !== 'string'
        || Number(readBack.sequence) !== writeSequence) {
        throw new Error('dual_write_snapshot_readback_missing');
      }
      const rebuilt = core.parseTaskPointsStorageJson(readBack.serializedState, null);
      if (!rebuilt || typeof rebuilt !== 'object' || Array.isArray(rebuilt)) {
        throw new Error('dual_write_snapshot_readback_unreadable');
      }
      const destinationSummary = core.shadowSourceSummary(rebuilt);
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const rawMatches = readBack.serializedState === serializedState;
      const status = countsMatch && hashesMatch && rawMatches ? 'passed_verification' : 'failed';
      const metadata = {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status,
        startedAt,
        completionTime: new Date().toISOString(),
        sequence: writeSequence,
        snapshotId: SNAPSHOT_ID,
        snapshotFormat: SNAPSHOT_FORMAT,
        errors: status === 'failed' ? ['Dual-write verification did not pass.'] : [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        verification: {
          countsMatch,
          hashesMatch,
          rawMatches,
          source: {
            counts: sourceSummary.counts,
            hashes: sourceSummary.hashes,
            hashDetails: sourceSummary.hashDetails
          },
          destination: {
            counts: destinationSummary.counts,
            hashes: destinationSummary.hashes,
            hashDetails: destinationSummary.hashDetails
          },
          mismatches
        }
      };
      await finalizeMetadataSnapshot(db, snapshotCandidate, metadata);
      return metadata;
"""
if old_write_body not in src:
    raise SystemExit('Phase 2 write body not found')
src = src.replace(old_write_body, new_write_body, 1)

# Return both parsed state and the exact current authoritative raw so the snapshot keeps exact bytes.
old_state_reader = """  function stateFromLatestStoredRaw(capturedRaw) {
    try {
      const latestRaw = global.localStorage?.getItem?.(core.STORAGE_KEY);
      // A confirmed missing authoritative key represents an empty state. Never
      // fall back to an older captured payload, which could resurrect data
      // after Reset All in this page or another open TaskPoints tab.
      if (latestRaw === null) return {};
      if (typeof latestRaw === 'string') {
        return latestRaw ? core.parseTaskPointsStorageJson(latestRaw, {}) : {};
      }
    } catch (_) {
      // If localStorage cannot be read, the captured successful setItem payload
      // is the safest fallback available for this single write.
    }
    return capturedRaw ? core.parseTaskPointsStorageJson(capturedRaw, {}) : {};
  }
"""
new_state_reader = """  function sourceFromLatestStoredRaw(capturedRaw) {
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
if old_state_reader not in src:
    raise SystemExit('Phase 2 stateFromLatestStoredRaw block not found')
src = src.replace(old_state_reader, new_state_reader, 1)

old_queue = """      .then(() => {
        const source = snapshot || stateFromLatestStoredRaw(options.serializedCandidate);
        // Both branches above are already detached from caller-owned/live state:
        // `snapshot` was cloned when queued, while the raw path was freshly parsed.
        // Reuse that private snapshot instead of cloning the entire multi-megabyte
        // state a second time immediately before the shadow write.
        return writeSnapshot(source, {
          ...options,
          sequence: writeSequence,
          [INTERNAL_DETACHED_SOURCE]: true
        });
      })
"""
new_queue = """      .then(() => {
        const resolved = snapshot
          ? { state: snapshot, raw: null }
          : sourceFromLatestStoredRaw(options.serializedCandidate);
        // Both branches above are already detached from caller-owned/live state:
        // `snapshot` was cloned when queued, while the raw path was freshly parsed.
        // Reuse that private snapshot instead of cloning the entire multi-megabyte
        // state a second time immediately before the shadow write.
        return writeSnapshot(resolved.state, {
          ...options,
          sequence: writeSequence,
          serializedSourceRaw: resolved.raw,
          [INTERNAL_DETACHED_SOURCE]: true
        });
      })
"""
if old_queue not in src:
    raise SystemExit('Phase 2 queue block not found')
src = src.replace(old_queue, new_queue, 1)

src = src.replace(
"  core.SHADOW_DUAL_WRITE_METADATA_ID = METADATA_ID;\n",
"  core.SHADOW_DUAL_WRITE_METADATA_ID = METADATA_ID;\n  core.SHADOW_DUAL_WRITE_SNAPSHOT_ID = SNAPSHOT_ID;\n  core.SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT = SNAPSHOT_FORMAT;\n",
1,
)
src = src.replace(
"""    sourceCloneCount,
    detachedSourceReuseCount
  });
""",
"""    sourceCloneCount,
    detachedSourceReuseCount,
    metadataSnapshotWriteCount,
    legacyRowWriteCount
  });
""",
1,
)
path.write_text(src)

# ---------------- Phase 3: prefer the new snapshot, keep legacy row fallback ----------------
path = Path('phase3_read_path.js')
src = path.read_text()
src = src.replace(
"  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];\n",
"  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];\n  const DUAL_SNAPSHOT_ID = core.SHADOW_DUAL_WRITE_SNAPSHOT_ID || 'phase2_dual_write_snapshot';\n  const DUAL_SNAPSHOT_FORMAT = core.SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT || 'metadata_raw_v1';\n",
1,
)

start = src.index('  async function readShadowSnapshot(indexedDb = global.indexedDB) {')
end = src.index('\n  function summariesMatch(', start)
old = src[start:end]
new = """  async function readLegacyShadowSnapshot(db, currentMetadata, dualWriteMetadata) {
    const requiredStores = [...ARRAY_STORES, 'collections', 'values'];
    const missing = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
    if (missing.length) throw new Error(`shadow_store_missing:${missing.join(',')}`);

    const tx = db.transaction(requiredStores, 'readonly');
    const arrayRequests = ARRAY_STORES.map((field) => requestPromise(tx.objectStore(field).getAll()));
    const collectionRequest = requestPromise(tx.objectStore('collections').getAll());
    const valuesRequest = requestPromise(tx.objectStore('values').getAll());
    const [arrayRows, collectionRows, valuesRows] = await Promise.all([
      Promise.all(arrayRequests),
      collectionRequest,
      valuesRequest
    ]);

    const state = {};
    ARRAY_STORES.forEach((field, index) => {
      state[field] = (arrayRows[index] || [])
        .slice()
        .sort((a, b) => Number(a.key) - Number(b.key))
        .map((row) => row.value);
    });
    (collectionRows || [])
      .filter((row) => row?.kind === 'manifest' && typeof row.field === 'string')
      .forEach((row) => { state[row.field] = []; });
    (collectionRows || [])
      .filter((row) => row?.kind === 'item' && typeof row.field === 'string')
      .sort((a, b) => String(a.field).localeCompare(String(b.field)) || Number(a.index) - Number(b.index))
      .forEach((row) => { (state[row.field] ||= [])[Number(row.index)] = row.value; });
    (valuesRows || []).forEach((row) => {
      if (row && typeof row.field === 'string') state[row.field] = row.value;
    });

    return {
      state,
      currentMetadata: currentMetadata || null,
      dualWriteMetadata: dualWriteMetadata || null,
      dualSnapshotMetadata: null,
      snapshotFormat: 'legacy_rows_v1'
    };
  }

  async function readShadowSnapshot(indexedDb = global.indexedDB) {
    const db = await openExistingShadowDb(indexedDb);
    try {
      if (!db.objectStoreNames.contains('metadata')) throw new Error('shadow_store_missing:metadata');
      const metadataTx = db.transaction('metadata', 'readonly');
      const currentMetadataRequest = requestPromise(metadataTx.objectStore('metadata').get('current'));
      const dualWriteMetadataRequest = requestPromise(metadataTx.objectStore('metadata').get(core.SHADOW_DUAL_WRITE_METADATA_ID || 'dual_write'));
      const dualSnapshotRequest = requestPromise(metadataTx.objectStore('metadata').get(DUAL_SNAPSHOT_ID));
      const [currentMetadata, dualWriteMetadata, dualSnapshotMetadata] = await Promise.all([
        currentMetadataRequest,
        dualWriteMetadataRequest,
        dualSnapshotRequest
      ]);

      if (dualSnapshotMetadata) {
        const validSnapshot = dualSnapshotMetadata.snapshotFormat === DUAL_SNAPSHOT_FORMAT
          && dualSnapshotMetadata.status === 'passed_verification'
          && typeof dualSnapshotMetadata.serializedState === 'string'
          && dualWriteMetadata?.status === 'passed_verification'
          && Number(dualSnapshotMetadata.sequence) === Number(dualWriteMetadata.sequence);
        if (!validSnapshot) throw new Error('dual_write_not_verified');
        const state = core.parseTaskPointsStorageJson(dualSnapshotMetadata.serializedState, null);
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('dual_write_not_verified');
        return {
          state,
          currentMetadata: currentMetadata || null,
          dualWriteMetadata: dualWriteMetadata || null,
          dualSnapshotMetadata,
          snapshotFormat: DUAL_SNAPSHOT_FORMAT
        };
      }

      return await readLegacyShadowSnapshot(db, currentMetadata, dualWriteMetadata);
    } finally {
      db.close?.();
    }
  }
"""
src = src[:start] + new + src[end:]

# Add snapshot state-hash verification after destination summary is computed.
needle = """        const destinationSummary = core.shadowSourceSummary(snapshot.state);
        const comparison = summariesMatch(authoritativeState, snapshot.state, sourceSummary, destinationSummary);
"""
replace = """        const destinationSummary = core.shadowSourceSummary(snapshot.state);
        if (snapshot.dualSnapshotMetadata?.stateHash
          && snapshot.dualSnapshotMetadata.stateHash !== destinationSummary.hashes.state) {
          throw new Error('dual_write_hash_mismatch');
        }
        const comparison = summariesMatch(authoritativeState, snapshot.state, sourceSummary, destinationSummary);
"""
if needle not in src:
    raise SystemExit('Phase 3 destination summary block not found')
src = src.replace(needle, replace, 1)
path.write_text(src)

# ---------------- Phase 4: use Phase 2 metadata snapshot before stale legacy rows ----------------
path = Path('phase4_storage_coordinator.js')
src = path.read_text()
src = src.replace(
"  const PRIMARY_COMMIT_ID = 'phase4_primary_commit';\n",
"  const PRIMARY_COMMIT_ID = 'phase4_primary_commit';\n  const DUAL_SNAPSHOT_ID = core.SHADOW_DUAL_WRITE_SNAPSHOT_ID || 'phase2_dual_write_snapshot';\n  const DUAL_SNAPSHOT_FORMAT = core.SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT || 'metadata_raw_v1';\n",
1,
)
old_readstate = """  async function readState(db) {
    const tx = db.transaction('metadata', 'readonly');
    const snapshotRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_SNAPSHOT_ID));
    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const primaryCommitRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_COMMIT_ID));
    const [snapshot, candidate, primaryCommit] = await Promise.all([
      snapshotRequest, candidateRequest, primaryCommitRequest
    ]);
    if (snapshot?.serializedState && typeof snapshot.serializedState === 'string') {
      let state;
      try { state = core.parseTaskPointsStorageJson(snapshot.serializedState, {}) || {}; }
      catch (error) { throw storageError('primary_snapshot_parse_failed', error); }
      return {
        state,
        candidate: candidate || null,
        primaryCommit: primaryCommit || null,
        snapshot,
        snapshotFormat: 'metadata_raw_v1'
      };
    }
    return readLegacyState(db, candidate, primaryCommit);
  }
"""
new_readstate = """  async function readState(db) {
    const tx = db.transaction('metadata', 'readonly');
    const snapshotRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_SNAPSHOT_ID));
    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const primaryCommitRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_COMMIT_ID));
    const dualSnapshotRequest = requestPromise(tx.objectStore('metadata').get(DUAL_SNAPSHOT_ID));
    const dualMetadataRequest = requestPromise(tx.objectStore('metadata').get(core.SHADOW_DUAL_WRITE_METADATA_ID || 'dual_write'));
    const [snapshot, candidate, primaryCommit, dualSnapshot, dualMetadata] = await Promise.all([
      snapshotRequest, candidateRequest, primaryCommitRequest, dualSnapshotRequest, dualMetadataRequest
    ]);
    if (snapshot?.serializedState && typeof snapshot.serializedState === 'string') {
      let state;
      try { state = core.parseTaskPointsStorageJson(snapshot.serializedState, {}) || {}; }
      catch (error) { throw storageError('primary_snapshot_parse_failed', error); }
      return {
        state,
        candidate: candidate || null,
        primaryCommit: primaryCommit || null,
        snapshot,
        snapshotFormat: 'metadata_raw_v1'
      };
    }
    const phase2SnapshotCurrent = dualSnapshot?.snapshotFormat === DUAL_SNAPSHOT_FORMAT
      && dualSnapshot.status === 'passed_verification'
      && typeof dualSnapshot.serializedState === 'string'
      && dualMetadata?.status === 'passed_verification'
      && Number(dualSnapshot.sequence) === Number(dualMetadata.sequence);
    if (phase2SnapshotCurrent) {
      let state;
      try { state = core.parseTaskPointsStorageJson(dualSnapshot.serializedState, {}) || {}; }
      catch (error) { throw storageError('phase2_snapshot_parse_failed', error); }
      return {
        state,
        candidate: candidate || null,
        primaryCommit: primaryCommit || null,
        snapshot: null,
        phase2Snapshot,
        phase2DualMetadata: dualMetadata,
        snapshotFormat: 'phase2_metadata_raw_v1'
      };
    }
    return readLegacyState(db, candidate, primaryCommit);
  }
"""
if old_readstate not in src:
    raise SystemExit('Phase 4 readState block not found')
src = src.replace(old_readstate, new_readstate, 1)

needle = """      if (rebuilt.snapshot) {
        if (Number(rebuilt.snapshot.sequence) !== Number(commit.sequence)) throw new Error('committed_snapshot_sequence_mismatch');
        if (rebuilt.snapshot.mirrorHash && rebuilt.snapshot.mirrorHash !== hashValue(rawBefore)) throw new Error('committed_snapshot_mirror_mismatch');
        if (rebuilt.snapshot.stateHash && rebuilt.snapshot.stateHash !== destinationSummary.hashes.state) throw new Error('committed_snapshot_hash_mismatch');
      }
"""
replace = needle + """      if (rebuilt.phase2Snapshot) {
        if (rebuilt.phase2Snapshot.stateHash && rebuilt.phase2Snapshot.stateHash !== destinationSummary.hashes.state) {
          throw new Error('phase2_snapshot_hash_mismatch');
        }
        const phase2SourceHash = rebuilt.phase2DualMetadata?.verification?.source?.hashes?.state;
        const phase2DestinationHash = rebuilt.phase2DualMetadata?.verification?.destination?.hashes?.state;
        if (phase2SourceHash && phase2SourceHash !== destinationSummary.hashes.state) throw new Error('phase2_source_hash_mismatch');
        if (phase2DestinationHash && phase2DestinationHash !== destinationSummary.hashes.state) throw new Error('phase2_destination_hash_mismatch');
      }
"""
if needle not in src:
    raise SystemExit('Phase 4 committed snapshot verification block not found')
src = src.replace(needle, replace, 1)
path.write_text(src)

# ---------------- Tests: Phase 2 now verifies a single metadata snapshot ----------------
path = Path('tests/phase2_dual_write.test.js')
test = path.read_text()
old_expect = """  assert.deepEqual((await rows(db, 'tasks')).map((row) => row.value.id), ['task-3']);

  const collectionRows = await rows(db, 'collections');
  ['schedule', 'opponentDripSchedules', 'storageWarnings', 'workHistory'].forEach((field) => {
    assert.equal(collectionRows.some((row) => row.kind === 'manifest' && row.field === field), true, field);
  });
  assert.equal(collectionRows.filter((row) => row.kind === 'item' && row.field === 'futureRows').length, 3);
  assert.equal(idb._db(core.IMAGE_DB_NAME), undefined, 'dual writes must not create or alter the image database');
"""
new_expect = """  const snapshotRows = await rows(db, 'metadata');
  const snapshot = snapshotRows.find((row) => row.id === core.SHADOW_DUAL_WRITE_SNAPSHOT_ID);
  assert.ok(snapshot, 'verified dual write should store one metadata snapshot');
  assert.equal(snapshot.snapshotFormat, 'metadata_raw_v1');
  assert.equal(snapshot.status, 'passed_verification');
  assert.equal(snapshot.serializedState, JSON.stringify(states[2]));
  assert.equal(core.parseTaskPointsStorageJson(snapshot.serializedState, {}).tasks[0].id, 'task-3');
  assert.equal((await rows(db, 'tasks')).length, 0, 'new dual writes must not enqueue per-row task puts');
  assert.equal((await rows(db, 'collections')).length, 0, 'new dual writes must not enqueue per-row collection puts');
  assert.equal(idb._db(core.IMAGE_DB_NAME), undefined, 'dual writes must not create or alter the image database');
"""
if old_expect not in test:
    raise SystemExit('Phase 2 test row expectations not found')
test = test.replace(old_expect, new_expect, 1)

append = r'''

test('dual-write metadata snapshot collapses the legacy row-write fanout', async () => {
  localRows.clear();
  const idb = createFakeIndexedDb({ strictTransactions: true });
  global.indexedDB = idb;
  const db = await seedVerifiedShadow(idb);
  const state = fixture(30);
  const raw = JSON.stringify(state);
  const before = core.getShadowDualWriteQueueStatus();

  global.localStorage.setItem(core.STORAGE_KEY, raw);
  await core.flushShadowDualWrites();
  const after = core.getShadowDualWriteQueueStatus();

  assert.equal(after.metadataSnapshotWriteCount - before.metadataSnapshotWriteCount, 1);
  assert.equal(after.legacyRowWriteCount - before.legacyRowWriteCount, 0);
  const snapshot = (await rows(db, 'metadata')).find((row) => row.id === core.SHADOW_DUAL_WRITE_SNAPSHOT_ID);
  assert.equal(snapshot.serializedState, raw);
  assert.equal(snapshot.status, 'passed_verification');
  for (const storeName of ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players', 'collections']) {
    assert.equal((await rows(db, storeName)).length, 0, `${storeName} should stay untouched by the new snapshot path`);
  }
});
'''
path.write_text(test + append)

# ---------------- Tests: Phase 3 supports new snapshot AND old rows ----------------
path = Path('tests/phase3_read_path.test.js')
test = path.read_text()
test = test.replace(
"  SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',\n",
"  SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',\n  SHADOW_DUAL_WRITE_SNAPSHOT_ID: 'phase2_dual_write_snapshot',\n  SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT: 'metadata_raw_v1',\n",
1,
)
# Extend seedShadow with metadataSnapshot option while preserving row-based legacy seeding.
old_seed_head = """async function seedShadow(idb, state, options = {}) {
  const db = idb._db(core.SHADOW_MIGRATION_DB_NAME) || await openFakeDb(idb);
  const layout = sourceLayout(state);
  const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
  const tx = db.transaction(stores, 'readwrite');
  [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
  tx.objectStore('values').clear();
  Object.entries(layout.arrays).forEach(([field, rows]) => rows.forEach((value, index) => tx.objectStore(field).put({ key: index, value })));
  Object.entries(layout.collections).forEach(([field, rows]) => {
    tx.objectStore('collections').put({ key: `manifest:${field}`, kind: 'manifest', field });
    rows.forEach((value, index) => tx.objectStore('collections').put({ key: `item:${field}:${index}`, kind: 'item', field, index, value }));
  });
  Object.entries(layout.values).forEach(([field, value]) => tx.objectStore('values').put({ field, value }));
  const summary = sourceSummary(state);
  tx.objectStore('metadata').put({ id: 'current', status: options.currentStatus || 'passed_verification' });
  tx.objectStore('metadata').put({
    id: 'dual_write',
    status: options.dualStatus || 'passed_verification',
    verification: {
      source: { hashes: { state: options.dualSourceHash || summary.hashes.state } },
      destination: { hashes: { state: options.dualDestinationHash || summary.hashes.state } }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return db;
}
"""
new_seed_head = """async function seedShadow(idb, state, options = {}) {
  const db = idb._db(core.SHADOW_MIGRATION_DB_NAME) || await openFakeDb(idb);
  const layout = sourceLayout(state);
  const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
  const tx = db.transaction(stores, 'readwrite');
  [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
  tx.objectStore('values').clear();
  if (!options.metadataSnapshot) {
    Object.entries(layout.arrays).forEach(([field, rows]) => rows.forEach((value, index) => tx.objectStore(field).put({ key: index, value })));
    Object.entries(layout.collections).forEach(([field, rows]) => {
      tx.objectStore('collections').put({ key: `manifest:${field}`, kind: 'manifest', field });
      rows.forEach((value, index) => tx.objectStore('collections').put({ key: `item:${field}:${index}`, kind: 'item', field, index, value }));
    });
    Object.entries(layout.values).forEach(([field, value]) => tx.objectStore('values').put({ field, value }));
  }
  const summary = sourceSummary(state);
  const sequence = Number(options.sequence) || 1;
  tx.objectStore('metadata').put({ id: 'current', status: options.currentStatus || 'passed_verification' });
  tx.objectStore('metadata').put({
    id: 'dual_write',
    status: options.dualStatus || 'passed_verification',
    sequence,
    verification: {
      source: { hashes: { state: options.dualSourceHash || summary.hashes.state } },
      destination: { hashes: { state: options.dualDestinationHash || summary.hashes.state } }
    }
  });
  if (options.metadataSnapshot) {
    tx.objectStore('metadata').put({
      id: core.SHADOW_DUAL_WRITE_SNAPSHOT_ID,
      snapshotFormat: core.SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT,
      status: options.snapshotStatus || 'passed_verification',
      sequence: Number(options.snapshotSequence) || sequence,
      serializedState: JSON.stringify(state),
      stateHash: options.snapshotStateHash || summary.hashes.state
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return db;
}
"""
if old_seed_head not in test:
    raise SystemExit('Phase 3 seedShadow block not found')
test = test.replace(old_seed_head, new_seed_head, 1)
append = r'''

test('compare mode verifies the new Phase 2 metadata snapshot without legacy row records', async () => {
  const state = fixture(31);
  await reset(state, 'compare');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  const db = await seedShadow(idb, state, { metadataSnapshot: true, sequence: 31 });
  for (const storeName of ARRAY_STORES) {
    assert.equal(db.stores.get(storeName).rows.size, 0, `${storeName} legacy rows should be empty`);
  }
  assert.equal(db.stores.get('collections').rows.size, 0);

  const status = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(status.status, 'compare_passed', JSON.stringify(status));
  assert.equal(status.hashesMatch, true);
  assert.equal(status.countsMatch, true);
});

test('verified mode serves the new metadata snapshot while legacy row snapshots remain supported', async () => {
  const state = fixture(32);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state, { metadataSnapshot: true, sequence: 32 });
  const warmed = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(warmed.status, 'ready', JSON.stringify(warmed));
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-32');

  // Existing row-format databases must remain readable as a fallback.
  await reset(fixture(33), 'compare');
  const legacyIdb = createFakeIndexedDb();
  global.indexedDB = legacyIdb;
  await seedShadow(legacyIdb, fixture(33));
  const legacyStatus = await core.getPhase3ReadStatus({ refresh: true, indexedDB: legacyIdb });
  assert.equal(legacyStatus.status, 'compare_passed', JSON.stringify(legacyStatus));
});

test('an unverified or sequence-mismatched metadata snapshot fails closed instead of falling back to stale rows', async () => {
  const state = fixture(34);
  await reset(state, 'compare');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state, { metadataSnapshot: true, sequence: 34, snapshotSequence: 35 });
  const status = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(status.status, 'fallback');
  assert.equal(status.effectiveSource, 'localStorage');
  assert.equal(status.lastFallbackReason, 'dual_write_not_verified');
});
'''
path.write_text(test + append)

# ---------------- Tests: Phase 4 fallback can consume current Phase 2 metadata snapshot ----------------
path = Path('tests/phase4_storage_contract.test.js')
test = path.read_text()
# Ensure the stub exposes the same IDs the runtime sees.
test = test.replace(
"    SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',\n",
"    SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',\n    SHADOW_DUAL_WRITE_SNAPSHOT_ID: 'phase2_dual_write_snapshot',\n    SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT: 'metadata_raw_v1',\n",
1,
)
append = r'''

test('Phase 4 restore prefers a current Phase 2 metadata snapshot before legacy row fallback', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  const state = fixture(41);
  const raw = JSON.stringify(state);
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();

  const commit = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  assert.equal(commit.status, 'passed_verification');
  const summary = sourceSummary(state);

  // Remove only the Phase 4 raw snapshot to force its compatibility fallback.
  const tx = harness.db.transaction('metadata', 'readwrite');
  tx.objectStore('metadata').delete('phase4_primary_snapshot');
  tx.objectStore('metadata').put({
    id: 'dual_write',
    status: 'passed_verification',
    sequence: 77,
    verification: {
      source: { hashes: { state: summary.hashes.state } },
      destination: { hashes: { state: summary.hashes.state } }
    }
  });
  tx.objectStore('metadata').put({
    id: 'phase2_dual_write_snapshot',
    snapshotFormat: 'metadata_raw_v1',
    status: 'passed_verification',
    sequence: 77,
    serializedState: raw,
    stateHash: summary.hashes.state
  });
  await new Promise((resolve) => { tx.oncomplete = resolve; });

  // Poison legacy rows so success proves the Phase 2 metadata snapshot won.
  const rowTx = harness.db.transaction('tasks', 'readwrite');
  rowTx.objectStore('tasks').clear();
  rowTx.objectStore('tasks').put({ key: 0, value: { id: 'stale-legacy-row' } });
  await new Promise((resolve) => { rowTx.oncomplete = resolve; });

  harness.core.clearPhase4Caches();
  const restored = await harness.core.restorePhase4CommittedPrimary({ indexedDB: harness.indexedDB });
  assert.equal(restored.restored, true, JSON.stringify(restored));
  assert.equal(restored.cache.state.tasks[0].id, 'task-41');
});
'''
path.write_text(test + append)
