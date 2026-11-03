# TaskPoints V2 — weighted cutover readiness milestones

**Branch:** `arch/state-runtime-v2-plan` (V2 only)
**Baseline:** November 2, 2026 · **67/100** estimated milestone points
**Authority:** V1 remains primary. V2 is dark/preview-only. No authorization to promote.

This checklist replaces the informal practice of increasing the completion
percentage after every performance/test commit. Weights are a **planning rubric,
not measured performance, a release probability, or a guarantee of safety**.
The original 67% estimate is retained as the starting baseline, with the
remaining work explicitly assigned. Change a gate's status only after its
acceptance criteria have been independently demonstrated.

| Gate | Weight | Credited | Acceptance evidence / status |
| --- | ---: | ---: | --- |
| Record-level V2 runtime foundation and atomic pilot mutations | 20 | 20 | `state_runtime_v2.js`, atomic/compatibility contracts. **Pilot only**; not all collection types. |
| Pilot WAL and immediate-interruption recovery mechanics | 15 | 15 | `state_runtime_v2_wal.js`, generation and lifecycle contracts, simulated kill and browser safety. **Pilot only**; not proof of device-level durability. |
| Pilot parity, reconciliation and safe rollback of incomplete writes | 15 | 15 | Parity, mutation, failure-isolation, serializer and reconciliation contracts. No general authority. |
| Foreground performance, idle coordination and tracing infrastructure | 10 | 10 | Step-4 performance, idle, trace and journal fast-path contracts. Additional tuning requires measured regressions, not percentage changes. |
| Legacy writer audit and fail-closed handoff diagnosis | 7 | 7 | Source-evidence matrix, nine known writer families, silent-old-tab negative browser tests and `canPromote:false`. **Audit is not writer exclusion**. |
| Migrate and verify every nonpilot authoritative collection | 12 | 0 | Tasks, Game/player/season data, Notes, Projects, Today, preference/auxiliary keys and imports; prove one-logical-action transaction and correct compatibility/export. |
| Enforce production-wide cross-tab writer admission and generation fencing | 11 | 0 | All nine known entry families **and** indirect/dynamic/direct paths; no stale writes from paused/old pages, fallback, compaction or service-worker lifecycle. Negative exclusion rehearsal does not pass this gate. |
| Proven independent recovery and complete reversible cutover | 5 | 0 | Authenticated, independent off-device backups; whole-app snapshot and journal/IDB coverage; safe rollback under generation rotation and interrupted restore. Local IndexedDB checkpoint is **not** off-device. |
| Physical Safari/iOS standalone PWA interruption and restart validation | 3 | 0 | Actual-device rapid kill/relaunch, quota denial, background/foreground, multi-tab and recovery; reproducible evidence. Chromium/WebKit automation alone does not qualify. |
| Authorized final authority migration and cutover verification | 2 | 0 | Explicit user approval, green prior gates, verified authority transfer, compatibility rollback plan and no missing features. Never auto-enable. |
| **Total** | **100** | **67** | **Current estimate: 67%** |

## Definition of advancement

1. **Pass a gate, not a commit count.** Partial work within an uncredited
   gate remains documented but earns no points until the full gate passes.
2. **Real evidence required.** CI, real browser tests, negative/failure cases,
   and physical device tests where required must agree. A passed test for a
   synthetic preview is not proof for a production writer.
3. **Safety controls do not silently disappear.** Any change to recovery,
   rollback, WAL, generation, fallback, imports/exports, ratings or other user
   features requires their existing contracts to keep passing. Never delete
   features to satisfy an architecture target.
4. **V2/Main separation is mandatory.** Only work on
   `arch/state-runtime-v2-plan` in this conversation. Sync Main into V2
   only when explicitly requested; do not modify Main or merge V2 into Main
   without approval.
5. **A failed gate can reduce credit.** A regression that invalidates
   previously accepted safety evidence must lower the estimate until fixed.

## Current architecture work — full-origin rollback coverage

