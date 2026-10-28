# State Runtime V2 — Preview Validation Evidence

Updated: 2026-09-15

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


## September 15 pilot ownership boundary and device gate

Follow-up inspection of the dark mirror exposed an ownership mismatch in the original completion mirror: the first proving ground is Habits/Vices, but V2 seed/parity had treated every legacy completion class as if it belonged to that pilot. That made unrelated task/manual completion records capable of producing false parity failures and made the physical store boundary broader than the architecture intended.

The V2 branch now enforces the pilot boundary consistently:

- V2 seed/storage owns only completion records with a Habit/Vice source and a Habit ID. Task/manual/other completion classes remain legacy-only for this phase.
- `buildCompatibilitySnapshot()` overlays V2-owned Habit/Vice completions back into their legacy positions while preserving unrelated legacy completion rows, including ordering, duplicate IDs, id-less rows, and rows added after V2 was seeded. V2-only pilot completions are still represented in the compatibility output.
- Parity compares all Habit records plus only the Habit/Vice completion subset. For comparison only, a historical full completion with no `completionFraction` is treated as canonical `1`; real half/custom-fraction differences still fail. Neither stored source is rewritten by that normalization.
- `scopeExcludedCounts` reports completion rows outside the pilot on each side. The physical-device verdict now requires the explicit pilot comparison scope and requires `scopeExcludedCounts.actualCompletions === 0`, so filtered parity cannot hide an out-of-scope row that accidentally entered V2.
- Habit-edit completion sequencing now uses the same pilot-owned subset. Unrelated legacy completion rows can no longer shift V2 sequence numbers and make a future-only Habit metadata edit rewrite unchanged historical Habit completion rows.
- The persistent V2 CI workflow hard-gates the pilot compatibility-boundary and parity-scope contracts.
- The live V2 TEST panel has a tenth check, **V2 stores only Habit/Vice pilot completions**, and its reviewer/live-review cache versions were advanced so a physical preview cannot silently keep the pre-ownership reviewer.

Focused ownership, compatibility, Habit-edit, trace-review, live-review, atomic-replacement, and data-loss fail-closed contracts pass with these changes. V2 remains default-off, preview-only, and legacy-read-authoritative. No authority transition is authorized by this change.

The next Step 4 physical pass should use the updated stable branch preview, Start fresh test, exercise completion/reorder/edit/add, keep interacting briefly to preempt pending maintenance, then leave the page visible and untouched for at least 20 seconds. A complete session now requires all ten live checks, including both green pilot ownership and green pilot-scoped parity. If either is red, copy the review without resetting TaskPoints data.

## October 26 — Completion lookup index preparation (no schema cutover)

The guarded preview-only Habit reader and the original V2 database continue to preserve V1 read authority. The next optimization is a per-Habit completion index, but historical completion storage is packed by completion ID rather than by Habit ID. One pack can contain duplicate completion IDs belonging to multiple Habits. Key-prefix searches or assuming that only the first packed entry matters would silently omit records.

Current non-destructive preparation:

- Newly seeded completion packs, journal-mirrored completions, and retroactively rewritten completion packs include a sorted, deduplicated `habitIds` metadata array covering **every** Habit/Vice completion in the pack. This is metadata on the V2 pack; its canonical completion values, duplicate semantics, and existing ordering are unchanged.
- `inspectPilotCompletionIndexCoverage()` checks the actual stored packs, with existing generation/WAL/parity checks before and after. Its output is read-only, bounded to aggregate counts (`total`, `complete`, `missing`, `mismatched`) and contains no completion payloads or automatic repairs.
- Older packs may lack `habitIds` and remain intact. When coverage is incomplete, the present guarded Habit reader continues using the existing completion scan. It must **not** substitute a partial future index.
- No IndexedDB version upgrade, new index, migration/backfill, live read change, production feature deletion, or V1 authority switch is made by this preparation.
- Future schema work must first prove an atomic, abort-safe upgrade/backfill for older packs, preserve the cross-Habit duplicate case, and provide a tested scan fallback when metadata/index migration is incomplete or blocked.

The focused Node and real-browser regression suite exercises complete packs, cross-Habit duplicate IDs, retroactive edits, missing/mismatched legacy metadata, pending WAL, and unchanged V1 authority. CI status is determined by the branch's GitHub Actions runs, not by this text.

## October 26 — Versioned completion index upgrade (preview branch only)

This phase advances the earlier metadata-only preparation. The dedicated **V2 preview database** now requests IndexedDB version 2 and defines `completions.by_habit_ids` as a multi-entry index over `habitIds`. This is a V2-specific schema upgrade: **it does not migrate Main, take over V1 reads, remove any legacy data, or enable V2 as primary storage.**

- During an upgrade from a legacy V2 version-1 database, the same IndexedDB `versionchange` transaction creates the index and backfills missing/incorrect `habitIds` on existing completion packs. If a request errors, the upgrade aborts; the previous database version, metadata, and original completion rows remain intact for retry. The request is not treated as a successful migration.
- A completion pack can contain duplicate completion IDs with several Habit owners. Each owner gets an index entry, and the entries' sequence and payload are preserved.
- The preview-only Habit reader checks full-pilot V1/V2 parity, WAL emptiness, epoch consistency, and index metadata completeness *before and after* querying the index. It uses `by_habit_ids` for a verified candidate; otherwise it retains the full completion scan. This guard continues to reject stale or mismatched data without returning records.
- Node contracts simulate version-1 upgrades, cross-Habit duplicates, aborted reads and writes, retry recovery, and no V1 changes. Chromium/WebKit scenarios run a real legacy IndexedDB upgrade from a localhost-only isolated fixture.
- Before a wider authority transition, complete device preview validation and repeated multi-tab/version-blocking tests. Version changes must be safe when another tab is open; never delete or silently reset the preview database to force an upgrade.

