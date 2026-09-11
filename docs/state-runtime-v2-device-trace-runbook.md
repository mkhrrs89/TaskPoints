# State Runtime V2 — Physical Device Step 4 Runbook

Updated: 2026-09-11

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

## Eight live evidence checks

A complete device trace must show all eight checks:

1. Habit completion / toggle observed.
2. Habit reorder observed.
3. Habit edit observed.
4. Habit add / delete presence mutation observed.
5. No direct foreground V2 parity/compatibility maintenance observed.
6. Automatic parity crossed the 20-second deep-idle boundary.
7. Real user interaction postponed pending maintenance before that release.
8. No V2 mutation/runtime/serializer/maintenance failure evidence observed.

When all are present, the button changes to **V2 TEST ✓** and the panel reports **Step 4 trace evidence complete**.

## Legacy/full-state timing line

The panel also reports legacy/full-state timing candidates and the maximum observed duration. This is intentionally separate from the eight V2 checks.

Candidates can include:

- Phase 2/4/5 work;
- writes to `taskpoints_v1`;
- large JSON serialization or structured cloning;
- snapshot/canonicalization work;
- non-V2 IndexedDB transactions.

A candidate does **not** automatically prove foreground blocking merely because it occurred somewhere in the trace. The real trace is used to correlate those durations with the interaction path and decide which remaining legacy full-state work should move off that path before V2 can become authoritative.

## If the panel is not fully green

Tap **Copy review** and send the copied review back for inspection. If deeper timing correlation is needed, use the existing PERF control to download the full JSON report as well.

Do not repair, reset, or delete TaskPoints data simply because a V2 check is missing or red. The dark mirror is diagnostic and production/legacy state remains authoritative.

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
