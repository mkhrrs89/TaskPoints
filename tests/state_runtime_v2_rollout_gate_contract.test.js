const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'state-runtime-v2-contracts.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const previewEnable = fs.readFileSync(path.join(repoRoot, 'state_v2_preview_enable.html'), 'utf8');
const runtime = fs.readFileSync(path.join(repoRoot, 'state_runtime_v2.js'), 'utf8');

const V2_COMMAND = 'node --test tests/state_runtime_v2*.test.js tests/perf_trace_v2_visibility_contract.test.js';

test('V2-22 branch CI requires locked dependencies, focused V2 contracts, and the complete TaskPoints test suite', () => {
  assert.match(workflow, /branches:\s*\n\s*- arch\/state-runtime-v2-plan/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.ok(workflow.includes(V2_COMMAND), 'focused V2 safety suite must remain an explicit gate');
  assert.match(workflow, /name:\s*Run full TaskPoints test suite[\s\S]*?run:\s*npm test/);
  assert.equal(packageJson.scripts?.test, 'node --test');

  const installAt = workflow.indexOf('run: npm ci');
  const v2At = workflow.indexOf(V2_COMMAND);
  const fullAt = workflow.indexOf('run: npm test');
  assert.ok(installAt >= 0 && v2At > installAt && fullAt > v2At, 'full-suite gate must run after dependencies and focused V2 contracts');
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

  const productionGuardAt = previewEnable.indexOf('productionHosts.has');
  const setFlagAt = previewEnable.indexOf("localStorage.setItem('taskpoints_state_v2_dark_mode_v1', '1')");
  assert.ok(productionGuardAt >= 0, 'production hostname guard must exist');
  assert.ok(setFlagAt > productionGuardAt, 'V2 flag must only be set after the production guard');
});