The readiness and candidate interfaces remain diagnostic-only. All live application reads and writes continue through the existing authority.

## October 26 — Blocked-upgrade and stale-tab lifecycle hardening

The schema-v2 index migration now has explicit protection for a blocked IndexedDB opening request. When another tab holds an older V2 connection, IndexedDB can fire `blocked` and later still deliver an upgrade opportunity; there is no cancel-open API. The runtime immediately refuses the blocked attempt, aborts any later versionchange transaction from that abandoned request, and closes a late connection if one arrives. Late callbacks cannot clear a newer successful open attempt. V1 authority and the original pending WAL are never modified by these refusals.

A currently open V2 connection also closes on `versionchange` from another tab and invalidates preview-only reads. The updated tests include:
- A blocked V2 open with delayed upgrade/success/error events, successive blocked opens, and a later successful retry.
- Real Chromium/WebKit tab pairs where a schema-v1 holder blocks a schema-v2 migration, then releases it for a safe retry with historical cross-Habit completion packs intact.
- Real browser tab pairs where a newer schema upgrade invalidates the stale V2 connection. The old page refuses preview candidates rather than reopening or silently using an obsolete schema.

These are fail-closed preview protections, **not** authorization to switch V2 to live reads or writes. Browser automation cannot prove every physical Safari lifecycle condition; the existing real-device gate is still required. No feature or legacy dataset was removed.

## October 26 — Explicit reversible Habit read comparison probe

A small diagnostic-only Stage-C rehearsal is now available on the V2 development branch. It does **not** enable a live read-authority switch. The only current selector is `legacy_only`.

- `setPilotReadProbeEnabled(true)` opt-ins to an ephemeral, in-memory comparison harness. It does not persist across page reloads and does not change Home's source, V1 writes, V2 writer ownership, or storage configuration. Calling it with `false` instantly disables the probe.
- `probePilotHabitRead(habitId)` compares the effective V1 Habit and its Habit/Vice completions against the independently guarded V2 candidate, using the existing parity-only normalization. It returns a bounded verdict, completion counts, revision and lookup mode but **never exposes record payloads, silently repairs data, or selects V2 authority**.
- Pending WAL, unreadable stores, parity mismatches, external revision signals, changed generations, and a probe/dark-mode opt-out during a check all fail closed to V1.
- The browser matrix now includes a five-reload default-off check, a successful candidate check before/after an actual Habit completion, stale-tab revision refusal, post-reload recovery, and an unchanged V1 authority verdict. Node tests additionally inject an opt-out in the middle of IDB access and confirm no late result is accepted.

This is a diagnostic prerequisite. A real targeted V2 read switch must wait for the separate, controlled mutation-authority stage, explicit device tests and a tested rollback. No automatic cutover is performed.

## October 26 — Repeated diagnostic read race protection

The opt-in Habit read probe is **not** a Stage-C production switch; V1 remains the only selected read authority. A follow-up race audit identified an ABA possibility: a diagnostic read started in one enabled session could return after an immediate off/on toggle and see a misleading `enabled: true` value. Likewise, a mirror parity read might begin before a quick disable/re-enable and find V2 enabled again at completion.

The development runtime now uses volatile per-session counters to fence these cases:

- Every explicit probe toggle starts a new probe epoch. A comparison from an older epoch is refused even if the probe is enabled again by the time it returns. Fresh comparisons in the new epoch remain allowed.
- Every public dark-mirror enable/disable increments a separate control epoch. A readiness check that crosses one of those transitions is refused, even when the resulting persisted flag is again enabled.
- Refusals preserve V1 data, indexed V2 records, WAL entries, and the existing user interface. They do not select V2 reads or repair a mismatch.
- Contract coverage injects off/on cycles during IndexedDB reads and verifies the refusal, counters, recovery via a fresh check, and unchanged records.

These protections address local public control transitions. They are **not** a distributed lock or proof that every browser storage transition is observable. Production authority promotion remains blocked by the separate later migration and physical-device validation gates.

## October 26 — Mutation-authority preflight remains deliberately nonpromotable

The V2 development runtime now exposes a read-only `inspectMutationHandoffPrerequisites()` report. It cannot enable a V2 writer or switch live read authority. Its `canPromote` result is **always false** until an explicit, separately tested authority protocol exists.

This preflight verifies the existing scoped Habit/Vice mirror parity and completion index; checks whether the uncompacted legacy Habit journal is empty; samples cross-tab revision and generation stability; detects observed mirror/bridge failures; and reports only bounded counts for legacy journal rows and completions outside V2's present pilot scope. It never returns private record payloads, edits the WAL, reseeds a database, or rewrites a mismatch. It reports hard blockers for the missing exclusive cross-tab writer lease, durable rollback contract, and migration of application collections outside the Habit pilot. These blockers are not overridable by the existing diagnostic probe.

The durable revision signal is now synchronously re-read **before and after** the guarded parity scan. A late persisted signal blocks a stale tab even when Storage/BroadcastChannel events were not delivered. Unlike optional UI notifications, denied reads of the revision-signal key are a hard `revision_signal_unreadable` refusal, not proof that no revision happened. Existing WAL, mirror, and V1 records remain intact and a fresh preview check is possible once storage becomes readable again.

Node contracts and real Chromium/WebKit browser scenarios cover healthy-but-nonpromotable audits, uncompacted V1 journals, pending WAL, mismatched V1/V2 rows, missed revision events, denied revision-signal access, and restoration without destructive repair. The separate physical-device, multi-tab writer-lease and explicit cutover/rollback checks remain pending. No current feature was removed, and Main is not affected.

## October 26 — Exclusive-writer coordination rehearsal and rollback-source audit

