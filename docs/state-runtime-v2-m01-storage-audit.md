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

## November 11 — nine more real legacy writer routes behavior-rehearsed

The [nine-writer source execution contract](../tests/state_runtime_v2_m01_nine_live_writer_behavior_contract.test.js) now rehearses Week's full merged snapshot save, Matchups' full merge, Tournament's deferred Season result resync, the Audit page's two Season/matchup save paths, the Phase 3 verified-session navigation record, Home recovery-attempt TTL cleanup, performance trace session writes, and the exact Season-image reference repair writer. Tests compare preserved `taskpoints_v1` bytes after failures or stale source changes, protect unknown imported fields and Gold where applicable, require explicit readback for image-reference repair and show that sidecar/session writes do not constitute full-state authority.

**Behavior-witness coverage 42 → 51 / 78 routes; M01 remains Working.** These are real-source *isolated VM* checks and intentionally not production admission, cross-tab paused-writer fencing, full import/export recovery, or physical iPhone Safari proof. No V2 primary authority; no Main write or sync; **0 / 78 verified handoffs**, weighted readiness still **67 / 100**.

## November 11 — nine preview, recovery and WAL storage routes witnessed

Real-source, isolated VM tests in [M01 preview/recovery tests](../tests/state_runtime_v2_m01_preview_recovery_nine_writer_behavior_contract.test.js) now exercise nine separate existing inventory anchors: preview dark opt-in, preview-only key cleanup, four isolated V2 IndexedDB deletions, two verified-secondary restore preload writers, emergency-recovery hold, V2 generation-key readback/rotation, WAL test arming, and WAL marker consumption. Verified successful and blocked cases preserve the V1 `taskpoints_v1` snapshot and pending Habit journal, avoid V1 image databases, and never authorize V2 cutover.

**Newly visible limitation:** emergency and verified-secondary preload scripts share a single try block between the hold write and `phase4` mode-off write. A thrown hold write prevents this preload from setting mode off; separate runtime checks remain important and further production fencing is necessary. The test preserves this observed risk rather than claiming fail-closed certification.

Behavioral coverage **51 → 60 / 78**; **0 / 78** V2 production owner/fence proofs. This remains M01 Working and weighted readiness **67/100**. Isolated VM evidence is not live concurrent-tab or physical Safari reliability. Main remains untouched and unsynced.

## November 11 — nine more image, export, Gold and V2 WAL behavior witnesses

The source-executing isolated VM tests at [M01 nine writer behavior contracts](../tests/state_runtime_v2_m01_nine_image_export_wal_writer_behavior_contract.test.js) now rehearse Toolbar image deletion, Storage Diagnostics image deletion, the guarded manual image cleanup transaction, Home export Notes location synchronization, SCWM's deferred original save, V2 WAL shared append and verified removal with independent recovery evidence, retroactive Gold/Matchups score-adjustment save routing, and secondary-page export's schedule-preparation save. No changes were made to live production writer code.

These tests separately assert no unexpected `taskpoints_v1` writes, quota/denial behavior, readback-based WAL durability, cleanup transaction handling, idempotent/no-op branches, and paths where saving may not be available. **Witnessed source routes: 60 → 69/78; verified production owner assignments still 0/78.** M01 remains Working, overall weighted readiness **67/100**. This is not a device-level verification, atomic multi-tab handoff, migration, or permission to cut over. Main was not modified or synced.

## November 11 — first-pass 78/78 legacy storage-writer behaviors rehearsed

The [final nine real-source behavior tests](../tests/state_runtime_v2_m01_final_nine_writer_behavior_contract.test.js) cover Toolbar Inbox auto-population, Toolbar trailing-debounce full-state snapshot flush, verified-secondary restore lock readback/quarantine/commit, the isolated Phase 5C secondary IndexedDB open/promotion writer, the startup no-op snapshot guard, IndexedDB requalification short-test gate writer, requalification resumed-session witness refresh, exclusive fresh-page lock witness, and interactive Habit-Ledger reconciliation save/readback. Tests include negative paths for write refusal, requalification ineligibility, pending journals, missing exclusivity and non-durable saves. Unrelated V1 Gold and imported fields are preserved in appropriate full-state saves.

