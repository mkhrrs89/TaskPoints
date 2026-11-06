const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routes = JSON.parse(fs.readFileSync(path.join(root, '_routes.json'), 'utf8'));
const worker = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');
const bootGate = fs.readFileSync(path.join(root, 'mobile_boot_gate.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('both Home URLs invoke the existing Cloudflare startup coordinator', () => {
  assert.equal(routes.version, 1);
  for (const entry of ['/', '/index.html']) {
    assert.ok(routes.include.includes(entry), entry + ' must invoke the worker');
    assert.ok(!routes.exclude.includes(entry), entry + ' must not bypass the worker');
  }
  for (const existing of ['/scoring_core.js', '/audit.html', '/matchups.html', '/settings.html']) {
    assert.ok(routes.include.includes(existing), existing + ' was not removed');
  }
  assert.match(worker, /isHomePagePath\(url\.pathname\)/);
  assert.match(worker, /transformHomeBoot\(response\)/);
  assert.match(bootGate, /element\.after\(COORDINATOR_SCRIPT/);
  assert.match(bootGate, /element\.append\(SETTINGS_COLLAPSE_SCRIPT \+ RUNTIME_LOADER_SCRIPT/);
  assert.match(bootGate, /element\.setAttribute\('data-tp-boot-deferred'/);
});

test('stalled deferred startup still exposes Recovery instead of a silent splash', () => {
  assert.match(bootGate, /isRevealed\(\) \{ return revealed; \}/);
  assert.match(home, /const deferredRuntimePending = Boolean\(/);
  assert.match(home, /if \(!revealAccepted \|\| deferredRuntimePending\)/);
  assert.match(home, /bootRecoveryTimer = setTimeout\(releaseStalledSplash, 6500\)/);
  assert.match(home, /link\.href = 'emergency_recovery\.html'/);
});
