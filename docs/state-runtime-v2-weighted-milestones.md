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