All **78/78 inventoried writer-path anchors** now have source-executed isolated behavior rehearsals, provided CI passes; none of those rehearsals is automatically a certified production V2 owner. This is a *known-path baseline*, not a proof of complete indirect/dynamic callgraph coverage. **M01 stays Working; 0/78 verified owner/fence assignments**, weighted overall readiness **67/100**, V1 remains primary and no cutover is authorized. Main has not been modified or synced.

## November 11 — Log full-snapshot field-loss repair on V2 only

Source-executing M01 witness tests identified a **real reduced-page-projection overwrite risk** in `log.html`: the page loaded only display fields but passed that object to `saveStateSnapshot` or the raw writer, dropping unrelated Gold, Season, skills and imported extension fields. V2 branch now reads the **full latest authoritative V1 snapshot** immediately before merging the requested Log edit, refusing an overwrite if the stored source cannot be parsed/verified. The same full-source writer is used for derived-point synchronizations; both the normal protected save and the raw fallback retain unrelated fields, while intentional Log completion deletions still persist.

The extended [real Log writer tests](../tests/state_runtime_v2_m01_log_skills_bracket_writer_behavior_contract.test.js) prove retained Gold, Season, skills and imported fields; newly added fields after Log loads; safe refusal on missing full-state reads; fallback behavior; and the derived-points routing. This is a **V2-only legacy safety correction**; it is not a V2 authority handoff. No cross-tab V1 writer fencing or atomic generation lease has been certified. Source-route behavior coverage remains **78/78**, production owner certification **0/78**, and M01 remains Working. `main` was not changed or synced.

## November 11 — Toolbar deferred-save outcome and preview-source safeguard

The previous `toolbar.js` debounce flush **removed its pending full-state snapshot before calling the core saver**. A thrown quota/storage exception, or a nonthrowing `skipped` / `blockedByQuotaCircuit` result, could lose the queued edit without confirmation. V2 branch now deletes a queued item **only after the core save returns an acknowledged state without refusal flags**, retaining pending intent on error for a later explicit retry. `TaskPointsCore.getDeferredSaveSafetyStatus()` reports pending key names and failure counters without exposing or rewriting saved payloads.

For the **V2 dark-preview environment only**, a deferred snapshot queued with a readable generation token now records its exact V1 raw source bytes and preview generation. The delayed flush refuses known newer source bytes, a rotated generation, or preview disablement. These are best-effort same-key checks; localStorage cannot perform atomic cross-tab compare-and-swap, and writers on old pages or other source files remain unfenced. If preview generation is unavailable when queuing, the guard does not claim coverage. The legacy immediate-write path, V1 primary authority, existing import/reset/recovery features and Main were not changed.

[Real Toolbar writer tests](../tests/state_runtime_v2_m01_final_nine_writer_behavior_contract.test.js) now additionally rehearse thrown failures, nonthrowing skipped quota results, later successful retries, external peer changes and preview generation rotation. **No production writer ownership certification:** M01 remains Working; 78/78 known behavior witnesses, 0/78 fully verified writer ownership, and weighted score 67/100.
## November 11 — SCWM delayed-save refusal and preview source fencing (V2 only)

The SCWM (Sleep, Calories, Work, Mood) performance wrapper in `scwm_interaction_fast_path.js` previously cleared `pendingSave` **before** invoking the original Home `save()`. An exception (including quota refusal) could therefore discard a deferred edit. V2 now clears the queue only if that call returns without throwing or explicitly indicating `skipped`, `blocked`, `blockedByQuotaCircuit`, `ok: false` or `false`. The original Home `save()` may return `undefined` after a normal successful call, so that return remains compatible. Failure leaves the exact queued intent in memory for later retry; idle/pagehide/visibility callbacks log and retain it rather than launching an uncontrolled retry loop.

In dark V2 preview, deferred SCWM saves also record the initial decoded V2 generation identifier and the exact V1 snapshot raw bytes. A later changed generation, missing generation, unreadable source, changed snapshot, or preview disablement is refused before invoking the old saver. Subsequent queued edits preserve the first source witness, preventing a stale view from implicitly rebasing onto a newer source. In ordinary V1 mode the preview comparison is absent, preserving original saves and UI flow. [Source-executed M01 regression tests](../tests/state_runtime_v2_m01_nine_image_export_wal_writer_behavior_contract.test.js) prove thrown-error retention, nonthrowing quota refusal, successful retry, source changes, generation rotation and ordinary V1 behavior.

