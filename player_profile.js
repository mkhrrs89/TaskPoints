/* Shared, lazy player-profile view. No duplicated player records, pages, or photos. */
(function (global) {
  'use strict';
  var ROUTE = '#player=';
  var ACTION = 'data-tp-profile-action';

  function create(deps) {
    var doc = deps.document || global.document;
    var win = deps.window || global;
    var token = 'profile-' + Date.now().toString(36);
    var screen = null;
    var activeId = '';
    var returnHash = '';
    var started = false;
    function esc(value) { return deps.escapeHtml(String(value == null ? '' : value)); }
    function att(value) { return deps.escapeHtmlAttr(String(value == null ? '' : value)); }
    function roster() { return Array.isArray(deps.getState().players) ? deps.getState().players : []; }
    function playerFor(id) {
      if (id === 'YOU') {
        var st = deps.getState();
        return { id: 'YOU', name: deps.getYouName(), notes: st.youNotes || '',
          rivalId: st.youRivalId || '', imageId: st.youImageId || '',
          primaryColor: st.youPrimaryColor, secondaryColor: st.youSecondaryColor,
          active: true, isYou: true };
      }
      return roster().find(function(p) { return String(p && p.id || '') === String(id); }) || null;
    }
    function readRoute() {
      var hash = String(win.location.hash || '');
      if (hash.indexOf(ROUTE) !== 0) return '';
      try { return decodeURIComponent(hash.slice(ROUTE.length)); } catch (_) { return ''; }
    }
    function ensureScreen() {
      if (screen) return screen;
      screen = doc.createElement('section');
      screen.id = 'tpPlayerProfileScreen';
      screen.className = 'tp-player-profile-screen';
      screen.setAttribute('aria-label', 'Player profile');
      screen.hidden = true;
      doc.body.appendChild(screen);
      screen.addEventListener('click', function(event) {
        var target = event.target.closest('[' + ACTION + ']');
        if (!target) return;
        var action = target.getAttribute(ACTION);
        if (action === 'back') close();
        if (action === 'advanced') {
          var id = activeId;
          if (id === 'YOU') { close({ immediate: true }); deps.editSelf(); }
          else deps.editNpc(id);
        }
        if (action === 'rival') {
          var id = target.getAttribute('data-rival-id');
          if (playerFor(id)) open(id);
        }
      });
      screen.addEventListener('submit', function(event) {
        if (event.target.id !== 'tpPlayerProfileForm') return;
        event.preventDefault();
        saveForm(event.target);
      });
      return screen;
    }
    function statsFor(id) {
      var st = deps.getState();
      if (id === 'YOU') {
        var you = deps.getYouStats();
        return { record: you.record || '0-0',
          ppd: Number.isFinite(Number(you.avgPPD)) ? Number(you.avgPPD).toFixed(1) : '—',
          games: Number(you.games) || 0 };
      }
      // Reuse the roster's canonical results when available; this avoids an
      // unnecessary league-wide recomputation and keeps PPD consistent.
      var canonical = deps.getCanonicalStat?.(id);
      if (canonical) {
        var canonPpd = Number(canonical.ppd);
        return {
          record: (Number(canonical.wins) || 0) + '-' + (Number(canonical.losses) || 0),
          ppd: Number.isFinite(canonPpd) ? canonPpd.toFixed(1) : '—',
          games: Number(canonical.games) || 0
        };
      }
      var rec = deps.getRecord(id) || {};
      var total = 0, count = 0, today = deps.todayKey();
      // Compute only the requested player's summary; nothing is added to storage.
      (Array.isArray(st.gameHistory) ? st.gameHistory : []).forEach(function(game) {
        if (!game || String(game.playerId) !== id) return;
        if (String(game.date || game.dateISO || '').slice(0, 10) === today) return;
        var value = Number(game.score);
        if (!Number.isFinite(value)) return;
        total += value; count++;
      });
      return { record: (Number(rec.wins) || 0) + '-' + (Number(rec.losses) || 0),
        ppd: count ? (total / count).toFixed(1) : '—', games: Number(rec.games) || count };
    }
    function ratingsFor(player) {
      if (player.isYou) return '<p class="tp-profile-note">Your daily points come from your TaskPoints activity. Your PID is permanently P000.</p>';
      var labels = [
        ['Baseline', player.baseline], ['Variance', player.variance],
        ['Variance Tilt', player.varianceTilt], ['Momentum', player.momentum],
        ['Risky', player.risky], ['INT', player.intimidation],
        ['Poise', player.poise], ['Greed', player.greed], ['Streaky', player.streaky]
      ];
      return '<div class="tp-profile-ratings">' + labels.map(function(pair) {
        return '<div class="tp-profile-rating"><span>' + esc(pair[0]) +
          '</span><strong>' + esc(pair[1] == null ? '—' : pair[1]) + '</strong></div>';
      }).join('') + '</div>';
    }
    function render() {
      var player = playerFor(activeId);
      if (!player) { hide(); return false; }
      var node = ensureScreen(), st = deps.getState(), id = player.id;
      var colors = player.isYou ? deps.getYouColors() : player;
      var primary = deps.normalizeColor(colors.primaryColor, '#FFFFFF');
      var secondary = deps.normalizeColor(colors.secondaryColor, '#808080');
      var name = player.isYou ? deps.getYouName() : player.name || 'Unnamed';
      var pid = player.isYou ? 'P000' : deps.getPlayerPid(st, id) || 'Unassigned';
      var stats = statsFor(id);
      var rival = player.rivalId ? playerFor(player.rivalId) : null;
      var image = player.imageId ? deps.cachedImageUrl(player.imageId) : '';
      var photo = '<div class="tp-profile-photo"><img data-profile-photo alt="' + att(name) +
        ' portrait" ' + (image ? 'src="' + att(image) + '"' : 'hidden') +
        '><span data-profile-photo-placeholder ' + (image ? 'hidden' : '') + '>No photo</span></div>';
      var rivalLink = rival ? '<button type="button" ' + ACTION + '="rival" data-rival-id="' +
        att(rival.id) + '" class="tp-profile-rival">Rival: ' + esc(rival.name) + ' ↗</button>' : '';
      var ratingButton = player.isYou ? '' : '<button type="button" ' + ACTION +
        '="advanced" class="tp-profile-inline-edit">Edit ratings</button>';
      var extraFields = player.isYou ? '' :
        '<label>Playing style<input name="style" value="' + att(player.style || '') + '"></label>';
      var activeField = player.isYou ? '' :
        '<label class="tp-profile-active"><input type="checkbox" name="active"' +
        (player.active !== false ? ' checked' : '') + '> Active player</label>';
      node.innerHTML = [
        '<div class="tp-profile-inner"><div class="tp-profile-topbar">',
        '<button type="button" ' + ACTION + '="back" class="tp-profile-back" aria-label="Back to players">← Players</button>',
        '<span class="tp-profile-eyebrow">PLAYER PROFILE</span>',
        '<button type="button" ' + ACTION + '="advanced" class="tp-profile-advanced">' +
          (player.isYou ? 'Edit photo' : 'Ratings & photo') + '</button></div>',
        '<div class="tp-profile-hero">', photo, '<div class="tp-profile-identity">',
        '<div class="tp-profile-pid">PID ' + esc(pid) + ' · ' +
          (player.isYou ? 'Your player' : player.active === false ? 'Inactive' : 'Active') + '</div>',
        '<h1 id="tpProfileName">' + esc(name) + '</h1>',
        '<div class="tp-profile-swatches"><span style="background:' + att(primary) +
          '"></span><span style="background:' + att(secondary) + '"></span></div>',
        '<div class="tp-profile-stats">',
        '<div><small>RECORD</small><strong>' + esc(stats.record) + '</strong></div>',
        '<div><small>PPD</small><strong>' + esc(stats.ppd) + '</strong></div>',
        '<div><small>GAMES</small><strong>' + esc(stats.games) + '</strong></div></div>',
        rivalLink, '</div></div>',
        '<div class="tp-profile-columns"><section class="tp-profile-panel"><h2>Player details</h2>',
        '<form id="tpPlayerProfileForm" class="tp-profile-form">',
        '<label>Name<input name="name" autocomplete="off" ' + (player.isYou ? '' : 'required') +
          ' value="' + att(player.isYou ? st.youName || '' : player.name || '') + '"></label>',
        '<label>Notes / biography<textarea name="notes" rows="4" placeholder="Player background, personality, or other notes">' +
          esc(player.notes || '') + '</textarea></label>',
        extraFields,
        '<label>Rival<select name="rivalId">' + deps.buildRivalOptions({
          excludePlayerId: id, selectedRivalId: player.rivalId || ''
        }) + '</select></label>',
        '<div class="tp-profile-colors">',
        '<label>Primary color<input name="primaryColor" type="color" value="' + att(primary) + '"></label>',
        '<label>Secondary color<input name="secondaryColor" type="color" value="' + att(secondary) + '"></label></div>',
        activeField,
        '<div class="tp-profile-actions"><button type="submit" class="btn btn-teal">Save profile</button>',
        '<span id="tpPlayerProfileSaved" role="status" aria-live="polite"></span></div></form></section>',
        '<section class="tp-profile-panel"><div class="tp-profile-section-title"><h2>' +
          (player.isYou ? 'Your performance' : 'Ratings') + '</h2>' + ratingButton + '</div>',
        ratingsFor(player), '</section></div></div>'
      ].join('');
      node.hidden = false;
      doc.body.classList.add('tp-player-profile-open');
      if (player.imageId && !image) {
        Promise.resolve(deps.loadImageUrl(player.imageId)).then(function(url) {
          if (!url || activeId !== id || !screen || screen.hidden) return;
          var img = screen.querySelector('[data-profile-photo]');
          var placeholder = screen.querySelector('[data-profile-photo-placeholder]');
          if (img) { img.src = url; img.hidden = false; }
          if (placeholder) placeholder.hidden = true;
        }).catch(function() {});
      }
      return true;
    }
    function saveForm(form) {
      var id = activeId, player = playerFor(id);
      if (!player) return false;
      function value(key) { return String(form.elements.namedItem(key)?.value || '').trim(); }
      var name = value('name');
      if (!name && id !== 'YOU') { form.elements.namedItem('name')?.focus(); return false; }
      var rivalId = value('rivalId');
      if (rivalId && (rivalId === id || !playerFor(rivalId))) return false;
      var st = deps.getState();
      var primary = deps.normalizeColor(value('primaryColor'), '#FFFFFF');
      var secondary = deps.normalizeColor(value('secondaryColor'), '#808080');
      var options = {};
      if (id === 'YOU') {
        st.youName = name;
        st.youNotes = value('notes');
        st.youRivalId = rivalId;
        st.youPrimaryColor = primary;
        st.youSecondaryColor = secondary;
        options = { allowStickyOverwriteKeys: ['youName', 'youNotes', 'youRivalId',
          'youPrimaryColor', 'youSecondaryColor'] };
      } else {
        var target = st.players.find(function(row) { return String(row?.id || '') === id; });
        if (!target) return false;
        target.name = name;
        target.notes = value('notes');
        target.style = value('style');
        target.rivalId = rivalId;
        target.primaryColor = primary;
        target.secondaryColor = secondary;
        var active = Boolean(form.elements.namedItem('active')?.checked);
        var wasActive = target.active !== false;
        target.active = active;
        if (wasActive !== active) deps.onActiveChange();
      }
      deps.save(deps.getState(), options);
      deps.renderRoster();
      render();
      var status = screen.querySelector('#tpPlayerProfileSaved');
      if (status) status.textContent = 'Saved';
      return true;
    }
    function hide() {
      if (!screen) return;
      screen.hidden = true;
      screen.innerHTML = '';
      doc.body.classList.remove('tp-player-profile-open');
      activeId = '';
    }
    function syncRoute() {
      var id = readRoute();
      if (!id || !playerFor(id)) { hide(); return; }
      var changed = id !== activeId;
      activeId = id;
      if (render() && changed) screen.scrollTop = 0;
    }
    function open(playerId) {
      var id = String(playerId || '');
      if (!playerFor(id)) return false;
      if (!activeId) returnHash = String(win.location.hash || '').indexOf(ROUTE) === 0
        ? '' : (win.location.hash || '');
      var hash = ROUTE + encodeURIComponent(id);
      if (win.location.hash !== hash && win.history?.pushState) {
        win.history.pushState({ tpProfileSession: token }, '', hash);
      }
      activeId = id;
      render();
      screen.scrollTop = 0;
      return true;
    }
    function close(options) {
      if (!options?.immediate && win.history?.state?.tpProfileSession === token && win.history?.back) {
        win.history.back();
        return;
      }
      var location = win.location;
      var backPath = location.pathname + location.search + (returnHash || '');
      if (win.history?.replaceState) win.history.replaceState(null, '', backPath);
      hide();
    }
    function init() {
      if (started) return;
      started = true;
      ensureScreen();
      win.addEventListener('popstate', syncRoute);
      win.addEventListener('hashchange', syncRoute);
      syncRoute();
    }
    return { init: init, open: open, close: close,
      refresh: function() { return activeId ? render() : false; },
      isOpen: function() { return Boolean(activeId); },
      activeId: function() { return activeId; }, saveForm: saveForm, statsFor: statsFor };
  }
  global.TaskPointsPlayerProfiles = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
