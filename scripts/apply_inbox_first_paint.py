from pathlib import Path

INBOX = Path('inbox.html')
TOOLBAR = Path('toolbar.js')
BADGE = Path('inbox_count_badge.js')
TEST = Path('tests/inbox_first_paint_performance.test.js')

inbox = INBOX.read_text(encoding='utf-8')
toolbar = TOOLBAR.read_text(encoding='utf-8')
badge = BADGE.read_text(encoding='utf-8')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'Could not locate {label}')
    return text.replace(old, new, 1)


inbox = replace_once(
    inbox,
    '''  <link rel="preload" href="toolbar.js" as="script">\n  <script src="scoring_core.js"></script>\n  <script src="toolbar.js" defer></script>\n''',
    '''  <link rel="preload" href="scoring_core.js" as="script">\n  <link rel="preload" href="toolbar.js" as="script">\n  <script>\n    window.__TP_INBOX_BOOT_START = performance.now();\n    window.__TP_INBOX_PERF = new URLSearchParams(location.search).has('perf');\n  </script>\n  <script src="toolbar.js" defer></script>\n''',
    'Inbox head script order',
)

inbox = replace_once(
    inbox,
    '''    <div id="inboxEmpty" class="glass p-4 hidden">\n''',
    '''    <div id="inboxLoading" class="glass p-4" role="status" aria-live="polite">\n      <div class="text-lg font-bold">Loading inbox…</div>\n      <div class="muted text-sm mt-1">Showing saved results as soon as they are ready.</div>\n    </div>\n\n    <div id="inboxEmpty" class="glass p-4 hidden">\n''',
    'Inbox loading placeholder',
)

inbox = replace_once(
    inbox,
    '''  <div id="bottomToolbarMount"></div>\n\n<script>\n(() => {\n''',
    '''  <div id="bottomToolbarMount"></div>\n\n<script src="scoring_core.js"></script>\n<script id="tp-inbox-runtime">\n(() => {\n''',
    'deferred Inbox core position',
)

runtime_start = inbox.find('<script id="tp-inbox-runtime">\n(() => {')
runtime_end_marker = '})();\n</script>\n  \n</body>'
runtime_end = inbox.find(runtime_end_marker, runtime_start)
if runtime_start == -1 or runtime_end == -1:
    raise SystemExit('Could not locate Inbox runtime block')

