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

## Targeted V2 Habit completion lookup — November 3

The existing V2 diagnostic `getCompletionsForHabit(habitId)` formerly
materialized the entire Habits object store and the completion rows just to
return one Habit's history. It now retrieves the specific Habit via
IndexedDB primary-key `get(habitId)`, while preserving the established
complete completion-row scan and filtering by Habit ID. This removes the
unnecessary whole-Habits read and clone cost from the preview lookup.

Duplicate historical completion IDs may share a packed IndexedDB record,
so the matching entries are still ordered by their persisted completion
sequence, newest first. The index is intentionally **not** trusted merely
because it exists: older rows may not have verified index coverage.
Regression cases require no `habits.getAll()`, exact mixed-Habit ordering,
a safe absent-Habit result and no persistent writes.

**Scope:** This optimizes only the opt-in V2 read API, not the live Home
page or production Habit scoring. A full completion scan remains until an
independently verified index-backed read can safely replace it. This is
incremental engineering within the existing readiness gates; **67/100**
and **canPromote:false** remain unchanged.

## Scoped Habit completion index parity rehearsal — November 3

The preview-host-only `inspectPreviewHabitCompletionIndexParity(habitId)`
compares a fully unpacked V2 completion scan to the multi-entry
`by_habit_ids` index result, reading both together with runtime metadata
in **one read-only IndexedDB transaction**. It validates the index metadata
of every stored completion pack, not only the packs the index happened to
return. Historical duplicate completion IDs and mixed-Habit packs are
preserved, with actual completion sequence order compared exactly.

A newer V2 metadata revision, invalid reset generation, changed full-origin
V1 source, missing index or inaccurate legacy index metadata must refuse
the claim without making any repair or persistence write. Synthetic tests
cover mixed-Habit packed rows, absent/inaccurate `habitIds` metadata and
a revision racing the final metadata check.

This is an **explicit O(all-completions) diagnostic**, not an optimized
foreground read. Its result does not establish current whole-app parity,
cross-tab writer admission, full export safety, or future index freshness.
The ordinary `getCompletionsForHabit` continues to use its complete
safe completion scan; a subsequent per-revision fast path still needs
separately proven freshness and invalidation. **67/100 and canPromote:false.**

## Proof-bound indexed Habit completion candidate — November 3

After a successful preview-only full-store index audit, the new
`readPreviewIndexedHabitCompletions(habitId)` can query only that Habit's
completion index, with no subsequent whole-Habits or whole-completions
IndexedDB scan. It preserves duplicate-ID packed entries and their canonical
sequence ordering. A bounded **single-Habit, in-memory** audit proof binds
the target ID, complete original localStorage origin inventory, dark-mode
epoch, reset generation, and exact V2 runtime metadata. Repeating an audit
invalidates the old proof before rescanning.

Every targeted candidate verifies current V1 inventory, generation/epoch,
indexed-row metadata, and V2 metadata both inside the initial read-only
transaction and afterward. A wrong Habit, missing/invalid proof, changed V1
source, changed revision, or read failure returns no completion rows.
Regression tests assert no V2 `getAll` calls after auditing and no writes,
plus proof invalidation under racing V1/V2 changes.

**Limits:** this is an explicit local preview probe, **not** a live app read.
It still compares full-origin localStorage inventory, which has O(origin size)
cost; therefore the no-full-scan improvement applies specifically to V2
IndexedDB access, not measured end-to-end Home latency. A noncooperating
writer that corrupts unreturned index records without updating metadata
cannot be excluded. Independent cross-tab writer admission, actual device
validation, full backup and final authority approval remain required. The
existing normal V2 `getCompletionsForHabit` safe fallback is unchanged.
**67/100; canPromote:false.**

## Index proof now requires authoritative Habit-completion parity — November 3

A correct `by_habit_ids` index could previously pass its full-V2-scan
check even if V2's completion values had independently diverged from the
authoritative V1 state. The preview index auditor now requires the selected
Habit's ordered, duplicate-preserving completion entries to also match
**effective V1**, including pending Habit journal changes and the existing
full-completion normalization rule. A V2-only extra, missing, reordered,
or altered completion must refuse proof; it is never silently repaired.

Concurrent preview audits use an in-memory audit epoch so an older
asynchronous attempt cannot republish stale proof after a later audit.
Likewise, a previously started indexed read only revokes its *own* evidence,
never a newer proof established during that read. Tests cover internally
self-consistent V2 corruption, unexpected V2-only rows, overlapping audits,
and old-read/new-audit races.

