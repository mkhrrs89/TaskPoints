from pathlib import Path

path = Path('index.html')
html = path.read_text(encoding='utf-8')
old = '''  // Failsafe in case the compositor animation cannot complete. Always settle
  // the visible title before revealing Home so random glyphs never leak through.
'''
new = '''  // failsafe in case the bootstrap cannot complete
  // If the compositor animation stalls, settle the visible title before revealing Home.
'''
if new not in html:
    if old not in html:
        raise SystemExit('Could not locate revised boot failsafe comment')
    html = html.replace(old, new, 1)
path.write_text(html, encoding='utf-8')
