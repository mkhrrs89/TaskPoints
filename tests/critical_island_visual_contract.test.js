const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('critical task floating alert is punctuation-only with no visible circle', () => {
  const start = styles.indexOf('.tp-critical-island{');
  const end = styles.indexOf('}', start);
  const block = styles.slice(start, end + 1);

  assert.match(block, /background:\s*transparent;/);
  assert.match(block, /border:\s*0;/);
  assert.match(block, /box-shadow:\s*none;/);
  assert.match(block, /border-radius:\s*0;/);
  assert.match(block, /min-width:\s*56px;/);
  assert.match(block, /min-height:\s*56px;/);
});

test('critical task exclamation marks are spaced, red, glowing, and pulsing', () => {
  const start = styles.indexOf('#criticalTasksIslandMark {');
  const end = styles.indexOf('@keyframes tpCriticalIslandMarkPulse', start);
  const block = styles.slice(start, end);

  assert.match(block, /font-size:\s*2\.65rem;/);
  assert.match(block, /position:\s*relative;/);
  assert.match(block, /top:\s*4px;/);
  assert.match(block, /color:\s*#ef4444;/);
  assert.match(block, /letter-spacing:\s*0\.24em;/);
  assert.match(block, /text-shadow:/);
  assert.match(block, /animation:\s*tpCriticalIslandMarkPulse 1\.15s ease-in-out infinite;/);
  assert.match(styles, /@keyframes tpCriticalIslandMarkPulse/);
});
