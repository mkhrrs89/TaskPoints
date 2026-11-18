# Physical iPhone results — user observations

Reported by the owner in chat on November 18, 2026. These are user-observed
results on a physical iPhone, not automated tests or observations independently
made by the assistant. No production TaskPoints data was supplied or inspected.

## Reported results

| Check | User-observed result |
| --- | --- |
| Safari synthetic storage | Created and verified records and image successfully |
| Home Screen installation | Worked |
| Safari versus Home Screen identity | Different Storage IDs |
| Home Screen synthetic storage | Records and image verified successfully |
| Export to Files | Worked |
| Reopen saved package | Checksum, records and image verification passed |
| Force-close and relaunch | Records survived; Storage ID stayed the same |
| Cancel capture | Incomplete package correctly refused |
| Retry capture | Succeeded |
| Force-close with an export prepared | Export readiness cleared |
| Reopen previously saved file after relaunch | Verification passed again |

All eleven reported checks succeeded. Exact device model, iOS version, final
hostname, Storage IDs, and deployed artifact checksum were not included in this
report. Do not infer those details or claim the deployed bytes were independently
verified. No new device test or production inspection is required merely to record
these observations.

## Separate automated evidence

The original Chromium harness run recorded 32 passing tests (`results.tap`). The
subsequent manual-upload package run recorded 33 passing tests
(`manual-upload/package-tests.tap`), including exact-origin refusal. Those are
Linux/Chromium results. The observations above add physical-device evidence; they
do not change the automated counts. No tests were rerun for this documentation-only
update, and no uploaded website assets or ZIP bytes were changed.

## What this establishes

The owner successfully exercised installation, synthetic storage and image reads,
export/save/reopen, cancellation, retry and lifecycle behavior in the tested iPhone
contexts. Different Storage IDs establish different fixture identities in Safari
and the installed app; do not generalize this into a universal partitioning guarantee
or assume Safari can access the existing TaskPoints Home Screen app's data.

This does not validate real TaskPoints source access, historical databases, large
packages, live-writer quiescence, unsaved edits, full startup/recovery or V2 operation.
The synthetic file format remains distinct from the lossless TaskPoints transfer
package. The original old-client safety requirement remains unresolved until the
replacement procedure is fully validated and the owner explicitly approves it.

## Recommended next ONE implementation task

**Build a capture-only entry path intended for the existing TaskPoints Home Screen
app, and prove it against synthetic TaskPoints storage before any deployment.**

This should reuse the existing lossless transfer-package capture/verification logic,
not introduce another general preview system or start migrating Task features.
Its purpose is to prepare a safe way out of the existing app's actual storage context;
a separate test website or a new Safari tab cannot provide that access.

Bounded acceptance criteria:

1. Prepare the entry path on the experimental branch with an isolated test fixture.
   Capture mode runs inside the app context before ordinary startup, maintenance,
   journal compaction or recovery writers. Ordinary V1 startup remains authoritative
   and unchanged when capture mode is not selected. No deployment or production
   navigation is part of this task.
2. Using only synthetic TaskPoints-shaped records, produce and independently verify
   the existing lossless package: all localStorage strings, IDB records/schema,
   image bytes, unknown fields, journals, backups and recovery evidence. Do not
   replay, repair, delete or silently omit source records. Preserve current-tab
   session evidence as an archive without activating it elsewhere.
3. Tests fail on any source storage write or unintended normal-startup writer during
   capture. Incomplete/unsupported data or observed source drift must refuse a ready
   package. Test interruption/restart and successful saved-file verification. Never
   claim repeat reads technically exclude uncooperative old tabs.
4. Deliver the isolated code, automated evidence and a narrowly specified future
   activation procedure for entering capture mode within the already-installed app.
   Explicitly address that reloading/updating the app can lose unsaved forms or start
   old maintenance code; do not assume a fresh same-origin tab solves this. Any
   unsolved delivery/context problem is a blocker, not a reason to export from Safari.

Finish line: a reviewed, synthetic-only proof that the actual app entry path can
produce the full package without running its usual writers. The next approval would
be for any production delivery/context check and eventual real-data capture; none
is granted here. This prerequisite gets us toward importing a verified working copy
into isolated V2 and then implementing the first genuine Task action. V2 activation,
feature migration, deployment and real-data access remain outside this milestone.
