from pathlib import Path

path = Path('tests/phase4_primary_cache_warmup_contract.test.js')
text = path.read_text(encoding='utf-8')
old = """  async function drain() {
    while (microtasks.length) microtasks.shift()();
    await Promise.resolve();
    await Promise.resolve();
  }
"""
new = """  async function drain() {
    while (microtasks.length) microtasks.shift()();
    await Promise.resolve();
    await core.warmPhase4PrimaryCache?.('test_drain');
    await Promise.resolve();
  }
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one drain helper, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
