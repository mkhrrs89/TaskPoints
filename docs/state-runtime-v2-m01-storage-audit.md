# M01 — TaskPoints authoritative storage and writer audit

**Branch:** `arch/state-runtime-v2-plan` · **First-pass evidence:** 2026-11-10  
**Result:** **M01 Working, NOT Verified.** This document records what is known and what remains to prove before V2 takes over any feature.

## Measurable first pass

| Observable | Initial result | Meaning |
| --- | ---: | --- |
| Tracked root-level production JS/HTML/MJS files | **170** | Reproducible source-file baseline; tests and docs excluded |
| Root source files inspected in the first-pass audit | **170** | All enumerated root JS/HTML/MJS source files examined; nested/dynamic paths remain |
| Key-to-source evidence entries | **146** | Source-linked references (one Notes key has two legitimate roles) — **not** all unique persistence keys |
| Known IndexedDB database/store evidence examples | **4** | `taskpoints/images`, safety vault snapshots, and V2 preview DB |
| Explicit primary snapshot fields in `normalizeState` | **30** | Reproducible named-field lower bound, NOT entire V1 schema |

Reproducible manifest: [source inventory](state-runtime-v2-storage-source-inventory.json). Every tracked source filename and the 30 named `src.` fields are checked in V2 CI by [M01 inventory contracts](../tests/state_runtime_v2_m01_source_inventory_contract.test.js). CI also checks key/database evidence paths exist. A new root-level source file or a new explicitly normalized field **fails the CI inventory guard** until the manifest is consciously updated. The additional [writer-path anchor contract](../tests/state_runtime_v2_m01_writer_path_evidence_contract.test.js) now catches disappearance/movement of 78 reviewed writer entrypoints and 128 reviewed source anchors and six high-risk storage key/database anchors. It does NOT enumerate every dynamic writer inside an existing file or prove caller ownership; this is not a completed-callgraph proof.

## What is actually stored separately

| Family | Known source of truth / source-specific record | Direct/indirect save path checked so far | Missing ownership proof |
| --- | --- | --- | --- |
| Main V1 snapshot | `taskpoints_v1`; normalized known fields plus unknown `...src` extension fields | `scoring_core.js`, `index.html`, `settings.html` | Enumerate dynamic/derived fields and every page/helper capable of rewriting snapshot |
| Pending Habits, Tasks and Inbox | `taskpoints_pending_habit_deltas_v1`, `taskpoints_pending_task_mutations_v1`, **`taskpoints_pending_inbox_state_v1`** | `scoring_core.js`, `task_mutation_journal.js`, `task_create_fast_path.js`, `toolbar.js` | Inbox idle compaction, all completion/replay/reset/stale-tab/fallback writers |
| Today | `taskpoints_today_view_v1` | `today.html` (`saveTodayStore`), Home also references Today | Link each Today/SCWM/Notes UI event to authoritative write and the V2 equivalent |
| Notes | `taskpoints_notes_v1`, dirty and authoritative markers; main V1 `notes` | `notes.html`, `scoring_core.js`, `settings.html` | Finish dirty-first edit and snapshot-sync recovery and ownership |
| Projects | `tp_projects_v1`; legacy V1 `projects` | `projects.html`, `index.html` | Reconcile every independent editor and import/export behavior |
| Game and seasons | Main V1 `players`, `seasonHistory`, `matchups` etc; separate gallery/sort/group keys | `game.html`, `season.js`, `matchups.html`, `season3_tournament_rollover.js`, `settings.html` | All gameplay, result, gold, season archive, manual repair and auxiliary settings paths |
| Gold | Main V1 Gold/economy fields, settlements and secondary result claims | `greed_gold_economy.js`, `gold_ledger.html`, `gold_manual_adjustment.js`, `index.html` | Outcome, margin, theft, repair and replay writers; no live V2 ownership |
| Pictures | IndexedDB database `taskpoints`, object store `images` (binary blobs) | `scoring_core.js` | All image refs, backup/export bytes and restore with no omission |
| Backups / recovery | Backup slots, quarantined state, `taskpoints_safety_vault_v1/snapshots`, `taskpoints_verified_secondary_v1/snapshots`, phase3/4/5 markers and restore locks | `scoring_core.js`, `settings.html`, `phase2_reset_hook.js`, `phase3_read_path.js`, `phase4_storage_coordinator.js`, `phase5b_deferred_mirror.js`, `emergency_recovery.html`, `verified_secondary_restore.js` | Source-complete export/import, generation rotation, emergency restore and old-tab effects |
| V2 previews | `taskpoints_state_v2`, preview Notes, Game, Habit ordering and checkpoint DBs | `state_runtime_v2.js` | Distinguish strictly preview-only writes from eventual production admission; no unauthorized promotion |

