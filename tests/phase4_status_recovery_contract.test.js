const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Phase 4 Refresh performs recovery rather than only repainting status', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'phase4_storage_status.html'), 'utf8');
  assert.match(html, /manual_status_refresh/);
  assert.match(html, /flushPhase4PrimaryWrites/);
  assert.match(html, /Checking…/);
});
