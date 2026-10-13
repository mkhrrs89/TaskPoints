# State Runtime V2 — Physical Device Step 4 Runbook

Updated: 2026-09-15

This runbook is for the remaining real iPhone/PWA evidence required by the Habits/completions V2 dark-mirror pilot.

## Safety boundary

This test runs only on the `arch/state-runtime-v2-plan` branch preview.

- Production `taskpoints.pages.dev` is explicitly rejected by the V2 opt-in page and the live reviewer.
- `taskpoints_v1` remains the UI/read authority.
- V2 remains a dark mirror and does not serve state to the UI.
- The V2 TEST panel is read-only with respect to TaskPoints state.
- **Start fresh test** clears only PERF trace history, resets the in-page V2 trace counters by reloading, and does not clear TaskPoints data, the V2 IndexedDB database, images, backups, or recovery state.
- No result from this runbook authorizes merging V2 into `main`.

## Stable branch preview

Use the stable branch preview rather than an immutable one-off deployment:

`https://arch-state-runtime-v2-plan.taskpoints.pages.dev`

Enable both the V2 dark mirror and performance tracing from:

`https://arch-state-runtime-v2-plan.taskpoints.pages.dev/state_v2_preview_enable.html?perf=1`

The page enables the preview-only flags and returns to Home.

## What should appear

On Home, the dark preview should show two temporary diagnostics controls above the mobile toolbar:

- the existing **PERF** control on the right;
- **V2 TEST** on the left.

`V2 TEST` is loaded only through the V2 dark-preview path. It is not a production UI feature.

## One clean Step 4 pass

1. Open **V2 TEST**.
2. Tap **Start fresh test** once. The page reloads after clearing only PERF trace history.
3. Use the real TaskPoints UI to toggle at least one Habit completion.
4. Reorder Habits.
5. Edit a Habit and save it normally.
6. Add a temporary Habit using the normal UI. Adding it is enough to exercise the V2 presence mutation; deleting a Habit also exercises that path. Retiring a Habit is intentionally not used for this check because retirement mirrors through the V2 edit path.
7. Continue touching/using the app briefly after one of those mutations. This is intentional: the trace must prove that user activity postpones the pending heavyweight parity pass.
8. Stop interacting with the app while leaving it visible in the foreground for at least **20 seconds**.
9. Open **V2 TEST** again and tap **Refresh evidence**.

The panel evaluates the current PERF report in memory; no report upload is required for the first pass.

## Ten live evidence checks

A complete device trace must show all ten checks:

1. Habit completion / toggle observed.
2. Habit reorder observed.
3. Habit edit observed.
4. Habit add / delete presence mutation observed.
5. No direct foreground V2 parity/compatibility maintenance observed.
6. Automatic parity crossed the 20-second deep-idle boundary.
7. Real user interaction postponed pending maintenance before that release.
8. The physical V2 completion store contains only the Habit/Vice completion records owned by this pilot.
9. V2 Habit/pilot-completion data affirmatively matches the legacy authority after idle parity.
10. No V2 mutation/runtime/serializer/maintenance failure evidence observed.

When all are present, the button changes to **V2 TEST ✓** and the panel reports **Step 4 trace evidence complete**.

The ownership check is deliberately separate from parity. Pilot-scoped parity can be green while an unrelated task/manual completion is accidentally present in the V2 store, so device evidence does not pass unless `scopeExcludedCounts.actualCompletions` is zero for the pilot comparison scope. Legacy-only completion classes may still exist in `taskpoints_v1`; they remain outside the first V2 proving ground and are preserved by compatibility snapshots.

Parity is intentionally strict for authoritative fields. The comparison ignores only the three known Home Habit render caches `__streak`, `__completion`, and `__failedStreak`. Timestamps, completion records, Habit order, and other fields remain part of the comparison. For parity comparison only, a historical full Habit/Vice completion that omits `completionFraction` is treated as the canonical full value `1`; half/custom fraction differences remain strict and neither stored source is rewritten by that normalization.

## Legacy/full-state foreground correlation

The ordinary V2 TEST panel still reports legacy/full-state timing candidates. For deeper Step 4 analysis, export the PERF JSON and open:

`https://arch-state-runtime-v2-plan.taskpoints.pages.dev/state_v2_trace_review.html`

The offline review page now correlates each recorded V2 mutation enqueue with the most recent user interaction on the same page, within a bounded five-second window. It then identifies legacy/full-state operations whose timed intervals overlap that interaction-to-enqueue foreground window.

The correlation can include:

- Phase 2/4/5 work;
- writes to `taskpoints_v1`;
- large JSON serialization or structured cloning;
- snapshot/canonicalization work;
- non-V2 IndexedDB transactions.

The page reports:

