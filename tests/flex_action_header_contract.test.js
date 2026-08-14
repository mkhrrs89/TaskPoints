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
  assert.match(source, /getElementById\?\.\('weekBackBtnHabits'\)/);
  assert.match(source, /getElementById\?\.\('weekBackBtnVices'\)/);
  assert.match(source, /global\.getComputedStyle\(referenceButton\)/);
  assert.match(source, /dayButton\.style\.fontFamily = referenceFont\.fontFamily/);
  assert.match(source, /dayButton\.style\.fontWeight = referenceFont\.fontWeight/);
  assert.match(source, /dayButton\.style\.letterSpacing = referenceFont\.letterSpacing/);
  assert.match(source, /const desiredLabel = viewingYesterday \? 'Today ▶︎' : '◀︎ Week'/);
  assert.match(source, /new global\.MutationObserver\(applyLabel\)/);
  assert.match(source, /observer\.observe\(dayButton, \{ childList: true, characterData: true, subtree: true \}\)/);
  assert.match(source, /applyFlexHeaderPresentation\(\);/);
});
