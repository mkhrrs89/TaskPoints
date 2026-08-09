const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'toolbar.js'), 'utf8');

test('non-Home shared toolbar maintenance waits for the Step 3E quiet gate', () => {
  const start = source.indexOf('function scheduleTaskPointsToolbarMaintenance()');
  const end = source.indexOf('function initToolbarNow()', start);
  assert.ok(start >= 0 && end > start, 'toolbar maintenance scheduler should exist');
  const scheduler = source.slice(start, end);
  assert.match(scheduler, /if \(!isMainPagePathname\(window\.location\.pathname\)\)/);
  assert.match(scheduler, /TaskPointsCore\?\.whenStorageMaintenanceQuiet/);
  assert.match(scheduler, /gate\(run, \{ reason: 'toolbar_background_maintenance' \}\)/);
  assert.doesNotMatch(scheduler, /if \(!isMainPagePathname\(window\.location\.pathname\)\) \{\s*run\(\);/);
});

test('Home and Inbox retain their existing specialized maintenance scheduling', () => {
  const start = source.indexOf('function scheduleTaskPointsToolbarMaintenance()');
  const end = source.indexOf('function initToolbarNow()', start);
  const scheduler = source.slice(start, end);
  assert.match(scheduler, /scheduleTaskPointsInboxAuditAfterStartup\(\)/);
  assert.match(scheduler, /TaskPointsHomeIdleQueue\?\.enqueue/);
  assert.match(scheduler, /home-toolbar-maintenance/);
});