**Limitations:** these best-effort localStorage checks are *not* atomic cross-tab compare-and-swap, do not fence stale already-open legacy pages, and do not guarantee journal, imported-field or recovery correctness across every writer. Existing recovery, restore, import, Home and Game flows remain intact; no Main sync. M01 remains **Working** with **78/78 behavior-tested** known writer routes but **0/78 verified live V2 owner/fence assignments**; weighted readiness **67/100**.

## November 12 — verified-secondary failed mirror retention (V2 branch only)

The Phase 5C verified secondary replica in `phase5b_deferred_mirror.js` previously cleared its in-memory queued V1 source at the start of a background mirror attempt and returned `true` even when `mirror()` returned `false` after an IndexedDB failure. That could leave a stale secondary backup while external callers believed flushing was complete. The corrected `run()` now returns `false` for failed verification, and retains the **latest current V1 source** in the in-memory queue when no Habit journal blocks mirroring. It preserves a newer source that arrived during the attempt. Failed identical bytes do not trigger an unbounded auto-retry; another explicit flush or future normal save can retry, and restart still uses the existing native-backfill scheduling. No authoritative data is deleted or replaced.

Three [production-module tests](../tests/phase5c_verified_secondary_contract.test.js) simulate transient and persistent IndexedDB open denial and a newer authoritative snapshot arriving between a failed and successful attempt. They assert that the secondary mirror cannot claim verified status until the IndexedDB readback passes, pending work remains visible, and V1 remains the source of truth. This is **not** a production V2 owner/fence certification: known behavior witness coverage is still 78/78, **0/78** production owner assignments verified, M01 stays Working and weighted readiness stays **67/100**. No Main sync, cutover, or feature removal.

## November 12 — incomplete image ZIP backup disclosure (V2 branch only)

`home_export_responsiveness.js` previously omitted a referenced image when `getImageBlob()` returned no blob and still displayed a generic “Backup ready” message. V2 preserves the existing downloadable ZIP/import layout, but its `manifest.json` now includes a **scoped** `imageExportCoverage` report with the number of current profile/player image references, included images, missing image IDs and `complete` flag. When any referenced image is missing, the UI clearly warns that the ZIP is **partial for referenced images**, leaves that warning visible, and still provides the ZIP instead of discarding recoverable state. Missing image results are evicted from the in-memory image lookup cache so a photo restored later can be included by a new export. Existing tasks, Notes, Gold, Seasons, extensions, player metadata and image files remain unchanged, and `settings.html` continues to consume `manifest.json` and the original `images/` entries.

Three [source-executed ZIP regression tests](../tests/home_export_responsiveness.test.js) are included in mandatory M01 CI to verify manifest contents, full-state preservation, warnings, download continuity and missing-image recovery on the next export. **Scope limit:** `imageExportCoverage.complete` covers only `youImageId` and current `players[].imageId` references; it does **not** prove a full IndexedDB image census, archived/unreferenced images, or off-device recovery. Consequently, **C01 is Open**, M01 stays Working, 78/78 known source-route behaviors remain rehearsed, **0/78 actual production owner assignments certified**, and overall readiness **67/100**. No Main changes or V2 cutover.

## November 12 — real Task journal synchronous durability acknowledgement (M02 partial)

The existing V1 Task edit/completion mutation path in `task_mutation_journal.js` previously called `setItem()` (or `removeItem()` during compaction) and acknowledged success without a same-key readback. A silently ignored storage call—possible with a custom storage shim or interrupted external storage layer—could leave the UI thinking that a Task edit or completion was saved, then lose it on reload. On the **V2 branch only**, `writeRecord()` now checks the **exact stored raw bytes synchronously** immediately after the attempted write/removal, before any Task journal generation increment, cache invalidation, UI acknowledgement, or idle compaction scheduling. A mismatch or unreadable result raises `TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_WRITE` and keeps the existing durable journal untouched. For explicit reset/recovery clearing, `clearPendingTaskMutations()` now checks that the journal key really became absent before reporting success; otherwise it raises `TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_CLEAR` so stale Task changes cannot be falsely reported as cleared. The original recovery locks, user-facing save paths, import/export machinery, and V1 full-state fallback remain intact.

