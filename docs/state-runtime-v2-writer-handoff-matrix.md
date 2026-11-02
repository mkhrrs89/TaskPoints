# V2 authority handoff — read-only V1 writer matrix

Updated: 2026-10-28 · V2 branch only · **NOT APPROVED FOR CUTOVER**

## Purpose and scope

This audit identifies eight **known, currently unfenced** V1 writer families and
44 **source-evidence anchors** across eight V1 runtime files. An anchor can be a
writer, fallback, lifecycle callback, journal compaction step or shared entry
point; **44 does not mean 44 independent or exhaustive writers**. The
classification is checked by
`tests/state_runtime_v2_writer_handoff_matrix_contract.test.js`, run in the
focused V2 contract CI stage. The preexisting broader sink scanner is retained.

A passing static scan cannot establish writer coverage: dynamic aliases,
indirect helpers, new page bundles, service workers, another window running
**older code**, browser process termination and external extensions are outside
its proof. Existing WAL wrapping and the isolated IndexedDB preview fence
**do not** fence every V1 path. `inspectAuthorityCutoverBarriers()` must keep
`all_legacy_writers_not_fenced`, `allLegacyWritersFenced:false`, and
`canPromote:false` until a separately verified production protocol exists.

## Known writer families (all remain unfenced)

| Runtime owner | Concrete live paths | Present V1 durability/recovery rule | Handoff prerequisite |
| --- | --- | --- | --- |
| **Core snapshot and Habit journal** — `scoring_core.js` | `safeReplaceTaskPointsStorage()` synchronous replacement; `writePendingHabitDelta()` primary journal plus separate event sidecar; `clearCompactedHabitDeltas()`; startup/idle Habit compaction; deferred `runPendingInteractiveRecompress()` on `pagehide`/visibility | Existing direct `setItem`, durable pre-paint Habit tap, verified journal cleanup, byte-identity check on deferred re-encoding | Preserve synchronous tap durability; include every journal and sidecar; transactional generation rejection; safely drain/abort background work |
| **Home** — `index.html` | `save()` and last-ditch/cached save; `resetAll()`; direct `tp_projects_v1` and Today view; Habit tap journal/fallback; Task completion journal; pending Habit compaction | Foreground journaling precedes paint; fallback and reset are independent paths | Prevent stale Home state and fallback resurrection; fence Task/Habit journals, direct keys, reset, and maintenance together |
| **Game/player editor** — `game.html` | `saveState()` via `TaskPointsCore.saveAppState`/`mergeAndSaveState`; scheduled matchup and roster changes; YOU/NPC rival and color edits; separate gallery columns, group-active, and sort preferences | Existing synchronous V1 snapshot save path and independent UI preference keys | Include game page and direct keys in writer admission, generation fencing, freshness checks and rollback; a Home-only fence is insufficient |
| **Today** — `today.html` | `saveApp()` snapshot and `saveTodayStore()` direct `TODAY_STORE_KEY` | Direct Today view can change independently of core snapshot | Preserve view data and current-day ordering across cross-tab migration |
| **Settings/import/reset** — `settings.html` | `saveValidatedSnapshot()` full import, direct `tp_projects_v1` import, reset/removal, manual compressed raw replacement and rollback, notes authority flags | User-confirmed destructive replacement and manual rescue/rollback | Independent rollback checkpoint, user-confirmation/recovery semantics, generation rotation, no bypass via direct-key import |
| **Notes** — `notes.html` | Direct `NOTES_STORAGE_KEY`; `saveAppState` or `writeTaskPointsStoredState()` fallback; notes authoritative/dirty flags | Notes are dual-stored, and dirty/authority markers control reconciliation | Treat content and flags as one logical unit; no silent loss of newer notes or dirty intent |
| **Emergency recovery** — `emergency_recovery.html` | Recovery hold and V2-mode-off flags, `safeReplaceTaskPointsStorage()`, phase journal quarantine/removal, Habit journal reset, verification | Recovery can intentionally replace the entire V1 source and keep hold active | Preserve emergency access and independent off-device rollback; never block rescue solely because V2 fence DB is unavailable |
| **Task journal/idle compaction** — `task_mutation_journal.js` | `journalMutation()` sync journal write; `scheduleCompaction()` / `runWhenQuiet()` deferred work; `saveStateSnapshotWithTaskJournal()` wrapping; verified cleanup | Sync journal precedes UI feedback; read overlay and deferred compaction protect pending Task changes | Must cover journal+overlay, completion updates and deletes, generation checks, quiet/idle failures, and compaction retry |

