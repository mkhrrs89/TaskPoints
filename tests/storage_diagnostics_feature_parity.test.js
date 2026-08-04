const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'storage_diagnostics.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'storage_diagnostics.js'), 'utf8');

test('all original Storage Diagnostics sections remain present', () => {
  for (const id of [
    'runDiagnosticsBtn',
    'exportDiagnosticsBtn',
    'requestPersistenceBtn',
    'diagnosticStatus',
    'summaryCards',
    'warningsOutput',
    'timingsOutput',
    'collectionsOutput',
    'imagesOutput',
    'localStorageOutput',
    'browserStorageOutput'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should remain in the page`);
  }
});

test('all original report and control functions remain implemented', () => {
  for (const functionName of [
    'getLocalStorageReport',
    'parseStoredState',
    'buildCollectionReport',
    'getBrowserStorageReport',
    'getImageDatabaseReport',
    'buildWarnings',
    'renderSummaryCards',
    'renderWarnings',
    'renderTimings',
    'renderCollections',
    'renderImages',
    'renderLocalStorage',
    'renderBrowserStorage',
    'renderReport',
    'runDiagnostics',
    'exportDiagnostics',
    'requestPersistence'
  ]) {
    assert.match(source, new RegExp(`function ${functionName}\\b`), `${functionName} should remain implemented`);
  }
});

test('report export, persistence, and automatic initial scan remain wired', () => {
  assert.match(source, /exportDiagnosticsBtn'\)\?\.addEventListener\('click', exportDiagnostics\)/);
  assert.match(source, /requestPersistenceBtn'\)\?\.addEventListener\('click', requestPersistence\)/);
  assert.match(source, /runDiagnosticsBtn'\)\?\.addEventListener\('click'/);
  assert.match(source, /document\.readyState === 'loading'/);
  assert.match(source, /DOMContentLoaded/);
  assert.match(source, /taskpoints-storage-diagnostics-\$\{stamp\}\.json/);
  assert.match(source, /navigator\.storage\.persist\(\)/);
});
