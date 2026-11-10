const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'mobile_boot_gate.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const marker = 'export { isHomePagePath, transformHomeBoot };';
const moduleSource = source.slice(0, source.lastIndexOf(marker));
const coordinatorHtml = new Function(moduleSource + String.fromCharCode(10) + 'return COORDINATOR_SCRIPT;')();
const coordinatorJs = coordinatorHtml.slice(coordinatorHtml.indexOf('>') + 1, coordinatorHtml.lastIndexOf('</script>'));

function setup() {
  const nodes = new Map();
  const timers = [];
  let reveals = 0;
  function element(id = '') {
    const node = {
      id, textContent: '', style: {}, attributes: {}, children: [],
      classList: { add() {}, remove() {} },
      addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); nodes.set(child.id, child); return child; },
      remove() { nodes.delete(this.id); }
    };
    return node;
  }
  const title = element('matrixTitle');
  const splash = element('bootSplash');
  nodes.set('matrixTitle', title);
  nodes.set('bootSplash', splash);
  const body = element('body');
  const document = {
    body, documentElement: { classList: { contains(name) { return name === 'tp-boot-pending'; } } },
    getElementById(id) { return nodes.get(id) || null; },
    createElement() { return element(); },
    addEventListener() {}, removeEventListener() {}
  };
  const window = {
    addEventListener() {}, removeEventListener() {},
    __tpCompleteBootView() { reveals++; }
  };
  const context = {
    window, document, Promise, Event: class Event { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} disconnect() {} },
    performance: { now() { return 100; } },
    console: { error() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}
  };
  vm.runInNewContext(coordinatorJs, context);
  return { window, document, nodes, timers, reveals: () => reveals };
}

test('after eleven seconds of stalled startup a visible, tappable Recovery link is outside the splash', () => {
  const h = setup();
  assert.ok(home.includes(':not(#bootSplash):not(#tp-boot-recovery-notice)'), 'startup CSS must not conceal the recovery notice');
  assert.ok(home.includes('if (viewFinished || window.__tpMobileBootCoordinator?.isRevealed?.()) return;'),
    'animation-complete flag must not cancel the data-load watchdog');
  const watchdog = h.timers.find(x => x.ms === 11000);
  assert.ok(watchdog, 'coordinator must have its own independent timeout');
  watchdog.fn();
  const notice = h.nodes.get('tp-boot-recovery-notice');
  assert.ok(notice, 'Recovery notice must be created');
  assert.ok(h.document.body.children.includes(notice), 'notice must be outside intercepting splash');
  assert.equal(notice.children[2].href, '/emergency_recovery.html');
  assert.match(notice.style.cssText, /pointer-events:auto/);
  assert.equal(h.reveals(), 0, 'must never show empty Home just to unblock user');
});

test('a rejected runtime shows Recovery instead of remaining on a silent loading splash', async () => {
  const h = setup();
  const coordinator = h.window.__tpMobileBootCoordinator;
  coordinator.installRuntimeStarter(() => Promise.reject(new Error('simulated load failure')));
  coordinator.requestReveal({ skipped: true });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(h.nodes.has('tp-boot-recovery-notice'));
  assert.equal(coordinator.isRevealed(), false);
  assert.equal(h.reveals(), 0);
});

test('successful initialization removes an earlier slow-startup notice', async () => {
  const h = setup();
  h.timers.find(x => x.ms === 11000).fn();
  const coordinator = h.window.__tpMobileBootCoordinator;
  coordinator.installRuntimeStarter(() => {
    coordinator.requestReveal({ skipped: true });
  });
  coordinator.requestReveal({ skipped: true });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(coordinator.isRevealed(), true);
  assert.equal(h.reveals(), 1);
  assert.equal(h.nodes.has('tp-boot-recovery-notice'), false);
});