These are read-only, preview-host-only checks. They do not prove whole-app
Habit parity, forbid unfenced legacy-tab writes, provide independent backup,
or authorize indexed production reads. **67/100; canPromote:false.**

## Verified empty-reset export must contain no V2 pilot/WAL evidence — November 3

An earlier compatibility export accepted an authorized, generation-rotated
missing-V1 reset whenever V2 runtime metadata had `legacyMissing:true`.
That marker alone did not prove the IndexedDB pilot and mutation stores were
actually empty. A corrupt/partially cleaned store could therefore be hidden
behind a deceptively valid `{}` compatibility export.

The missing-V1 export now checks the runtime marker **and counts** the
`habits`, `completions`, and `mutations` stores within the **same read-only
IndexedDB transaction**, followed by a separate metadata revision check and
unchanged full-origin V1 inventory/generation guard. Nonzero retained rows
refuse the export without deleting, repairing or revealing them as valid
empty data. Unreadable counts and concurrent revision changes also refuse.

Node regression cases cover each retained store, denied count reads,
revision races and a valid empty export that performs no expensive getAll.
Chromium/WebKit browser testing simulates a legitimate reset, injects
recoverable stranded V2 evidence, and verifies export refusal and evidence
preservation after reload. **No production authority promotion.**

The original three-store version was expanded in the subsequent update
below to cover the V2 Task preview store too. This still does not prove
entire-app reset completeness or independent backup. The nine writer families,
off-device recovery, physical PWA tests, and final approval gates remain
uncredited. **67/100; canPromote:false.**

## Count-verified empty-reset parity and compatibility — November 3

An intentional reset that removes the V1 snapshot and rotates its generation
must not produce a false-positive empty compatibility export or successful
V2 parity when any recoverable pilot state or mutation ledger survives.
A shared **read-only, single-transaction** IndexedDB inspection now reads
the runtime reset marker and counts rows in `habits`, `completions` and
`mutations` without deserializing the stores. Compatibility export refuses
`{}` on retained records, denied count reads, unexpected metadata or a
revision change after the atomic inspection. The parity diagnostic now
reports `match:false` with actual retained counts instead of blindly
declaring an absent V1 snapshot a match.

Node regressions cover all three stores, count failures, revision races and
the genuinely empty reset case. Chromium/WebKit browser coverage checks a
successful authorized empty export, then injects a stranded V2 Habit record
and verifies both false-empty export refusal and parity mismatch across
a browser reload. Stranded data is preserved for investigation.

This change is restricted to diagnostic/preview operations and does
not erase retained rows or alter production V1. The subsequent four-store
expansion below also refuses retained V2 Task preview evidence. Unfenced legacy writers and asynchronous races
after the last check remain cutover blockers. **67/100; canPromote:false.**

## Broadened empty-reset inspection and browser-test correction — November 3

The previous three-store empty-reset inspection omitted V2's isolated
`tasks` rehearsal store. Although preview Tasks are **not authoritative**,
they may contain recoverable evidence from an earlier epoch and should never
be silently hidden behind a clean `{}` export. The same single read-only
IndexedDB transaction now counts all **four** V2 data/ledger stores:
`habits`, `completions`, `mutations`, and `tasks`, together with
runtime metadata. Export and parity both refuse falsely empty evidence.
The authorized-reset path does **not** delete Tasks to make the check pass.
Node tests cover stranded rows in each store; an additional Chromium/WebKit
case checks Tasks surviving a reload.

The first version of the browser reset regression deliberately removed V1
then manually wrote the generation key. That conflicted with the production
reset-boundary hook, which independently rotates the epoch on V1 removal,
so Chromium and WebKit correctly rejected the test with
`state_runtime_v2_empty_seed_context_changed`. The test now bypasses the
deferred removal hook *only within the synthetic isolated fixture* and
rotates exactly once via the supported V2 generation API. Production reset
handling was left intact. This is a browser-test fix, not a relaxation of
generation safeguards.

**Limits:** This covers IndexedDB metadata/count evidence, not all recovery
sources, image databases, independent off-device backups or unfenced old
tabs. No promotion is authorized. **67/100; canPromote:false.**

## Incremental authoritative-V1 Task collection reconciliation — November 3

