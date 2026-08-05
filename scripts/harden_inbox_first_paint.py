from pathlib import Path

TOOLBAR = Path('toolbar.js')
TEST = Path('tests/inbox_first_paint_performance.test.js')

toolbar = TOOLBAR.read_text(encoding='utf-8')
test = TEST.read_text(encoding='utf-8')

old_event = '''      window.dispatchEvent?.(new CustomEvent('taskpoints:inbox-updated', {
        detail: { count: activeCount }
      }));
'''
new_event = '''      if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('taskpoints:inbox-updated', {
          detail: { count: activeCount }
        }));
      }
'''
if new_event not in toolbar:
    if old_event not in toolbar:
        raise SystemExit('Could not locate Inbox update event dispatch')
    toolbar = toolbar.replace(old_event, new_event, 1)

old_audit = '''function scheduleTaskPointsInboxAuditAfterStartup() {
  window.setTimeout(() => {
    const auditOnly = () => runTaskPointsToolbarMaintenance({ populateInbox: false });
    if (document.hidden) return;
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(auditOnly, { timeout: 5000 });
    } else {
      window.setTimeout(auditOnly, 0);
    }
  }, 30000);
}
'''
new_audit = '''function scheduleTaskPointsInboxAuditAfterStartup() {
  let completed = false;
  let timer = null;
  let visibilityBound = false;

  const cleanup = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = false;
    }
  };

  const runWhenIdle = () => {
    if (completed) return;
    if (document.hidden) {
      if (!visibilityBound) {
        visibilityBound = true;
        document.addEventListener('visibilitychange', onVisibilityChange);
      }
      return;
    }

    const auditOnly = () => {
      if (completed || document.hidden) {
        if (!completed) schedule(5000);
        return;
      }
      completed = true;
      cleanup();
      runTaskPointsToolbarMaintenance({ populateInbox: false });
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(auditOnly, { timeout: 5000 });
    } else {
      window.setTimeout(auditOnly, 0);
    }
  };

  const schedule = (delayMs) => {
    if (completed) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      runWhenIdle();
    }, delayMs);
  };

  function onVisibilityChange() {
    if (document.hidden || completed) return;
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = false;
    }
    schedule(1000);
  }

  schedule(30000);
}
'''
if new_audit not in toolbar:
    if old_audit not in toolbar:
        raise SystemExit('Could not locate Inbox audit scheduler')
    toolbar = toolbar.replace(old_audit, new_audit, 1)

old_assertions = '''  assert.match(helper, /runTaskPointsToolbarMaintenance\\(\\{ populateInbox: false \\}\\)/);
  assert.match(helper, /requestIdleCallback/);
  assert.match(helper, /30000/);
});
'''
new_assertions = '''  assert.match(helper, /runTaskPointsToolbarMaintenance\\(\\{ populateInbox: false \\}\\)/);
  assert.match(helper, /requestIdleCallback/);
  assert.match(helper, /document\\.hidden/);
  assert.match(helper, /addEventListener\\('visibilitychange', onVisibilityChange\\)/);
  assert.match(helper, /schedule\\(1000\\)/);
  assert.match(helper, /schedule\\(30000\\)/);
});
'''
if new_assertions not in test:
    if old_assertions not in test:
        raise SystemExit('Could not locate Inbox audit scheduler assertions')
    test = test.replace(old_assertions, new_assertions, 1)

checkpoint_test = '''
test('Inbox update notifications are guarded when CustomEvent is unavailable', () => {
  const populate = between(toolbar, 'function autoPopulateTaskPointsInbox(options = {})', 'window.TaskPointsInbox =');
  assert.match(populate, /typeof window\\.dispatchEvent === 'function'/);
  assert.match(populate, /typeof window\\.CustomEvent === 'function'/);
  assert.match(populate, /new window\\.CustomEvent\\('taskpoints:inbox-updated'/);
});
'''
if checkpoint_test not in test:
    marker = "\ntest('Inbox badge accepts the page-known count and avoids redundant startup reads', () => {"
    if marker not in test:
        raise SystemExit('Could not locate final Inbox badge test')
    test = test.replace(marker, checkpoint_test + marker, 1)

TOOLBAR.write_text(toolbar, encoding='utf-8')
TEST.write_text(test, encoding='utf-8')