**The main snapshot is open-ended.** In `scoring_core.js`, `normalizeState` spreads `...src` before normalizing named fields. The 30 known fields therefore cannot be used to delete, normalize away, or ignore unknown properties when moving to V2.

## November 10 second pass — discovered writer routes (NOT a migration)

Twenty additional production files were inspected: 40/168 total, leaving 128. Evidence now includes 51 key/source entries, 4 database/store examples, and **16 source-anchored writer/delegation routes** in the machine-readable manifest. These anchors are checked in a new Node contract; they are **not** exhaustive callgraph or live-operation tests.

- **Week** saves through `TaskPointsCore.saveStateSnapshot`; **Matchups** saves through `mergeAndSaveState`. Both are non-Home legacy write entrypoints that must be admitted or fenced during any cutover.
- **Toolbar** delegates Inbox writes through `mergeAndSaveState`, wraps the core save functions with deferred writes, and independently updates image blobs. **Inbox** also has its own synchronous `taskpoints_pending_inbox_state_v1` journal and delayed compaction/removal in `task_create_fast_path.js`. Losing this journal would lose events even if main-snapshot parity passed.
- **Season rollover** saves a new legacy snapshot; the **Gold retrospective adjustment** helper replaces the save wrapper, another indirect route not discoverable from literal `localStorage.setItem` searches alone.
- **Emergency and verified-secondary restore** persist recovery holds, lock markers and pre-restore backup references. **Phase3** has separate read mode/diagnostic keys. **Phase5b** writes a verified-secondary IndexedDB `snapshots` store; it remains a V1 recovery mirror, not V2 authority.
- **Storage maintenance** wraps snapshot saves, while **storage diagnostics** can delete IDB image records. Deferred callbacks and manual cleanup must be included in the ownership/fencing map, not silently treated as read-only pages.

Remaining blockers: 128 uninspected root sources, nested sources/assets/service worker entrypoints, computed key aliases, unknown V1 snapshot properties, caller-to-sink paths, restore/import/reset behavior and a reviewed owner for every surviving writer. No V1 or V2 production save behavior was changed.

## November 10 Main → V2 sync — new Gold writer reviewed

