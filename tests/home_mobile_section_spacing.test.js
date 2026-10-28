const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const MOBILE_RHYTHM_COMMENT = '/* Main Home mobile section rhythm: 16px between adjacent cards.';
const cssStart = css.indexOf(MOBILE_RHYTHM_COMMENT);
assert.ok(cssStart >= 0, 'Expected scoped mobile Home spacing rules');
const mobileRules = css.slice(cssStart);

function rule(selector) {
  const marker = selector + ' {';
  const start = mobileRules.lastIndexOf(marker);
  assert.ok(start >= 0, 'Missing mobile rule for ' + selector);
  return mobileRules.slice(start + marker.length, mobileRules.indexOf('}', start));
}

test('Home cards retain their order and every existing card remains present', () => {
  const tokens = [
    'id="homeTopCardStack"',
    'id="homeSeasonChampionshipMount"',
    'id="matchupStreakPanel"',
    'id="homeGraphWidget"',
    'id="homeWorkHoursSection"',
    'id="remindersSection"',
    'id="homeReminderSidecar"'
  ];
  const positions = tokens.map(token => html.indexOf(token));
  assert.ok(positions.every(index => index >= 0), 'Missing an existing Home section');
  assert.ok(positions.every((index, i) => i === 0 || index > positions[i - 1]),
    'Home sections have changed order');
});

test('All five mobile vertical section gaps resolve to 16px', () => {
  assert.match(mobileRules, /^\/\* Main Home mobile section rhythm:[\s\S]*?@media \(max-width: 767px\) \{/);
  assert.match(rule('#homeTopCardStack'), /margin-bottom:\s*16px\s*!important/);
  const betweenTop = rule('#homeTopCardStack > #homeSeasonChampionshipMount,\n  #homeTopCardStack > .inertiaTrendRow');
  assert.match(betweenTop, /margin-top:\s*16px\s*!important/);
  assert.match(betweenTop, /margin-bottom:\s*0\s*!important/);
  assert.match(rule('#homeTopCardStack > .inertiaTrendRow'), /row-gap:\s*16px/);
  assert.match(rule('#homeWorkHoursSection'), /margin-bottom:\s*16px\s*!important/);
  const reminders = rule('.home-reminders-row #remindersSection,\n  .home-reminders-row .home-reminders-sidecar');
  assert.match(reminders, /margin-top:\s*0\s*!important/);
});

test('An optional visible breakdown card also gets a consistent 16px gap', () => {
  assert.match(rule('#todayBreakdownCard'), /margin-bottom:\s*16px\s*!important/);
  assert.match(html, /id="todayBreakdownCard" class="mb-6 hidden"/);
});

test('Mobile-only scope preserves desktop spacing and panel functionality', () => {
  assert.match(html, /id="homeTopCardStack" class="space-y-3 mb-6"/);
  assert.match(html, /class="grid gap-3 inertiaTrendRow"/);
  assert.match(html, /id="homeWorkHoursSection" class="glass home-work-hours-card mb-6"/);
  assert.match(html, /id="homeReminderSidecar"/);
  assert.match(html, /id="homeWorkHoursProgress"/);
  assert.ok(mobileRules.startsWith(MOBILE_RHYTHM_COMMENT));
  assert.ok(mobileRules.trimEnd().endsWith('}'),
    'Last stylesheet override should be confined to the mobile media block');
});
