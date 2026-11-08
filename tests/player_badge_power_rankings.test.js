const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const achievementsSource = fs.readFileSync(path.resolve(__dirname, '..', 'achievements.html'), 'utf8');
const rankingsSource = fs.readFileSync(path.resolve(__dirname, '..', 'rankings_tournament_trophies.js'), 'utf8');

function installRankingsHelper() {
  const document = {
    readyState: 'complete',
    documentElement: null,
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        className: '',
        textContent: '',
        src: '',
        alt: '',
        title: ''
      };
    }
  };
  const context = vm.createContext({
    console,
    JSON,
    Map,
    Set,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    location: { pathname: '/rankings.html' },
    localStorage: { getItem: () => null },
    document,
    setTimeout: () => 0,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      loadAppState: () => ({ state: {} }),
      computeCanonicalRankings: () => []
    }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(rankingsSource, context, { filename: 'rankings_tournament_trophies.js' });
  return context.TaskPointsRankingsTournamentTrophies;
}

test('Badges page points Retro Winner at the bronze trophy asset', () => {
  assert.match(achievementsSource, /icon:\s*'assets\/retrowinner\.PNG'/);
  assert.match(achievementsSource, /class="earnedBadgeIcon"/);
});

test('Badges page saves assignments immediately before rerendering', () => {
  assert.match(achievementsSource, /immediateWrite:\s*true/);
  assert.match(achievementsSource, /savePath:\s*'achievements-player-badge'/);
  assert.match(achievementsSource, /userInitiated:\s*true/);
  assert.match(achievementsSource, /const savedState = saveAchievementsPageState\(next\);\s*renderBadgesTab\(savedState\);/s);
});

test('badge normalization accepts both string and object-backed historical entries', () => {
  const api = installRankingsHelper();
  assert.deepEqual(Array.from(api.normalizeBadgeIds(['retroWinner', { id: 'other' }, { badgeId: 'retroWinner' }])), ['retroWinner', 'other']);
  assert.equal(api.hasRetroWinnerBadge({ playerBadges: { CARL: ['retroWinner'] } }, 'CARL', 'Carl'), true);
  assert.equal(api.hasRetroWinnerBadge({ playerBadges: { CARL: [{ id: 'retroWinner' }] } }, 'CARL', 'Carl'), true);
  assert.equal(api.hasRetroWinnerBadge({ playerBadges: { Carl: [{ badgeId: 'retroWinner' }] } }, 'CARL', 'Carl'), true);
  assert.equal(api.hasRetroWinnerBadge({ playerBadges: { CARL: [] } }, 'CARL', 'Carl'), false);
});

test('Power Rankings bronze badge uses the same compact scale as the tournament trophy marker', () => {
  assert.match(rankingsSource, /RETRO_BADGE_ICON = 'assets\/retrowinner\.PNG'/);
  assert.match(rankingsSource, /\.ranking-trophy-mark\}\{?[^`]*font-size:0\.72em/);
  assert.match(rankingsSource, /\.\$\{RETRO_BADGE_CLASS\}\{width:0\.72em;height:0\.72em/);
});

test('Power Rankings can render tournament trophies and Retro Winner badge together', () => {
  const api = installRankingsHelper();
  const children = [];
  const nameElement = {
    textContent: '',
    appendChild(node) { children.push(node); },
    querySelector(selector) {
      const className = String(selector).replace(/^\./, '');
      return children.find((node) => node.className === className) || null;
    }
  };

  api.renderDecoratedName(nameElement, 'Carl', 2, true);

  assert.equal(nameElement.textContent, 'Carl');
  assert.equal(children.length, 2);
  assert.equal(children[0].className, 'ranking-trophy-mark');
  assert.equal(children[0].textContent, ' 🏆🏆');
  assert.equal(children[1].className, 'ranking-retro-winner-badge');
  assert.equal(children[1].src, 'assets/retrowinner.PNG');
  assert.equal(children[1].alt, 'Retro Winner');
});
