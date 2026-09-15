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
