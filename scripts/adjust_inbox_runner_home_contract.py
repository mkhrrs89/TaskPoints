from pathlib import Path

path = Path('scripts/apply_inbox_first_paint.py')
text = path.read_text(encoding='utf-8')

old_block = '''old_schedule = ''' + "'''" + '''  const run = () => runTaskPointsToolbarMaintenance();
  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }
''' + "'''" + '''
new_schedule = ''' + "'''" + '''  const run = () => runTaskPointsToolbarMaintenance();
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
''' + "'''" + '''
toolbar = replace_once(toolbar, old_schedule, new_schedule, 'Inbox toolbar maintenance deferral')
'''

new_block = '''inbox_audit_helper = ''' + "'''" + '''function scheduleTaskPointsInboxAuditAfterStartup() {
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

''' + "'''" + '''
if inbox_audit_helper not in toolbar:
    marker = 'function scheduleTaskPointsToolbarMaintenance() {'
    if marker not in toolbar:
        raise SystemExit('Could not locate toolbar maintenance scheduler')
    toolbar = toolbar.replace(marker, inbox_audit_helper + marker, 1)

old_schedule = ''' + "'''" + '''  const run = () => runTaskPointsToolbarMaintenance();
  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }
''' + "'''" + '''
new_schedule = ''' + "'''" + '''  const run = () => runTaskPointsToolbarMaintenance();
  if (isInboxPagePathname(window.location.pathname)) {
    // inbox.html owns message generation after its first interactive paint.
    scheduleTaskPointsInboxAuditAfterStartup();
    return;
  }

  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }
''' + "'''" + '''
toolbar = replace_once(toolbar, old_schedule, new_schedule, 'Inbox toolbar maintenance deferral')
'''

if old_block not in text:
    raise SystemExit('Could not locate scheduler patch block in runner')
text = text.replace(old_block, new_block, 1)

old_test = '''test('toolbar does not duplicate Inbox generation during Inbox startup', () => {
  const scheduler = between(toolbar, 'function scheduleTaskPointsToolbarMaintenance()', 'function initToolbarNow()');
  assert.match(toolbar, /function isInboxPagePathname\\(pathname\\)/);
  assert.match(scheduler, /isInboxPagePathname\\(window\\.location\\.pathname\\)/);
  assert.match(scheduler, /runTaskPointsToolbarMaintenance\\(\\{ populateInbox: false \\}\\)/);
  assert.match(scheduler, /30000/);
});
'''
new_test = '''test('toolbar does not duplicate Inbox generation during Inbox startup', () => {
  const helper = between(toolbar, 'function scheduleTaskPointsInboxAuditAfterStartup()', 'function scheduleTaskPointsToolbarMaintenance()');
  const scheduler = between(toolbar, 'function scheduleTaskPointsToolbarMaintenance()', 'function initToolbarNow()');
  assert.match(toolbar, /function isInboxPagePathname\\(pathname\\)/);
  assert.match(scheduler, /isInboxPagePathname\\(window\\.location\\.pathname\\)/);
  assert.match(scheduler, /scheduleTaskPointsInboxAuditAfterStartup\\(\\)/);
  assert.match(helper, /runTaskPointsToolbarMaintenance\\(\\{ populateInbox: false \\}\\)/);
  assert.match(helper, /requestIdleCallback/);
  assert.match(helper, /30000/);
});
'''
if old_test not in text:
    raise SystemExit('Could not locate scheduler test in runner')
text = text.replace(old_test, new_test, 1)

path.write_text(text, encoding='utf-8')
