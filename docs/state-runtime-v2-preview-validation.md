# State Runtime V2 — Preview Validation Evidence

Updated: 2026-09-09

This document tracks evidence for the Habits/completions V2 dark-mirror pilot and the Step 4 performance-validation phase.

Important boundaries:

- V2 remains default-off and preview-only.
- `taskpoints_v1` remains application read authority.
- Existing production persistence/recovery behavior remains authoritative.
- Automated simulation is not treated as proof of a physical browser/PWA lifecycle scenario.
- A scenario marked **Manual preview required** must be exercised on the branch preview before V2 can own that mutation class.
- No V2 code is approved for merge into `main` by this document.

## Automated and passing

| Scenario | Evidence | Status |
| --- | --- | --- |
| Dedicated V2 DB + only four pilot stores | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Image DB never touched | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Habit completion atomic row + ledger + revision | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Transaction rollback/abort | atomic + failure-isolation contracts | Automated passing |
| Duplicate mutation idempotence | atomic/WAL/revision contract suites | Automated passing |
| Revision persists across runtime recreation | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| WAL before async V2 verification | WAL bridge contract | Automated passing |
| Kill-before-IDB replay model | WAL bridge contract | Automated passing simulation |
| Malformed WAL preserved | WAL contract + bridge contract | Automated passing |
| Stale-generation WAL skipped | WAL/generation contract suites | Automated passing |
| Reset generation invalidates old/in-flight writes | generation contract | Automated passing |
| Import/restore rotates generation after authoritative replacement | generation contract | Automated passing |
| Two runtime instances detect revision conflict | revision conflict contract | Automated passing |
| Compatibility snapshot preserves Habit order and completion semantics | compatibility snapshot contract | Automated passing |
| Parity mismatch is diagnostic only | failure isolation contract | Automated passing |
| IndexedDB unavailable/open failure | failure isolation contract | Automated passing |
| Explicit IndexedDB `onblocked` | lifecycle interruption contract | Automated passing |
| Quota-style failure | failure isolation contract | Automated passing |
| Export/compatibility snapshot includes committed V2 changes | export contract | Automated passing |
| Rapid full → half → off | Habit preview scenarios contract | Automated passing |
| Half-point semantics | Habit preview scenarios contract | Automated passing |
| Icy/custom completion points | Habit preview scenarios contract | Automated passing |
| Failed → full correction | Habit preview scenarios contract | Automated passing |
| Burst of several completion writes | Habit preview scenarios contract | Automated passing |
| Repeated runtime recreation/reverification | reload verification contract | Automated passing |
| Background state change during IDB write | lifecycle interruption contract | Automated passing simulation |
| Navigation state change during IDB write | lifecycle interruption contract | Automated passing simulation |
| Safe V2-only cleanup | cleanup page + cleanup contract | Automated passing |
| Reorder: durable production overlay precedes V2 | Habit order contract | Automated passing |
| Reorder: atomic Habit rows + mutation ledger + revision | Habit order contract | Automated passing |
| Reorder: rapid churn and idempotent replay | Habit order contract | Automated passing |
| Reorder and completion share revision conflict guard | Habit order contract | Automated passing |
| Reorder overlay replay queues V2 after reload | Habit order contract | Automated passing |
| Habit metadata edits mirror after canonical production save | `tests/state_runtime_v2_habit_edit_contract.test.js` | Automated passing |
| Retroactive Habit point edits update only affected V2 completion rows | Habit edit contract | Automated passing |
| Add Habit / add Vice mirror as one V2 presence mutation | `tests/state_runtime_v2_habit_presence_contract.test.js` | Automated passing |
| Retire Habit mirrors accepted metadata change | Habit presence/edit contracts | Automated passing |
| Delete Habit removes V2 Habit row while preserving completion history | Habit presence contract | Automated passing |
| Automatic V2 parity waits for 20 seconds of sustained quiet before entering the shared maintenance coordinator | `tests/state_runtime_v2_maintenance_idle_contract.test.js` | Automated passing |
| Pre-idle mutation bursts coalesce, and a mutation landing during parity forces a follow-up quiet pass | `tests/state_runtime_v2_maintenance_idle_contract.test.js` | Automated passing |
| Missing idle coordinator fails closed without running heavyweight parity in the foreground | `tests/state_runtime_v2_maintenance_idle_contract.test.js` | Automated passing |
| Focused idle-maintenance CI is bounded by a 30-second fail-fast timeout | `.github/workflows/state-runtime-v2-contracts.yml` | Contracted |
| V2-specific focused CI | `.github/workflows/state-runtime-v2-contracts.yml` | Live current-main comparison + focused V2 hard gates |
| No regressions beyond current main | live-main baseline comparison in V2 CI | Live baseline; no static failure snapshot |

## Step 4 — performance observability

Step 4 is active. The goal is to prove that V2 improves or bounds foreground work rather than simply moving full-state work elsewhere.

Dark-preview-only instrumentation and scheduling now include:

