const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_featured_matchup_visibility.js'), 'utf8');

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
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

class FakeElement {
  constructor({ textContent = '', className = '' } = {}) {
    this.textContent = textContent;
    this.className = className;
    this.classList = new FakeClassList(className ? className.split(/\s+/) : []);
    this.attributes = new Map();
    this.removed = false;
    this.after = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  insertAdjacentElement(position, element) {
    assert.equal(position, 'afterend');
    this.after = element;
  }
  remove() { this.removed = true; }
}

class FakeMount extends FakeElement {
  constructor() {
    super();
    this.classList = new FakeClassList(['hidden']);
    this.innerHTML = '';
  }
}

class FakeScoreboard extends FakeElement {
  constructor() {
    super({ className: 'home-scoreboard-card' });
    this.seriesLine = new FakeElement({ textContent: 'SERIES: 0–0' });
    this.labels = [];
  }
  querySelectorAll(selector) {
    if (selector === 'div, span, p, strong') return [this.seriesLine];
    if (selector === '.home-scoreboard-series-format') return this.labels.filter((label) => !label.removed);
    return [];
  }
}

function makeContext({ state, featured }) {
  const mount = new FakeMount();
  const scoreboard = new FakeScoreboard();
  const head = { appendChild() {} };
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    head,
    getElementById: (id) => id === 'homeSeasonChampionshipMount' ? mount : null,
    querySelector: (selector) => selector === '.home-scoreboard-card' ? scoreboard : null,
    createElement: (tag) => {
      const element = new FakeElement();
      if (tag === 'div') scoreboard.labels.push(element);
      return element;
    },
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
  return { window, mount, scoreboard };
}

function activeState(bestOf = 5) {
  return {
    currentSeason: {
      id: 'season-aug',
      status: 'active',
      series: {
        'series-you': { id: 'series-you', roundId: 'round_of_32', bestOf }
      }
    },
    matchups: [{
      dateKey: '2026-08-01',
      playerAId: 'YOU',
      playerBId: 'opponent-1',
      seriesId: 'series-you',
      roundId: 'round_of_32',
      roundName: 'Opening Round'
    }]
  };
}

test('featured matchup no longer includes a Best of label', () => {
  const state = activeState(5);
  const featured = {
    title: 'Player A vs Player B',
    seriesId: 'series-featured',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    gameNumber: 2,
    statusText: 'Player A leads 1–0',
    bestOf: 5
  };
  const { window, mount } = makeContext({ state, featured });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-08-01');
  assert.equal(view.visible, true);
  assert.equal(mount.classList.contains('hidden'), false);
  assert.match(mount.innerHTML, /Featured Matchup/);
  assert.match(mount.innerHTML, /Player A vs Player B/);
  assert.doesNotMatch(mount.innerHTML, /Best of/i);
});

test('places Best of directly after the SERIES line in the user current-series scoreboard', () => {
  const state = activeState(5);
  const { window, scoreboard } = makeContext({ state, featured: null });

  const result = window.TaskPointsHomeFeaturedMatchup.renderCurrentSeriesBestOf(state, '2026-08-01');
  assert.equal(result.visible, true);
  assert.equal(result.bestOf, 5);
  assert.ok(scoreboard.seriesLine.after);
  assert.equal(scoreboard.seriesLine.after.textContent, 'Best of 5');
  assert.equal(scoreboard.seriesLine.after.className, 'home-scoreboard-series-format');
});

test('uses configured round length for the current user series when series bestOf is absent', () => {
  const state = {
    currentSeason: {
      id: 'season-aug',
      status: 'active',
      dateWindows: [{ id: 'finals', displayName: 'Finals', bestOf: 7 }]
    },
    matchups: [{
      dateKey: '2026-08-25',
      playerAId: 'opponent-1',
      playerBId: 'YOU',
      roundId: 'finals',
      roundName: 'Finals'
    }]
  };
  const { window, scoreboard } = makeContext({ state, featured: null });

  const result = window.TaskPointsHomeFeaturedMatchup.renderCurrentSeriesBestOf(state, '2026-08-25');
  assert.equal(result.bestOf, 7);
  assert.equal(scoreboard.seriesLine.after.textContent, 'Best of 7');
});

test('does not show Best of when today scoreboard is not the users current series', () => {
  const state = {
    currentSeason: { id: 'season-aug', status: 'active' },
    matchups: [{ dateKey: '2026-08-01', playerAId: 'a', playerBId: 'b', bestOf: 3 }]
  };
  const { window, scoreboard } = makeContext({ state, featured: null });

  const result = window.TaskPointsHomeFeaturedMatchup.renderCurrentSeriesBestOf(state, '2026-08-01');
  assert.equal(result.visible, false);
  assert.equal(scoreboard.seriesLine.after, null);
});

test('keeps featured section hidden when there is no active tournament', () => {
  const state = { currentSeason: { id: 'season-july', status: 'draft' }, matchups: [] };
  const { window, mount } = makeContext({ state, featured: null });
  mount.innerHTML = '<p>old content</p>';

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-07-10');
  assert.equal(view.visible, false);
  assert.equal(mount.classList.contains('hidden'), true);
  assert.equal(mount.innerHTML, '');
});

test('hides a completed tournament instead of showing a June-specific message', () => {
  const state = { currentSeason: { id: 'season-june', status: 'champion_crowned' }, matchups: [] };
  const { window, mount } = makeContext({ state, featured: null });

  const view = window.TaskPointsHomeFeaturedMatchup.render(state, '2026-06-30');
  assert.equal(view.visible, false);
  assert.equal(mount.classList.contains('hidden'), true);
  assert.doesNotMatch(source, /June 2026 tournament is complete/);
});
