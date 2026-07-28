const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase4_cache_guard.js'), 'utf8');

test('Storage Diagnostics cannot satisfy the normal-app close-and-reopen proof', () => {
  const excludedStart = source.indexOf('const EXCLUDED_PAGES = new Set([');
  const excludedEnd = source.indexOf(']);', excludedStart);
  assert.ok(excludedStart >= 0 && excludedEnd > excludedStart);
  const excludedPages = source.slice(excludedStart, excludedEnd);
  assert.match(excludedPages, /'storage_diagnostics\.html'/);
  assert.match(excludedPages, /'settings\.html'/);
  assert.match(source, /!EXCLUDED_PAGES\.has\(pageName\)/);
});