- `state_runtime_v2_perf.js` times the synchronous enqueue portion separately from the asynchronous V2 IndexedDB mutation;
- completion, reorder, edit, and presence transactions emit `stateV2.txn.*` durations;
- transaction events report the expected store count and bounded logical row count for that mutation class;
- direct parity and compatibility snapshot work emits `stateV2.maintenance.*` durations with `foregroundBlocking: true`, making an accidental direct foreground call visible in a trace;
- `state_runtime_v2_maintenance_idle.js` adds a separate automatic maintenance lane for parity and optional compatibility checkpoints;
- when `TaskPointsCore.getStorageMaintenanceIdleStatus()` is available, automatic V2 heavyweight maintenance requires **20 seconds of sustained quiet** before it may enter the ordinary shared `TaskPointsCore.whenStorageMaintenanceQuiet` gate;
- a navigation grace period, active editor, hidden/leaving page, or renewed user interaction keeps that deep-idle gate closed;
- automatic parity work is not chained into the mutation promise returned to the interaction path;
- mutation bursts that finish before quiet execution are coalesced into one parity pass;
- if another mutation finishes while parity is already running, the lane schedules a follow-up quiet pass so the newer mutation is not silently considered verified by an older read;
- idle-maintenance trace events emit `foregroundBlocking: false` and `scheduled: true`, with `deepDeferred` / `deepReleased` marks exposing the 20-second gate;
- if the shared idle coordinator is unavailable, automatic V2 heavyweight maintenance fails closed instead of falling back to foreground execution;
- direct `verifyParity()` and `buildCompatibilitySnapshot()` APIs remain immediate for explicit diagnostics, export, recovery, and other correctness-sensitive callers;
- `tests/state_runtime_v2_perf_contract.test.js` contracts the trace names, foreground/async separation, and mutation scope metadata;
- `tests/state_runtime_v2_maintenance_idle_contract.test.js` contracts 20-second deep-idle deferral, burst coalescing, during-run follow-up, fail-closed behavior, and preservation of direct calls;
- the focused idle-maintenance test has a 30-second CI timeout so a scheduling regression cannot indefinitely stall the rollout gate;
- V2 performance instrumentation and idle scheduling are loaded only through the V2 dark-preview path.

Still required before Step 4 is considered complete:

- capture real device/PWA traces for ordinary Habit completion, rapid completion burst, reorder, edit, add, retire, and delete;
- confirm synchronous V2 enqueue time remains negligible compared with the production action;
- confirm automatic V2 parity work appears only after the 20-second deep-idle boundary and as scheduled non-foreground maintenance in ordinary interaction traces;
- confirm a new touch/navigation/edit before parity begins postpones the automatic parity pass on the real device;
- confirm no V2 compatibility snapshot work occurs before the visible response boundary in ordinary interaction traces;
- correlate existing Phase 2/4/5 trace events with the V2 events to show whether full-state production work still blocks the foreground;
- use the resulting traces to decide which remaining legacy full-state work must move off the interaction path before V2 can own a mutation.

## Implemented, but physical preview validation still required

These have automated coverage for their storage/recovery mechanics, but browser/device behavior still needs real preview testing.

| Scenario | Why manual is still required |
| --- | --- |
| Complete a Habit and immediately kill the standalone app | Unit tests simulate an interrupted WAL/IDB boundary but cannot reproduce an OS killing a PWA process. |
| Complete several Habits rapidly and immediately kill the app | Burst serialization and WAL replay are automated; physical kill timing is not. |
| Navigate away during an actual IndexedDB write | Pathname mutation is simulated; real page teardown/navigation scheduling differs by browser. |
| Background/foreground during an actual write | Visibility is simulated; real iOS suspension can terminate callbacks. |
| Standalone PWA plus Safari tab open simultaneously | Revision conflict is tested with two runtime instances, but separate browser contexts must be exercised. |
| Two normal browser tabs modifying Habits | Revision conflict is automated; browser scheduling must still be smoke-tested. |
| Repeated reorder clicks in the real UI | Atomic reorder and overlay replay are automated; capture-click + render + idle compaction integration needs preview smoke testing. |
| Habit edit/add/retire/delete in real UI | Mutation semantics are automated; actual Home editor/confirmation timing still needs preview validation. |
| Reload repeatedly during dark verification | Runtime recreation/parity is automated; actual browser cache/worker lifecycle must still be exercised. |
| Automatic deep-idle parity under real mobile interaction | The 20-second gate, coordinator, and coalescing semantics are automated, but iOS/PWA scheduling and real user-interaction preemption must be confirmed in a trace. |
| Ordinary export immediately after a recent Habit mutation | Export contract is automated; the real UI export timing needs preview verification. |
| Reset All / import / emergency restore using real controls | Generation protocols are automated; end-to-end UI paths must be smoke-tested. |
| V2 cleanup page with another preview tab holding the DB open | `onblocked` handling is coded/tested; real tab blocking behavior should be confirmed. |

## Current automated rollout gate semantics

The previous static failure snapshot is no longer used as the authoritative regression comparator.

The V2 CI gate now:

1. hard-gates the focused V2 contract suite, including the Step 4 performance and idle-maintenance contracts;
2. bounds the focused idle-maintenance contract with a fail-fast timeout;
3. fetches and checks out **live current `main`** into a separate worktree;
4. runs each current-main test file independently and records its actual current failure signatures;
5. runs all non-V2 test files independently on the V2 branch;
6. compares those signatures directly against live current main;
7. fails only when the V2 branch introduces a failure/hang that current main does not have;
8. uploads both baseline and V2 diagnostics;
9. runs the full `npm test` suite as a supplemental diagnostic.

The live-main workflow intentionally avoids requiring another manually maintained failure list whenever `main` advances.