new_runtime = r'''<script id="tp-inbox-runtime">
(() => {
  const STORAGE_KEY = window.TaskPointsCore?.STORAGE_KEY || "taskpoints_v1";
  const PERF = Boolean(window.__TP_INBOX_PERF);
  const BOOT_START = Number(window.__TP_INBOX_BOOT_START) || performance.now();
  const QUIET_MS = 2500;
  let firstRenderComplete = false;
  let populateComplete = false;
  let populateTimer = null;
  let refreshQueued = false;
  let lastInteractionAt = performance.now();

  function perfLog(message) {
    if (PERF) console.log(`[TP inbox perf] ${message}`);
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatInboxDate(dateKey) {
    const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(dateKey || "");
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day))
      .toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
  }

  function messageIcon(type) {
    if (type === "record") return "🏆";
    if (type === "series_advance") return "🏅";
    if (type === "series_upset") return "⚡";
    return "❗";
  }

  function loadInboxState() {
    const startedAt = performance.now();
    try {
      if (window.TaskPointsCore?.readTaskPointsStoredState) {
        return TaskPointsCore.readTaskPointsStoredState(STORAGE_KEY, {}) || {};
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      throw new Error("TaskPointsCore storage parser is unavailable; refusing to load partial state.");
    } catch (error) {
      console.warn("Inbox state could not be loaded", error);
      return {};
    } finally {
      perfLog(`stored-state-read ${(performance.now() - startedAt).toFixed(1)}ms`);
    }
  }

  function activeInboxMessages(state) {
    return (Array.isArray(state?.inboxMessages) ? state.inboxMessages : [])
      .filter((message) => message && message.archived !== true)
      .sort((a, b) => {
        const dateCompare = String(b.eventDateKey || "")
          .localeCompare(String(a.eventDateKey || ""));
        if (dateCompare) return dateCompare;
        return String(b.createdAtISO || "")
          .localeCompare(String(a.createdAtISO || ""));
      });
  }

  function renderInboxState(state, { source = "stored" } = {}) {
    const startedAt = performance.now();
    const messages = activeInboxMessages(state);
    const loading = document.getElementById("inboxLoading");
    const empty = document.getElementById("inboxEmpty");
    const list = document.getElementById("inboxMessages");
    if (!empty || !list) return messages;

    loading?.classList.add("hidden");
    empty.classList.toggle("hidden", messages.length > 0);

    list.innerHTML = messages.map((message) => {
      const href = message.relatedPage || "#";
      return `
        <a href="${esc(href)}" class="glass p-4 block">
          <div class="flex items-start gap-3">
            <div class="text-2xl leading-none" aria-hidden="true">
              ${messageIcon(message.type)}
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <div class="font-extrabold">${esc(message.title || "Inbox message")}</div>
                <div class="muted text-xs whitespace-nowrap">
                  ${esc(formatInboxDate(message.eventDateKey))}
                </div>
              </div>

              <div class="text-sm mt-1 leading-relaxed">
                ${esc(message.body || "")}
              </div>
            </div>
          </div>
        </a>
      `;
    }).join("");

    window.__tpInboxKnownCount = messages.length;
    window.TaskPointsInboxCountBadge?.render?.(messages.length);
    perfLog(`${source}-render ${(performance.now() - startedAt).toFixed(1)}ms count=${messages.length}`);

    if (!firstRenderComplete) {
      firstRenderComplete = true;
      requestAnimationFrame(() => {
        perfLog(`boot->first-render ${(performance.now() - BOOT_START).toFixed(1)}ms`);
      });
    }

    return messages;
  }

  function clearPopulateTimer() {
    if (populateTimer === null) return;
    clearTimeout(populateTimer);
    populateTimer = null;
  }

  function queueBackgroundPopulate(delayMs = QUIET_MS) {
    if (populateComplete) return;
    clearPopulateTimer();
    populateTimer = setTimeout(tryBackgroundPopulate, Math.max(0, delayMs));
  }

  function markInteraction() {
    lastInteractionAt = performance.now();
    queueBackgroundPopulate(QUIET_MS);
  }

  function tryBackgroundPopulate() {
    populateTimer = null;
    if (populateComplete) return;
    if (document.hidden) {
      queueBackgroundPopulate(QUIET_MS);
      return;
    }

    const quietFor = performance.now() - lastInteractionAt;
    if (quietFor < QUIET_MS) {
      queueBackgroundPopulate(QUIET_MS - quietFor);
      return;
    }

    const run = () => {
      if (populateComplete) return;
      if (!window.TaskPointsInbox?.populate) {
        queueBackgroundPopulate(250);
        return;
      }

      const startedAt = performance.now();
      const result = window.TaskPointsInbox.populate();
      populateComplete = true;
      if (result?.changed && result?.state) {
        renderInboxState(result.state, { source: "generated" });
      }
      perfLog(`background-populate ${(performance.now() - startedAt).toFixed(1)}ms changed=${Boolean(result?.changed)} skipped=${Boolean(result?.skipped)}`);
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 5000 });
    } else {
      setTimeout(run, 0);
    }
  }

  function queueStoredRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      renderInboxState(loadInboxState(), { source: "storage-event" });
      populateComplete = false;
      queueBackgroundPopulate(QUIET_MS);
    });
  }

  ["pointerdown", "touchstart", "wheel", "keydown"].forEach((eventName) => {
    window.addEventListener(eventName, markInteraction, { passive: eventName !== "keydown" });
  });
  window.addEventListener("scroll", markInteraction, { passive: true });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) queueStoredRefresh();
  });

  renderInboxState(loadInboxState(), { source: "stored" });
  requestAnimationFrame(() => requestAnimationFrame(() => queueBackgroundPopulate(QUIET_MS)));
})();
</script>
  
</body>'''

inbox = inbox[:runtime_start] + new_runtime + inbox[runtime_end + len(runtime_end_marker):]

