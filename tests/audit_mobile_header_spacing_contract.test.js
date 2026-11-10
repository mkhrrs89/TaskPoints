const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const audit = fs.readFileSync(path.join(root, 'audit.html'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');

test('Audit page clears the iPhone status bar without shifting desktop layout', () => {
  assert.match(audit, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"\/>/);
  assert.match(audit, /class="audit-page-frame mx-auto max-w-6xl p-4 sm:p-6 pb-20 md:pb-10"/);
  assert.match(audit, /@media \(max-width: 767px\)\s*\{\s*\.audit-page-frame\s*\{\s*padding-top: max\(64px, calc\(env\(safe-area-inset-top, 0px\) \+ 14px\)\);/);
  assert.doesNotMatch(audit, /@media \(min-width: 768px\)[\s\S]*?\.audit-page-frame\s*\{/);
});

test('Audit removes only the upper Projects shortcut, not the Projects feature', () => {
  const header = audit.split('<!-- HEADER -->')[1]?.split('</header>')[0];
  assert.ok(header, 'Audit header should still exist');
  assert.doesNotMatch(header, /<a href="projects\.html"[^>]*>Projects<\/a>/);
  assert.match(toolbar, /<a href="projects\.html" class="mobile-bottom-nav-btn/);
  assert.match(header, /href="index\.html"/);
  assert.match(header, /href="season\.html"/);
  assert.match(header, /href="settings\.html"/);
});

test('Audit calculations, export/import and mobile navigation stay intact', () => {
  for (const marker of [
    'data-export-button', 'data-import-input', 'id="auditDate"', 'id="runAuditBtn"',
    'id="syncMatchupsBtn"', 'id="syncNotesBtn"', 'id="copyReportBtn"',
    'id="exportJsonBtn"', 'id="auditProgressWrap"', 'id="auditSummaryMeta"',
    'id="auditHighlights"', 'id="auditChecks"', 'id="bottomToolbarMount"'
  ]) {
    assert.ok(audit.includes(marker), marker + ' must be preserved');
  }
  assert.match(audit, /bindPress\('runAuditBtn', runAudit\)/);
  assert.match(audit, /runAudit\(\);\s*\}\);/);
});