The next nonpilot migration step is a **real V1-source-backed, opt-in Task
collection catch-up** (rather than another static parity check).
`rehearsePreviewTaskCollectionReconcile(sourceToken, actionId)` compares an
already-seeded V2 Task collection against current **effective V1 Tasks**,
including pending Task journal changes, and updates only the changed records
(create/edit/delete/reorder) inside **one readwrite transaction** covering
`tasks`, `meta` and `mutations`. The old baseline, new SHA-256 Task
fingerprint, exact full-origin source inventory, generation and action receipt
must agree. A new readonly transaction checks the resulting entire Task
collection and the action receipt before returning success.

The operation refuses unexplained V2-only Task modifications, a preserved
preview lifecycle ordering counter, changed V1 source, duplicate Task IDs,
conflicting action IDs, concurrent IndexedDB changes and an oversized
logical batch (more than 64 changed or deleted Task records). Quota or
transaction failures leave all records and receipts unchanged. A repeated
already-current source is read-only; V1 snapshot/journal, production scoring,
exports, Habits and old recovery paths remain untouched. Node tests cover
CRUD, order, source isolation, idempotence, restart, conflict and quota;
Chromium/WebKit rehearsals exercise **real** Task journal create/edit changes
and stale V2 evidence.

This closes an important **Task collection delta catch-up gap**: the earlier
Task seed could only populate a fresh store and would refuse a changed
source instead of incrementally mirroring it. It is nevertheless **an
explicit developer preview operation**, not automatic Task journal mirroring,
mandatory writer admission, cross-tab exclusion, background compaction
handoff, nonpilot completion ownership, whole-app migration or final
compatibility/export cutover. Those remaining criteria keep the
12-point nonpilot migration gate **uncredited**. **67/100; canPromote:false.**

## Historical Task-linked completion catch-up — November 3

A preview-only historical backlog importer,
`rehearsePreviewTaskCompletionHistoryCatchUp(sourceToken, actionId)`,
now discovers **actual effective V1 Task/Work/metric completion rows**,
including pending Task journal overlays, rather than requiring a caller to
manually enumerate completion IDs. It selects up to 64 missing unique IDs
per invocation and delegates the write to the existing atomic
`rehearsePreviewTaskLinkedCompletionBatch` receipt-backed transaction.
A success requires the batch's independent durable readback. It preserves
the pilot Habit/vice completions and V1 authority.

Before importing, the operation requires **complete Task collection parity**
with V1, a current full-origin source token, an unchanged generation, and a
full read-only V2 completion scan proving that **all already-present nonpilot
rows** match the current V1 value, ID and negative position sequence. Extra,
partially packed, colliding or different V2 evidence refuses the operation
rather than silently overwriting it. More than one completion with the same
V1 ID refuses (including duplicates across pilot scopes). Each batch reports
the imported count, remaining supported backlog, and whether independent
scoped ordering parity verifies the entire imported history. Unsupported
nonpilot completion classes cannot be reported as fully migrated.

The new executable contracts cover a complete historical import, chunked
64+2 continuation without duplicate inserts, V2 corruption, duplicate
V1 IDs, stale Task/source evidence, quota rollback and reload. Chromium/
WebKit coverage imports actual V1 Task journal completion upserts and checks
V1 unchanged plus source ordering after reload.

**Limits:** This is a bounded historical importer, not a live V1 journal
hook, a writer fence or a generalized update/delete of previously imported
completion records. A later V1 edit that changes old completion ordering
requires an explicit safe reconciliation strategy; the importer deliberately
refuses stale evidence. Other nonpilot V1 collections and independent backup
remain incomplete. **V2 67/100, canPromote:false.**


## Final caller-token guard after Task history parity — November 4

The developer-only Task-linked historical backlog importer performs a second
full-origin V1 inventory and generation/epoch check **after** awaiting the
independent scoped completion-order parity inspector. The inspector captures
its own source baseline; its success alone cannot certify that the original
backfill caller's token survived the await. A legacy-only tab may modify an
independent key (such as `tp_projects_v1`) after that inspector's final check.

The no-op/current-history case now refuses a stale or unreadable caller token
instead of returning `fullyMirrored:true`. For an already-durable V2 import,
the same late race preserves committed records and reports
`confirmedDurable:true` with `writeOutcomeUncertain:true`, never an
unqualified parity claim. Node regressions schedule an independent V1-origin
mutation at the inspector's final read and check both cases. No production
writer, scoring behavior, legacy fallback, or authority setting is altered.

