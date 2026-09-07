# State Runtime V2 — Preview Validation Evidence

Updated: 2026-09-06

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
| V2-specific focused CI | `.github/workflows/state-runtime-v2-contracts.yml` | Passing before Step 4 changes; revalidation in progress |
| No regressions beyond current main | live-main baseline comparison in V2 CI | Replaced stale static baseline on 2026-09-06 |

## Step 4 — performance observability

Step 4 has begun. The goal is to prove that V2 improves or bounds foreground work rather than simply moving full-state work elsewhere.

New dark-preview-only instrumentation:

- `state_runtime_v2_perf.js` times the synchronous enqueue portion separately from the asynchronous V2 IndexedDB mutation;
- completion, reorder, edit, and presence transactions emit `stateV2.txn.*` durations;
- transaction events report the expected store count and bounded logical row count for that mutation class;
- direct parity and compatibility snapshot work emits `stateV2.maintenance.*` durations so heavyweight verification is visible in a trace;
- `tests/state_runtime_v2_perf_contract.test.js` contracts the trace names, foreground/async separation, and mutation scope metadata;
- V2 performance instrumentation is loaded only when the V2 dark-preview flag is enabled.

Still required before Step 4 is considered complete:

- capture real device/PWA traces for ordinary Habit completion, rapid completion burst, reorder, edit, add, retire, and delete;
- confirm synchronous V2 enqueue time remains negligible compared with the production action;
- confirm no V2 parity/compatibility work occurs before the visible response boundary in ordinary interaction traces;
- correlate existing Phase 2/4/5 trace events with the V2 events to show whether full-state production work still blocks the foreground;
- move any V2 heavyweight maintenance that proves foreground-blocking behind the existing global idle/maintenance coordinator;
- verify user interaction postpones/preempts V2 heavyweight maintenance that has not started.

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
| Ordinary export immediately after a recent Habit mutation | Export contract is automated; the real UI export timing needs preview verification. |
| Reset All / import / emergency restore using real controls | Generation protocols are automated; end-to-end UI paths must be smoke-tested. |
| V2 cleanup page with another preview tab holding the DB open | `onblocked` handling is coded/tested; real tab blocking behavior should be confirmed. |

## Current automated rollout gate semantics

The previous static failure snapshot was based on old `main` SHA `0b643035811045f2ee450831faef8db2e5a2dd10` and is no longer used as the authoritative regression comparator.

As of 2026-09-06, the V2 CI gate now:

1. hard-gates the focused V2 contract suite;
2. fetches and checks out **live current `main`** into a separate worktree;
3. runs each current-main test file independently and records its actual current failure signatures;
4. runs all non-V2 test files independently on the V2 branch;
5. compares those signatures directly against live current main;
6. fails only when the V2 branch introduces a failure/hang that current main does not have;
7. uploads both baseline and V2 diagnostics;
8. runs the full `npm test` suite as a supplemental diagnostic.

Current production baseline at the start of Step 4 is `5da660b0cc91fca1c6b69b4c069196f8a81a600d`. The live-main workflow intentionally avoids requiring another manually maintained failure list whenever `main` advances.