Five [source-executed regression tests](../tests/task_mutation_journal_contract.test.js) cover ignored first writes, ignored multi-completion batches, ignored overwrites of existing pending edits, ignored reset/removal, and successful exact readback; these run in mandatory M01 safety CI. The additional readback is a **local synchronous acknowledgement**, not an atomic cross-tab compare-and-swap or off-device proof. M02 remains **Working** until actual Home/Tasks operations use admitted V2 transactions and V1 fallback/parity are independently verified. M01 remains Working and C02 remains Open. Current rubric unchanged: 8/23 verified nonpilot checkpoints, 78/78 known V1 behaviors rehearsed, **0/78 production writer owners fenced and certified**, 67/100 weighted readiness. No Main sync or V2 cutover.

## November 12 — Task journal detects stale peer bytes before overwrite (M02 partial)

A foreground Task mutation previously read and modified the live V1 Task journal, then persisted a complete replacement without checking whether another tab had written a newer journal in between. The V2 branch now carries `readRecord().raw` into the synchronous `writeRecord()` path and compares it with the current key immediately before setItem/removeItem. A mismatch produces `TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_CHANGED` and an unreadable source produces `TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_UNREADABLE`, before any overwrite, mutation-generation increment, cache invalidation, acknowledgement, or idle compaction. The guard also covers verified compaction cleanup: if another tab appends between the cleanup read and deletion, the cleanup fails, keeps the peer's pending journal intact, and allows later recovery. Five [production-module regression cases](../tests/task_mutation_journal_contract.test.js) prove two contexts sharing storage, read failure, cleanup races, malformed-journal cleanup refusal and normal sequential use.

These are best-effort localStorage source comparisons, **not** an atomic old-tab fence or an admitted V2 transaction, and do not justify removing synchronous V1 fallback. M02 remains Working, M01 Working, M09 and C02/C03/C04 Open. All 78 known V1 behaviors remain rehearsed; 0/78 live V2 writer-owner handoffs certified; 8/23 verified nonpilot checkpoints; 67/100 weighted readiness. Main unchanged.

An additional M02 compaction safety guard explicitly requires `clearVerifiedSnapshot(snapshot)` to return `true` before incrementing completed-compaction counters, resetting retries, or reporting a successful flush. A malformed journal appearing during snapshot persistence is preserved rather than misreported as cleared. This is not a V2 transaction handoff.

## November 12 — live Task action to isolated V2 preview mirror (M02 partial)

On the V2 branch, the **real** `task_mutation_journal.js` now notifies `TaskPointsStateRuntimeV2.queueObservedLegacyTaskJournal()` **only after** the existing synchronous V1 Task mutation journal was written and its bytes verified. The hook does not await IndexedDB, calculate a full-origin token, change return values, or touch the UI; a missing, disabled, or erroring V2 observer is ignored. The runtime observer is eligible **only** on preview hosts with the existing V2 dark mode and reset-generation evidence. It schedules preview processing after a 9-second delay and a minimum 7-second storage-idle preflight (or permits an explicit preview-only diagnostic flush). It invokes the existing guarded Task seed or atomic record/receipt reconciliation from the latest effective V1 Task state (including pending journal overlays), then independently checks full Task parity. All operations retain `mutationAuthority:'legacy_only'`, `readAuthority:'legacy_only'`, `canPromote:false` and `productionWritersFenced:false`. No main-site authority, snapshot, journal or reset behavior is replaced.

To prevent this new observer from overwriting unexplained preview data, initial Task collection seeding refuses unowned Task rows or lifecycle evidence when a Task seed receipt is absent, and repeats the unowned-record check **inside the IndexedDB readwrite transaction**. Stored V1 pending Task journal sources now require complete schema-1 array shapes, recognized keys and valid Task/completion/delete entries before normalization; otherwise the raw record remains untouched and pending mutations/compactions are refused instead of dropping invalid or unknown fields. Older valid schema-1 journal records without optional `updatedAtISO` continue to load.

[Seven integration tests](../tests/state_runtime_v2_task_live_journal_bridge_contract.test.js) execute the production Task journal and full V2 runtime with a simulated IndexedDB. They verify two consecutive real V1 actions, no V2 foreground writes, background parity, idle deferral, disabled production behavior, failed journal writes, unowned preview rows and reset-generation changes. [Two additional journal tests](../tests/task_mutation_journal_contract.test.js) cover malformed/incomplete/unknown journal records and older valid records. Mandatory V2 core CI runs these tests. **Limitations:** this is a read-only-to-V1, write-only-to-V2 *preview synchronization bridge*, not writer ownership. It does not guarantee old-tab cooperation, pre-paint durability of V2, accepted V2 mutations across all Task paths, or rollback certification. M02 stays Working, M01 stays Working, M09/C03/C04 stay Open, 8/23 nonpilot checkpoints verified, 0/78 production V2 writer owners certified, 67/100 weighted readiness. Main remains untouched.