V2 now has two **opt-in/read-only development diagnostics**, without changing Main, the runtime authority, or the automatic Home startup path:

- `rehearseExclusiveWriterLease()` asks the browser's same-origin Lock Manager for the named writer-rehearsal lock using `mode:'exclusive'` and `ifAvailable:true`. It re-verifies the scoped V2 pilot and the intact legacy recovery source **inside** the lock callback; the lock is released before the call returns. Busy, unsupported, denied, or stale requests produce a fail-closed response. No fallback localStorage timestamp "lease" is fabricated, and no caller-supplied code runs under the rehearsal lock.
- `inspectLegacyRollbackSource()` checks that the effective V1 storage snapshot, pending legacy journal, WAL, and generation remain readable and stable across an asynchronous boundary. It returns counts and a bounded verdict, never raw personal data. It **does not** create a durable checkpoint and must not be represented as a completed rollback protocol.
- Both APIs explicitly report `mutationAuthority:'legacy_only'`, `readAuthority:'legacy_only'`, and no live promotion. Even successful exclusive acquisition proves only that the *diagnostic lock* was temporarily available; existing production V1 mutations do not participate in it.
- Node tests cover missing Lock Manager support, successful exclusive acquisition and immediate release, lock contention, denied lock requests, changed V1 under the lock, WAL denial and preservation of the underlying records.
- Chromium and WebKit browser tests open two actual tabs and, where Lock Manager is available, hold the rehearsal lock in one tab while the other confirms fail-closed contention; they then release it, retry successfully, and assert V1 is still authoritative. Unsupported WebKit Lock Manager implementations are accepted as **unavailable**, never as proven exclusivity.

**Remaining prerequisites:** All production writers must be integrated under a cross-tab exclusive lease with fencing tokens and crash recovery; complete verified checkpoint creation plus restoration must be durable and tested against quota/storage eviction; nonpilot app collections must be migrated without loss; and physical iOS/Safari/PWA use requires device testing. `inspectMutationHandoffPrerequisites().canPromote` remains hard-false with all three primary blockers.

## October 26 — Independent immutable recovery-checkpoint prototype (preview only)

The development branch adds **explicit, opt-in** `createPreviewRecoveryCheckpoint()` and read-only `inspectPreviewRecoveryCheckpoint(checkpointId)`. These calls do not run on startup, user edits, background sync or mirror seeding. They do not redirect live reads or writes, modify V1, or invoke a restore.

- A checkpoint captures the exact localStorage string values of all keys whose names start with `taskpoints_`, including the V1 state, existing Habit overlays, generation metadata, independent V2 WAL sidecars and legacy journal keys in that namespace. It inventories keys strictly, rejects missing/unreadable state, and checks the V1 rollback source before and after persistence. This is a **namespace-scoped prototype**; additional keys or non-localStorage dependencies must be audited before anyone treats it as a comprehensive production backup.
- Snapshots are written via an **immutable IndexedDB `add`** to `taskpoints_v2_recovery_checkpoints_preview` / `snapshots`, an entirely separate database from `taskpoints_state_v2`. Each explicit call creates a new ID; a failed request aborts its transaction and cannot overwrite an existing snapshot.
- Browser WebCrypto **SHA-256** covers exact captured bytes. An absent/denied SHA-256 capability fails closed, and readback verifies the persisted digest. Inspection returns only metadata and integrity status, **not private copied values**. This protects against undetected accidental byte damage but is not an external authenticity signature.
- An existing immutable snapshot survives later V1 edits and V2 mirror changes as long as browser-origin storage is retained. If V1 changes during a save, the historical copy is preserved but the response refuses to mark it as current. There is no automatic merge, deletion or overwrite.
- Contract tests cover initial creation, namespace coverage, two successive immutable checkpoints, missing WebCrypto, quota/write denial, intentionally corrupted records and no restoration; real Chromium/WebKit browser tests cover browser persistence through reload, SHA-256 verification, corruption and a failed second write.

**Important limitations:** An IndexedDB snapshot is **not an off-device backup**. Clearing site data, browser eviction, or some device failures can remove both V1 and the preview checkpoint. There is no automated restore, verified external export, writer fencing, rollback orchestration, or production handoff yet. `inspectMutationHandoffPrerequisites().canPromote` remains hard-false and the `durable_authority_rollback_not_implemented` blocker remains correctly present. Physical iOS/Safari/PWA tests and full collection-coverage verification are still required.

## October 26 — Read-only rollback diff planning and metadata-bound checkpoint integrity

Recovery checkpoint creation remains an **explicit, preview-only** operation. A new read-only `inspectPreviewRollbackPlan(checkpointId)` diagnostic validates an existing saved snapshot, checks the current V1 source and journal for stability, compares the captured `taskpoints_` namespace with the current keys, and reports only aggregate counts of keys that would need to be restored, replaced, or removed. It **never** writes localStorage, edits V2, auto-restores, exports private data, or authorizes cutover (`canApply:false` always). A generation difference is surfaced as a separate reason; it is not silently reconciled.

New checkpoints seal the **snapshot metadata and data together** under SHA-256 using `integrityVersion:2`: checkpoint ID, schema, captured time, captured generation, and complete entry list are hashed. Previously created `integrityVersion:1` or unversioned entry-only SHA-256 snapshots remain inspectable and untouched, but diagnostics explicitly distinguish their narrower `legacy_payload_only` integrity coverage from new `metadata_and_payload` records. Metadata tampering is rejected for new snapshots.

Node tests cover changed, missing, and newer V1 keys; generation differences; storage denial; metadata corruption; compatibility of older checkpoint records; immutable V1/V2 state; and recovery without auto-restore. Browser tests cover a rollback diff after a page reload, unchanged V1 data, and a forged checkpoint generation rejected by the hash.

