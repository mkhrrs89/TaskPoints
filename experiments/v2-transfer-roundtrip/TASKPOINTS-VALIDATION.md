# TaskPoints-specific transfer validation

This is an isolated, synthetic experiment for draft PR #1004, based on V2 commit
`44b7cc1e0b5b8acab3bfd80dd7e31a5f5ed93643`. No application files, existing tests,
production data, deployment, main branch or V2 activation flags were changed.

## Decision

The transfer format supports every database/store layout identified in the current
TaskPoints application source. No identified store uses auto-increment. Exact
preservation is demonstrated, including damaged evidence; it is NOT approval to
run the full application over arbitrary restored data.

Proceed to **develop a source-only capture rehearsal using synthetic iPhone Home
Screen data**. Real-data capture, live startup, recovery promotion and V2 activation
remain blocked. The first device blocker is identifying and reading the actual
Home Screen storage context without navigating/reloading or modifying that app.

## Storage inventory and coverage

`taskpoints-schemas.cjs` derives names and store lists from current creation code.
`storage-creation-sites.json` pins all 32 creation sites in root application JS/HTML;
the test fails if these source anchors change. Eleven databases contain 34 stores:

| Database | Version | Stores |
| --- | --- | --- |
| taskpoints | 1 | images |
| taskpoints_shadow_state_v1 | 1 | completions, matchups, gameHistory, seasonHistory, tasks, habits, players, collections, values, metadata |
| taskpoints_safety_vault_v1 | 1 | snapshots |
| taskpoints_verified_secondary_v1 | 1 | snapshots |
| taskpoints_state_v2 | 6 | habits, completions, mutations, tasks, projects, todayDays, goldLedger, meta |
| taskpoints_v2_recovery_checkpoints_preview | 1 | snapshots |
| taskpoints_v2_notes_preview | 1 | bundles, receipts, meta |
| taskpoints_v2_habit_order_preview | 1 | records, receipts, meta |
| taskpoints_v2_game_preview | 1 | players, bundles, receipts, meta |
| taskpoints_v2_frozen_origin_witness_v1 | 1 | witnesses |
| taskpoints_v2_writer_fence_preview_v1 | 1 | control |

Images have out-of-line keys and Blob values. Shadow stores use key, field or id
key paths. Other stores use id; V2 completions also have a multi-entry habitIds
index. Schema, indexes, record keys/values and binary content are compared exactly.
The V2 layouts are archival fixtures: no V2 runtime is loaded or activated.

The existing source inventory's 146 key references deduplicate to **76 literal
keys**. All 76 survive an opaque-data transfer test, alongside dynamically named
sidecars and an unknown future key. Export enumerates storage, not this list.
That test deliberately does not treat arbitrary fixture values as runnable state.

Realistic fixtures separately cover:

- The actual core serializer's packed/compressed canonical snapshot, unknown root
  and nested fields, plus actual shadow migration output and verification metadata.
- Actual Habit writer output and journal reader overlays for Task, Habit, Player,
  Flex completions/order and Inbox; primary/sidecar deduplication.
- Dirty authoritative Notes cache, Today and Projects documents, preferences and
  generation metadata; actual Notes page startup on a synthetic origin.
- All four rolling-backup envelopes, vault slots, secondary latest/native/candidate
  record shapes, raw snapshots, nested state, recovery evidence and unknown fields.
  Vault/secondary hashes/statuses are explicitly synthetic/untrusted; copying a
  `passed_verification` label is NOT independent validation of that recovery record.
- Referenced and orphan image bytes, independently read back using native IDB APIs.

Preview store values exercise generic structured-clone preservation; their domain
recovery semantics are not certified. Unknown databases are enumerated too, but
unsupported types, auto-increment generators, unavailable catalogs and packages
over the 32 MiB body limit still refuse. The code census cannot establish what
historical/unknown databases actually exist on the iPhone.

## Preservation is different from safe startup

A negative regression test demonstrates an existing V1 behavior:
`readPendingPlayerEdits()` throws on a malformed journal, but `loadAppState()`
catches that error and can return the older Player value. The original bytes
remain, yet the returned state is incomplete. This production behavior is unchanged.

`startup-preflight.cjs` is a deliberately conservative **offline reader-rehearsal
check**, called by the test harness before loading the selected real browser
readers. It parses the canonical snapshot using the unchanged core in an isolated
VM with read-only copied storage, no document/IDB, and no running timers. Malformed
or missing canonical state cannot become an empty default or an archive fallback.
Known pending journals must satisfy the experiment's supported shapes and targets;
unknown versions/operations, filtered invalid rows, duplicate/ambiguous records,
stale-generation sidecars and conflicting Habit evidence block the rehearsal.
Unknown pending/recovery protocols, Phase5b pending changes, restore packages,
recovery holds/locks and the data-loss guard also block, including malformed or
apparently inactive evidence. Nothing is expired, fixed or cleared to get past it.

