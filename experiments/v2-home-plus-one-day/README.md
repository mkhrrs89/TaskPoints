# V2 ownership for Home +1 Day

Clicking the real Home `+1d` button moved the synthetic Task from November 18 to
November 19, 2026. A new page and a new Chromium process both read November 19
from V2. The V1 snapshot still held November 18, and the test recorded zero V1
write attempts.

The experiment mounts the Task cards and event delegation taken directly from
`index.html` with the existing eligibility and date rules. It exercises the Home
Task component in a disposable browser profile on a loopback server. The harness
loads only this component and the storage code needed for the experiment.

## Save and recovery

- An explicit synthetic fixture on a fresh localhost origin seeds the existing V2
  database schema. The Home adapter is selected only in the experiment. The
  original Home journal path is exercised separately with the adapter absent.
- An action compares the generation, Task revision and Task contents that Home
  displayed. One IndexedDB transaction writes the Task, mutation receipt and
  revision with strict durability requested. The existing V2 transaction helpers,
  `tasks`, `mutations` and `meta` stores are reused. The legacy-first WAL remains
  on its existing paths.
- Home renders the new date after a separate read verifies the row and committed
  receipt. Retry uses the same action ID. After a restart, startup validates the
  receipt chain and reads V2 before rendering. Missing, incomplete or inconsistent
  authority refuses to open.
- Synthetic legacy edits can still arrive from another tab. They remain in the V1
  snapshot or journal, and observed source changes block further admission and
  rollback until reconciled. The acknowledged V2 record and receipt survive. The
  legacy dark mirror is also blocked from reopening the seeded experiment database.
- Rollback freezes the exact V2 revision before preparing a downloadable, detached
  Task checkpoint. The test reopens it in a fresh synthetic V1 context through the
  real serializer and reader and verifies the latest date. Original source strings,
  journals and receipts remain available, and the experiment leaves source images
  in place. The checkpoint covers the Task compatibility test and is separate from
  the full lossless migration package in PR #1004.

This proves the write and restart path for one action in isolated synthetic storage.
Chromium process restart is tested. Device power loss, deployment, and the existing
production Home Screen storage context are outside this evidence. The old-client
safety requirement and the iPhone capture/handoff prerequisite still apply to any
real transfer. Legacy source comparisons detect observed drift only.

## Verification

- **19 browser tests passed.** Covered the real click and V1 path, process restart,
  duplicate action IDs, stale and competing edits, generation conflicts, quota,
  transaction abort and page closure, lost readback, corrupted or missing receipts,
  recovery holds, unrelated records and images, and detached rollback.
- **158 existing Task tests passed.** Covered Home fast paths, Critical Tasks state
  handoff, V1 journaling, V2 Task parity and the existing journal bridge.

Run with Node and the external Playwright/Chromium setup:

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules node --test --test-timeout=60000 experiments/v2-home-plus-one-day/run-browser.cjs
node --test --test-concurrency=2 tests/task_action_fast_paths.test.js tests/step5f_critical_tasks_state_handoff.test.js tests/task_mutation_journal_contract.test.js tests/state_runtime_v2_task_collection_parity_contract.test.js tests/state_runtime_v2_task_live_journal_bridge_contract.test.js
```

For manual review, run `node experiments/v2-home-plus-one-day/server.cjs` and open
its printed loopback URL in a fresh disposable browser profile.