**Remaining gaps:** This is not a production rollback mechanism. A real restoration requires independently proven external retention, whole-application collection coverage, an exclusive writer fence, consented restore, verified post-restore parity, and safe recovery after a mid-restore browser crash. None of these are implemented or enabled by the preview diagnostics. Main remains untouched and V1 remains authoritative.

## October 27 — Historical checkpoint provenance safeguard

Legacy preview checkpoint records with payload-only SHA-256 remain inspectable without modification, deletion or silent replacement. However, their `generation` and capture timestamp were not included in the old checksum. An `intact: true` payload verdict therefore cannot establish trusted rollback provenance.

`inspectPreviewRollbackPlan()` now refuses these historical records with `checkpoint_provenance_unverified`. Modern `integrityCoverage: 'metadata_and_payload'` records remain eligible for **read-only** diff rehearsal. Neither format can be automatically applied or promoted as the live storage authority. Node contracts and Chromium/WebKit regression tests verify old-record preservation, provenance refusal and unchanged V1.

This is an explicit safety boundary, not a migration that erases older recovery evidence; actual external backup and writer-fenced restoration remain separate cutover prerequisites.


## October 27 — Preview-only participating-tab writer discovery

V2 now exposes `inspectPreviewWriterPeers()` to perform a short, voluntary BroadcastChannel challenge across other **currently responsive V2-preview tabs**. Its passive responder is installed only when the V2 dark mirror is enabled; no live V1 save path is wrapped or paused. A probe collects only whether each responding tab has preview enabled, shares the same generation, and supports browser Web Locks. It never copies Habit rows, application state, or recovery payloads into a cross-tab message, and it never writes localStorage.

The report deliberately includes `allLegacyWritersKnown:false`, `productionWritersFenced:false`, and `canPromote:false` **in every outcome**, including when all observed peers responded and Web Locks are supported. An unresponsive, background-suspended, pre-V2, or legacy-only tab can still write without ever answering the challenge. Receiving zero answers never proves there are no other tabs. Absent BroadcastChannel support or a changed generation/preview mode gives a nonpromotable failure/limited result.

Node contracts simulate participating peers (including one without Web Locks) and verify no storage modifications. Actual Chromium/WebKit browser checks use two V2-preview tabs plus a third legacy-only page which writes an unrelated V1 key without responding; the report still refuses to certify complete writer coverage. This is protocol scaffolding, **not a production handoff**. A future stage must gate *all* V1 mutation entry points on a real cross-tab writer lease and test stale tokens, suspended tabs, imports, WAL, compaction, and crash recovery before any authority switch.


## October 27 — Cooperative shared writer-lock prototype (developer-only)

V2 now has `exercisePreviewCooperativeWriterLease(operation)`, an **explicit developer-only** rehearsal restricted to localhost and approved branch-preview hosts. It requests a **shared Web Lock** under the same resource name that `rehearseExclusiveWriterLease()` requests exclusively. Multiple voluntary cooperative operations may coexist, while a pending exclusive handoff proof must refuse a busy lock. Conversely, an existing exclusive lock denies new cooperative operations. The lock is released as soon as the callback finishes or fails.

The method does **not** install itself on Home, normal V1 saves, imports, journal compaction, notes, or settings. It cannot select V2 reads/writes, issue a durable authority token, pause an unfenced legacy tab, or promote V2. Every result keeps `productionWritersFenced:false`, `allLegacyWritersKnown:false`, and `canPromote:false`. An operation that throws is reported as failed; the failure does not claim to undo side effects already performed by that operation. A generation or preview-mode change during the callback invalidates its rehearsal result.

The concrete existing legacy write-entry inventory includes:

- `scoring_core.js` `writePendingHabitDelta()` writes the V1 journal and independent V2-preview event sidecar keys.
- `scoring_core.js` `saveStateSnapshot()`, `saveValidatedSnapshot()` and `safeReplaceTaskPointsStorage()` write full snapshots, including recovery, import and replacement paths.
- `task_mutation_journal.js` wraps `saveStateSnapshot()` for Tasks, SCWM and protection against stale Home saves.
- `state_runtime_v2_wal_bridge.js` wraps snapshot replacement/restore generation transitions.
- Standalone notes/preferences, emergency storage and other `localStorage` writers must also be inventoried. A wrapper around **only** the above methods would not fence every legacy write.
- Older currently open tabs remain outside any newly added locking protocol until explicitly verified to have reloaded and opted in. Browser Locks alone cannot retroactively fence them.

Node contracts test callback rejection, absent Web Locks, preview-host restrictions, operation failure, and preview off/on invalidation. Chromium/WebKit scenarios exercise two simultaneous shared operations, exclusive-versus-shared contention in both directions, lock release following a failed callback, and a silent legacy-only page continuing to write without the new lock.

Browser-level coverage additionally checks that closing a preview tab while its cooperative shared-lock callback remains pending releases the browser lock, allows another tab to complete a *read-only* exclusive rehearsal, and leaves `taskpoints_v1` and authority unchanged. Closing a Playwright page is **not** equivalent to an operating-system kill of a physical Safari/PWA process; the latter remains a required manual validation.

### Cooperative-lock lifecycle follow-up (October 27)

The WebKit browser gate exposed an assertion issue in the new tab-close recovery test: its asynchronous polling recorded a successful exclusive rehearsal, then could observe a subsequent denied result in the shared browser global. The test now retries one rehearsal at a time from Playwright and asserts the retained successful proof directly. This is a test-harness correction; it does not change storage behavior or certify physical PWA termination.