The earlier explicit preview recovery checkpoint covers only keys starting
with `taskpoints_`. A standalone `tp_projects_v1` write, Game preference,
or other independent localStorage key could therefore be absent from that
checkpoint even if the Habit pilot and legacy snapshot were healthy.

V2 introduces an **opt-in** `createPreviewRecoveryCheckpoint({ scope:
'full_origin' })` mode which takes an immutable, SHA-256 verified **full
localStorage origin inventory**. The V3 checkpoint binds its scope and
provenance into the integrity digest. Existing default `taskpoints_`-only
V1/V2 records remain readable without modification. Read-only inspection
reports the capture scope, and the non-mutating rollback plan flags
partial-scope records. A full-origin dry-run still returns `canApply:false`.

**Limits:** It does not capture IndexedDB databases, images or off-device
backups. It cannot exclude older/suspended V1 writers, and it neither
restores data nor grants V2 primary authority. Thus it advances engineering
within the *uncredited 5-point recovery gate*, but does not earn that gate.

## Next sequence

1. Finish and test full-origin rollback inventory and snapshot tamper/race
   handling without changing the original checkpoint default.
2. Build a mandatory writer admission route, starting with a tightly scoped
   logical action and a cross-tab failure/rollback proof; preserve the
   existing synchronous V1 durability contract during coexistence.
3. Expand authoritative store migration and journal/compatibility parity.
4. Validate whole-app recovery with independent export/backup and
   real iOS PWA cases.
5. Seek explicit approval before any live V2 authority promotion.

For current hard blockers consult
`TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers()` and
`docs/state-runtime-v2-writer-handoff-matrix.md`. No green pilot test,
short idle window or read-only peer report alone satisfies writer fencing.


## Nonpilot Tasks record migration rehearsal — November 2

V2 now upgrades its isolated `taskpoints_state_v2` IndexedDB schema
from version 2 to version 3 by **adding** a `tasks` object store.
It does not change the Habits/completions stores, their mutation ledger,
existing legacy storage, image database or the authoritative read path.
The existing V2 pilot transaction-store list remains unchanged.

The explicit localhost/branch-preview-only
`rehearsePreviewTaskCollectionSeed()` reads the **effective** V1 Tasks,
including still-pending Task journal records. It requires a valid source
journal, valid unique Task IDs, stable full-origin storage inventory,
a current V2 pilot generation, and an unchanged runtime metadata revision.
It writes individual Tasks and a separate `task-preview` evidence record
in one IndexedDB transaction. Source and store values are verified again
after commit and after reload. A repeat against the same source verifies
rather than rewriting records. If V1 Tasks have changed since the prior
preview, the old V2 evidence is preserved rather than silently overwritten.
No automatic repair/resync is allowed.

Browser tests cover the real journal overlay, per-record backfill,
verified readback, reloading, idempotent repeat, and a newer legacy-only
Task write that must block stale reseeding. A mismatch, malformed journal,
generation change, or unstable source cannot authorize a successful
preview claim. The metadata hash is not an off-device backup, an
authenticity guarantee or a new runtime authority. A task preview is
**not automatically refreshed** as users edit Tasks.

This supplies concrete **partial engineering evidence** for the
12-point nonpilot-collection milestone; it earns **zero additional
percentage points** until full write admission, completion/matchup
relationships, compatibility/export parity and real-device gates are met.
The baseline remains 67/100.


## Read-only nonpilot Tasks parity inspection — November 2

The explicit preview-host-only `inspectPreviewTaskCollectionParity()`
compares the **effective** current V1 Tasks (including pending Task journal
overlays) with every per-record V2 Task value and the original seed evidence.
It checks unique Task IDs, stable full-origin source inventory, runtime and
checkpoint generations, per-row identity, ordering and payload equality.
It returns a fail-closed diagnostic for missing seed evidence, newer V1-only
Tasks, altered V2 rows, malformed source journals or generation changes.

