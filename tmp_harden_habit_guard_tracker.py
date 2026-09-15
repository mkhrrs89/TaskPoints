from pathlib import Path

path = Path('habit_completion_source_guard.js')
text = path.read_text()
old = """    // If no observable authoritative revision changed, only keep an existing
    // tracker when its completion count is still exactly unchanged. Any
    // uncertain completion mutation falls back to a full read on the next save.
    const rows = Array.isArray(resultState?.completions) ? resultState.completions : null;
    if (!trackerBefore || !rows || rows.length !== trackerBefore.count) invalidateCompletionTracker();
    return result;
"""
new = """    // No observable authoritative revision changed. Do not infer that the
    // completion identity set is still current from count alone; fail closed so
    // the next save uses the original full previous-state check.
    invalidateCompletionTracker();
    return result;
"""
if old not in text:
    raise SystemExit('tracker fallback block not found')
path.write_text(text.replace(old, new, 1))
