# Synthetic isolated-origin transfer rehearsal

Scope: engineering experiment only. Base V2 commit:
`44b7cc1e0b5b8acab3bfd80dd7e31a5f5ed93643`.
Branch: `experiment/v2-transfer-roundtrip`.

## Safety status — unresolved

The owner approved DEVELOPMENT AND TESTING of a controlled single-user,
isolated-origin alternative. This is NOT approval to transfer real data,
activate V2, deploy this tool, change production behavior, or finalize a revised
old-client safety requirement. The existing technical old-client exclusion
requirement remains unresolved until the replacement procedure is fully validated
and the owner explicitly approves the final change. No existing gate is removed,
weakened or credited here.

The failed old-client experiment remains preserved on
`experiment/v2-old-client-boundary` at
`2f35bc4f68d73c39f06b28babe7119b598c50eab`. Its loss counterexample still applies.

## What this implements

Only a localhost test harness uses `transfer.js`; no application file imports it.
It refuses non-localhost execution. The harness opens blank synthetic pages on
three separate origins: source, destination, and rollback destination. No V2
runtime, TaskPoints UI, or production storage is opened.

Capture preserves every localStorage key/value, including empty/malformed values,
unknown fields and literal `__proto__` names. It enumerates every IndexedDB
database/store/record, retaining versions, key paths, index definitions, keys,
values, images (including orphan images), backups and recovery records. The codec
supports cyclic/shared objects, sparse arrays, undefined, BigInt, special numbers,
Date, Map, Set, RegExp, ArrayBuffer, typed views, Blob and File bytes/metadata.
Unsupported stored types refuse export rather than being converted or omitted.

SessionStorage from the CAPTURING TAB is included as an archive. Session markers
are not activated in the destination; their exact values remain in the retained
package on every restart. Other tabs' session storage, unsaved forms, cookies,
service workers, CacheStorage and browser configuration are not captured. They
must not be silently treated as covered by this rehearsal.

The package contains the source origin, format version, complete captured data,
and SHA-256 integrity checksum. Hashing detects accidental alteration; it is NOT
sender authentication or a cryptographic signature. Use trusted package files.
The synthetic test writes the original to an external file, reopens it, and
restores after closing the source browser context.

Import requires an empty destination or an exact partial restoration of the SAME
package. Before materializing anything, it stores the exact original package and
an incomplete status in a separate control database. Existing/conflicting data is
refused, never cleared. Same-package retry fills absent data and rewrites only
matching existing records; it never deletes unrelated data. Database writes are
transactional within each database. An interrupted import remains incomplete.
Full record/byte/schema comparison is required before marking the copy verified,
and is repeated by inspection after reopening. A verified marker alone is never
sufficient. `applicationEnabled` remains false even after successful verification.

These stages do not pretend that localStorage and multiple databases form one
atomic transaction. The destination runs ONLY this tool; there is no app allowed
to consume partially restored data. An eventual application startup gate is NOT
implemented. No original journal is compacted, replayed, cleared or interpreted.
Recovery holds and other safety evidence remain preserved. Compatibility with
actual app startup/replay must be established separately.

Rollback rehearsal exports a NEW package after an isolated edit and restores it
into a fresh third origin. This retains the newest edit and every unchanged
record, while the initial package remains intact. It does not overwrite a live V1
site or claim that the production V1 importer supports this package format.

## Results

See `results.tap` for the final run. Node 22.23.5, Playwright 1.56.1,
Chromium 156.0.8078.79 on Linux. **18 passed, 0 failed/cancelled/skipped.**

The suite covers complete round-trip and unchanged source; exact package retention;
page restart; interruption after staging, after a database commit, and after data
verification before status commit; simulated quota failure; aborted IndexedDB
transaction; corrupted/truncated packages; changed image bytes; conflicting and
nonblank destinations; latest-edit rollback; unsupported auto-increment/type and
catalog refusal; old-origin write/reset isolation; external-file restore and full
destination browser-process shutdown/restart; silent dropped writes; observed
source drift; and independent native readback of binary data, indexes, cycles,
shared references and special values without using the package codec.

The first development run exposed an object-reference numbering bug when encoding
keys in a different order than reconstruction. Fixed by visiting keys in stable
order before assigning references; the final suite includes independent native
readback. Expected failure injections pass only when the tool refuses readiness
and retains the original package. No test assertions were weakened.

## Explicit limits / next real-device gates

- Source capture assumes the owner has stopped editing and retired other writers.
  Double captures catch observed changes, not every write/change-back race. This
  is not technical exclusion of old clients or proof of one cross-database instant.
- Source-side capture on the actual iPhone is not implemented or deployed. A new
  origin cannot inspect production-origin storage. The source execution method
  needs separate authorization and validation in the actual storage context.
- Auto-increment stores are rejected: their deleted-key generator high-water mark
  is not exposed by browsers. Inferring it from surviving keys is not lossless.
  Inspected TaskPoints stores use explicit keys; unknown stores must be checked.
- Unsupported structured-clone types (for example stored Error objects), unavailable
  catalogs, and packages over the 32 MiB body limit refuse. No truncation or count-only
  fallback. The codec and capture are in-memory; realistic iPhone memory/storage
  capacity must be measured before choosing production packaging/chunking limits.
- The reserved control database name is rejected if it occurs in a source package.
  It is excluded only when explicitly capturing the experiment's own destination.
- Package export captures raw journals and preserves unknown schema. It does NOT
  prove effective-state reconstruction, exactly-once business effects, or complete
  running-app functionality. Existing V1/V2 activation and rollout gates stay shut.
- Browser restarts are graceful process shutdowns and controlled tab closures/
  transaction aborts. Sudden OS termination, power loss, eviction, WebKit and actual
  iPhone Safari/Home Screen storage and lifecycle behavior are untested.
- Accidental legacy edits after transfer still require capture and explicit
  reconciliation. Already-overwritten old edits cannot be recovered from no evidence.

On the iPhone, validate source-context identity (Safari vs Home Screen), complete
capture of actual databases and image records, file save/reopen/import, available
space and peak memory, image rendering, background/foreground, force-close/relaunch,
quota behavior, journal replay and recovery holds, and controlled latest-state
rollback. Desktop functionality remains unchanged and must continue to be checked
when any future app integration is proposed.

## Run

Dependencies are deliberately outside the checkout; no package manifest or lockfile
changes are required. The runner's name/location keeps it out of default Node tests.

```sh
npm install --prefix /tmp/taskpoints-boundary-tools --cache /tmp/taskpoints-npm-cache --no-audit --no-fund playwright@1.56.1
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules BOUNDARY_CHROMIUM_PATH=/usr/bin/chromium node --test --test-timeout=45000 experiments/v2-transfer-roundtrip/run-browser.cjs
```

Use an installed Chromium path via `BOUNDARY_CHROMIUM_PATH`. The tests create and
remove their own temporary profile/package files and never access user profiles.
They do not require real data, network services, credentials, or a V2 deployment.