## Main sync writer coverage expansion (October 28)

The October 28 Main sync brought player-rival and other Game page changes
into V2. The preexisting seven-family audit did not explicitly name
`game.html`, despite its `saveState()` calls and three independently stored
preference keys. The audit now pins six Game anchors and reports an eighth
**unfenced** V1 writer family. This is read-only evidence, **not** a Game
writer fence, a player-data migration or permission for V2 cutover.
Paused Game tabs and old deployed code remain unfenced. The cutover report
must still keep `canPromote:false` and `allLegacyWritersFenced:false`.

## Task-journal handoff preflight: explicit read-only blocker

The V2-only `inspectAuthorityCutoverBarriers()` now reads
`taskpoints_pending_task_mutations_v1` **twice**, surrounding the asynchronous
peer probe and full-origin storage inventory. It reports
`taskJournal.reason` as `absent`, `empty`, `pending`, or `malformed`,
and reports separate Task, completion-upsert, and completion-delete counts.
Any pending record adds `task_mutation_journal_pending`; malformed rows or
schema add `task_mutation_journal_malformed`. Denied reads continue to refuse
the entire inspection. `checks.taskJournalEmpty` is true only for an absent
or structurally valid empty journal; it **does not** grant a cutover.

The raw journal bytes are compared in the observation window, but are not
returned to callers. A Tab A/Tab B regression uses the actual synchronous
`TaskPointsCore.journalTaskMutation()` write during the peer probe; the
inspection must reject its stale preflight and leave the journal intact.
Another test confirms malformed journal evidence is not silently normalized
into an empty handoff. These tests never flush, compact, delete, restore, or
migrate Task journal records.

**Still unsafe for authority:** A read-only check is not transactional
admission. An old tab can write immediately after the second read, and a
Task journal can change and change back between reads. This preflight must
remain diagnostic until all synchronous Task entry points and deferred
compaction participate in a verified generation-fenced protocol, without
weakening the current durable-before-paint experience.

## Real Task journal compaction and stale-tab rehearsal

The next V2-only browser safety cases exercise the **existing production V1
Task journal implementation**, without changing its code or admitting writers
to the preview fencing protocol:

- A real `journalTaskMutation()` persists a Task patch plus a completion
  upsert. A real `flushPendingTaskMutations()` then writes the canonical
  snapshot, verifies both rows, and removes the covered journal records.
  The read-only cutover inspector reports an empty/absent Task journal, but
  still reports `canPromote:false`.
- An injected `QuotaExceededError` on the real `taskpoints_v1` replacement
  must cause compaction to fail safely, retaining the pending Task journal and
  the previous snapshot bytes. The inspector must continue showing its
  `task_mutation_journal_pending` blocker.
- In a two-tab rehearsal, a newer Task edit is journaled and compacted by
  one tab, then an older tab tries to save its stale Task state. The existing
  newer-persisted-Task-row protection must prevent reverting that row, while
  the still-unfenced old tab keeps the authority gate closed.

The cutover inspector therefore also reports
`checks.taskJournalCompactionHandoffValidated:false` and the independent
hard blocker `task_journal_compaction_handoff_not_validated`, **including
when the Task journal is empty after verified compaction**. A drain does not
constitute proof that an old tab or idle callback cannot write again.
Cross-tab browser tests are not equivalent to killing an installed iOS PWA.
This incremental audit changes no V1 save timing, journals, recovery
procedures, or writable storage.

## Task completion replay and cleanup interleavings (V2 safety regressions)

The V2 browser suite now exercises the existing **synchronous V1** Task journal's
completion-delete overlay against a stale full-state save. An older tab
captures an entry, a second tab writes a durable `completionDeleteId`, and
the first attempts a stale `saveStateSnapshot()`. The journal wrapper must
apply the delete before persistence so an old completion cannot resurrect
while the delete is pending. The cutover inspector still refuses promotion.

