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


## Read-only dual-source Notes audit — November 4

Notes are **not** a single array or a single authoritative field. The
`notes.html` editor persists the live text in two separate V1 locations:
the `notes` field in `taskpoints_v1` and the independent
`taskpoints_notes_v1` cache. Separate dirty
(`taskpoints_notes_dirty_v1`) and authoritative
(`taskpoints_notes_authoritative_v1`) flags select the cache on
partial saves. A deliberately emptied or shortened dirty cache is
**more recent** than a longer main snapshot, so taking the longest
string or always trusting the snapshot would resurrect deleted text.

An explicit, preview-host-only `inspectPreviewNotesSource()` now
**reads both Notes locations and both markers without modifying
either**. It uses the existing `TaskPointsCore.parseTaskPointsStorageJson`
parser to handle compressed/packed main snapshots, refuses malformed
snapshot contents, non-string Notes fields, missing marked caches,
unrecognized marker values, unreadable storage, and excessive size.
The initial Notes capture verifies full-origin inventory and reset
generation before and after a SHA-256 digest, catching simultaneous
writes in older tabs. The preview reimplements the editor's exact
read-time precedence: an active dirty/authoritative cache wins even
if empty, while unmarked older installations retain their legacy
nonblank/length-based fallback.

The report contains **no Notes text**: only cache/snapshot presence,
dirty and authority state, copy agreement, lengths, source choice and
a SHA-256 fingerprint. All Notes inspection is explicitly
`notesMigrated:false`, `canPromote:false`, with V1 retaining reads
and writes. New Node and Chromium/WebKit tests exercise both-copy
parity, intentionally shortened caches, unmarked conflicts,
malformed state, missing caches, authority flag changes,
compressed parser delegation, source modification during hashing,
and the absence of any source rewriting.

**Next Notes phase:** independently record a complete Notes *source
bundle* (both copies, marker status and appropriate main snapshot
provenance) in an isolated V2 store with immutable receipts. Then
implement bounded reconciliation and full origin/restore compatibility.
Until those are proven, a Notes-source inspector is **not** a
Notes migration or a production writer fence. The weighted
readiness remains **67/100**.


## Notes dual-source immutable seed rehearsal — November 4 (V2 only)

The explicit preview-host-only method rehearsePreviewNotesBundleSeed(fullOriginToken,
actionId) takes the verified V1 Notes source audit and snapshots BOTH Notes text
copies, their presence/dirty/authoritative markers, legacy source precedence,
and SHA-256 main snapshot/full-origin provenance into a separate opt-in
IndexedDB database named taskpoints_v2_notes_preview.

The source bundle, generation-bound metadata and immutable seed receipt commit
atomically. Concurrent or stale writes, changed source inventories and failed
quota writes refuse rather than replacing existing evidence. An independent
inspectPreviewNotesBundleParity() compares the latest unchanged V1 sources with
a verified V2 preview receipt and bundle, including post-digest rereads. No
returned diagnostic contains Notes text. A repeated unchanged seed is a
validated no-op instead of a second receipt.

Preview cleanup deletes the new isolated database alongside the original V2
database, and never deletes the V1 snapshot, verified secondary, existing
image database or user backups. Node contracts cover intentionally empty dirty
caches, no-op/reload durability, missing/invalid markers, stale sources, quota
aborts in every object store, production-host refusal and race interruption.

This is a Notes source-bundle *seed*, not Notes reconciliation, live read/write
authority, off-device recovery coverage, or production old-tab writer fencing.
It does not enable V2 or count as a completed nonpilot migration gate. V1
remains authoritative and weighted readiness stays **67/100**.

Next: bounded incremental Notes reconciliation with receipt chaining, parity
across recovery/import, browser coverage and separate actual-device tests.


## Notes incremental source-bundle reconciliation — November 4 (V2 only)

Added explicit preview-host-only reconciliation method:
rehearsePreviewNotesBundleReconcile(fullOriginToken, actionId).
inspectPreviewNotesBundleParity() now recognizes SHA-256-linked receipt lineage,
instead of assuming that the original seed is forever the only receipt.
V1 keeps all Notes read/write authority. No live Notes UI calls rehearsal.

- Each reconciliation records the new source bundle, updates
  generation-bound metadata and appends an immutable receipt in ONE
  IndexedDB transaction. Prior receipts are not overwritten or deleted.
- The chain pins predecessor bundle fingerprints and SHA-256 receipt
  fingerprints, rejects orphaned/forked/cyclic/corrupted lineage, and
  preserves questionable evidence instead of silently replacing it.
- Full-origin V1 inventory and reset generation are checked before/after
  asynchronous hashing, under the write transaction and after readback.
  Uncooperative older tabs remain outside admission, blocking live cutover.
- Missing seed, malformed Notes flags, stale capture tokens, action-ID reuse,
  concurrent preview writes, intentional empty dirty caches, receipt tampering,
  quota/transaction failures and cross-generation requests all fail closed.
  Byte-identical sources become read-only verified no-ops.
- Limited to 128 total receipts including the seed, preventing unbounded
  provenance growth. A future verified checkpoint would be required beyond
  that threshold; no history is silently pruned.
- Nine new Node regression cases plus a Chromium/WebKit cross-tab browser
  scenario exercise note shortening to empty, legacy source preservation,
  durability, no-ops, reloads and interruption.

Remaining: import/restore integration, off-device backup parity, production
Notes writer admission, stale old-tab exclusion and physical Safari/iOS
standalone interruption evidence. This does NOT complete the nonpilot
migration gate, does not authorize production cutover and does not change the
V1 authority. Weighted readiness remains **67/100**.


## Real Notes UI preview validation (supplemental browser contract)

The real-Home Chromium/WebKit UI safety runner now includes a separate
scenario that opens the actual Notes editor on a disposable localhost origin,
types and saves general Notes, then deliberately clears them to the empty
string. It confirms both legacy copy paths have persisted the intentional
clear before invoking the **injected preview-only V2 runtime** (the deployed
Notes page itself remains unchanged). The preview seed and subsequent
reconcile must verify after real UI saves, preserve every live V1 byte,
reopen without resurrecting old text, and retain readAuthority=legacy_only.

This is stronger browser evidence for Notes source handling, not proof that
production Notes writers participate in a V2 admission protocol or that
iOS Safari standalone lifecycle interruptions are solved. It earns no
additional weighted milestone points.


## Notes and full-origin recovery checkpoint linkage (V2 preview only)

An explicit read-only inspector, inspectPreviewNotesCheckpointCoverage(id),
now verifies that an existing immutable full-origin V1 localStorage recovery
checkpoint is intact AND proves its exact captured Notes source inventory
matches the separately sealed Notes V2 preview bundle.

Its checks:
- Authenticate the original checkpoint record and require integrityVersion 3
  and captureScope full_origin (older namespace-only captures are insufficient).
- Require the checkpoint reset generation to match the current V2 preview.
- Verify the Notes seed/reconcile receipt lineage, including each linked
  predecessor, its cryptographic digest and current sealed bundle.
- Recompute the full-origin source token fingerprint independently from the
  checkpoint's immutable entries; distinguish source agreement with the V2
  Notes preview from agreement with the current V1 localStorage origin.
- Re-read preview evidence and V1 source after asynchronous hashes, refuse
  concurrent changes, and report only booleans/reasons rather than note text.
- Keep canApply:false and canPromote:false on every result. A valid local
  checkpoint is NOT an off-device backup, not an image/IndexedDB copy, and
  not a full-app rollback mechanism.

Regression coverage includes intentionally empty authoritative Notes caches,
a source updated after an older checkpoint, a newer reconciled Notes bundle,
a synthetic same-generation Notes import/restore, invalid/tampered local
checkpoints, partial-scope checkpoints, generation rotation, a race during
cryptographic hashing, dark-mode/production refusal and an actual Chromium/
WebKit browser fixture that exercises old/new checkpoint evidence.

This is another prerequisite for reversible migration, not completion of the
off-device backup or recovery gate. V1 remains authoritative, and the V2
weighted score remains **67/100**.


## Game-page independent preference source preflight (V2 preview)

The V2 runtime now exposes an opt-in, read-only
inspectPreviewGamePreferencesSource() method. The Game/Players page currently
writes three separate localStorage keys independently of taskpoints_v1:
taskpoints_gallery_columns, taskpoints_player_sort_mode and
taskpoints_group_active_players. A partial V2 Game migration that copied only
the players array could silently lose mobile gallery layout and user-selected
sorting/grouping.

The preview inspector retains the exact raw values in its SHA-256 source
fingerprint and checks a stable full-origin inventory and reset generation
before and after hashing. Its report contains only key-presence booleans,
validated effective options and hashes; no raw storage content. It mirrors
the current Game page's supported portrait/landscape column and sort-mode
options but *refuses* malformed explicit values instead of treating the UI's
forgiving fallback as a trustworthy storage migration.

Tests pin all three existing Game keys/options, defaults, valid settings,
malformed JSON, invalid sort/group flags, changed keys, unrelated-origin
races, denied reads, dark-disabled and production-host refusals. Nothing
writes the Game page, localStorage, any V2 store, or the canonical snapshot.
This is only a source inventory prerequisite, not Game/player storage
migration or mandatory writer fencing. The Game/editor legacy writer family
is still unfenced, canPromote stays false, and weighted readiness remains
**67/100**.


## Game/player/season preview collection — November 4 (V2 branch only)

The existing Game preference source audit is extended by explicit preview-only
rehearsePreviewGameCollectionSeed(fullOriginToken,actionId),
rehearsePreviewGameCollectionReconcile(fullOriginToken,actionId) and
inspectPreviewGameCollectionParity() methods. They store roster entries as
**ordered, individually addressable player records** in the separate
taskpoints_v2_game_preview IndexedDB database. A sibling source bundle
preserves raw current Game/Players state fields: gameHistory, matchups,
schedule, opponentDripSchedules, seasonHistory, currentSeason,
latestSeasonId, user identity/rival/color/image references, and the three
separately persisted Game preferences. Unknown fields inside player and
season/game objects are retained without normalization or pruning. Player
rows use their legacy position as the stable storage key so even duplicated
or malformed optional player IDs are not silently dropped.

A seeded or reconciled logical action updates all affected player rows,
Game bundle and source evidence, and appends a SHA-256-linked immutable
receipt in a **single IndexedDB readwrite transaction**. It refuses
unverified legacy/companion inputs, stale full-origin tokens, changed
generations, racing preview transactions, corrupt V2 records/receipts,
action-ID reuse and interrupted/denied writes. Every success requires full
durable re-read and origin/parity recheck. Up to 64 changed/removed roster
rows and 256KiB of changed-row payload can be reconciled per action; no
partial oversized mutation is applied. An unmodified Game source is a
verified no-op, not a new receipt. Maximum 128 retained immutable receipts
per preview generation, and a 2MiB initial source bundle ceiling. Exhaustion
fails closed pending a future checkpoint/compaction design.

The explicit preview cleanup page now also deletes this independent Game
database, but never deletes the V1 snapshot, backup, or image database.
New Node contracts cover full source preservation, order changes, additions,
deletions, unknown fields, season and Game history, independent preferences,
idempotence and reload, malformed source, source changes, injected quota
failures for every store, concurrent writes, tampered receipts and row data,
receipt reuse, oversize batches and host/mode denial. Chromium/WebKit
cross-tab safety now exercises an old tab changing Game player and season
fields outside the preview writer while a new tab detects stale parity and
explicitly reconciles, preserving the legacy source after reload.

