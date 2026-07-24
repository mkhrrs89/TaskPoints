# Phase 4 Preview Findings

## 2026-07-24 — sequence continuity and habit-journal retry

The first `verify_primary_writes` preview pass exposed two issues that did not affect production:

1. The in-memory Phase 4 sequence counter restarted after navigation or reload, allowing `latestQueuedSequence` to appear lower than an earlier passed sequence.
2. A habit save correctly deferred verification while the crash-safe habit journal was non-empty, but the journal clearing did not automatically queue a fresh verification. Some transient journal races were also being counted as verification failures.

Fixes:

- Each new sequence now resumes above persisted queued and passed diagnostics.
- Diagnostic sequence values are monotonic and queued can never display below passed.
- Clearing or removing the pending-habit journal automatically queues a fresh verified write.
- Expected transient deferrals are tracked separately from true verification failures.
- The status page displays both verification failures and deferred writes.

Regression coverage:

- Sequence continuity across page reloads.
- Automatic recovery after the habit journal clears.
- No verification-failure increase for expected habit-journal deferrals.

Validation after the fix:

- Phase 4 contract suite passed with the two new regression tests.
- Full repository test suite passed.
- Cloudflare branch preview deployed successfully.

Production and `main` remained unchanged throughout.