A separate controlled reentrant interruption tests **the cleanup boundary**:
the first completion upsert is saved to the V1 snapshot, then an updated
same-ID completion arrives before the journal clears verified entries.
`clearVerifiedSnapshot()` must retain the newer row rather than deleting
it based solely on ID. A subsequent explicit flush must persist the new
completion exactly once, with the final journal empty. This models a
mutation interleaving during one JS call stack; it **does not simulate a
simultaneously executing process or guarantee cross-tab atomicity**.

Both regressions exercise real V1 journal functions inside disposable
localhost browser fixtures, without switching V2 primary storage or
changing TaskPoints' live save code. Unfenced paused legacy tabs,
destructive imports, after-compaction stale deletes, physical Safari/PWA
lifecycle and independent rollback are still blockers.

## V2-branch Task completion tombstone protection (October 28)

An expanded synthetic browser regression exposed a real edge in the V1
snapshot writer: an **explicit pending Task completion deletion** could leave
the candidate `completions` array empty, and the protective
`preserveStickyFieldsBeforeSave()` logic would mistakenly replace it
with previously stored nonempty completions. A stale full-state save could
therefore resurrect the journaled deletion.

The V2 branch now passes a narrowly scoped
`pendingTaskCompletionDeleteIds` option **only when the existing V1 Task
journal actually holds deletion IDs**. The core's ordinary sticky-array guard
honors those specific tombstones while merging other, newly persisted
completion records from another tab. It never sets
`allowDestructiveOverwrite:true` or blanket
`replaceCompletions:true` to work around the issue, because either would
risk deleting unrelated history. Without actual Task tombstones, the normal
nonempty-completions protection is unchanged.

Browser regressions verify three separate outcomes: a pending delete beats
an old snapshot even when it is the **last remaining completion**; an
unrelated newer completion from another tab survives alongside the
tombstone; and an ordinary full-state save **without** Task tombstones
cannot wipe a nonempty completion array. The interrupted cleanup tests
still cover same-ID upserts and idempotent retry.

These are limited **V2-branch safeguards**, not Main changes and not
proof of complete multi-tab authority fencing. After compaction drains,
an old tab that never participated can still write a stale completion;
the cutover diagnostic continues reporting
`task_journal_compaction_handoff_not_validated`, and V1 remains primary.

## Writer ordering and race classes to solve

1. **Immediate user action:** Task and Habit taps must remain durable before
   visual acknowledgement. Converting a journal `setItem` into an awaited
   IndexedDB write without redesign would break current synchronous semantics.
2. **Deferred maintenance:** A compaction/recompression callback may have
   captured earlier state and can awaken after another tab, restore, or
   generation change. Snapshot byte identity helps but cannot establish a
   cross-store atomic boundary with journals, sidecars or direct keys.
3. **Destructive replacement:** Main reset, Settings full import/raw rescue,
   and emergency restore use different entry points and authority flags.
   They cannot be treated as ordinary V2 mutations or omitted from rollback.
4. **Split-key writes:** Notes flags/content, Projects, Today view, Task
   journal, Habit primary journal, independent Habit sidecars and the main
   snapshot can be durable at different instants. A green snapshot-only
   parity check is insufficient.
5. **Old or unresponsive tabs:** The preview Web Lock and IDB epoch only stop
   willing participants. A suspended tab from an older deployment can
   resume and write V1 without ever consulting those protocols.

## Proposed production integration order — NOT an authorization

1. Inventory/assign owners for **every** V1 write entry point, including
   indirect aliases, nonpilot keys, startup/idle callbacks and recovery.
   Maintain full read-only source evidence and compare Main before each sync.
2. Design a same-generation transactional record that includes the *actual*
   authoritative mutation and a durable idempotent acknowledgement. Preserve
   the current user-facing synchronous durability guarantee or provide an
   explicitly proven equivalent before changing any live save behavior.
3. Implement explicit writer admission/fencing across **all** participating
   paths, with controlled drain, conservative refusal on unknown state,
   generation change, paused old tabs and interrupted background tasks.
   Evidence from only responsive current-version tabs must not clear the
   unfenced-old-tab blocker.
4. Prove restore-before/restore-after crashes, complete Task/Habit journal
   replay, Notes/Projects/Today consistency, blocked and failed IndexedDB,
   storage quota behavior, and independent **off-device** rollback.
