const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'performance_diagnostics.js'), 'utf8');

test('performance trace reports State Runtime V2 status when available', () => {
  assert.match(source, /stateRuntimeV2Status:global\.TaskPointsStateRuntimeV2\?\.getStatus\?\.\(\)\|\|null/);
});

test('mobile PERF bubble sits just above the bottom toolbar', () => {
  assert.match(source, /bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 135px\)/);
  assert.doesNotMatch(source, /bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 185px\)/);
});
