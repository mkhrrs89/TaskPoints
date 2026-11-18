# Capture-only TaskPoints entry — synthetic engineering proof

Branch: `experiment/v2-transfer-roundtrip`, draft PR #1004, based on V2 commit
`44b7cc1e0b5b8acab3bfd80dd7e31a5f5ed93643`.

## Outcome and scope

A selected synthetic Home request can produce the existing complete lossless
transfer package without loading ordinary TaskPoints HTML or its startup writers.
Unselected requests delegate unchanged to the original worker. This is a local
engineering proof, not a deployed capture feature or permission to read real data.

**Delivery into the already-installed production iPhone app remains BLOCKED.**
This milestone demonstrates the new entry when it is actually served; it cannot
force already-running, cached or restored old documents to execute that entry.
No Safari tab, new origin or newly installed app is substituted for the existing
TaskPoints Home Screen storage context.

## Minimal implementation

`entry-worker.mjs` is an opt-in experimental worker entry that imports the unchanged
root `_worker.js`. It is NOT referenced by production deployment configuration.
`entry-router.mjs` selects `/?tp_capture=synthetic-v1` or
`/index.html?tp_capture=synthetic-v1` on localhost only, and requires the explicit
`CAPTURE_EXPERIMENT=synthetic-only` test setting. It serves capture HTML directly
from assets before the ordinary worker/boot transformer can emit index HTML,
preloads, or startup scripts. Invalid selectors, unavailable capture HTML, disabled
mode and non-localhost requests refuse; none falls back to normal startup.

Without the selector, the same request, environment and context objects go to
`normalWorker.fetch`; its response is returned unchanged. No root application file,
existing worker, `_routes.json`, HTML entry, V1 writer, existing test or safeguard
was edited. All changes are under `experiments/`. There is no production flag to
turn on, no deployed route and no V2 activation.

The capture document contains only a read-only guard, the existing
`v2-transfer-roundtrip/transfer.js`, and a small capture/download/reopen interface.
It does not load TaskPointsCore, the bootstrap, toolbar, maintenance, compaction,
recovery or V2 runtime. The restore API is removed from the capture window's public
interface. CSP disallows connections, frames and workers; the response is no-store.
Existing service-worker evidence blocks capture. Captured session strings remain
archive evidence, not active recovery markers in a new destination.

The page guard rejects local/session storage methods and property mutations, IDB
write transactions/creation/upgrades/deletion, cursor/store writes, cookie setters,
CacheStorage mutations and service-worker registration. Even a caught write attempt
poisons package readiness. This guards accidental writers in this new document;
it is not a security boundary against other tabs or retained native references.
Independent test instrumentation and native before/after snapshots detect such
bypassed writes too; a negative calibration test proves the detector fails.

The only shared transfer changes expose its existing validator as `verifyPackage`
and observe transaction completion and read failures together (avoiding an unhandled
abort rejection). The package format/codec/import protections are unchanged.
The prior realistic fixture was moved verbatim into `seed-taskpoints.cjs` so both
suites use the same actual serializer, shadow migration and Habit writer output.

## Capture, interruption and independent verification

The source is not repaired, normalized, replayed, compacted or cleared. Malformed
journals, holds and recovery evidence are copied byte-for-byte as archives; a valid
copy does not certify safe application startup or authorize automatic recovery.

The canonical `taskpoints_v1` key must exist. An empty/wrong context cannot silently
export an empty package. Presence is a prerequisite, not proof of correct context
identity or healthy data. Missing canonical state is a blocker, never an invitation
to select a backup. Unsupported structured-clone values, auto-increment stores,
missing catalogs, reserved control-DB collisions and the original size limits still
refuse. There is no count-only, omission or lossy fallback.

The reused exporter compares two complete captures; the entry validates the result
and compares a third capture after hashing. Observed changes refuse. Repeated reads
are NOT one atomic cross-database snapshot and cannot detect every write/change-back
race. Other clients must eventually be deliberately retired/quiesced; the earlier
failed old-client proof and unresolved safety requirement are preserved.

Cancel, backgrounding, page closure and returning from the back/forward cache clear
export readiness. Cancellation releases the UI promptly even if a read/hash stalls;
pending readonly work may finish, but its result cannot be released. Nothing is
persisted as an export-success marker. Restart requires a fresh capture. Current-tab
sessionStorage survives a same-tab reload but may disappear when the tab itself is
closed; the code does not invent it. Saved packages must be retained outside the
source before any future session retirement.

