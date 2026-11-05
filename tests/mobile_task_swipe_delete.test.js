const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const fastPath = fs.readFileSync(path.join(root, 'task_delete_fast_path.js'), 'utf8');
const begin = home.indexOf('// Mobile-only left-swipe gesture.');
const end = home.indexOf('function initTaskListDelegation(){', begin);
assert.ok(begin >= 0 && end > begin, 'the mobile swipe handler is present');
const snippet = home.slice(begin, end);

function fixture({ mobile = true, editing = false, startOnButton = false } = {}) {
  class FakeElement {}
  const callbacks = { list: {}, document: {}, window: {} };
  const classes = new Set();
  const props = new Map();
  const card = new FakeElement();
  card.dataset = { taskId: 'task-1' };
  card.isConnected = true;
  card.classList = {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); }
  };
  card.style = {
    setProperty(name, value) { props.set(name, value); },
    removeProperty(name) { props.delete(name); }
  };
  const target = new FakeElement();
  target.closest = selector => {
    if (selector.startsWith('button,')) return startOnButton ? {} : null;
    if (selector === '.task-priority-card[data-task-id]') return card;
    return card;
  };
  const list = {
    dataset: {},
    contains(item) { return item === card; },
    addEventListener(type, fn) { callbacks.list[type] = fn; }
  };
  const document = {
    addEventListener(type, fn) { callbacks.document[type] = fn; }
  };
  const window = {
    matchMedia() { return { matches: mobile }; },
    addEventListener(type, fn) { callbacks.window[type] = fn; }
  };
  const deleted = [];
  const rescheduled = [];
  const context = {
    window, document, Element: FakeElement, Date, Math,
    editingTaskId: editing ? 'task-1' : null,
    state: { tasks: [{ id: 'task-1', completedAtISO: null, hidden: false }] },
    isTaskTrashed() { return false; },
    deleteTask(id) { deleted.push(id); },
    openTaskRescheduleCalendar(id) { rescheduled.push(id); }
  };
  vm.createContext(context);
  vm.runInContext(snippet, context, { filename: 'mobile-task-swipe-delete.js' });
  context.installMobileTaskSwipeDelete(list);

  const pointer = (type, x, y, override = {}) => ({
    pointerType: 'touch', isPrimary: true, pointerId: 5,
    clientX: x, clientY: y, target, ...override
  });
  const down = (x = 250, y = 100, override = {}) =>
    callbacks.list.pointerdown(pointer('down', x, y, override));
  const move = (x, y, override = {}) =>
    callbacks.document.pointermove(pointer('move', x, y, override));
  const up = (x, y, override = {}) =>
    callbacks.document.pointerup(pointer('up', x, y, override));
  const cancel = () =>
    callbacks.document.pointercancel(pointer('cancel', 250, 100));
  const click = () => {
    const event = {
      target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }
    };
    callbacks.list.click(event);
    return event;
  };
  return {
    context, callbacks, list, deleted, rescheduled, classes, props, card,
    down, move, up, cancel, click
  };
}

test('left swipe of at least 76px triggers the same deleteTask path', () => {
  const f = fixture();
  f.down();
  f.move(155, 108);
  assert.equal(f.classes.has('task-swipe-delete-active'), true);
  assert.equal(f.props.get('--task-swipe-delete-offset'), '-95px');
  f.up(155, 108);
  assert.deepEqual(f.deleted, ['task-1']);
  assert.equal(f.classes.has('task-swipe-delete-active'), false);
  assert.equal(f.props.has('--task-swipe-delete-offset'), false);
  assert.equal(f.click().prevented, true, 'synthesized click must not expand the task');
});

test('partial left swipe does not delete or accidentally expand a task', () => {
  const f = fixture();
  f.down();
  f.move(195, 103);
  f.up(195, 103);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.click().stopped, true);
});

test('vertical scroll and right swipe never trigger deletion', () => {
  const vertical = fixture();
  vertical.down();
  vertical.move(220, 12);
  vertical.up(220, 12);
  assert.deepEqual(vertical.deleted, []);
  assert.equal(vertical.click().prevented, false, 'vertical scrolling should not be intercepted');
  const right = fixture();
  right.down();
  right.move(340, 105);
  right.up(340, 105);
  assert.deepEqual(right.deleted, []);
});

