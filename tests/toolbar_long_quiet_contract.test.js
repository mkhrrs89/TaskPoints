const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const diagnostics = fs.readFileSync(path.join(root, 'phase4_diagnostics.js'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');

test('shared toolbar maintenance waits for eight seconds of sustained inactivity', () => {
  assert.match(diagnostics, /installTaskPointsToolbarLongQuietGuard/);
  assert.match(diagnostics, /const REQUIRED_QUIET_MS = 8000;/);
  assert.match(diagnostics, /core\.getStorageMaintenanceIdleStatus\?\.\(\)/);
  assert.match(diagnostics, /Number\(status\.lastInteractionAgoMs \|\| 0\) >= REQUIRED_QUIET_MS/);
  assert.match(diagnostics, /global\.runTaskPointsToolbarMaintenance = wrapped;/);
  assert.match(diagnostics, /toolbar\.longQuietGuardInstalled/);
  assert.match(diagnostics, /toolbar\.longQuietDeferred/);
  assert.match(diagnostics, /toolbar\.longQuietReleased/);
});

test('Inbox page is exempt and Inbox generation semantics remain unchanged', () => {
  assert.match(diagnostics, /const isInbox = pathname === '\/inbox\.html' \|\| pathname\.endsWith\('\/inbox\.html'\);/);
  assert.match(diagnostics, /if \(isInbox\) return;/);
  assert.match(toolbar, /TaskPointsCore\.loadAppState\(\{ syncDerived: true, persistSync: true \}\)/);
  assert.match(toolbar, /savePath: 'inbox-auto-populate'/);
  assert.match(toolbar, /immediateWrite: true/);
});
