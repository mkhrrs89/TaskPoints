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

## November 10 seventh pass — Inbox journal behavior and conservative cutover block

The **real** `task_create_fast_path.js` Inbox mutation journal has been exercised with synthetic memory storage for its two recorded writer routes: synchronous `setItem` and post-verification `removeItem`. The new [Inbox behavior contract](../tests/state_runtime_v2_m01_inbox_journal_behavior_contract.test.js) tests successful immediate journaling, durable journal read overlay, direct V1 fallback on quota failure, preservation of malformed journal evidence, retention and retry after skipped/failed/nonpersisted compaction, and protection of newer journal records created while older compaction is in progress.

The V2-only read-only `inspectAuthorityCutoverBarriers()` additionally observes `taskpoints_pending_inbox_state_v1` **before and after** the asynchronous peer probe and full-origin inventory. The [cutover observer contract](../tests/state_runtime_v2_m01_inbox_cutover_guard_contract.test.js) checks V1 array and V2 object formats, malformed/unknown journals, inaccessible reads, exact no-mutation behavior and permanent hard blockers. A valid present journal is **pending**, even if the record contains empty arrays. Cutover remains impossible even when absent: `inbox_journal_compaction_handoff_not_validated` is always a blocker.

Current behavioral-witness metric: **3/78** known source-anchored routes (Task Delete + Inbox append + Inbox cleanup); **0/78** production owners verified. These are two separate measures. No nonpilot V2 writer admission, old-tab fencing, or primary migration has occurred.

## November 10 eighth pass — both Flex journals and a cutover blocker

The [M01 Flex behavior tests](../tests/state_runtime_v2_m01_flex_journal_behavior_contract.test.js) execute the **actual** `flex_action_fast_path.js` module against disposable memory storage. They cover both independent journals: `taskpoints_pending_flex_completions_v1` for completed Flex Actions and `taskpoints_pending_flex_order_v1` for reordering. The tests check combined replay, verified compaction, protection of malformed order records, recovery lock refusal, quota failure and retry, and suppression of a stale delayed save that might overwrite newer V1 data.

The V2-only [read-only Flex cutover observer](../tests/state_runtime_v2_m01_flex_cutover_guard_contract.test.js) examines both keys **before and after** asynchronous peer inspection. It detects raw-byte changes and separately reports pending, malformed and unreadable evidence. Even a present empty journal remains unresolved, and the unconditional `flex_journal_compaction_handoff_not_validated` blocker prevents any authority handoff.

The audit's behavior rehearsal count increased from **3 to 5 of 78** known source-anchored writer routes. **Zero of 78** writer owners have been certified for production, and no new checkpoint was verified. These are V1 behavioral tests and V2 inspection gates, not real multi-tab writer fencing or a V2 cutover.

## November 10 ninth pass — three Habit repair entrypoints behavior-tested

The [M01 Habit repair writer test](../tests/state_runtime_v2_m01_habit_repair_writer_behavior_contract.test.js) runs three **real existing production scripts** in isolated synthetic browser/DOM and storage environments. This round adds three distinct behavioral witnesses:

1. **`habit_ledger_repair_audit.js`** — Backup confirmation and preview are required before ordinary source-label correction is written via `core.saveStateSnapshot`; stale entries do not trigger a V1 writer, and skipped saves do not claim success.
2. **`habit_ledger_completion_backed_repair.js`** — A completion-backed missing `doneKey` is restored while existing completion points, Game records and Gold remain intact. A changed completion date invalidates the preview, and a forced save error leaves canonical data unchanged.
3. **`habit_ledger_score_reconciliation.js`** — The applied repair updates matching historical score copies (matchup/schedule/game history), preserves the existing winner and Gold, and refuses to save when an observed historical matchup changed after preview.

These are intentional manual repair paths with `replaceCompletions` and `allowDestructiveOverwrite`. They are high-risk exceptions requiring full owner inventory, backup confirmation, recovery semantics, and old-tab fencing in any future migration. The tests exercise the genuine UI save code but do **not** simulate actual device persistence, live cross-tab admissions or certified V2 owners.

**Measured progress:** **5 → 8 of 78** known writer routes with scenario-tested V1 behavior. **0 of 78** routes have owner/fence certification. M01 is still Working and the 23-checkpoint/67-point scoring rubric does not change.

## November 10 — four more cross-domain V1 save paths verified behaviorally

The new [four-writer contract](../tests/state_runtime_v2_m01_four_cross_domain_writer_behavior_contract.test.js) executes four **real production modules** against disposable Node VM storage. All four were already in the 78-route inventory.