**Boundary:** this only covers the enumerated Game/Season fields in the
current Game page; it does not establish all other season-sidecar paths,
images or external media bytes. It does not wire Game UI writes, authorize
independent V2 Game reads, transfer authority, fence legacy writers or
reduce current production storage size. The canonical V1 save/import/export
and recovery implementation remains completely unchanged. The nonpilot
migration gate remains incomplete; weighted V2 readiness stays **67/100**.


## Game preview compatibility, checkpoint/restore coverage and legacy evidence sealing

The Game/Players preview now distinguishes between an **absent** players
property and an explicitly **empty** players array; future exports must not
turn one into the other. New Game bundles seal the presence bit. Existing
preview bundles made before the change remain verifiable by their original
source/receipt hashes and keep their old receipts intact. The explicit
reconcile operation upgrades that legacy evidence by appending a linked
immutable receipt and sealing the presence bit, without deleting any
historical provenance or changing V1.

The read-only inspectPreviewGameCompatibilityProjection() reconstructs a
candidate from the original, parsed V1 snapshot plus the verified Game
preview player rows and all relevant Game/season fields, checks raw
independent Game preferences and full-origin freshness, then proves that
**every** top-level source field (including unrelated Tasks/Notes/settings
and unknown keys), absence/presence and ordering matches. It fingerprints
the result, re-reads V2 evidence after the asynchronous digest and never
writes, exports or restores that candidate. Older, unsealed Game previews
must reconcile before receiving a positive reconstruction verdict.

The read-only inspectPreviewGameCheckpointCoverage(checkpointId) audits a
previously authenticated immutable full-origin localStorage checkpoint:
it checks generation and original checkpoint authenticity, independently
validates the Game preview lineage, compares the checkpoint to both the
current Game preview and the **current** V1 source, verifies exact snapshot
bytes and all three independent Game preference values, rechecks origin,
checkpoint and V2 evidence after hashing, then returns only metadata.
A checkpoint that matches the Game bundle but predates unrelated origin
keys is distinguished from one that predates Game edits or a V1 restore.
A taskpoints-only legacy checkpoint cannot meet this proof.

New contracts test exact Game and unknown field preservation, missing versus
empty players, old preview sealing without loss, stale Game edits and source
races, tampered player evidence, full-origin checkpoint coverage, newer
checkpoints, unrelated-origin drift, stale V2 after synthetic V1 restore,
partial/invalid checkpoints, generation changes and production/dark guards.
The browser fixture also tests old-tab Game edits, parity failure, explicit
reconciliation, old/new checkpoint differences and reload.

All methods remain explicit, preview-host-only and V1 read/write
authoritative. Full exports, images, production old-tab exclusion, off-device
backup and real reversible cutover are still unproven. This does not
satisfy the complete nonpilot or recovery milestones, and the weighted
score remains **67/100**.


## Game/player image-reference integrity preflight — November 4 (V2 only)

Game/Players has an independently authoritative taskpoints IndexedDB
database with an images object store. Game records contain imageId
references (including youImageId), but an intact V1 snapshot, localStorage
recovery checkpoint, or Game V2 preview does not prove the referenced binary
photos are still present. A JSON-only backup may similarly retain an image
ID without including the photo itself; the separately available Settings
"Backup + Images" ZIP is not interchangeable with JSON export.

The explicit preview-only inspectPreviewGameImageCoverage() now:
- Requires current complete Game source/preview parity before examining
  any image; traverses nested player, Game and season object fields ending
  in imageId, retaining future/unknown reference fields.
- Refuses invalid/malformed raw references, >256 distinct image IDs or
  ambiguous legacy source changes instead of normalizing/dropping them.
- Requires indexedDB.databases() to confirm the live legacy taskpoints
  image DB already exists **before opening it**. An unsupported listing,
  absent DB or absent images store is a failure, never permission to
  create an empty DB. Zero references are handled without touching it.
- Fetches referenced blobs in readonly transactions and checks exact
  byte-size, MIME metadata and SHA-256 content hashes on two separate
  reads. Rejects missing referenced blobs, access failures, byte changes
  between reads and an oversized >64 MiB hashing budget.
- Re-checks full-origin V1 generation/inventory and sealed Game preview
  parity after the digest; its response contains only counts, fingerprint
  and verdicts, never image IDs, bytes or personal player details.
- Explicitly keeps externalImageBackupVerified:false,
  canPromote:false, gameMigrated:false and readAuthority:'legacy_only'.

The regression suite includes a real old-tab deletion scenario against the
legacy image store in Chromium/WebKit, plus Node source/parity checks,
no-reference behavior, missing DB/store/row, mismatched raw IDs, SHA byte
races, large reference sets, denied image reads, and preview-only guards.
It does not install new production image writers or change the core image
storage API, import/export, snapshots, existing photos, or cleanup behavior.

This audit closes one *observation* gap but does not authenticate an
independent off-device backup, guarantee atomicity between the Game
snapshot and separate photo database, or fence uncooperative legacy tabs.
No weighted migration milestone is yet completed: **67/100**.


## Full Game Backup + Images ZIP compatibility preflight (V2 only)

Added explicit, preview-host-only, non-mutating
inspectPreviewGameBackupZip(archiveBytes) for the actual stored ZIP format
from home_export_responsiveness.js, which settings.html can import.
The caller supplies a bounded Uint8Array/ArrayBuffer; V2 takes a private
immutable byte copy, never uses a file picker, never performs an import,
never creates a recovery archive, and never opens writable image storage.

Safety assertions:
- The entire stored ZIP layout is validated: uncompressed entries,
  bounded size/count, unique safe paths, CRC32 per file, matching central
  directory offsets and metadata, exact footer and no truncated entries.
- The manifest must be TaskPoints full-backup version 2 with Tasks and
  Completions arrays. Every owned Game/player/season field is checked
  against the currently sealed Game preview, including field absence,
  roster order, every unknown nested field and current season metadata.
- Every imageId reference in Game players, season and nested fields must
  resolve to an archived image file. Duplicate image IDs, malformed paths,
  missing images and unknown binary MIME types fail closed.
- Archived image bytes are SHA-256 compared to the independent read-only
  live legacy image audit. The Game preview, full-origin inventory,
  reset generation and preview-host gate must still match afterward.
- No raw photo/image identifiers, contents or player names are returned.
  No result may enable cutover, import, restore, production writes or
  promotion. An archive checked in memory is NOT an authenticated
  independent off-device recovery backup.

**Important discovered export gaps:** As currently implemented,
imageIdsFromState in home_export_responsiveness.js exports the current
youImageId and each current player.imageId, but not arbitrary historical
nested Game/season imageId references. Separately stored Game gallery,
sort and grouping preferences do not appear in the current ZIP manifest
or its aux object. The V2 audit therefore rejects archives missing an
actual historical referenced photo; otherwise it reports a matching Game
snapshot and image bytes as a *partial* success while explicitly recording
independentPreferencesIncluded:false and completeGameBackupVerified:false.
Even if manually added aux preferences are byte-identical, Settings currently
does not replay those three keys on ZIP import, so
independentPreferencesRestorable:false and completeGameBackupVerified:false
remain the only defensible outcomes. This audit does NOT claim that an
actual import/restore round-trip has occurred or will preserve every field.
It does not modify the production exporter or quietly infer coverage of
missing files or preference values.

The focused tests use the **real production ZIP writer** to generate
archives, check valid CRC/central-directory output, corrupted/truncated
or duplicated/unsafe entries, changed Game/season fields, omitted photos,
mismatched same-size photo bytes, missing independent preferences,
unexpected binary types, concurrent source changes, and no-image cases.
The real-browser fixture independently verifies the actual ZIP builder,
a failed corruption probe and old-tab Game edit detection without authority
migration. A separate browser fallback accounts for Linux WebKit refusing
Blob structured-clone writes to the synthetic legacy image store:
that path must return an unverified image audit, never false success.
Chromium exercises actual persisted Blob comparison.

As with all other V2 probes, no gate is credited until its **entire**
acceptance criteria are satisfied. The original milestones remain 67/100,
and V1 remains the only production authority.


## Isolated ZIP import reconstruction rehearsal (V2 preview only)

The new explicit rehearsePreviewGameZipRestoreInMemory(archiveBytes)
takes a ZIP already provided by the caller, requires the existing
Game preview and live-image/archive integrity checks, and then invokes
TaskPointsCore.normalizeImportedFullBackupState with detached JSON clones
and the same preserveMissingReminders/Projects:false options used by the
Settings import page. No actual Settings import is triggered.

Two independent checks are made:
1. The import normalizer's projected Game, Player, Season,
   playerBadges, and reservedPlayerPids outputs must match the same
   normalized V1 baseline. The original *raw* V1 field presence and
   values are compared separately, catching defaults added and fields
   dropped even when both sides normalize to identical output.
2. Each referenced archived image is staged in an ephemeral Map of
   copied Uint8Arrays, rehashed with SHA-256, and compared with the
   earlier, independently authenticated ZIP/live-image fingerprint.
   This does not save actual Blobs or open an image writer.

The rehearsal verifies additional player metadata fields not previously
included in the Game preview bundle; an omitted or altered reserved PID
or badge payload refuses the reconstruction. Old tabs, changed
full-origin keys, changed Game preview evidence, malformed ZIPs and
missing or changing image bytes all fail closed without repairing
anything. The API returns only safe counts and digests, no user
player/notes/photo contents or identifiers.

Production Settings uses other logic not emulated here: optional
confirmation prompts, notes/project sidecars, final save/quarantine
behavior, importing photos into IndexedDB, persistence after reload,
and independent Game preferences. Because Settings currently does not
restore those preferences and no durable full-app or off-device restore
occurs, the audit always reports
completeGameRestoreVerified:false, fullAppRestoreVerified:false,
offDeviceBackupVerified:false, canApply:false and canPromote:false.
A positive in-memory check is NOT evidence of successful production
import or a safe V2 cutover.

The added focused contracts cover the missing-normalizer guard,
detached image+Game reconstruction without writes, raw field presence,
destructive normalization, altered normalized outputs, unbacked
player PIDs/badges, corrupted/missing archive files, old-tab staleness,
source changes during hashes and disabled production guards. A
Chromium/WebKit browser check runs the actual TaskPointsCore normalizer
against the ZIP created by the production builder and rejects stale
archives after an uncooperative Game tab edit.

Weighted score remains **67/100**: full production writer fencing,
verified import/export including all sidecars/images, independent
off-device rollback, and physical iOS interruption tests are still
open gates. No Main merge or sync was requested.


## Real WebKit test synchronization — retained safety contracts

Two existing browser failure scenarios have been made more precise,
without removing any test or weakening the underlying V1/V2 guards.

- The suspended old-generation Habit journal scenario now waits until
  the other tab can observe the durable pending V1 journal **or** an
  already-persisted canonical completion. A missing journal AND
  missing completion still fails. All subsequent generation, WAL,
  replay, ordering, and V1 parity assertions remain in place.
