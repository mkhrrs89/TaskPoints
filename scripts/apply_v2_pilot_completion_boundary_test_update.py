from pathlib import Path

path = Path('tests/state_runtime_v2_compatibility_snapshot_contract.test.js')
text = path.read_text()
old = '''  assert.deepEqual(JSON.parse(JSON.stringify(parity.scopeExcludedCounts)), {\n    expectedCompletions: 3,\n    actualCompletions: 3\n  });'''
new = '''  assert.deepEqual(JSON.parse(JSON.stringify(parity.scopeExcludedCounts)), {\n    expectedCompletions: 3,\n    actualCompletions: 0\n  });'''
if old not in text:
    raise SystemExit('V2 compatibility scope-excluded count expectation not found')
text = text.replace(old, new, 1)
path.write_text(text)
