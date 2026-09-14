const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HOME = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const TOOLBAR = fs.readFileSync(path.join(ROOT, 'toolbar.js'), 'utf8');

function extractArrowFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `expected ${declaration}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) {
      const semicolon = source.indexOf(';', i);
      return source.slice(start, semicolon + 1);
    }
  }
  throw new Error(`could not bound ${declaration}`);
}

test('Home scoreboard publishes the exact displayed score to the floating-island cache', () => {
  const source = extractArrowFunction(HOME, 'const updateTodayScoreIsland =');
  assert.match(source, /String\(value\)/);
  assert.match(source, /cacheKey = 'tpTodayScore'/);
  assert.match(source, /localStorage\.setItem\(cacheKey, displayValue\)/);
  assert.doesNotMatch(source, /toFixed\(/, 'cache writer must not independently round the already-formatted scoreboard value');

  const values = new Map([['tpTodayScore', '10.1']]);
  const localStorage = {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
  const scoreNode = { textContent: '' };
  const context = vm.createContext({ localStorage, $: id => id === 'todayScoreIslandValue' ? scoreNode : null, String });
  vm.runInContext(`${source}; globalThis.updateScore = updateTodayScoreIsland;`, context);
  context.updateScore('10.2');
  assert.equal(scoreNode.textContent, '10.2');
  assert.equal(values.get('tpTodayScore'), '10.2');
});

test('Floating island reads the same tpTodayScore cache the Home scoreboard now publishes', () => {
  assert.match(TOOLBAR, /const key = 'tpTodayScore'/);
  assert.match(TOOLBAR, /localStorage\.getItem\(key\)/);
  assert.match(TOOLBAR, /valueEl\.textContent = \(v == null \|\| v === ''\) \? '—' : v/);
});

test('Home scoreboard passes its already-rounded displayed value into the shared island updater', () => {
  assert.match(HOME, /yourScoreEl\.textContent = safeYourScore\.toFixed\(1\);\s*updateTodayScoreIsland\(safeYourScore\.toFixed\(1\)\);/);
});
