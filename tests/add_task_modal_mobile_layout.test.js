const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_indexeddb_bootstrap.js'), 'utf8');

test('mobile Add Task modal sits above the Home header while toolbar stays available', () => {
  assert.match(source, /#addTaskModal\s*\{[^}]*z-index:\s*70\s*!important/s);
  assert.match(source, /#mobileBottomNav\s*\{[^}]*z-index:\s*80\s*!important/s);
});

test('mobile Add Task title field gets a dedicated top band below Close', () => {
  assert.match(source, /#addTaskModal \.addTaskModalPanel\s*\{[^}]*padding-top:\s*72px\s*!important/s);
});
