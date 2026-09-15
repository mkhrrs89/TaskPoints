from pathlib import Path

path = Path('state_runtime_v2.js')
text = path.read_text()
old = '    return [...v2Only, ...merged];'
new = '    return clone([...v2Only, ...merged]);'
if old not in text:
    raise SystemExit('V2 compatibility completion merge return target not found')
text = text.replace(old, new, 1)
path.write_text(text)
