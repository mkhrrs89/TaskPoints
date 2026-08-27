# TaskPoints State Runtime V2 — Architecture Plan

Status: Step 1 planning only. This document intentionally makes **no production runtime changes**.

Branch: `arch/state-runtime-v2-plan`

Base: current `main` after PR #894.

## 1. Goal

Move TaskPoints toward a ZenGM-style data architecture where normal user actions update only the records that actually changed, while preserving TaskPoints' existing features, recovery behavior, exports, images, and rollback paths throughout the migration.

The end state should make ordinary interactions feel immediate even as historical data continues to grow.

The main architectural change is:

- today: the app often treats one large serialized application snapshot as the unit of persistence;
- V2: the app treats one logical mutation and the records affected by that mutation as the unit of persistence.

A full snapshot remains available for export, backup, compatibility, and recovery, but it must stop being the required foreground write path for every small action.

## 2. Why this is separate from the existing Phase 4 system

The existing Phase 4 IndexedDB-primary work is a safety-first migration layer around the current snapshot architecture. It deliberately preserves `taskpoints_v1` as a complete synchronous mirror and verifies full-state candidates before preferring IndexedDB reads.

That work remains valuable as migration/recovery infrastructure, but it is not the V2 target architecture because it can still serialize, mirror, verify, and compare the complete application state.

V2 therefore must not simply add another mode to `phase4_storage_coordinator.js` or repurpose `taskpoints_shadow_state_v1` as the live mutation engine.

V2 gets a clean boundary and its own database.

## 3. Non-negotiable requirements

1. No existing TaskPoints feature may be removed or weakened as part of this migration.
2. `main` remains untouched until a preview stage is explicitly approved.
3. V2 starts dark: writes and verification only; no production read path changes in the first implementation stage.
4. A user action must have a durable representation before its expensive compatibility/full-snapshot work is deferred.
5. Killing or backgrounding the app immediately after a user action must not intentionally lose that action.
6. Existing import/export formats remain supported throughout migration.
7. Existing player/user image storage remains isolated and untouched.
8. Reset, restore, emergency recovery, backup slots, quarantine data, and recovery write locks remain functional.
9. A stale V2 database must never resurrect data after an explicit reset or restore.
10. Multi-tab and standalone-browser contexts must not silently overwrite newer state.
11. Every migration stage must have an instant or straightforward fallback to the existing storage path.
12. Transitional infrastructure should eventually be removable; V2 must reduce architectural complexity rather than permanently stack another wrapper on top.

## 4. New persistent database

Proposed database:

`taskpoints_state_v2`

Do not reuse:

- `taskpoints_shadow_state_v1`
- `taskpoints_verified_secondary_v1`
- `taskpoints` / `images`

The existing databases keep their current safety/recovery roles during migration.

### Initial object stores

The first implementation should create only the stores required for the Habits/completions proving ground plus generic transaction metadata:

- `habits` — key: habit id
- `completions` — key: completion id
- `mutations` — key: mutation id; durable mutation ledger / idempotency evidence
- `meta` — schema, revision, migration state, reset generation, last verified compatibility checkpoint

Later stores can be added deliberately:

- `tasks`
- `matchups`
- `gameHistory`
- `seasonHistory`
- `players`
- other authoritative collections

Do not create every future store simply because it exists in `taskpoints_v1`.

## 5. Authoritative data vs derived data

Before a collection moves to V2, classify every field involved in its workflows.

### Authoritative

Data that represents a user decision, historical event, or canonical game state and cannot be safely recomputed from another source.

Examples for the first migration:

- habit definitions/settings
- habit ordering/group ordering
- completion records
- explicit fail/skip/half-complete status when represented canonically
- timestamps required by scoring/history rules

### Derived / rebuildable

Data that can be regenerated deterministically from authoritative records.

Examples may include:

- some streak summaries
- UI-only cached values
- page-specific aggregate tables
- transient sorting/view state

Derived fields should not be copied into V2 merely because the current snapshot contains them. Each field must be justified.

## 6. TaskPointsStateRuntime V2 boundary

Proposed browser API:

`TaskPointsStateRuntimeV2`

Initial contract:

