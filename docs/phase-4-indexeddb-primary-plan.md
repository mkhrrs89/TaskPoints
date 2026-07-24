# Phase 4 — IndexedDB-Primary Storage Plan

Status: planning only. This document does not enable Phase 4 or change production storage behavior.

## 1. Goal

Make IndexedDB the preferred verified application-state source while retaining `localStorage` as a complete, immediately available rollback mirror.

Phase 4 must preserve every existing TaskPoints feature and every existing safety boundary. It must not delete `localStorage`, alter image storage, change import/export formats, bypass reset warnings, or require a destructive migration.

## 2. Non-negotiable requirements

1. IndexedDB becomes the preferred source only after a complete write has been read back and verified.
2. `localStorage` continues receiving the full `taskpoints_v1` snapshot after every successful save.
3. A failed or unavailable IndexedDB operation can never block or erase a successful `localStorage` save.
4. A failed `localStorage` mirror write prevents the corresponding IndexedDB candidate from becoming authoritative.
5. Every read falls back immediately to the current `localStorage` loader when IndexedDB is missing, pending, stale, malformed, mismatched, unavailable, or unverified.
6. A Settings control provides instant rollback to the current Phase 3/localStorage behavior.
7. Existing export/import behavior, images, backup slots, quarantine handling, pending-habit journals, reset confirmations, and all app features remain unchanged.
8. No `localStorage` data is deleted during Phase 4 or as part of the Phase 4 rollout.
9. The live image database (`taskpoints`, store `images`) remains isolated and untouched.
10. A missing `taskpoints_v1` key is always treated as a reset/empty-state signal. IndexedDB must never resurrect an older snapshot.

## 3. Current baseline

The existing implementation already provides the main safety primitives Phase 4 needs:

- `scoring_core.js` keeps `taskpoints_v1` as the synchronous canonical snapshot and preserves the pending-habit write-ahead journal.
- Phase 1 created and verified `taskpoints_shadow_state_v1` without changing the application read path.
- `phase2_dual_write.js` serializes writes, stores a complete record-based snapshot, reads it back, and verifies counts and canonical hashes after every mirrored write.
- `phase2_reset_hook.js` prevents delayed writes from restoring pre-reset data.
- `phase3_read_path.js` serves IndexedDB-derived state only after exact verification and otherwise reruns the untouched `localStorage` loader.
- Phase 3 navigation/session modules allow a fully verified snapshot to survive same-tab page navigation while still checking the live `localStorage` mirror.

Phase 4 should extend these seams rather than replace the application or rewrite every page.

## 4. Key architectural decision

Phase 4 will initially reuse the existing `taskpoints_shadow_state_v1` database and its record stores instead of creating a third full structured-state database.

Reasons:

- The existing database layout is already production-tested and verified.
- Reuse avoids keeping `localStorage`, a shadow database, and a separate primary database simultaneously.
- The state-store transaction already clears and rewrites all structured stores atomically.
- Existing Phase 1 and Phase 2 metadata rows can remain intact.

Phase 4 will add separate metadata records for its own commit protocol. It will not overwrite or delete the existing `current` or `dual_write` metadata records.

Proposed new metadata IDs:

- `phase4_candidate`
- `phase4_primary_commit`
- `phase4_diagnostics`

## 5. What “IndexedDB primary” means

IndexedDB is primary only when the latest candidate has:

1. been written atomically;
2. been read back;
3. matched the source state by counts, hashes, mismatch checks, and full canonical layout;
4. been confirmed against an unchanged `localStorage` mirror;
5. received a `passed_verification` primary-commit marker.

Until all five conditions pass, `localStorage` remains the effective source for that save.

Because IndexedDB is asynchronous and the current TaskPoints pages load synchronously, a cold page load may use the `localStorage` mirror as a safe bootstrap while IndexedDB verifies. Same-tab navigation may continue using the verified session snapshot. A later project could convert every page to an asynchronous boot process, but that broad refactor is not required for Phase 4 and will not be mixed into this migration.

## 6. Storage modes

Phase 4 gets its own mode key and leaves the existing Phase 3 setting intact.

Proposed key:

`taskpoints_phase4_storage_mode_v1`

Proposed modes:

### `off`

- Default.
- Current Phase 3 behavior remains unchanged.
- Existing Phase 2 dual writes continue as they do now.
- No Phase 4 commit is considered primary.

### `verify_primary_writes`

- The new Phase 4 write coordinator creates and verifies primary candidates.
- Application reads continue through the current Phase 3 policy.
- Used for preview and production validation before read preference changes.

### `indexeddb_primary`

- Verified primary commits become the preferred read source.
- Any failed gate immediately uses the untouched `localStorage` loader.
- The Settings control can return to `off` without deleting or converting data.

Invalid or unreadable mode values resolve to `off`.

## 7. Save protocol

The existing synchronous save contract must remain usable by all pages.

### Step A — build one canonical snapshot

The normal TaskPoints save path produces one normalized state and one serialized `taskpoints_v1` mirror using the existing packing/compression code.

### Step B — write the rollback mirror first

