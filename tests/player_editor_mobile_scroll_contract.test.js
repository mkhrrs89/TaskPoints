const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

test('player editor modal remains vertically scrollable on mobile', () => {
  assert.match(source, /\.player-editor-modal-panel\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(source, /-webkit-overflow-scrolling:\s*touch;/);
  assert.match(source, /overscroll-behavior:\s*contain;/);
  assert.match(source, /scroll-padding-bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 28px\)/);
});

test('bottom mobile toolbar hides while player editor is open', () => {
  assert.match(source, /body\.player-editor-modal-open #bottomToolbarMount/);
  assert.match(source, /body\.player-editor-modal-open #mobileBottomNav/);
  assert.match(source, /document\.body\.classList\.add\("player-editor-modal-open"\)/);
  assert.match(source, /document\.body\.classList\.remove\("player-editor-modal-open"\)/);
});

test('opening player editor resets its own scroll position', () => {
  assert.match(source, /panel\.scrollTop = 0;/);
});
