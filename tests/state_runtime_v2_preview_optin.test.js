const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_v2_preview_enable.html'), 'utf8');
const generationSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_generation.js'), 'utf8');

test('V2 preview opt-in is explicitly blocked on production hostnames', () => {
  assert.match(source, /taskpoints\.pages\.dev/);
  assert.match(source, /productionHosts\.has\(hostname\)/);
  assert.match(source, /localStorage\.removeItem\(KEY\)/);
  assert.match(source, /Nothing was enabled/);
});

test('V2 preview opt-in only persists the dark flag on preview or localhost origins', () => {
  const hostGuard = source.indexOf("hostname.endsWith('.taskpoints.pages.dev')");
  const setFlag = source.indexOf("localStorage.setItem(KEY, '1')");
  assert.ok(hostGuard >= 0, 'preview hostname guard must exist');
  assert.ok(setFlag > hostGuard, 'flag write must happen only after preview hostname guard');
});

test('V2 preview opt-in can enable the existing perf tracer in the same preview session', () => {
  assert.match(source, /const PERF_KEY = 'tp_perf_trace_enabled_v1'/);
  assert.match(source, /params\.get\('perf'\)/);
  assert.match(source, /sessionStorage\.setItem\(PERF_KEY, '1'\)/);
  const productionGuard = source.indexOf('productionHosts.has(hostname)');
  const perfWrite = source.indexOf("sessionStorage.setItem(PERF_KEY, '1')");
  assert.ok(perfWrite > productionGuard, 'performance tracing must not be enabled before the production-host guard');
});

test('V2 preview opt-in carries a one-time Home bootstrap signal across redirect', () => {
  assert.match(source, /homeParams\.set\('v2dark', '1'\)/);
  assert.match(source, /location\.replace\('\/\?' \+ homeParams\.toString\(\)\)/);
  assert.match(generationSource, /params\.get\('v2dark'\)/);
  assert.match(generationSource, /safeSet\(DARK_MODE_KEY, '1'\)/);
  assert.match(generationSource, /previewQueryBootstrap = true/);
});

test('Home-side V2 bootstrap independently blocks production and non-preview origins', () => {
  const productionGuard = generationSource.indexOf('productionHosts.has(currentHostname)');
  const queryBootstrap = generationSource.indexOf('function bootstrapFromPreviewQuery()');
  const guardedDarkWrite = generationSource.indexOf("safeSet(DARK_MODE_KEY, '1')", queryBootstrap);
  assert.ok(productionGuard >= 0, 'Home bootstrap must have production host guard');
  assert.ok(guardedDarkWrite > productionGuard, 'Home query bootstrap dark write must occur only after production guard');
  assert.match(generationSource, /if \(!previewHost && !localHost\) return false/);
  assert.match(generationSource, /safeRemove\(DARK_MODE_KEY\)/);
});

test('dedicated V2 architecture preview is forced on without depending on redirect storage persistence', () => {
  assert.match(generationSource, /const FORCED_PREVIEW_HOST = 'arch-state-runtime-v2-plan\.taskpoints\.pages\.dev'/);
  assert.match(generationSource, /hostname\(\) === FORCED_PREVIEW_HOST/);
  assert.match(generationSource, /bootstrapForcedPreviewHost\(\)/);
  assert.match(generationSource, /isForcedPreviewHost\(\) \|\| safeGet\(DARK_MODE_KEY\) === '1'/);
  assert.match(generationSource, /stateV2\.previewForcedEnabled/);
});
