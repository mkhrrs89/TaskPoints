# Full Home compatibility results

**Full Home compatibility remains blocked.** The real `+1d` button saved November
16, 2026 directly to V2 while the full Home page and its normal startup modules
were running. Reload, Notes navigation, a lifecycle refresh, and process restart
could still display November 15 from V1. They left the November 16 V2 row and
receipt intact. The component experiment remains the supported synthetic proof.

| Path exercised | Observed result |
| --- | --- |
| Home cold startup | The V1 loader supplied November 15. The rendered card showed that date. An explicit V2 attempt from this stale view was refused. |
| Home → Notes → Home | Actual links and Notes loaded normally. Home returned to the old V1 date. |
| Home `save()` → `saveStateSnapshot()` | Saving the live Home state copied November 16 into V1. The V2 owner then detected changed legacy bytes and refused rollback. |
| `flushPendingTaskMutations()` and Home `pageshow` refresh | Compaction preserved the unrelated Task edit in V1 while keeping the older target date. The lifecycle refresh replaced Home's display with that V1 date. |
| Verified-secondary maintenance | A valid native startup record held November 15. Canonical V1 bytes stayed identical, but `taskpoints_storage_data_loss_guard_v1` changed and the owner reported source drift. The next Home boot took the native record and displayed November 15. |
| Competing legacy Task edit | A separate full Home tab's V1 journal held November 14. V2 retained November 16 and refused both another V2 write and rollback. |
| Injected IndexedDB quota failure | Home reported failure, neither the V2 date nor receipt advanced, and reopening read the original date. |
| Clean-source rollback | The checkpoint froze the V2 revision. A fresh synthetic V1 profile loaded November 16 from the detached snapshot while the source retained its original V1 date and V2 receipt. |
| Chromium process restart | V2 retained its acknowledged row and receipt, while full Home loaded the old date. |

The navigation, save and compaction tests retained the unrelated Task, Habit,
Game, Gold, Projects, Notes and exact Image bytes present after startup. The
compaction case intentionally changed the unrelated Task title. Habit comparisons
exclude three explicitly identified derived display counters that Home adds on save.

**Inbox preservation failed before the V2 action.** The seed reader verified the
message before navigation. Ordinary Home startup then wrote a `taskpoints_v1`
snapshot that omitted it, with the V2 fixture marker absent. The write trace goes
through the existing `saveStateSnapshot` chain to `safeReplaceTaskPointsStorage`.
The same witness passed against an independent temporary export of the untouched
V2 base at `44b7cc1e`, reproducing the omission. This experiment records the issue
without changing Inbox behavior.

## Why the gate stays closed

There are two Home readers to address in `index.html`: the initial `state`
initializer uses the verified native snapshot or V1 `load()`, and
`refreshMainPageFromStorage()` replaces the live state with the legacy result.
The ordinary `save()` then serializes the displayed state as a legacy snapshot.
Meanwhile `ownedLegacyEvidence()` currently compares all legacy key/value pairs,
so even a maintenance-only diagnostic change blocks subsequent V2 edits. Dropping
that check by itself would also overlook the observed competing Task journal edit.

A full Home owner needs a consistent V2 Task read at boot and lifecycle refresh,
plus explicit separation of the V2 Task fields from legacy persistence and conflict
checks that distinguish a diagnostic update from a real competing edit. Production
access and the existing iPhone handoff requirement remain outside this proof.

## Reproduce

`run-full-home.cjs` runs the checked-in Home HTML, actual Home controls, actual
Notes navigation, and the core script order derived from `_worker.js`. A loopback
server provides the asset bundle without Cloudflare HTML rewriting. It uses
isolated synthetic profiles and blocks external browser requests. A test-only
adapter connects the existing Home button to its durable V2 API after a normal
boot. It leaves the ordinary startup and writes running so the tests expose
compatibility failures. No application or harness ownership code changed in this
follow-up.

**10 full Home witness tests passed**, including assertions that reproduce the
blockers above. **19 component tests and 158 existing Task tests passed again.**
The one independent base Inbox check also passed by reproducing the omission.
See `full-home-results.tap` and `base-inbox-results.tap`.

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules node --test --test-timeout=160000 experiments/v2-home-plus-one-day/run-full-home.cjs
```
