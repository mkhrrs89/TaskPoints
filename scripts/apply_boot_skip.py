from pathlib import Path

INDEX = Path('index.html')
TEST = Path('tests/boot_animation_skip_contract.test.js')

text = INDEX.read_text(encoding='utf-8')

old_splash_css = '''    .bootSplash {
      position: fixed;
      inset: 0;
      background: #000;
      display: grid;
      place-items: center;
      z-index: 99999;
      opacity: 1;
      transition: opacity 140ms ease;
    }

    .matrixTitle {
'''
new_splash_css = '''    .bootSplash {
      position: fixed;
      inset: 0;
      background: #000;
      display: grid;
      place-items: center;
      z-index: 99999;
      opacity: 1;
      transition: opacity 140ms ease;
      touch-action: manipulation;
      cursor: pointer;
    }

    .bootSplashContent {
      display: grid;
      place-items: center;
      gap: 18px;
      text-align: center;
    }

    .bootSkipHint {
      color: rgba(200,255,216,0.62);
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      user-select: none;
      animation: tpBootSkipHintPulse 1.2s ease-in-out infinite alternate;
    }

    @keyframes tpBootSkipHintPulse {
      from { opacity: 0.42; }
      to { opacity: 0.82; }
    }

    .matrixTitle {
'''
if old_splash_css in text:
    text = text.replace(old_splash_css, new_splash_css, 1)
elif '.bootSkipHint {' not in text:
    raise SystemExit('Could not locate boot splash CSS')

old_markup = '''<div id="bootSplash" class="bootSplash" aria-hidden="true">
  <div id="matrixTitle" class="matrixTitle" role="img" aria-label="TASKPOINTS"></div>
</div>
'''
new_markup = '''<div
  id="bootSplash"
  class="bootSplash"
  role="button"
  tabindex="0"
  aria-label="TaskPoints opening animation. Tap anywhere to skip."
>
  <div class="bootSplashContent">
    <div id="matrixTitle" class="matrixTitle" role="img" aria-label="TASKPOINTS"></div>
    <div class="bootSkipHint" aria-hidden="true">Tap anywhere to skip</div>
  </div>
</div>
'''
if old_markup in text:
    text = text.replace(old_markup, new_markup, 1)
elif 'Tap anywhere to skip' not in text:
    raise SystemExit('Could not locate boot splash markup')

old_state = '''  let finishTimer = null;
  let skipCleanup = null;
  let resolveFinished;

  window.__tpMatrixFinished = false;
'''
new_state = '''  let finishTimer = null;
  let skipCleanup = null;
  let resolveFinished;
  let viewFinished = false;

  window.__tpMatrixFinished = false;
'''
if old_state in text:
    text = text.replace(old_state, new_state, 1)
elif 'let viewFinished = false;' not in text:
    raise SystemExit('Could not locate early boot state')

promise_marker = '''  window.__tpBootAnimStarted = true;

  const finish = () => {
'''
complete_boot = '''  window.__tpBootAnimStarted = true;

  const completeBootView = ({ skipped = false } = {}) => {
    if (viewFinished || window.__tpBootViewFinished) return true;

    const app = document.getElementById("appRoot");
    if (!app) {
      window.__tpBootRevealPending = { skipped: Boolean(skipped) };
      return false;
    }

    viewFinished = true;
    window.__tpBootViewFinished = true;
    window.__tpBootRevealPending = null;

    try { sessionStorage.setItem("tpBootSeenThisSession", "1"); } catch (e) {}
    document.documentElement.classList.remove("tp-boot-pending");
    document.documentElement.classList.add("tp-boot-seen");
    document.body.classList.remove("booting");

    app.style.visibility = "visible";
    app.style.opacity = "1";
    app.style.pointerEvents = "auto";

    if (splash) {
      splash.style.pointerEvents = "none";
      splash.style.transition = skipped ? "opacity 70ms ease" : "opacity 240ms ease";
      splash.style.opacity = "0";
      setTimeout(() => splash.remove(), skipped ? 80 : 260);
    }

    window.dispatchEvent(new Event("tp:bootFinished"));
    return true;
  };
  window.__tpCompleteBootView = completeBootView;

  const finish = () => {
'''
if promise_marker in text:
    text = text.replace(promise_marker, complete_boot, 1)
elif 'window.__tpCompleteBootView = completeBootView;' not in text:
    raise SystemExit('Could not install early boot completion function')

old_skip = '''  const requestSkip = () => {
    if (skipRequested || finished) return;
    skipRequested = true;
    titleEl.classList.add("tp-matrix-skip");
    finish();
  };
  splash.addEventListener("pointerdown", requestSkip, { passive: true });
  splash.addEventListener("click", requestSkip, { passive: true });
  skipCleanup = () => {
    splash.removeEventListener("pointerdown", requestSkip);
    splash.removeEventListener("click", requestSkip);
  };
'''
new_skip = '''  const requestSkip = () => {
    if (skipRequested || finished) return;
    skipRequested = true;
    titleEl.classList.add("tp-matrix-skip");
    finish();
    completeBootView({ skipped: true });
  };
  const requestSkipFromKey = (event) => {
    if (!["Enter", " ", "Escape"].includes(event.key)) return;
    event.preventDefault();
    requestSkip();
  };
  splash.addEventListener("pointerdown", requestSkip, { passive: true });
  splash.addEventListener("touchstart", requestSkip, { passive: true });
  splash.addEventListener("click", requestSkip, { passive: true });
  splash.addEventListener("keydown", requestSkipFromKey);
  skipCleanup = () => {
    splash.removeEventListener("pointerdown", requestSkip);
    splash.removeEventListener("touchstart", requestSkip);
    splash.removeEventListener("click", requestSkip);
    splash.removeEventListener("keydown", requestSkipFromKey);
  };
'''
if old_skip in text:
    text = text.replace(old_skip, new_skip, 1)
elif 'completeBootView({ skipped: true });' not in text:
    raise SystemExit('Could not locate early boot skip handler')

ready_marker = '''</div>

<script src="scoring_core.js"></script>  
'''
ready_replacement = '''</div>

<script id="tp-boot-skip-ready">
  if (window.__tpBootRevealPending && typeof window.__tpCompleteBootView === "function") {
    window.__tpCompleteBootView(window.__tpBootRevealPending);
  }
</script>
<script src="scoring_core.js"></script>  
'''
if ready_marker in text:
    text = text.replace(ready_marker, ready_replacement, 1)
elif 'id="tp-boot-skip-ready"' not in text:
    raise SystemExit('Could not locate app-root completion marker')

late_marker = '''  function finishBoot(){
    if (bootFinished) return;
    bootFinished = true;
    const splash = document.getElementById("bootSplash");
'''
late_replacement = '''  function finishBoot(){
    if (bootFinished || window.__tpBootViewFinished) {
      bootFinished = true;
      return;
    }
    bootFinished = true;

    if (typeof window.__tpCompleteBootView === "function" && window.__tpCompleteBootView({ skipped: false })) {
      return;
    }

    const splash = document.getElementById("bootSplash");
'''
if late_marker in text:
    text = text.replace(late_marker, late_replacement, 1)
elif 'window.__tpCompleteBootView({ skipped: false })' not in text:
    raise SystemExit('Could not update late boot gate')

INDEX.write_text(text, encoding='utf-8')

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
''', encoding='utf-8')
