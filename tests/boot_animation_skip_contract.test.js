const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(start, end) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return html.slice(startIndex, endIndex);
}

test('opening splash visibly offers tap-to-skip and is keyboard reachable', () => {
  assert.match(html, /id="bootSplash"[\s\S]*role="button"[\s\S]*tabindex="0"/);
  assert.match(html, /Tap anywhere to skip/);
  assert.match(html, /\.bootSkipHint\s*\{/);
  assert.match(html, /touch-action:\s*manipulation/);
});

test('early splash controller reveals the app immediately on skip', () => {
  const early = between('<script id="tp-early-matrix-bootstrap">', '</script>');
  assert.match(early, /window\.__tpCompleteBootView = completeBootView/);
  assert.match(early, /completeBootView\(\{ skipped: true \}\)/);
  assert.match(early, /classList\.remove\("tp-boot-pending"\)/);
  assert.match(early, /classList\.add\("tp-boot-seen"\)/);
  assert.match(early, /window\.dispatchEvent\(new Event\("tp:bootFinished"\)\)/);
  assert.match(early, /addEventListener\("touchstart", requestSkip/);
  assert.match(early, /addEventListener\("keydown", requestSkipFromKey\)/);
});

test('a skip requested before appRoot exists is completed before scoring core runs', () => {
  const readyIndex = html.indexOf('id="tp-boot-skip-ready"');
  const coreIndex = html.indexOf('<script src="scoring_core.js"></script>');
  assert.ok(readyIndex > 0 && coreIndex > readyIndex);
  assert.match(html.slice(readyIndex, coreIndex), /__tpBootRevealPending/);
  assert.match(html.slice(readyIndex, coreIndex), /__tpCompleteBootView/);
});

test('late boot gate delegates to the shared completion function without double finishing', () => {
  const late = between('<script>\n(function(){\n  let bootFinished = false;', '// failsafe in case the bootstrap cannot complete');
  assert.match(late, /bootFinished \|\| window\.__tpBootViewFinished/);
  assert.match(late, /window\.__tpCompleteBootView\(\{ skipped: false \}\)/);
});