5. Validate on physical iPhone Safari and installed PWA through suspend,
   kill, offline, multi-tab, restore and retry. Only then separately review
   whether a limited collection cutover is possible.

## CI policy

The source-evidence matrix requires that each known anchor still exists,
has one of the eight documented owners, and names an admission/rollback
requirement. It also requires the runtime's cutover report to stay
non-promotable and explicitly list every family. It intentionally does
**not** grant writer-fenced status, enumerate all dynamic writes, or require
rewriting existing V1 functions. If a Main sync moves or adds a write path,
update this matrix only after reviewing the new behavior; **never delete a
live writer, a safeguard, or its test just to satisfy the audit**.

No files from production `main` are modified by this document or test.

## Latest preview-only writer marker and old-tab safety evidence (October 29)

The isolated IndexedDB writer-marker rehearsal now checks an additional
invariant when a caller inspects or retries the **last committed marker**:
if the aggregate control record still names that marker but its individual
row has disappeared, the result is `fence_writer_marker_missing`, never
`preview_writer_marker_absent` or a second successful write. The control
writer count and any surviving evidence remain untouched. This avoids a
false "never committed" conclusion after marker loss. It remains a
preview protocol, **not** production mutation durability. It does not
perform exhaustive integrity scanning of earlier marker history.

A new Chromium/WebKit regression also freezes the preview IDB writer epoch,
then makes a real same-origin `taskpoints_v1` snapshot write from a
nonparticipating legacy-only page with **no V2 runtime installed**.
Cooperating preview writer attempts remain denied, while the legacy write
survives reload; the cutover report continues to block promotion. The
browser harness explicitly waits for cross-tab storage visibility rather
than treating the legacy tab's completed `setItem()` as an immediate
synchronization barrier. This demonstrates that the IDB rehearsal is not
protection against existing/paused V1 tabs.

No existing TaskPoints feature, V1 writer, backup or recovery mechanism
has been removed or switched to V2 primary authority.

## Nonpilot direct-storage writer proof after a preview freeze (October 29)

A browser regression now uses an old-tab fixture without any V2 runtime
installed to write five separate existing-family V1 keys *after* a preview
IndexedDB fence is frozen: Notes content, Notes dirty/authoritative flags,
Projects data and Today view data. It waits for other-tab visibility in
WebKit, verifies an experimental cooperating writer remains frozen, verifies
the V1 snapshot is unchanged, and checks that the independent values
survive reload with `legacy_only` authority. The cutover inspector
must continue refusing promotion.

These writes are intentional evidence of **missing production fencing**,
not a test of actual Notes or Today UI event handlers, and not a migration
of these keys to V2. No old writer has been disabled or re-routed.

## Atomic preview writer-marker inventory check before freeze (October 29)

A new preview-only `rehearsePreviewDurableWriterFence('audit')` action
reads every synthetic writer marker within one IndexedDB read-only
transaction. It compares the exact count against the durable control
counter, validates each marker ID, generation, epoch and optional SHA-256
fingerprint, and confirms the control's last-written marker still exists.
Any absent older marker, stray record, contradictory counter, or malformed
marker refuses with `fence_writer_inventory_inconsistent`. The audit is
read-only, returns no mutation payload, never repairs or removes evidence,
and cannot grant V2 authority.

Experimental `freeze` now runs this same inventory validation inside
its own readwrite transaction **before** advancing the preview epoch.
Cooperating marker writes serialize against that transaction. Chromium and
WebKit regressions remove an earlier marker while keeping the latest marker
and counter intact, and separately corrupt an older fingerprint without
changing the count. Both must block freeze and remain nonpromotable; the
older missing-marker case also persists through reload. Existing 'read',
writer, and marker inspection behavior remains available.

This validates only the isolated synthetic IndexedDB preview records.
It does **not** fence old V1 tabs, prevent localStorage writes, protect a
real TaskPoints mutation or establish a production-safe cutover.

## Preview synthetic payload + durable acknowledgement (October 29)

The isolated IndexedDB writer rehearsal now optionally accepts a small,
strictly validated `syntheticMutation` with a collection, entity ID,
`put`/`delete` operation and optional JSON value. Only the five fixture
collection names (Habits, Tasks, Notes, Projects and Today) are permitted.
Canonical JSON is SHA-256 hashed before opening the IndexedDB transaction,
so no asynchronous crypto operation can let a readwrite transaction expire.
A caller-supplied mismatching fingerprint is rejected before any writes.