checkpoint_helpers = r'''
const TP_INBOX_SCAN_CHECKPOINT_KEY = 'taskpoints_inbox_scan_checkpoint_v1';
const TP_INBOX_SCAN_ALGORITHM_VERSION = '20260805-1';

function tpInboxRawFingerprint(raw) {
  const value = String(raw || '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function tpInboxReadStorageFingerprint(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return typeof raw === 'string' ? tpInboxRawFingerprint(raw) : '';
  } catch (_) {
    return '';
  }
}

function tpInboxReadScanCheckpoint() {
  try {
    const raw = localStorage.getItem(TP_INBOX_SCAN_CHECKPOINT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function tpInboxScanCheckpointMatches({ revealDayKey, fingerprint }) {
  if (!revealDayKey || !fingerprint) return false;
  const checkpoint = tpInboxReadScanCheckpoint();
  return Boolean(
    checkpoint
    && checkpoint.version === TP_INBOX_SCAN_ALGORITHM_VERSION
    && checkpoint.revealDayKey === revealDayKey
    && checkpoint.fingerprint === fingerprint
  );
}

function tpInboxWriteScanCheckpoint({ revealDayKey, fingerprint }) {
  if (!revealDayKey || !fingerprint) return false;
  try {
    localStorage.setItem(TP_INBOX_SCAN_CHECKPOINT_KEY, JSON.stringify({
      version: TP_INBOX_SCAN_ALGORITHM_VERSION,
      revealDayKey,
      fingerprint,
      checkedAtISO: new Date().toISOString()
    }));
    return true;
  } catch (_) {
    return false;
  }
}

'''

if checkpoint_helpers not in toolbar:
    marker = 'function autoPopulateTaskPointsInbox() {'
    if marker not in toolbar:
        raise SystemExit('Could not locate Inbox population function')
    toolbar = toolbar.replace(marker, checkpoint_helpers + 'function autoPopulateTaskPointsInbox(options = {}) {', 1)

old_populate_body = '''function autoPopulateTaskPointsInbox(options = {}) {
  if (!window.TaskPointsCore?.loadAppState || !window.TaskPointsCore?.mergeAndSaveState) return null;
  try {
    const loaded = TaskPointsCore.loadAppState({ syncDerived: true, persistSync: true });
    const result = tpGenerateInboxMessages(loaded?.state || {});
    if (result.changed) {
      TaskPointsCore.mergeAndSaveState({
        inboxMessages: result.state.inboxMessages,
        inboxProcessedEventIds: result.state.inboxProcessedEventIds,
        inboxStartedDateKey: result.state.inboxStartedDateKey
      }, {
        savePath: 'inbox-auto-populate',
        immediateWrite: true,
        assumeNormalized: true
      });
    }
    return result;
  } catch (error) {
    console.warn('TaskPoints Inbox auto-population failed', error);
    return null;
  }
}
'''
new_populate_body = '''function autoPopulateTaskPointsInbox(options = {}) {
  if (!window.TaskPointsCore?.loadAppState || !window.TaskPointsCore?.mergeAndSaveState) return null;

  const storageKey = window.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const now = options.now instanceof Date ? options.now : new Date();
  const revealDayKey = tpInboxRevealDayKey(now);
  const sourceFingerprint = tpInboxReadStorageFingerprint(storageKey);

  if (!options.force && tpInboxScanCheckpointMatches({ revealDayKey, fingerprint: sourceFingerprint })) {
    return {
      changed: false,
      skipped: true,
      reason: 'unchanged-source',
      revealDayKey
    };
  }

  try {
    const loaded = TaskPointsCore.loadAppState({ syncDerived: true, persistSync: true });
    const result = tpGenerateInboxMessages(loaded?.state || {}, { now });
    if (result.changed) {
      TaskPointsCore.mergeAndSaveState({
        inboxMessages: result.state.inboxMessages,
        inboxProcessedEventIds: result.state.inboxProcessedEventIds,
        inboxStartedDateKey: result.state.inboxStartedDateKey
      }, {
        savePath: 'inbox-auto-populate',
        immediateWrite: true,
        assumeNormalized: true
      });

      const activeCount = (Array.isArray(result.state.inboxMessages) ? result.state.inboxMessages : [])
        .filter((message) => message && message.archived !== true)
        .length;
      window.dispatchEvent?.(new CustomEvent('taskpoints:inbox-updated', {
        detail: { count: activeCount }
      }));
    } else {
      const finalFingerprint = tpInboxReadStorageFingerprint(storageKey) || sourceFingerprint;
      tpInboxWriteScanCheckpoint({ revealDayKey, fingerprint: finalFingerprint });
    }
    return { ...result, skipped: false, revealDayKey };
  } catch (error) {
    console.warn('TaskPoints Inbox auto-population failed', error);
    return null;
  }
}
'''
if old_populate_body in toolbar:
    toolbar = toolbar.replace(old_populate_body, new_populate_body, 1)
