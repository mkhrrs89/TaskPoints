const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'inbox_count_badge.js'), 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(selector) {
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.children.find((child) => String(child.className).split(/\s+/).includes(className)) || null;
    }
    return null;
  }
  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (selector === 'a[href]' && child.tagName === 'A' && child.getAttribute('href')) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function makeContext(state) {
  const documentElement = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement,
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    getElementById(id) {
      const all = [documentElement, head, body, ...documentElement.querySelectorAll('a[href]')];
      return all.find((item) => item.id === id || item.getAttribute?.('id') === id) || null;
    },
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener() {}
  };
  const listeners = new Map();
  const window = {
    document,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      readTaskPointsStoredState: () => state
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    setTimeout(callback) { callback(); },
    requestAnimationFrame(callback) { callback(); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
    }
  };
  const context = vm.createContext({ window, document, globalThis: window, console, module: { exports: {} } });
  vm.runInContext(source, context);
  return { window, document, body, listeners };
}

function addLink(body, href, text = 'Inbox', className = '') {
  const link = new FakeElement('a');
  link.setAttribute('href', href);
  link.textContent = text;
  link.className = className;
  body.appendChild(link);
  return link;
}

test('counts only active inbox items', () => {
  const state = { inboxMessages: [{ id: 1 }, { id: 2, archived: false }, { id: 3, archived: true }, null] };
  const { window } = makeContext(state);
  assert.equal(window.TaskPointsInboxCountBadge.count(), 2);
});

test('renders exact orange count badge on every inbox link', () => {
  const state = { inboxMessages: [{}, {}, {}] };
  const { window, body } = makeContext(state);
  const mobile = addLink(body, 'inbox.html', 'Inbox', 'mobile-bottom-nav-btn');
  const desktop = addLink(body, '/app/inbox.html?from=nav', 'Inbox');
  const unrelated = addLink(body, 'index.html', 'Home');

  assert.equal(window.TaskPointsInboxCountBadge.refresh(), 3);
  for (const link of [mobile, desktop]) {
    const badge = link.querySelector('.tp-inbox-count-badge');
    assert.ok(badge);
    assert.equal(badge.textContent, '3');
    assert.equal(badge.hidden, false);
    assert.equal(link.getAttribute('data-inbox-count'), '3');
    assert.equal(link.getAttribute('aria-label'), 'Inbox, 3 inbox items');
  }
  assert.equal(unrelated.querySelector('.tp-inbox-count-badge'), null);
});

test('hides the badge when the inbox becomes empty', () => {
  const state = { inboxMessages: [{}] };
  const { window, body } = makeContext(state);
  const link = addLink(body, 'inbox.html', 'Inbox');
  window.TaskPointsInboxCountBadge.refresh();
  const badge = link.querySelector('.tp-inbox-count-badge');
  assert.ok(badge);

  state.inboxMessages = [];
  assert.equal(window.TaskPointsInboxCountBadge.refresh(), 0);
  assert.equal(badge.hidden, true);
  assert.equal(badge.style.display, 'none');
  assert.equal(link.getAttribute('data-inbox-count'), null);
  assert.equal(link.getAttribute('aria-label'), 'Inbox');
});

test('preserves the full count instead of capping large inboxes', () => {
  const state = { inboxMessages: Array.from({ length: 127 }, (_, id) => ({ id })) };
  const { window, body } = makeContext(state);
  const link = addLink(body, 'inbox.html', 'Inbox');
  window.TaskPointsInboxCountBadge.refresh();
  assert.equal(link.querySelector('.tp-inbox-count-badge').textContent, '127');
});