Damaged backup/quarantine archives can still be copied and reported as archive-only
when the canonical state and selected journals pass. They are NEVER automatically
selected for recovery. IDB recovery databases are copied but never used as recovery
sources by these reader tests. Both `applicationEnabled` and
`recoveryFallbackAllowed` stay false. A verified import marker alone is insufficient;
the initial reader test also compares the complete destination to its original.

This check is intentionally stricter than some legacy readers and may reject valid
older forms that have not been demonstrated. It is not a general schema validator,
a live browser entry-point gate, or proof of every page's normalization/maintenance
behavior. Full Home startup and automatic vault/secondary/Phase5b recovery are not
admitted by this experiment. A future app integration must keep them blocked until
its own admission and recovery verification is implemented and tested. Do not load
these modules into a live site or interpret this test result as making existing V1
startup safe for arbitrary corrupt data.

## Results and reproducibility

Run with Node 22.23.5, Playwright 1.56.1 and Chromium 156.0.8078.79 on Linux:

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules BOUNDARY_CHROMIUM_PATH=/usr/bin/chromium node --test --test-timeout=180000 --test-concurrency=1 experiments/v2-transfer-roundtrip/run-browser.cjs experiments/v2-transfer-roundtrip/run-taskpoints.cjs
```

**60 experiment tests passed, 0 failed/cancelled/skipped: 18 original generic
tests plus 42 TaskPoints-specific tests.** Complete TAP: `taskpoints-results.tap`.
The generic 18-test suite includes rollback into a fresh origin, reset/old-origin
isolation, aborted IDB transactions, interrupted imports and full graceful browser
process restart. The TaskPoints suite adds realistic incomplete import/refusal,
import quota failure/resume, actual save quota failure with retained journals,
restart and repeated effective-state reads with exactly one copy of each expected
completion. Failure-injection tests pass only when the expected refusal occurs.

Existing protection tests were run separately: **196 passed, 1 failed** across
11 files. The failure in `notes_cache_authority_contract.test.js` expects the
literal text `authority.dirty || authority.authoritative`. It also fails on an
independent temporary export of the unchanged V2 base (4 pass, 1 fail). No test
was weakened or source changed to hide it. Compact reproducible evidence is in
`existing-protection-results.txt`; full logs needlessly dump the entire core on
that regex failure. This failure does not certify or disprove all Notes behavior;
the actual transferred dirty-Notes page test passes.

During development a mistaken new key-count assertion (>100) was corrected to
76 unique keys from 146 references. An initial expanded-suite run hit its old
45-second whole-file timeout; the bounded budget was raised to 180 seconds.
Neither change bypasses a safety assertion. The final run includes all cases.

## Next implementation task: source capture, synthetic only

1. Install a separate synthetic rehearsal site as an iPhone Home Screen app. Put
   distinctive localStorage, sessionStorage and IDB/image records in that context
   and different records in Safari. Prove which context is being inspected.
2. On a paired Mac, investigate Safari Web Inspector access to that already-open
   Home Screen app on the actual iOS version. Availability must be demonstrated,
   not assumed. If it cannot inspect that context, stop: a new origin or ordinary
   Safari tab cannot substitute. A production same-origin capture surface would
   require a separate implementation and explicit authorization.
3. Develop an extractor that uses enumeration and readonly IDB transactions only.
   Do not call normal backup/recovery, save, migration, compaction, journal replay,
   cleanup or reset code. Preserve raw journals, locks, archives and unknown data.
   Capture the current tab's session evidence before retiring it. No tool here
   currently supports production origins; the localhost restriction remains.
4. With the owner deliberately stopping edits/other writers, compare repeated
   captures and verify a saved/reopened package on the Mac. Detect observed drift
   and abort; repeated reads cannot prove one atomic instant across LS/multiple
   databases. Capture alone cannot recover unsaved forms or already-overwritten
   old-tab edits. Any later old-session edit needs a fresh capture and explicit
   reconciliation; never discard it by treating the first package as final.
5. On synthetic data, test iPhone background/foreground, force-close/relaunch,
   interrupted file delivery, storage quota, image rendering, export memory/time,
   independent readback and latest-edit rollback. Record whether source reads leave
   storage unchanged; production app background writers may still change storage
   independently. Do not claim that pausing editing automatically stops all timers.

Only after that evidence and explicit owner approval can real-data capture or the
final session-retirement procedure be considered. The prior failed old-client
proof remains on the separately pushed `experiment/v2-old-client-boundary` branch
at `2f35bc4f68d73c39f06b28babe7119b598c50eab`. The existing old-client safety
requirement remains unresolved until its replacement is fully validated and the
owner explicitly approves the final change.