This is a race-detection hardening of a **cooperative preview**, not mandatory
old-tab exclusion, a linearizable cross-store transaction, or permission to
activate V2. The weighted cutover estimate remains **67/100**.


## Fresh live V2 Task no-op parity guard — November 4

The preview Task collection reconcile's `task_preview_already_current`
shortcut previously checked that its earlier read of V2 Tasks matched recorded
metadata, then hashed those rows asynchronously before returning
`collectionParityVerified:true`. Another preview tab could mutate a V2 Task
during that await without changing the V1 full-origin token. The shortcut could
therefore confirm parity for **stale V2 evidence**.

The read-only shortcut now invokes the independent complete V1-versus-V2 Task
parity inspector immediately before claiming durable no-op success, then
rechecks its **original** full-origin source/generation/mode token after the
inspector returns. A mismatch refuses success, preserves the altered V2 row
for investigation, and writes no Task, metadata or receipt. A Node regression
injects a competing V2-only Task edit at the second SHA digest (after the
initial V2 read) to reproduce the former false-positive result.

This is a cooperative race-detection improvement for an explicit preview,
**not** cross-tab writer exclusion or a proof that V2 data cannot change
immediately after an inspection. Production V1 remains authoritative,
`canPromote:false`; no credit toward the incomplete writer-admission
gate is claimed. **V2 readiness remains 67/100.**


## Receipt-proven historical Task-completion reconciliation — November 4

The earlier Task/Work/metric preview history importer could insert missing
records but deliberately refused to overwrite old imported data after V1
edited, reordered or deleted a completion. The separate explicit
`rehearsePreviewTaskCompletionHistoryReconcile(sourceToken, actionId)`
now rehearses a bounded, all-or-nothing reconciliation of these changes.

**Admission prerequisites:** complete current effective-V1 Task parity,
a current full-origin token and reset generation, valid unique V1 IDs, no
unsupported completion types, and immutable provenance for *every* existing
V2 Task/Work/metric completion. On first reconciliation, every existing
nonpilot row must be covered by intact, nonoverlapping, SHA-256 verified
batch-import receipts. A later reconciliation instead requires its previous
atomic history seal and matching receipt. This deliberately rejects preview
only edits, incomplete historical backfills, single-record imports without
sufficient ordering provenance, mixed pilot/nonpilot packs, unknown records,
and any corrupted/extra completion instead of erasing or repairing them.

Up to 64 changed/added/deleted history rows (and at most 240 KB of affected
logical data) are reconciled in **one** IndexedDB readwrite transaction across
`tasks`, `completions`, `mutations`, and `meta`. It compares the complete
pre-transaction V2 snapshots and source token again *inside* the transaction,
preserves all Habit/vice and unrelated rows, writes a durable action receipt
plus entire nonpilot completion fingerprint seal, then performs an independent
full readback and current V1 scoped ordering parity check before success.
Deletion of the last supported completion is checked against an empty V2
nonpilot scope rather than an inspector requiring at least one record.

New Node scenarios cover edit/delete/reorder/insert, repeated no-op,
second reconciliation and reload, V2 tampering, stale V1 source, quota
rollback, action ID conflicts, altered seal and empty history. Existing
imports/exports and all V1 durability paths are unchanged.

**Limitations:** a cooperative preview recheck cannot exclude an older tab
that writes after the last check. The sealing receipt is a consistency proof,
not an independent off-device backup or a production admission fence. An
incomplete/ambiguous origin fails closed; the function does not automatically
run for ordinary Task edits, perform a live authority switch, or extend
compatibility to unsupported completion classes. No cutover gate is fully
satisfied by this step: **67/100; canPromote:false**.


## Independent Projects source preflight — November 4

Projects is a **separate V1 authority** stored by the standalone Projects
mini-app under `tp_projects_v1`, not only in `taskpoints_v1`. The normal
Projects page uses a forgiving `loadProjects()` fallback (malformed JSON
can display as an empty list). Such fallback is unacceptable as migration
evidence: it risks silently replacing unresolved data with `[]`.

