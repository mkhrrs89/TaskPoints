const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'performance_diagnostics.js'), 'utf8');

test('perf trace exposes an on-demand storage environment report', () => {
  assert.match(source, /collectStorageEnvironment/);
  assert.match(source, /storageEnvironment/);
  assert.match(source, /data-p-storage/);
  assert.match(source, /Collect storage report/);
});

test('storage report inventories metadata without reading IndexedDB record bodies', () => {
  assert.match(source, /indexedDB\.databases/);
  assert.match(source, /\.count\(\)/);
  assert.doesNotMatch(source, /\.getAll\(/);
  assert.doesNotMatch(source, /\.getAllKeys\(/);
});

test('storage report covers the major browser storage containers', () => {
  assert.match(source, /navigator\?\.storage\?\.estimate/);
  assert.match(source, /storageInventory\(global\.localStorage\)/);
  assert.match(source, /storageInventory\(global\.sessionStorage\)/);
  assert.match(source, /cacheInventory\(\)/);
  assert.match(source, /serviceWorkerInventory\(\)/);
});

test('iOS download keeps the actual file click synchronous', () => {
  assert.match(source, /function download\(\)\{const b=new Blob/);
  assert.doesNotMatch(source, /async function download\(\)/);
  assert.doesNotMatch(source, /function download\(\)\{if\(!storageEnvironment\)await/);
});

test('copy and download collect storage first and ask for a second tap', () => {
  assert.match(source, /Storage report ready\. Tap Copy report again\./);
  assert.match(source, /Storage report ready\. Tap Download JSON again\./);
  assert.match(source, /if\(!storageEnvironment\).*collectStorageEnvironment/s);
});

test('mobile perf badge stays below modal action buttons', () => {
  assert.match(source, /bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 135px\)/);
});