elif "reason: 'unchanged-source'" not in toolbar:
    raise SystemExit('Could not replace Inbox population body')

old_maintenance = '''function runTaskPointsToolbarMaintenance() {
  autoPopulateTaskPointsInbox();
  try {
'''
new_maintenance = '''function runTaskPointsToolbarMaintenance(options = {}) {
  if (options.populateInbox !== false) autoPopulateTaskPointsInbox();
  try {
'''
toolbar = replace_once(toolbar, old_maintenance, new_maintenance, 'toolbar maintenance options')

old_path_helper = '''function isMainPagePathname(pathname) {
  return pathname === '/' || pathname.endsWith('/index.html');
}
'''
new_path_helper = '''function isMainPagePathname(pathname) {
  return pathname === '/' || pathname.endsWith('/index.html');
}

function isInboxPagePathname(pathname) {
  return pathname === '/inbox.html' || pathname.endsWith('/inbox.html');
}
'''
toolbar = replace_once(toolbar, old_path_helper, new_path_helper, 'Inbox pathname helper')

old_schedule = '''  const run = () => runTaskPointsToolbarMaintenance();
  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }
'''
new_schedule = '''  const run = () => runTaskPointsToolbarMaintenance();
  if (isInboxPagePathname(window.location.pathname)) {
    // inbox.html owns message generation after its first interactive paint.
    // Keep the duplicate-completion audit, but do not let it contend with opening the page.
    window.setTimeout(() => {
      const auditOnly = () => runTaskPointsToolbarMaintenance({ populateInbox: false });
      if (document.hidden) return;
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(auditOnly, { timeout: 5000 });
      } else {
        window.setTimeout(auditOnly, 0);
      }
    }, 30000);
    return;
  }

  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }
'''
toolbar = replace_once(toolbar, old_schedule, new_schedule, 'Inbox toolbar maintenance deferral')

old_observe = '''  function observeLinks() {
    const document = global.document;
    if (observer || typeof global.MutationObserver !== 'function' || !document?.documentElement) return;
    observer = new global.MutationObserver((mutations) => {
'''
new_observe = '''  function observeLinks() {
    const document = global.document;
    if (observer) return true;
    if (typeof global.MutationObserver !== 'function' || !document?.documentElement) return false;
    observer = new global.MutationObserver((mutations) => {
'''
badge = replace_once(badge, old_observe, new_observe, 'badge observer return value')

old_observe_end = '''    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    refresh();
    observeLinks();
    global.setTimeout?.(refresh, 0);
    global.setTimeout?.(refresh, 150);
  }
'''
new_observe_end = '''    observer.observe(document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function start() {
    const knownCount = Number(global.__tpInboxKnownCount);
    if (Number.isFinite(knownCount)) render(knownCount);
    else refresh();

    const observing = observeLinks();
    // MutationObserver normally catches toolbar links inserted after startup.
    // Keep one delayed fallback only for older environments without it.
    if (!observing) global.setTimeout?.(refresh, 150);
  }
'''
badge = replace_once(badge, old_observe_end, new_observe_end, 'badge startup read deduplication')

old_updated_listener = '''  global.addEventListener?.('taskpoints:inbox-updated', queueRefresh);
'''
new_updated_listener = '''  global.addEventListener?.('taskpoints:inbox-updated', (event) => {
    const count = Number(event?.detail?.count);
    if (Number.isFinite(count)) render(count);
    else queueRefresh();
  });
'''
badge = replace_once(badge, old_updated_listener, new_updated_listener, 'badge direct update count')

