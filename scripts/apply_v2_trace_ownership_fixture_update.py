from pathlib import Path

path = Path('tests/state_runtime_v2_hot_snapshot_device_evidence_contract.test.js')
text = path.read_text()
old = "    lastParity: { checked: true, match: true },"
new = "    lastParity: { checked: true, match: true, comparisonScope: 'habit_records_plus_habit_vice_completions_normalizing_full_fraction', scopeExcludedCounts: { expectedCompletions: 6, actualCompletions: 0 } },"
if old not in text:
    raise SystemExit('hot snapshot baseStatus parity fixture not found')
text = text.replace(old, new, 1)
path.write_text(text)
