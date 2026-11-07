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

test('a skipped or stalled Home splash respects the deferred runtime reveal gate', () => {
  const start = home.indexOf('<script id="tp-early-matrix-bootstrap">');
  const end = home.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start);
  const earlyBoot = home.slice(start, end);
  assert.ok(earlyBoot.includes('window.__tpCompleteBootView?.({ skipped: true })'));
  assert.ok(!earlyBoot.includes('    completeBootView({ skipped: true });'));
  assert.ok(earlyBoot.includes('deferredRuntimePending'));
  assert.ok(earlyBoot.includes('emergency_recovery.html'));
});

test('a missing required core script or Home state fails closed before Home is revealed', () => {
  assert.ok(bootGate.includes("source.split('?')[0].split('/').pop() === 'scoring_core.js'"));
  assert.ok(bootGate.includes('if (isRequiredCore) reject(new Error'));
  assert.ok(bootGate.includes('TaskPointsHomeLiveState?.getState'));
  const starter = bootGate.split('function startRuntime()')[1].split('function markFinalTitle()')[0];
  assert.ok(starter.includes('.then(() => {'));
  assert.ok(starter.includes('runtimeReady = true'));
  assert.ok(!starter.includes('.finally('));
});

test('both generated boot scripts parse as valid JavaScript', () => {
  const marker = 'export { isHomePagePath, transformHomeBoot };';
  const index = bootGate.lastIndexOf(marker);
  assert.ok(index >= 0);
  const source = bootGate.slice(0, index);
  const scripts = new Function(source + String.fromCharCode(10) + 'return [COORDINATOR_SCRIPT, RUNTIME_LOADER_SCRIPT];')();
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    const code = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
    assert.doesNotThrow(() => new Function(code));
  }
});
