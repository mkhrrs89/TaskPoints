# V2 authority handoff — read-only V1 writer matrix

Updated: 2026-10-28 · V2 branch only · **NOT APPROVED FOR CUTOVER**

## Purpose and scope

This audit identifies seven **known, currently unfenced** V1 writer families and
38 **source-evidence anchors** across seven V1 runtime files. An anchor can be a
writer, fallback, lifecycle callback, journal compaction step or shared entry
point; **38 does not mean 38 independent or exhaustive writers**. The
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
| **Today** — `today.html` | `saveApp()` snapshot and `saveTodayStore()` direct `TODAY_STORE_KEY` | Direct Today view can change independently of core snapshot | Preserve view data and current-day ordering across cross-tab migration |
| **Settings/import/reset** — `settings.html` | `saveValidatedSnapshot()` full import, direct `tp_projects_v1` import, reset/removal, manual compressed raw replacement and rollback, notes authority flags | User-confirmed destructive replacement and manual rescue/rollback | Independent rollback checkpoint, user-confirmation/recovery semantics, generation rotation, no bypass via direct-key import |
| **Notes** — `notes.html` | Direct `NOTES_STORAGE_KEY`; `saveAppState` or `writeTaskPointsStoredState()` fallback; notes authoritative/dirty flags | Notes are dual-stored, and dirty/authority markers control reconciliation | Treat content and flags as one logical unit; no silent loss of newer notes or dirty intent |
| **Emergency recovery** — `emergency_recovery.html` | Recovery hold and V2-mode-off flags, `safeReplaceTaskPointsStorage()`, phase journal quarantine/removal, Habit journal reset, verification | Recovery can intentionally replace the entire V1 source and keep hold active | Preserve emergency access and independent off-device rollback; never block rescue solely because V2 fence DB is unavailable |
| **Task journal/idle compaction** — `task_mutation_journal.js` | `journalMutation()` sync journal write; `scheduleCompaction()` / `runWhenQuiet()` deferred work; `saveStateSnapshotWithTaskJournal()` wrapping; verified cleanup | Sync journal precedes UI feedback; read overlay and deferred compaction protect pending Task changes | Must cover journal+overlay, completion updates and deletes, generation checks, quiet/idle failures, and compaction retry |

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
has one of the seven documented owners, and names an admission/rollback
requirement. It also requires the runtime's cutover report to stay
non-promotable and explicitly list every family. It intentionally does
**not** grant writer-fenced status, enumerate all dynamic writes, or require
rewriting existing V1 functions. If a Main sync moves or adds a write path,
update this matrix only after reviewing the new behavior; **never delete a
live writer, a safeguard, or its test just to satisfy the audit**.

No files from production `main` are modified by this document or test.