The existing preview writer places that canonical payload *inside the
immutable writer-marker record*, in the very same IndexedDB transaction as
its idempotency marker and aggregate writer counter. A retry must present
the identical payload and derived hash, or fail closed without changing
the writer count. Read-only inspection with the expected payload verifies
identity after a reload. The full inventory audit validates the canonical
payload shape and fingerprint format before allowing a preview freeze.

Synthetic tests use two browser tabs, typed payload replacement, wrong hash,
reload and the existing read-only audit. Marker-only preview writers and
all real V1 entry points retain their previous behavior. This establishes
an experimental atomic **payload + acknowledgement** building block only:
it neither writes a real TaskPoints mutation nor replaces sync V1 journaling,
and does not prove the absence of noncooperating old tabs or allow promotion.

### Synthetic payload transaction rollback and evidence tampering

Additional Chromium/WebKit regressions now force an IDB
`QuotaExceededError` on the aggregate writer count **after** the typed
synthetic marker/payload put has been queued. The transaction must abort
both puts, leave no acknowledged payload, then allow a clean, idempotent
retry with the same synthetic identity. Reload verifies that the later
successful mutation remains inspectable without touching V1 storage.

Another regression corrupts the stored synthetic JSON while leaving
the writer count intact. The typed marker inspector and full inventory
audit must refuse that record, and the preview freeze must stay
uncommitted with the forensic evidence preserved. SHA-256 proof for
original caller-supplied bytes is enforced by typed inspection; the
preview inventory scan verifies canonical stored JSON shape and hash
*format*, not a cryptographic recomputation for every historical row.
This limitation is documented rather than treated as a production gate.

## Atomic materialized preview entity writes (October 29)

The isolated test-only writer prototype now stores **three** record classes
atomically in its *existing* IndexedDB control store: the canonical synthetic
entity's newest put/delete operation, an immutable writer marker containing
the mutation identity, and the epoch/counter acknowledgement. No database
schema upgrade, production V1 write, or application mutation routing changed.
Deletes are explicit tombstone rows, not destructive removals.

A new preview `inspect_entity` read-only action requires a collection
(Habits, Tasks, Notes, Projects or Today) and entity ID and first scans the
entire isolated marker/entity inventory in a single readonly transaction.
The audit compares every entity against its **highest-sequence** committed
marker and verifies generation, marker identity, epoch, digest and canonical
payload equality. Missing materialized rows, unexpected orphan entities,
and marker/entity disagreement fail closed. A replaced entity can be
observed through its latest materialized row while earlier immutable
markers remain available as historical evidence.

Synthetic writers perform the same inventory verification inside their
single readwrite transaction *before* adding the next entity, marker and
counter; thus a cooperating writer cannot modify already-corrupted
preview evidence. Typed marker inspection and replay require this audit
as well. No promises are made about legacy tabs or the actual V2 mirror
collections, and no V1 saving semantics change.

### Materialized entity browser regressions

Chromium and WebKit now exercise real isolated preview entity data: a
two-tab sequence of Task put, correction, and explicit delete tombstone;
two simultaneous Notes edits with deterministic IndexedDB serial ordering
and idempotent retries; and an induced missing Projects materialized row
while the immutable marker remains intact. Audit, read-only inspection,
typed replay, freeze, and reload each verify the intended state. In the
missing-row case, preview replay and freeze must refuse to repair the
ambiguous record. All application V1 bytes remain untouched.

## Bounded synthetic multi-record logical actions (October 30)

The isolated, test-only IndexedDB preview writer now accepts
`syntheticMutations`: 1–8 **different entity targets** in one logical
action. It rejects duplicate targets, invalid records, oversized batches
and conflicting single/batch payloads before any write. A canonical
SHA-256 digest binds the entire ordered batch outside the transaction.

In one IndexedDB readwrite transaction the prototype materializes every
entity, saves one immutable full-batch intent, and increments the writer
counter **once**. The existing marker-only and single-entity callers are
retained. The inventory audit recomputes the latest materialized record
from each historical single or batch intent; any missing/changed entity
blocks inspection, replay and freeze. Typed batch replay must match every
record, not just a marker ID. Synthetic completions are permitted to
rehearse the multi-record Task + completion use case.

