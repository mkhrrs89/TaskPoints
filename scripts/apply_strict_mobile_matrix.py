from pathlib import Path

INDEX = Path('index.html')
TEST = Path('tests/boot_animation_sequence_contract.test.js')

html = INDEX.read_text(encoding='utf-8')
start_marker = '  const animationStyle = document.createElement("style");\n'
end_marker = '  nextFrame(() => nextFrame(startVisualAnimation));\n'
start = html.find(start_marker)
if start < 0:
    raise SystemExit('Could not locate matrix animation start')
end = html.find(end_marker, start)
if end < 0:
    raise SystemExit('Could not locate matrix animation end')
end += len(end_marker)
old = html[start:end]
for marker in ('tp-matrix-running', '--tp-char-delay', 'lastStrip?.addEventListener'):
    if marker not in old:
        raise SystemExit(f'Expected current animation marker missing: {marker}')

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
      contain: layout paint;
      transform: translateZ(0);
    }
    #matrixTitle .tp-matrix-char-strip {
      display: flex;
      flex-direction: column;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      will-change: transform;
      animation: none;
    }
    #matrixTitle .tp-matrix-char-window.is-active .tp-matrix-char-strip {
      animation: tpMatrixDecodeChar var(--tp-char-duration) steps(7, end) forwards;
    }
    #matrixTitle .tp-matrix-char-window.is-settled .tp-matrix-char-strip {
      transform: translate3d(0, -8.05em, 0);
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
      transform: translate3d(0, -8.05em, 0) !important;
    }
    @keyframes tpMatrixDecodeChar {
      from { transform: translate3d(0, 0, 0); }
      to { transform: translate3d(0, -8.05em, 0); }
    }
  `;
  document.head.appendChild(animationStyle);

  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];
  const scrambleFrameCount = 6;
  const charDurationMs = 280;
  const charFallbackGraceMs = 240;
  let completionScheduled = false;
  let activeCharIndex = -1;
  let activeSequenceToken = 0;

  titleEl.innerHTML = "";
  const stage = document.createElement("span");
  stage.className = "tp-matrix-stage";
  const charWindows = [];

  for (let charIndex = 0; charIndex < word.length; charIndex++){
    const charWindow = document.createElement("span");
    charWindow.className = "tp-matrix-char-window";
    charWindow.dataset.matrixIndex = String(charIndex);

    const strip = document.createElement("span");
    strip.className = "tp-matrix-char-strip";
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
    charWindows.push(charWindow);
  }

  titleEl.appendChild(stage);

  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    settleMatrixTitle();
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  const nextFrame = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback) => setTimeout(callback, 16);

  const activateCharacter = (index) => {
    if (skipRequested || finished || completionScheduled) return;
    if (activeCharIndex !== -1) return;
    if (index >= charWindows.length) {
      completeAfterVisual();
      return;
    }

    activeCharIndex = index;
    const token = ++activeSequenceToken;
    const charWindow = charWindows[index];
    charWindow.classList.add("is-active");
    visualFallbackTimer = setTimeout(
      () => completeCharacter(index, token),
      charDurationMs + charFallbackGraceMs
    );
  };

  const completeCharacter = (index, token) => {
    if (skipRequested || finished || completionScheduled) return;
    if (index !== activeCharIndex || token !== activeSequenceToken) return;

    if (visualFallbackTimer !== null) {
      clearTimeout(visualFallbackTimer);
      visualFallbackTimer = null;
    }

    const charWindow = charWindows[index];
    charWindow.classList.remove("is-active");
    charWindow.classList.add("is-settled");
    activeCharIndex = -1;

    if (index === charWindows.length - 1) {
      completeAfterVisual();
      return;
    }

    nextFrame(() => activateCharacter(index + 1));
  };

  charWindows.forEach((charWindow, index) => {
    const strip = charWindow.querySelector(".tp-matrix-char-strip");
    strip?.addEventListener("animationend", (event) => {
      if (event.animationName !== "tpMatrixDecodeChar") return;
      completeCharacter(index, activeSequenceToken);
    });
  });

  const startVisualAnimation = () => {
    if (skipRequested || finished || completionScheduled) return;
    try { performance.mark("tp-matrix-visual-started"); } catch (e) {}
    activateCharacter(0);
  };
  nextFrame(() => nextFrame(startVisualAnimation));
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

test('matrix begins with ten blank slots and no future slot animation delays', () => {
  assert.match(early, /for \(let charIndex = 0; charIndex < word\.length; charIndex\+\+\)/);
  assert.match(early, /blankFrame\.textContent = "\\u00a0"/);
  assert.match(early, /const charWindows = \[\]/);
  assert.doesNotMatch(early, /--tp-char-delay/);
  assert.doesNotMatch(early, /charIndex \* charIntervalMs/);
  assert.doesNotMatch(early, /tp-matrix-running \.tp-matrix-char-strip/);
});

test('only the current character can receive the active animation class', () => {
  assert.match(early, /let activeCharIndex = -1/);
  assert.match(early, /if \(activeCharIndex !== -1\) return/);
  assert.match(early, /activeCharIndex = index/);
  assert.match(early, /charWindow\.classList\.add\("is-active"\)/);
  assert.match(early, /\.tp-matrix-char-window\.is-active \.tp-matrix-char-strip/);
  assert.doesNotMatch(early, /charWindows\.forEach\([\s\S]*classList\.add\("is-active"\)/);
});

test('the current letter settles before the next blank position is activated', () => {
  assert.match(early, /charWindow\.classList\.remove\("is-active"\)/);
  assert.match(early, /charWindow\.classList\.add\("is-settled"\)/);
  assert.match(early, /activeCharIndex = -1/);
  assert.match(early, /nextFrame\(\(\) => activateCharacter\(index \+ 1\)\)/);
  assert.match(early, /\.tp-matrix-char-window\.is-settled \.tp-matrix-char-strip/);
});

test('each active position rapidly cycles matrix glyphs then lands on its exact letter', () => {
  assert.match(early, /const scrambleFrameCount = 6/);
  assert.match(early, /steps\(7, end\)/);
  assert.match(early, /frame\.textContent = randomGlyph\(\)/);
  assert.match(early, /finalFrame\.textContent = word\[charIndex\]/);
  assert.match(early, /translate3d\(0, -8\.05em, 0\)/);
});

test('animation events and guarded fallbacks advance only the active character', () => {
  assert.match(early, /const token = \+\+activeSequenceToken/);
  assert.match(early, /completeCharacter\(index, token\)/);
  assert.match(early, /index !== activeCharIndex \|\| token !== activeSequenceToken/);
  assert.match(early, /event\.animationName !== "tpMatrixDecodeChar"/);
  assert.match(early, /completeCharacter\(index, activeSequenceToken\)/);
});

test('blank paint, skip, normal completion, and failsafe behavior remain intact', () => {
  assert.match(early, /nextFrame\(\(\) => nextFrame\(startVisualAnimation\)\)/);
  assert.match(early, /activateCharacter\(0\)/);
  assert.match(early, /settleMatrixTitle\(\)/);
  assert.match(early, /completeBootView\(\{ skipped: true \}\)/);
  assert.match(html, /window\.__tpForceMatrixCompletion\?\.\(\);\s+finishBoot\(\);/);
});
''', encoding='utf-8')