A separate two-tab browser regression deliberately rotates the **synthetic fixture generation** while one developer-only cooperative shared-lock callback is suspended. The expected result is `generation_or_preview_changed_under_lock` with `canPromote:false`, release of the shared lock, unchanged V1 snapshot, and continued `legacy_only` authority. The fixture does not execute production Reset All/import or prove all legacy writers participate. Physical Safari/PWA interruption and full writer fencing remain required before authority can ever be switched.

### Voluntary prewrite generation guard (developer-only)

The cooperative-lock rehearsal now passes an optional frozen callback argument:
`({ assertPreviewGenerationCurrent }) => { ... }`. A participating fixture can invoke
`assertPreviewGenerationCurrent()` immediately before a controlled write, including
after an asynchronous pause. It throws `STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED`
when the preview mode or persisted reset generation differs from that seen at
lease acquisition. The outer diagnostic then returns
`cooperative_operation_generation_invalidated` while releasing the shared lock
and retaining `mutationAuthority:'legacy_only'` and `canPromote:false`.

The Chromium/WebKit browser regression starts with a fresh guarded fixture
write, then suspends a second callback, rotates the synthetic test generation
in another tab, resumes it and requires the stale *fixture* write not to occur.
The separate existing unguarded race test intentionally continues to show that
post-callback validation alone can only **report** a stale generation after
side effects may already have happened.

**This is an opt-in test helper, not a storage transaction or recovery
boundary.** It cannot roll back operations already completed, prevent another
tab from changing generation immediately after the guard returns, control an
uncooperative V1 tab, or promise physical Safari/PWA kill safety. Production
writers must not be wired to this experimental helper as a shortcut to a real
fenced handoff. All rollout blockers remain in force.

### Legacy writer inventory: initial CI guard

The V2-only `tests/state_runtime_v2_legacy_writer_inventory_contract.test.js` now scans top-level JavaScript/HTML for direct browser-storage writes and core save/replacement calls. The V2 Contracts workflow hard-gates the following verified legacy write surfaces:

| Source | Existing mutation surface | Handoff implication |
| --- | --- | --- |
| `scoring_core.js` | Habit-delta journal, snapshot and replacement writes | Core wrappers alone do not establish global exclusivity |
| `index.html` | Home snapshot saves, explicit storage removal, Notes and other direct keys | Normal foreground Home writers must be fenced |
| `today.html` | Snapshot updates from Today | Separate page context may write independently |
| `settings.html` | Imports, snapshot replacement and direct key writes | Reset/import must rotate generation under a real fence |
| `notes.html` | Direct Notes contents, dirty/authority keys | Separate Notes authority is not captured by a Habit-only lock |
| `emergency_recovery.html` | Recovery holds, restored snapshots and journal removal | Urgent rollback/recovery must retain safe operation |
| `task_mutation_journal.js` | Journal write, delete and snapshot-compaction wrappers | Deferred writer must not bypass a future handoff |

The contract also ensures the developer-only shared-lock rehearsal remains preview-host-gated, does not claim complete writer coverage or promotion authority, and is not silently wired into ordinary legacy pages. These tests are intentionally *pre-cutover* guardrails, not authorization to enable V2 storage authority.

**Scope limitation:** This is a line-oriented candidate-source audit, not an exhaustive JavaScript alias/control-flow analysis and not a runtime survey of all tabs. It can miss indirect writers, generated code, stale already-open pages, writes in nested scripts, and OS/PWA lifecycle races. Future work must inventory these cases, integrate a real cross-tab writer fence at every authoritative mutation entry, and test rollover, error, abort, pending journals, imports, and off-device rollback. No source-scan success can set `allLegacyWritersKnown` or `productionWritersFenced` to true.

### Read-only authority-cutover barrier inventory

V2 now exposes `TaskPointsStateRuntimeV2.inspectAuthorityCutoverBarriers()` for an explicit **diagnostic only**. It consolidates Habit-pilot preflight, a legacy rollback-source inspection, and the voluntary preview-peer observation, then repeats the pilot/rollback inventory and compares a separately captured `taskpoints_*` namespace. If a nonpilot legacy key (such as Notes) changes during the asynchronous peer challenge, the report fails closed with `inventory_changed_during_check`. A missed or denied storage read also cannot grant authority.

The report enumerates seven minimum known unfenced writer families: core snapshots/Habit journal, Home, Today, Settings/import/reset, Notes, emergency recovery, and Task journal/compaction. It **unconditionally** sets all five production-critical readiness flags to false: complete writer fencing, complete authoritative collection migration, independently verified off-device rollback, physical Safari/PWA lifecycle validation, and production multi-context handoff. `canPromote`, `mutationAuthority`, and `readAuthority` remain `false`, `legacy_only`, and `legacy_only`, respectively, regardless of any green pilot or observable preview peers.

Contract tests pin those blocker semantics, and browser regressions verify that a healthy Habit pilot cannot authorize a cutover and that an unrelated Notes edit by a legacy-only tab during the observation window is detected without overwriting it. The snapshot inventory currently covers storage keys beginning with `taskpoints_`; it is not a comprehensive survey of aliases, unrelated project keys, external backups, open older tabs, or browser/OS termination. There is **no persisted approval flag, write fence, automatic restore, or authority switch** in this diagnostic. A passing report of pilot consistency does not establish that production is ready.

### Full-origin localStorage race coverage (October 27)

The read-only cutover inventory now enumerates **all** current origin-`localStorage` keys and values, not just keys beginning with `taskpoints_`. This addresses otherwise missed legacy keys such as `tp_projects_v1`. The inventory rejects missing/unreadable keys, duplicate keys, and changing key counts, and compares the sorted before/after observations around the async preview-peer probe. It never writes storage, opens a new database, creates a rollback checkpoint, or switches authority. Existing `captureLegacyNamespace()`, snapshot/checkpoint key-selection rules, and recovery formats are **unchanged**.

