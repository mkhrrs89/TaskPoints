const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_rank_percentile_line.js'), 'utf8');

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, value); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
}

class FakeElement {
  constructor(className = '') {
    this.id = '';
    this.className = className;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.hidden = false;
    this.textContent = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  querySelector(selector) {
    if (selector.startsWith('.')) {
      const target = selector.slice(1);
      return this.find((node) => String(node.className || '').split(/\s+/).includes(target));
    }
    return null;
  }

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find?.(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

function createHarness() {
  const head = new FakeElement();
  const grid = new FakeElement('grid');
  const scoreboard = new FakeElement('glass home-scoreboard-card');
  grid.appendChild(scoreboard);

  const roots = [head, grid];
  const findById = (id) => {
    for (const root of roots) {
      if (root.id === id) return root;
      const found = root.find((node) => node.id === id);
      if (found) return found;
    }
    return null;
  };

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    head,
    createElement: () => new FakeElement(),
    getElementById: findById,
    querySelector: (selector) => selector === '.home-scoreboard-card' ? scoreboard : null,
    addEventListener: () => undefined
  };

  let ranking = { size: 80, get: (id) => id === 'YOU' ? { rank: 40 } : null };
  const context = {
    document,
    console,
    Map,
    setTimeout: () => 0,
    requestAnimationFrame: (run) => run(),
    addEventListener: () => undefined,
    getCanonicalRankingMap: () => ranking
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: 'home_rank_percentile_line.js' });

  return {
    context,
    grid,
    scoreboard,
    setRanking(next) { ranking = next; }
  };
}

test('rank percentile puts the lowest rank at the left and rank 1 at the right', () => {
  const { context } = createHarness();
  const api = context.TaskPointsHomeRankPercentileLine;

  assert.equal(api.calculatePosition(80, 80), 0);
  assert.equal(api.calculatePosition(1, 80), 100);
  assert.ok(Math.abs(api.calculatePosition(40, 80) - 50.63291139240506) < 1e-9);
});

test('home rank line inserts before the scoreboard and uses the live active ranking count', () => {
  const harness = createHarness();
  const api = harness.context.TaskPointsHomeRankPercentileLine;
  const root = harness.context.document.getElementById(api.ROOT_ID);

  assert.ok(root, 'rank line should be mounted');
  assert.equal(harness.grid.children[0], root, 'rank line should sit immediately before the scoreboard');
  assert.equal(harness.grid.children[1], harness.scoreboard);
  assert.equal(root.getAttribute('data-rank'), '40');
  assert.equal(root.getAttribute('data-ranked-players'), '80');
  assert.match(root.style.getPropertyValue('--tp-rank-position'), /^50\.6329/);
  assert.equal(root.querySelector('.home-rank-percentile-marker').textContent, '40');

  harness.setRanking({ size: 100, get: (id) => id === 'YOU' ? { rank: 25 } : null });
  const updated = api.render();

  assert.equal(updated.total, 100);
  assert.equal(updated.rank, 25);
  assert.equal(root.getAttribute('data-ranked-players'), '100');
  assert.equal(root.getAttribute('data-rank'), '25');
  assert.match(root.style.getPropertyValue('--tp-rank-position'), /^75\.7575/);
  assert.equal(root.querySelector('.home-rank-percentile-marker').textContent, '25');
});

test('module listens for state-revision refreshes and contains no persistence path', () => {
  assert.match(source, /taskpoints:state-revision/);
  assert.match(source, /getCanonicalRankingMap/);
  assert.doesNotMatch(source, /localStorage\.setItem|saveStateSnapshot|writePending/);
});
