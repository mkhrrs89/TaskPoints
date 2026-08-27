const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_v2_preview_enable.html'), 'utf8');

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

test('V2 preview opt-in returns to Home after enabling the isolated origin flag', () => {
  assert.match(source, /location\.replace\('\/'\)/);
});
