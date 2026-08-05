const test = require('node:test');
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
  assert.match(runtime, /const quietForNow = performance\.now\(\) - lastInteractionAt/);
  assert.match(runtime, /document\.hidden \|\| quietForNow < QUIET_MS/);
  assert.match(runtime, /queueBackgroundPopulate\(document\.hidden \? QUIET_MS : QUIET_MS - quietForNow\)/);
  assert.match(runtime, /result\?\.changed && result\?\.state/);
  assert.doesNotMatch(runtime, /DOMContentLoaded[^\n]*renderInbox/);
});

test('toolbar does not duplicate Inbox generation during Inbox startup', () => {
  const helper = between(toolbar, 'function scheduleTaskPointsInboxAuditAfterStartup()', 'function scheduleTaskPointsToolbarMaintenance()');
  const scheduler = between(toolbar, 'function scheduleTaskPointsToolbarMaintenance()', 'function initToolbarNow()');
  assert.match(toolbar, /function isInboxPagePathname\(pathname\)/);
  assert.match(scheduler, /isInboxPagePathname\(window\.location\.pathname\)/);
  assert.match(scheduler, /scheduleTaskPointsInboxAuditAfterStartup\(\)/);
  assert.match(helper, /runTaskPointsToolbarMaintenance\(\{ populateInbox: false \}\)/);
  assert.match(helper, /requestIdleCallback/);
  assert.match(helper, /document\.hidden/);
  assert.match(helper, /addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(helper, /schedule\(1000\)/);
  assert.match(helper, /schedule\(30000\)/);
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

test('Inbox update notifications are guarded when CustomEvent is unavailable', () => {
  const populate = between(toolbar, 'function autoPopulateTaskPointsInbox(options = {})', 'window.TaskPointsInbox =');
  assert.match(populate, /typeof window\.dispatchEvent === 'function'/);
  assert.match(populate, /typeof window\.CustomEvent === 'function'/);
  assert.match(populate, /new window\.CustomEvent\('taskpoints:inbox-updated'/);
});

test('Inbox badge accepts the page-known count and avoids redundant startup reads', () => {
  const start = between(badge, 'function start()', "global.addEventListener?.('storage'");
  assert.match(start, /global\.__tpInboxKnownCount/);
  assert.match(start, /if \(Number\.isFinite\(knownCount\)\) render\(knownCount\)/);
  assert.match(start, /if \(!observing\) global\.setTimeout\?\.\(refresh, 150\)/);
  assert.doesNotMatch(start, /setTimeout\?\.\(refresh, 0\)/);
  assert.match(badge, /event\?\.detail\?\.count/);
});
