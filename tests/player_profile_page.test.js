const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const profileCode = fs.readFileSync(path.join(root, 'player_profile.js'), 'utf8');
const game = fs.readFileSync(path.join(root, 'game.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'scoring_core.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function fixture(count = 2, directHash = '') {
  const state = {
    youName: 'Me', youNotes: '', youRivalId: 'npc1', youImageId: 'you-photo',
    youPrimaryColor: '#aabbcc', youSecondaryColor: '#113344',
    players: Array.from({ length: count }, (_, i) => ({
      id: 'npc' + (i + 1), pid: 'P' + String(i + 1).padStart(3, '0'),
      name: 'NPC ' + (i + 1), active: true, rivalId: '',
      primaryColor: '#112233', secondaryColor: '#334455',
      notes: 'Old notes', style: 'grinder', baseline: 51, variance: 12,
      imageId: 'photo' + i
    })),
    gameHistory: [
      { playerId: 'npc1', date: '2026-10-25', score: 10 },
      { playerId: 'npc1', date: '2026-10-26', score: 20 },
      { playerId: 'npc2', date: '2026-10-26', score: 50 },
      { playerId: 'npc1', date: '2026-10-28', score: 200 }
    ]
  };
  const calls = { save: [], rerender: 0, schedule: 0, editNpc: [], editSelf: 0, photos: [] };
  const screen = {
    innerHTML: '', hidden: true, scrollTop: -1,
    style: {
      properties: {},
      setProperty(key, value) { this.properties[key] = value; },
      getPropertyValue(key) { return this.properties[key] || ''; }
    },
    setAttribute(key, value) { this[key] = value; },
    addEventListener(name, fn) { this[name] = fn; },
    querySelector(sel) {
      if (sel === '#tpPlayerProfileSaved') return { set textContent(value) { calls.status = value; } };
      return null;
    }
  };
  const listeners = {};
  const body = {
    children: [],
    appendChild(node) { this.children.push(node); },
    classList: {
      values: new Set(),
      add(v) { this.values.add(v); },
      remove(v) { this.values.delete(v); },
      contains(v) { return this.values.has(v); }
    }
  };
  const document = { body, createElement() { return screen; } };
  const win = {
    document,
    location: { pathname: '/game.html', search: '', hash: directHash },
    history: {
      state: null, stack: [],
      pushState(data, _title, pathValue) {
        this.stack.push({ hash: win.location.hash, state: this.state });
        this.state = data;
        win.location.hash = pathValue.startsWith('#') ? pathValue : '';
      },
      replaceState(data, _title, pathValue) {
        this.state = data;
        win.location.hash = pathValue.includes('#') ? '#' + pathValue.split('#').slice(1).join('#') : '';
      },
      back() {
        const prev = this.stack.pop() || { hash: '', state: null };
        this.state = prev.state;
        win.location.hash = prev.hash;
        (listeners.popstate || []).forEach(fn => fn());
      }
    },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }
  };
  const sandbox = { window: win, globalThis: win, console, Date, Promise };
  vm.createContext(sandbox);
  vm.runInContext(profileCode, sandbox);
  const controller = win.TaskPointsPlayerProfiles.create({
    document, window: win, getState: () => state,
    getYouName: () => state.youName || 'You',
    getYouColors: () => ({ primaryColor: state.youPrimaryColor, secondaryColor: state.youSecondaryColor }),
    getYouStats: () => ({ record: '10-3', avgPPD: 17.5, games: 13 }),
    getRecord: () => ({ wins: 3, losses: 2, games: 5 }),
    getPlayerPid: (_state, id) => state.players.find(p => p.id === id)?.pid,
    todayKey: () => '2026-10-28',
    cachedImageUrl: id => 'blob:existing-' + id,
    loadImageUrl: id => { calls.photos.push(id); return Promise.resolve('blob:' + id); },
    buildRivalOptions: ({ excludePlayerId, selectedRivalId }) =>
      '<option value="">None</option>' + state.players
        .filter(p => p.id !== excludePlayerId)
        .map(p => '<option value="' + p.id + '"' + (p.id === selectedRivalId ? ' selected' : '') + '>' + p.name + '</option>')
        .join(''),
    escapeHtml: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escapeHtmlAttr: v => String(v).replace(/"/g, '&quot;'),
    normalizeColor: (v, fallback) => /^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback,
    save: (updated, opts) => { calls.save.push({ state: structuredClone(updated), opts }); },
    renderRoster: () => { calls.rerender++; },
    onActiveChange: () => { calls.schedule++; calls.activeWhenScheduled = state.players[0].active; },
    editNpc: id => calls.editNpc.push(id),
    editSelf: () => calls.editSelf++
  });
  controller.init();
  const makeForm = (fields) => ({
    elements: { namedItem(key) {
      if (!(key in fields)) return null;
      return { value: fields[key], checked: Boolean(fields[key]) };
    }}
  });
  return { controller, state, calls, screen, body, win, makeForm };
}

test('profile screen is a single hidden lazy container even for 500 players', () => {
  const f = fixture(500);
  assert.equal(f.body.children.length, 1);
  assert.equal(f.screen.hidden, true);
  assert.equal(f.calls.save.length, 0);
  assert.equal(f.controller.open('npc499'), true);
  assert.equal(f.body.children.length, 1);
  assert.equal(f.screen.hidden, false);
  assert.equal(f.controller.activeId(), 'npc499');
  assert.equal(f.calls.save.length, 0);
});

test('NPC profile displays its existing identity, stats, ratings, rival choices and photo', () => {
  const f = fixture();
  f.controller.open('npc1');
  assert.match(f.screen.innerHTML, /NPC 1/);
  assert.match(f.screen.innerHTML, /P001/);
  assert.match(f.screen.innerHTML, /3-2/);
  assert.match(f.screen.innerHTML, /15\.0/);
  assert.match(f.screen.innerHTML, /Baseline/);
  assert.match(f.screen.innerHTML, /photo0/);
  assert.match(f.screen.innerHTML, /Playing style/);
  assert.match(f.screen.innerHTML, /Notes \/ biography/);
  assert.match(f.screen.innerHTML, /Save profile/);
  assert.equal(f.controller.statsFor('npc1').ppd, '15.0');
});

test('YOU shares the profile UI but retains its special score and permanent P000', () => {
  const f = fixture();
  assert.equal(f.controller.open('YOU'), true);
  assert.match(f.screen.innerHTML, /P000/);
  assert.match(f.screen.innerHTML, /10-3/);
  assert.match(f.screen.innerHTML, /17\.5/);
  assert.match(f.screen.innerHTML, /Your performance/);
  assert.doesNotMatch(f.screen.innerHTML, /Active player/);
  assert.match(f.screen.innerHTML, /Notes \/ biography/);
});

test('save NPC details edits the original record, not a copy, without touching ratings or other players', () => {
  const f = fixture();
  f.controller.open('npc1');
  const oldNpc2 = structuredClone(f.state.players[1]);
  assert.equal(f.controller.saveForm(f.makeForm({
    name: 'Captain', notes: 'New profile', style: 'volatile',
    rivalId: 'YOU', primaryColor: '#aabbcc', secondaryColor: '#445566', active: true
  })), true);
  assert.equal(f.state.players[0].name, 'Captain');
  assert.equal(f.state.players[0].notes, 'New profile');
  assert.equal(f.state.players[0].rivalId, 'YOU');
  assert.equal(f.state.players[0].baseline, 51);
  assert.deepEqual(f.state.players[1], oldNpc2);
  assert.equal(f.calls.save.length, 1);
  assert.equal(f.calls.rerender, 1);
  assert.match(f.screen.innerHTML, /Captain/);
});

test('YOU profile saves optional biography with name, colors and rival while retaining image', () => {
  const f = fixture();
  f.controller.open('YOU');
  const originalPhoto = f.state.youImageId;
  assert.equal(f.controller.saveForm(f.makeForm({
    name: 'Alias', notes: 'A player biography', rivalId: 'npc2',
    primaryColor: '#123456', secondaryColor: '#abcdef'
  })), true);
  assert.equal(f.state.youName, 'Alias');
  assert.equal(f.state.youNotes, 'A player biography');
  assert.equal(f.state.youRivalId, 'npc2');
  assert.equal(f.state.youImageId, originalPhoto);
  assert.ok(f.calls.save[0].opts.allowStickyOverwriteKeys.includes('youNotes'));
  assert.equal(f.calls.rerender, 1);
  assert.equal(f.controller.saveForm(f.makeForm({
    name: '', notes: '', rivalId: '', primaryColor: '#123456', secondaryColor: '#abcdef'
  })), true);
  assert.equal(f.state.youNotes, '');
  assert.equal(f.state.youRivalId, '');
});

test('invalid rival and invalid player IDs are rejected without saving', () => {
  const f = fixture();
  assert.equal(f.controller.open('missing'), false);
  f.controller.open('npc1');
  assert.equal(f.controller.saveForm(f.makeForm({
    name: 'Name', notes: '', rivalId: 'npc1', active: true
  })), false);
  assert.equal(f.controller.saveForm(f.makeForm({
    name: 'Name', notes: '', rivalId: 'deleted', active: true
  })), false);
  assert.equal(f.calls.save.length, 0);
});

test('active state changes are applied before schedule regeneration, with no change when unchanged', () => {
  const f = fixture();
  f.controller.open('npc1');
  const fields = { name: 'NPC 1', notes: 'Old notes', style: 'grinder',
    rivalId: '', primaryColor: '#112233', secondaryColor: '#334455', active: false };
  assert.equal(f.controller.saveForm(f.makeForm(fields)), true);
  assert.equal(f.calls.activeWhenScheduled, false);
  assert.equal(f.calls.schedule, 1);
  f.controller.saveForm(f.makeForm(fields));
  assert.equal(f.calls.schedule, 1);
});

test('back navigation restores roster instead of navigating to another browser tab', () => {
  const f = fixture();
  f.controller.open('npc1');
  assert.equal(f.win.location.hash, '#player=npc1');
  f.controller.close();
  assert.equal(f.win.location.hash, '');
  assert.equal(f.screen.hidden, true);
  assert.equal(f.body.classList.contains('tp-player-profile-open'), false);
});

test('a bookmarked direct player link can open then close without browser history exit', () => {
  const f = fixture(2, '#player=npc2');
  assert.equal(f.controller.activeId(), 'npc2');
  f.controller.close();
  assert.equal(f.win.location.hash, '');
  assert.equal(f.screen.hidden, true);
});

test('card/gallery and existing editors remain available and backed by same core data', () => {
  assert.match(game, /script src="player_profile\.js"/);
  assert.match(game, /playerProfiles\.init\(\)/);
  assert.match(game, /function wireViewCardProfileLinks/);
  assert.match(game, /data-profile-open="YOU"/);
  assert.match(game, /data-profile-open=".*p\.id/);
  assert.match(game, /openPlayerEditor\(id\)/);
  assert.match(game, /function buildPlayerEditorContent\(player\)/);
  assert.match(game, /function loadImageUrl\(imageId\)/);
  assert.match(css, /\.tp-player-profile-screen/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(core, /youNotes: typeof src\.youNotes/);
  assert.equal((core.match(/youNotes: typeof src\.youNotes/g) || []).length, 2);
});


test('centered Players back button replaces title and stays clear of left floating Today island', () => {
  const f = fixture();
  assert.equal(f.controller.open('npc1'), true);
  const markup = f.screen.innerHTML;
  const topbar = markup.slice(markup.indexOf('class="tp-profile-topbar"'),
    markup.indexOf('</div>', markup.indexOf('class="tp-profile-topbar"')));
  assert.match(topbar, /class="tp-profile-topbar-spacer" aria-hidden="true"/);
  assert.match(topbar, /class="tp-profile-back" aria-label="Back to players">← Players<\/button>/);
  assert.match(topbar, /class="tp-profile-advanced">Ratings & photo<\/button>/);
  assert.ok(topbar.indexOf('tp-profile-topbar-spacer') < topbar.indexOf('tp-profile-back'));
  assert.ok(topbar.indexOf('tp-profile-back') < topbar.indexOf('tp-profile-advanced'));
  assert.doesNotMatch(markup, /PLAYER PROFILE/);
  assert.match(css, /\.tp-profile-topbar\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.tp-profile-topbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.tp-profile-back\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*center/);
  assert.match(css, /\.tp-profile-advanced\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end/);
  assert.doesNotMatch(css, /\.tp-profile-eyebrow\s*\{/);
});

test('centered back control works for P000 without changing the existing photo editor', () => {
  const f = fixture();
  f.controller.open('YOU');
  const markup = f.screen.innerHTML;
  assert.match(markup, /class="tp-profile-back" aria-label="Back to players">← Players/);
  assert.match(markup, /class="tp-profile-advanced">Edit photo/);
  assert.equal(f.controller.activeId(), 'YOU');
  f.controller.close();
  assert.equal(f.screen.hidden, true);
});


function themeContrast(light, dark) {
  const luminance = hex => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const linear = rgb.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(light), b = luminance(dark);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('profile theme uses both player colors for backgrounds, panels, controls and accents', () => {
  const f = fixture();
  f.controller.open('npc1');
  const props = f.screen.style.properties;
  const primary = f.state.players[0].primaryColor;
  const secondary = f.state.players[0].secondaryColor;
  assert.ok(primary !== secondary);
  for (const prop of [
    '--tp-profile-canvas-from', '--tp-profile-canvas-to',
    '--tp-profile-hero-from', '--tp-profile-hero-to',
    '--tp-profile-panel-from', '--tp-profile-panel-to',
    '--tp-profile-button-from', '--tp-profile-button-to',
    '--tp-profile-field', '--tp-profile-metric',
    '--tp-profile-accent', '--tp-profile-accent-secondary',
    '--tp-profile-border', '--tp-profile-focus'
  ]) {
    assert.match(props[prop] || '', /^#[0-9a-f]{6}$/, 'Missing CSS variable: ' + prop);
    assert.match(css, new RegExp('var\\(' + prop + '\\)'), 'CSS does not use ' + prop);
  }
  assert.notEqual(props['--tp-profile-hero-from'], props['--tp-profile-hero-to']);
  assert.notEqual(props['--tp-profile-panel-from'], props['--tp-profile-panel-to']);
  assert.equal(f.calls.save.length, 0, 'Changing appearance must not write to storage');
});

test('switching profiles changes theme without creating another screen or saved copy', () => {
  const f = fixture();
  f.state.players[1].primaryColor = '#ff7700';
  f.state.players[1].secondaryColor = '#3344cc';
  f.controller.open('npc1');
  const original = { ...f.screen.style.properties };
  f.controller.open('npc2');
  const updated = f.screen.style.properties;
  assert.notEqual(updated['--tp-profile-hero-from'], original['--tp-profile-hero-from']);
  assert.notEqual(updated['--tp-profile-hero-to'], original['--tp-profile-hero-to']);
  assert.equal(f.body.children.length, 1);
  assert.equal(f.calls.save.length, 0);
});

test('YOUR P000 profile theme uses YOUR existing primary and secondary colors', () => {
  const f = fixture();
  f.controller.open('YOU');
  const params = f.screen.style.properties;
  assert.match(params['--tp-profile-hero-from'], /^#[0-9a-f]{6}$/);
  f.state.youPrimaryColor = '#cc44ff';
  f.state.youSecondaryColor = '#2244dd';
  f.controller.refresh();
  assert.equal(f.screen.style.properties['--tp-profile-hero-from'], '#481c64');
  assert.equal(f.calls.save.length, 0);
});

test('saving profile colors immediately updates this profile theme and preserved fields', () => {
  const f = fixture();
  f.controller.open('npc1');
  const before = { ...f.screen.style.properties };
  const saved = f.controller.saveForm(f.makeForm({
    name: 'NPC 1', notes: 'Old notes', style: 'grinder',
    rivalId: '', primaryColor: '#ffcc00', secondaryColor: '#990099', active: true
  }));
  assert.equal(saved, true);
  assert.equal(f.state.players[0].primaryColor, '#ffcc00');
  assert.equal(f.state.players[0].secondaryColor, '#990099');
  assert.notEqual(f.screen.style.properties['--tp-profile-hero-from'], before['--tp-profile-hero-from']);
  assert.notEqual(f.screen.style.properties['--tp-profile-hero-to'], before['--tp-profile-hero-to']);
  assert.equal(f.calls.save.length, 1);
  assert.equal(f.state.players[0].baseline, 51);
  assert.equal(f.state.players[1].primaryColor, '#112233');
});

test('white typography has >= 4.5:1 contrast on hero gradients for very bright and dark player colors', () => {
  const f = fixture();
  const original = f.state.players[0];
  const colors = [
    ['#ffffff', '#ffffff'], ['#000000', '#000000'],
    ['#ffff00', '#ffffff'], ['#ff0000', '#ffff00'],
    ['#ff7700', '#ff2200'], ['#0000ff', '#00ffff'],
    ['#00ff00', '#00ff00'], ['#c0c0c0', '#333333']
  ];
  for (const [primary, secondary] of colors) {
    original.primaryColor = primary;
    original.secondaryColor = secondary;
    f.controller.open('npc1');
    for (const surface of [
      '--tp-profile-hero-from', '--tp-profile-hero-to',
      '--tp-profile-panel-from', '--tp-profile-panel-to',
      '--tp-profile-button-from', '--tp-profile-button-to',
      '--tp-profile-canvas-from', '--tp-profile-canvas-to'
    ]) {
      const hex = f.screen.style.properties[surface];
      assert.ok(themeContrast('#ffffff', hex) >= 4.5,
        surface + ' insufficient contrast for ' + primary + ' / ' + secondary + ': ' + hex);
    }
  }
});

test('color theme remains scoped to player profiles and does not affect game cards or editors', () => {
  assert.match(css, /\.tp-player-profile-screen\s*\{/);
  assert.match(css, /\.tp-profile-hero\s*\{[^}]*--tp-profile-hero-from/);
  assert.match(css, /\.tp-profile-panel\s*\{[^}]*--tp-profile-panel-from/);
  assert.match(css, /\.tp-profile-form input:not\(\[type="checkbox"\]\)[\s\S]*?--tp-profile-field/);
  assert.match(game, /function buildPlayerEditorContent\(player\)/);
  assert.match(game, /function wireViewCardProfileLinks/);
  assert.match(game, /id="playersList"/);
});
