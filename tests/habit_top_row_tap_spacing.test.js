const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_featured_matchup_visibility.js'), 'utf8');

test('mobile Habit and Vice top controls sit farther from completion bubbles', () => {
  assert.match(source, /@media \(max-width: 640px\)/);
  assert.match(source, /\.habitRow--single,[\s\S]*\.habitGroupBody \.habitRow \{[\s\S]*row-gap: 0\.5rem !important;/);
  assert.match(source, /\.habitRow--single \.habitLeft,[\s\S]*\.habitGroupBody \.habitRow \.habitControls \{[\s\S]*transform: translateY\(-2px\);/);
});

test('tap-spacing change does not disable the name, move controls, or date bubbles', () => {
  assert.doesNotMatch(source, /pointer-events:\s*none[^}]*habit(?:Left|Controls|DaysRow)/i);
  assert.doesNotMatch(source, /\.habitDaysRow\s*\{[^}]*transform:/);
});
