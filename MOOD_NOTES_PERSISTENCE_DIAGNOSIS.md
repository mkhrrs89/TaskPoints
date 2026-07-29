# Mood Notes persistence diagnosis

The Notes page was behaving like a writer even during a read-only visit:

- `loadNotes()` synchronized General Notes by rebuilding and rewriting the full `taskpoints_v1` snapshot.
- `beforeunload`, `pagehide`, and hidden visibility events called `saveNotes(true)` even when the General Notes textarea had not changed.
- The Mood Notes tab itself is read-only, but those unrelated full-state writes could promote an older completion snapshot over a recently edited `moodNotes` value.

The implementation in this branch changes General Notes synchronization to a field-level `saveAppState({ notes })` patch against current authoritative storage and tracks a dirty flag so page exit is a no-op unless General Notes actually changed. Mood Notes rendering remains read-only.
