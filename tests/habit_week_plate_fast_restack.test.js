const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_fast_path_control.js'), 'utf8');

class FakeClassList {
  constructor(node, initial = []) {
    this.node = node;
    this.values = new Set(initial);
  }

  contains(name) {
    return this.values.has(name);
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  toggle(name, force) {
    if (force === true) {
      this.values.add(name);
      return true;
    }
    if (force === false) {
      this.values.delete(name);
      return false;
    }
    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }
    this.values.add(name);
    return true;
  }

  replaceFromString(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  toString() {
    return Array.from(this.values).join(' ');
  }
}

class FakeNode {
  constructor(tagName = 'div', classes = []) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.isFragment = tagName === '#fragment';
    this.classList = new FakeClassList(this, classes);
    this.daysRow = null;
  }

  set className(value) {
    this.classList.replaceFromString(value);
  }

  get className() {
    return this.classList.toString();
  }

  appendChild(child) {
    if (child.isFragment) {
      while (child.children.length) this.appendChild(child.children[0]);
      return child;
    }
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  insertBefore(child, reference) {
    const referenceIndex = this.children.indexOf(reference);
    if (referenceIndex === -1) throw new Error('Reference node is not a child');

    if (child.isFragment) {
      const fragmentChildren = child.children.slice();
      fragmentChildren.forEach((fragmentChild) => this.insertBefore(fragmentChild, reference));
      return child;
    }

    child.parentElement?.removeChild(child);
    const nextReferenceIndex = this.children.indexOf(reference);
    this.children.splice(nextReferenceIndex, 0, child);
    child.parentElement = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('Node is not a child');
    this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  querySelector(selector) {
    if (selector === '.habitDaysRow') return this.daysRow;
    return null;
  }
}

function makeRow(id) {
  const row = new FakeNode('div', ['habitRow']);
  row.dataset.habitRowId = id;
  row.daysRow = new FakeNode('div', ['habitDaysRow']);
  return row;
}

function makeDocument() {
  return {
    readyState: 'complete',
    addEventListener() {},
    createElement(tagName) {
      return new FakeNode(tagName);
    },
    createComment() {
      return new FakeNode('#comment');
    },
    createDocumentFragment() {
      return new FakeNode('#fragment');
    }
  };
}

function makeContext(habits) {
  const bootDocument = {
    readyState: 'complete',
    addEventListener() {}
  };
  const window = {
    document: bootDocument,
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    Date,
    setTimeout(callback) {
      callback();
      return 1;
    },
    addEventListener() {},
    handleHabitBubbleTap() {}
  };
  const context = vm.createContext({
    window,
    document: bootDocument,
    globalThis: window,
    module: { exports: {} },
    console,
    Date
  });

  vm.runInContext(source, context);

  const document = makeDocument();
  window.document = document;
  context.document = document;

  let fallbackCalls = 0;
  window.refreshHabitRowWeekCompleteVisual = () => {
    fallbackCalls += 1;
  };
  context.state = { habits };
  context.isHabitWeeklyCompleteForDays = (habit) => habit.complete === true;
  context.habitWeekCompleteRowClasses = [
    'habitRow--week-complete',
    'habitRow--week-complete-before',
    'habitRow--week-complete-after',
    'habitRow--week-complete-start',
    'habitRow--week-complete-middle',
    'habitRow--week-complete-end',
    'habitRow--week-complete-single'
  ];
  context.addHabitWeeklyCompleteClasses = (row, complete, previous, next) => {
    if (!complete) return;
    row.classList.add('habitRow--week-complete');
    if (previous) row.classList.add('habitRow--week-complete-after');
    if (next) row.classList.add('habitRow--week-complete-before');
    if (previous && next) row.classList.add('habitRow--week-complete-middle');
    else if (previous) row.classList.add('habitRow--week-complete-end');
    else if (next) row.classList.add('habitRow--week-complete-start');
    else row.classList.add('habitRow--week-complete-single');
  };

  const status = window.TaskPointsImmediateHabitWeekPlate.install();
  assert.equal(status.installed, true);

  return {
    window,
    document,
    fallbackCalls: () => fallbackCalls
  };
}

test('final completion immediately creates the steel-plate wrapper and undo removes it', () => {
  const habits = [
    { id: 'a', complete: false },
    { id: 'b', complete: true }
  ];
  const { window, fallbackCalls } = makeContext(habits);
  const container = new FakeNode('div');
  const rowA = makeRow('a');
  const rowB = makeRow('b');
  container.appendChild(rowA);
  container.appendChild(rowB);

  window.refreshHabitRowWeekCompleteVisual(rowB, habits[1], [{}]);

  assert.equal(container.children.length, 2);
  assert.equal(container.children[0], rowA);
  const completedStack = container.children[1];
  assert.equal(completedStack.classList.contains('habitWeekCompleteStack'), true);
  assert.deepEqual(completedStack.children, [rowB]);
  assert.equal(rowB.classList.contains('habitRow--week-complete'), true);
  assert.equal(rowB.classList.contains('habitRow--week-complete-single'), true);
  assert.equal(rowB.daysRow.classList.contains('week-complete-row'), true);
  assert.equal(fallbackCalls(), 0);

  habits[1].complete = false;
  window.refreshHabitRowWeekCompleteVisual(rowB, habits[1], [{}]);

  assert.deepEqual(container.children, [rowA, rowB]);
  assert.equal(rowB.classList.contains('habitRow--week-complete'), false);
  assert.equal(rowB.daysRow.classList.contains('week-complete-row'), false);
  assert.equal(fallbackCalls(), 0);
});

test('a newly completed row immediately merges adjacent steel-plate runs', () => {
  const habits = [
    { id: 'a', complete: true },
    { id: 'b', complete: true },
    { id: 'c', complete: true }
  ];
  const { window } = makeContext(habits);
  const container = new FakeNode('div');
  const leftStack = new FakeNode('div', ['habitWeekCompleteStack']);
  const rightStack = new FakeNode('div', ['habitWeekCompleteStack']);
  const rowA = makeRow('a');
  const rowB = makeRow('b');
  const rowC = makeRow('c');
  leftStack.appendChild(rowA);
  rightStack.appendChild(rowC);
  container.appendChild(leftStack);
  container.appendChild(rowB);
  container.appendChild(rightStack);

  window.refreshHabitRowWeekCompleteVisual(rowB, habits[1], [{}]);

  assert.equal(container.children.length, 1);
  const mergedStack = container.children[0];
  assert.equal(mergedStack.classList.contains('habitWeekCompleteStack'), true);
  assert.deepEqual(mergedStack.children, [rowA, rowB, rowC]);
  assert.equal(rowA.classList.contains('habitRow--week-complete-start'), true);
  assert.equal(rowB.classList.contains('habitRow--week-complete-middle'), true);
  assert.equal(rowC.classList.contains('habitRow--week-complete-end'), true);
});

test('the updater retains the original refresh as a guarded fallback', () => {
  assert.match(source, /function runOriginal\(row, habit, days\)/);
  assert.match(source, /Immediate habit week plate refresh failed/);
  assert.match(source, /__tpOriginalHabitWeekRefresh/);
});
