from pathlib import Path

path = Path("index.html")
text = path.read_text(encoding="utf-8")
script_marker = '<script id="tp-early-matrix-bootstrap">'
script_start = text.index(script_marker)
script_end = text.index("</script>", script_start)
early = text[script_start:script_end]

old_start = '  const animationStyle = document.createElement("style");'
replace_start = early.index(old_start)
replace_end = early.rfind("\n})();")
assert replace_end > replace_start, "Could not locate the Matrix animation block end"
assert early.count('animation: tpMatrixGlyphReel 210ms steps(7, end) forwards;') == 1
assert early.count('className = "tp-matrix-reel";') == 1

new_animation = '''  const animationStyle = document.createElement("style");
  animationStyle.id = "tp-early-matrix-animation-style";
  animationStyle.textContent = `
    #matrixTitle .tp-matrix-window {
      display: inline-block;
      height: 1.15em;
      line-height: 1.15em;
      overflow: hidden;
      vertical-align: middle;
      contain: layout paint;
      transform: translateZ(0);
    }
    #matrixTitle .tp-matrix-strip {
      display: flex;
      flex-direction: column;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      will-change: transform;
      animation: tpMatrixWordStrip 1500ms steps(30, end) forwards;
    }
    #matrixTitle .tp-matrix-frame {
      display: block;
      flex: 0 0 1.15em;
      height: 1.15em;
      line-height: 1.15em;
      white-space: nowrap;
      text-align: center;
    }
    #matrixTitle .tp-matrix-frame:last-child {
      color: #eafff1;
    }
    #matrixTitle.tp-matrix-skip .tp-matrix-strip {
      animation: none !important;
      transform: translate3d(0, -34.5em, 0) !important;
    }
    @keyframes tpMatrixWordStrip {
      to { transform: translate3d(0, -34.5em, 0); }
    }
  `;
  document.head.appendChild(animationStyle);

  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];
  const totalSteps = 30;
  const framesPerLock = 3;
  const visualDurationMs = 1500;
  let completionScheduled = false;

  titleEl.innerHTML = "";
  const windowEl = document.createElement("span");
  windowEl.className = "tp-matrix-window";
  const strip = document.createElement("span");
  strip.className = "tp-matrix-strip";

  for (let frameIndex = 0; frameIndex <= totalSteps; frameIndex++){
    const lockedCount = Math.min(word.length, Math.floor(frameIndex / framesPerLock));
    let frameText = "";
    for (let charIndex = 0; charIndex < word.length; charIndex++){
      frameText += charIndex < lockedCount ? word[charIndex] : randomGlyph();
    }
    if (frameIndex === totalSteps) frameText = word;

    const frame = document.createElement("span");
    frame.className = "tp-matrix-frame";
    frame.textContent = frameText;
    strip.appendChild(frame);
  }

  windowEl.appendChild(strip);
  titleEl.appendChild(windowEl);

  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  strip.addEventListener("animationend", completeAfterVisual, { once: true });
  setTimeout(completeAfterVisual, visualDurationMs + 120);
'''
new_animation = "\n".join(line.rstrip() for line in new_animation.splitlines()) + "\n"
early = early[:replace_start] + new_animation + early[replace_end:]
text = text[:script_start] + early + text[script_end:]
path.write_text(text, encoding="utf-8")

verified = path.read_text(encoding="utf-8")
verify_start = verified.index(script_marker)
verify_end = verified.index("</script>", verify_start)
verify_early = verified[verify_start:verify_end]
assert verify_early.count('animation: tpMatrixWordStrip 1500ms steps(30, end) forwards;') == 1
assert verify_early.count('className = "tp-matrix-strip";') == 1
assert verify_early.count('className = "tp-matrix-frame";') == 1
assert verify_early.count('className = "tp-matrix-reel";') == 0
assert 'tpMatrixGlyphReel' not in verify_early
assert 'setInterval(' not in verify_early
assert verify_early.count('titleEl.classList.add("tp-matrix-skip")') == 1
assert verified.count("window.__tpMatrixFinishedPromise = new Promise") == 1

trigger = Path(".github/automation-triggers/single-strip-matrix.txt")
if trigger.exists():
    trigger.unlink()
Path(__file__).unlink()
