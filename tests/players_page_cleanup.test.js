const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

test('Players header no longer has a standalone Projects link', () => {
  assert.doesNotMatch(src, /<a\s+href="projects\.html"[^>]*>Projects<\/a>/);
  assert.match(src, /href="gamehub\.html"/);
  assert.match(src, /href="settings\.html"/);
});

test('Stats Guide is last in the visible Players flow, hidden until intentionally opened', () => {
  const roster = src.indexOf('id="playersList"');
  const guide = src.indexOf('id="playerStatsGuide"');
  const editor = src.indexOf('id="playerEditorModal"');
  assert.ok(roster >= 0 && roster < guide && guide < editor);
  assert.match(src, /id="playerStatsGuide"[^>]*data-collapsed="true"/);
  assert.match(src, /id="playerStatsGuideBody"[^>]*hidden/);
  assert.match(src, /class="mobile-collapsible-header"[^>]*aria-expanded="false"/);
  assert.match(src, /#playerStatsGuide \.mobile-collapsible-body\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(src, /let(?:\s|\n)+isMobile|function setupMobileCollapsibles\(/);
  assert.doesNotMatch(src, /window\.addEventListener\("resize", syncForViewport\)/);
});

test('Stats Guide opens and closes on either viewport without losing its current state on resize', () => {
  const start = src.indexOf('function setupMobileCollapsibles() {');
  const end = src.indexOf('// The profile view is a single', start);
  assert.ok(start > -1 && end > start);
  const setup = new Function('document', src.slice(start, end) + '\nreturn setupMobileCollapsibles;');
  const attrs = {};
  const body = { hidden: true };
  const listeners = {};
  const header = {
    setAttribute(key, value) { attrs[key] = value; },
    addEventListener(key, fn) { listeners[key] = fn; }
  };
  const section = {
    dataset: { collapsed: 'true' },
    querySelector(query) { return query === '.mobile-collapsible-header' ? header : body; }
  };
  const document = { querySelectorAll() { return [section]; } };
  const init = setup(document);
  init();
  assert.equal(body.hidden, true);
  assert.equal(attrs['aria-expanded'], 'false');
  listeners.click();
  assert.equal(section.dataset.collapsed, 'false');
  assert.equal(body.hidden, false);
  assert.equal(attrs['aria-expanded'], 'true');
  listeners.click();
  assert.equal(body.hidden, true);
  init();
  assert.equal(body.hidden, true);
});

test('Players defaults directly to gallery with both manual views and mobile controls intact', () => {
  assert.match(src, /let viewMode = "gallery"/);
  assert.match(src, /id="playersList"[^>]*gallery-view/);
  assert.match(src, /id="viewGalleryBtn"/);
  assert.match(src, /id="viewCardBtn"/);
  assert.match(src, /id="groupActiveToggle"/);
  assert.match(src, /id="galleryColumnsControl"[^>]*class="flex/);
  assert.match(src, /id="galleryColumnsSelect"/);
  assert.match(src, /viewMode = "card";\s*editingPlayerId = null/);
  assert.match(src, /viewMode = "gallery";\s*editingPlayerId = null/);
});

test('Players toolbar removes the Players caption but retains sort and row controls', () => {
  const start = src.indexOf('<!-- Players list -->');
  const end = src.indexOf('id="playersList"', start);
  const toolbar = src.slice(start, end);
  assert.doesNotMatch(toolbar, /<h2[^>]*>Players<\/h2>/);
  assert.match(toolbar, /id="viewCardBtn"/);
  assert.match(toolbar, /id="viewGalleryBtn"/);
  assert.match(toolbar, /id="groupActiveToggle"/);
  assert.match(toolbar, /id="galleryColumnsSelect"/);
  assert.match(toolbar, /id="playerSort"/);
});

test('Manual simulation controls removed without disabling automatic game simulation', () => {
  assert.doesNotMatch(src, /id="openSimulationConfirmBtn"|id="runSimulationConfirmModal"|id="confirmRunSimulationBtn"/);
  assert.doesNotMatch(src, /<h2[^>]*>Simulate Today<\/h2>/);
  assert.match(src, /function simulateToday\(\)/);
  assert.match(src, /function maybeAutoSimToday\(\)/);
  assert.equal((src.match(/if \(\$\('simResults'\)\) \$\('simResults'\)\.innerHTML = `/g) || []).length, 2);
  assert.doesNotMatch(src, /setupSimulationConfirmModal\(\)/);
});

test('Embedded Players-page script still parses', () => {
  const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(text => text.trim());
  assert.ok(scripts.length >= 1);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
