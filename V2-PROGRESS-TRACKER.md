# TaskPoints V2 — Progress Tracker

> **Branch:** `arch/state-runtime-v2-plan` only · **Established:** 2026-11-10
> **Baseline evidence:** [V2 commit e64cceb](https://github.com/mkhrrs89/TaskPoints/commit/e64ccebe21ec5b8f6af2688ea6b47fd10b9ac6a7) · [Contracts CI](https://github.com/mkhrrs89/TaskPoints/actions/runs/42846573945) · [Chromium/WebKit CI](https://github.com/mkhrrs89/TaskPoints/actions/runs/42846574123)
>
> **SAFETY:** `main` must never be written from this conversation. V1 remains the only live storage authority. All preview features stay dark/non-production; do not activate V2, synchronize Main, delete safeguards, weaken test gates, or promote without the user's explicit instruction and required verification.

## Today's scoreboard

| Measure | Current | What it actually means |
| --- | ---: | --- |
| **Nonpilot engineering checkpoints verified** | **8 / 23** | Eight *preview foundations* have passing evidence. This is a count, **not** "35% ready" or a prediction of time to completion. |
| Checkpoints under active development | **6** | Work has begun, but their pass conditions are **not** met. |
| Checkpoints still open | **9** | No complete evidence for their pass condition. |
| **Next weighted gate: nonpilot migration** | **0 / 12 points credited** | Only earns the **12** points when all 23 checkpoints and the gate's stated acceptance conditions pass. |
| **Total weighted cutover-readiness rubric** | **67 / 100 points** | Five previously credited planning gates, **not** 67% of engineering hours/code/remaining time. |
| **Other blocked cutover gates** | **11 + 5 + 3 + 2 points** | Production writer fencing; independent off-device recovery; physical iPhone Safari; explicit authorization/cutover. |
| Former "98% to escaping 67%" | **Withdrawn** | No auditably defined denominator or acceptance evidence supported it. Do not reintroduce it. |

**Next meaningful unlock:** finish the complete nonpilot-authority collection migration (the 12-point gate). The first **immediate target** is **M01** (complete authoritative key/field inventory), then **M02** (Task live mutation admission/integration behind safe gates). Preview proofs alone never pass live checkpoints.

## How to read/update this board

- **Verified** means the *exact, narrowly worded pass condition* in that row has code, a passing test, and an inspected supporting source. A verified **preview** row does **not** imply any live feature has migrated.
- **Working** means implementation/evidence exists but its explicit pass condition has **not** been demonstrated. **Open** means no complete implementation evidence yet. Neither earns credit.
- **Stable IDs:** P01–P08 = eight required preview foundations; M01–M09 = nine live migration requirements; C01–C06 = six full-feature acceptance requirements. **23 total**. Do not silently add/remove/split/rename requirements. If an additional requirement is genuinely discovered, document its source, explain the change, increment the tracker version and denominator, and retain a before/after history entry.
- **Promotion is a separate decision:** even 23/23 does not enable V2. The remaining weighted gates are independently mandatory, especially physical iOS validation and user-approved cutover.
- **After every "go" session:** link the commit(s), list IDs moved **Working/Open → Verified** (if none, say **none**), show previous → current counts, summarize code/tests that improved *unverified* rows, identify the next blocker, and note CI status. No artificial progress percentages.
- Checkpoints marked Verified can revert to Working if tests or source proof regress. The tracker counts must follow the actual statuses, not vice versa.

## Stage P — prerequisite preview foundations (8 Verified)

These are **required groundwork**, intentionally less ambitious than deployed storage authority. They are marked Verified only for these *preview-scoped* claims.

| ID | Status | Pass condition actually established | Evidence |
| --- | --- | --- | --- |
| P01 | Verified | Effective V1 Tasks/Task-linked completions can be represented as separate V2 preview records and explicitly reconciled with atomic receipts and parity checks; no deployed Task authority. | [Task parity contracts](tests/state_runtime_v2_task_collection_parity_contract.test.js), [Task reconcile scenarios](tests/state_runtime_v2_task_reconcile_scenarios_contract.test.js) |
| P02 | Verified | V1 Today sparse day maps can be preview-seeded, reconciled and rebuilt into a compatibility document; detached sealed candidate and isolated-context package rehearsal reject corruption. No live Today read/save/restore. | [Today contracts](tests/state_runtime_v2_today_collection_contract.test.js), [browser safety](tests/browser/run-v2-browser.mjs) |
| P03 | Verified | Projects preview stores ordered records with atomic receipts and explicit V1 parity/reconciliation; never overwrites V1 Projects. | [Projects contracts](tests/state_runtime_v2_projects_seed_contract.test.js) |
| P04 | Verified | Dual-source Notes preview captures content, dirty/authority markers and saved bundle revisions with protective receipts, without taking Notes authority. | [Notes bundle contracts](tests/state_runtime_v2_notes_bundle_contract.test.js), [Notes sync](tests/state_runtime_v2_notes_snapshot_sync_contract.test.js) |
| P05 | Verified | Game preview stores players, seasons/history and rebuilds a compatibility projection with parity and source-change rejection; not an authoritative Game writer. | [Game collection contracts](tests/state_runtime_v2_game_collection_contract.test.js) |
| P06 | Verified | Gold ledger preview captures transactions/economy and verifies append/reconcile semantics and historical transfer integrity; no production Gold authority. | [Gold ledger contracts](tests/state_runtime_v2_gold_ledger_contract.test.js) |
| P07 | Verified | Three independent Game UI preferences are located and source-validated without changing old keys. This does **not** cover all app preferences. | [Game preferences contracts](tests/state_runtime_v2_game_preferences_source_contract.test.js) |
| P08 | Verified | Habit-order sidecar can be inspected/reconciled in a preview with retention of existing live ordering/storage authority. | [Habit-order sidecar contracts](tests/state_runtime_v2_habit_order_sidecar_contract.test.js) |

## Stage M — actual nonpilot feature migration (0 Verified; 6 Working, 3 Open)

A preview test does **not** satisfy these. For each feature, success must show that a genuine user action produces a single durable logical change in V2 **under the required admission/generation rules**, survives restart/quota/interruption, preserves the original V1 compatibility and rollback route, and works from the actual page. Do **not** enable live authority while the separate writer-fence and recovery gates remain blocked.

| ID | Status | Pass condition required before marking Verified | Current blocker / evidence |
| --- | --- | --- | --- |
| M01 | Working | Exhaustive, reviewed inventory maps **every** authoritative field, localStorage key, IndexedDB store, pending journal and cross-page writer to its V2 owner or preserved auxiliary storage, including imports and resets. | [Writer matrix](docs/state-runtime-v2-writer-handoff-matrix.md) and [legacy writer tests](tests/state_runtime_v2_legacy_writer_inventory_contract.test.js) are substantial but explicitly **not exhaustive**. Audit all current page/key paths first. |
| M02 | Working | Real Home/Tasks actions (create, edit, delete, finish, historical completion) take admitted transactional V2 writes, with synchronous pre-paint durability and V1 fallback/parity. | Preview task actions/journal protections exist, but [Home](index.html) and [Task journal](task_mutation_journal.js) still use V1 paths; no proven live handoff. |
| M03 | Working | Real Today page add/edit/reorder/remove and notes writes use admitted V2 day-row transactions and survive reload/quota without losing empty/absent days. | Preview Today's row/rebuild/recovery work exists; [Today](today.html) still uses legacy `saveTodayStore()`. |
| M04 | Working | Real Projects create/edit/delete/order operations commit as admitted atomic V2 changes with compatible project exports/restores. | Preview project reconcile + cooperative writer experiments exist, but [Home](index.html) keeps a direct `tp_projects_v1` path. |
| M05 | Working | Real Notes first edit, rapid/repeated edits, dirty markers and snapshot continuation are durable/coherent as an admitted V2 write, including interruption and restart. | Preview Notes first-edit/sync experiments exist. [Notes page](notes.html) continues legacy writer/cache behavior. |
| M06 | Working | Real Game/player/season/matchup changes and separate player sort/group/gallery settings use admitted V2 transactions while maintaining original behavior and images. | Preview Game projection/action, image and preference audits exist; [Game](game.html) still writes through V1. |
| M07 | Open | Real Gold ledger/economy/settlement events have exactly-once admitted V2 commits, validated balances and compatible recovery without changing gameplay outcomes. | Gold preview audits only; live feature saves not migrated. |
| M08 | Open | All remaining auxiliary preferences, Habit-order sidecars, Today settings and other M01-discovered keys have verified ownership and durable write paths without data loss. | Partial sidecar and Game preference previews; whole-app auxiliary inventory incomplete. |
| M09 | Open | All nonpilot writers can navigate Home ↔ Today ↔ Notes ↔ Game ↔ Settings and preserve one logical edit through page close/reopen and coexistence with pending journals. | Page-level simulations exist, but no end-to-end deployed V2 authority across pages. |

## Stage C — complete nonpilot migration acceptance (0 Verified; 6 Open)

| ID | Status | Pass condition required before marking Verified | Current blocker / evidence |
| --- | --- | --- | --- |
| C01 | Open | Full V1-compatible app snapshots, JSON/import/export, settings backups and Game ZIP/photo references round-trip every migrated field and extra key; no omissions. | Partial compatibility and Game ZIP tests, not an independently verified *entire app* round-trip. |
| C02 | Open | Reset All, manual restore, emergency recovery, backup slots/quarantine and storage locks preserve all features; stale V2 generations cannot resurrect deleted/restored state. | Pilot + preview recovery checks only; whole-app handoff remains blocked. |
| C03 | Open | Real user actions in **every** migrated family prove no duplicate/missing data after immediate close/reload, quota denial, partial transaction, and interrupted compatibility snapshot. | Isolated family simulations; no complete multi-feature deployed action matrix. |
| C04 | Open | Complete latest-state V1↔V2 parity across all authoritative fields (including Task/Habit journals, Gold, Game history, Notes, Today, Projects) under interleaved edits and restarts. | Multiple scoped parity proofs exist; no single audited *all-field* production scenario. |
| C05 | Open | Mobile foreground performance is measured against representative growing user data with a no-regression threshold, without sacrificing durability or feature behavior. | Pilot trace/idle test infrastructure exists; no comprehensive nonpilot workload signoff. Actual physical Safari qualification is a **separate 3-point gate**. |
| C06 | Open | A single nonpilot end-to-end acceptance suite verifies M01–M09 and C01–C05 and is green in required browser simulations; all compatibility, fallback and rollback plans reviewed. | No complete suite can pass until the live paths above exist. The 12-point gate is uncredited. |

## Separate cutover gates — NEVER infer these from the 8/23 tally

| Weighted gate | Credited | Remaining acceptance |
| --- | ---: | --- |
| Production legacy-writer exclusion and generation fencing | 0 / 11 | All old writers, deferred compaction and background callbacks fenced, including stale tabs; [writer matrix](docs/state-runtime-v2-writer-handoff-matrix.md) notes still-unfenced paths. |
| Independent off-device whole-app recovery | 0 / 5 | Exported authenticated and restorable full-origin/IDB/image bytes, interruption and rollback tests. **A signed Today-only package is not a whole-app backup.** |
| Physical iPhone standalone Safari | 0 / 3 | Repeat real-device kill/relaunch, quota denial, backgrounding, and restore scenarios. WebKit simulation alone is insufficient. |
| Explicitly authorized final cutover | 0 / 2 | User approves after all gates pass; no automatic V2 activation or V2→Main merge. |

See [weighted acceptance rubric](docs/state-runtime-v2-weighted-milestones.md) for the exact 67-point accounting and [architecture plan](docs/state-runtime-v2-plan.md) for non-negotiable safeguards.

## Daily change log

| Date/session | Verified checkpoints | New verification | Outstanding checkpoint change | GitHub proof |
| --- | ---: | --- | --- | --- |
| 2026-11-10 — audited baseline | **8/23** | Inspected V2 runtime, live page writers, source/contract suites and green browser/contract CI. All 8 completed rows are **preview-scoped** only. | **6 Working, 9 Open**. Next: M01 exhaustive source/writer inventory. No nonpilot gate credited. | [Baseline V2 head](https://github.com/mkhrrs89/TaskPoints/commit/e64ccebe21ec5b8f6af2688ea6b47fd10b9ac6a7) · [CI contracts](https://github.com/mkhrrs89/TaskPoints/actions/runs/42846573945) · [CI browser](https://github.com/mkhrrs89/TaskPoints/actions/runs/42846574123) |

| 2026-11-10 — tracker introduced | **8 → 8 / 23** | **0 newly verified**. Established 23 stable IDs, fixed pass conditions, source/test links, and a CI status-count/evidence guard. | M01 still Working: audit remaining authoritative keys/writers before production integration. No weighted milestone unlocked. | [Tracker created](https://github.com/mkhrrs89/TaskPoints/commit/e81a8bbf2d26fbb1933eb8a9b6be3431b5b2bb15) · [CI guard added](https://github.com/mkhrrs89/TaskPoints/commit/c5093827b7ee3e0e841b2ef43cb5fa6a870a10bf) · [Future-completion guard fixed](https://github.com/mkhrrs89/TaskPoints/commit/991e63007a97252814ebdaffbb61691d0a71a3da) |

**Future update format:** `old verified/new verified · IDs completed · IDs still blocked · code commits · tests pass/fail · next closure target`. If work improves a Working item but doesn't finish its pass condition, explicitly write **0 new checkpoints verified**. Never report the withdrawn "98%" or a fabricated replacement.