The inspector is strictly read-only: it does not reseed, repair, compact,
replace, or clean data. Browser regressions cover an intact preview after
reload, an updated V1 Task journal that leaves older V2 rows intact, and
corrupted V2 Task data that cannot be silently accepted or overwritten.
No normal Task interaction invokes the inspector; there is no foreground
full-origin serialization added to the live app.

**Limitations:** matching parity is an observation, not a cross-tab writer
fence or future-write guarantee. The local preview evidence is not an
off-device backup, V2 Tasks are not production authoritative, and the
12-point nonpilot collection milestone remains uncredited.


## Targeted Task record lookup in isolated V2 preview

An additional preview-only `inspectPreviewTaskRecord(id)` exercises a
single-record IndexedDB `get`, instead of loading the entire V2 Tasks
object store. It checks effective V1 Task-journal state, original source
fingerprint, reset generation, metadata, exact Task ID, legacy order index,
and the selected V2 record's payload. It handles a verified absent Task,
and explicitly denies missing seed evidence, V1 journal changes and
tampered V2 rows without repairing them.

The result has `recordVerified` but **always**
`collectionParityVerified:false`: a targeted read cannot rule out
unexpected extra rows elsewhere in the V2 store. Browser tests prohibit
`tasks.getAll()` during the targeted call and check corruption/stale-source
denial. This is future read-path groundwork only, not a foreground
optimization: source validation still requires effective V1 snapshot
parsing, and V1 remains the sole production authority.


## Atomic Task record update rehearsal — November 2

The explicit preview-only `rehearsePreviewTaskRecordUpdate(task, token, actionId)`
exercises a real single-record update in isolated V2 IndexedDB. It freezes
caller Task bytes before asynchronous hashing, requires an exact full-origin
V1 source token, an effective V1 Tasks journal snapshot, current generation,
unchanged original Task seed evidence and an unchanged original V2 Task row.
The modified Task record and a namespaced, SHA-256-bound idempotency receipt
commit in **one IndexedDB readwrite transaction**. A separate readonly
transaction verifies exact stored bytes before acknowledging durability.

A replay with the identical action ID and exact payload performs no write;
conflicting action IDs or edited Task bytes fail closed. Simulated quota
failure in the receipt write aborts the entire Task+receipt transaction, and
an explicit retry is safe. Browser tests assert V1 localStorage/journals
remain byte-for-byte unchanged and a V2-only edit causes the existing parity
inspector to report a mismatch rather than silently treating V2 as current.

**This is intentionally a divergent V2-only sandbox edit**, not a live Task
save or general migration. It does not resync to V1, amend the original seed
evidence, install any production writer hook, exclude old tabs or establish
physical-device recovery. The complete nonpilot collection milestone
remains uncredited; V1 is still the only authority.


## Isolated Task create/delete lifecycle rehearsal — November 2

The explicit preview-host-only `rehearsePreviewTaskLifecycleMutation()`
now rehearses **Task creation and deletion** in the separate V2 Tasks
object store. A validated and frozen action, exact full-origin source token,
effective V1 Task journal, matching original seed fingerprint and current
generation are required before any V2 write. A Task record change and a
SHA-256-bound retry receipt commit in one IndexedDB readwrite transaction.
Creates also advance a monotonic, generation-bound Task index counter in the
**same transaction**, preserving unique relative insertion order without an
extra whole-store read. Deleting a seeded V1 Task verifies its original
V2 record first; missing, changed and conflicting targets are refused.

Retrying identical action IDs is idempotent, with a new readonly transaction
verifying exact receipt and current Task state. Quota failure injected during
receipt insertion aborts Task, receipt and ordering counter together;
subsequent explicit retry succeeds. Browser coverage includes two sequential
creates, original Task deletion, conflicting and repeated actions, V1
byte preservation, source parity refusal and quota interruption.

