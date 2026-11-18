# Existing Inbox startup loss

**Inbox record preservation is still unproven and blocks a full-Home data safety
claim.** A synthetic Inbox message is verified in `taskpoints_v1` immediately
before Home startup. The ordinary startup save then replaces the canonical
snapshot with one that omits the message. The V2 fixture marker is absent and
no V2 Task action has run.

The test captures the actual write stack through `saveStateSnapshot` and
`safeReplaceTaskPointsStorage`, including the existing Habit save wrapper. The
same test reproduced the omission on a temporary export of the untouched V2 base
`44b7cc1e`. This branch preserves that evidence and leaves the production Inbox
path as-is. The Task dates and receipts that passed acceptance do not resolve
this separate data-loss path.

The live witness is the `existing Home startup loses the seeded Inbox message`
case in `run-full-home.cjs`. Results are in `full-home-acceptance.tap` and the
independent `base-inbox-results.tap`. The checkpoint also refuses a malformed
Inbox journal rather than treating its pending data as empty.
