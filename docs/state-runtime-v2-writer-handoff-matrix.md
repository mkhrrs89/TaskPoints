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