This is not a production writer handoff, real V1 journal replacement,
or an authorization to activate V2 storage. All eight unfenced V1 writer
families and independent rollback requirements remain unchanged.

### Detached validated payload before asynchronous hashing

A browser regression exercises a subtle race in both single-record and
multi-record preview calls: the caller changes the original JavaScript
payload object *after* invoking the writer but while its SHA-256 digest
is pending. The validated canonical object is now parsed into a detached
snapshot **before** the digest awaits. The eventual materialized entity
rows, marker contents and digest all represent the same pre-mutation
intent, and a retry using that original intent remains idempotent.
This also avoids an otherwise permanently inconsistent preview ledger.
No live V1 storage flow is affected.

### Historical marker ordering fix (October 30)

Both Chromium and WebKit identified a real preview-recovery bug:
IndexedDB `getAll()` returns records sorted by their *string keys*, but
the inventory audit originally assumed marker enumeration was in commit
order. After a correction, a newer marker could sort alphabetically before
an older one, yielding a false `fence_writer_inventory_inconsistent`
without actual corruption. The audit now reconstructs each current
materialized entity using the **highest committed synthetic sequence**,
independently of marker ID order. It also refuses duplicate sequence
numbers across different immutable synthetic writer markers; legitimate
batch entities share one marker/sequence. Existing historical markers and
tombstones remain untouched. The existing browser correction and
simultaneous-writer scenarios provide real-engine coverage of this edge.


### Historical payload digest preflight (November 1)

The isolated preview writer's inventory scan previously checked that
historical synthetic mutation JSON was canonical, that its SHA-256
fingerprint *looked* valid, and that the latest materialized row matched
the marker's JSON. It did not recompute SHA-256 for **every** historical
payload. A structurally valid rewrite of both an old marker and its
materialized row, without updating their fingerprint, could therefore
escape the structural check.

All preview audit, typed inspection, writer/replay and freeze operations
now first capture a short read-only IndexedDB snapshot of historical
synthetic marker payloads. The snapshot is hashed via WebCrypto **after
the transaction has completed**, never while a transaction is active.
The subsequent inventory scan compares those exact marker bytes and
recomputed digests within the same IndexedDB transaction used for its
normal operation. A concurrent synthetic writer, revision of existing
payload evidence, missing fingerprint or mismatched digest makes the
scan refuse rather than assuming the preflight is still current. If a
cooperating writer *adds* a marker between the snapshot and transaction,
the preview rehashes the full inventory and retries at most three times
(four total attempts). It never accepts an unverified digest, and a
substitution at an unchanged counter is not retryable. Exhausted retries
refuse without changing the state. The freeze decision still shares its
final audit and fence update in one readwrite transaction.

Real-browser regression coverage rewrites a valid-looking historical
Task payload *and* its materialized row while retaining the original
fingerprint. Audit, inspection, replay and freeze must all refuse;
reload must retain the tampered evidence without repairing it, and the
real V1 storage must be unchanged. Ordinary clean records still pass
the audit. Existing structural checks and the earlier reverse-lexical
sequence regression remain in place.

This is **accidental-corruption consistency checking**, not a secure
authentication mechanism: a malicious actor able to rewrite all
IndexedDB records could also recompute an unkeyed SHA-256 hash. It
does not fence old V1 tabs, make the synthetic rehearsal a production
writer, or authorize V2 cutover. The extra scans are confined to the
isolated dark-preview rehearsal; they are not a proposed foreground
production mutation path.


### Full-ledger marker inspection (November 1)

The read-only `inspect_marker` recovery probe previously enforced the full
inventory and historical digest check **only** when the caller supplied a
typed synthetic mutation. A marker-only query (or a query for an absent
marker) could claim `present`/`absent` even though another older marker had
disappeared, or an older typed intent had been altered. The separate
`audit` and `freeze` paths still refused, but the direct inspection result
could mislead callers trying to resolve an uncertain commit.

All `inspect_marker` outcomes that would otherwise be `present` or
`absent` now pass the same complete historical inventory and SHA-256
verification used for freeze. Successful lookups explicitly report
`inventoryVerified:true` and `historicalPayloadDigestsVerified:true`.
Missing-last-marker and malformed-control refusals remain their existing
fail-closed results. A structurally valid latest marker cannot hide
missing or cryptographically inconsistent earlier evidence, whether the
caller supplies a typed payload, a marker-only fingerprint, or no payload.