```js
await TaskPointsStateRuntimeV2.open();
await TaskPointsStateRuntimeV2.applyMutation(mutation);
await TaskPointsStateRuntimeV2.getHabit(id);
await TaskPointsStateRuntimeV2.getCompletionsForHabit(id, options);
await TaskPointsStateRuntimeV2.buildCompatibilitySnapshot(options);
TaskPointsStateRuntimeV2.getStatus();
```

The runtime should be a thin state/storage boundary, not a second scoring engine.

Scoring/business rules remain owned by the existing canonical TaskPoints logic until they are intentionally migrated. V2 receives explicit mutation results from those rules rather than reimplementing them independently.

## 7. Logical mutations, not single-row assumptions

One click may affect several authoritative records. V2 must represent one user action as one logical mutation.

Example:

```js
{
  id: "mutation-uuid",
  type: "habit-completion-set",
  createdAtISO: "...",
  expectedBaseRevision: 123,
  changes: {
    habits: [...],
    completionUpserts: [...],
    completionDeletes: [...]
  }
}
```

The exact schema should be finalized in implementation tests, but the properties must include:

- globally unique mutation id;
- mutation type;
- base/current revision information;
- enough payload to replay safely;
- idempotency guarantee;
- transaction result/revision.

All V2 records affected by one logical mutation must commit in **one IndexedDB transaction** wherever technically possible.

The mutation ledger and the changed rows must commit atomically so replaying the same mutation cannot double-award points or duplicate a historical action.

## 8. Immediate-kill safety: synchronous write-ahead log

IndexedDB is asynchronous, especially on mobile Safari. V2 must not rely on an IndexedDB promise as the only durable evidence of a just-completed foreground action.

Proposed small localStorage WAL:

`taskpoints_v2_pending_mutations_v1`

The WAL is intentionally small and mutation-oriented. It must never contain the complete TaskPoints state.

Foreground flow:

1. Existing business logic determines the canonical mutation.
2. Write that mutation synchronously to the V2 WAL.
3. Update visible UI/in-memory state.
4. Submit the mutation to `taskpoints_state_v2`.
5. Verify the committed mutation/revision.
6. Remove only the verified mutation from the WAL.
7. Schedule expensive compatibility/checkpoint work later.

If the app is killed after step 2 but before step 6, startup replays the WAL idempotently.

### WAL rules

- append/merge must be synchronous and small;
- every mutation has a unique id;
- replaying an already-committed mutation is a no-op;
- malformed WAL data is quarantined, not silently discarded;
- recovery/import/reset locks can block replay/writes;
- explicit reset/restore advances a generation so older WAL mutations cannot resurrect prior state;
- WAL clearing occurs only after verified V2 commit or explicit authorized discard during reset/restore.

## 9. Revision and generation model

V2 needs a monotonic persistent revision independent of page reloads.

`meta` should contain at least:

```js
{
  id: "runtime",
  schemaVersion: 1,
  revision: 123,
  resetGeneration: "uuid-or-monotonic-token",
  lastMutationId: "...",
  updatedAtISO: "..."
}
```

Every successful logical mutation increments `revision` inside the same IndexedDB transaction as its changed records.

Every explicit Reset All / authoritative restore establishes a new `resetGeneration`.

A mutation from an older generation is never eligible for replay.

This avoids using timestamps as conflict authority.

## 10. Multi-context behavior

TaskPoints can run in separate browser documents and potentially multiple tabs/standalone contexts. V2 cannot assume one immortal in-memory owner yet.

For the pre-SPA architecture:

- IndexedDB is the persistent center;
- each document gets a lightweight runtime instance;
- each runtime reads the persistent revision on startup;
- mutations use expected revision / conflict handling;
- `BroadcastChannel` should be used when available to announce committed revisions;
- a `storage`-event fallback may be used for invalidation signaling;
- an invalidated page must refresh affected authoritative records before issuing a conflicting mutation.

Do not create a SharedWorker dependency in Step 1/early V2. Safari/PWA lifecycle support and the current multipage architecture make that an unnecessary first risk.

## 11. Compatibility snapshot boundary

During migration, many existing pages/tools will still expect complete legacy state.

V2 therefore needs one explicit compatibility function:

`buildCompatibilitySnapshot()`

Its job is to produce the current legacy-shaped state from:

- the latest legacy snapshot for collections not yet migrated;
- V2 authoritative records for collections already migrated;
- any verified pending mutation overlay that must be represented.

This function becomes the only approved bridge between incremental V2 data and legacy whole-state consumers.

### Important

