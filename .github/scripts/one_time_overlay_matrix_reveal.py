from pathlib import Path

path = Path("index.html")
text = path.read_text(encoding="utf-8")
script_marker = '<script id="tp-early-matrix-bootstrap">'
script_start = text.index(script_marker)
script_end = text.index("</script>", script_start)
early = text[script_start:script_end]

if 'className = "tp-matrix-final-layer"' not in early:
    replace_start = early.index('  const animationStyle = document.createElement("style");')
    replace_end = early.rfind("\n})();")
    assert replace_end > replace_start, "Could not locate Matrix animation block end"

    new_animation = '''  const animationStyle = document.createElement("style");
  animationStyle.id = "tp-early-matrix-animation-style";
  animationStyle.textContent = `
    #matrixTitle .tp-matrix-stage {
      position: relative;
      display: inline-block;
      height: 1.15em;
      line-height: 1.15em;
      white-space: nowrap;
      contain: layout paint;
      transform: translateZ(0);
    }
    #matrixTitle .tp-matrix-scramble-window {
      display: block;
      height: 1.15em;
      line-height: 1.15em;
      overflow: hidden;
    }
    #matrixTitle .tp-matrix-scramble-strip {
      display: flex;
      flex-direction: column;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      will-change: transform;
      animation: tpMatrixScrambleStrip 220ms steps(4, end) forwards;
    }
    #matrixTitle .tp-matrix-scramble-frame {
      display: block;
      flex: 0 0 1.15em;
      height: 1.15em;
      line-height: 1.15em;
      white-space: nowrap;
      text-align: center;
    }
    #matrixTitle .tp-matrix-final-layer {
      position: absolute;
      inset: 0;
      color: #eafff1;
      white-space: nowrap;
      text-align: center;
      clip-path: inset(0 100% 0 0);
      -webkit-clip-path: inset(0 100% 0 0);
      transform: translateZ(0);
      will-change: clip-path;
      animation: tpMatrixReveal 900ms steps(10, end) 220ms forwards;
    }
    #matrixTitle.tp-matrix-skip .tp-matrix-scramble-strip {
      animation: none !important;
      transform: translate3d(0, -4.6em, 0) !important;
    }
    #matrixTitle.tp-matrix-skip .tp-matrix-final-layer {
      animation: none !important;
      clip-path: inset(0 0 0 0) !important;
      -webkit-clip-path: inset(0 0 0 0) !important;
    }
    @keyframes tpMatrixScrambleStrip {
      to { transform: translate3d(0, -4.6em, 0); }
    }
    @keyframes tpMatrixReveal {
      to {
        clip-path: inset(0 0 0 0);
        -webkit-clip-path: inset(0 0 0 0);
      }
    }
  `;
  document.head.appendChild(animationStyle);

  const randomGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];
  const scrambleFrameCount = 5;
  const visualDurationMs = 1120;
  let completionScheduled = false;

  const randomWord = () => {
    let value = "";
    for (let index = 0; index < word.length; index++) value += randomGlyph();
    return value;
  };

  titleEl.innerHTML = "";
  const stage = document.createElement("span");
  stage.className = "tp-matrix-stage";

  const scrambleWindow = document.createElement("span");
  scrambleWindow.className = "tp-matrix-scramble-window";
  const scrambleStrip = document.createElement("span");
  scrambleStrip.className = "tp-matrix-scramble-strip";

  for (let frameIndex = 0; frameIndex < scrambleFrameCount; frameIndex++){
    const frame = document.createElement("span");
    frame.className = "tp-matrix-scramble-frame";
    frame.textContent = randomWord();
    scrambleStrip.appendChild(frame);
  }

  const finalLayer = document.createElement("span");
  finalLayer.className = "tp-matrix-final-layer";
  finalLayer.textContent = word;

  scrambleWindow.appendChild(scrambleStrip);
  stage.appendChild(scrambleWindow);
  stage.appendChild(finalLayer);
  titleEl.appendChild(stage);

  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  finalLayer.addEventListener("animationend", completeAfterVisual, { once: true });
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
assert verified.count('id="tp-early-matrix-bootstrap"') == 1
assert verify_early.count('className = "tp-matrix-final-layer"') == 1
assert verify_early.count('animation: tpMatrixReveal 900ms steps(10, end) 220ms forwards;') == 1
assert verify_early.count('animation: tpMatrixScrambleStrip 220ms steps(4, end) forwards;') == 1
assert 'tp-matrix-strip' not in verify_early
assert 'totalSteps' not in verify_early
assert verify_early.count("setInterval(") == 0
assert verify_early.count('titleEl.classList.add("tp-matrix-skip")') == 1
assert verified.count("window.__tpMatrixFinishedPromise = new Promise") == 1

trigger = Path(".github/automation-triggers/overlay-matrix-reveal.txt")
if trigger.exists():
    trigger.unlink()
Path(__file__).unlink()