- The real Notes UI scenario retries only bounded, explicitly denied
  pre-commit reconciliations whose source changed during its digest.
  Every attempt takes a fresh full-origin token. The accepted commit
  must leave V1 snapshot bytes untouched and pass reload parity.
  Tampered evidence, partial commits and unrelated refusals are never
  retried as successes.

These adjustments address asynchronous multi-tab propagation in
WebKit and real Notes autosave races. The actual browser workflows,
not only focused unit tests, must pass before these gates are marked
green. V1 remains authoritative and the weighted estimate stays 67%.


## Whole-backup restoration coverage audit (preview only)

The new explicit `inspectPreviewWholeBackupRestoreCoverage(archiveBytes)`
builds on the existing authenticated Game ZIP/image preflight, then independently
compares **all** raw V1 snapshot fields against the archived state. It covers
Tasks, completions, Habits, Notes, unknown future fields and field presence
rather than limiting verification to Game history and player records.
It also invokes the same Settings full-import normalizer with **detached
in-memory objects** to report two distinct failure types:

- the imported snapshot differs after Settings-style normalization;
- both sides normalize identically, but the normalizer would drop or
  replace raw original fields. Normalized parity is not raw preservation.

An explicit, bounded list of independently persisted keys is then inspected:
Notes cache and dirty/authority markers, Projects raw data, Today view, and
three Game gallery/sort/grouping preferences. The report counts source keys
missing or mismatched in the archive's auxiliary payload, *without returning
any names, values, Notes text, image IDs or other private content*.
Even if every one is supplied in a custom ZIP, the actual Settings importer
does not replay all these keys and writes ZIP photos **before** the later
confirmation to replace application state. It is not an atomic import.

The API is preview-host-only and dark-mode-only. It rechecks the entire
origin inventory, generation, host and mode around verification; malformed
ZIPs, missing live photos, old-tab races, absent Settings normalizer,
normalizer loss and unrelated snapshot field changes all fail closed. It
does not mutate V1, V2, photos or backup artifacts, and makes no claim
about an authenticated off-device recovery copy, interrupted production
restore or successful device-level replay.

The focused tests use the real production stored-ZIP builder to verify
whole-snapshot parity, missing unknown/Task fields, Notes omission,
destructive normalizers, complete-but-**unrestorable** sidecars,
missing photo bytes, an old-tab origin edit during SHA hashing, and
production-host/dark-mode denial.

**Gate state unchanged: 67/100.** This is partial diagnostic evidence within
the uncredited recovery and nonpilot-migration milestones. In particular
`independentOriginSidecarsRestorable:false`,
`fullAppRestoreVerified:false`, `offDeviceBackupVerified:false`,
`canApply:false` and `canPromote:false` remain mandatory. A safe
production importer would require separately approved writer fencing,
image staging/rollback, complete sidecar replay, independent authenticated
backups, interrupted physical-iOS restore testing, and actual durable
post-restart verification. No Main sync or authority promotion occurred.


### Mutable archive buffer race hardening

The existing Game import rehearsal and new whole-app coverage inspector now
copy the bounded input ZIP **at API entry, before the first await**. Both
use that same private immutable content for CRC validation, SHA-256 image
comparison, and detached Settings normalization. Previously, a caller who
retained a writable Uint8Array could alter the bytes during an asynchronous
hash after the Game ZIP preflight but before a second ZIP parse. This could
make two stages evaluate different caller-controlled archives.

New negative tests corrupt the caller's original ZIP header during an
in-flight SHA-256 call; both multi-stage rehearsals must continue to evaluate
only the original verified bytes. The normal ZIP parser still freezes bytes
for single-stage callers. The 64 MiB cap and all fail-closed source, image,
generation, parity and promotion checks remain in force. This is an
in-memory TOCTOU fix only, not a complete restore, persistent WAL change,
Main sync, or activation of V2. Readiness stays **67/100**.


## V6 Gold ledger collection preview — independent V2 work

Added an opt-in, preview-host-only per-record Gold ledger collection in the
existing taskpoints_state_v2 IndexedDB database (schema version 6). The
upgrade is additive: Habits, Completions, Tasks, Projects, Today, mutation
history and recovery data remain in their previous stores. The live Gold
engine, taskpoints_v1 and the separate legacy image database remain untouched.

rehearsePreviewGoldLedgerSeed(fullOriginToken, actionId) can seal one bounded,
explicit snapshot of the currently authoritative V1 goldLedger alongside the
entire goldEconomy metadata object. It preserves original transaction order
and every unknown row/metadata field. Even historically duplicated/missing
transaction identifiers are not quietly deduplicated or synthesized: invalid
sources refuse. Ledger presence and economy presence are distinct from an
explicitly present empty array/metadata object.

The source preflight rejects inconsistent ledger/economy presence, duplicate
or malformed transaction IDs, invalid metadata, excessively large snapshots,
and missing transaction rows when settled Game outcomes or economy settlement
keys prove prior Gold activity. A SHA-256 fingerprint seals raw field presence,
the ordered transactions and the complete economy metadata. The full origin
storage inventory, reset generation, dark mode and preview-host guard must
remain stable throughout the asynchronous work.

The seed commits all ordered rows, metadata and a mutation receipt in ONE
IndexedDB transaction. It refuses to overwrite orphaned Gold rows, markers
or preexisting receipts. A separate complete readback and a new parity
inspection must both succeed; otherwise the result remains unverified.
inspectPreviewGoldLedgerParity() compares every row and economy field in an
isolated readonly transaction, rechecks the source and generation, and refuses
missing/tampered receipts or any stale independent V1 Gold update.

Critical reset protection was extended: verified-empty V2 compatibility
exports and reset parity now count the Gold store alongside all existing
preview/WAL stores. A leftover Gold row is never compatible with a supposedly
empty reset, and no stale preview history is silently erased. The focused
contracts include missing/empty sources, settled-history loss, tampering,
quota rollback, old-tab changes during asynchronous hashing, orphan receipts,
dark/production-host denial, V5→V6 upgrades, and verified-empty reset guards.
The Gold tests are now included in the required V2 CI contract job.

**Not yet proven:** Gold ledger edits/additions/deletions reconciliation,
full nonpilot/Gold read authority, production writer fencing, independent
Gold+image backup/restore, iOS device interruption safety, and reversible
production cutover. Every new API returns goldMigrated:false, canPromote:false
and readAuthority:'legacy_only'. The weighted readiness score remains
**67/100** because no entire remaining gate has been completed. This is a
V2-only change; no Main sync or Main write was performed in this pass.


## Gold ledger incremental reconciliation — V2 only

The isolated V6 Gold preview now has the second explicit API
**rehearsePreviewGoldLedgerReconcile(fullOriginToken, actionId, options)**.
It is a non-authoritative rehearsal, not a production Gold writer or an
automatic mirror. V1 remains the only source of balances and transaction
history. It neither invokes the Gold engine nor modifies any legacy storage.

The operation accepts **append-only history**, full Gold economy metadata
changes, and in-place historical payload corrections only when the caller
explicitly supplies **options.allowHistoricalCorrections = true**. It refuses
shrinking ledgers, missing source keys after earlier presence, transaction-ID
swaps or reordering, and implicit history rewrites. These situations require
separate investigation rather than a convenience overwrite: no old Gold
history is silently discarded.

Before writing, it validates:

- Current complete V1 origin inventory and unchanged reset generation,
  preview host and dark-mode epoch across awaited calls.
- All existing V2 row positions and their original transaction IDs.
- SHA-256 of **all prior transaction rows and complete prior economy metadata**
  against the sealed earlier preview digest, not merely the newly captured
  V1 snapshot.
- The entire seed/reconciliation receipt ancestry, including origin
  fingerprints, row counts and generation at every link. Missing ancestors,
  cycles, orphan receipts and mismatched IDs fail closed. This is local
  integrity evidence, not an authenticated external recovery copy.
- A maximum of 64 changed rows and 256 KiB of changed-row/metadata payload
  per action. No personal transaction details are returned.

Changed rows, provenance metadata and a fresh linked receipt commit in one
**goldLedger/meta/mutations** IndexedDB transaction. A concurrent V2 write,
old-tab V1 write, quota failure, changed generation or duplicate action ID
cannot silently rebase data. After commit, independent readback and full
source-vs-preview parity must succeed. A source change following a durable
commit yields an explicitly uncertain result, never promotion. Identical
repeated checks report a verified no-op without modifying any receipts.

The focused tests cover appends across multiple generations, reload,
metadata-only changes, explicit corrections, refused deletion/reordering,
tampered old rows, lost and orphaned receipts, repeated action IDs,
quota rollback in every transaction store, simultaneous preview writes,
asynchronous old-tab source races and production/preview guards.

**Still unproven:** production writer admission/fencing, a reviewed historical
deletion workflow, independent off-device Gold+image backups and restoration,
all-sidecar recovery, full nonpilot migration, physical Safari/iOS interruption
testing, and an explicitly authorized reversible cutover. The entire 12-point
nonpilot milestone is not complete. **V2 remains at 67/100**; Gold is
non-authoritative with goldMigrated:false, canPromote:false and
readAuthority:legacy_only. No Main sync or Main modifications were made.


## Preview Habit serializer deduplication safety — November 5

The existing preview-only Habit mutation serialization guard now considers
**the entire operation-options object**, rather than only generation and
revision. A verified WAL replay request with
`skipInitialSeedForVerifiedReplay:true` can no longer reuse the result of an
otherwise identical normal mirror write. Distinct caller options are treated
as distinct requests.

If an input cannot be represented safely by JSON (such as a cycle,
BigInt, nonfinite number or function), the operation is still passed to the
original runtime **in sequence**; the guard merely disables duplicate
suppression for that request. It no longer falls back to a partial habit/date
key that could mistake two different writes for one. A rejected or
noncommitting result is never cached as successful durable work, so a quick
retry reaches the runtime rather than receiving a stale denial.

New focused regressions cover replay-vs-normal options, refused-then-retried
writes, cyclic payload collisions, non-JSON values and distinct options.
The existing adjacent identical-write optimization and A/B/A ordering
semantics remain unchanged for regular JSON-safe payloads.

This protects only the V2 preview Habit serializer. It does not fence old
tabs, replace production V1 writes, make WAL replay authoritative, prove
all other writer families or satisfy the full production writer-admission
gate. **Readiness remains 67/100**, with V1 primary and V2 unpromoted.
Main was not synced or modified.


## Record-level preservation of the independent Habit-order sidecar — November 6

The preview-only Habit order source overlay now has an **independent,
record-level IndexedDB copy**, `taskpoints_v2_habit_order_preview`. This is
in addition to the existing effective Habit mirror, not a replacement.
`rehearsePreviewHabitOrderSidecarSeed(fullOriginToken,actionId)`,
`rehearsePreviewHabitOrderSidecarReconcile(fullOriginToken,actionId)`
and `inspectPreviewHabitOrderSidecarParity()` explicitly store the raw
`taskpoints_habit_order_overlay_v1` bytes as a root row alongside
individually addressable Habit order/timestamp rows.

