from pathlib import Path

path = Path("index.html")
text = path.read_text(encoding="utf-8")
script_marker = '<script id="tp-early-matrix-bootstrap">'
script_start = text.index(script_marker)
script_end = text.index("</script>", script_start)
early = text[script_start:script_end]

old_start = '  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];'
if old_start in early:
    replace_start = early.index(old_start)
    replace_end = early.rfind("\n})();")
    assert replace_end > replace_start, "Could not locate early Matrix animation block end"

    new_animation = '''  const animationStyle = document.createElement("style");
  animationStyle.id = "tp-early-matrix-animation-style";
  animationStyle.textContent = `
    #matrixTitle .tp-matrix-cell {
      position: relative;
      height: 1.15em;
      line-height: 1.15em;
      overflow: hidden;
      vertical-align: middle;
    }
    #matrixTitle .tp-matrix-reel {
      display: flex;
      flex-direction: column;
      transform: translate3d(0, 0, 0);
      will-change: transform;
      animation: tpMatrixGlyphReel 210ms steps(7, end) forwards;
    }
    #matrixTitle .tp-matrix-reel > span {
      display: block;
      flex: 0 0 1.15em;
      height: 1.15em;
      line-height: 1.15em;
      text-align: center;
    }
    #matrixTitle .tp-matrix-final {
      color: #eafff1;
    }
    #matrixTitle.tp-matrix-skip .tp-matrix-reel {
      animation: none !important;
      transform: translate3d(0, -8.05em, 0) !important;
    }
    @keyframes tpMatrixGlyphReel {
      to { transform: translate3d(0, -8.05em, 0); }
    }
  `;
  document.head.appendChild(animationStyle);

  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];
  const randomFrameCount = 7;
  const characterDurationMs = 210;
  const initialDelayMs = 90;
  let completionScheduled = false;
  let lastReel = null;

  titleEl.innerHTML = "";
  for (let index = 0; index < word.length; index++){
    const cell = document.createElement("span");
    cell.className = "matrixChar tp-matrix-cell";

    const reel = document.createElement("span");
    reel.className = "tp-matrix-reel";
    reel.style.animationDelay = `${initialDelayMs + (index * characterDurationMs)}ms`;

    for (let frameIndex = 0; frameIndex < randomFrameCount; frameIndex++){
      const frame = document.createElement("span");
      frame.textContent = randomGlyph();
      reel.appendChild(frame);
    }

    const finalFrame = document.createElement("span");
    finalFrame.className = "tp-matrix-final locked";
    finalFrame.textContent = word[index];
    reel.appendChild(finalFrame);
    cell.appendChild(reel);
    titleEl.appendChild(cell);
    lastReel = reel;
  }

  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  lastReel?.addEventListener("animationend", completeAfterVisual, { once: true });
  const visualDurationMs = initialDelayMs + (word.length * characterDurationMs);
  setTimeout(completeAfterVisual, visualDurationMs + 120);
  '''

    early = early[:replace_start] + new_animation + early[replace_end:]

old_skip = '''  const requestSkip = () => {
    if (skipRequested || finished) return;
    skipRequested = true;
    finish();
  };'''
new_skip = '''  const requestSkip = () => {
    if (skipRequested || finished) return;
    skipRequested = true;
    titleEl.classList.add("tp-matrix-skip");
    finish();
  };'''
if old_skip in early:
    assert early.count(old_skip) == 1, "Expected exactly one early Matrix skip handler"
    early = early.replace(old_skip, new_skip, 1)

text = text[:script_start] + early + text[script_end:]
path.write_text(text, encoding="utf-8")

verified = path.read_text(encoding="utf-8")
verify_start = verified.index(script_marker)
verify_end = verified.index("</script>", verify_start)
verify_early = verified[verify_start:verify_end]
assert verified.count('id="tp-early-matrix-bootstrap"') == 1
assert verify_early.count('animationStyle.id = "tp-early-matrix-animation-style";') == 1
assert verify_early.count('animation: tpMatrixGlyphReel 210ms steps(7, end) forwards;') == 1
assert verify_early.count("setInterval(") == 0
assert verify_early.count('titleEl.classList.add("tp-matrix-skip")') == 1
assert verify_early.count('lastReel?.addEventListener("animationend"') == 1
assert verified.count("window.__tpMatrixFinishedPromise = new Promise") == 1

for trigger in Path(".github/automation-triggers").glob("smooth-early-matrix*.txt"):
    trigger.unlink()
Path(__file__).unlink()