The existing safe `localStorage` replacement completes first.

This order is intentional:

- it preserves crash safety for synchronous user interactions;
- it preserves current quota handling and rollback behavior;
- it ensures a tab close cannot lose a user action while an IndexedDB promise is still pending.

If this write fails, the Phase 4 candidate is not queued or accepted.

### Step C — serialize candidates

Phase 4 queues candidates with a monotonically increasing sequence. Rapid saves are processed in order. When queued work begins, it re-reads the latest `taskpoints_v1` mirror rather than trusting an older captured payload.

A confirmed missing mirror means empty/reset state. It never falls back to an older captured snapshot.

### Step D — atomic IndexedDB transaction

A single read-write transaction replaces the record stores and writes `phase4_candidate` metadata containing at least:

- schema version;
- sequence/generation;
- candidate status;
- started timestamp;
- source counts and hashes;
- hash of the captured mirror raw string;
- pending-journal count;
- error list.

All requests are created synchronously before awaiting to preserve Safari transaction behavior.

### Step E — read-back verification

Phase 4 rebuilds the complete state and verifies:

- counts match;
- overall canonical state hash matches;
- per-section mismatch checks are empty;
- full arrays/collections/values layout matches;
- ordering and duplicates are preserved;
- the live `taskpoints_v1` raw value is unchanged from the value captured before the transaction;
- no newer Phase 4 sequence exists;
- no pending Phase 2/Phase 4 write remains ahead of this candidate;
- no pending-habit journal appeared during verification.

### Step F — primary commit marker

Only after verification passes does Phase 4 write `phase4_primary_commit` with `status: passed_verification` and the verified sequence, counts, hashes, timestamps, and mirror hash.

A write is never called “primary” merely because the IndexedDB transaction completed.

### Failure behavior

If IndexedDB fails or verification does not pass:

- preserve the successful `localStorage` mirror;
- record diagnostics;
- invalidate Phase 4 read caches;
- set the effective source to `localStorage`;
- retry only through a controlled later save/refresh;
- never roll back user data to an older IndexedDB snapshot.

## 8. Read protocol

A Phase 4 read may use IndexedDB-derived state only when all of these gates pass:

1. mode is `indexeddb_primary`;
2. `phase4_primary_commit.status` is `passed_verification`;
3. its sequence matches the current IndexedDB candidate/state;
4. counts, hashes, and canonical layout still verify;
5. the current `taskpoints_v1` mirror is present;
6. the mirror hash matches the committed mirror hash;
7. no Phase 2 or Phase 4 write is pending;
8. no pending-habit journal exists;
9. no reset, storage, or cross-tab invalidation occurred;
10. the verified session snapshot, when used, also matches the live mirror.

If any gate fails, the code immediately invokes the untouched current `localStorage` loader with the caller’s original options.

The read path must retain `persistSync: false` for IndexedDB-assisted attempts. If the live mirror or journal changes during a substituted read, discard the attempt and rerun the original loader.

## 9. Rollback behavior

The Settings switch must be immediate and nondestructive.

Switching Phase 4 to `off`:

- clears Phase 4 in-memory and session caches;
- stops treating Phase 4 commits as primary;
- restores the current Phase 3/localStorage read policy on the next read;
- does not clear IndexedDB stores;
- does not clear `localStorage`;
- does not alter images;
- does not require an import or reload to recover data.

The rollback control must remain usable even when IndexedDB is unavailable or corrupt.

## 10. Reset All

Reset behavior remains confirmation-gated and preserves current UI warnings.

Required rules:

- Removing `taskpoints_v1` immediately invalidates every Phase 4 cache.
- A missing mirror always defeats a stale queued candidate.
- Phase 4 reconciles IndexedDB to an empty state/tombstone only after the confirmed reset.
- A pending pre-reset write can never restore the old state.
- Cross-tab reset events clear caches and prevent an in-progress verified read from returning stale data.
- Images follow the existing reset policy only; Phase 4 introduces no image deletion behavior.

## 11. Import, export, and backups

### Import

The existing importer and file format remain unchanged. An imported state is written through the current `localStorage` path first, then queued as a Phase 4 candidate. Until verification passes, reads use the imported `localStorage` mirror.

### Export

The existing export button remains unchanged and continues to work from the complete rollback mirror/current loaded state. Phase 4 must not require users to wait for IndexedDB before making a backup.

### Existing safety data

The backup slots, quarantined snapshot, compressed storage wrapper, and pending-habit journal remain in their current locations and formats.

## 12. Image boundary

Player and user images remain in:

- database: `taskpoints`
- object store: `images`

Phase 4 state transactions must never open that database. Image IDs continue to live in structured state, but image blobs are neither copied, rewritten, verified, deleted, nor garbage-collected by Phase 4.

Tests must assert that no Phase 4 operation opens or mutates the image database.

## 13. Worker/module strategy

Keep Phase 4 isolated behind the existing narrow Cloudflare Pages augmentation rather than editing every application page.

Proposed modules:

