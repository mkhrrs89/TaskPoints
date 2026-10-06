const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('Yesterday Results panel is keyboard/tap interactive and controls recent results dropdown', () => {
  assert.match(index, /id="yesterdayResultsPanel"[\s\S]*role="button"[\s\S]*tabindex="0"[\s\S]*aria-expanded="false"[\s\S]*aria-controls="yesterdayRecentResultsDropdown"/);
  assert.match(index, /panel\.addEventListener\('click',[\s\S]*toggleYesterdayRecentResultsDropdown\(\)/);
  assert.match(index, /event\.key !== 'Enter' && event\.key !== ' '/);
});

test('recent results dropdown uses exactly the last five completed user matchups', () => {
  assert.match(index, /getCompletedYouMatchupsForStats\(\)\.slice\(0, 5\)/);
  assert.match(index, /opponentName:\s*getPlayerNameById\(opponentId\)/);
  assert.match(index, /Number\(row\.youScore\)\.toFixed\(1\)/);
  assert.match(index, /Number\(row\.oppScore\)\.toFixed\(1\)/);
});

test('tapping anywhere inside the open dropdown retracts it', () => {
  assert.match(index, /dropdown\.addEventListener\('click',[\s\S]*closeYesterdayRecentResultsDropdown\(\)/);
  assert.match(index, /dropdown\.classList\.remove\('is-open'\)/);
  assert.match(index, /panel\.setAttribute\('aria-expanded', 'false'\)/);
});

test('recent results dropdown animates downward but remains below bottom toolbar layer', () => {
  assert.match(styles, /\.yesterday-recent-results-dropdown\s*\{[\s\S]*transform-origin:\s*top center;/);
  assert.match(styles, /clip-path:\s*inset\(0 0 100% 0/);
  assert.match(styles, /\.yesterday-recent-results-dropdown\.is-open\s*\{[\s\S]*clip-path:\s*inset\(0 0 0 0/);
  assert.match(styles, /z-index:\s*calc\(var\(--tp-z-toolbar-popup-layer\) - 1\);/);
  assert.match(index, /window\.innerHeight - rect\.bottom - toolbarHeight/);
});

test('recent results dropdown stays anchored to the Yesterday panel and repositions on viewport movement', () => {
  assert.match(index, /rect\.right - desiredWidth/);
  assert.match(index, /dropdown\.style\.top = `\$\{Math\.round\(rect\.bottom\)\}px`/);
  assert.match(index, /window\.addEventListener\('resize', scheduleYesterdayRecentResultsPosition/);
  assert.match(index, /window\.addEventListener\('scroll', scheduleYesterdayRecentResultsPosition/);
});
