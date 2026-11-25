# Synthetic iPhone storage-capture milestone

Physical-device update: [owner-reported iPhone results and the next bounded task](DEVICE-RESULTS.md). All eleven reported checks succeeded; these are separate from automated test results.

Standalone experiment on `experiment/v2-transfer-roundtrip`, for draft PR #1004.
Nothing imports TaskPoints application code or activates V2. No deployment or real
TaskPoints data access is authorized by this milestone. The previous transfer and
old-client experiments remain unchanged.

## What is ready

`site/` is a small, independent static website with an install manifest, iPhone
Home Screen metadata/icon, touch-sized controls, and on-screen diagnostics. It
requires an online connection to open/reopen: there is intentionally no service
worker or offline cache. It runs locally on localhost/127.0.0.1 for automation.

For HTTPS, it refuses to access storage until `config.js` names the exact approved
origin and that host starts with `tp-synthetic-capture-`. The checked-in setting is
now configured for the proposed `https://tp-synthetic-capture-taskpoints.pages.dev`
hostname at the owner's request; Cloudflare has not yet confirmed it. See
[manual upload instructions](MANUAL-UPLOAD.md) before uploading. Deploy only the contents of `site/` at the root of a **new,
dedicated HTTPS origin**, never the TaskPoints project/origin or a path underneath it. Do not deploy
the repository root, its worker, or any application files. The supplied `_headers`
contains no-store and security headers for hosts supporting that format; verify
those headers on the chosen host. There are no external scripts, analytics,
network uploads, application cookies, or dependencies in this website.

The page creates exactly:

- Three labeled localStorage strings: identity, synthetic note, synthetic pending
  edit. Identity includes a random Storage ID, creation time and initial mode.
- One database (`tp_synthetic_capture_v1`, version 1) with explicit-key `records`
  and `images` stores; two synthetic data/recovery records and one Blob image.
- A teal/gold checkerboard whose exact PNG bytes are known in advance. Unknown
  example fields and deliberately malformed recovery evidence are synthetic too.

Only **Create or resume synthetic records** writes storage. It uses a cooperative
browser lock, never replaces existing values, and fills absent expected records
on retry. Interrupted creation is visibly incomplete and cannot be exported.
Unexpected, changed, incompatible or orphaned records are preserved and refused;
there is deliberately no erase/reset/repair button.

Capture uses readonly database transactions and localStorage reads. It checks the
complete fixture three times, including after hashing, and offers a package only
when complete and unchanged during those checks. It never compacts/replays journals,
clears locks, creates backup markers or registers a service worker. Unrelated
localStorage keys, session storage, databases or workers cause refusal; unrelated
DB contents are not opened. Missing enumeration/Web Locks/crypto support also
refuses, without a weaker fallback. This is an accidental-use guard, not a security
boundary against someone modifying the code or the hosting configuration.

The export is a **separate, fixed synthetic-only test format**,
`tp-iphone-synthetic-capture-1`, limited to 64 KiB. It is not a production TaskPoints
backup or the earlier general transfer package/importer. It exercises the mobile
capture/save/reopen workflow without granting a general-purpose origin exporter
access to arbitrary records. Verification checks SHA-256, schema, identity, every
record and the exact image bytes; it also decodes the image. Checksums detect damage,
not malicious authorship. Files are never imported. A valid file verifies even in
an otherwise empty test context, without restoring anything there.

Export readiness is memory-only. Cancel, page closure, backgrounding during capture
and a return from the back/forward cache revoke readiness. There is no persisted
success marker to trust after interruption. Download/Share alone is not counted as
saved-file success: the owner must choose the saved file and get a separate PASS.
Native sharing is invoked directly from the user click for iOS compatibility; if
file sharing is unavailable, Download remains available. Actual iOS behavior still
needs device testing. A backgrounded share may require preparing the export again.

## Exactly how to test on your iPhone after approved deployment

No Mac or console is needed. Use only the new test website, not TaskPoints.

1. Record your iOS version and the approved test URL. In Safari, open that URL.
   Confirm **SYNTHETIC DATA ONLY · BUILD 1**, the expected website, and
   **Safari / browser**. Tap **Create or resume synthetic records**. Expect PASS,
   the checkerboard and a Storage ID. Save that ID in Notes or take a screenshot.
2. In Safari use **Share → Add to Home Screen**, enabling **Open as Web App** if
   your iOS version offers it. Launch the new *Synthetic Capture* icon. Confirm
   **Home Screen** and the same website. Do not use an ordinary Safari tab as a
   substitute for this step.
