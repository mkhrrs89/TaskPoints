const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');

test('Flex Actions header matches the Habits and Vices control layout', () => {
  assert.match(source, /function applyFlexHeaderPresentation\(\)/);
  assert.match(source, /\.recent-toggle\[data-target="flexWrap"\]/);
  assert.match(source, /hideButton\?\.remove\?\.\(\)/);
  assert.match(source, /dayButton\.style\.marginLeft = 'auto'/);
  assert.match(source, /dayButton\.textContent = viewingYesterday \? 'Today ▶︎' : '◀︎ Week'/);
  assert.match(source, /applyFlexHeaderPresentation\(\);/);
});
