from pathlib import Path

path = Path('tests/season_series_upset_reconciliation_loop.test.js')
text = path.read_text()
old = "test('Home reconciliation preserves derived sync while reusing the live Home state as preloaded input', () => {"
new = "test('Home reconciliation skips derived sync while reusing the live Home state as preloaded input', () => {"
if old not in text:
    raise SystemExit('Home reconciliation test title not found')
text = text.replace(old, new, 1)

start = text.index(new)
end = text.index("\ntest('superseded Home quiet reconciliation gates", start)
block = text[start:end]
old_assert = "  assert.equal(harness.loadCalls[0].syncDerived, true);"
new_assert = "  assert.equal(harness.loadCalls[0].syncDerived, false);"
if old_assert not in block:
    raise SystemExit('Home reconciliation syncDerived expectation not found')
block = block.replace(old_assert, new_assert, 1)
text = text[:start] + block + text[end:]
path.write_text(text)