This is intentionally divergent **V2-only preview storage**, not live Task
creation or deletion. The original seed evidence stays immutable, and the
read-only parity inspector must flag resulting differences. V1 primary
writes, pending journals, UI, writer admission and rollback are untouched.
The 12-point full nonpilot migration gate remains uncredited.


## Task-linked completion preview — November 2

The explicit preview-only `rehearsePreviewTaskLinkedCompletion(id, token, actionId)`
imports **one existing effective V1 Task/Work/metric completion** (including
a pending V1 Task journal upsert) into the isolated V2 completion records
store. It requires an unchanged effective V1 Task source, a uniquely
identified completion and matching V2 seeded Task row, full-origin source
inventory and current generation. The completion and a SHA-256-bound
idempotency receipt commit in a **single IndexedDB transaction**, followed
by an independent readback. It refuses preexisting completion ID collisions,
stale Task edits, different reuse of an action ID, missing V1 completion,
malformed journal and quota failures. The packed completion uses the
existing V2 row format and a non-Habit index projection, preserving Habit
pilot parity without claiming complete Tasks/Work/metric parity.

The original V1 Task journal, V1 snapshot, live Work/Sleep scoring path and
all production read/write authority remain untouched. A test-injected
receipt write failure must abort both new completion and receipt, and an
explicit retry is safe. Partial relative completion ordering is diagnostic,
not full compatibility/export parity. Old-tab writer fencing, independent
backup, real-device validation and authorization are still blocking gates.


## Atomic multi-completion preview batches — November 2

The explicit `rehearsePreviewTaskLinkedCompletionBatch(ids, token, actionId)`
extends the single completion rehearsal to bounded batches of up to 64
distinct **existing effective V1 Task/Work/metric completions**, including
rows awaiting V1 Task-journal compaction. Every linked Task must match its
original V2 seed value and index. The source inventory, V1 Task collection,
nonpilot completion classes, reset generation and all original seed evidence
are checked before the entire batch is admitted.

All packed completion rows and a SHA-256-bound batch receipt commit in
**one IndexedDB transaction**. A different action with an already-present
completion ID refuses rather than overwriting; an identical action-ID retry
is read-only and must verify every row and receipt in a fresh transaction.
A synthetic quota error at receipt insertion, after completion adds have
been enqueued, aborts all completions and the receipt as one transaction.
Browser tests cover two V1 journal-backed scores, malformed/duplicate IDs,
conflicting order, retry, failure and complete readback.

**Scope:** Only preview-host V2 records change. No live point calculation,
V1 journal/save modification, production authority transfer, global writer
fence, Task/Work/Sleep compatibility export, or full completion chronology
is established. Existing Habit pilot parity remains scoped and unchanged.


## Read-only Task completion ordering inspection — November 3

`inspectPreviewTaskCompletionOrderParity()` independently compares the
effective V1 ordered Task/Work/metric completion subset (including
uncompacted journal overlays) to isolated V2 packed completion rows.
It verifies original Task seed evidence, generation and full-origin
source inventory, scans the V2 Task and completion stores read-only,
checks exact Task payload/order, refuses incomplete or extra Task
completion rows, detects payload/sequence corruption and verifies relative
source-array order independently of timestamps. Historical ambiguous IDs
and mixed Habit/Task packed records fail closed.

The inspector reports `comparisonScope:
'existing_v1_task_work_metric_completions_only'`, plus excluded and
unsupported-nonpilot counts. Even a matching scoped comparison always
reports `fullCompatibilityVerified: false`, `canPromote: false`
and legacy-only read/write authority. It does NOT establish complete
interleaved Habit/Task chronology, export/backup parity, production writer
fencing or independent recovery. It never rewrites or auto-heals V2 or V1.
Browser scenarios cover partial import, exact completion, corrupt sequence,
unexpected extra row, and new V1 journal activity.


## V2 compatibility snapshot: interleaved V1 Task and Habit journals — November 3