Merged [Main head 017e456](https://github.com/mkhrrs89/TaskPoints/commit/017e4562a8575e53f7b84818b46449c54475d78b) into [V2 commit 959979e](https://github.com/mkhrrs89/TaskPoints/commit/959979e98d4f96e587bed63d0b9c727f4b7da0e9) **without modifying Main**. The merge inherited Main's 65 newer commits (41 changed files) and retained all V2-specific files. Two overlapping sources, `index.html` and `scoring_core.js`, were merged with non-overlapping line changes from both branches. V1 remains authoritative; this is not a V2 storage cutover.

- Main introduced `gold_manual_adjustment.js`, which writes the live Gold ledger through `TaskPointsCore.saveValidatedSnapshot` after a freshness check, reads `taskpoints_v1`, and respects the emergency recovery hold. **This is a newly discovered nonpilot Gold writer** requiring M07 ownership/fencing before V2 authority.
- Main introduced `gold_circulation_total.js`, a Gold-ledger read/aggregation helper. Both new production sources were inspected and added to the CI-guarded root source list.
- Current inventory: **170 enumerated / 42 inspected**, **53 key/source entries**, 4 database/store examples and **17** guarded writer anchors. **128 root files** remain uninspected, plus indirect/dynamic call paths.
- Existing M01 limitations, field-extension preservation, safety vault and recovery gates remain blocked. No new engineering checkpoint was verified by the synchronization.

## November 10 third pass — Flex, recovery, image cleanup, and export side effects

Thirty more root production files were inspected with source-specific anchors (now **72 of 170**). The manifest stores **76** source-linked key evidence entries, **33** writer-route anchors and **30** reviewed source anchors. The source evidence is guarded by the [M01 writer/inspection contract](../tests/state_runtime_v2_m01_writer_path_evidence_contract.test.js), which prevents losing the identified paths during future merges. This is still **not** complete writer ownership or permission to enable V2.

- **Flex Actions** have **two independent synchronous pending journals**: `taskpoints_pending_flex_completions_v1` and `taskpoints_pending_flex_order_v1`. Completion/reorder operations and reset/flush can touch these keys independently of the primary snapshot. A future V2 migration must preserve both, including no-loss under interruption.
- **Season integrity** may persist corrected V1 snapshots through `season_result_integrity_guard.js` even during a load, and **season image reference repair** can call the exact legacy writer `writeTaskPointsStoredState`. Both need stale-generation fences.
- **Image cleanup** can delete binary player images from IndexedDB using a manual `readwrite` transaction. The reference-scanning helper and repair planner are separate code paths; state-only backups do not replace photo bytes.
- **Export** on Home and secondary pages reads standalone Projects/Notes, and can trigger Notes synchronization or schedule-preparation snapshot writes; backup is not guaranteed read-only.
- **IndexedDB requalification** uses separate localStorage gate/diagnostic/session markers, browser page locks and recovery-hold mode writes. Emergency/secondary recovery guards can replace or remove lock keys. These must stay preserved during any V2 conversion.
- **Session caches** and **hot-state read guards** add auxiliary values and watch pending Player edits. These are distinct from the authoritative V1 snapshot.

**Remaining:** 98 root files not individually reviewed, plus nested sources and computed/indirect writers, full key/field owner reconciliation, import/reset/recovery callgraphs, production writer fencing, off-device backups and physical Safari qualification. M01 stays **Working**; all 23 milestone statuses are unchanged.

## November 10 fourth pass — non-Home production save entrypoints

An additional **36 root source files** were inspected (now **108/170**, with **62 root files** awaiting review). The source inventory now has **105 key/source evidence entries**, **59 writer/delegation path anchors**, and **66 explicit source-review anchors**.

This pass uncovered important write paths outside Home:

- **Achievements, Game Ratings, Log and Trash** save directly into V1. Several have a `writeTaskPointsStoredState` fallback, so a future V2 fence cannot protect only ordinary `saveStateSnapshot` calls.
- **Habit and Game-history repair panels** can rewrite completion history and season-linked data after backup confirmation. Migration must preserve safety checks and recovery semantics, not just the happy-path save.
- **Tournament resync** can run later through `requestIdleCallback` or a timer. **SCWM** may queue an original save. **Task Delete fast path** intercepts snapshot saves and routes confirmed deletes through a Task journal, retaining fallbacks.
- **Background Season upset notifications** persist Inbox state through a separate merge path, in addition to the pending Inbox journal.
- **Rankings scope and Game ratings filters** persist separate localStorage preferences; performance trace state persists to sessionStorage.

The 26 newly documented writer routes explicitly carry `fencingStatus: not_proven` and `ownerStatus: awaiting_full_callgraph`. [CI guards](../tests/state_runtime_v2_m01_writer_path_evidence_contract.test.js) reject their omission or premature reclassification. This is **static evidence**, not production writer admission. Do not activate V2 or delete legacy fallback routes based on these source anchors.

**Remaining M01 work:** 62 other root files, dynamic/indirect mutation paths, unknown V1 fields, full ownership mapping and safe writer fencing across real tabs, repairs, import/export, startup and restore. Other cutover gates for disconnected backups and physical iPhone validation remain independently blocked.

## November 10 fifth pass — complete root discovery; ownership remains blocked

The remaining **62 root JS/HTML/MJS files** were reviewed, taking the first-pass count from **108 to 170 of 170 enumerated**. This records **146 key-to-source evidence entries**, **78 source-anchored writer/delegation paths** and **128 individual source-review anchors**. This is **not** exhaustive migration inventory: dynamic aliases, embedded/generated scripts, nested assets, open-ended unknown V1 fields and indirect callers remain.

The new `proposedWriterHandoffs` list maps all **78 observed writer routes** to a **provisional** migration/retained auxiliary owner and a required proof. It gives us a finite set of known routes to investigate, not a completeness claim. **0 of 78 are owner-verified or production-fenced.** Every route explicitly has `evidenceStatus: not_verified`, `cutoverPermission: false`. CI compares the handoff rows to the tracked source-anchored writers and prevents silently dropping one.

Additional risk paths found in the last 62 files:

- **Skills and Bracket Builder** save complete legacy snapshots; Skills also retains a raw V1 write fallback and separate preference keys.
- **Standings** writes its season-scope setting and one-time rollover markers independently of the main V1 snapshot.
- **Home yesterday result consistency** may remove emergency/attempt recovery lock keys; these are safety boundaries, not disposable cache state.
- **V2 generation and WAL** have separate localStorage keys; V2 live review has a session-scoped WAL test arm, and preview enable/cleanup can set/remove pilot keys and delete **preview-only** databases. None of this grants production authority.
- **Storage health** reads safety-vault, rolling backups and image stores, so full backup/restore validation must include independent IDB blobs and backup keys.

**Next practical closure work:** resolve the known 78 provisional handoffs to actual owners and prove caller-to-sink completeness, including old-tab generation fencing, fallback writes, generated scripts, import/reset and recovery paths. Preserve every existing safeguard and keep V1 authoritative until all independent safety gates pass.

## November 10 sixth pass — actual V1 Task-delete writer behavior witness

The M01 audit moved beyond file anchors for the first named route: `task_delete_fast_path.js`. A dedicated [Node VM regression](../tests/state_runtime_v2_m01_task_delete_behavior_contract.test.js) executes the **real installed Task-delete fast-path module** and, in two integration cases, the **actual existing V1 Task journal module** (`task_mutation_journal.js`) against disposable memory storage.

The focused cases preserve and check: confirmed deletes journal before any full snapshot; unrelated/unfinished actions still take the original save route; missing/locked/failing journals fall back to V1; click arms expire safely; journaled deletes overlay reads and compact to V1 without losing unrelated completions; and a forced journal quota error falls back to the original snapshot writer instead of falsely acknowledging a durable journal.

This gives **1 of the 78 source-tracked writer paths a tested synthetic V1 behavior witness**. The source inventory records the test and its five scenario classes. It is deliberately **not** a verified V2 owner, not a multi-tab transaction, not an iPhone proof, and not a production writer fence. **0/78 production ownership proofs** remain complete, and the migration/cutover blockers stay in force.

## Specific next work to close M01

1. Run the CI source scanner against all 170 files; triage which of the 98 uninspected files access or indirectly modify storage. Move from *inspected* to *writer ownership verified* only with a caller/writer trace, including indirect `TaskPointsCore` saves and dynamic key aliases.
2. Group all literal and computed localStorage keys by authoritative vs derived vs session-only vs recovery-only, and identify how each is imported/exported and reset. Preserve user-defined fields and unknown V1 properties.
3. Audit every other IndexedDB database/version/store and each image read/write/delete and backup path. Include malformed schema and no-DB cases.
4. Map all UI and maintenance entrypoints, including pages, service worker lifecycle, deferred compaction, Phase4/5 mirrors, restore and import, to the nine known legacy writer families; use negative tests where a stale writer must be refused.
5. Compare the full inventory to each proposed V2 owner. M01 is verified **only** when every authoritative source/writer has a reviewed owner or an explicitly preserved auxiliary path, and tests fail if coverage regresses.

**Safety boundary:** none of this changes production storage or a user's data. V1 remains primary; no V2 writer cutover or completed 12-point migration gate is implied. A raw file-count ratio is *not* an engineering-completion percentage.
