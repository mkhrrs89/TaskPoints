# Inbox preservation during Home startup

## Reproduction and cause

The updated browser test opens the real Inbox page with a synthetic matchup and
score. `TaskPointsInbox.populate()` generates its actual Top-50 score message.
The test verifies the pending journal and waits for normal compaction to persist
the message and processed-event ID. It then copies those canonical bytes to a
fresh disposable profile with no verified native snapshot. This exercises Home's
normal localStorage startup when the day's matchup is still missing.

The positive preservation assertion fails on the prior experimental commit
`7ecd2379`. The recorded write goes from `maybeAutoSimToday()` to
`simulateToday()`, `save()`, `saveStateSnapshot()` and
`safeReplaceTaskPointsStorage()`. Home's `load()` builds a partial live state
that omits the Inbox fields. The startup snapshot writer used that state without
preserving canonical Inbox data. The stored message count went from one to zero.
These are synthetic results under that condition. Production storage and device
startup behavior were outside the test.

## Fix and verification

Routine snapshot saves preserve all four Inbox fields from the current canonical
snapshot, including empty lists and absent fields. Inbox producer merges and
verified journal compaction can still change the fields they explicitly supply.
The writer checks the observed source again before replacing the snapshot. This
uses the existing save boundary and keeps the startup simulation and storage
safeguards in place.

Pending Inbox edits and explicit empty-list deletions stay in the journal until
verified compaction. The processed-event ID survives deletion, preventing the
next producer scan from recreating the notification. Malformed or unknown
journal bytes stay intact. The existing fallback can add a message while those
bytes are retained, and the canonical guard refuses replacements that would
lose messages or processed-event evidence. A failed write over a valid pending
journal cannot fall back around that evidence.

The browser cases exercise actual creation, ordinary cold Home startup, pending
edits, save, reload, deletion, stale snapshots, and malformed-journal fallback.
The full suite also keeps the Inbox message in the unrelated-data comparisons
for the V2 Task experiment. See `real-inbox-before-fix.txt` and
`inbox-and-home-results.tap`. Earlier `base-inbox-results.tap` records the original
witness with the manually constructed fixture.

Validation passed with 19 full Home browser checks, 19 V2 component checks,
and 229 Inbox, storage, Task, and Home regression checks.
