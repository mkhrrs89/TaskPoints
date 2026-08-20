const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'home_season_slate_long_quiet.js'), 'utf8');

test('Home Inbox auto-populate keeps derived sync but suppresses its redundant persistSync write', () => {
  assert.match(source, /installTaskPointsHomeInboxNoRedundantPersist/);
  assert.match(source, /global\.autoPopulateTaskPointsInbox/);
  assert.match(source, /options\.syncDerived === true && options\.persistSync === true/);
  assert.match(source, /originalLoad\.call\(this, \{ \.\.\.options, persistSync: false \}\)/);
  assert.match(source, /toolbar\.inboxPersistSyncSuppressed/);
  assert.match(source, /core\.loadAppState = originalLoad/);
});

test('Home Inbox wrapper leaves the original auto-populate function and save decision in control', () => {
  assert.match(source, /return original\.apply\(this, args\)/);
  assert.match(source, /wrapped\.__taskPointsOriginal = original/);
  assert.doesNotMatch(source, /mergeAndSaveState\(/);
});