A complete source inventory, reset generation and source SHA-256 must remain
stable across awaits. Missing overlays and explicit empty overlays stay
distinct. Unknown future JSON fields, literal formatting, string-vs-number
values, and absent timestamp properties are retained exactly in the raw row.
A change updates only changed rows, deletes removed rows, and appends an
immutable prior-linked receipt and a new seal in one IndexedDB transaction.
Tampered or orphaned evidence, stale other-tab changes, malformed source,
quota failures, action replay and oversized batches refuse rather than
repair or drop pending data. Readback and independent parity are required.

Focused Node and Chromium/WebKit tests prove byte-preserving seed, edits,
deletions, addition, reload, stale source refusal and transaction rollback.
The V1 Habit reorder writer remains synchronous and authoritative. The
existing V2 Habit pilot, WAL, Settings, recovery, and Main are unchanged.
This is a concrete piece of the uncredited auxiliary/sidecar migration work,
**not** production-wide writer fencing, complete backup/restore, or a
milestone acceptance. Readiness remains **67/100**.

## Habit-order preview evidence inventory hardening — November 6

The independent Habit-order sidecar now rejects mismatched seal
`recordCount`/`sourcePresent` metadata and malformed receipt
change/delete counts before returning verified parity or accepting
another write. Focused regression tests tamper with each field and
check that inspection and reconciliation fail closed without editing
the stored rows, receipts or seals. Restoring valid evidence restores
parity. This is preview-only validation: V1 stays authoritative and
the production writer-fencing and real-device cutover gates remain
open. **Overall readiness stays at 67/100.**

## Independent Habit-order recovery evidence — November 6

The new preview-only `inspectPreviewHabitOrderSidecarRecoveryEvidence()`
verifies the independent IndexedDB Habit-order copy without reading the
current V1 Habit-order overlay. It checks generation, sealed SHA-256
inventory, linked receipts, and recomputes individual Habit rows from the
original raw overlay bytes stored in V2. Mixed-case Habit IDs use the same
deterministic code-unit sort as source capture, avoiding locale mismatches.

Node and Chromium/WebKit cases cover saved evidence even when the legacy
overlay is stale or missing, source parity rejecting stale copies, and
tampering detection. This **never restores V1**, copies data into production,
or grants V2 authority. It is not an off-device recovery proof, and it does
not complete writer fencing or any weighted cutover gate. **67/100.**

## Independent Notes evidence preflight — November 6

The preview-only `inspectPreviewNotesRecoveryEvidence()` verifies Notes
dual-source copies stored in isolated V2 IndexedDB **without consulting V1**.
It checks the linked immutable receipts, bundle digest, saved source presence,
authority/dirty markers, the Notes winner-selection rules, and a freshly
recomputed source fingerprint. A second IndexedDB read rejects evidence
replaced during asynchronous hashing. It never returns Notes contents.

Node tests cover disappearance of the V1 Notes cache and malformed V1
snapshot, tampered evidence, preview-disabled/production hosts and changed
generation. Chromium/WebKit browser coverage checks that stored evidence
survives stale cross-tab Notes writes and verified reconciliation.

This is a read-only, same-device partial backup check: the complete original
V1 snapshot is not stored here, no recovery is performed, and no live writer
is fenced. V1 remains primary and no weighted cutover gate is complete.
**Overall readiness stays 67/100.**

## Independent Projects recovery proof — November 6

The preview-only `inspectPreviewProjectsRecoveryEvidence()` now inspects
Project records already stored in V2 without reading `tp_projects_v1`.
It checks ordered records, unique Project and subtask IDs, SHA-256 source
fingerprint, runtime generation, the complete linked Project receipt chain,
and unlinked/altered receipts. An independent second read catches stored
evidence changing during asynchronous verification. No notes or other
Project content are returned.

Node tests cover missing/broken V1 data, several source revisions, orphan
and altered intermediate receipts, damaged V2 rows and forbidden production
hosts. Chromium/WebKit browser cases check independent V2 evidence before
and after a newer V1 edit and a verified reconciliation.

This preserves semantic Project objects, not the original V1 raw JSON bytes;
it neither creates an off-device backup nor restores data, fences writers,
or activates V2. No existing protection is removed. Both the full
collection-migration and complete-recovery gates remain uncredited:
**67/100 overall readiness**.

## Independent Today V2 recovery evidence — November 6

The preview-only `inspectPreviewTodayRecoveryEvidence()` now verifies
V2's saved Today rows **without consulting the current V1 Today source**.
It validates all four sparse day maps, unknown root fields, row uniqueness,
the exact SHA-256 row seal, reset generation and the complete seed/seal/
reconciliation receipt ancestry. Malformed day values, orphan receipts,
intermediate receipt tampering and altered rows fail closed. A second
atomic read refuses evidence replaced during async hashing.

Older unsealed V5 source copies remain preserved but cannot pass this
independent proof until the existing explicit, V1-parity-verified row seal
has been applied. New Node and Chromium/WebKit regressions cover stale or
missing V1 Today, bad rows, broken receipt chains and sealed upgrades.

The check is read-only. It neither recreates exact V1 JSON bytes, repairs
V1 Today, backs data up off-device, fences all writers nor authorizes V2
read/write cutover. **Overall readiness remains 67/100**.

## Independent Game and season recovery evidence — November 6

The preview-only `inspectPreviewGameRecoveryEvidence()` now checks the
isolated V2 Game, Players and Season bundle without reading V1 Game state
or preference keys. It verifies all saved player rows and complete receipt
history, then independently reconstructs the SHA-256 fingerprint of the
stored roster, season/matchup/history fields and all three preference values.
It refuses unsealed historical player-property presence, malformed Game
array fields or preference shapes, missing receipts and changed generations.
A second snapshot detects preview evidence replaced during hashing.

Node and real Chromium/WebKit browser tests cover intact data after V1
becomes unreadable, old-tab edits, exact roster/season/preferences changes,
tampered Game records and safe refusal outside the preview host.
No private player notes or content are returned in results.

This proves **only** the consistency of same-device preview evidence.
The V2 Game source intentionally does not hold the entire raw V1 snapshot,
and images remain in their own V1 database. It does not independently
restore photos, synchronize V1, fence old tabs, verify an off-device backup
or authorize cutover. V1 remains primary and overall milestone credit
is still **67/100**.

## Independent Gold preview recovery proof — November 6

