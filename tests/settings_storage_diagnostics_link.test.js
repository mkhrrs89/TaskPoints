const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const responsiveExportSource = fs.readFileSync(
  path.join(__dirname, '..', 'home_export_responsiveness.js'),
  'utf8'
);
const homeFeaturedSource = fs.readFileSync(
  path.join(__dirname, '..', 'home_featured_matchup_visibility.js'),
  'utf8'
);
const marker = '(function installSettingsStorageDiagnosticsLink(global) {';
const markerIndex = responsiveExportSource.indexOf(marker);
if (markerIndex < 0) throw new Error('Settings Storage Diagnostics link module was not found.');
const source = responsiveExportSource.slice(markerIndex);

function install(pathname = '/settings.html') {
  let appendedLink = null;
  let appendCount = 0;
  const attributes = new Map();
  const actionRow = {
    appendChild(node) {
      appendedLink = node;
      appendCount += 1;
      return node;
    }
  };
  const section = {
    querySelector(selector) {
      assert.equal(selector, '.flex.flex-wrap.items-center.justify-end.gap-2');
      return actionRow;
    }
  };
  const document = {
    readyState: 'complete',
    getElementById(id) {
      if (id === 'storageHealthSection') return section;
      if (id === 'storageDiagnosticsLink' && appendedLink) return appendedLink;
      return null;
    },
    createElement(tag) {
      assert.equal(tag, 'a');
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
    location: { pathname },
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
  }, { filename: 'settings-storage-diagnostics-link.js' });

  return { window, appendedLink, getAppendCount: () => appendCount };
}

test('adds one Storage Diagnostics link inside the Settings Storage Health action row', () => {
  const result = install('/app/settings.html');
  const link = result.appendedLink;

  assert.ok(link);
  assert.equal(link.id, 'storageDiagnosticsLink');
  assert.equal(link.href, 'storage_diagnostics.html');
  assert.equal(link.textContent, 'Storage Diagnostics');
  assert.match(link.className, /\bbtn\b/);
  assert.match(link.className, /\bbtn-toolbar\b/);
  assert.match(link.className, /\bnav-btn\b/);
  assert.equal(link.getAttribute('aria-label'), 'Open Storage Diagnostics');
  assert.equal(result.getAppendCount(), 1);

  assert.equal(result.window.TaskPointsSettingsStorageDiagnosticsLink.install(), true);
  assert.equal(result.getAppendCount(), 1);
});

test('does not add the Settings link on the Home page', () => {
  const result = install('/index.html');
  assert.equal(result.appendedLink, null);
  assert.equal(result.getAppendCount(), 0);
  assert.equal(result.window.TaskPointsSettingsStorageDiagnosticsLink.install(), false);
});

test('the Home featured-matchup module contains no diagnostics-link injection', () => {
  assert.doesNotMatch(homeFeaturedSource, /installHomeStorageDiagnosticsLink/);
  assert.doesNotMatch(homeFeaturedSource, /tpHomeStorageDiagnosticsLink/);
  assert.doesNotMatch(homeFeaturedSource, /storage_diagnostics\.html/);
});