The live Task observer now filters journal notifications to actual Task/Task-linked mutations, avoiding redundant V2 Task scans for unrelated Work or SCWM batches. Automatic observation retries up to three additional quiet windows after an active-use preflight refusal, without an unbounded polling loop; an explicit developer-only flush remains available. Required integration coverage confirms both conditions.


## November 12 — blank-present Task journal is not a safe absence (M02 partial)

The real V1 Task journal reader previously interpreted any falsy storage result as a missing journal. In particular, a **present empty-string key** could be silently treated as no pending work, and the next Task edit would replace those suspicious bytes. On V2, only `localStorage.getItem('taskpoints_pending_task_mutations_v1') === null` qualifies as genuine absence. A present `''`, whitespace/invalid JSON, or a nonstandard `undefined` result from a storage shim is now **malformed** rather than safe to rewrite. The original bytes are left intact; mutation admission, background compaction and false durability acknowledgement are refused. A genuinely missing key and older valid schema-1 journals still work normally.

Two [production-module regressions](../tests/task_mutation_journal_contract.test.js) cover blank-but-present pending data and unreadable shim results; additional real-browser checks exercise both blank and whitespace sources through preview Task admission. This does not establish a V2 writer handoff, complete inventory, or multi-context fence. M02 and M01 stay Working, **8/23** preview-scoped prerequisites Verified, **0/78** production writers fenced/certified, **67/100** weighted rubric, V1 primary. Main untouched.


## November 12 — preview Task catch-up across reload after journal compaction (M02 partial)

A real Task mutation already schedules the **optional** V2 Task preview observer only after its synchronous V1 journal write. However, a page can close before that delayed observer runs. The existing V1 maintenance worker may already have compacted the pending Task journal into the canonical V1 snapshot, leaving **no pending journal on reload**; the isolated V2 Task preview might therefore remain stale indefinitely until another Task edit occurs.

On preview hosts with dark mode enabled, `startCoordinatedDarkMirror()` now schedules **one bounded idle Task catch-up opportunity per startup generation/epoch** after the existing dark/WAL startup has settled. It uses the same `queueObservedLegacyTaskJournal()` pathway as foreground-triggered Task observations, not a new writer. No task IDB read, snapshot scan, or Task write is performed before UI paint. The task mirror still waits for the 9-second delayed callback and at least 7 seconds of user idle; it postpones or refuses while active/hidden, on generation rotation, invalid legacy journal, missing seed, malformed source, or unowned preview evidence. The background observer re-reads V1's **effective** Task state; an existing preview is reconciled with an atomic receipt, and subsequent source/parity readbacks remain mandatory. All V1/localStorage Task data, journals, import/export paths and recovery protections remain authoritative and unchanged.

[Production-source/fake-IDB integration tests](../tests/state_runtime_v2_task_live_journal_bridge_contract.test.js) now exercise an originally compacted snapshot that contains no pending journal, a genuine new VM context reusing the previous context's persisted localStorage+IDB, review of the previously seeded Task collection, later V1 edit/add followed by reload, one startup opportunity, no foreground scan, successful isolated Task parity, source-byte preservation, production exclusion and duplicate-start suppression. [Real browser regression](../tests/browser/run-v2-browser.mjs) likewise seeds Task preview, updates only the full V1 snapshot, reloads, flushes queued idle preview work, and checks strict read-only parity with unchanged V1 bytes and authority in Chromium/WebKit. Existing pilot/WAL bootstrap order is retained and [startup source contract](../tests/state_runtime_v2_dark_contract.test.js) checks the new post-boot observer order.

**Scope:** This is neither a live Task writer admission nor a production-only cutover, and does not solve a non-cooperating old tab, complete M01 ownership or full app backup. M02/M01 remain Working, **0/78** writer owner/fence certificates, **8/23** preview prerequisites Verified, **67/100** weighted readiness. Main was neither modified nor synchronized.


## November 12 — pending Task preview survives a hidden-tab deferral (M02 partial)