Tests reopen an actual downloaded file, independently hash its raw body with Node
crypto, restore through the existing protected importer into a separate synthetic
origin, then compare native localStorage and every native IDB schema/key/value/image
byte to a source baseline. `native-snapshot.cjs` does not call the package codec or
application normalization. The immutable original and archived session strings are
also checked. No source import is performed. A checksum proves internal integrity,
not authenticity or completeness of a separately rewritten/rehashed package without
the trusted original/source baseline.

## Coverage and actual results

All current 11 TaskPoints DB layouts / 34 stores are represented, including live and
orphan image Blobs, real compressed snapshot and shadow output, pending Task/Habit/
Player/Flex/Inbox journals, backup envelopes, vault/secondary records, malformed
recovery evidence, 76 inventoried literal keys, dynamic sidecars, unknown keys/fields
and session evidence. An additional unknown database/binary-record test verifies
capture is not limited to an inventory allowlist. These are synthetic records only.

**34 final capture-entry tests, 3 adapter module-graph checks, and all 60 existing
transfer regressions passed (97 distinct passing experiment checks).**
Results are recorded in `results.tap`, `worker-results.tap` and `transfer-regressions.tap`. The latter is
the earlier combined run (32 initial entry tests plus all 60 existing transfer tests);
`results.tap` supersedes its entry portion with the final expanded entry suite.
The adapter checks load the actual unchanged V1 worker module graph. Node records
Cloudflare HTMLRewriter handler requests without executing the platform HTML rewrite;
this checks delegation and matching responses, not deployed Cloudflare behavior.
No existing assertions were weakened. A first-run new test polling an unset global
was corrected to poll `window.__digestWaiting`; no application change was needed.

Existing worker/startup checks: **10 passed, 1 failed**. The failed
`home_boot_splash_recovery.test.js` source-text assertion expects
`id = 'tp-boot-wait-notice'`; it also fails on an independent temporary export of
unchanged V2 base `44b7cc1e` (2 pass, 1 fail). It is unchanged and not hidden.
See `startup-regressions.txt` for compact evidence. This task does not certify all
ordinary application behavior; preservation is also established by the unchanged
production source and exact pass-through branch.

Node 22.23.5, Playwright 1.56.1, Chromium 156.0.8078.79 on Linux. No actual iPhone,
Cloudflare deployment, network production origin or real storage context was tested
in this milestone. The owner's prior physical-iPhone observations apply to the
standalone synthetic harness, not this new full-package entry path.

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules node --test --test-timeout=180000 experiments/v2-capture-entry/run-browser.cjs
node --experimental-vm-modules --test experiments/v2-capture-entry/run-worker.cjs
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules node --test --test-timeout=240000 --test-concurrency=1 experiments/v2-transfer-roundtrip/run-browser.cjs experiments/v2-transfer-roundtrip/run-taskpoints.cjs
```

## Existing iPhone app delivery: exact blocker and next step

The repository's Home HTML runs boot code before most app modules; the current
worker also rewrites/preloads it. A script added after normal startup is too late.
A new capture URL only helps once the fresh server-selected document actually
replaces the current document **inside the same existing Home Screen context**.
Same origin alone does not establish that context, as the owner's Safari/Home Screen
Storage IDs differed. Existing installed start URL, cache/session restoration and
possible live service-worker behavior have not been inspected or altered here.

Two negative tests make the limits concrete:

- Navigating a synthetic existing document preserves durable same-tab storage but
  loses an unsaved form value. A read-only package cannot reconstruct that value.
- Serving stale HTML at the capture URL can run the ACTUAL legacy Habit writer
  before any new capture guard exists. A selector or a fresh-server no-store header
  cannot retroactively control old code already delivered/restored by the browser.

Therefore **do not reload, update, navigate, close or retire the real app as part of
this experiment**. An entry control is intentionally not added to the live UI and
there is no deep link that claims to bypass these problems. Final safety approval,
production delivery and real-data capture remain separate decisions.

The next bounded prerequisite is an **existing-session handoff/delivery rehearsal**:
prove on an already-installed synthetic TaskPoints-shaped app that an owner-confirmed
saved-work checkpoint and in-app same-context navigation reach a fresh capture entry,
with stale-document detection and no unaccounted writer/unload effects. Specify how
that control would reach the already-open app; an update/reload must not be assumed
safe. Any hosting/deployment or real-context check needs separate approval. If a
Mac-free handoff cannot be proved, report that limitation rather than sending the
owner to Safari. A separately authorized Web Inspector approach is a possible
alternative, not something accessed or promised here.

Once delivery/context and source-quiet conditions are validated and approved, a
verified real working copy can be captured for an isolated V2 environment. The
first actual V2 Task action is after that gate; no Task migration begins here.