Do not make every V2 mutation immediately call `buildCompatibilitySnapshot()` and rewrite `taskpoints_v1`. That would reproduce the current bottleneck.

Compatibility snapshots are for:

- explicit export;
- scheduled/idle checkpoints;
- legacy pages that have not yet migrated and cannot use a targeted adapter;
- backup/recovery checkpoints;
- verification during dark migration.

## 12. `taskpoints_v1` during the transition

At first, `taskpoints_v1` remains the current production authority.

Migration stages change its role gradually:

### Stage A — dark mirror

- current app remains authoritative;
- existing save behavior remains unchanged;
- Habits/completions mutations are additionally mirrored into V2;
- V2 is never used to serve application reads;
- parity is continuously measured.

### Stage B — V2 mutation authority for pilot actions

Only after dark-mirror parity succeeds:

- the immediate durable action is WAL + V2 transaction;
- current in-memory UI is updated immediately;
- legacy snapshot checkpoint is deferred to a safe idle period;
- compatibility snapshot verification remains active.

### Stage C — targeted V2 reads

- one controlled page/workflow reads Habits/completions through V2;
- unmigrated state still comes from legacy storage;
- instant kill switch restores the current read path.

### Stage D — broader collection migration

Move additional authoritative collections one at a time.

### Stage E — legacy snapshot becomes checkpoint artifact

Only after enough of the application is V2-native:

- `taskpoints_v1` becomes primarily compatibility/export/recovery checkpoint data;
- routine foreground actions no longer require a full rewrite.

No stage deletes the legacy snapshot automatically.

## 13. Existing systems that must remain isolated initially

V2 Step 1 and first implementation must not modify the semantics of:

- Phase 2 shadow dual-write
- Phase 3 read/session cache
- existing Phase 4 IndexedDB-primary experiment
- verified secondary storage / restore
- emergency recovery
- image storage
- import/export file format
- Reset All confirmation UX
- existing task/habit/inbox journals

These systems may consume a verified compatibility checkpoint later, but early V2 work must not silently reroute them.

## 14. Reset / restore / import protocol

These are correctness-critical and must be designed before V2 can serve reads.

### Reset All

Required order:

1. Acquire/establish existing recovery/reset write protection.
2. Advance V2 `resetGeneration` or commit a reset tombstone.
3. Clear/quarantine pending V2 WAL mutations from older generations.
4. Apply the current legacy reset behavior.
5. Reconcile V2 to the empty/reset state.
6. Release locks only after the authoritative state relationship is unambiguous.

A delayed pre-reset V2 transaction must never resurrect prior records.

### Restore / emergency recovery

An authorized restore creates a new generation and replaces/reseeds V2 from the restored canonical state before normal V2 writes resume.

### Import

During early migration, existing import remains authoritative. After successful import:

- establish a new V2 generation or migration epoch;
- seed/mirror migrated collections into V2;
- verify parity;
- clear incompatible pre-import V2 WAL entries.

## 15. Export and backup behavior

Export cannot rely on a potentially stale legacy checkpoint once V2 becomes mutation-authoritative.

Before that transition, define one of these safe behaviors:

Preferred:

- export asks `buildCompatibilitySnapshot()` for a transactionally consistent complete state and writes the existing file format.

Acceptable transitional fallback:

- export requests a foreground checkpoint, waits for its verification, then exports the resulting complete snapshot.

The user must never unknowingly receive an export that omits recently committed V2 mutations.

## 16. Image boundary

No V2 transaction may open or mutate the existing `taskpoints` database used for image blobs.

V2 may store image-reference IDs as ordinary state fields when those records are eventually migrated, but image bytes remain outside V2.

Tests must make this boundary explicit.

## 17. Storage-quota considerations

Migration temporarily duplicates data across:

- `taskpoints_v1` / compatibility state;
- existing shadow database;
- verified secondary storage;
- new V2 data;
- existing image database.

Before dark mirroring large collections, diagnostics should estimate browser storage usage/quota where the API is available.

V2 must degrade safely when quota is unavailable or low. A failed V2 dark write cannot damage the current production state.

## 18. Step 1 deliverables

This planning step is complete only when the branch contains:

1. this architecture document;
2. no runtime or worker changes;
3. no new production storage key/database creation;
4. no changes to `main`;
5. a reviewed list of acceptance tests for the first V2 implementation.

