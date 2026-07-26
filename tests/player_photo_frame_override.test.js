const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'home_yesterday_result_consistency.js'), 'utf8');

test('Players page silver photo frame override is injected once', () => {
  const elementsById = new Map();
  const appended = [];
  const document = {
    readyState: 'loading',
    head: {
      appendChild(element) {
        appended.push(element);
        if (element.id) elementsById.set(element.id, element);
      }
    },
    createElement(tagName) {
      return { tagName, id: '', textContent: '' };
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    addEventListener() {}
  };

  const context = {
    document,
    Date,
    Number,
    String,
    Array,
    Object,
    Math,
    Set,
    console
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: 'home_yesterday_result_consistency.js' });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].tagName, 'style');
  assert.equal(appended[0].id, 'taskpoints-player-photo-frame-override');
  assert.match(appended[0].textContent, /\.player-img-frame\s*\{/);
  assert.match(appended[0].textContent, /padding:\s*0\s*!important/);
  assert.match(appended[0].textContent, /background:\s*transparent\s*!important/);
  assert.doesNotMatch(appended[0].textContent, /\.player-img-inner\s*\{[^}]*padding:\s*0/s);

  assert.equal(
    context.TaskPointsHomeYesterdayResultConsistency.installPlayerPhotoFrameOverride(),
    true
  );
  assert.equal(appended.length, 1, 'the override must not be appended twice');
});
