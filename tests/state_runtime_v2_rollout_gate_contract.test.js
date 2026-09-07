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

const STEP4_COMMAND = 'node --test tests/state_runtime_v2_perf_contract.test.js';

test('V2-22 branch CI gates focused V2 contracts and regressions against live current main', () => {
  assert.match(workflow, /branches:\s*\n\s*- arch\/state-runtime-v2-plan/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.ok(workflow.includes(STEP4_COMMAND), 'Step 4 performance contract must remain an explicit gate');
  assert.match(workflow, /Run V2 core storage contracts/);
  assert.match(workflow, /Run V2 Habit mutation contracts/);
  assert.match(workflow, /Run V2 lifecycle and rollout contracts/);
  assert.match(workflow, /Prepare live current-main baseline worktree/);
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /git worktree add --detach \/tmp\/taskpoints-main origin\/main/);
  assert.match(workflow, /Compare individual test failures with live current main/);
  assert.match(workflow, /main-failures\.txt/);
  assert.match(workflow, /NEW_V2_REGRESSION/);
  assert.match(workflow, /Fail rollout gate on new V2 regressions/);
  assert.match(workflow, /Run full TaskPoints test suite as supplemental diagnostic/);
  assert.match(workflow, /timeout[^\n]*npm test/);
  assert.match(workflow, /continue-on-error:\s*true/);
  assert.equal(packageJson.scripts?.test, 'node --test');
  assert.match(baselineFailures, /DEPRECATED REFERENCE ONLY/);
  assert.match(baselineFailures, /no longer\s+uses this list/i);

  const installAt = workflow.indexOf('run: npm ci');
  const step4At = workflow.indexOf(STEP4_COMMAND);
  const coreAt = workflow.indexOf('Run V2 core storage contracts');
  const liveMainAt = workflow.indexOf('Prepare live current-main baseline worktree');
  const individualAt = workflow.indexOf('Compare individual test failures with live current main');
  const fullAt = workflow.indexOf('Run full TaskPoints test suite as supplemental diagnostic');
  const regressionGateAt = workflow.indexOf('Fail rollout gate on new V2 regressions');
  assert.ok(
    installAt >= 0
      && step4At > installAt
      && coreAt > step4At
      && liveMainAt > coreAt
      && individualAt > liveMainAt
      && fullAt > individualAt
      && regressionGateAt > fullAt,
    'live-main regression gate must run after dependencies, focused V2 contracts, current-main collection, branch diagnostics, and supplemental full suite'
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
