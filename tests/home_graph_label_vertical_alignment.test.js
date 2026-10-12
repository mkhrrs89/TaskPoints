const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Home graph carousel uses top alignment without changing its height', () => {
  const match = source.match(/\.homeGraphWidget \{[\s\S]*?\}/);
  assert.ok(match, 'homeGraphWidget style block should exist');
  assert.match(match[0], /min-height:\s*120px;/);
  assert.match(match[0], /justify-content:\s*flex-start;/);
  assert.doesNotMatch(match[0], /justify-content:\s*flex-end;/);
});


test('Home graph uses the widget bottom space for a taller plot while keeping the label fixed', () => {
  const panel = source.match(/\.homeGraphPanel \{[\s\S]*?\}/);
  const title = source.match(/\.homeGraphTitle \{[\s\S]*?\}/);
  const canvas = source.match(/\.homeGraphPanel canvas \{[\s\S]*?\}/);

  assert.ok(panel && title && canvas);
  assert.match(panel[0], /height:\s*106px;/);
  assert.match(title[0], /top:\s*2px;/);
  assert.match(canvas[0], /height:\s*100% !important;/);
});
