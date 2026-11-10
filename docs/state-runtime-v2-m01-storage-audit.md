# M01 — TaskPoints authoritative storage and writer audit

**Branch:** `arch/state-runtime-v2-plan` · **First-pass evidence:** 2026-11-10  
**Result:** **M01 Working, NOT Verified.** This document records what is known and what remains to prove before V2 takes over any feature.

## Measurable first pass

| Observable | Initial result | Meaning |
| --- | ---: | --- |
| Tracked root-level production JS/HTML/MJS files | **168** | Reproducible source-file baseline; tests and docs excluded |
| Files personally inspected at the source level this pass | **20** | **148** other files still need independent review |
| Key-to-source evidence entries | **33** | Source-linked references (one Notes key has two legitimate roles) — **not** all unique persistence keys |
| Known IndexedDB database/store evidence examples | **3** | `taskpoints/images`, safety vault snapshots, and V2 preview DB |
| Explicit primary snapshot fields in `normalizeState` | **30** | Reproducible named-field lower bound, NOT entire V1 schema |

Reproducible manifest: [source inventory](state-runtime-v2-storage-source-inventory.json). Every tracked source filename and the 30 named `src.` fields are checked in V2 CI by [M01 inventory contracts](../tests/state_runtime_v2_m01_source_inventory_contract.test.js). CI also checks key/database evidence paths exist. A new root-level source file or a new explicitly normalized field **fails the CI inventory guard** until the manifest is consciously updated. A new indirect/dynamic writer *inside* an existing file is not guaranteed to be caught; this is not a completed-callgraph proof.

## What is actually stored separately

| Family | Known source of truth / source-specific record | Direct/indirect save path checked so far | Missing ownership proof |
| --- | --- | --- | --- |
| Main V1 snapshot | `taskpoints_v1`; normalized known fields plus unknown `...src` extension fields | `scoring_core.js`, `index.html`, `settings.html` | Enumerate dynamic/derived fields and every page/helper capable of rewriting snapshot |
| Pending Habits and Tasks | `taskpoints_pending_habit_deltas_v1`, `taskpoints_pending_task_mutations_v1` | `scoring_core.js`, `task_mutation_journal.js` | All completion/compaction, replay, reset, stale-tab and fallback writers |
| Today | `taskpoints_today_view_v1` | `today.html` (`saveTodayStore`), Home also references Today | Link each Today/SCWM/Notes UI event to authoritative write and the V2 equivalent |
| Notes | `taskpoints_notes_v1`, dirty and authoritative markers; main V1 `notes` | `notes.html`, `scoring_core.js`, `settings.html` | Finish dirty-first edit and snapshot-sync recovery and ownership |
| Projects | `tp_projects_v1`; legacy V1 `projects` | `projects.html`, `index.html` | Reconcile every independent editor and import/export behavior |
| Game and seasons | Main V1 `players`, `seasonHistory`, `matchups` etc; separate gallery/sort/group keys | `game.html`, `season.js`, `settings.html` | All gameplay, result, gold, season archive, manual repair and auxiliary settings paths |
| Gold | Main V1 Gold/economy fields, settlements and secondary result claims | `greed_gold_economy.js`, `gold_ledger.html`, `index.html` | Outcome, margin, theft, repair and replay writers; no live V2 ownership |
| Pictures | IndexedDB database `taskpoints`, object store `images` (binary blobs) | `scoring_core.js` | All image refs, backup/export bytes and restore with no omission |
| Backups / recovery | Backup slots, quarantined state, `taskpoints_safety_vault_v1/snapshots`, phase4/5 markers | `scoring_core.js`, `settings.html`, `phase2_reset_hook.js`, `phase4_storage_coordinator.js` | Source-complete export/import, generation rotation, emergency restore and old-tab effects |
| V2 previews | `taskpoints_state_v2`, preview Notes, Game, Habit ordering and checkpoint DBs | `state_runtime_v2.js` | Distinguish strictly preview-only writes from eventual production admission; no unauthorized promotion |

**The main snapshot is open-ended.** In `scoring_core.js`, `normalizeState` spreads `...src` before normalizing named fields. The 30 known fields therefore cannot be used to delete, normalize away, or ignore unknown properties when moving to V2.

## Specific next work to close M01

1. Run the CI source scanner against all 168 files; triage which of the 148 uninspected files access or indirectly modify storage. Move from *inspected* to *writer ownership verified* only with a caller/writer trace, including indirect `TaskPointsCore` saves and dynamic key aliases.
2. Group all literal and computed localStorage keys by authoritative vs derived vs session-only vs recovery-only, and identify how each is imported/exported and reset. Preserve user-defined fields and unknown V1 properties.
3. Audit every other IndexedDB database/version/store and each image read/write/delete and backup path. Include malformed schema and no-DB cases.
4. Map all UI and maintenance entrypoints, including pages, service worker lifecycle, deferred compaction, Phase4/5 mirrors, restore and import, to the nine known legacy writer families; use negative tests where a stale writer must be refused.
5. Compare the full inventory to each proposed V2 owner. M01 is verified **only** when every authoritative source/writer has a reviewed owner or an explicitly preserved auxiliary path, and tests fail if coverage regresses.

**Safety boundary:** none of this changes production storage or a user's data. V1 remains primary; no V2 writer cutover or completed 12-point migration gate is implied. A raw file-count ratio is *not* an engineering-completion percentage.