## 19. Step 2 — contract-test design

Before writing V2 runtime code, add tests that define the storage contract.

Minimum initial contract matrix:

1. opening V2 creates only the expected database/stores;
2. images database is never touched;
3. one habit mutation commits mutation ledger + changed records + revision atomically;
4. transaction failure commits none of those changes;
5. duplicate mutation id is idempotent;
6. revision is persistent across reload/runtime recreation;
7. WAL write precedes asynchronous V2 commit;
8. successful V2 verification removes only the matching WAL mutation;
9. kill-before-IDB simulation leaves WAL replayable;
10. WAL replay commits exactly once;
11. malformed WAL is preserved/quarantined and does not silently mutate data;
12. old-generation WAL cannot replay after reset;
13. reset invalidates an in-flight older mutation;
14. import/restore generation supersedes pre-import mutations;
15. two runtime instances detect revision conflict rather than last-write-wins silently;
16. compatibility snapshot preserves habit ordering exactly;
17. compatibility snapshot preserves completion ordering/duplicates according to current canonical semantics;
18. dark-mirror comparison reports mismatch without changing application reads;
19. V2 unavailable/open failure leaves current production behavior untouched;
20. quota failure leaves current production behavior untouched;
21. export contract includes committed V2 mutations once V2 becomes authoritative;
22. all current repository tests remain unchanged/passing before any behavior flag can be enabled.

## 20. Step 3 — dark Habits/completions prototype

After Step 2 tests are reviewed, implement V2 behind a default-off/dark-only flag.

The first prototype must:

- create `taskpoints_state_v2` only when the dark feature is explicitly enabled on the preview branch;
- mirror canonical Habit/completion mutations after the existing production action succeeds;
- never serve V2 state to the UI;
- record revision/mutation diagnostics;
- compare V2 Habits/completions against the canonical loaded state;
- expose mismatches without repairing production state automatically;
- support clean disable/delete of V2 test data without touching production state or images.

## 21. Preview failure scenarios required before V2 can own a mutation

At minimum test manually and automatically where possible:

- complete a habit and immediately kill the app;
- complete several habits rapidly and kill the app;
- undo/toggle the same completion rapidly;
- half-completion and any alternate Habit completion states;
- move/reorder habits repeatedly;
- edit Habit name/points/schedule/category/group fields;
- navigate during an IndexedDB write;
- background/foreground during a write;
- standalone app plus Safari tab open simultaneously;
- two normal browser tabs modifying Habits;
- V2 IndexedDB blocked/unavailable;
- transaction abort;
- quota failure;
- malformed WAL;
- stale WAL from an older generation;
- explicit Reset All;
- import a backup;
- emergency restore;
- ordinary export immediately after a recent mutation;
- reload repeatedly during dark verification.

## 22. Performance acceptance criteria for the pilot

The V2 pilot is successful only if it improves foreground work, not merely shifts the same full-state work around.

For a migrated Habit action:

- no full `taskpoints_v1` serialization/compression is required before UI response;
- no full shadow-state verification is required before UI response;
- no verified-secondary snapshot is required before UI response;
- synchronous WAL work remains small;
- V2 IndexedDB transaction touches only the stores/rows needed by the logical mutation;
- expensive compatibility/checkpoint work is scheduled behind a global idle/maintenance coordinator;
- user interaction preempts or postpones heavyweight maintenance that has not yet begun.

Trace diagnostics must make each of these assertions observable.

## 23. Long-term simplification target

V2 is not complete when it merely works alongside every existing phase forever.

Once V2 has proven authority for all required data and recovery/export paths:

- remove obsolete per-action fast-path journals by folding them into the generic V2 mutation/WAL system;
- stop routine Phase 2 full-state writes;
- stop routine Phase 4 full-snapshot verification;
- retain only the backup/recovery checkpoints that still provide independent value;
- make pages consume targeted state APIs;
- later introduce a persistent app shell/internal routing so browser memory can remain hot across navigation.

Removal of any existing protection happens only after equivalent or stronger V2 protection is verified and explicitly approved.

## 24. Decision for the first implementation

The first V2 proving ground is **Habits + completion records**.

The first implementation must be **dark mirror only**. It does not replace the current Habit completion or reorder paths, does not change what the UI reads, and does not change production persistence.

This keeps the migration reversible while giving us the best-instrumented, most frequently used interaction set for validating the architecture.