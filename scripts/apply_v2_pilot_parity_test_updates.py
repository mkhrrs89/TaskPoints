from pathlib import Path

path = Path('tests/state_runtime_v2_compatibility_snapshot_contract.test.js')
text = path.read_text()

old_counts = '''  assert.equal(parity.expectedCounts.habits, 1);\n  assert.equal(parity.expectedCounts.completions, 5);\n  assert.equal(parity.actualCounts.habits, 1);\n  assert.equal(parity.actualCounts.completions, 5);'''
new_counts = '''  assert.equal(parity.expectedCounts.habits, 1);\n  assert.equal(parity.expectedCounts.completions, 2);\n  assert.equal(parity.actualCounts.habits, 1);\n  assert.equal(parity.actualCounts.completions, 2);\n  assert.deepEqual(JSON.parse(JSON.stringify(parity.scopeExcludedCounts)), {\n    expectedCompletions: 3,\n    actualCompletions: 3\n  });'''
if old_counts not in text:
    raise SystemExit('compatibility parity count expectations not found')
text = text.replace(old_counts, new_counts, 1)

old_strict = "completions: [{ id: 'c1', points: 4, __streak: 1 }]"
new_strict = "completions: [{ id: 'habit:h1:2026-09-12', source: 'habit', habitId: 'h1', dayKey: '2026-09-12', points: 4, __streak: 1 }]"
if old_strict not in text:
    raise SystemExit('strict completion fixture not found')
text = text.replace(old_strict, new_strict, 1)

old_many = "completions: Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, points: 4, title: 'Private original title' }))"
new_many = "completions: Array.from({ length: 4 }, (_, i) => ({ id: `habit:h${i}:2026-09-10`, source: 'habit', habitId: `h${i}`, dayKey: '2026-09-10', points: 4, title: 'Private original title' }))"
if old_many not in text:
    raise SystemExit('multi-completion parity fixture not found')
text = text.replace(old_many, new_many, 1)

path.write_text(text)