Browser regressions verify two independent races: another tab editing `taskpoints_notes_v1`, and a legacy-only tab editing `tp_projects_v1` while the observer's read-only cutover check is suspended. They also verify fail-closed behavior when a project key's value cannot be read. Test synchronization uses a page-local variable rather than writing a marker to localStorage, so it cannot itself manufacture the observed storage change.

**Residual limits:** Two matching snapshots cannot prove exclusivity. A nonparticipating legacy tab can write between observations, change-and-restore a value (ABA), or write after the report. This inventory does not cover IndexedDB stores, sessionStorage, service-worker caches, off-device backups, or browser tabs on other versions/origins. It remains a diagnostic only; all hard rollout blockers remain false.

### Real legacy snapshot writer rehearsal under an exclusive lock

V2 exposes `exercisePreviewSerializedSnapshotLease(operation)`, a separate **developer-only**, explicit callback exercise on localhost/approved branch-preview hosts. It requests the existing handoff-rehearsal Web Lock **exclusively** rather than taking the shared cooperative lock. An explicit caller may acquire it, read the latest V1 state inside the callback, validate the supplied `assertPreviewGenerationCurrent()` guard, and invoke the **unchanged synchronous** `TaskPointsCore.saveStateSnapshot()` under that lock. The method itself never auto-installs a wrapper or schedules production saves.

The isolated Chromium/WebKit fixture verifies a real snapshot save preserving its previous Task row and out-of-pilot completion, while other *participating* shared/exclusive attempts fail with `lock_held_elsewhere`. It also verifies a fixture generation rotation before the guarded save prevents a stale V1 snapshot from being written, with the exclusive lock released afterwards. An old noncooperating browser tab still writes `tp_projects_v1` during the exclusive callback, explicitly proving coverage is incomplete.

The API always returns `canPromote:false`, `productionWritersFenced:false`, `allLegacyWritersKnown:false`, and `legacy_only` read/mutation authority. It cannot rebase or reconcile independently running old tabs, prevent ABA changes, make every synchronous caller async safely, or roll back an operation that wrote before failing. A callback that ignores the voluntary generation guard can still write stale data. This is **protocol evidence, not production fencing**. Before actual migration, every real writer must be inventoried and integrated without sacrificing sync-first durability or any emergency-recovery path.

### Stale full-snapshot source guard (October 27)

The preview-only `exercisePreviewSerializedSnapshotLease()` now supplies a second **optional** callback guard, `assertPreviewLegacySnapshotUnchanged(expectedRaw)`. The explicit caller can retain the exact serialized `taskpoints_v1` value used to build its candidate, then compare it synchronously inside the exclusive browser lock **immediately before the existing synchronous save**. If a nonparticipating tab has changed that V1 snapshot, the guard throws `STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_CHANGED` and reports `serialized_operation_snapshot_changed`; a missing token or denied storage read fails closed with a separate reason. The guard also checks generation and refuses use outside the active callback; it does not persist or broadcast raw snapshots.

Chromium/WebKit tests include a **real** uncooperative `TaskPointsCore.saveStateSnapshot()` by another tab while the rehearsal lock is held. The stale fixture then attempts to save its older candidate but is blocked before its write; the newer task, legacy completion, original V1 journal rules, and lock release are checked. Another test denies the underlying V1 storage read to ensure no promotion or destructive fallback. WebKit's independent Home Tasks UI test now activates the real Save button via `HTMLElement.click()` because offscreen inline editing made the pointer click fail; the underlying Save handler and persistence/reload assertions remain unchanged.

**Important:** This is still just a voluntary developer-side check of *one* source value. It does not compare effective pending Habit/Task journals, guarantee correctness if the caller supplies a fresh-but-unrelated token, stop a legacy writer between the check and save, or fix a stale in-memory candidate automatically. It does not change the normal sync-first V1 save API, wire real Home saves into Web Locks, restore snapshots, or enable V2 authority. A true production fence will need source/version provenance, cooperative coverage, reset/recovery semantics, and physical Safari/PWA testing.

### WebKit cross-tab visibility caveat (October 27)

A WebKit synthetic-generation test exposed a critical timing distinction: a `localStorage.setItem()` can return in one tab before another tab has observed the change. Therefore a suspended writer's generation check can still see its old value if the callback resumes immediately. The browser test now waits for **demonstrated visibility of the changed generation inside the writer tab** before evaluating the existing stale-generation refusal. It does not treat the other tab's successful `setItem()` as a synchronization or locking barrier.

This change stabilizes a narrow observational test, **not** the production protocol. Real mutation-authority transfer must rely on a verified cross-tab writer fence/epoch handshake with stale clients blocked, not merely on read-after-write timing, BroadcastChannel responses, or periodically sampled localStorage values. Unfenced V1 writers and physical Safari/PWA lifecycle tests remain unresolved. The new snapshot token guard likewise provides voluntary local best-effort checks, not guaranteed cross-tab visibility.

### V1 primary-journal source guards in serialized save rehearsal

The explicit preview-only exclusive snapshot lease now offers a third optional guard, `assertPreviewPrimaryJournalsUnchanged({ taskJournalRaw, habitJournalRaw })`. It requires both caller-supplied raw tokens (each a string or `null`) and rereads the **real V1 primary Task and Habit journals** inside the exclusive browser lock, immediately before an existing synchronous `TaskPointsCore.saveStateSnapshot()` fixture operation. A changed value refuses the callback with `serialized_operation_primary_journals_changed`; missing tokens or a denied journal read fail closed. The guard cannot be used outside its active callback.

Browser regressions involve actual `TaskPointsCore.journalTaskMutation()` and `TaskPointsCore.writePendingHabitDelta()` calls from another tab while the guarded writer is suspended. Those edits can be durable in a journal even if `taskpoints_v1` is unchanged. The stale fixture save must be rejected, the newer journal retained, and the V1 snapshot unmodified. These tests prove the **voluntary guard mechanics**, not general legacy-writer fencing.