- **Gold ledger manual adjustment** `gold_manual_adjustment.js`: requires raw snapshot confirmation, blocks recovery holds, uses protected `saveValidatedSnapshot`, and checks actual stored ledger balance/IDs. Skipped and unpersisted writes cannot be counted as success.
- **Season 2 historical Play-In recovery** `season2_missed_playin_recovery.js`: saves reconstructed results once, declines incomplete input, skips repeat recovery and retains V1 data when the protected save fails.
- **Season upset Inbox notifications** `season_series_upset_notifications.js`: writes only Inbox fields, deduplicates processed upset event IDs, and cannot mutate effective V1 authority on rejected writes.
- **Season result integrity** `season_result_integrity_guard.js`: reconciles duplicate legacy results/schedules using the existing protected writer, avoids unnecessary writes for clean state, and retries rather than marking an unsuccessful repair clean.

These four **V1 behavior tests** bring M01 behavior-witness coverage from **8 to 12 out of 78** known writer routes. They do **not** certify V2 writer generation fencing, complete nested source inventories, multi-tab authority transfer or real device backup/restore. **0/78 V2 production owners are certified; M01 remains Working and overall readiness 67/100.**

## November 10 eleventh pass — five real user-facing page write routes

The [M01 page-write behavior contract](../tests/state_runtime_v2_m01_badges_trash_ratings_writer_behavior_contract.test.js) executes the actual inline scripts from three separate production HTML pages, against disposable in-memory V1 storage. It covers **five different source-inventory routes**:

1. **`achievements.html` protected save:** Badge add/remove calls `saveStateSnapshot` immediately and preserves unrelated Task/Gold/unknown imported fields.
2. **`achievements.html` raw fallback:** On a thrown protected save, the page uses `writeTaskPointsStoredState` directly. A second raw-write failure does not change stored bytes.
3. **`trash.html` protected save:** Restoring prior status and permanently deleting a Task route through `saveStateSnapshot`, with an explicit confirmation before deletion.
4. **`trash.html` raw fallback:** If the page's `mergeAndSaveState` availability check fails, task mutations write directly via `writeTaskPointsStoredState`. Raw quota failures retain original canonical bytes.
5. **`game_ratings.html` direct writer:** The Ratings editor validates input then writes edited non-YOU players directly via `writeTaskPointsStoredState`, preserving other V1 fields; errors do not persist a false update.

**Most important finding:** Badge and Trash legacy fallbacks can bypass the ordinary protected save path, and Ratings unconditionally writes directly. These are **existing V1 behaviors, not new features**, and should not be removed without replacement and explicit approval. A future V2 handoff must account for them explicitly.

This raises behavior-tested writer routes **12 → 17 of 78**. Still **0/78 V2 owner/fence proofs**, so the M01 milestone and 67/100 weighted readiness remain unchanged. Tests are synthetic VM rehearsals, not proof of cross-tab stale-write rejection, true device persistence, or safe V2 production authority.

## November 11 twelfth pass — Log, Skills and Bracket page-save behavior

The [M01 actual-page contract](../tests/state_runtime_v2_m01_log_skills_bracket_writer_behavior_contract.test.js) executes the **real inline JS** from `log.html` and `skills.html`, plus `season_bracket_builder.js`, against disposable browser storage and DOM stubs. It covers five previously source-inventoried routes:

- **Log protected snapshot writer:** saves edits through `saveStateSnapshot`, replacing completion lists so deletions stick, and updates its cache.
- **Log raw V1 fallback:** if the snapshot-save helper is missing, saves directly with `writeTaskPointsStoredState`; rejected raw saves retain stored bytes and invalidate cache.
- **Skills protected snapshot writer:** adds/deletes manually configured skills with distinct save paths, retaining other stored Game, Gold and Task fields.
- **Skills raw V1 fallback:** if the protected snapshot helper is unavailable, direct V1 writes add/remove skills; storage failure cannot persist false data.
- **Season Bracket Builder protected writer:** saves an editable draft without activating the tournament; the official bracket requires confirmation, refuses invalid settings, and does not navigate if the protected save throws.

**Important source-level data-loss finding:** `log.html` uses `readPageStateFresh()` to project a fixed set of legacy top-level fields; `goldLedger` and other unrecognized/forward-compatible fields are absent from that projection. Subsequent Log `saveMerged()` uses this reduced state for an entire `saveStateSnapshot()`. The synthetic test demonstrates the missing `goldLedger` in the saved data. This is a V1 path hazard we must fence or make lossless in any V2 migration. **No production Log or V1 Main code was modified** and no migration authority is granted. Do not disable the Log or other features; future remediation must preserve all functionality.

Result: **22/78** source-anchored routes with real V1 behavior witnesses, up from **17/78**. **0/78** production owners verified. Main has progressed separately since the prior V2 turn; no Main sync was requested, so this round did not sync or modify it. M01 and 67/100 readiness remain unchanged.

## November 11 thirteenth pass — six distinct legacy writer-route behavior witnesses

The two new M01 contracts execute **the real production sources** against isolated synthetic state/storage (not replacements for the actual writer functions):

