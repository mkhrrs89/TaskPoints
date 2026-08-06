from pathlib import Path

INDEX = Path('index.html')
TEST = Path('tests/boot_animation_sequence_contract.test.js')

html = INDEX.read_text(encoding='utf-8')

replacements = [
    (
'''  let finishTimer = null;
  let skipCleanup = null;
''',
'''  let finishTimer = null;
  let visualFallbackTimer = null;
  let skipCleanup = null;
'''
    ),
    (
'''  window.__tpCompleteBootView = completeBootView;

  const finish = () => {
''',
'''  window.__tpCompleteBootView = completeBootView;

  const settleMatrixTitle = () => {
    if (!titleEl) return;
    titleEl.classList.remove("tp-matrix-running");
    titleEl.textContent = word;
  };
  window.__tpForceMatrixFinal = settleMatrixTitle;

  const finish = () => {
'''
    ),
    (
'''    if (finishTimer !== null) clearTimeout(finishTimer);
    if (typeof skipCleanup === "function") skipCleanup();
''',
'''    if (finishTimer !== null) clearTimeout(finishTimer);
    if (visualFallbackTimer !== null) clearTimeout(visualFallbackTimer);
    if (typeof skipCleanup === "function") skipCleanup();
'''
    ),
    (
'''    window.dispatchEvent(new Event("tp:matrixFinished"));
  };

  if (!splash || !titleEl){
''',
'''    window.dispatchEvent(new Event("tp:matrixFinished"));
  };
  window.__tpForceMatrixCompletion = () => {
    settleMatrixTitle();
    finish();
  };

  if (!splash || !titleEl){
'''
    ),
    (
'''    skipRequested = true;
    titleEl.classList.add("tp-matrix-skip");
    finish();
''',
'''    skipRequested = true;
    titleEl.classList.add("tp-matrix-skip");
    settleMatrixTitle();
    finish();
'''
    ),
    (
'''  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    titleEl.textContent = word;
    finishTimer = setTimeout(finish, 180);
''',
'''  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    settleMatrixTitle();
    finishTimer = setTimeout(finish, 180);
'''
    ),
    (
'''      will-change: transform;
      animation: tpMatrixDecodeChar var(--tp-char-duration) steps(6, end) var(--tp-char-delay) both;
    }
''',
'''      will-change: transform;
      animation: none;
    }
    #matrixTitle.tp-matrix-running .tp-matrix-char-strip {
      animation: tpMatrixDecodeChar var(--tp-char-duration) steps(6, end) var(--tp-char-delay) both;
    }
'''
    ),
    (
'''  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  lastStrip?.addEventListener("animationend", completeAfterVisual, { once: true });
  setTimeout(completeAfterVisual, visualDurationMs + 120);
''',
'''  const completeAfterVisual = () => {
    if (completionScheduled || skipRequested || finished) return;
    completionScheduled = true;
    settleMatrixTitle();
    setTimeout(() => {
      if (skipRequested || finished) return;
      finishTimer = setTimeout(finish, 180);
    }, 80);
  };

  lastStrip?.addEventListener("animationend", completeAfterVisual, { once: true });

  const startVisualAnimation = () => {
    if (skipRequested || finished || titleEl.classList.contains("tp-matrix-running")) return;
    try { performance.mark("tp-matrix-visual-started"); } catch (e) {}
    titleEl.classList.add("tp-matrix-running");
    visualFallbackTimer = setTimeout(completeAfterVisual, visualDurationMs + 400);
  };
  const nextFrame = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback) => setTimeout(callback, 16);
  nextFrame(() => nextFrame(startVisualAnimation));
'''
    ),
    (
'''  // failsafe in case the bootstrap cannot complete
  setTimeout(finishBoot, 4000);
''',
'''  // Failsafe in case the compositor animation cannot complete. Always settle
  // the visible title before revealing Home so random glyphs never leak through.
  setTimeout(() => {
    window.__tpForceMatrixCompletion?.();
    finishBoot();
  }, 5000);
'''
    ),
]

for old, new in replacements:
    if new in html:
        continue
    if old not in html:
        raise SystemExit(f'Could not locate guarded animation block:\n{old[:120]}')
    html = html.replace(old, new, 1)

INDEX.write_text(html, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
append = r'''

test('visual sequence begins only after blank slots have received two paint opportunities', () => {
  assert.match(early, /animation: none/);
  assert.match(early, /#matrixTitle\.tp-matrix-running \.tp-matrix-char-strip/);
  assert.match(early, /nextFrame\(\(\) => nextFrame\(startVisualAnimation\)\)/);
  assert.match(early, /titleEl\.classList\.add\("tp-matrix-running"\)/);
  assert.match(early, /visualFallbackTimer = setTimeout\(completeAfterVisual, visualDurationMs \+ 400\)/);
});

test('normal, skipped, and failsafe completion always settle a clean TASKPOINTS title', () => {
  assert.match(early, /const settleMatrixTitle = \(\) =>/);
  assert.match(early, /titleEl\.textContent = word/);
  assert.match(early, /window\.__tpForceMatrixCompletion = \(\) =>/);
  assert.match(early, /completionScheduled = true;\s+settleMatrixTitle\(\)/);
  assert.match(early, /skipRequested = true;[\s\S]*settleMatrixTitle\(\);[\s\S]*finish\(\)/);
  assert.match(html, /window\.__tpForceMatrixCompletion\?\.\(\);\s+finishBoot\(\);/);
});
'''
if 'visual sequence begins only after blank slots have received two paint opportunities' not in test:
    test += append
TEST.write_text(test, encoding='utf-8')
