const fs = require('node:fs');

const modulePath = 'season_series_upset_notifications.js';
let source = fs.readFileSync(modulePath, 'utf8');

const queueBlock = `  function queueReconcile(delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      reconcileStored();
    }, Math.max(0, Number(delayMs) || 0));
  }
`;

const quietBlock = `${queueBlock}
  function queueReconcileWhenQuiet(reason = 'startup', delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    const schedule = () => queueReconcile(delayMs);
    const tryGate = () => {
      const gate = global.TaskPointsCore?.whenStorageMaintenanceQuiet;
      if (typeof gate !== 'function') return false;
      Promise.resolve(gate(schedule, { reason: \`season_series_upset_\${reason}\` }))
        .catch(() => global.setTimeout?.(schedule, 3000));
      return true;
    };
    if (tryGate()) return;
    global.setTimeout?.(() => {
      if (!tryGate()) schedule();
    }, 0);
  }
`;

if (!source.includes(queueBlock)) throw new Error('queueReconcile block not found');
source = source.replace(queueBlock, quietBlock);

const bootstrapOld = '    queueReconcile(0);\n    return true;';
const bootstrapNew = "    queueReconcileWhenQuiet('bootstrap', 0);\n    return true;";
if (!source.includes(bootstrapOld)) throw new Error('bootstrap reconcile call not found');
source = source.replace(bootstrapOld, bootstrapNew);

const pageshowOld = '    queueReconcile(50);\n  });';
const pageshowNew = "    queueReconcileWhenQuiet('pageshow', 50);\n  });";
if (!source.includes(pageshowOld)) throw new Error('pageshow reconcile call not found');
source = source.replace(pageshowOld, pageshowNew);

fs.writeFileSync(modulePath, source);

const testSource = `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../season_series_upset_notifications.js'), 'utf8');

test('startup and pageshow upset reconciliation wait for the shared quiet gate', () => {
  assert.match(source, /function queueReconcileWhenQuiet\\(/);
  assert.match(source, /TaskPointsCore\\?\\.whenStorageMaintenanceQuiet/);
  assert.match(source, /queueReconcileWhenQuiet\\('bootstrap', 0\\)/);
  assert.match(source, /queueReconcileWhenQuiet\\('pageshow', 50\\)/);
});

test('focus and state revisions keep prompt reconciliation', () => {
  assert.match(source, /'focus', \\(\\) => queueReconcile\\(100\\)/);
  assert.match(source, /'taskpoints:state-revision',[\\s\\S]*queueReconcile\\(100\\)/);
});
`;
fs.writeFileSync('tests/step3h_upset_reconcile_quiet.test.js', testSource);
