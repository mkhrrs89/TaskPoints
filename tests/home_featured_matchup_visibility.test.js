const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_featured_matchup_visibility.js'), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(['hidden']); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    if (force === true) this.add(value);
    else if (force === false) this.remove(value);
    else if (this.values.has(value)) this.remove(value);
    else this.add(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeMount {
  constructor() {
    this.classList = new FakeClassList();
    this.innerHTML = '';
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) || null; }
}

function makeContext({ state, featured }) {
  const mount = new FakeMount();
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    getElementById: (id) => id === 'homeSeasonChampionshipMount' ? mount : null,
    addEventListener() {}
  };
  const window = {
    document,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      loadAppState: () => ({ state }),
      getFeaturedSeasonMatchup: () => featured,
      getSeasonSeriesLength: (roundId, season) => {
        const round = (season?.dateWindows || []).find((item) => item.id === roundId);
        return round?.bestOf || null;
      }
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); },
    addEventListener() {},
    MutationObserver: class { observe() {} }
  };
  const context = vm.createContext({
    window,
    document,
    globalThis: window,
    console,
    module: { exports: {} },
    Set,
    Date
  });
  vm.runInContext(source, context);
  return { window, mount };
}

test('shows an August featured matchup for an active current season', () => {
  const state = {
    currentSeason: {
      id: 'season-aug',
      status: 'active',
      series: {
        'series-1': { id: 'series-1', roundId: 'round_of_32', bestOf: 5 }
      }
    },
    matchups: []
  };
  const featured = {
    title: 'Player A vs Player B',
    seriesId: 'series-1',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    gameNumber: 2,
    statusText: 'Player A leads 1–0',
    isEliminationGame: false
  };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-01');
  assert.equal(view.visible, true);
  assert.equal(view.bestOf, 5);
  assert.equal(mount.classList.contains('hidden'), false);
  assert.match(mount.innerHTML, /Featured Matchup/);
  assert.match(mount.innerHTML, /Player A vs Player B/);
  assert.match(mount.innerHTML, /Round of 32, Gm 2/);
  assert.match(mount.innerHTML, /Best of 5/);
});

test('falls back to the configured round length when featured data has no series best-of', () => {
  const state = {
    currentSeason: {
      id: 'season-aug',
      status: 'active',
      dateWindows: [{ id: 'finals', displayName: 'Finals', bestOf: 7 }]
    }
  };
  const featured = {
    title: 'Player A vs Player B',
    roundId: 'finals',
    roundName: 'Finals',
    gameNumber: 1,
    statusText: 'Series tied 0–0'
  };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-25');
  assert.equal(view.bestOf, 7);
  assert.match(mount.innerHTML, /Best of 7/);
});

test('keeps the section hidden when there is no active tournament', () => {
  const state = { currentSeason: { id: 'season-july', status: 'draft' } };
  const { window, mount } = makeContext({ state, featured: null });
  mount.innerHTML = '<p>old content</p>';

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-07-10');
  assert.equal(view.visible, false);
  assert.equal(mount.classList.contains('hidden'), true);
  assert.equal(mount.innerHTML, '');
});

test('hides a completed tournament instead of showing a June-specific message', () => {
  const state = { currentSeason: { id: 'season-june', status: 'champion_crowned' } };
  const { window, mount } = makeContext({ state, featured: null });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-06-30');
  assert.equal(view.visible, false);
  assert.equal(mount.classList.contains('hidden'), true);
  assert.doesNotMatch(source, /June 2026 tournament is complete/);
});

test('supports locked tournament seasons before the first result', () => {
  const state = {
    currentSeason: {
      id: 'season-next',
      status: 'locked',
      dateWindows: [{ id: 'play_in', displayName: 'Play-In', bestOf: 3 }]
    }
  };
  const featured = {
    title: 'Opening matchup',
    roundId: 'play_in',
    roundName: 'Play-In',
    gameNumber: 1,
    statusText: ''
  };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-01');
  assert.equal(view.visible, true);
  assert.equal(view.bestOf, 3);
  assert.equal(mount.classList.contains('hidden'), false);
  assert.match(mount.innerHTML, /Best of 3/);
});
