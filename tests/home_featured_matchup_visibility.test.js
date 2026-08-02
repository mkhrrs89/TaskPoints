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
      getFeaturedSeasonMatchup: () => featured
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
  const state = { currentSeason: { id: 'season-aug', status: 'active' }, matchups: [] };
  const featured = {
    title: 'Player A vs Player B',
    roundName: 'Round of 32',
    gameNumber: 2,
    statusText: 'Player A leads 1–0',
    isEliminationGame: false
  };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-01');
  assert.equal(view.visible, true);
  assert.equal(mount.classList.contains('hidden'), false);
  assert.match(mount.innerHTML, /Featured Matchup/);
  assert.match(mount.innerHTML, /Player A vs Player B/);
  assert.match(mount.innerHTML, /Round of 32, Gm 2/);
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
  const state = { currentSeason: { id: 'season-next', status: 'locked' } };
  const featured = { title: 'Opening matchup', roundName: 'Play-In', gameNumber: 1, statusText: '' };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-01');
  assert.equal(view.visible, true);
  assert.equal(mount.classList.contains('hidden'), false);
});