**Limits:** Primary journal equality is not an effective-state transaction. This guard does not cover V2's independent per-event Habit sidecars, nonpilot keys, pending background compaction, write-after-check races, older nonparticipating tabs, or physical Safari/PWA process termination. Two equal reads (or ABA changes) cannot grant an authority switch. Ordinary V1 writers remain unchanged and synchronous. Complete writer fencing and safe offline rollback are still mandatory blockers.

### Independent Habit sidecar and verified-row cleanup rehearsal

The explicit **preview-only** `exercisePreviewSerializedSnapshotLease()` now offers
`assertPreviewHabitSidecarsUnchanged(expectedEntries)`, a strict, synchronous
comparison of the `taskpoints_v2_habit_journal_event_v1:` localStorage key/value
inventory captured before the exercise. The caller supplies a sorted list of
`[key, rawValue]` pairs; missing, duplicate, unsorted or malformed tokens are
rejected, and a denied key enumeration or value read fails closed. This guard
also checks the preview generation and cannot be invoked outside an active
exclusive-lock callback. It performs **no writes** and has no restore powers.

Browser regressions intentionally distinguish the sidecar from the primary
Habit journal and `taskpoints_v1`: (1) a second tab creates an independent,
valid Habit event key while all three primary values remain unchanged;
(2) the existing `clearCompactedHabitDeltas()` helper removes an already
verified sidecar after its completion has been persisted in V1; and (3)
malformed expected inventory or a blocked sidecar read is rejected. In each
case the stale preview callback must refuse to certify a successful
serialized operation; surviving events and verified V1 completions must
remain intact.

**No production fence is implied.** The array is an observational token,
not an atomic snapshot. A nonparticipant can create, delete or recreate a
sidecar between the test's observations, and a compaction process can change
both journals and snapshots independently. The method does not wrap real
Habit writes, grant a migration lease, guarantee timely WebKit localStorage
visibility, or verify background OS/PWA termination. Safe future cutover
still requires a transactional authority generation, complete writer
coverage, recovery and real-device validation.

### Forensic inspection WebKit retry discipline

The read-only V1/V2 mismatch browser check now treats
`inspection_window_changed` as a **correct fail-closed observation**, not
as evidence of corruption or permission to reseed. After another tab changes
or restores `taskpoints_v1`, the harness first waits for that exact raw
value to become visible in the inspecting tab; if a transient inspection
window changes during the asynchronous IndexedDB pass, it permits a small
number of separately executed read-only attempts. Any other refusal is
still a test failure. Every transient refusal must retain `canRepair:false`,
`evidencePreserved:true`, and `legacy_only` authority; the successful
inspection must prove the expected mismatch or match without modifying
either V1 or the four V2 stores.

This is a test-only synchronization improvement and does **not** weaken
`inspectPreservedParityMismatch()`, cause an automatic retry inside the
runtime, or certify cross-tab consistency in production.

### Combined prewrite source guard and deferred recompression test (October 28)

The localhost/approved-preview-only exclusive snapshot rehearsal now passes a
single optional callback guard called
`assertPreviewCompleteWriterSourcesUnchanged(source)`. It expects version 1
tokens for the exact `taskpoints_v1` snapshot, raw primary Task and Habit
journals, and the sorted independent Habit-sidecar key/value inventory.
For each controlled test write, this composed check compares the snapshot and
both journals, enumerates/compares sidecars, then rechecks the snapshot and
journals and finally the generation before returning. A missing/malformed
composite token fails closed. The individual opt-in guard methods remain
available and unchanged.

A Chromium/WebKit scenario now suspends a preview-only writer, lets an
**unfenced** legacy tab perform the real interactive packed
`TaskPointsCore.saveStateSnapshot()` and
`flushPendingInteractiveRecompresses()`, then resumes the preview writer.
The newer Task and existing unrelated completion must survive; the stale
preview candidate must be refused, and the rehearsal lock released. Another
scenario verifies that the combined guard cannot accidentally omit the
independent Habit sidecar check.

This does **not** turn the sequence into a transaction: separate tab processes
can still change storage between two synchronous reads or immediately after
the last read; primary Task/Habit journals can also advance during
compaction. The guard does not cover every TaskPoints key, image store or
older app version, and the callback can still bypass it. It is intentionally
**not installed into the real save path**, preserves all synchronous V1
writes, leaves V1 authoritative, and never grants V2 cutover approval.
Moving from this evidence to production requires a genuine writer-fencing
protocol plus a crash-safe recovery/rollback design.

### Transactional, preview-only writer fencing prototype (October 28)

An explicit preview-host-only API, `rehearsePreviewDurableWriterFence(action, options)`,
now provides a small, **isolated IndexedDB transaction** experiment with
`read`, `writer`, and `freeze` actions. It uses its own
`taskpoints_v2_writer_fence_preview_v1` database and `control` store, not
the V1 snapshot, V2 state database, or emergency recovery checkpoints.
All responses retain `canPromote:false`, `productionWritersFenced:false`,
`allLegacyWritersKnown:false`, and `legacy_only` read/write authority.

The `writer` and `freeze` actions require a caller-supplied exact
`expectedEpoch`. Inside one IndexedDB readwrite transaction, each request
reads the current fence control record, checks the stored generation and epoch,
rejects a frozen/stale participant, and records either a synthetic writer
marker or a freeze with an incremented epoch. The transaction completion,
not the initial request callback, is used as the reported success boundary.
No asynchronous network/UI work or localStorage write occurs inside the
transaction. The `read` action is observational and never creates a
control record.

