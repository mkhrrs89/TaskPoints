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

const early = between('<script id="tp-early-matrix-bootstrap">', '</script>');

test('early boot starts with ten blank positions and decodes one character at a time', () => {
  assert.match(early, /for \(let charIndex = 0; charIndex < word\.length; charIndex\+\+\)/);
  assert.match(early, /blankFrame\.textContent = "\\u00a0"/);
  assert.match(early, /strip\.style\.setProperty\("--tp-char-delay", `\$\{charIndex \* charIntervalMs\}ms`\)/);
  assert.match(early, /finalFrame\.textContent = word\[charIndex\]/);
  assert.match(early, /charDurationMs = 210/);
  assert.match(early, /charIntervalMs = 220/);
});

test('each position owns its scramble frames and final letter without a second text layer', () => {
  assert.match(early, /tp-matrix-char-window/);
  assert.match(early, /tp-matrix-char-strip/);
  assert.match(early, /tp-matrix-char-frame--final/);
  assert.match(early, /steps\(6, end\)/);
  assert.doesNotMatch(early, /randomWord/);
  assert.doesNotMatch(early, /tp-matrix-final-layer/);
  assert.doesNotMatch(early, /tpMatrixReveal/);
  assert.doesNotMatch(early, /clip-path/);
});

test('normal completion follows the last character and skip jumps every strip to its final frame', () => {
  assert.match(early, /lastStrip\?\.addEventListener\("animationend", completeAfterVisual/);
  assert.match(early, /visualDurationMs = charDurationMs \+ \(\(word\.length - 1\) \* charIntervalMs\)/);
  assert.match(early, /#matrixTitle\.tp-matrix-skip \.tp-matrix-char-strip/);
  assert.match(early, /translate3d\(0, -6\.9em, 0\) !important/);
  assert.match(early, /completeBootView\(\{ skipped: true \}\)/);
});
