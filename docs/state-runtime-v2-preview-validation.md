# State Runtime V2 — Preview Validation Evidence

Updated: 2026-09-03

This document tracks evidence for the Step 3 Habits/completions dark-mirror pilot.

Important boundaries:

- V2 remains default-off and preview-only.
- `taskpoints_v1` remains application read authority.
- Existing production persistence/recovery behavior remains authoritative.
- Automated simulation is not treated as proof of a physical browser/PWA lifecycle scenario.
- A scenario marked **Manual preview required** must be exercised on the branch preview before V2 can own that mutation class.

## Automated and passing

| Scenario | Evidence | Status |
| --- | --- | --- |
| Dedicated V2 DB + only four pilot stores | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Image DB never touched | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Habit completion atomic row + ledger + revision | `tests/state_runtime_v2_atomic_contract.test.js` | Automated passing |
| Transaction rollback/abort | `tests/state_runtime_v2_atomic_contract.test.js`, `tests/state_runtime_v2_failure_isolation_contract.test.js` | Automated passing |
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
| Explicit IndexedDB `onblocked` | `tests/state_runtime_v2_lifecycle_interruption_contract.test.js` | Automated passing |
| Quota-style failure | failure isolation contract | Automated passing |
| Export/compatibility snapshot includes committed V2 changes | export contract | Automated passing |
| Rapid full → half → off | `tests/state_runtime_v2_habit_preview_scenarios_contract.test.js` | Automated passing |
| Half-point semantics | Habit preview scenarios contract | Automated passing |
| Icy/custom completion points | Habit preview scenarios contract | Automated passing |
| Failed → full correction | Habit preview scenarios contract | Automated passing |
| Burst of several completion writes | Habit preview scenarios contract | Automated passing |
| Repeated runtime recreation/reverification | `tests/state_runtime_v2_reload_verification_contract.test.js` | Automated passing |
| Background state change during IDB write | lifecycle interruption contract | Automated passing simulation |
| Navigation state change during IDB write | lifecycle interruption contract | Automated passing simulation |
| Safe V2-only cleanup | `state_v2_preview_cleanup.html` + cleanup contract | Automated passing |
| Reorder: durable production overlay precedes V2 | `tests/state_runtime_v2_habit_order_contract.test.js` | Automated passing |
| Reorder: atomic Habit rows + mutation ledger + revision | Habit order contract | Automated passing |
| Reorder: rapid churn | Habit order contract | Automated passing |
| Reorder: idempotent replay | Habit order contract | Automated passing |
| Reorder and completion share revision conflict guard | Habit order contract | Automated passing |
| Reorder overlay replay queues V2 after reload | Habit order contract | Automated passing |
| V2-specific focused CI | `.github/workflows/state-runtime-v2-contracts.yml` | Passing |
| No regressions beyond recorded current-main baseline | baseline-aware CI gate | Passing as of current branch validation |

## Implemented, but physical preview validation still required

These have automated coverage for their storage/recovery mechanics, but browser/device behavior still needs real preview testing.

| Scenario | Why manual is still required |
| --- | --- |
| Complete a Habit and immediately kill the standalone app | Unit tests simulate an interrupted WAL/IDB boundary but cannot reproduce an OS killing a PWA process. |
| Complete several Habits rapidly and immediately kill the app | Burst serialization and WAL replay are automated; physical kill timing is not. |
| Navigate away during an actual IndexedDB write | Pathname mutation is simulated; real page teardown/navigation scheduling differs by browser. |
| Background/foreground during an actual write | Visibility is simulated; real iOS suspension can terminate callbacks. |
| Standalone PWA plus Safari tab open simultaneously | Revision conflict is tested with two runtime instances, but separate browser contexts must be exercised. |
| Two normal browser tabs modifying Habits | Revision conflict is automated; Broadcast/IDB/browser scheduling must still be smoke-tested. |
| Repeated reorder clicks in the real UI | Atomic reorder and overlay replay are automated; capture-click + render + idle compaction integration needs preview smoke testing. |
| Reload repeatedly during dark verification | Runtime recreation/parity is automated; actual browser cache/worker lifecycle must still be exercised. |
| Ordinary export immediately after a recent Habit mutation | Export contract is automated; the real UI export timing needs preview verification. |
| Reset All / import / emergency restore using real controls | Generation protocols are automated; end-to-end UI paths must be smoke-tested. |
| V2 cleanup page with another preview tab holding the DB open | `onblocked` handling is coded/tested; real tab blocking behavior should be confirmed. |

## Not yet V2-native

### Habit metadata edits

The production Home editor currently supports edits to:

- name;
- points per day;
- tag/grouping;
- days-per-complete-week;
- half-point enabled;
- streak multiplier enabled/start date;
- category (Habit/Vice).

The production edit path also optionally rewrites historical Habit/Vice completion point values when the user chooses a retroactive points edit.

V2 must therefore mirror an accepted edit as one logical atomic change that can include:

1. the updated Habit record;
2. only the affected historical completion rows when production changed them;
3. one V2 mutation-ledger entry;
4. one shared revision increment.

The V2 edit mirror must run only **after** the existing production `saveHabitEdit()` path has accepted the edit and persisted the canonical state. It must not duplicate editor validation, confirmation UX, or retroactive-point rules.

### Add / retire / delete Habit

These are outside the current edit-field checklist and are not yet V2-native. They remain legacy-authoritative. Do not infer V2 ownership from successful reseeding.

## Current automated rollout gate semantics

The V2 branch has a recorded snapshot of individual test-file failures confirmed on current `main` at baseline SHA:

`0b643035811045f2ee450831faef8db2e5a2dd10`

CI:

1. hard-gates the focused V2 contract suite;
2. runs every TaskPoints test file individually;
3. reports all failures;
4. distinguishes known current-main failures from new V2 regressions;
5. fails the rollout gate on any new V2 regression;
6. runs the full `npm test` suite as a supplemental diagnostic.

The baseline must be refreshed whenever `main` changes before relying on the regression comparison.
