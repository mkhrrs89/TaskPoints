const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fullSource = fs.readFileSync(
  path.join(__dirname, '..', 'home_featured_matchup_visibility.js'),
  'utf8'
);
const marker = '(function installHomeStorageDiagnosticsLink(global) {';
const markerIndex = fullSource.indexOf(marker);
if (markerIndex < 0) throw new Error('Home Storage Diagnostics link module was not found.');
const source = fullSource.slice(markerIndex);

test('adds one Diagnostics link beside the Home Export button', () => {
  let insertedLink = null;
  let insertions = 0;
  const exportButton = {
    insertAdjacentElement(position, element) {
      assert.equal(position, 'afterend');
      insertedLink = element;
      insertions += 1;
    }
  };

  const document = {
    readyState: 'complete',
    getElementById(id) {
      return insertedLink?.id === id ? insertedLink : null;
    },
    querySelector(selector) {
      return selector === '[data-export-button]' ? exportButton : null;
    },
    createElement(tag) {
      assert.equal(tag, 'a');
      const attributes = new Map();
      return {
        id: '',
        href: '',
        className: '',
        textContent: '',
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) || null; }
      };
    },
    addEventListener() {}
  };

  const window = {
    document,
    setTimeout(callback) { callback(); return 1; },
    addEventListener() {}
  };
  window.window = window;
  window.globalThis = window;

  vm.runInNewContext(source, {
    window,
    document,
    globalThis: window,
    console
  }, { filename: 'home-storage-diagnostics-link.js' });

  assert.ok(insertedLink);
  assert.equal(insertedLink.id, 'tpHomeStorageDiagnosticsLink');
  assert.equal(insertedLink.href, 'storage_diagnostics.html');
  assert.equal(insertedLink.textContent, 'Diagnostics');
  assert.match(insertedLink.className, /btn-toolbar/);
  assert.equal(insertedLink.getAttribute('aria-label'), 'Open Storage Diagnostics');
  assert.equal(insertions, 1);

  assert.equal(window.TaskPointsHomeStorageDiagnosticsLink.install(), false);
  assert.equal(insertions, 1);
});