3. Tap **Check records**. If empty, create this context's synthetic records. Record
   its Storage ID and **Records first created in** label. Enter Safari's ID under
   **Compare IDs**. Same IDs mean shared *or copied* fixture identity; different
   IDs mean different fixture identities. Either is a valid observation, not an
   automatic pass/fail judgment about iOS isolation. Check Safari again and record
   both results. Installation may copy an initial snapshot; matching IDs alone
   cannot prove continuing shared storage.
4. In the Home Screen app, tap **Prepare synthetic export**. Expect PASS and a
   download link. Use **Share / Save to Files** if offered, or **Download** and
   Safari/iOS's file-saving UI. Do not assume the file saved successfully yet.
5. Under **Reopen and verify**, choose that file from Files. Expect PASS for the
   checksum, all records and image bytes. The reported Storage ID must match the
   captured context. Tap **Check records** again; it should still show the same ID
   and complete fixture. Repeat capture/save/reopen in Safari and compare IDs in
   both saved-file reports. You may verify either file in either test context;
   verification does not import or merge it.
6. Start another capture and immediately tap **Cancel capture**. No download should
   remain. Retry to get PASS. Repeat by switching to another app during the capture
   window, then returning. An interrupted capture must offer no package. If capture
   completed before you switched, repeat quickly enough to interrupt it.
7. Start a capture and force-close the test app, then relaunch it while online.
   No earlier export should be ready. Check the unchanged Storage ID and complete
   fixture, then prepare/save/reopen again. Reopen the earlier saved file too.
8. Report the two Storage IDs, both mode labels, same/different comparison,
   capture/reopen results, interruption/relaunch results, and any FAIL message.
   If a safe API is unsupported or any check fails, stop at that result; do not
   clear website storage, weaken checks or switch to the TaskPoints origin.

Real device quota and eviction are additional limits, not something to test by
filling your iPhone's storage. Desktop tests inject quota/abort/dropped-write
failures. A small fixture does not measure real-data capacity or power-loss durability.

## What this proves, and what it does not

Automation proves the fixed synthetic fixture round-trips through a saved file,
source capture does not call storage writers, unsupported/incomplete data is refused,
and controlled interruptions cannot leave a reusable success marker. A passing
phone run adds evidence for that iOS version's installation, context observations,
image decoding, file picker/sharing and lifecycle behavior on **this new origin**.

It does not prove that a new website can read TaskPoints; browser origin isolation
prevents that. It does not establish which historical Safari/Home Screen partition
contains real TaskPoints data, enumerate those real databases, quiesce the live
app's background writers, capture unsaved forms, validate large exports, certify
recovery fallback, or retire old sessions. Repeat reads detect observed changes,
not every write-and-change-back race or one atomic instant across storage systems.
The test's same-origin cooperative lock does not control old TaskPoints clients.

Real source capture would still need a separately approved mechanism executing in
TaskPoints' actual existing Home Screen context (plus source-quiet/session-retirement
procedures). This synthetic in-page UI demonstrates a Mac-free workflow on its own
site; it does not provide such access to the production app. The original old-client
safety requirement remains unresolved until the replacement procedure is fully
validated and you explicitly approve its final change.

## Automated validation

`run-browser.cjs` serves only `site/` from an ephemeral loopback server and uses a
fresh browser profile at 390×844. Playwright 1.56.1, Node 22.23.5, Chromium
156.0.8078.79 on Linux. These are not iOS/WebKit tests. Standalone mode, native share
and visibility transitions are simulated where called out in the test names.
**32 tests passed; 0 failed, cancelled or skipped.** See `results.tap` for individual cases. `mobile-preview.png` is a
Chromium layout screenshot, not an iPhone screenshot.

```sh
NODE_PATH=/tmp/taskpoints-boundary-tools/node_modules BOUNDARY_CHROMIUM_PATH=/usr/bin/chromium node --test --test-timeout=180000 experiments/iphone-synthetic-capture/run-browser.cjs
```

The runner needs the external Playwright installation already used by the earlier
experiment. No application dependencies, existing tests or protections are changed.
For local manual review only, serve `site/` on a dedicated localhost port, for example:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory experiments/iphone-synthetic-capture/site
```

## Next specific action — source capture entry proof

The owner reports successful physical-iPhone testing; see
[the recorded observations](DEVICE-RESULTS.md). Manual-upload instructions remain
available as historical packaging guidance. The next recommended implementation
is a capture-only entry path for the existing TaskPoints Home Screen context,
proved with synthetic TaskPoints storage before any production delivery or access.
No new deployment, live data capture, V2 activation or safety relaxation is approved.