- how many V2 mutation windows could be correlated to a real interaction;
- how many correlated windows contained legacy/full-state work;
- the maximum overlapping legacy/full-state duration;
- a bounded per-mutation list of the overlapping operation names and durations.

The V2 IndexedDB transaction itself is explicitly excluded from this legacy-work result. The correlator is read-only and does not affect the Step 4 pass/fail verdict; it exists to identify which remaining legacy whole-state costs are actually on the foreground path before V2 can own a mutation class.

A legacy candidate occurring elsewhere in the trace is no longer enough by itself to call the interaction blocked. If a mutation enqueue has no nearby recorded interaction, the correlator marks that window uncorrelated rather than guessing.

## If the panel is not fully green

Tap **Copy review** and send the copied review back for inspection. If parity or pilot ownership is red, the review includes bounded diagnostic evidence; do not reset or reseed simply to make the check green.

If deeper timing correlation is needed, use the existing PERF control to download the full JSON report and run it through `state_v2_trace_review.html` as described above.

Do not repair, reset, or delete TaskPoints data simply because a V2 check is missing or red. The dark mirror is diagnostic and production/legacy state remains authoritative.

## Current timestamp and ownership verification targets

The latest parity fixes preserve two timestamps that previously could diverge in the dark mirror:

- Habit reorder now carries the per-Habit `updatedAtISO` values produced by the canonical Home reorder path through the durable overlay and V2 mutation.
- Backdated Habit completion now carries the canonical `completedAtISO` from the selected day through pending delta replay, WAL identity, and V2 commit.

The September 15 ownership tightening also means:

- V2 seeds and stores only Habit/Vice completion rows for this first pilot;
- task/manual/other completion classes remain legacy-only and are preserved when a compatibility snapshot is built;
- Habit-edit completion sequencing is calculated inside the same pilot-owned subset so unrelated legacy completion rows cannot make a metadata-only edit rewrite unchanged Habit completion history;
- the live trace verdict now fails closed unless the pilot scope is explicitly reported and the V2 store contains zero out-of-scope completion rows.

The next physical pass must therefore include a normal reorder and, when convenient, a completion recorded for a day other than today. Strict parity and pilot ownership should both remain green without weakening timestamp or completion semantics.

## Additional physical scenarios after the primary trace

The primary Step 4 trace is not the only manual lifecycle evidence required before authority changes. Later physical passes still include:

- complete a Habit and immediately kill the standalone app;
- rapid completion burst followed by kill;
- navigate/background during an actual IndexedDB write;
- standalone PWA plus Safari tab simultaneously;
- two normal tabs modifying Habits;
- repeated reorder/edit/add/retire/delete in the real UI; retirement remains an edit-path scenario while add/delete exercise presence;
- repeated reload during dark verification;
- export immediately after a recent mutation;
- Reset All/import/emergency restore through real controls;
- cleanup while another preview tab holds the V2 database open.

Those are separate lifecycle/recovery gates. They should not be conflated with the foreground-performance evidence collected by the V2 TEST panel.

## October 13 Time of Day parity trace (post-Main reconciliation)

The October 13 physical preview review (schemaVersion 4; 954 events) observed all
four pilot mutation classes: 14 completions, 2 reorders, 1 edit and 1 presence
mutation. All 18 V2 transactions committed durably; no V2 mutation/runtime
failures or revision conflicts were observed. The deep-idle maintenance and
interaction-preemption checks passed (20-second quiet boundary; 97 preemptions).
Habit/Vice pilot ownership was correct: zero nonpilot completions in V2.
All 4,584 pilot completions matched, with 2,751 nonpilot legacy completions
correctly excluded.

Parity was red for 66 of 68 Habits. All 20 available bounded samples showed
the same exact field difference: legacy `timeOfDay` was the literal empty string,
and the corresponding older V2 row did not have that property. The sampled
empty-string hash was `ffcaaa85` (the stable JSON representation `""`).
The remaining 46 changed Habit rows were not individually sampled, so do not
assume they were all equivalent defaults without a fresh green parity check.

Home's `normalizeHabit` maps an absent Time of Day to `''`; newly introduced
grouping has no semantic distinction between these two cases. V2 therefore now
normalizes **only the missing `timeOfDay` property to `''` for parity
comparison**. The comparison still rejects nonempty Time of Day labels,
whitespace, explicit null, and all other authoritative-field differences.
No legacy records, V2 database records, WAL entries, revisions, compatibility
exports, or user data are rewritten by this diagnostic projection.
The report includes `normalizedHabitEmptyDefaultFields` and
`normalizedHabitDefaultDifferences` for transparent inspection of these
representation-only differences.

