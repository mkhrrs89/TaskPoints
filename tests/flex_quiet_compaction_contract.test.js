const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');

test('Flex completion snapshots wait for extended Home quiet while the durable journal remains immediate', () => {
  assert.match(source, /const REQUIRED_QUIET_MS = 8000;/);
  assert.match(source, /const QUIET_POLL_MS = 250;/);
  assert.match(source, /core\.getStorageMaintenanceIdleStatus\?\.\(\)/);
  assert.match(source, /status\.activeEditor === true/);
  assert.match(source, /status\.lastInteractionAgoMs/);
  assert.match(source, /flex\.compactionDeferred/);
  assert.match(source, /flex\.compactionReleased/);
  assert.match(source, /appendJournal\(entry\)/, 'Flex completion is still journaled before background compaction');
  assert.match(source, /global\.addEventListener\?\.\('pagehide', \(\) => persistNow\('pagehide'\)\)/, 'pagehide remains an immediate durability flush');
  assert.match(source, /persistNow\('core-flush'\)/, 'explicit core flushes remain immediate');
});

test('Flex UI refresh is decoupled from the delayed full-state snapshot', () => {
  assert.match(source, /if \(renderPending\) \{/);
  assert.match(source, /pendingRenderSatisfied = true;/);
  assert.match(source, /requestFullRender\(\);/);
  assert.match(source, /if \(fullRenderRequested\) renderPending = true;/);
  assert.match(source, /attemptQuietSave\('quiet-after-paint'\)/);
});