The existing V2 `buildCompatibilitySnapshot()` formerly read the effective
V1 **Habit** journal, then merged V2 pilot completions into the persisted V1
completion array. It did **not** overlay the pending synchronous V1 **Task**
journal before building that snapshot. A preview export could therefore omit
recent Task/Work/metric completion upserts or deletions that had not yet
undergone V1 compaction.

The V2-only compatibility builder now clones the Habit-journal-aware V1
source and applies the **production Task-journal replay function** to that
copy before merging V2's Habit-only pilot rows. It refuses malformed Task
journal evidence and rejects source inventory, generation or mode changes
during the asynchronous V2 read. It does not alter V1 storage, the journal
writer, the existing Habit/WAL mirror or any production export path.

New `inspectPreviewMixedCompletionExport()` independently inspects the
uncompacted effective V1 mixed completion order and the V2 Habit pilot
candidate via **read-only** IDB transactions without seeding or repairing.
It compares exact payloads and array ordering, flags pilot mismatches or
stale source, and never infers promotion readiness. Browser tests cover
interleaved Habit + Task changes and malformed journal refusal. Neither
a successful scoped audit nor the compatibility snapshot establishes
full multi-collection export parity, off-device backup or writer exclusion;
`fullExportVerified` and `canPromote` remain false.


## Whole compatibility projection and reload integrity — November 3

The preview-host-only `inspectPreviewWholeCompatibilityProjection()`
performs a read-only check that a V2 compatibility snapshot would retain
**all** effective V1 JSON properties, including Tasks, settings, metadata,
nonpilot completions and exact interleaved completion ordering. It clones
the V1 source, replays pending Habit and Task journals with their existing
production logic, and reads V2 Habits and completion rows without seeding
or repairing either store. It applies only the established narrow
normalizations for Habit derived cache, missing `timeOfDay` and full
`completionFraction`. Nonpilot source values and positions remain exact.

A second read of runtime metadata (also after async SHA-256 fingerprinting)
rejects concurrent V2 revisions; full-origin inventory and generation
are checked before and after IDB reads. A matching result returns a
normalized SHA-256 fingerprint suitable for comparing the same projected
compatibility data across reloads or journal compaction. It always reports
`fullExportVerified: false` and `canPromote: false` because production
backup/import, nonpilot IDB authority, writer fencing and independent
recovery have not yet been proven.

Browser coverage verifies a pending Task edit, completion deletion and
Work/metric upserts alongside a Habit completion; full snapshot
top-level keys, mixed ordering and stable fingerprint after reload.
A transient denied V1 read must fail closed while preserving V2 Task seed
evidence, and source restoration must restore a matching projection.
No live storage write path or authority flag is changed.

The browser recovery probe injects a temporary V1 read denial, not a real
localStorage.removeItem: removal is an intentional reset boundary which
rotates the TaskPoints generation and must not be bypassed.

## Empty-seed preservation under asynchronous V1/reset races — November 3

The dark V2 seed now distinguishes an unreadable V1 snapshot from a truly
missing key, and refuses to manufacture an empty source from a denied read.
A same-generation missing V1 key preserves existing V2 evidence even when
a diagnostic caller requests `force:true`. The preview compatibility
snapshot likewise refuses to return an apparently valid empty export while
a same-generation V2 mirror survives; a generation-rotated, verified empty
seed retains its established behavior.

A further race guard rechecks dark-mode epoch, reset generation and actual V1
key absence **after** asynchronous IndexedDB opening and again inside the
seed replacement transaction callback, before any Habits/completions/WAL
clears. A competing V1 restore, second generation rotation, or V1 read denial
must abort without erasing the older V2 mirror. Regression fixtures inject
these changes both during metadata reads and inside the destructive
transaction. Existing production V1 writers and image storage are untouched.

**Scope limit:** These best-effort checks do not provide transactional
cross-tab writer exclusion across localStorage and IndexedDB. An old
nonparticipating tab could still write immediately after a check.
Physical-device validation, complete writer admission, independent backup,
and full collection migration remain uncredited. **67/100; canPromote:false.**
