# Admission / old-client feasibility checkpoint

Decision: **NO-GO for a real Task authority migration under the current requirements.**

Base: `44b7cc1e0b5b8acab3bfd80dd7e31a5f5ed93643`, fetched from
`arch/state-runtime-v2-plan`. This experiment has no application imports,
HTML references, production hooks, mode flags, or deployment changes. V1 remains
authoritative. All writes happen in disposable browser contexts with synthetic data.

## Candidate and scope

`gateway.js` is a deliberately small, test-only candidate: one cooperative Web
Lock plus one IndexedDB transaction for payload, revision, generation and retry
receipts. It retains a captured legacy baseline and refuses new writes if that
baseline visibly diverges. It never imports subsequent legacy changes or writes
back to V1. This avoids hiding a conflict with an automatic merge.

This is an admission experiment, not a complete V2 runtime. In particular it does
not implement the production synchronous WAL, backups, exports, business logic,
legacy reset, or recovery procedures. A successful transaction is not proof of
physical-device power-loss durability. The test reset only rotates the candidate's
generation and empties its synthetic payload atomically.

The browser harness extracts and executes the actual `saveProjects()` function
from `projects.html`. Its exact body is asserted before execution. Inspection
confirmed the same function in the previously reviewed V1 commit
`4b8e9d337d53344288f9aa6dc0096627cb1e126b`. No legacy write implementation is
substituted. The full Projects UI is not booted: the harness supplies the same
storage key and synthetic `state.projects`, then calls the real writer. Projects
is a counterexample to universal admission, not a feature being migrated.

## Observed results

Node 22.23.5, Playwright 1.56.1, system Chromium 156.0.8078.79 on Linux:
**7 tests passed; 0 failed, cancelled or skipped.** See `results.tap`.

1. Two cooperating tabs submit competing edits: exactly one commits; retry does
   not duplicate it and a changed payload cannot reuse its receipt.
2. The real old writer writes while the new admission lock is held and overwrites
   a shared compatibility key. Web Locks do not constrain nonparticipants.
3. Separate IndexedDB records retain the new edit; a visible old edit is retained
   in legacy storage and blocks further admission. Neither version is discarded.
4. With modern tabs closed, an old tab successfully saves an edit and reads it
   back. A second stale old tab restores the original bytes. Both close. After
   reopening, all durable inputs to the gateway match a history with no old edit.
   The gateway accepts a subsequent mutation and cannot report the lost edit.
5. Candidate reset rejects stale participating generations and survives reopening.
   An old writer can still recreate its legacy document; candidate records remain
   empty, but application-wide reset cannot be certified from this protocol.
6. Explicit transaction abort before commit leaves no changed payload or receipt
   after reopening; retry succeeds.
7. After transaction commit, the caller's acknowledgement is deliberately held
   pending and its tab closes. Reopening and retrying does not apply twice.

Passing counterexample tests establish limitations; they are NOT a passing
old-client safety gate. Interruption tests are controlled transaction abort / tab
closure and reopen within a browser, not browser-process crash, OS termination,
quota testing, WebKit, or physical iPhone validation. No whole-app gate is credited.

## Why the requirement cannot be satisfied by this gateway

A new page cannot revoke the storage access of already-running old JavaScript.
Generation flags, locks, storage listeners and new API wrappers require that old
code cooperate. Double-checking bytes detects some races but cannot recover an
edit overwritten while no durable observer existed. Equality after restart does
not prove that nothing happened in between.

Separate storage (or a new origin) protects new records from known legacy writers,
but does not preserve every old-client edit. Conversely, feeding legacy snapshots
back into V2 risks reverting newer edits and cannot infer missing intent. An
explicit conflict queue helps only for changes actually observed and captured.
There is no safe automatic reconciliation of a history that was never retained.

This falsifies the proposed shared gateway as a COMPLETE solution to unrestricted
old-client coexistence. It does not falsify record-level V2 storage or the gateway
for cooperating clients. No implementation workaround should be promoted.

## What must change before proceeding

Choose and prove a finite transfer/upgrade boundary that stops legacy editing,
captures and reconciles every retained source/journal, and prevents old clients
from subsequently being used as writable peers. A request to close tabs, a quiet
period, or an update announcement alone is not an enforceable exclusion proof.
A separate origin alone also does not solve abandoned legacy edits.

Alternatively, explicitly revise the product requirement so legacy clients are
outside the supported editing contract after a controlled transfer, with an
honest procedure for recovering divergent retained legacy data. Such a revision
requires an owner decision; this experiment does not grant it. Lost edits already
overwritten by legacy peers cannot be reconstructed by either route.

Until a boundary is established, keep V1 authoritative and do not start the first
real Task authority migration. Further preview inspectors cannot resolve this
missing control over legacy writers.

## Reproduce

Install tools outside the checkout (no manifest or lockfile changes):

```sh
npm install --prefix /tmp/taskpoints-boundary-tools --cache /tmp/taskpoints-npm-cache --no-audit --no-fund playwright@1.56.1
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules BOUNDARY_CHROMIUM_PATH=/usr/bin/chromium node --test --test-timeout=45000 experiments/v2-admission-boundary/run-browser.cjs
```

Set `BOUNDARY_CHROMIUM_PATH` to an installed Chromium executable, or omit it when
Playwright's matching browser is installed. The standard Playwright browser CDN
was denied by this environment's network policy; the successful run used the
installed system Chromium. No network settings or verification checks were changed.
The explicit runner name keeps this optional browser experiment out of default
Node test discovery. No dependencies were added to the application.