The foreground correlation also found a legacy 1,624 ms full-state save during
Habit edit and a 1,282 ms save during Habit creation; V2 synchronous enqueue
work stayed at 0–2 ms. These legacy costs remain a performance problem,
not evidence that V2 itself made the actions fast. No paint boundaries
were available, so the report is not a full input-to-paint measurement.

**Next physical verification:** reload the updated branch preview, start a
fresh V2 TEST, exercise completion/reorder/edit/presence, and capture a new
10-check review after 20 seconds idle. Confirm strict parity green, all pilot
completions match, no out-of-scope V2 completions, no mutation/runtime failures,
and no suspicious reseed. If parity remains red, inspect the new field samples
rather than weakening the comparator. Keep Main unchanged and do not authorize
V2 mutation ownership from this representation-only correction.


## October 13 verified physical Step 4 pass and next WAL recovery gate

The second October 13 iPhone preview review (`reportGeneratedAtISO:
2026-10-13T19:47:42.167Z`, 575 events on two pages) **passes all ten
primary Step 4 device evidence checks**:

- Four completions, two order changes, one Habit edit, and one Habit
  presence/add were durably committed: **8/8**, with **zero** V2 mutation,
  subsystem, runtime-mirror, or revision-conflict failures.
- Strict parity is confirmed: both hashes were `ee7014a3:1638415`,
  **69/69** Habits and **4,584/4,584** pilot Habit/Vice completions matched,
  with no missing, extra, reordered, or changed authoritative fields.
  **2,751** unrelated legacy completions stayed out of pilot scope, and
  **zero** unrelated completion rows entered the V2 database.
- The parity-only projection transparently accounted for **65** missing
  versus explicitly empty `timeOfDay` defaults. It did not modify stored
  records, and strict comparisons for real values remain in effect.
- Maintenance was deferred and released after the full 20-second quiet
  window (**56** interaction preemptions; 20,507 ms after last interaction).
  No direct foreground V2 parity/compatibility maintenance was recorded.
- Startup reused the existing V2 pilot database via
  `stateV2.seedAlreadyCurrent` (revision 181), without a full reseed.
- Foreground V2 synchronous enqueue costs were at most **2 ms**.
  The old full-state foreground save path still overlapped Habit edit
  (up to **1,391 ms**) and Habit creation/presence (**1,309 ms**);
  these are remaining **legacy performance costs**, not V2 failures.
  No next-paint boundaries were captured, so these are not definitive
  input-to-visible-frame response times.

This closes the primary **Step 4 dark-mirror physical trace** gate only.
It does **not** satisfy the separate device lifecycle/recovery gates, and
does **not** authorize V2 mutation authority or merging into Main.

### Next: deterministic preview WAL interruption/replay test

The preview already has an **Arm WAL kill test** button in **V2 TEST**
(`state_runtime_v2_live_review.js`). It intentionally preserves the
ordinary authoritative V1 write and the synchronous V2 WAL, but holds
V2 async confirmation until the current page restarts. This tests a
real page interruption without touching production or resetting data.

1. In the stable V2 branch preview, make sure dark mode/PERF is enabled.
   Open **V2 TEST**, click **Start fresh test** **before** arming, if a
   clean trace is desired.
2. Open **V2 TEST**, select **Arm WAL kill test**, and close the panel.
3. Toggle **one** noncritical Habit, noting its expected new completion
   state. The legacy write should remain authoritative. Do not reset,
   import, or open the V2 cleanup page.
4. **Immediately reload or close/reopen the preview** to end the held
   page lifetime (real standalone iPhone app force-quit/reopen is also
   useful). Do not click **Start fresh test** *after* restarting,
   because it discards the trace of the recovery.
5. With the restarted preview visible, open **V2 TEST** and select
   **Refresh evidence**, then **Copy review**. If needed, leave the
   preview foregrounded and untouched for at least 20 seconds to allow
   the idle parity pass, then refresh/copy again.
6. Required evidence: `startupRecoveryOrder.mode === 'wal_then_seed'`
   when compatible V2 metadata and a current-generation WAL entry
   exist; `walRecovery.replayAttemptCount >= 1`,
   `walRecovery.replayClearedCount >= 1`,
   `walRecovery.replayRecoveryConfirmed === true`,
   and `walRecovery.replayFailureCount === 0`. Verify the Habit has the
   intended state once, parity is green, there is no data duplication
   or suspicious reseed, and no V2 failure.
   If the hold did not activate or confirmation raced ahead, the trace
   may not contain a replay—report that as inconclusive, not a pass.

This specific test is **preview-only**, gated away from
`taskpoints.pages.dev`. The first physical trace's
`walRecovery.observed === false` is expected because it had no
interrupted pending WAL entry.

Only after this recovery test should the next device gate cover rapid
completion bursts, multi-context revision conflicts, foreground /
background lifecycle interruption, and export/reset/restore parity.
