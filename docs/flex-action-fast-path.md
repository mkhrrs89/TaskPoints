# Flex Action fast path

Flex Action checkmarks now update the tapped row immediately instead of waiting for the full TaskPoints snapshot save and full home-page render.

## Input path

1. Write the completed Flex Action to the small `taskpoints_pending_flex_completions_v1` crash-safe journal.
2. Add the completion to the current in-memory state and paint the new orange dot immediately.
3. After the browser has had a chance to paint, save the full TaskPoints snapshot using the existing interactive packed-save path.
4. Clear only journal entries whose completion IDs are verified in the authoritative saved snapshot.
5. Run the normal full home-page render afterward so every dependent score and summary remains current.

Rapid taps are coalesced into one background snapshot save. Pending entries are replayed during app loading and flushed during page hiding, exports, and reset-related save flushes.

The existing recovery locks remain authoritative. A Flex Action journal write is refused while confirmed-recovery or active-recovery-attempt protection blocks the page from writing.