V2 now exposes a **read-only, preview-host-only**
`inspectPreviewProjectsSource()` preflight. It requires dark mode, a current
reset generation, an exact full-origin storage inventory, and an unchanged
source across asynchronous SHA-256 capture. It validates the original ordered
Project array, unique nonempty Project IDs, and noncolliding valid subtask
IDs when subtasks exist, while retaining **all** source fields (including
notes, progress, timestamps and future extension fields) in the fingerprint.
It returns only counts, an integrity fingerprint and nonpromotable status,
not sensitive note content. A truly absent key and a present `[]` are
both valid *empty sources* but are distinguished by `hasSourceKey`.

Malformed JSON, non-array payloads, duplicated IDs, unreadable storage, or
writes to Projects **or any other origin key** during hashing refuse a
successful verification. The tests verify no IndexedDB or V1 writes, quota
and authority flags unchanged, race refusal and production-host restriction.

**Boundary:** this is a verified V1-source inventory, *not* a migrated
Projects record store, independent off-device backup, mandatory Project
writer fence, or permission to switch read authority. It does not modify
`projects.html`, its forgiving existing load behavior, or any TaskPoints
UI. This preparatory work earns no entire 12-point migration-gate credit.
**67/100; canPromote:false.**


## Isolated record-level Projects preview seed — November 4

V2 extends its own IndexedDB schema from **V3 to V4**, adding a `projects`
object store while keeping the original Habit, completion, Task, mutation
and metadata stores, their records and their existing production behavior.
`STORE_NAMES` remains the *pilot mutation transaction scope*, not a claim
that all other stores have moved to production authority.

The explicit preview-only
`rehearsePreviewProjectsCollectionSeed(fullOriginToken,actionId)`
uses the read-only `tp_projects_v1` source inspector as its validator.
It copies the **full original ordered Project objects** (including unknown
fields, notes, timestamps, subtasks and progress) into individual
`projects` rows, without changing V1. It is bounded at 2,048 Projects
or 2 MiB of logical rows per *single* atomic seed. Every first seed requires
the current origin inventory, unchanged V2 mode and reset generation, valid
runtime metadata, and no existing orphaned Project row or unverified earlier
source evidence. A changed V1 source refuses reseeding without altering the
existing V2 records.

One IndexedDB transaction stores every Project row, a unique mutation
receipt, and Project-source metadata with a SHA-256 source fingerprint,
full-origin inventory signature, explicit `tp_projects_v1` key-presence bit,
row count and generation. Quota errors and concurrent V2 inserts abort the
whole transaction. An independent readonly transaction verifies all rows,
the exact receipt, runtime metadata and source before reporting success.
An already seeded, unchanged source can be reverified without additional
writes. The separate read-only
`inspectPreviewProjectsCollectionParity()` compares exact record values
and ordering, metadata and the durable receipt against the current V1
Projects source, and refuses stale, corrupted or missing evidence.

**Reset safety:** The empty-reset/export and parity guard now also counts
the V4 Projects store in its same-transaction retained-evidence inspection;
a stranded preview Project cannot be hidden by an empty V1 snapshot.
Previously protected stores remain counted.

Synthetic Node tests cover V3-to-V4 schema upgrade with pilot preservation,
first seed, exact fields and ordering, replay/restart, stale V1, orphaned V2
rows, corrupted records/receipt, quota rollback, competing V2 writes,
malformed V1, absent versus explicit-empty Projects, and production-host
restriction. Chromium/WebKit regression additionally seeds real browser
Projects, reloads to verify durable parity, and refuses a later V1-only edit.

**Scope:** A V4 Projects seed is not a live Projects journal bridge,
automatic update/delete reconciliation, independent/off-device recovery,
mandatory old-tab exclusion, V2 authority switch, or full compatibility
export. The old `projects.html` page, user features, read/write paths,
backups and recovery remain in place. An older V3-only dark tab may get
a normal IndexedDB `VersionError` after V4 upgrade; V1 remains the
authoritative fallback and old V2 connections are invalidated. No weighted
cutover gate has fully passed: **67/100, canPromote:false**.


## Receipt-proven incremental Projects reconciliation — November 4

The V4 isolated Projects preview now supports an **explicit, non-authoritative**
`rehearsePreviewProjectsCollectionReconcile(fullOriginToken, actionId)`.
A V1 Project creation, edit (including notes, progress, and subtasks),
deletion, or reordering can be mirrored into existing V2 Project rows
without clearing/reseeding the entire store.

