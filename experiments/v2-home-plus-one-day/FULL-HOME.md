# Full Home acceptance for V2-owned +1 Day

The full synthetic Home page keeps showing the acknowledged V2 Task date through
reload, Notes navigation, lifecycle refresh, ordinary Save, Task journal
compaction, verified-secondary maintenance, and Chromium restart. Unrelated
data continues through the existing V1 paths. Full Home data preservation remains
blocked by the separate [Inbox startup loss](INBOX-STARTUP-LOSS.md).

## How the integration works

- The loopback harness explicitly selects a single synthetic Task and checks the
  fixture marker against V2 metadata. The Home card and Critical Tasks display use
  a separate view verified against the durable V2 receipt chain. The card waits for
  that read at startup and stays withheld if V2 cannot be verified. Lifecycle
  refresh rereads V2 even when the V1 revision did not change.
- Home keeps the V1 backing state and storage cache on their legacy values. The
  V2 display is not passed to ordinary snapshot, journal, maintenance, or backup
  writers. Both the original localStorage and native IndexedDB boot paths still run.
- V2 checks the canonical owned Task, its linked completions, its pending Task
  journal evidence, the legacy generation, and the existing recovery holds. The
  read and transaction checks refuse genuine conflicts and unreadable evidence.
  Unrelated Task compaction and verified-secondary diagnostics can change without
  disabling V2 edits. The component experiment retains its original full-source check.
- Rollback freezes V2 at the verified revision, reads the current legacy snapshot,
  and inserts only the verified owned Task into a detached candidate. A fresh
  synthetic V1 profile opens at the latest V2 date and keeps the latest unrelated
  Task edit. Original/current legacy strings and receipts remain archived. The
  source images and journals are left in place. This checkpoint exercises Task
  compatibility. PR #1004 retains the separate full storage-transfer format.

## Evidence and limits

The loopback tests run checked-in Home HTML and its real controls, Notes
navigation and the core script order derived from `_worker.js`. The service
provides static assets and the bundle without Cloudflare HTML rewriting. Test
profiles use only synthetic data and block external browser requests.

The acceptance cases assert the actual Task card date after each path. They track
first paint on reload to catch a temporary stale date. The tests also cover quota,
before and after commit interruption, stale V2 and competing V1 edits, malformed
journals, missing receipts, and the detached rollback checkpoint. The preservation
checks compare the unrelated Task, Habit, Flex, Game, Gold, Projects, Notes,
unknown Task fields and raw keys, quarantine evidence, and exact image bytes.
Habit comparisons omit three named derived display counters that ordinary Home
adds on save. The separate Inbox witness must continue to report the outstanding
loss until that startup path is repaired.

The scope is the single synthetic +1 Day action. The evidence compares observed
legacy changes and leaves competing edits for reconciliation. It does not exclude
uncooperative old clients or certify the installed iPhone handoff and real-data
transfer. The full Home adapter is loaded by the experiment only. Ordinary V1
storage and UI paths retain their existing behavior with the experiment disabled.

**16 full Home checks passed**, including the deliberate Inbox loss witness.
**19 component checks and 162 existing Task and Home checks passed.** See
`full-home-acceptance.tap` for this run and `full-home-results.tap` for the earlier
negative witnesses.

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules node --test --test-timeout=180000 experiments/v2-home-plus-one-day/run-full-home.cjs
```