- **Archive `archive.html`:** User actions to unarchive and complete a Task use the protected V1 snapshot route. Failed or missing writer leaves stored canonical bytes unchanged; Gold, history and unknown fields are preserved.
- **Schedule `schedule.html`:** Schedule edits write a merged full V1 snapshot and preserve unrelated imported fields. Missing or rejected writers cannot persist a replacement; failed saves invalidate the page cache.
- **Season seed source `season_seed_sources.js`:** Scoped Season 2 preview rebuild persists through the V1 season writer. A failed save leaves the authoritative scope unchanged and reports failure; a missing helper does not silently persist state.
- **Season 3 October rollover `season3_tournament_rollover.js`:** The automatic protected V1 writer locks 60 seeds exactly once and is idempotent. It refuses insufficient qualifiers, a conflicting active season and a failed canonical write without replacing existing data.
- **Restore lock cleanup `verified_secondary_restore_lock_guard.js`:** Only an owned uncommitted recovery lock may be cleared. A committed/manual hold or a lock owned by a different tab is retained; expired abandoned locks cannot authorize a stale writer.
- **Game History repair `game_history_reconciliation_repair.js`:** The actual repair panel requires a fresh preview and backup confirmation, corrects a known scored history row while retaining matchups/Gold/Tasks, and rejects a stale preview or blocked V1 save without claiming success.

These six source-anchored paths raise behavior-witness coverage to **28/78**. Each explicitly remains `productionOwnerVerified:false`, `productionFenceVerified:false` and `cutoverPermission:false`. **0/78** paths are production ownership certified. These tests do not prove old background tabs are fenced, transaction admission is atomic, or on-device recovery is safe. V2 is still in dark preview, V1 remains authoritative and the migration score stays **67/100**.

## Specific next work to close M01

1. Run the CI source scanner against all 170 files; triage which of the 98 uninspected files access or indirectly modify storage. Move from *inspected* to *writer ownership verified* only with a caller/writer trace, including indirect `TaskPointsCore` saves and dynamic key aliases.
2. Group all literal and computed localStorage keys by authoritative vs derived vs session-only vs recovery-only, and identify how each is imported/exported and reset. Preserve user-defined fields and unknown V1 properties.
3. Audit every other IndexedDB database/version/store and each image read/write/delete and backup path. Include malformed schema and no-DB cases.
4. Map all UI and maintenance entrypoints, including pages, service worker lifecycle, deferred compaction, Phase4/5 mirrors, restore and import, to the nine known legacy writer families; use negative tests where a stale writer must be refused.
5. Compare the full inventory to each proposed V2 owner. M01 is verified **only** when every authoritative source/writer has a reviewed owner or an explicitly preserved auxiliary path, and tests fail if coverage regresses.

**Safety boundary:** none of this changes production storage or a user's data. V1 remains primary; no V2 writer cutover or completed 12-point migration gate is implied. A raw file-count ratio is *not* an engineering-completion percentage.

## November 11 — six independent preferences and rollover routes behavior-rehearsed

The source-executing isolated Node VM tests in [M01 auxiliary preference behavior contracts](../tests/state_runtime_v2_m01_auxiliary_preferences_behavior_contract.test.js) now cover six additional reviewed writer-path anchors: Rankings season-scope selection and Season 4 rollover flag, Standings season-scope selection and rollover flag, Game Ratings inactive-player preference, and Skills level configuration.

Tests check that explicit historical/lifetime/overall choices remain preserved during season transition; season markers are written once; preference choices survive a simulated fresh page; Skills configuration normalizes invalid levels and falls back on damaged JSON; quota-denied writes do **not** change the independent key or `taskpoints_v1` snapshot bytes. Importantly, some existing page UI handlers change their in-memory view even when a preference write fails: this is **not** a durability guarantee and remains an actual handoff design requirement.

M01 behavior witnesses increase **28 → 34 of 78 known routes**, but actual verified V2 ownership and production generation-fenced writer admission remain **0/78**. The 170-file root source pass is not proof of an exhaustive indirect callgraph. V1 is still authoritative; V2 stays preview-only; nothing in this test authorizes migration, Main sync, or cutover. Weighted readiness remains **67/100**.

## November 11 — eight recovery, storage-mode and sidecar behaviors audited

The real-production-module VM suite [M01 mode and recovery sidecars](../tests/state_runtime_v2_m01_mode_recovery_sidecar_behavior_contract.test.js) now behavior-rehearses eight independently inventoried writer anchors: two kill switches (Home targeted render and Habit fast path), the Phase 3 read-mode sidecar, Phase 4 fallback diagnostics, the IndexedDB requalification diagnostics and hold-to-off fallback, emergency recovery committed-lock creation, and expiry of an uncommitted Home recovery lock. These checks include normal persistence/reload, injected quota-denied sidecar writes, explicit recovery hold refusal, degraded-storage fail-closed behavior and protection of committed recovery locks from expiry.

**Source inventory behavior witnesses: 34 → 42 / 78.** These tests do not establish atomic owner handoffs, genuine nonpilot V2 writes, stale-tab protection across deployments, independent rollback or physical Safari durability. The status remains **M01 Working**, **0 / 78 production writer owners certified**, and **67 / 100 weighted gate points**; V1 remains authoritative and Main remains untouched.
