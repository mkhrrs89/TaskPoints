# State Runtime V2 — Preview Validation Evidence

Updated: 2026-09-12

This document tracks evidence for the Habits/completions V2 dark-mirror pilot and the Step 4 performance-validation phase.

Important boundaries:

- V2 remains default-off and preview-only.
- `taskpoints_v1` remains application read authority.
- Existing production persistence/recovery behavior remains authoritative.
- Automated simulation is not treated as proof of a physical browser/PWA lifecycle scenario.
- A scenario marked **Manual preview required** must be exercised on the branch preview before V2 can own that mutation class.
- No V2 code is approved for merge into `main` by this document.

## Current branch integration baseline

As of 2026-09-11, `arch/state-runtime-v2-plan` contains current production `main` through `d025dd443f26f7ac1cd8297b4e83bd8911c1ad6d` as a real second parent of merge commit `4f80fa9509f8f9f342286decf882a6cd22ed557f`.

The only overlapping production/V2 integration point was `_worker.js`. Its resolved version preserves both sides: the V2 runtime/WAL modules remain in the core bundle and the newer production Gold Theft notification bundle remains after Greed. The branch therefore starts Step 4 device validation from current production behavior rather than an older production snapshot.

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
| Per-mutation-class trace evidence and direct-vs-idle maintenance acceptance summary | `tests/state_runtime_v2_perf_contract.test.js` | Automated passing |
| V2-specific focused CI | `.github/workflows/state-runtime-v2-contracts.yml` | Live current-main comparison + focused V2 hard gates |
| No regressions beyond current main | live-main baseline comparison in V2 CI | Live baseline; no static failure snapshot |

## Step 4 — performance observability

Step 4 is active. The goal is to prove that V2 improves or bounds foreground work rather than simply moving full-state work elsewhere.

Dark-preview-only instrumentation and scheduling now include:

- `state_runtime_v2_perf.js` times the synchronous enqueue portion separately from the asynchronous V2 IndexedDB mutation;
- completion, reorder, edit, and presence transactions emit `stateV2.txn.*` durations;
- transaction events report the expected store count and bounded logical row count for that mutation class;
- V2 perf status tracks completion/order/edit/presence separately, including enqueue counts, transaction counts, failures, average/max enqueue duration, average/max transaction duration, and last mutation evidence;
- `TaskPointsStateRuntimeV2Perf.getAcceptanceSnapshot()` summarizes whether all four mutation classes were actually observed, whether any direct foreground parity/compatibility call occurred, whether automatic parity was seen crossing the deep-idle boundary, and whether the V2 perf/maintenance/serializer layers recorded failures;
- the same acceptance snapshot is embedded under `TaskPointsStateRuntimeV2.getStatus().traceDiagnostics.acceptance`, so the ordinary PERF JSON export carries its own Step 4 evidence summary;
- that summary deliberately reports `physicalDeviceEvidenceStillRequired: true`; automated counters are not allowed to masquerade as proof of an iOS/PWA lifecycle test;
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
- `tests/state_runtime_v2_perf_contract.test.js` contracts the trace names, foreground/async separation, mutation scope metadata, per-class counters, and acceptance summary;
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


## September 12 iPhone trace follow-up

The 16:49:52 trace from preview head `45348ec` confirms 0–1 ms hot edit/presence capture, but does **not** pass the device gate:

- A completion expected revision 75 while a presence mutation committed revision 76. The same completion ID then committed at revision 77. Internal lexical apply calls bypassed the public serialization guard; internal enqueue and generic mutation dispatch now use the wrapped public methods. Revision/generation checks remain intact.
- Idle parity reported `match: false` with matching counts (65 Habits / 7,310 completions). Hashes alone cannot identify the differing records. No mismatch repair or reseed is justified by this trace.
- Parity now produces bounded record IDs, occurrence/index information, mismatch counts and changed top-level field names, without exporting field values. This work runs only during existing idle/explicit parity. It does not mutate either data source.
- Both trace review and runtime acceptance expose parity mismatch. The review requires affirmative matching parity and now displays nine checks, including data equality. Failed-event details survive in Copy review across the retained pages.
- Long V2 transactions overlapped legacy loads and event-loop stalls. The queue fix is not a claim that legacy whole-state costs are removed.

Regression coverage holds a presence request open while exercising the internal journal and generic mutation entry points, checks that both wait, and verifies all three commits without a revision conflict. Additional tests cover bounded/read-only mismatch reporting and failed/missing parity evidence.

Next physical evidence: reload the updated stable branch preview, Start fresh test, and repeat completion, reorder, edit/save and temporary-Habit add. Keep interacting briefly, then leave the page visible and untouched for at least 20 seconds and Refresh evidence / Copy review before navigating away. Startup can reseed V2 when the legacy seed hash changes, so an idle-only reload is not sufficient to reproduce the original mismatch. No TaskPoints data reset is needed. The mismatch field report is needed before claiming parity is fixed or allowing V2 to own mutations. Main remains unchanged.


## September 12 cache-aware parity comparison

The 21:28 device review recorded all four mutation classes with zero mutation failures and 0–3 ms synchronous V2 overhead. Parity still failed: 46 Habits and four completion records differed, with no missing/extra/moved rows. Habit samples were dominated by `__streak`, `__completion`, and `__failedStreak`; some also included `updatedAtISO`. The original global sample cap hid all completion details.

Home `renderHabits` recomputes those exact three double-underscore fields for display and sorting. Parity now compares a projection excluding only these three Habit fields. It reports the comparison scope and separate ignored-cache counts. This changes no persisted records, compatibility exports, display calculations, or production behavior. No other double-underscore fields are ignored, and completion records and timestamps remain strictly compared. The comparison hashes now describe this explicitly named projection.

Mismatch sampling allows up to 20 entries **per collection** (40 total). Each sampled field includes presence/type/length/hash evidence; only bounded timestamp/day-key/scoring fields include scalar values. Arbitrary titles, names and record text are not copied into the report. Missing, extra, moved and duplicate-occurrence evidence remains available.

Focused regression tests prove cache-only differences pass without mutating either store or compatibility exports; timestamp/unknown-field/completion differences still fail; and 46 Habit mismatches cannot crowd four completion mismatches out of the report. The remaining device timestamp/completion differences are not yet diagnosed or repaired. Repeat the short device sequence on the updated preview and capture Copy review before navigating away; no data reset is needed.


## September 12 timestamp payload corrections and create-Habit layout

The 21:41 device report narrowed strict parity to three Habit `updatedAtISO` fields and one backdated completion `completedAtISO`. Code inspection found two payload omissions:

- Home reorder stamps the affected Habits individually, but the durable order overlay and V2 previously carried order numbers only. The overlay now carries per-Habit timestamps through replay, compaction verification, mutation identity and V2 commit. Older overlay timestamps cannot overwrite newer Habit timestamps; old overlays without this optional map retain their existing behavior.
- Home already constructs a canonical completion time for the selected day, but the pending delta omitted it. The delta now carries `completedAtISO`, legacy journal replay and V2 honor it, and the V2 WAL identity includes it when present. Existing deltas without this optional value retain the previous timestamp fallback and identity.

Strict timestamp parity remains enabled. Focused tests cover a September 10 completion tapped on September 12, per-Habit reorder timestamps, order-neutral timestamp updates, preservation of newer timestamps, and WAL timestamp retention/identity. These fixes still require physical-device verification.

Create Habit now places Tag and Points in one equal-width grid row with shrinkable inputs, preserving both labels, controls, options and actions. Local browser layout validation was unavailable because the Playwright Chromium executable is not installed.