The operation first requires a valid V1 `tp_projects_v1` source, a stable
full-origin inventory, current reset generation/dark-mode epoch, and an intact
previous V2 Projects snapshot. It checks the *entire* previous ordered
Projects record set against the last SHA-256 source fingerprint, row IDs,
contiguous positions, metadata and immutable seed/reconcile receipt before
altering anything. Corruption, missing predecessor evidence, unrelated
V2-only edits or a stale V1 token all fail closed. The independent Projects
parity inspector now checks both seed and reconciliation receipts, including
their immediately preceding receipt chain.

At most **64 changed/added/deleted Project records** and **256 KiB of
affected logical row data** may be reconciled per action (total source
remains bounded by the V4 2 MiB/2,048 Project seed limits). The changed
rows, delete tombstones, immutable action receipt, and successor source
metadata are committed together inside one IndexedDB readwrite
transaction. The transaction rechecks pre-write rows, metadata, receipts,
and V1 full-origin token; a failed request/abort leaves prior V2 records
untouched. A fresh readback and a full V1-to-V2 Project parity inspection
are required to confirm durability. A true no-op independently rechecks
live parity rather than relying on an earlier digest; if only another
origin key changed, a metadata-only receipt advances the full-origin guard.
Presence versus absence of an empty `tp_projects_v1` key is retained.

New Node regression scenarios cover all four mutation types, no-op and
reload, multiple reconciliations, unchanged origin vs unrelated key change,
malformed source, corrupted Project row/receipt, quota rollback, competing
V2 writer, stale source/action ID, 65+ changes, empty/absent transitions,
broken predecessor and a race during no-op hashing. Chromium/WebKit
exercise a V1 Projects edit, receipt-proven V2 reconciliation, and a second
reload. Test completion and current CI results must be checked separately.

**Not complete:** Project writes on `projects.html` still use V1;
automatic preview import, live cross-tab writer admission, full reversible
authority switch, whole-app backups and other nonpilot collections remain
unmigrated. A cooperative prewrite check is not a fence against older tabs.
This does not advance an entire weighted gate:
**V2 readiness remains 67/100; canPromote:false.**


## V5 Today independent day-map preview — November 4

The standalone Today page stores its canonical per-day view state under
`taskpoints_today_view_v1`, **outside** the main `taskpoints_v1`
snapshot. Its existing `loadTodayDb()` tolerantly falls back to
empty objects when source JSON is malformed and normalizes invalid maps
or arrays. Reusing that fallback for a V2 import would risk silent loss
of dated task picks, inline notes, selected habits and exact drag order.

V2 now includes an independent preview-host-only
`inspectPreviewTodaySource()` read-only preflight that verifies a
stable *full-origin* inventory, current reset generation, and dark-mode
epoch before and after SHA-256 capture. It rejects malformed JSON,
unrecognized schema versions, non-object day maps, unexpected day-key
formats, non-array day values, denied storage and changed source
bytes. The preflight covers all four canonical maps
(`tasksByDay`, `notesByDay`, `selectedHabitIdsByDay`,
`orderByDay`) and **does not export note contents** in its result.
Its source limits are 4,096 distinct day keys and a 1 MiB JSON
payload. Unknown top-level extensions are retained exactly.

An additive schema upgrade to **V5** creates an independent
`todayDays` object store in the isolated V2 IndexedDB database.
The explicit `rehearsePreviewTodayCollectionSeed(token,actionId)`
copies source data to one `day:<YYYY-MM-DD>` row per distinct day
plus a `root` row containing every non-day-map top-level field
and the exact list of present maps (distinguishing missing maps
from present-but-empty maps). Missing source key, present `{}`,
present empty day maps, empty dates, notes and unknown fields are
preserved as distinct, non-destructive cases. Nothing changes
the live Today page.

Every first seed requires current pilot metadata, an exact original
full-origin token, and an empty/unclaimed V2 Today store. It saves
every per-day row, source checksum/metadata and an immutable
`today-preview-seed:<actionId>` receipt in **one IndexedDB
transaction**. An injected quota failure or concurrently inserted
V2 row aborts without partially importing anything. Repeating
the unchanged seed verifies the existing rows and receipt instead
of rewriting them. Changed V1 Today data *does not* authorize
blind reseeding or V2-over-V1 data repair.

