#!/usr/bin/env python3
"""Build and verify a root-only Cloudflare Pages ZIP; never contact a host."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
SITE = ROOT / 'site'
NAMES = ('_headers', 'capture.js', 'config.js', 'icon.png', 'index.html',
         'manifest.webmanifest', 'style.css', 'ui.js')
OUT = ROOT / 'manual-upload'
assert set(p.name for p in SITE.iterdir()) == set(NAMES), 'Unexpected/missing site assets'
assert all((SITE / n).is_file() and not (SITE / n).is_symlink() for n in NAMES)
config = (SITE / 'config.js').read_text()
match = re.search(r"^window\.SYNTHETIC_CAPTURE_ORIGIN = '(https://tp-synthetic-capture-[a-z0-9-]+\.pages\.dev)';$", config, re.M)
assert match, 'Use one exact dedicated Pages origin; never broaden the origin guard'
origin = match.group(1)
assert json.loads((SITE / 'manifest.webmanifest').read_text())['start_url'] == './'
assert "frame-ancestors 'none'" in (SITE / '_headers').read_text()
assert "Cache-Control: no-store" in (SITE / '_headers').read_text()
OUT.mkdir(exist_ok=True)
archive = OUT / (origin.split('//', 1)[1].removesuffix('.pages.dev') + '.zip')
contents = {name: (SITE / name).read_bytes() for name in NAMES}
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, data in contents.items():
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, data)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None, 'ZIP integrity check failed'
    assert sorted(z.namelist()) == sorted(NAMES), 'Incorrect ZIP root'
    assert all('/' not in name and '\\' not in name for name in z.namelist())
    extracted = Path(tempfile.mkdtemp(prefix='tp-synthetic-upload-check-'))
    z.extractall(extracted)
    for name, data in contents.items():
        assert z.read(name) == data == (extracted / name).read_bytes()
report = {
    'configuredOrigin': origin,
    'hostnameConfirmedByCloudflare': False,
    'deployed': False,
    'zip': archive.name,
    'zipBytes': archive.stat().st_size,
    'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'files': {n: {'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()} for n, b in contents.items()},
    'checks': ['exact eight-file allowlist', 'no symlinks/directories', 'index.html at root',
               'exact dedicated Pages origin', 'no-store and frame protections retained',
               'ZIP CRC verification', 'all extracted bytes equal site assets'],
}
(OUT / 'package-verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'archive': str(archive), 'extractedSite': str(extracted), **report}, indent=2))