The \`inspectPreviewGoldRecoveryEvidence()\` preflight verifies only the
sealed V2 Gold ledger and economy metadata, without consulting the live
V1 localStorage snapshot. It checks contiguous ledger rows and unique
transaction IDs, Gold-economy presence flags, SHA-256 of all ordered
ledger values and metadata, the complete seed/reconcile receipt ancestry,
runtime generation, and stability during asynchronous hashing.

Node and Chromium/WebKit tests cover malformed V1, multiple V2 appended
transaction receipts, tampered amounts, duplicated IDs, corrupt economy
metadata, middle-receipt corruption, orphan receipts and absent-versus-empty
Gold sources. The inspector cannot restore anything or show private data.

**Limitation:** a Gold loss present in both V1 and V2 is not detectable
by independent equality alone. Existing live Game-outcome and theft-pair
semantic audits remain separate. Neither audit supplies off-device
backup, performs recovery, fences production writers, or authorizes V2.
Overall readiness remains **67/100**.

## Preview-only frozen-origin legacy writer witness — November 7

Added two explicit developer/fixture APIs:
\`capturePreviewFrozenOriginWitness(id)\` and
\`inspectPreviewFrozenOriginWitness(id)\`. Only an already-frozen synthetic
V2 writer fence can admit a capture. A SHA-256 fingerprint of the complete
current origin-localStorage inventory is sealed into a **separate isolated
preview IndexedDB** witness with generation, freeze epoch, timestamp and
its own SHA integrity check. No V1 key names or values are copied.
Identifiers are immutable, bounded and not overwritten; an existing witness
is retained through reload. Capture checks that V1 and the synthetic fence
remain unchanged before and after committing; an uncertain commit is never
reported as clean evidence.

The read-only inspector independently validates the sealed witness and
recomputes the current V1 fingerprint, denying malformed or stale witness
metadata. This demonstrates that an **uncooperative V1 tab can still write
after a frozen synthetic fence**, including main snapshot, journal,
Projects, Today and Notes, and that such observed drift survives reload.
Browser regression uses an actual legacy page lacking the V2 runtime,
while Node regression tests cover duplicate capture IDs, tampering,
disabled preview and generation changes.

**Critical limits:** a matching current fingerprint does not prove writer
silence; a legacy tab could be asleep, write later or restore the same bytes.
The origin witness does not cover independent IndexedDB (notably images),
identify which tab wrote, block production writes, back up content
off-device or authorize any promotion. Existing V1 writers and exports
remain unchanged. The 11-point production cross-tab admission milestone
still earns **0**, overall **67/100**.

## Nine-family synthetic writer admission matrix — November 7

The experimental V2 IndexedDB writer fence now accepts an optional
`writerFamily` claim for one of the nine existing audited V1 save
families. These are **synthetic markers**, not real production hooks.
The caller must also provide the exact current full-origin V1 inventory;
the fence checks it before its transaction and synchronously again just
before its atomic marker write. It never persists or returns the V1 token.
Tampered family tags and replays with a different family fail closed.

A new optional `requireAllKnownFamilies:true` **preview-only** freeze
cannot complete until all nine families have durable markers in the
same IndexedDB control ledger. Existing unqualified freeze and writer
rehearsals remain unchanged. The read-only inventory audit now reports
observed counts and missing synthetic family representatives without
pretending they prove live write protection.

Node and Chromium/WebKit tests cover incomplete and complete family
rosters, stolen marker identities, malformed family tags, cross-tab stale
origin tokens, replay identity, and the crucial negative proof: a real
older page with no V2 runtime **can still save V1 after the synthetic
freeze**, even with every family represented.

**No production V1 writer is intercepted.** No background old-tab
exclusion, photo/IndexedDB coverage or cross-store atomicity is
established. Production authority stays V1, all migration and writer
fencing gates still require explicit approval, and the weighted score
remains 67/100.

## Source-bound nine-family freeze hardening — November 7

New synthetic family markers store **only** a SHA-256 fingerprint of
their V1 full-origin source inventory, never the original source bytes.
The existing source token is still checked synchronously at the atomic
writer-marker boundary. The optional strict nine-family freeze now
requires all nine families to have cryptographically fingerprinted
markers from **the same** V1 snapshot and checks that the current V1
source still matches it. Mixed revisions, stale source, legacy unbound
family markers and malformed fingerprints fail closed. Older unbound
markers remain inspectable and are never deleted or silently upgraded.

The read-only family audit distinguishes observed names from origin-sealed
claims. This prevents a fake green result when a legacy tab changes V1
between successive preview admission markers. It does not prevent an
old tab writing after a successful freeze. Real production writer paths
remain unmodified and independent IndexedDB/photos remain outside the
full-origin localStorage comparison. Writer-fencing milestone: 0/11.


## Read-only current-origin family audit — November 8

The isolated nine-family writer-marker audit now checks **two distinct facts**:
whether the recorded V1 origin digests agree with each other, and whether
those claims still match the actual current localStorage V1 origin. The
second flag, `syntheticFamilyOriginMatchesCurrent`, is false when an old
tab writes after admission or races the audit's preflight. An unreadable or
unverifiable source also cannot produce a positive match. A successful
read-only check remains only a point-in-time observation: an old V1 tab
can still save immediately afterward, and independent IndexedDB/photo
sources are not covered. Node and Chromium/WebKit regressions cover the
matching baseline and changed-old-tab source. No real writer interception,
production cutover, migration, or V1 save-path behavior was changed.

Writer-fencing weighted milestone remains 0/11; overall weighted V2
readiness stays 67/100 until a complete safety gate is verified.


## Post-commit synthetic writer acknowledgment guard — November 8

A preview writer or idempotent replay can pass its origin checks, commit an
atomic IndexedDB marker, and then race an older tab that writes new V1 bytes
before the promise resolves. The preview now checks full-origin V1 source
**again after the IndexedDB transaction completes**. If the source changed or
became unreadable, the result is uncertain and explicitly directs the caller
to inspect the durable marker before any retry. It does not claim that a
committed marker was rolled back or that the V1 write was blocked.

The normal unchanged-source acknowledgment is preserved. The guard changes
only synthetic family-owned preview writer results; existing production
V1 save paths are untouched. Node race regressions inject the old-tab write
at the exact fake-IDB commit boundary and independently reopen the saved
marker. This is a point-in-time drift check, **not** a fix for an old tab
writing after the final check. Main remains unchanged, V1 authoritative,
writer exclusion milestone 0/11 and overall completion 67/100.


## Strict preview freeze post-commit race — November 8

The optional nine-family strict preview freeze now also rereads the exact V1
origin **after** the IndexedDB freeze transaction completes. An old tab can
commit new V1 data between the atomic fence update and its acknowledgment.
If that happens (or the source becomes unreadable), the API returns an
**uncertain outcome**, directs the caller to inspect the durable fence, and
does not claim the freeze did not commit. No rollback, unfreeze, or V1
restoration is attempted. Node regressions inject both cases at the exact
fake-IDB commit boundary and prove the persisted fence and newer V1 data
remain intact. A successful point-in-time check still cannot stop an older
uncooperative V1 tab from writing afterward. Production writers are still
unfenced, V1 remains primary, and weighted readiness remains **67/100**.


## Durable strict preview freeze source seal — November 8

The isolated nine-family **strict preview** freeze now writes the exact
SHA-256 + byte-length fingerprint of its V1 full-origin inventory into the
same IndexedDB transaction as the frozen writer-fence control. This is a
fingerprint only, not a duplicate snapshot or a backup. Subsequent read-only
writer inventory audits compare this durable freeze-time fingerprint against
(1) all nine origin-bound synthetic family markers and (2) a fresh stable
full-origin V1 inventory. A mismatched or malformed control record fails
closed; a changed old-tab source reports
`strictFreezeSourceMatchesCurrent:false` rather than a clean result.

Older **non-strict** frozen fences remain readable with
`strictFreezeSourceSealed:false` and an unknown (null) current-source
verdict; no historical evidence is silently fabricated. Node tests cover
reload, drift, deliberate control-record tampering and non-strict backward
compatibility. Chromium/WebKit browser safety tests check that an old V1 tab
can still write after the strict preview freeze and that the evidence
survives a reload. Existing V1 state, backups, images, and all production
save paths remain untouched.

**Limits:** These are still synthetic markers, not live writer exclusion.
A matching fingerprint proves only a sampled point in time and cannot detect
an undetected intermediate ABA write, a dormant old tab, or independently
stored IndexedDB images. V1 remains primary, the production writer-exclusion
gate remains 0/11, and weighted overall V2 readiness remains **67/100**.


## Real Task journal + preview fence admission bridge — November 8

The new preview-host-only `rehearsePreviewFenceCheckedTaskCompletionBatch()`
is an **additive, explicitly invoked** bridge between the existing real,
atomic V1 Task completion journal adapter and the isolated IndexedDB writer
fence. It audits the complete synthetic fence inventory **before** calling
the unchanged Task batch adapter and again afterward. A fence already
frozen at entry or a corrupted inventory refuses **before any V1 journal
write**. If a concurrent freeze commits between the two audits, the
bridge preserves any durable journal write and reports an **uncertain**
result, never a falsely confirmed handoff.

Node regressions check admitted real journal batches, frozen refusal and
the concurrent-freeze race in which V1 may already be durable. Chromium
and WebKit exercise a real Task journal write before freeze and verify
a subsequent preview-fenced write cannot modify that journal.

The original preview Task adapter remains available with exactly its
previous behavior. No normal production Task, Work, SCWM, Habit, Game,
Notes, Projects, Today, import or fallback writer is routed through this
experimental bridge. The two IndexedDB/localStorage observations are
**not one atomic cross-store transaction**, and a nonparticipating or
suspended legacy tab can still write regardless of this fence. This is
proof of an initial integration seam, **not** the production-wide gate.
V1 remains authoritative; no feature or protection is removed; overall
weighted readiness remains **67/100** until a complete gate passes.


## Cooperative preview Task/freeze Web Lock — November 8

The explicitly invoked, preview-host-only V2 Task journal bridge now holds
one **shared native Web Lock** from its initial synthetic writer-fence audit
through the existing real V1 Task journal adapter and final fence audit.
A new opt-in `rehearsePreviewCooperativeWriterFreeze()` takes **the same
lock** before calling the existing isolated preview freeze. Participating
freeze and Task bridge calls cannot overlap: with `ifAvailable:true`, a
competing caller is refused before its operation starts instead of waiting
indefinitely. Existing V1 Task journal durability, exact readback, full-origin
checks, its *separate* inner journal lock, and source recovery remain intact.

Node regressions check both ordering directions: Task writing first refuses
a cooperative freeze; a cooperative freeze holding the lock refuses a Task
write; subsequent frozen Task writes remain blocked. Missing Web Locks
fails closed. Real Chromium/WebKit browser tests acquire the lock in one tab,
verify the other tab cannot write or freeze, release it, commit a real Task
journal completion, then cooperatively freeze and verify further guarded
Task writes are refused. The browser tests also prove an older V1 tab can
still write a separate Projects key regardless.

**Scope:** This protects only the two *newly cooperating preview APIs*.
The older uncoordinated preview freeze and real legacy V1 writers do not
use the shared lock, so preexisting race/uncertainty checks remain necessary.
This does not enforce cross-store atomicity, stop suspended/old tabs,
cover all nine production writer families, or authorize a V2 cutover.
Main is not changed. The writer-fencing gate remains **0/11** and overall
weighted readiness stays **67/100**.


## Interrupted Task journal write: read-only recovery evidence — November 8

The V2 preview-only API `inspectPreviewTaskBatchJournalEvidence()` accepts
a bounded serialized JSON batch and compares it to the **raw current V1 Task
mutation journal** without calling the V1 normalizer or writing storage.
It independently brackets its read with full-origin localStorage inventories.
Exact unique matches are reported as rows **currently observed** in the pending
journal; conflicting IDs, duplicate IDs, deletion markers, missing/compacted
rows, invalid records and interleaved old-tab source changes fail closed.

Critically, even a positive current-row observation sets
`confirmedDurable:false`, `safeToRetry:false` and `canPromote:false`.
A completed journal may later be compacted into the V1 snapshot, so its
absence from the *pending journal* does **not** prove an action was lost.
A matching journal row also does not prove who wrote it or that other pending
work survived. A failed or interrupted write is never automatically retried,
replayed, repaired, compacted or removed by this diagnostic.

Node regressions check restart after a real preview-admitted Task batch,
a concurrent freeze causing an uncertain write acknowledgment, conflicting
and tombstoned rows, old-tab source races and invalid inputs. The browser
regression injects a post-commit exception in the **actual V1 journal append**,
reloads, verifies the surviving raw row without changing V1, and then checks
that an old-version tab's conflicting edit is noticed. No production save
paths, main branch, backups or authority gates are changed. Weighted
readiness stays **67/100**; production writer fencing remains unproven.


## Effective Task recovery evidence across journal compaction — November 8

An interrupted Task write cannot be diagnosed from the pending V1 Task
journal alone: the existing V1 compactor may have merged the row into
`taskpoints_v1` and then removed its journal entry. The additive,
preview-host-only `inspectPreviewTaskBatchEffectiveEvidence()` performs
an entirely **read-only** comparison of bounded expected completion rows
against BOTH the current V1 snapshot and pending Task journal.

The pending V1 upsert takes precedence over a potentially older snapshot
value; an explicit pending deletion marker takes precedence over both.
The inspector distinguishes rows currently visible in the snapshot, journal
or a mixture of both, and refuses conflicting values, duplicate IDs,
malformed journals/snapshots and detectable old-tab edits during the
full-origin inventory window. It never replays, repairs, compacts or deletes
data; it reports `safeToRetry:false`, `confirmedDurable:false`,
`productionWritersFenced:false`, `canPromote:false` even when exact
current-source rows are observed.

Node regressions cover fully compacted, mixed, corrected and tombstoned
Task completions, malformed sources and old-tab races. The real browser
regression simulates ordinary journal compaction in an isolated fixture,
reloads, then checks that a conflicting newer V1 journal write from an old
tab cannot be hidden by the matching stale snapshot.

This improves **diagnosis**, not independent backup proof or writer
exclusion: exact visible rows do not reveal who wrote them, prove all
unrelated data survived, protect from a dormant old tab or guarantee physical
iPhone durability. Neither Main nor production V1 save paths are changed.
Overall credited milestone readiness remains **67/100**.


## Cooperative V1 Projects direct-key save rehearsal — November 8

The isolated V2 preview now includes
`rehearsePreviewCooperativeProjectsSave(nextProjectsRaw, token)`, a
**developer/fixture-only** direct writer for the actual independent V1
Projects localStorage key (`tp_projects_v1`). It is an additional
participant in the **same native Web Lock** already used by the
experimental Task completion bridge and cooperative freeze. No existing
production Home/Projects writer is rerouted or disabled.

The new adapter requires bounded canonical JSON with unique Project
and subtask IDs, preserving unknown fields as exact raw bytes. It refuses
malformed existing Projects data rather than silently replacing it.
Before writing it checks the complete original localStorage inventory
both on lock entry and immediately before the synchronous save, plus
generation/mode/preview fence state. After saving it requires exact raw
readback, unchanged unrelated origin keys, stable fence epoch and a final
point-in-time full-origin comparison. Postwrite errors, stale/frozen
sources and detectable non-cooperating old-tab edits have explicit
fail-closed or uncertain results; **nothing is automatically rolled
back, repaired, retried or deleted**.

Node tests cover an independent real V1 Projects-key save, preservation
of unknown fields, stale-source refusal, invalid JSON/source rejection,
an already-frozen fence, competing Task writer lock, unrelated old-tab
writes and a failure thrown *after* localStorage changed. Browser
regressions cover older-tab Projects edits, native same-origin Web Lock
contention, data persistence after reload and cooperative freeze refusal.

**Scope remains intentionally narrow:** This is only the second
experimental writer family (Task journal plus Projects direct key);
production Home, import, settings and recovery still use their existing
V1 paths, older suspended tabs still bypass the lock, and a final
snapshot check is not an atomic cross-store compare-and-swap. These
results DO NOT credit the production writer-fencing milestone (still
**0/11**), change authority, imply physical iPhone validation, or
authorize cutover. Main and existing V1 safety/recovery paths remain
untouched. Overall weighted V2 readiness remains **67/100**.


## Cooperative Today direct-key V1 writer rehearsal — November 9

The V2-only explicit preview API
\`rehearsePreviewCooperativeTodaySave(nextTodayRaw, expectedInventoryToken)\`
adds **Today day-map** storage (\`taskpoints_today_view_v1\`) to the existing
experimental shared Web Lock for Task, Projects, and cooperative freeze.
It makes an actual, synchronous V1 localStorage write **only when explicitly
called in a developer preview host**, not in production Today save paths.

The caller supplies canonical, bounded JSON and an exact, full-origin V1
inventory token from before any asynchronous work. It preserves all four
native day maps (\`tasksByDay\`, \`notesByDay\`,
\`selectedHabitIdsByDay\`, \`orderByDay\`) plus unknown custom fields, and
rejects invalid source schemas, date keys, array shapes, and unrecognized
versions. The writer refuses an already-frozen preview fence, a held
cooperative lock, any detected old-tab source modification, and any
generation/mode change before saving. It confirms exact readback and
checks unchanged unrelated origin keys plus the fence epoch afterward.
An exception after a possible durable write yields an **uncertain** outcome;
there is no rollback, deletion, retry or normalization of V1 source.

Six focused tests cover source fidelity, stale-source rejection, malformed
existing Today records, cross-family locking, freeze refusal, an old-tab
interleaving and a thrown postwrite exception. Chromium/WebKit browser tests
verify a real old-version Today write, fresh guarded Today edit, persistence
after reload, cooperative freeze refusal, shared native cross-tab Web Lock,
and the critical fact that an old tab **still bypasses the preview fence**.

**This is not production-wide protection**. The three tested explicit
preview writer paths (Task completion journal, Projects direct key, Today
direct key) do not protect Home, Settings import/reset, Notes, Game,
Habit journals, emergency recovery, or previous-version tabs. An equal
source fingerprint does not prove old tabs cannot write a moment later.
V1 remains authoritative and every existing safeguard/back-up remains.
Production writer-fencing credit stays **0/11**; overall weighted V2
readiness stays **67/100**. Main is untouched.


## Cooperative Notes dirty-cache keystroke rehearsal — November 9 (V2 only)

Notes is **not a single-key save**: \`notes.html\` uses
\`taskpoints_notes_v1\`, \`taskpoints_notes_authoritative_v1\`,
\`taskpoints_notes_dirty_v1\`, and \`taskpoints_v1.notes\`. The first
keystroke can establish two authority markers, and final synchronization
writes the V1 snapshot and clears the dirty marker. Those changes cannot
be made atomically with a localStorage multi-key operation, so claiming
a fully fenced Notes writer would risk partial or stale recovery.

The additive, **developer-preview-only**
\`rehearsePreviewCooperativeDirtyNotesCacheSave(text, fullOriginToken)\`
therefore handles the narrow safe single-key case: authority and dirty
markers must **both already be \`"1"\`**, a Notes cache must already
exist, and the V1 snapshot must be readable and valid. It only writes
the existing Notes cache key, under the same cooperative native Web Lock
used for Task, Projects, Today and preview freeze. It requires an exact
full-origin token before writing, validates the frozen preview fence and
generation, checks unchanged unrelated keys and exact cache readback
immediately afterward, and audits fence/complete inventory again before
acknowledging the cache observation.

A stale source, missing markers, absent cache, invalid snapshot, frozen
fence or competing cooperative lock prevents the write. Post-write
errors and old-tab interleavings report **uncertain** outcomes rather
than retrying or restoring potentially stale data. Empty/shortened Notes
are preserved exactly. The new result explicitly says
\`cacheReadbackVerified:true\` where applicable, but
\`notesFullySynchronized:false\` and \`confirmedDurable:false\`:
**it is not a complete Notes multi-key save or independent backup**.
Normal Notes event listeners, marker initialization, snapshot sync and
recovery paths are unchanged.

Node tests cover empty/shortened text, preserved source/markers, an
uninitialized editing session, stale source, malformed V1 snapshot,
native lock competition, freeze refusal, an older-tab write and a
simulated exception *after* localStorage commits. Browser tests cover
the live storage key across reload, old-version Notes edits after a
preview freeze, missing marker refusal and cross-tab Web Lock behavior.

This is the **fourth narrow preview participant**, not production
protection. Remaining Notes marker transitions, snapshot updates,
other writers, and dormant legacy tabs still bypass this cooperative
protocol. V1 remains authoritative; Main is untouched; all existing
features, backups and safeguards remain. Writer-fencing credit is
still **0/11** and overall weighted readiness remains **67/100**.


## Read-only Notes multi-key crash-window classification — November 9

The V2-only `inspectPreviewNotesSource()` now reports a **point-in-time**
`notesSavePhase` for six distinct Notes marker/cache states: unmarked
bootstrap, a dirty authoritative cache, a dirty marker without authority,
an authoritative cache diverging from the snapshot, matching copies, and an
authoritative cache with a missing snapshot. This distinguishes interrupted
marker transitions and still-pending snapshot reconciliation without
displaying Notes text or mutating any V1 key.

`markerTransitionMayBeIncomplete` highlights a dirty-without-authority
state. `notesMultiKeySyncVerified:false` and
`readyForNotesAuthorityHandoff:false` remain explicit for **every** phase,
including equal copies: no localStorage marker sequence proves an atomic
save, old-tab exclusion, independent backup, or physical iPhone durability.
Node tests check all six cases, byte-identical V1 and V2 after inspection,
and an old-tab marker change during digest that invalidates the report.

This does not alter Notes selection/synchronization, cache-only preview
writes, V1 recovery, imports/exports, or main. Both production writer fencing
and weighted V2 readiness remain uncredited at **67/100**.


## Sealed Notes crash-window recovery comparison — November 9 (V2 only)

The explicit, preview-host-only `inspectPreviewNotesTransitionSafety(token)`
compares the **current V1 Notes snapshot, cache, and authority/dirty markers**
against the independently sealed latest V2 Notes preview bundle and its
validated receipt lineage. It distinguishes an unchanged Notes source, an
unrelated origin-key edit, and a change to Notes itself. Separate flags show
whether the cache, snapshot Notes or authority markers changed since the
sealed observation, and identify the current Notes save phase.

Both the current full-origin source token and the entire sealed preview
lineage are rechecked around asynchronous operations. Damaged/missing
sources, tampered receipts, stale tokens and concurrent older-tab writes
fail closed. Responses expose only diagnostic flags, not Notes text.
**No V1 or V2 storage is modified by the inspector.**

Node tests cover dirty drafts, shortening, matching copies, interrupted
marker transitions, unrelated writes, stale tokens, tampering and reload.
Chromium/WebKit browser checks cover real older-tab Notes edits, sealed
preview reconciliation and reload. Even if the copies match, the report
always says `notesMultiKeySyncVerified:false`,
`safeToAutoReconcile:false`, `safeToClearDirtyMarker:false`,
`safeToRestore:false` and `canPromote:false`: same-device equality
cannot establish atomic multi-key storage or old-tab exclusion.

Production Notes handlers, Main, exports, recovery and all existing
safeguards remain unchanged. Official V2 readiness remains **67/100**
until the independent production writer-fencing, recovery and physical
iOS gates can be verified.


## Notes first-edit and final-save crash-prefix rehearsal — November 9 (V2 only)

The new explicit, developer-preview-only
`inspectPreviewNotesInterruptedSaveWindows(proposedText, fullOriginToken)`
simulates **five consecutive prefixes** of the existing V1 Notes edit/save
sequence entirely **in memory**: cache write before authority marker,
authority marker before dirty marker, dirty marker before snapshot sync,
completed snapshot sync before dirty-marker removal, and cleared dirty
marker. It uses the same legacy cache-vs-snapshot selection rules as
`notes.html`, including a deliberately shortened or emptied Notes edit.

The main finding is a concrete preexisting first-edit crash window:
when neither authority marker has yet been established, a cache-only
shortening/clear can be ignored in favor of the longer old V1 snapshot
if the browser is killed before the next marker write. An edit that
happens to be longer may remain visible under the bootstrap length
rule, but that does **not** provide atomic durability or old-tab safety.
Once the authority marker is successfully written, cache selection
can preserve intentional shortening in the modeled states.

The simulator accepts only validated V1 Notes sources and exact full-origin
tokens, uses the existing asynchronous source-digest checks, and refuses
stale, malformed, production-host and disabled-preview cases. It returns
only selected-source classifications and risk flags; neither original nor
proposed Notes text is returned. It **does not mutate any V1/V2 key,
create a database, or attempt a restore/retry**. Node tests cover
shortening/clearing, marker-established and longer-edit counterexamples,
malformed/stale sources and an old-tab race during hashing. Real
Chromium/WebKit browser tests simulate an interrupted old Notes page
after its cache write, then the authority-marker continuation, with
all storage changes confined to disposable browser fixtures.

This is a *reproducible safety diagnosis*, not a fix to the live Notes
first-edit sequence or proof of an atomic multi-key writer. Every
response preserves `safeToBeginNotesWrite:false`,
`notesMultiKeySyncVerified:false` and `canPromote:false`.
A future production protocol must preserve the old snapshot, protect
the cache before it becomes authoritative, fence all older writers,
and verify recovery across interrupted and quota-denied writes.
Main, live Notes save handlers, off-device backup and rollback remain
unchanged. Weighted readiness remains **67/100**.


## Guarded Notes first-edit recovery intent — November 9 (V2 only)

V2 now has a **developer-preview-only** synchronous recovery-intent
rehearsal: `rehearsePreviewNotesFirstEditIntent(text, originToken, actionId)`.
It establishes **one immutable intent bounded to 64 KiB of encoded JSON** in an independent
`taskpoints_v2_preview_notes_first_edit_intent_v1` localStorage key
**before** attempting to modify any canonical Notes keys. The first-edit
source must be unmarked, a current full-origin source token and generation
must match, Web Locks must be available, and the existing cooperative
Task/Today/Projects/Notes preview freeze must not be active. An existing
intent is **never overwritten**, normalized, retried, deleted or discarded
automatically. The full UTF-8 serialized record, not merely its JavaScript
character count, is capped before any storage write. Quota errors and exceptions after a possible write are
reported as uncertain and require inspection before any deliberate retry.

The sealed record includes exact proposed text, source provenance,
generation and a SHA-256 integrity checksum. The companion
`inspectPreviewNotesFirstEditIntent()` checks the stored bytes after a
restart, reports whether the live V1 cache currently matches the intent
and whether the original source inventory is still the same. It returns
**no Notes text**, performs no write, and neither replays nor authorizes
restoration from this same-device evidence. A failed, stale, corrupted,
wrong-generation or missing intent cannot be called a saved Notes action.

Node tests cover initial recording, repeat/no-overwrite, first-edit
shortening, restart, older-tab changes, quota denial, postwrite exceptions,
digest corruption, wrong generation, preview freeze and production-host
refusal. Browser tests exercise a separate older-code tab interrupted
between writing the cache and its markers, followed by reload and
read-only intent inspection; the live snapshot and markers remain intact.

**Limitations:** This rehearsal does not install a production Notes
listener, prevent old-version tabs from overwriting the cache or snapshot,
provide atomic multi-key writes, or prove off-device restore. A confirmed
intent records only that **one independent localStorage key**; it is not
confirmation that the application saved Notes, and no automatic recovery
may be attempted. For that reason `confirmedNotesDurable:false`,
`safeToRestore:false` and `canPromote:false` remain hard-coded.
No existing V1 feature, recovery lock, import/export or Main file changed.
Weighted milestone readiness stays **67/100**.


## First-edit Notes intent: read-only crash-stage diagnosis — November 9

The existing, developer-preview-only `inspectPreviewNotesFirstEditIntent()`
now classifies the **currently observed** V1 Notes save stage after verifying
the independent SHA-256 sealed first-edit intent. This can distinguish an
intent that has not reached the cache; an unmarked shortened or cleared cache
that the current Notes reader would hide behind an older snapshot; an
authority marker with snapshot synchronization pending; a dirty cache with
unsynchronized or synchronized snapshot; and matching cache/snapshot after
the dirty marker has been cleared.

The report also distinguishes damaged/unavailable current snapshots, invalid
authority/dirty markers, and a cache changed by an older tab. The sealed
intent can remain verifiable even when the current V1 snapshot is corrupted.
The report contains flags and stage labels only, **never Notes text**, and
rechecks the full localStorage inventory after source parsing and async
checks. It changes no V1 storage key, V2 database, production writer,
backup, or restore workflow.

Node tests walk each stage, including restart, invalid source, and a
conflicting older-tab cache. Real Chromium/WebKit browser tests inspect
the actual interrupted old-tab cache write before and after the authority
marker is written. Because these are **observations, not proof of the
sequence's exclusive ownership**, `canAutomaticallyResume:false`,
`safeToClearDirtyMarker:false`, `safeToRestore:false`, and
`canPromote:false` remain enforced regardless of matching copies.

This helps specify the eventual writer handoff but does not close the
production-wide old-tab fencing, independent backup, or physical iOS PWA
validation gates. Weighted readiness remains **67/100**.


## Shared-lock Notes first-edit conflict audit — November 9 (V2 only)

New preview-only `inspectPreviewCooperativeNotesFirstEditConflict(token)`
verifies the previously sealed first-edit intent and both the current full-
origin inventory and preview fence under the **same native Web Lock** used by
the Task, Projects, Today and Notes cooperative rehearsal. It double-checks
the full origin before, during and after asynchronous evidence verification,
and rechecks the fence epoch. It rejects a stale token, failed native lock,
frozen fence, changed generation, missing/corrupted intent or any observed
older-tab mutation mid-audit.

It produces one of three cautious **point-in-time observations**: original
origin unchanged; origin changed with cache matching the intended edit; or
origin changed with a different Notes cache. It never attributes a change
with certainty to a particular tab or user. Importantly,
`oldTabsExcluded:false` and `productionWritersFenced:false` remain true
**even after a successful cooperative lock**. A pre-V2 tab is under no
obligation to acquire it, and an A-to-B-to-A legacy change could evade two
identical snapshots. No code now attempts automatic recovery or changes
any of the canonical Notes, Task, Habit or Project storage paths.

Node regressions cover all three observations, reload, competing native
lock, frozen preview, an old-tab edit injected after lock acquisition and
an edit during asynchronous verification. A real Chromium/WebKit test
holds the preview Web Lock in one tab while an older-code page successfully
modifies Notes; the diagnostic then rejects the stale token and identifies
the changed cache after reload. This establishes a concrete remaining
cutover blocker rather than claiming production-wide exclusion.

All safety flags stay restrictive: no automatic resume, marker clearing,
restore, live Notes writer migration or cutover. Main remains unchanged.
The weighted V2 readiness gate remains **67/100**.


## Baseline-preserving first Notes edit protocol (in-memory rehearsal) — November 9

The preview-only `inspectPreviewNotesBaselineFirstProtocol(token)` now models a
safer **first-edit ordering** using a previously sealed, generation-bound
first-edit intent. The precise candidate sequence is: (1) sealed intent,
(2) seed the current *effective* V1 Notes into the cache, (3) mark that
baseline cache authoritative, (4) write the new intended cache value,
(5) set the dirty marker, (6) synchronize the V1 snapshot, and finally
(7) clear the dirty marker. It simulates every interruption prefix and
checks what the actual current V1 Notes selection rules would return.

Why the extra cache-baseline step matters: on legacy unmarked Notes, an
older longer snapshot may be preferred over a shorter stale cache. Writing
the authority marker **before first matching the cache to the effective
baseline** can accidentally make that stale cache win. Writing the new,
shorter cache before the marker has the opposite vulnerability: an
interruption can hide the new intended shorter edit behind the old snapshot.
The baseline-first sequence preserves the previous effective Notes until
the intended cache value is installed under an already-established marker;
a separate verified intent keeps evidence of the proposed edit during
earlier interruption steps. This is a *logical ordering improvement*,
not yet a proven safe production transaction.

The rehearsed sequence requires an independently verified first-edit
intent, unchanged complete origin inventory, valid unmarked V1 Notes,
correct generation, exact SHA integrity and developer-preview context.
It returns only per-stage booleans and labels, never original/proposed
Notes text. It writes no V1 or V2 keys and always leaves
`liveWriterActivated:false`, `canApply:false`,
`oldTabsExcluded:false`, `safeToRestore:false` and
`canPromote:false`. No real Notes handler uses the candidate sequence.

Node contracts cross-check **49 interruption states** against the actual
`notes.html` Notes reader, including missing cache, stale shorter cache,
longer cached content, empty edits, unchanged content and stale-source
rejection. Real Chromium/WebKit tests exercise each state transition in
disposable browser storage, plus reload and read-only intent inspection.

The protocol still cannot prevent a pre-V2 tab from bypassing Web Locks,
a write racing between synchronous localStorage instructions, or storage
quota/eviction. It is **not** an atomic multi-key commit, a background
recovery process, an independent backup or an authority migration. Main
and live Notes storage remain unchanged; official readiness stays **67/100**.


## Transient old-tab A→B→A storage-event witness — November 9 (V2 only)

A new explicitly opt-in, page-lifetime preview diagnostic,
`beginPreviewLegacyStorageEventWitness(fullOriginToken)`,
`inspectPreviewLegacyStorageEventWitness()`, and
`stopPreviewLegacyStorageEventWitness()`, listens for browser **storage
events from other same-origin contexts**. It captures the starting
full-origin state as a SHA-256 fingerprint and tracks only bounded counts
for Notes-related keys, unrelated origin keys and clear-origin events.
It never stores the Notes text, changed key values, plaintext inventory,
or event sender identifiers. The witness is in-memory only: after reload
it no longer claims to have seen earlier events.

The specific missing evidence this targets is a transient **A→B→A**
change by an older tab: a full-origin checksum before and after is
identical, but the listener can report that the external tab changed the
Notes cache twice while the preview was open. Asynchronous digest
rechecks refuse to report stable evidence when events or storage change
mid-inspection. Tests cover two-tab real-browser A→B→A behavior,
intermediate storage changes, quota-independent read-only operation,
unrelated-key counts, generation changes, observer teardown, and events
during SHA validation.

**Major limitation:** a missed event, sleeping tab, same-tab write, event
delivered before witness start, or event replayed after reload can escape
this observation. The browser StorageEvent is NOT a durable journal,
writer lease, source-of-truth or exclusion protocol. Absence of observed
events therefore **never** establishes that all old tabs are quiet.
Every result keeps `oldTabsExcluded:false`,
`missedEventsRuledOut:false`, `productionWritersFenced:false`,
and `canPromote:false`. Production writers, live Notes handling,
restore, Main and V1 authority remain unchanged. Weighted readiness
remains **67/100**.


## First admitted Notes edit — real cache/marker write in disposable preview only

A new explicit developer-only method,
`rehearsePreviewAdmittedNotesFirstEditCacheWrite(token, actionId)`,
now performs **real localStorage writes** to the existing V1 Notes cache,
authority and dirty marker in a disposable V2 preview origin, instead of
only simulating those steps. It requires a previously SHA-256 verified,
generation-bound, immutable first-edit intent with the exact action ID,
a current full-origin token, a clean unmarked Notes source, the existing
cooperative Web Lock and a nonfrozen durable preview writer fence.

It synchronously seeds the cache with the currently selected older Notes,
sets the authority marker, writes the intended first edit and sets dirty.
It reads back all keys and verifies that the entire rest of the origin,
including the V1 snapshot, stayed unchanged; afterward it rechecks the
preview fence and generation. A quota denial, partial write, old-tab source
change, stale token, already-marked Notes or concurrent preview lock fails
closed. The intent is never removed or replayed automatically. The dirty
marker is **deliberately not cleared**, and the V1 snapshot is untouched,
pending the existing legacy synchronization path.

Unlike prior read-only diagnostics, this tests an actual guarded writer
admission path while still keeping V1 as the sole authority. It is **not
wired to live Notes inputs**, enabled on production hosts, or enabled in
Main. Pre-V2 tabs can still bypass the shared lock; the multi-key operation
is not atomic; physical browser crash durability and independent off-device
backup remain unproven. All results keep `notesFullySynchronized:false`,
`confirmedNotesDurable:false`, `oldTabsExcluded:false`, and
`canPromote:false`. Node tests cover successful real writes, idempotent
refusal, four denial families, every write failure prefix, and unrelated
old-tab mutation; browser tests exercise real cache/marker writes and reload.

Weighted milestone gate stays **67/100** until end-to-end nonpilot writer
admission and collection parity are proven.

## Preview-only Notes snapshot synchronization continuation — November 9

The explicit developer-only `rehearsePreviewAdmittedNotesSnapshotSync(token, actionId)`
continues **after** an independently verified first Notes cache edit.
It acquires the same cooperative preview lock, checks the nonfrozen
generation-bound writer fence and sealed action intent, and verifies the
dirty cache is still authoritative. It then writes only the Notes field
of a plain-JSON V1 snapshot. All unrelated snapshot fields and the intact
signed intent, cache and authority marker are checked again afterward.
The dirty marker **stays set**. Unsupported legacy encodings are refused
instead of silently converted or overwritten.

This makes crash/reload inspection distinguish `dirty_cache_snapshot_pending`
from `snapshot_synced_dirty_pending`. It does **not** clear the dirty flag,
automatically retry an uncertain write, prove multi-key atomicity, prevent
silent old-tab writes, enable live Notes inputs or migrate production
read/write authority. V1 remains primary; Main is unchanged.

Node regressions cover cache-to-snapshot continuity, intent preservation,
stale origin, wrong action, quota denial, competing old-tab writes,
frozen fence, production-host refusal and unsupported snapshot codec.
This is progress within the uncredited nonpilot migration gate, not
evidence to raise the weighted **67/100** readiness score.

## Notes completion proof — read-only final-stage verification (November 9)

The developer-only `inspectPreviewNotesSnapshotCompletionEvidence(token, actionId)`
now checks the *post-snapshot* Notes state without changing any storage.
It requires a matching signed first-edit intent, both V1 Notes locations
selecting that text, valid authoritative and still-dirty markers, a
stable whole-origin inventory, a nonfrozen preview writer fence and
the cooperative Web Lock. It rechecks the origin and fence after async
verification and rejects any observed external storage events from
an optionally active page-lifetime witness.

A passing result proves only that the cache and snapshot match **at the
time of inspection**; it does not prove the old V1 tabs are excluded,
storage events were not missed, the prior app state was transactionally
protected, the dirty marker can be safely removed, or a physical iOS
process kill is durable. `safeToClearDirtyMarker:false`,
`oldTabsExcluded:false`, `canPromote:false` and V1 authority remain fixed.

Node tests cover snapshot-not-yet-synced, positive replay after reload,
older-tab post-sync overwrite, wrong action, tampered intent, frozen fence,
production-host refusal and observed external event. Browser tests check
reload, a transient old-tab change and a later snapshot overwrite while
preserving the independent task and the dirty marker.

This is still progress within an uncredited cutover gate. The weighted
completion score stays **67/100**; Main has not been changed.

## Original-snapshot-bound Notes admission — November 9

V2 preview first-edit intent schema 2 now signs the SHA-256 fingerprint
of the **exact original raw V1 snapshot**, including non-Notes fields.
The guarded Notes snapshot continuation requires that original snapshot
to still match before replacing only Notes. If an older V1 tab has edited
a Task, Habit, or Notes field in the snapshot, a newly recaptured origin
token is **not** sufficient to authorize overwriting it. The operation
refuses before its first snapshot write and retains the immutable intent
and dirty marker. This closes a previously uncovered re-tokening race.

Existing signed schema-1 preview intents remain read-only inspectable
for diagnosis and recovery evidence, but cannot acquire this stronger
snapshot-write admission without the original snapshot attestation.
No automatic replay, marker clearing, hidden format conversion, or live
Notes integration is introduced. This protection is limited to disposable
preview origins; old browsers remain able to bypass cooperative Web Locks
and independently mutate V1 after inspection.

Node and Chromium/WebKit browser contracts cover retokened old-tab
snapshot changes. The change improves an **uncredited gate** and does
not establish production-wide writer fencing, full Notes migration,
physical device durability or permission to promote. Overall remains
**67/100**, and Main is unchanged.

## Exact legacy snapshot representation guard — November 9

The developer-preview Notes snapshot continuation now refuses an existing
raw V1 JSON snapshot unless JSON parsing followed by serialization reproduces
**exactly the same bytes**. This prevents a Notes-only save from inadvertently
normalizing unrelated snapshot data (duplicate object keys, pretty-printing,
escaped characters or numeric values that lose precision). The signed
original-snapshot fingerprint is still verified *before* the codec check.

Noncanonical data remains in the original V1 key, unchanged. The signed Notes
edit intent, cache, authority and dirty recovery marker remain intact. The
writer does not attempt a snapshot setItem; there is no automatic retry,
conversion or recovery-marker clearing. The preview guard is intentionally
conservative: unusual but valid JSON must use the actual legacy serializer,
not this synthetic writer.

Node regression scenarios cover formatted data, duplicate keys, Unicode
escapes and unsafe-precision numbers. Real Chromium/WebKit scenarios cover
noncanonical data surviving refusal and reload. The preview-only guard does
not resolve uncooperative old tabs or establish production cutover authority.
The weighted readiness gate remains **67/100**. No change to Main.

## Cross-tab event witness checked by Notes preview writers — November 9

The opt-in, page-lifetime legacy `storage` event witness is now consulted by
the **actual preview Notes writers**, not only by read-only completion
inspection. When the witness is active, an observed external storage event
(including a temporary A → B → A change with identical before/after
inventories), invalidated generation, or invalidated dark-mode epoch refuses
the preview Notes first-edit intent, cache/authority/dirty writer, or snapshot
continuation **before any new write**. If an event is observed while a writer
is completing its post-write fence audit, the operation reports an uncertain
result rather than acknowledging success. The dirty recovery marker remains
set after a started Notes edit.

The witness is not mandatory and its silence cannot rule out dormant older
tabs, missed/suppressed storage events or non-cooperating legacy writers. This
does **not** constitute cross-tab authority fencing, atomic Notes multi-key
storage or a green light to clear the dirty marker or promote V2.

Node regressions cover intent, cache, snapshot and midwrite event failures.
Chromium/WebKit safety tests exercise a real second tab changing another
localStorage key and restoring it before snapshot admission, while the
signed Notes edit and recovery flag remain inspectable after reload.

This remains an uncredited migration/fencing increment. Weighted milestone
readiness is **67/100**, with V1 authoritative and Main untouched.

## Two-edit Notes preview continuity — November 9

The first Notes edit already had a sealed first-edit intent, baseline-first
authoritative cache write, and separate V1 snapshot synchronization. A second
edit previously could use the generic dirty Notes cache path, but lacked its
own immutable crash-recovery intent and end-to-end sync evidence.

Three additional developer-preview-only methods now exercise a *second*
independently sealed edit:

- `rehearsePreviewNotesFollowupIntent(text, token, actionId)` records a
  new signed, immutable intent **only after the first edit's cache and snapshot
  match with the dirty recovery marker still set**. It binds the exact
  full-origin inventory, the original snapshot, the prior cache, generation,
  first action ID, and the proposed text. The original intent is untouched.
- `rehearsePreviewAdmittedNotesFollowupCacheWrite(token, actionId)` admits
  only that exact action and writes just the already-authoritative dirty
  Notes cache, with lock, writer-fence, source digest, storage-event witness
  and post-write checks. Interrupted or quota-denied writes remain inspectable
  and are never automatically replayed.
- `rehearsePreviewAdmittedNotesFollowupSnapshotSync(token, actionId)`
  later updates **only** the Notes field of the canonical, unchanged V1
  snapshot. It reconstructs the sealed original full-origin inventory by
  substituting the first intent's text for the now-updated cache, so a newly
  supplied token cannot bless an old tab's unrelated edits. It refuses
  noncanonical/encoded source, stale snapshots, marker loss, missing locks,
  witness events, frozen fences, quota errors, or unverified readback.
  It deliberately leaves both signed intents and the dirty marker untouched.

`inspectPreviewNotesFollowupIntent()` is read-only and distinguishes the
intent-recorded, cache-saved/snapshot-pending, and snapshot-synced/dirty-pending
stages across reload. Lost dirty or authority markers are explicitly reported,
**not** mislabeled as synchronized. No method automatically resumes a save.

Node regressions check interrupted stages, quota failures, old-tab edits,
newly captured stale-source tokens, replay refusal, tampered intents, reload,
lost marker conditions and unrelated Task preservation. Real-browser tests
rehearse two edits separated by a browser restart, with explicit second
snapshot sync and a second reload.

This remains a **bounded two-edit preview**, not the production Notes input
route and not an indefinite Notes edit protocol. Old legacy tabs are not
excluded, storage events can be missed, no atomic multi-key durable commit
or physical-device durability is proven, and the dirty marker cannot be
safely cleared. V1 remains the only authority. Weighted cutover readiness
remains **67/100**, and Main is untouched.

## Bounded reusable Notes edit journal — November 9

The previously demonstrated first and second Notes edits had separate,
immutable signed intent records. V2 now adds a **single bounded, append-only
preview journal** for further sequential edits, rather than inventing a
new storage key per edit:

- `rehearsePreviewNotesRepeatEditIntent(text, token, actionId)` admits a
  new signed journal entry only after the previous edit's cache and V1
  snapshot are synchronized and the legacy authoritative/dirty markers
  remain intact. It binds the exact origin inventory excluding the journal,
  prior Notes cache, original snapshot, previous action ID and proposed text.
  It refuses duplicate action IDs, an unfinished preceding edit, tampered
  entries, inconsistent generation and an already full journal.
- `rehearsePreviewAdmittedNotesRepeatCacheWrite(token, actionId)` writes
  the single authoritative Notes cache key only when the newest signed
  action, full-origin provenance, original snapshot, cooperative lock,
  nonfrozen writer fence and optional storage-event witness agree.
- `rehearsePreviewAdmittedNotesRepeatSnapshotSync(token, actionId)` writes
  only the Notes field of a canonical, unchanged V1 snapshot. The
  immutable admission fingerprint is checked against the present full
  origin **with the previous Notes cache text reconstructed**; a freshly
  captured token cannot authorize erasing Tasks or Projects from an
  uncooperative older tab.
- `inspectPreviewNotesRepeatEditJournal()` is strictly read-only. It
  distinguishes a pending intent, cache-written/snapshot-pending,
  synchronized/dirty-pending, missing recovery markers and invalid journal
  stages across reload. It never exposes saved note text or applies it.

Journal admission is limited to **16 additional actions** and a total
of **256 KiB** of serialized history, with 64 KiB maximum Notes text per
action. These are conservative preview limits to prevent unbounded local
storage growth; hitting either limit fails closed without deleting
earlier actions or clearing the dirty recovery marker. No automatic replay
or compaction is authorized.

Node tests exercise three or more consecutive edits, the 16-action limit,
crash/reload, duplicate identifiers, quota denial, tampering, altered Tasks,
re-tokened old-tab changes, midwrite races and storage-event warnings.
Chromium/WebKit browser checks exercise repeated edits separated by reload
and a subsequent stale old-tab update.

**This is a reusable synthetic preview, not a production cutover.** Existing
live Notes editors are not redirected. V1 remains authoritative; older
tabs may bypass locks, the multi-key sequence is not atomic, physical
iOS durability and independent recovery are not established, and the
dirty recovery marker stays set. The weighted milestone rubric remains
**67/100**, with the nonpilot migration and production-wide writer-fencing
gates still uncredited. Main is unchanged.

## Repeat Notes journal provenance checks — November 9

The bounded preview Notes journal is now checked for **meaningful edit
continuity**, not just the signed container checksum. Every entry must name
the preceding action, use that action's exact intended text as its
`previousText`, and carry the correct SHA-256 for that prior cache value.
This prevents a malformed or re-signed journal with inconsistent ancestry
from being treated as a usable recovery history.

The read-only `inspectPreviewNotesRepeatEditJournal()` additionally checks
the **current whole-origin state against the newest action's original
admission fingerprint**. It reconstructs the prior Notes cache (and, only
when the second location was already synchronized, the prior canonical V1
snapshot Notes field) *in memory*, then checks exact origin and snapshot
digests. It never overwrites the Notes cache, V1 snapshot, marker or journal.

An independently updated legacy Task/Project/other storage key now reports
`repeat_source_diverged` rather than a misleading fully synchronized
recovery stage. Likewise, missing authority or dirty recovery markers
remain explicitly unsafe. The audit separately reports whether the
historical journal itself is internally verified and whether the
current origin still matches the latest admission; neither result permits
automatic replay, dirty-marker clearing, or authority transfer.

Additional Node tests cover correctly re-signed but logically broken edit
chains, false prior-cache fingerprints, three recovery stages, post-sync
old-tab edits and marker loss. The browser regression also verifies a
restored old-tab Task is recognized as source divergence, not safe sync.

This is diagnostic hardening **inside** the uncredited nonpilot migration
gate. The cutover estimate stays **67/100**, with V1 authoritative, V2
preview-only, and Main unchanged.