The preview-only V1 Task observer deliberately avoids IndexedDB reconciliation while its page is hidden. Its nine-second timer previously returned with the request still marked pending but **without rescheduling**; a tab that became visible again could remain stale until another Task event, fresh reload or manual diagnostic flush. On V2 preview hosts, coordinated startup now also installs **one** lightweight `visibilitychange` listener alongside the already-gated peer storage listener. If a deferred Task catch-up is still pending when the page becomes visible, it schedules the **existing delayed idle preflight**, never an immediate IndexedDB scan. A duplicate visibility event, already-running catch-up, disabled dark preview, background event, or production host cannot spawn extra work. Existing generation/reset checks, pending journal integrity checks, independent parity, full V1 authority and recovery gates remain mandatory.

[Two production-runtime integration tests](../tests/state_runtime_v2_task_live_journal_bridge_contract.test.js) exercise hidden timer deferral, visible resume, deferred-only processing, duplicate events, dark-disable and production exclusion. This does **not** mean M02 completion or V2 Task writer ownership. All 78 known V1 behaviors remain rehearsed, 0/78 handoffs certified, 8/23 checkpoint gates verified, weighted readiness 67/100; Main unchanged/unsynced.


## November 12 — Task compaction rejects a changed V1 snapshot source (M02 partial)

A Task journal may be perfectly unchanged while **another tab commits an unrelated or newer full `taskpoints_v1` snapshot** during decompression of the candidate for deferred Task compaction. If the original candidate were saved, it could replace that peer's newer Notes, completion history, Tasks or other fields. On the V2 branch, `persistPending()` now captures the **exact raw V1 snapshot bytes** first, decodes that same capture, and compares the stored source with those bytes immediately before invoking the existing full-state writer. A changed/missing/unreadable source fails closed: **no full save is attempted**, the Task journal stays pending, and a later retry can safely recompute from the latest V1 snapshot. Diagnostic status exposes `snapshotSourceConflicts` separately from journal-source conflicts. The older journal byte-readback, verified cleanup, row-aware interleaving, normalized/compacted Task verification, quota behavior and import/reset protections are preserved.

Three [production-module source tests](../tests/task_mutation_journal_contract.test.js) simulate a peer full snapshot changing during parsing (including unrelated Notes/completion history), removal during parsing, and unreadable source, then check that the original journal survives and a fresh retry preserves both sets of changes. A [Chromium/WebKit real-browser scenario](../tests/browser/run-v2-browser.mjs) exercises the full Task journal path against a synthetic V1 state. The [writer handoff contract](../tests/state_runtime_v2_writer_handoff_matrix_contract.test.js) checks that both journal and V1 snapshot freshness checks precede the full-state writer. This is a **best-effort, non-atomic** cross-tab race reduction: a nonparticipating old tab can still write after the final check. M02 and M01 remain Working, 0/78 owner/fence certificates, 8/23 preview foundations verified, 67/100 weighted readiness. V1 remains live authority; Main untouched and unsynced.


## November 12 — ordinary V1 full saves refuse changed pending Task sources (M02 partial)

The V2 branch already protects its **background Task journal compaction** against observable changes to pending journal bytes and its source full snapshot. The ordinary `saveStateSnapshotWithTaskJournal()` wrapper also prepares a full V1 save with a potentially large, asynchronous-to-other-tabs parse/merge. During that preparation another tab can replace the pending Task journal or the full `taskpoints_v1` snapshot. Replaying the originally captured journal against the older snapshot would risk ignoring newer peer edits.

For ordinary full saves with **a valid, nonempty pending Task journal**, the wrapper now captures the exact raw source snapshot used for its sticky-field safety merge, then rechecks **both** the pending Task journal and full V1 snapshot immediately before calling the existing full-state writer. If either source changed or became unreadable, it returns a `skipped` result with explicit `blockedByTaskSourceChanged` evidence rather than throwing into Home's unguarded last-ditch fallback. It preserves the peer's stored bytes and pending Task mutations for a fresh retry; counters distinguish journal conflicts, snapshot conflicts, and refused ordinary saves. This does not alter normal full saves when **no** pending Task journal exists.