The Chromium/WebKit regression first verifies an ordinary marker-only
lookup, then corrupts a previous typed marker's persisted hash without
altering the latest marker. Lookups for the latest, the corrupted marker,
and a never-committed marker must all refuse with
`fence_writer_inventory_inconsistent`, including after reload. No
inspection writes repairs, clears evidence, changes V1, or grants authority.
This is a stricter diagnostic of the preview rehearsal, not production
fencing of older V1 tabs.

### Marker-only writer/retry inventory enforcement (November 1)

Although full-ledger audit was already enforced for typed synthetic writer
replays and commits, marker-only preview writers still bypassed that audit.
Because the durable counter advances for both marker types, a marker-only
writer could previously append an acknowledgement after an older typed
mutation had been corrupted, and a marker-only retry could report a
successful idempotent replay while the ledger was inconsistent.

**Both preview paths now require `inspectAllWriterMarkers()` before
acknowledging a new marker or an existing-marker retry.** The audit checks
the complete historical marker/entity inventory, and verifies stored
SHA-256 payload fingerprints through the already introduced bounded
two-pass digest proof. Inventory validation and any new writer-marker,
materialized entity and counter writes remain in one IndexedDB readwrite
transaction. No async hashing occurs inside a live transaction.

A Chromium/WebKit regression commits one typed synthetic note mutation and
one marker-only acknowledgement, confirms clean replay, corrupts the older
typed marker fingerprint, then confirms marker-only replay, a fresh
marker-only write, freeze and audit all fail closed. It also checks that
the writer count, last marker, V1 snapshot and legacy read authority are
unchanged and that refusal persists across reload.

The added scans are intentionally preview-only and are **not** an
endorsement of full-history scanning on the future production mutation
hot path. Nonparticipating old V1 tabs remain unfenced, and the authority
cutover must still refuse. No protection has been removed.

### Marker-only concurrency proof and preflight substitution guard (November 1)

The historical SHA-256 proof is obtained outside IndexedDB transactions.
A concurrent cooperating marker-only acknowledgement can therefore commit
after an audit's preflight snapshot but before its verification transaction.
Earlier bounded retry logic only recognized newly added **typed** markers;
a valid marker-only interleaving could incorrectly fail with
`fence_writer_inventory_inconsistent` despite an intact ledger.

The preflight now records the canonical bytes of **every** historical
marker, whether typed or marker-only. The verification transaction permits
a bounded digest refresh when new marker IDs increase the committed
counter consistently **and every older marker is still byte-identical**.
Adding marker-only and typed intents now follows the same retry path.
Removing or rewriting an existing marker, even alongside a new marker and
a counter increment, cannot be treated as a legitimate stale snapshot.
The final inventory check also requires all preflight marker IDs to remain
present and unchanged. New marker payloads are checked on the refreshed
preflight, never trusted based on the counter alone.

Browser regressions explicitly pause an older marker's WebCrypto digest
between the read-only and verification transactions. A second tab commits
a marker-only acknowledgement and the first write must safely retry,
preserving both markers. A separate fixture mutates a preexisting
marker-only fingerprint while incrementing the control and adding a new
marker; the paused operation must refuse rather than rehash the altered
history into an apparent success.

Marker-only fingerprints are still *caller assertions*, not independently
authenticated payload digests. These checks establish snapshot
consistency during preview operations; they do not prove that a
preexisting marker-only assertion could never have been tampered with.
This is diagnostic hardening, not a production migration or a fence
against nonparticipating V1 pages. The legacy storage remains primary.

### Preview marker commit-sequence evidence (November 1)

The preview control record already stores a writer count and the identifier
of its last writer. Earlier typed synthetic intents also store a
`syntheticSequence`, but marker-only acknowledgements historically stored
**no commit sequence**. Thus an otherwise intact marker inventory could
misleadingly accept a control record whose last-writer identifier had been
repointed to an older marker. The next recovery lookup could trust a false
latest-commit pointer.

