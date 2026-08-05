from pathlib import Path

INBOX = Path('inbox.html')
TEST = Path('tests/inbox_first_paint_performance.test.js')

inbox = INBOX.read_text(encoding='utf-8')
test = TEST.read_text(encoding='utf-8')

old_run = '''    const run = () => {
      if (populateComplete) return;
      if (!window.TaskPointsInbox?.populate) {
        queueBackgroundPopulate(250);
        return;
      }

      const startedAt = performance.now();
'''
new_run = '''    const run = () => {
      if (populateComplete) return;

      const quietForNow = performance.now() - lastInteractionAt;
      if (document.hidden || quietForNow < QUIET_MS) {
        queueBackgroundPopulate(document.hidden ? QUIET_MS : QUIET_MS - quietForNow);
        return;
      }

      if (!window.TaskPointsInbox?.populate) {
        queueBackgroundPopulate(250);
        return;
      }

      const startedAt = performance.now();
'''

if new_run not in inbox:
    if old_run not in inbox:
        raise SystemExit('Could not locate Inbox idle populate callback')
    inbox = inbox.replace(old_run, new_run, 1)

old_test = '''  assert.match(runtime, /requestIdleCallback\\(run, \\{ timeout: 5000 \\}\\)/);
  assert.match(runtime, /result\\?\\.changed && result\\?\\.state/);
'''
new_test = '''  assert.match(runtime, /requestIdleCallback\\(run, \\{ timeout: 5000 \\}\\)/);
  assert.match(runtime, /const quietForNow = performance\\.now\\(\\) - lastInteractionAt/);
  assert.match(runtime, /document\\.hidden \\|\\| quietForNow < QUIET_MS/);
  assert.match(runtime, /queueBackgroundPopulate\\(document\\.hidden \\? QUIET_MS : QUIET_MS - quietForNow\\)/);
  assert.match(runtime, /result\\?\\.changed && result\\?\\.state/);
'''

if new_test not in test:
    if old_test not in test:
        raise SystemExit('Could not locate Inbox idle callback contract assertions')
    test = test.replace(old_test, new_test, 1)

INBOX.write_text(inbox, encoding='utf-8')
TEST.write_text(test, encoding='utf-8')