[Four real-module regressions](../tests/task_mutation_journal_contract.test.js) cover a peer's later Task journal edit during parsing, a newer full snapshot with extra user data, denied source readback, safe retry and ordinary no-journal saves. A [Chromium/WebKit browser scenario](../tests/browser/run-v2-browser.mjs) tests the actual V1 save wrapper and retry under an interleaved peer journal edit. In `index.html`, direct Weight and VO₂ Max form saves now explicitly handle any `skipped`/quota-refused result, displaying a retry message **before** updating the UI or closing its input modal. A source-anchored regression enforces both dialog safeguards. The existing `save()` path already recognizes skipped results.

**Boundary:** This is a best-effort stale-tab safety guard, not cross-context atomicity, Task ownership in IndexedDB or a production cutover. An old non-cooperating tab may still write after the final preflight. The normal V1 Task journal, recovery locks, export, backup, all existing score/habit paths and fallback remain in place. M01/M02 stay Working; 8/23 preview-scoped checkpoints remain Verified, no owner handoffs certified (0/78), weighted readiness 67/100. Main was not changed or synchronized.


## November 12 — two-tab Habit journal visibility must settle before strict assertion (C03 partial)

The last combined safety CI on V2 commit `a4462b5` passed the complete source/contract workflow and WebKit runs, but **Chromium run 3 failed** in the existing parallel two-tab Habit journal test. The exact failure was its immediate first-tab assertion observing only Habit `h1`. The failure diagnostics taken milliseconds later from that same browser context already showed **both `h1` and `h2` in the durable V1 Habit journal**, indicating a cross-tab visibility timing race in the test's first observation rather than proven durable loss. It is still a mandatory test failure, not a pass.

The [real-browser contract](../tests/browser/run-v2-browser.mjs) now waits, with a strict **12-second failure deadline**, until the first tab can observe both completed writers through the real `TaskPointsCore.readPendingHabitDeltas()` read path. It then retains the exact two-Habit assertion, confirms WAL recovery after reopening, and checks full V1/V2 parity and same-generation preservation. This never accepts missing records, skips the scenario, changes the live Habit writer or relaxes the final tests. A genuine lost write still fails at the deadline. **No feature or production authority was altered.**

C03 remains Open pending actual all-writer fencing and multi-tab correctness. M01/M02 Working; 8/23 preview checkpoints Verified, 0/78 production handoffs certified and 67/100 weighted readiness unchanged. Main untouched. New Chromium/WebKit CI must pass before describing this timing correction as verified.


## November 12 — denied Task journal reads cannot trigger Home's unguarded fallback (M02 partial)

The existing V2 Task journal wrapper made ordinary `saveStateSnapshot()` calls read the pending V1 Task journal first. If the browser/storage layer threw while reading that key, the exception could reach Home's `save()` catch block, which has a **last-ditch direct full-snapshot writer** that does not replay unreadable pending Task edits. On V2, that initial journal read is now enclosed in a fail-closed guard: an unreadable journal returns `{skipped:true,blockedByTaskJournalUnreadable:true}`, records a refusal diagnostic, and does not touch the canonical snapshot, pending journal, or Task UI save acknowledgement. Existing Home `save()` checks the `skipped` result before returning success, so it does not enter the direct exception-based fallback. Recovering the storage read allows the same guarded save to be retried normally.

[Two production-module regressions](../tests/task_mutation_journal_contract.test.js) prove a denied journal read cannot throw into Home's catch fallback, cannot call the underlying snapshot writer, preserves V1 state and pending Task evidence, and resumes after storage recovers; a genuinely absent journal remains compatible. Settings' **Game stats reset** and **Clear all skills** fallbacks now also explicitly reject `skipped` or quota-denied full saves, using their existing visible error paths rather than displaying a false success confirmation. A source regression checks both Settings callers. No reset capability, import/export path, backup or recovery protection was removed; under unreliable storage, writes are postponed rather than claimed as saved.

**Scope:** A refused save is not a migration or a guarantee of atomic cross-tab fencing. All existing V1 save/restore formats remain authoritative; the user still controls recovery. M01 and M02 remain Working, C03 Open, 8/23 preview checkpoints Verified, 0/78 production writer owner assignments certified, weighted rubric 67/100. Main untouched and unsynced.

The Settings Game-stat reset source check additionally covers the preferred `saveValidatedSnapshot()` path: a returned `blocked` / `skipped` / quota-denied status now triggers its existing failure message instead of the previous success alert. This is separate from the ordinary Task journal wrapper; validated destructive imports and recovery remain available and continue using their own safeguards.