Browser tests on Chromium/WebKit simulate two tabs attempting the same-epoch
freeze simultaneously: exactly one freeze should commit. Both stale-epoch
and correct-epoch-but-frozen writer attempts must then fail. The frozen
decision survives a tab close/reopen. Another test rotates V2's preview
generation and verifies that the previous generation's stored control
record cannot be reused. An explicitly **nonparticipating legacy tab is
still able to modify localStorage** despite the preview freeze, and the
original V1 snapshot must remain byte-identical throughout the rehearsal.

**Critical limits:** This prototype records only synthetic markers in an
independent test database. It is **not attached to production save callers**,
does not fence offline/pre-V2 pages, and does not move a real V1 mutation into
the same IndexedDB transaction. A Web Lock or IDB control record cannot make
an old synchronous localStorage writer transactional without a complete
protocol migration. A genuinely safe authority transfer still requires
comprehensive writer integration, journal handling, stale-generation
semantics, crash/termination recovery, physical Safari/PWA testing, and
independent rollback evidence. No path in this prototype grants promotion.

### Idempotent transactional writer marker rehearsal (October 28)

The isolated developer-only IndexedDB fence rehearsal now keeps a separate
`writer_marker:<marker>` record for each synthetic participating write in
the **same readwrite transaction** as the aggregate writer-count update.
Concurrent same-marker requests from two tabs serialize: one may commit the
marker and increment the count, while the other returns
`preview_writer_replayed` without incrementing it. A nonadjacent retry
after another writer has committed, or after a tab reload, remains
idempotent. A frozen or stale epoch takes priority over the replay result
and continues to reject the request.

The guard also refuses an overflowing epoch or writer counter rather than
storing an imprecise integer. Tests race a writer against a freeze, accepting
only the serializable outcomes (writer committed before freeze, or writer
refused after freeze). A quota-style failure on the **second** put deliberately
aborts the transaction; the test reads the raw preview database to prove
neither the first marker put nor the control count survived, and then confirms
a clean retry can succeed.

The record is still a **synthetic protocol marker**: it is not a V1 task or
Habit mutation, does not fence the old localStorage save paths, does not
prove physical device crash durability, and has no production rollback
semantics. Marker history in this preview database is intentionally not
garbage-collected, and the frozen state is not automatically reset. No
promotion is available.

### Two-stage generation validation in preview IDB marker lookup

The idempotent synthetic writer now checks the preview generation both on
reading the fence control record and **again** after the separate asynchronous
marker lookup, immediately before writing either marker or aggregate count.
A browser regression forces a generation rotation from inside the marker
request interception. It verifies that the transaction records neither
marker nor aggregate control, while the original V1 snapshot stays intact.
This closes a test-protocol observation gap but is **not a production
writer fence**: browser-local storage visibility is not transactional with
IndexedDB, and an old V1 tab can still mutate localStorage independently.

### Read-only recovery of ambiguous preview writer outcomes (October 28)

The isolated IndexedDB fence now supports
`rehearsePreviewDurableWriterFence('inspect_marker', {marker})`. This is a
strict **read-only** IndexedDB transaction that checks whether a synthetic
writer marker survived a lost callback response. It reports
`preview_writer_marker_present` or `preview_writer_marker_absent`, the
recorded marker epoch, and the current frozen/writer-count control state.
It refuses inconsistent or orphan marker records, different generations,
and unreadable transactions rather than inventing a successful commit.
It does not retry, restore, unfreeze, delete, or write any data.

A browser test intentionally starts a synthetic writer without awaiting its
result, verifies the commit from a second tab, closes the originating tab,
and then inspects and retries the marker after reopening another tab. The
marker remains present after an epoch freeze, and the retry cannot increase
the writer count. The existing injected-transaction-abort test additionally
checks that a failed marker reports **absent** through this read-only API.

This addresses **ambiguous synthetic acknowledgement**, not durable
TaskPoints writes. The control store is an isolated preview database;
physical app termination, filesystem failure, multi-origin storage, all
V1 writer entry points, and off-device rollback are not validated by it.
V1 remains the only authority and the protocol cannot promote V2.

### Two-put abort, reload recovery, and contradictory marker evidence (October 28)

The preview-only transactional writer-fence rehearsal now rejects additional
inconsistent durable evidence before authorizing even a synthetic marker.
A control record is invalid if a zero writer count claims a last marker, a
positive count lacks a valid last marker, or a frozen epoch is zero. A
separate writer marker without a matching control or with zero committed
writers is an **orphan**, not proof of a completed transaction. Both replay
and read-only inspection refuse such records; no runtime method erases,
silently repairs, or substitutes a newly initialized control.

The new Chromium/WebKit regressions exercise two distinct interruption
outcomes. First, a transaction has **both its marker put and control-count
put queued**, then an injected abort fires before commit. The independent
read-only inspector must observe an absent marker and uninitialized control,
even after the originating tab closes. A clean retry then commits once,
and subsequent retries remain idempotent. Second, a test fixture directly
plants an orphan marker and a contradictory control record into the
**isolated preview test database**. Neither a new writer attempt nor the
inspector may accept the corruption as a valid commit. The original V1
snapshot is checked unchanged in both scenarios.

These are browser-observed logical transaction and record-consistency
checks, not a demonstration of physical process-kill durability or storage
persistence after OS eviction. Old tabs and synchronous production
localStorage writers still bypass this preview fence. Actual cutover still
requires V1 writer coverage, full-collection migration, off-device recovery,
and physical Safari/PWA tests.

**Cutover remains prohibited.** Before a production lease can replace this prototype: audit and integrate every V1 writer with abort/fencing semantics, preserve urgent writes and crash-recovery behavior, verify an off-device rollback source, migrate all nonpilot collections, and run full physical Safari/PWA lifecycle testing. This test API must never be mistaken for production writer fencing.
