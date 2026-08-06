from pathlib import Path

INDEX = Path('index.html')
TEST = Path('tests/boot_animation_sequence_contract.test.js')

html = INDEX.read_text(encoding='utf-8')
start_marker = '  const animationStyle = document.createElement("style");\n'
end_marker = '  setTimeout(completeAfterVisual, visualDurationMs + 120);\n'
start = html.find(start_marker)
if start < 0:
    raise SystemExit('Could not locate early matrix animation start')
end = html.find(end_marker, start)
if end < 0:
    raise SystemExit('Could not locate early matrix animation end')
end += len(end_marker)
old = html[start:end]
for required in ('randomWord', 'tp-matrix-final-layer', 'tpMatrixReveal'):
    if required not in old:
        raise SystemExit(f'Expected current whole-word animation marker missing: {required}')

new = r'''  const animationStyle = document.createElement("style");
  animationStyle.id = "tp-early-matrix-animation-style";
  animationStyle.textContent = `
    #matrixTitle .tp-matrix-stage {
      display: inline-flex;
      align-items: flex-start;
      gap: 0.08em;
      height: 1.15em;
      line-height: 1.15em;
      white-space: nowrap;
      contain: layout paint;
      transform: translateZ(0);
    }
    #matrixTitle .tp-matrix-char-window {
      display: inline-block;
      width: 0.85em;
      height: 1.15em;
      line-height: 1.15em;
      overflow: hidden;
      text-align: center;
    }
    #matrixTitle .tp-matrix-char-strip {
      display: flex;
      flex-direction: column;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      will-change: transform;
      animation: tpMatrixDecodeChar var(--tp-char-duration) steps(6, end) var(--tp-char-delay) both;
    }
    #matrixTitle .tp-matrix-char-frame {
      display: block;
      flex: 0 0 1.15em;
      width: 0.85em;
      height: 1.15em;
      line-height: 1.15em;
      letter-spacing: 0;
      white-space: nowrap;
      text-align: center;
    }
    #matrixTitle .tp-matrix-char-frame--final {
      color: #eafff1;
    }
    #matrixTitle.tp-matrix-skip .tp-matrix-char-strip {
      animation: none !important;
      transform: translate3d(0, -6.9em, 0) !important;
    }
    @keyframes tpMatrixDecodeChar {
      from { transform: translate3d(0, 0, 0); }
      to { transform: translate3d(0, -6.9em, 0); }
    }
  `;
  document.head.appendChild(animationStyle);

  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];
  const scrambleFrameCount = 5;
  const charDurationMs = 210;
  const charIntervalMs = 220;
  const visualDurationMs = charDurationMs + ((word.length - 1) * charIntervalMs);
  let completionScheduled = false;

  titleEl.innerHTML = "";
  const stage = document.createElement("span");
  stage.className = "tp-matrix-stage";
  let lastStrip = null;

  for (let charIndex = 0; charIndex < word.length; charIndex++){
    const charWindow = document.createElement("span");
    charWindow.className = "tp-matrix-char-window";

    const strip = document.createElement("span");
    strip.className = "tp-matrix-char-strip";
    strip.style.setProperty("--tp-char-delay", `${charIndex * charIntervalMs}ms`);
    strip.style.setProperty("--tp-char-duration", `${charDurationMs}ms`);

    const blankFrame = document.createElement("span");
    blankFrame.className = "tp-matrix-char-frame";
    blankFrame.textContent = "\u00a0";
    strip.appendChild(blankFrame);

    for (let frameIndex = 0; frameIndex < scrambleFrameCount; frameIndex++){
      const frame = document.createElement("span");
      frame.className = "tp-matrix-char-frame";
      frame.textContent = randomGlyph();
      strip.appendChild(frame);
    }

    const finalFrame = document.createElement("span");
    finalFrame.className = "tp-matrix-char-frame tp-matrix-char-frame--final";
    finalFrame.textContent = word[charIndex];
    strip.appendChild(finalFrame);

    charWindow.appendChild(strip);
    stage.appendChild(charWindow);
    lastStrip = strip;
  }

  titleEl.appendChild(stage);

  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  lastStrip?.addEventListener("animationend", completeAfterVisual, { once: true });
  setTimeout(completeAfterVisual, visualDurationMs + 120);
'''

html = html[:start] + new + html[end:]
INDEX.write_text(html, encoding='utf-8')

TEST.write_text(r'''const test = require('node:test');
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
''', encoding='utf-8')
