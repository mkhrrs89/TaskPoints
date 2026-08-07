const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scwm_interaction_fast_path.js'), 'utf8');

function classes(initial = []) {
  const values = new Set(initial);
  return {
    contains(name) { return values.has(name); },
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    toggle(name, force) {
      if (force === true) values.add(name);
      else if (force === false) values.delete(name);
      else if (values.has(name)) values.delete(name); else values.add(name);
    }
  };
}

function createHarness() {
  const calls = { legacyLocks: 0, legacyUnlocks: 0, focus: 0, select: 0 };
  const timers = new Map();
  const frames = [];
  let timerId = 0;

  const panel = {
    hidden: false,
    classList: classes(['is-active']),
    getAttribute() { return null; }
  };
  const workModal = {
    id: 'workEditModal',
    hidden: true,
    classList: classes(['hidden']),
    getAttribute(name) { return name === 'aria-hidden' ? (this.hidden ? 'true' : 'false') : null; }
  };
  const input = {
    focus() { calls.focus += 1; },
    select() { calls.select += 1; }
  };
  const body = { style: {}, classList: classes() };
  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    body,
    head: { appendChild() {} },
    documentElement: { style: {} },
    activeElement: { blur() {} },
    getElementById(id) {
      if (id === 'homePanelScwm') return panel;
      if (id === 'workEditModal') return workModal;
      if (id === 'workEditScoreInput') return input;
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes('workEditModal') ? [workModal] : [];
    },
    createElement() { return { textContent: '', setAttribute() {} }; },
    addEventListener() {}
  };

  const context = {
    console, Date, Promise, Array, Object, Set, Map, Number, String, Math, Function,
    document,
    performance: { now: () => 100 },
    matchMedia: () => ({ matches: true }),
    setTimeout(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(cb) { frames.push(cb); return frames.length; },
    requestIdleCallback(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    cancelIdleCallback(id) { timers.delete(id); },
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    save() {},
    renderAll() {},
    TaskPointsHomeIdleQueue: { noteInteraction() {} },
    lockScrollForModal() {
      calls.legacyLocks += 1;
      body.style.position = 'fixed';
      body.style.top = '-200px';
      body.style.width = '100%';
    },
    unlockScrollForModal() {
      calls.legacyUnlocks += 1;
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
    }
  };
  context.window = context;
  context.globalThis = context;
  context.promptEditWorkEntry = function promptEditWorkEntry() {
    workModal.hidden = false;
    workModal.classList.remove('hidden');
    context.lockScrollForModal();
    input.focus();
    input.select();
  };
  context.closeWorkEditModal = function closeWorkEditModal() {
    workModal.hidden = true;
    workModal.classList.add('hidden');
    context.unlockScrollForModal();
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'scwm_interaction_fast_path.js' });

  const [installId, install] = timers.entries().next().value;
  timers.delete(installId);
  install();

  const flushFramesAndTimers = () => {
    let guard = 0;
    while ((frames.length || timers.size) && guard++ < 30) {
      while (frames.length) frames.shift()();
      const row = timers.entries().next().value;
      if (row) {
        timers.delete(row[0]);
        row[1]();
      }
    }
  };

  return { context, calls, body, workModal, flushFramesAndTimers };
}

test('SCWM modal open does not rewrite body layout and focuses after paint', () => {
  const { context, calls, body, flushFramesAndTimers } = createHarness();
  context.promptEditWorkEntry();

  assert.equal(calls.legacyLocks, 0);
  assert.equal(body.style.position, undefined);
  assert.equal(body.style.top, undefined);
  assert.equal(body.style.width, undefined);
  assert.equal(body.style.overflow, undefined);
  assert.equal(calls.focus, 0);
  assert.equal(calls.select, 0);

  flushFramesAndTimers();
  assert.equal(calls.focus, 1);
  assert.equal(calls.select, 1);
});

test('non-SCWM modal locks still delegate to the existing scroll-lock implementation', () => {
  const { context, calls, workModal, body } = createHarness();
  workModal.hidden = true;
  workModal.classList.add('hidden');

  context.lockScrollForModal();
  assert.equal(calls.legacyLocks, 1);
  assert.equal(body.style.position, 'fixed');

  context.unlockScrollForModal();
  assert.equal(calls.legacyUnlocks, 1);
  assert.equal(body.style.position, '');
});
