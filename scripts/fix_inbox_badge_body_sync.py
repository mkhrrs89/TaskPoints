from pathlib import Path

INBOX = Path('inbox.html')
BADGE = Path('inbox_count_badge.js')
BADGE_TEST = Path('tests/inbox_count_badge.test.js')
PERF_TEST = Path('tests/inbox_first_paint_performance.test.js')

inbox = INBOX.read_text(encoding='utf-8')
badge = BADGE.read_text(encoding='utf-8')
badge_test = BADGE_TEST.read_text(encoding='utf-8')
perf_test = PERF_TEST.read_text(encoding='utf-8')

old_refresh = '''  function refresh() {
    return render(countActiveInboxItems());
  }
'''
new_refresh = '''  function emitInboxStateSnapshotIfNeeded(state, count) {
    const knownCount = Number(global.__tpInboxKnownCount);
    if (!Number.isFinite(knownCount) || knownCount === count) return false;
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return false;

    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-state-snapshot', {
      detail: {
        count,
        inboxMessages: Array.isArray(state?.inboxMessages) ? state.inboxMessages : []
      }
    }));
    return true;
  }

  function refresh() {
    const state = readState();
    const count = countActiveInboxItems(state);
    render(count);
    emitInboxStateSnapshotIfNeeded(state, count);
    return count;
  }
'''
if new_refresh not in badge:
    if old_refresh not in badge:
        raise SystemExit('Could not locate Inbox badge refresh function')
    badge = badge.replace(old_refresh, new_refresh, 1)

old_storage_listener = '''  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) queueStoredRefresh();
  });

  renderInboxState(loadInboxState(), { source: "stored" });
'''
new_storage_listener = '''  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) queueStoredRefresh();
  });

  window.addEventListener("taskpoints:inbox-state-snapshot", (event) => {
    const messages = event?.detail?.inboxMessages;
    if (!Array.isArray(messages)) return;
    renderInboxState({ inboxMessages: messages }, { source: "badge-reconcile" });
  });

  renderInboxState(loadInboxState(), { source: "stored" });
'''
if new_storage_listener not in inbox:
    if old_storage_listener not in inbox:
        raise SystemExit('Could not locate Inbox storage listener')
    inbox = inbox.replace(old_storage_listener, new_storage_listener, 1)

old_window = '''    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
    }
  };
'''
new_window = '''    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent(event) {
      const callback = listeners.get(event?.type);
      if (callback) callback(event);
      return true;
    }
  };
'''
if new_window not in badge_test:
    if old_window not in badge_test:
        raise SystemExit('Could not locate Inbox badge test window stub')
    badge_test = badge_test.replace(old_window, new_window, 1)

badge_test_append = r'''

test('emits the current Inbox message snapshot when a later badge read disagrees with the page', () => {
  const state = { inboxMessages: [{ id: 'one' }, { id: 'two' }] };
  const { window } = makeContext(state);
  window.__tpInboxKnownCount = 0;

  let detail = null;
  window.addEventListener('taskpoints:inbox-state-snapshot', (event) => {
    detail = event.detail;
  });

  assert.equal(window.TaskPointsInboxCountBadge.refresh(), 2);
  assert.equal(detail?.count, 2);
  assert.deepEqual(Array.from(detail?.inboxMessages || [], (message) => message?.id), ['one', 'two']);
});

test('does not emit an Inbox snapshot when the badge and page counts already agree', () => {
  const state = { inboxMessages: [{ id: 'one' }, { id: 'two' }] };
  const { window } = makeContext(state);
  window.__tpInboxKnownCount = 2;

  let emitted = false;
  window.addEventListener('taskpoints:inbox-state-snapshot', () => {
    emitted = true;
  });

  assert.equal(window.TaskPointsInboxCountBadge.refresh(), 2);
  assert.equal(emitted, false);
});
'''
if "emits the current Inbox message snapshot when a later badge read disagrees with the page" not in badge_test:
    badge_test += badge_test_append

perf_test_append = r'''

test('Inbox body reconciles when a later badge read finds a fresher message snapshot', () => {
  const runtime = between(inbox, '<script id="tp-inbox-runtime">', '</script>');
  assert.match(runtime, /addEventListener\("taskpoints:inbox-state-snapshot"/);
  assert.match(runtime, /event\?\.detail\?\.inboxMessages/);
  assert.match(runtime, /renderInboxState\(\{ inboxMessages: messages \}, \{ source: "badge-reconcile" \}\)/);
  assert.match(badge, /function emitInboxStateSnapshotIfNeeded\(state, count\)/);
  assert.match(badge, /knownCount === count/);
  assert.match(badge, /taskpoints:inbox-state-snapshot/);
  assert.match(badge, /inboxMessages: Array\.isArray\(state\?\.inboxMessages\)/);
});
'''
if "Inbox body reconciles when a later badge read finds a fresher message snapshot" not in perf_test:
    perf_test += perf_test_append

INBOX.write_text(inbox, encoding='utf-8')
BADGE.write_text(badge, encoding='utf-8')
BADGE_TEST.write_text(badge_test, encoding='utf-8')
PERF_TEST.write_text(perf_test, encoding='utf-8')