INBOX.write_text(inbox, encoding='utf-8')
TOOLBAR.write_text(toolbar, encoding='utf-8')
BADGE.write_text(badge, encoding='utf-8')

TEST.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inbox = fs.readFileSync(path.join(__dirname, '..', 'inbox.html'), 'utf8');
const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar.js'), 'utf8');
const badge = fs.readFileSync(path.join(__dirname, '..', 'inbox_count_badge.js'), 'utf8');

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test('Inbox parses its visible shell before loading the large scoring bundle', () => {
  const head = between(inbox, '<head>', '</head>');
  assert.match(head, /preload" href="scoring_core\.js" as="script"/);
  assert.doesNotMatch(head, /<script src="scoring_core\.js"><\/script>/);

  const loadingIndex = inbox.indexOf('id="inboxLoading"');
  const coreIndex = inbox.indexOf('<script src="scoring_core.js"></script>');
  const runtimeIndex = inbox.indexOf('id="tp-inbox-runtime"');
  assert.ok(loadingIndex > 0 && coreIndex > loadingIndex && runtimeIndex > coreIndex);
});

test('Inbox renders stored messages immediately and generates rollover messages later', () => {
  const runtime = between(inbox, '<script id="tp-inbox-runtime">', '</script>');
  assert.match(runtime, /renderInboxState\(loadInboxState\(\), \{ source: "stored" \}\)/);
  assert.match(runtime, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => queueBackgroundPopulate/);
  assert.match(runtime, /const QUIET_MS = 2500/);
  assert.match(runtime, /\["pointerdown", "touchstart", "wheel", "keydown"\]/);
  assert.match(runtime, /window\.addEventListener\("scroll", markInteraction/);
  assert.match(runtime, /requestIdleCallback\(run, \{ timeout: 5000 \}\)/);
  assert.match(runtime, /result\?\.changed && result\?\.state/);
  assert.doesNotMatch(runtime, /DOMContentLoaded[^\n]*renderInbox/);
});

test('toolbar does not duplicate Inbox generation during Inbox startup', () => {
  const scheduler = between(toolbar, 'function scheduleTaskPointsToolbarMaintenance()', 'function initToolbarNow()');
  assert.match(toolbar, /function isInboxPagePathname\(pathname\)/);
  assert.match(scheduler, /isInboxPagePathname\(window\.location\.pathname\)/);
  assert.match(scheduler, /runTaskPointsToolbarMaintenance\(\{ populateInbox: false \}\)/);
  assert.match(scheduler, /30000/);
});

test('unchanged Inbox scans use a day and full compressed-state fingerprint checkpoint', () => {
  assert.match(toolbar, /TP_INBOX_SCAN_CHECKPOINT_KEY = 'taskpoints_inbox_scan_checkpoint_v1'/);
  assert.match(toolbar, /TP_INBOX_SCAN_ALGORITHM_VERSION = '20260805-1'/);
  assert.match(toolbar, /for \(let index = 0; index < value\.length; index \+= 1\)/);
  assert.match(toolbar, /checkpoint\.revealDayKey === revealDayKey/);
  assert.match(toolbar, /checkpoint\.fingerprint === fingerprint/);
  assert.match(toolbar, /reason: 'unchanged-source'/);
  assert.match(toolbar, /if \(result\.changed\)/);
  assert.match(toolbar, /else \{\s*const finalFingerprint/);
});

test('Inbox badge accepts the page-known count and avoids redundant startup reads', () => {
  const start = between(badge, 'function start()', "global.addEventListener?.('storage'");
  assert.match(start, /global\.__tpInboxKnownCount/);
  assert.match(start, /if \(Number\.isFinite\(knownCount\)\) render\(knownCount\)/);
  assert.match(start, /if \(!observing\) global\.setTimeout\?\.\(refresh, 150\)/);
  assert.doesNotMatch(start, /setTimeout\?\.\(refresh, 0\)/);
  assert.match(badge, /event\?\.detail\?\.count/);
});
''', encoding='utf-8')
