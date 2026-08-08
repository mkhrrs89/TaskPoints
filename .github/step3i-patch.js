const fs = require('node:fs');

const sourcePath = 'season_series_upset_notifications.js';
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`${label} not found`);
  source = source.replace(oldText, newText);
}

replaceOnce(
  "      const loaded = core.loadAppState({ syncDerived: true, persistSync: false });",
  "      const loaded = core.loadAppState({ syncDerived: options.syncDerived !== false, persistSync: false });",
  'reconcileStored load options'
);

replaceOnce(
`  function queueReconcile(delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      reconcileStored();
    }, Math.max(0, Number(delayMs) || 0));
  }
`,
`  function queueReconcile(delayMs = 0, reconcileOptions = {}) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      reconcileStored(reconcileOptions);
    }, Math.max(0, Number(delayMs) || 0));
  }
`,
  'queueReconcile options'
);

replaceOnce(
  "    const schedule = () => queueReconcile(delayMs);",
  "    const schedule = () => queueReconcile(delayMs, { syncDerived: false });",
  'quiet lightweight schedule'
);

fs.writeFileSync(sourcePath, source);

const testSource = `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../season_series_upset_notifications.js'), 'utf8');

test('passive bootstrap/pageshow reconciliation skips derived synchronization', () => {
  assert.match(source, /loadAppState\\(\\{ syncDerived: options\\.syncDerived !== false, persistSync: false \\}\\)/);
  assert.match(source, /const schedule = \\(\\) => queueReconcile\\(delayMs, \\{ syncDerived: false \\}\\);/);
  assert.match(source, /queueReconcileWhenQuiet\\('bootstrap', 0\\)/);
  assert.match(source, /queueReconcileWhenQuiet\\('pageshow', 50\\)/);
});

test('live focus and state-revision reconciliation retain full derived synchronization by default', () => {
  assert.match(source, /function queueReconcile\\(delayMs = 0, reconcileOptions = \\{\\}\\)/);
  assert.match(source, /reconcileStored\\(reconcileOptions\\)/);
  assert.match(source, /addEventListener\\?\\.\\('focus', \\(\\) => queueReconcile\\(100\\)\\)/);
  assert.match(source, /addEventListener\\?\\.\\('taskpoints:state-revision',[\\s\\S]*queueReconcile\\(100\\)/);
});
`;
fs.writeFileSync('tests/step3i_upset_lightweight_passive.test.js', testSource);