test('pointer cancellation cleans up the preview and never deletes a task', () => {
  const f = fixture();
  f.down();
  f.move(154, 100);
  f.cancel();
  f.up(154, 100);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.classes.has('task-swipe-delete-active'), false);
});

test('desktop, mouse, button controls and editing are excluded', () => {
  for (const config of [
    { mobile: false },
    { startOnButton: true },
    { editing: true }
  ]) {
    const f = fixture(config);
    f.down();
    f.move(100, 100);
    f.up(100, 100);
    assert.deepEqual(f.deleted, []);
  }
  const mouse = fixture();
  mouse.down(250, 100, { pointerType: 'mouse' });
  mouse.move(100, 100);
  mouse.up(100, 100);
  assert.deepEqual(mouse.deleted, []);
});

test('gesture installs only once per task-list container across renders', () => {
  const f = fixture();
  assert.equal(f.list.dataset.tpSwipeDeleteAttached, '1');
  const prior = f.callbacks.list.pointerdown;
  f.context.installMobileTaskSwipeDelete(f.list);
  assert.equal(f.callbacks.list.pointerdown, prior);
  assert.match(home, /installMobileTaskSwipeDelete\(list\);/);
});

test('swipe reuses the existing user confirmation, Trash, Undo, and delete save path', () => {
  const start = home.indexOf('function deleteTask(id){');
  const end = home.indexOf('/* ---------- IMPORT/EXPORT/RESET ---------- */', start);
  const deletion = home.slice(start, end);
  assert.match(deletion, /confirm\('Move this task to Trash\?'\)/);
  assert.match(deletion, /moveTaskToTrash\(t, 'TasksScreen'\)/);
  assert.match(deletion, /showTrashToast\(id\)/);
  assert.match(snippet, /deleteTask\(id\)/);
  assert.match(home, /TaskPointsCore\?\.armTaskDeleteFastPath\?\.\(id\)/);
  assert.match(fastPath, /core\.armTaskDeleteFastPath = function armTaskDeleteFastPath/);
});

test('touch scrolling, feedback, and scope are mobile-only CSS', () => {
  assert.match(styles, /@media \(max-width: 900px\) and \(pointer: coarse\)/);
  assert.match(styles, /#taskList \.task-priority-card\s*\{\s*touch-action: pan-y;/);
  assert.match(styles, /task-swipe-delete-active::after/);
  assert.match(styles, /content: "Delete"/);
});

test('right swipe of at least 76px opens calendar without deleting', () => {
  const f = fixture();
  f.down();
  f.move(343, 105);
  assert.equal(f.classes.has('task-swipe-reschedule-active'), true);
  assert.equal(f.props.get('--task-swipe-reschedule-offset'), '93px');
  f.up(343, 105);
  assert.deepEqual(f.rescheduled, ['task-1']);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.classes.has('task-swipe-reschedule-active'), false);
  assert.equal(f.props.has('--task-swipe-reschedule-offset'), false);
  assert.equal(f.click().prevented, true);
});

test('partial right swipe and diagonal scroll neither open calendar nor expand task', () => {
  const partial = fixture();
  partial.down();
  partial.move(293, 104);
  partial.up(293, 104);
  assert.deepEqual(partial.rescheduled, []);
  assert.equal(partial.click().prevented, true);
  const diagonal = fixture();
  diagonal.down();
  diagonal.move(335, 176);
  diagonal.up(335, 176);
  assert.deepEqual(diagonal.rescheduled, []);
});

test('right swipe is disabled while editing and for buttons, mouse, and desktop', () => {
  for (const opts of [{editing:true}, {startOnButton:true}, {mobile:false}]) {
    const f = fixture(opts);
    f.down();
    f.move(351,105);
    f.up(351,105);
    assert.deepEqual(f.rescheduled, []);
  }
  const f=fixture();
  f.down(250,100,{pointerType:'mouse'});
  f.move(350,100);
  f.up(350,100);
  assert.deepEqual(f.rescheduled, []);
});

test('reschedule uses a separate cue while the old delete swipe remains intact', () => {
  assert.match(styles, /task-swipe-reschedule-active::before/);
  assert.match(styles, /content: "Reschedule"/);
  assert.match(styles, /task-swipe-delete-active::after/);
  assert.match(snippet, /openTaskRescheduleCalendar\(id\)/);
  assert.match(snippet, /deleteTask\(id\)/);
});