## November 12 — preview Task journal refuses an obsolete reset generation (M02 / C03 partial)

The real V1 Task journal already has read-before-write source-byte checks and recovery locks, but a **suspended preview tab** could wake after another tab's reset/import rotated the V2 generation and still attempt to append or compact Task edits from its previous page lifetime. That stale write is unsafe against a newer restored snapshot. On the V2 branch, the Task journal now captures the initial `taskpoints_state_v2_generation_v1` token **only on localhost or nonproduction preview hosts with dark mode already enabled**. The shipped core bundle loads `state_runtime_v2_generation.js` before the Task journal. Each subsequent **foreground Task mutation** checks the token before reading/admission and immediately again before its synchronous journal write; background Task compaction checks before processing and before the full snapshot writer. A rotated or unreadable epoch refuses an old preview tab's write and leaves the pending V1 journal and full V1 snapshot untouched. No asynchronous IndexedDB request or expensive state scan was added to the foreground Task save path.

The check is **disabled on production hosts** and when preview dark mode is explicitly turned off. An old preview tab must reload after a reset to adopt the new generation. The existing synchronous V1 journal remains the only acknowledged Task durability path; the V2 IndexedDB store stays an isolated observer. New [source-executed regression cases](../tests/task_mutation_journal_contract.test.js) cover stale Task edits, generation change between preflight and write, rotation during quiet compaction, denied reads, valid new-generation reload, preview-off and production-host exclusions, and the shipped bundle order. [V2 integration harness](../tests/state_runtime_v2_task_live_journal_bridge_contract.test.js) now reproduces the real bootstrap's generation-before-Task-journal order. The [Chromium/WebKit scenario](../tests/browser/run-v2-browser.mjs) uses the real generation rotation API and verifies old-tab refusal, no Task compaction, unchanged V1 bytes and legacy authority.

**Known limitations:** this is still **not** cross-tab atomic compare-and-swap or complete writer fencing. Code running in a pre-V2 tab cannot be forced to participate; the direct recovery/reset Task-journal clear path, ordinary snapshot writers, old branches and nonpilot collections still need individually proven admission/rollback behavior. No Task data is moved to authoritative IndexedDB, and no live production V2 read/write switch occurs. M02 stays Working, C03 stays Open, **0/78** certified production writer owners, **8/23** Verified preview-scoped foundations, **67/100** weighted readiness. Main was not modified or synced.


## November 13 — all legacy image Blob bytes, including orphan rows (C01/M01 partial)

The read-only V2 preview method `inspectPreviewLegacyImageBytes(expectedInventoryToken)`
checks the **entire existing legacy IndexedDB `taskpoints/images` store**, not
just the image IDs referenced by current player fields. It never opens an
absent database in upgrade/create mode, never mutates or exports a record, and
requires the exact live full-origin token, a stable preview reset generation,
and an available cooperating-browser lock. Two separate readonly captures
check the complete key list and digest each stored Blob's actual bytes using
SHA-256, then require identical row identities, byte lengths, MIME types and
content hashes. A concurrent same-count replacement cannot silently pass as
the same source if observed between those captures; comparing fingerprints
across independent audits also detects changes in otherwise identical
record counts. Unreadable, non-Blob, over-budget or changing records fail
closed. The byte cap is 64 MiB and the row cap is 512; exceeding either does
**not** qualify as verified image coverage.

The new [browser rehearsal](../tests/browser/run-v2-browser.mjs) uses disposable
real IndexedDB with one referenced and one orphan image; checks exact
fingerprint changes after a peer replaces the orphan without changing counts;
and rejects a non-Blob row or stale localStorage token. The
[source contract](../tests/state_runtime_v2_legacy_image_bytes_contract.test.js)
is required by V2 core CI. Browser implementations that refuse Blob cloning
are explicitly reported as **not verified** rather than counted as success.

**Scope limits:** A local image-byte digest is not an independent off-device
backup, does not prove all image references or other IndexedDB stores, cannot
atomically fence noncooperating old tabs, and does not offer a restore. The
older count-only whole-origin audit remains unchanged. No migrations,
production writes or live image owner handoffs occurred; **C01 remains Open,
M01 remains Working, 0/78 writer handoffs certified, 8/23 checkpoints verified,
67/100 weighted readiness**. V1 is still authoritative; Main untouched.