- `phase4_storage_coordinator.js`
- `phase4_primary_read_path.js`
- `phase4_cache_guard.js`
- `phase4_diagnostics.js`

Required worker behavior:

- Phase 1/2 remain the safety floor.
- Phase 3 remains functional when Phase 4 is absent or off.
- Failure to fetch or evaluate a Phase 4 module must degrade to the complete current Phase 3 bundle.
- No unrelated route is rewritten.
- Settings injection adds controls/status without replacing the existing Settings file.
- Optional Phase 4 modules should be installed atomically where partial installation could alter storage semantics.

## 14. Diagnostics

The read-only Phase 4 status should expose:

- configured mode;
- effective source;
- latest queued sequence;
- latest passed sequence;
- pending writes;
- last mirror write time;
- last candidate write time;
- last verification time;
- last IndexedDB-served read;
- last fallback time and reason;
- source/destination counts and hashes;
- current mirror hash match;
- cache readiness/session restore state;
- failure totals and fallback totals;
- reset/tombstone status.

Diagnostics must not provide destructive controls.

## 15. Implementation sequence

### Phase 4.0 — planning branch

- Documentation only.
- No production behavior changes.
- Review architecture and acceptance criteria.

### Phase 4.1 — contract tests first

Add failing tests for the complete protocol before runtime implementation.

### Phase 4.2 — dark write coordinator

Add modules and worker wiring with mode defaulting to `off`. Confirm that the exact current behavior remains when Phase 4 is unavailable or disabled.

### Phase 4.3 — verified primary-write mode

Enable `verify_primary_writes` only in preview. Confirm rapid writes, failures, reset, import, export, journals, cross-tab behavior, and image isolation.

### Phase 4.4 — production deploy, still off

Deploy the reviewed implementation with Phase 4 disabled. Confirm that the current Phase 3 status and normal app behavior are unchanged.

### Phase 4.5 — limited opt-in

Enable `verify_primary_writes` in production first. Inspect diagnostics and use TaskPoints normally.

### Phase 4.6 — IndexedDB-primary opt-in

Enable `indexeddb_primary` only after write verification has remained clean. Keep the instant rollback switch visible.

No stage deletes `localStorage`.

## 16. Required automated test matrix

At minimum:

1. default mode is off;
2. invalid mode becomes off;
3. Phase 4 module fetch/evaluation failure preserves Phase 3;
4. successful mirror write queues one ordered IndexedDB candidate;
5. failed mirror write does not create a primary candidate;
6. rapid saves commit only the newest valid sequence as primary;
7. stale captured payload cannot overwrite newer mirror data;
8. missing mirror defeats a queued pre-reset payload;
9. IndexedDB transaction failure preserves the mirror and falls back;
10. read-back count mismatch rejects the candidate;
11. hash mismatch rejects the candidate;
12. canonical-layout mismatch rejects the candidate;
13. mirror change during verification rejects the candidate;
14. pending habit journal blocks a primary read;
15. journal appearance, replacement, or clearing during a read discards the attempt;
16. pending write blocks a primary read;
17. cross-tab save/reset invalidates caches;
18. session cache restores only when fully reverified;
19. sessionStorage unavailable/quota failure safely falls back;
20. cold load safely bootstraps from the mirror while verification warms;
21. rollback switch immediately restores current Phase 3 behavior;
22. import is mirrored and verified without format changes;
23. export works while Phase 4 is pending or unavailable;
24. reset warnings and confirmation behavior remain unchanged;
25. no image database access occurs;
26. arrays, unknown collections, empty collections, ordering, and duplicates survive;
27. compressed and packed mirror formats parse to the same verified state;
28. full repository test suite passes.

## 17. Preview/production verification checklist

Before implementation testing:

- create and retain a fresh dated production export;
- confirm Phase 3 diagnostics are healthy;
- confirm player images load before and after navigation.

For preview:

- add tasks and complete habits;
- generate and finalize matchups;
- navigate across multiple pages;
- close and reopen the app;
- test import/export;
- test rapid repeated saves;
- test rollback mode;
- test Reset All only with a disposable preview dataset;
- verify no images are missing or rewritten;
- confirm fallback reasons are controlled and understandable.

For production:

- deploy with Phase 4 off;
- verify no behavior change;
- enable write verification before enabling primary reads;
- keep the dated export available;
- use the rollback switch immediately for any unexplained mismatch, stale state, missing image reference, or save anomaly.

## 18. Acceptance criteria for beginning implementation

Implementation may begin only when:

- this plan is reviewed;
- the branch contains no production runtime change;
- the fresh dated export exists;
- current Phase 3 remains healthy;
- the implementation is split into reviewable draft PRs;
- tests are committed before or alongside each behavior change;
- no requested feature is removed or weakened.

## 19. Explicit exclusions

Phase 4 does not include:

- deleting or shrinking `localStorage` data;
- changing the import/export file format;
- moving or cleaning player images;
- redesigning unrelated UI;
- replacing reset confirmations;
- converting every page to asynchronous startup;
- adding cloud synchronization;
- removing Phase 1, Phase 2, or Phase 3 rollback evidence.
