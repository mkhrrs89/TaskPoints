const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'state-runtime-v2-contracts.yml'), 'utf8');
const baselineFailures = fs.readFileSync(path.join(repoRoot, 'tests', 'state_runtime_v2_baseline_failures.txt'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const previewEnable = fs.readFileSync(path.join(repoRoot, 'state_v2_preview_enable.html'), 'utf8');
const runtime = fs.readFileSync(path.join(repoRoot, 'state_runtime_v2.js'), 'utf8');

const V2_COMMAND = 'node --test tests/state_runtime_v2*.test.js tests/perf_trace_v2_visibility_contract.test.js';

test('V2-22 branch CI gates focused V2 contracts and regressions beyond the recorded current-main baseline', () => {
  assert.match(workflow, /branches:\s*\n\s*- arch\/state-runtime-v2-plan/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.ok(workflow.includes(V2_COMMAND), 'focused V2 safety suite must remain an explicit gate');
  assert.match(workflow, /Diagnose individual TaskPoints test files against main baseline/);
  assert.match(workflow, /tests\/state_runtime_v2_baseline_failures\.txt/);
  assert.match(workflow, /NEW_V2_REGRESSION/);
  assert.match(workflow, /Fail rollout gate on new V2 regressions/);
  assert.match(workflow, /Run full TaskPoints test suite as supplemental diagnostic/);
  assert.match(workflow, /timeout[^\n]*npm test/);
  assert.match(workflow, /continue-on-error:\s*true/);
  assert.equal(packageJson.scripts?.test, 'node --test');
  assert.match(baselineFailures, /Snapshot of individual test-file failures observed on current main/);

  const installAt = workflow.indexOf('run: npm ci');
  const v2At = workflow.indexOf(V2_COMMAND);
  const individualAt = workflow.indexOf('Diagnose individual TaskPoints test files against main baseline');
  const fullAt = workflow.indexOf('Run full TaskPoints test suite as supplemental diagnostic');
  const regressionGateAt = workflow.indexOf('Fail rollout gate on new V2 regressions');
  assert.ok(
    installAt >= 0 && v2At > installAt && individualAt > v2At && fullAt > individualAt && regressionGateAt > fullAt,
    'baseline-aware regression gate must run after dependencies, focused V2 contracts, individual diagnostics, and the supplemental full suite'
  );
});

test('V2-22 rollout remains default-off and preview-only rather than silently becoming production authority', () => {
  assert.match(runtime, /const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1'/);
  assert.match(runtime, /function isDarkEnabled\(\)\s*{\s*return safeGet\(DARK_MODE_KEY\) === '1';/);
  assert.match(runtime, /readAuthority:\s*'legacy_only'/);
  assert.doesNotMatch(runtime, /readAuthority:\s*'v2'/);
  assert.doesNotMatch(runtime, /localStorage[^\n]*setItem[^\n]*DARK_MODE_KEY[^\n]*'1'/);
});

test('V2-22 preview opt-in explicitly blocks production hostnames before setting the V2 flag', () => {
  assert.match(previewEnable, /taskpoints\.pages\.dev/);
  assert.match(previewEnable, /www\.taskpoints\.pages\.dev/);
  assert.match(previewEnable, /productionHosts/);

  const productionGuardAt = previewEnable.indexOf('productionHosts.has(hostname)');
  const setFlagAt = previewEnable.indexOf("localStorage.setItem(KEY, '1')");
  assert.ok(productionGuardAt >= 0, 'production hostname guard must exist');
  assert.ok(setFlagAt > productionGuardAt, 'V2 flag must only be set after the production guard');
});
