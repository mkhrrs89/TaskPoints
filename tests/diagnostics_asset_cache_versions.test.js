const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'inbox_count_badge.js'),
  'utf8'
);

test('loads the cache-busted Home and Settings diagnostics assets', () => {
  assert.match(
    source,
    /\/home_featured_matchup_visibility\.js\?v=20260803-2/
  );
  assert.match(
    source,
    /\/home_export_responsiveness\.js\?v=20260803-3/
  );

  assert.doesNotMatch(
    source,
    /\/home_featured_matchup_visibility\.js\?v=20260801-1/
  );
  assert.doesNotMatch(
    source,
    /\/home_export_responsiveness\.js\?v=20260803-2/
  );
});