`inspectPreviewTodayCollectionParity()` independently compares
all V2 Today rows (including sparse entries and root metadata)
with the currently captured V1 source and verifies the exact
seed receipt, runtime generation and source inventory.
Readback/parity happens before any acknowledgement. A changed
source, missing receipt or tampered V2 row refuses green parity.
New Node and Chromium/WebKit tests exercise malformed data,
sparse dates/notes, hidden top-level extensions, absent/empty
distinctions, reload/replay, V4-to-V5 upgrade, stale V1, partial
failure and concurrent V2 writers.

The verified-empty reset/export proof now **counts Today rows in the
same readonly transaction as the previous pilot, Task and Projects
stores**, refusing an empty-export success if any old V2 Today data
survives. The original `STORE_NAMES` pilot transaction list and
existing storage/rollback features remain unchanged.

**Not included:** V1 Today writer interception, incremental Today
edit/delete reconciliation, production admission of old/sleeping
tabs, automatic V2 promotion, independent off-device backups,
physical iOS proof, or complete V2 migration of Notes/Game/other
authoritative collections. V1 remains read/write authority;
`todayMigrated:false`, `canPromote:false` and the weighted
readiness estimate stays **67/100** until an entire gate passes.


## Receipt-verified Today incremental reconciliation — November 4

V5's independent Today day-map preview now supports explicitly invoked
`rehearsePreviewTodayCollectionReconcile(fullOriginToken, actionId)`.
The operation mirrors current V1 edits to dated task IDs, selected habits,
notes, order, and root extensions with **record-level additions, changes and
deletions** in the V2-only `todayDays` object store. It does not write V1
or change the behavior of the live Today page.

A source read must pass the original fail-closed Today preflight, remain
unchanged across a cryptographic digest, and be tied to the caller's exact
full-origin token and reset generation. **Before deleting or replacing any
old row**, the operation checks the last V2 snapshot's full SHA-256
`recordsFingerprint`, receipt, source inventory, row count, and immediate
parent receipt chain. A V2-only edit, stale generation, missing receipt,
invalid root, malformed day row, unexpected action ID replay, unreadable
storage, or V1 write race is refused rather than automatically repaired.
The `root` row preserves which of the four V1 maps are actually present,
and arbitrary unknown fields (including an own JSON `__proto__` key) are
retained without changing the object prototype.

Each reconcile is bounded at **64 changed/add/remove rows** and 256 KiB
of affected row payload, with the same 4,096-day/1 MiB overall source
bounds as the Today preview seed. Changed/deleted day rows, immutable
`today-preview-reconcile:<actionId>` receipt and successor metadata
are committed in a **single readwrite IndexedDB transaction** that
rechecks the prior rows, metadata, predecessor receipt, and V1 source.
Source-only inventory changes write metadata/receipt without re-saving
unchanged day rows. A true no-op independently re-proves live parity
rather than relying on an older hash.

Post-commit verification reads all updated rows, evidence, and receipt
in a single readonly transaction. The independent parity inspector now
recognizes seed, seal, and reconcile receipts, checks their immediate
predecessor integrity and SHA-256 rows, and **re-reads V2 state after
awaiting any digest**, catching intervening preview writes. A later V1
write cannot turn a stale result into an authorized cutover.

For V5 preview seeds created before the row-SHA format, the explicit
`rehearsePreviewTodayRowSeal(fullOriginToken,actionId)` can add a
new immutable `today-preview-seal:<actionId>` receipt and metadata SHA
**without changing historical day rows**. It requires *current* whole
V1-to-V2 parity and refuses any already-divergent source. The original
seed receipt remains intact. Older unsealed previews remain inspectable,
but cannot be reconciled until they pass this one-time upgrade.

Added focused tests cover additions, edits, deletions, reordering,
root-only changes, absent/present source transitions, multiple receipts,
reloads, unchanged no-ops, metadata-only updates, >64 changes, stale
sources, action ID reuse, injected add/put/delete or receipt quota
failures, competing writers, previous-row corruption, receipt-chain
tampering, digest races, legacy seal upgrade/refusal, and prototype
key preservation. The Chromium/WebKit suite now also mirrors a real
V1 Today note edit and verifies the change again after browser reload.

**No production promotion:** All new paths are explicit, preview-host
restricted, `todayMigrated:false`, `canPromote:false` and
`readAuthority:'legacy_only'`. Uncooperative old tabs, remaining
nonpilot writers, external backup/restore and physical iOS gates
are still blockers. The weighted total remains **67/100**.