New preview marker rows now include a durable `writerSequence` equal to
the incremented writer counter, alongside the existing typed
`syntheticSequence` when appropriate. The full inventory audit checks
positive, bounded, distinct known sequences, agreement between a typed
marker's two sequence fields, and that the control's last writer actually
owns the newest known sequence. Typed old-format markers remain verified
using their original `syntheticSequence`.

Older marker-only rows without `writerSequence` are retained as readable
legacy preview evidence. They are never silently backfilled or modified.
If a newer numbered marker exists, however, the control cannot point to
an earlier unsequenced marker and pass the audit. A history consisting
entirely of old unnumbered marker-only rows cannot be retroactively
proven to be in precise commit order; this remains an explicit limitation
rather than manufactured proof.

Chromium/WebKit tests first verify numbered typed and marker-only
acknowledgements, emulate one historical sequence-less marker, then
corrupt only the control's last-writer pointer while leaving the three
markers and writer count intact. Audit, inspection, replay, fresh writes
and freeze must refuse before mutation, including after reload. A second
regression refuses duplicated writer sequences. The original V1 snapshot
and legacy authority remain unchanged. This protocol remains synthetic
and preview-only: older V1 application tabs are not fenced or migrated.

### Dormant legacy-writer exclusion remains unproven (November 2)

The read-only authority-cutover report and preview peer handshake now
explicitly publish `silentLegacyWriterExclusionVerified:false` and
`productionWriterAdmissionComplete:false`. The cutover report also
publishes `legacyWriterQuietWindowProven:false` and keeps the hard
`silent_or_suspended_legacy_writers_not_excluded` blocker even if the
entire localStorage inventory is unchanged across two observations,
the Habit pilot is consistent, and every observed V2 peer responds.

These are deliberately negative safety facts, not an attempt to discover
or disable old tabs. A BroadcastChannel handshake can only enumerate
responding V2 participants; unresponsive, suspended and pre-V2 pages
remain invisible. The legacy V1 writers do not share a mandatory writer
admission lease. Passing a static writer evidence matrix or the isolated
IndexedDB preview fence cannot fill that gap.

A real Chromium/WebKit fixture opens a same-origin **legacy-only page**
with no V2 runtime loaded, obtains two unchanged full-origin cutover
audits and a preview peer observation, then resumes that old page to
write an actual `taskpoints_v1` snapshot and independent `tp_projects_v1`
data. The receiving V2 tab must observe both durable changes, keep V1
authority, continue reporting old-tab exclusion as unproven and preserve
the updated data after reload. No code is added to the live V1 writer
path; this test demonstrates why snapshot quiescence is not fencing.

This evidence does not simulate an actual iOS PWA process kill or prove
the safety of a future handoff. Production multi-context writer admission,
physical Safari lifecycle validation and off-device rollback remain
non-negotiable blockers. V2 stays preview-only.

### Full-origin exclusive-lock rehearsal inventory (November 2)

The preview-only `rehearseExclusiveWriterLease()` previously hashed
`captureLegacyNamespace()`, which intentionally includes just
`taskpoints_*` keys for its established recovery-checkpoint format.
That was insufficient for an exclusive handoff diagnostic: a paused
pre-V2 page can independently modify `tp_projects_v1`, Game preferences
or other same-origin keys without changing the Habit pilot or V2 revision.
The Web Lock does not exclude these noncooperating legacy writers.

The exclusive *rehearsal only* now hashes the complete sorted origin
`localStorage` inventory returned by the separate strict read-only
`captureReadOnlyFullStorageInventory()` helper, before acquiring the
exclusive Web Lock and while holding it. Following its awaited SHA-256
it synchronously rescans the full origin, detecting visible changes
during the digest window. The existing key-filtered recovery capture
and checkpoint format are deliberately unchanged. The actual V1 writes,
journals, compaction, rescue, and cutover policy are also unchanged.

Chromium/WebKit regressions open a page with **no V2 runtime** and write
the real independent `tp_projects_v1` key during (1) the initial hash
preflight and (2) the in-lock hash. The rehearsal must refuse either
interleaving, keep the original `taskpoints_v1` unchanged, and preserve
the independent Projects write under legacy-only authority.

Even this broader observation cannot exclude a dormant legacy writer
that wakes after the final check, or a value that changes and reverts
between observations. It is therefore **not** a production writer
admission fence and never sets `canPromote:true`. Production cutover
still requires an approved strategy for unfenced old tabs.
