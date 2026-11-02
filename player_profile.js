/* Shared, lazy player-profile view. No duplicated player records, pages, or photos. */
(function (global) {
  'use strict';
  var ROUTE = '#player=';
  var ACTION = 'data-tp-profile-action';

  // Use the player's two existing colors to tint the entire profile.
  // All large surfaces are blended toward near-black so white UI text stays
  // readable even for white, yellow or other very bright player colors.
  // Accents are blended lighter so black/dark player colors remain visible.
  function profileThemeForColors(primaryColor, secondaryColor) {
    function hex(value, fallback) {
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        ? value.toLowerCase() : fallback;
    }
    function mix(a, b, shareA) {
      var x = hex(a, '#091014').slice(1);
      var y = hex(b, '#091014').slice(1);
      var channels = [0, 2, 4].map(function(offset) {
        var aChannel = parseInt(x.slice(offset, offset + 2), 16);
        var bChannel = parseInt(y.slice(offset, offset + 2), 16);
        return Math.round(aChannel * shareA + bChannel * (1 - shareA))
          .toString(16).padStart(2, '0');
      });
      return '#' + channels.join('');
    }

    var primary = hex(primaryColor, '#ffffff');
    var secondary = hex(secondaryColor, '#808080');
    var dark = '#091014';
    var light = '#e6f0ed';
    return {
      '--tp-profile-canvas-from': mix(primary, dark, 0.16),
      '--tp-profile-canvas-to': mix(secondary, dark, 0.14),
      '--tp-profile-hero-from': mix(primary, dark, 0.34),
      '--tp-profile-hero-to': mix(secondary, dark, 0.29),
      '--tp-profile-panel-from': mix(primary, dark, 0.22),
      '--tp-profile-panel-to': mix(secondary, dark, 0.18),
      '--tp-profile-button-from': mix(primary, dark, 0.30),
      '--tp-profile-button-to': mix(secondary, dark, 0.26),
      '--tp-profile-field': mix(secondary, dark, 0.10),
      '--tp-profile-metric': mix(secondary, dark, 0.16),
      '--tp-profile-accent': mix(primary, light, 0.36),
      '--tp-profile-accent-secondary': mix(secondary, light, 0.36),
      '--tp-profile-border': mix(primary, '#547077', 0.33),
      '--tp-profile-focus': mix(primary, '#c6f0e6', 0.30)
    };
  }

  function create(deps) {
    var doc = deps.document || global.document;
    var win = deps.window || global;
    var token = 'profile-' + Date.now().toString(36);
    var screen = null;
    var activeId = '';
    var returnHash = '';
    var started = false;
    var editingRatings = false;
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
        if (action === 'edit-ratings' && activeId !== 'YOU') {
          editingRatings = true;
          refreshRatingsSection();
          screen.querySelector('[name="baseline"]')?.focus?.({ preventScroll: true });
          return;
        }
        if (action === 'cancel-ratings') {
          editingRatings = false;
          refreshRatingsSection();
          screen.querySelector('#tpProfileEditRatings')?.focus?.({ preventScroll: true });
          return;
        }
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
        if (event.target.id === 'tpPlayerRatingsForm') {
          event.preventDefault();
          saveRatingsForm(event.target);
          return;
        }
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
    // Match the existing NPC editor's numeric fields and risky conversion.
    // Changes are written to the SAME player record only after validation.
    function ratingFields(player) {
      var fields = [
        { key: 'baseline', label: 'Baseline', fallback: 60 },
        { key: 'variance', label: 'Variance', fallback: 40 },
        { key: 'varianceTilt', label: 'Variance Tilt', fallback: 50 },
        { key: 'momentum', label: 'Momentum', fallback: 50 },
        { key: 'risky', label: 'Risky', fallback: 3 },
        { key: 'intimidation', label: 'INT', fallback: 0 },
        { key: 'poise', label: 'Poise', fallback: 0 },
        { key: 'greed', label: 'Greed', fallback: 0 },
        { key: 'streaky', label: 'Streaky', fallback: 0 }
      ];
      return fields.map(function(field) {
        var stored = Number(player[field.key]);
        var value = player[field.key] == null || !Number.isFinite(stored)
          ? field.fallback : stored;
        if (field.key === 'risky') value = value <= 10 ? value * 10 : value;
        return { key: field.key, label: field.label, value: value };
      });
    }

    function ratingsEditorFor(player) {
      return '<form id="tpPlayerRatingsForm" class="tp-profile-ratings-form">' +
        '<div class="tp-profile-ratings tp-profile-ratings-edit">' +
        ratingFields(player).map(function(field) {
          return '<label class="tp-profile-rating tp-profile-rating-edit">' +
            '<span>' + esc(field.label) + '</span>' +
            '<input name="' + att(field.key) + '" aria-label="' + att(field.label) +
            '" type="number" inputmode="decimal" min="0" max="100" step="any" required value="' +
            att(field.value) + '"></label>';
        }).join('') + '</div>' +
        '<p class="tp-profile-rating-help">Risky is entered from 0–100, matching the existing player editor.</p>' +
        '<p id="tpProfileRatingsError" role="alert" class="tp-profile-rating-error"></p>' +
        '<div class="tp-profile-rating-actions">' +
        '<button type="button" ' + ACTION + '="cancel-ratings" class="tp-profile-secondary-action">Cancel</button>' +
        '<button type="submit" class="tp-profile-primary-action">Save ratings</button>' +
        '</div></form>';
    }

    function refreshRatingsSection() {
      if (!screen || !activeId || activeId === 'YOU') return;
      var player = playerFor(activeId);
      if (!player) return;
      var content = screen.querySelector('#tpProfileRatingsContent');
      if (content) content.innerHTML = editingRatings ? ratingsEditorFor(player) : ratingsFor(player);
      var edit = screen.querySelector('#tpProfileEditRatings');
      if (edit) {
        edit.hidden = editingRatings;
        edit.setAttribute('aria-expanded', String(editingRatings));
      }
    }

    function parseRatings(form) {
      var values = {};
      for (var field of ratingFields({})) {
        var input = form.elements.namedItem(field.key);
        var raw = String(input?.value == null ? '' : input.value).trim();
        var number = raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(number) || number < 0 || number > 100) {
          return { valid: false, field: field.key };
        }
        values[field.key] = field.key === 'risky' ? number / 10 : number;
      }
      return { valid: true, values: values };
    }

    function reportInvalidRating(form, fieldName) {
      var input = form.elements.namedItem(fieldName);
      var error = screen?.querySelector('#tpProfileRatingsError');
      if (error) error.textContent = 'Enter a number from 0 to 100 for every rating.';
      input?.focus?.({ preventScroll: true });
    }

    function applyRatings(player, values) {
      Object.keys(values).forEach(function(key) { player[key] = values[key]; });
    }

    function saveRatingsForm(form) {
      var id = activeId;
      if (!id || id === 'YOU' || !editingRatings) return false;
      var target = playerFor(id);
      if (!target) return false;
      var parsed = parseRatings(form);
      if (!parsed.valid) { reportInvalidRating(form, parsed.field); return false; }
      applyRatings(target, parsed.values);
      deps.save(deps.getState(), {});
      deps.renderRoster();
      editingRatings = false;
      refreshRatingsSection();
      return true;
    }

    function render() {
      var player = playerFor(activeId);
      if (!player) { hide(); return false; }
      var node = ensureScreen(), st = deps.getState(), id = player.id;
      var colors = player.isYou ? deps.getYouColors() : player;
      var primary = deps.normalizeColor(colors.primaryColor, '#FFFFFF');
      var secondary = deps.normalizeColor(colors.secondaryColor, '#808080');
      var theme = profileThemeForColors(primary, secondary);
      Object.keys(theme).forEach(function(key) { node.style.setProperty(key, theme[key]); });
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
      var ratingButton = player.isYou ? '' : '<button type="button" id="tpProfileEditRatings" ' + ACTION +
        '="edit-ratings" aria-controls="tpProfileRatingsContent" aria-expanded="' +
        String(editingRatings) + '" class="tp-profile-inline-edit" ' +
        (editingRatings ? 'hidden' : '') + '>Edit ratings</button>';
      var extraFields = player.isYou ? '' :
        '<label>Playing style<input name="style" value="' + att(player.style || '') + '"></label>';
      var activeField = player.isYou ? '' :
        '<label class="tp-profile-active"><input type="checkbox" name="active"' +
        (player.active !== false ? ' checked' : '') + '> Active player</label>';
      node.innerHTML = [
        '<div class="tp-profile-inner"><div class="tp-profile-topbar">',
        '<span class="tp-profile-topbar-spacer" aria-hidden="true"></span>',
        '<button type="button" ' + ACTION + '="back" class="tp-profile-back" aria-label="Back to players">← Players</button>',
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
        '<div><small>MATCHUPS</small><strong>' + esc(stats.games) + '</strong></div></div>',
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
        '<div id="tpProfileRatingsContent">' +
          (editingRatings && !player.isYou ? ratingsEditorFor(player) : ratingsFor(player)) +
          '</div></section></div></div>'
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
      // Saving Player details also commits any open ratings edits. Never
      // silently discard an unsaved ratings form during a profile re-render.
      var pendingRatings = null;
      if (id !== 'YOU' && editingRatings) {
        var ratingsForm = screen?.querySelector('#tpPlayerRatingsForm');
        if (ratingsForm) {
          pendingRatings = parseRatings(ratingsForm);
          if (!pendingRatings.valid) {
            reportInvalidRating(ratingsForm, pendingRatings.field);
            return false;
          }
        }
      }
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
        if (pendingRatings) applyRatings(target, pendingRatings.values);
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
      editingRatings = false;
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
      editingRatings = false;
    }
    function syncRoute() {
      var id = readRoute();
      if (!id || !playerFor(id)) { hide(); return; }
      var changed = id !== activeId;
      if (changed) editingRatings = false;
      activeId = id;
      if (render() && changed) screen.scrollTop = 0;
    }
    function open(playerId) {
      var id = String(playerId || '');
      if (!playerFor(id)) return false;
      if (!activeId) returnHash = String(win.location.hash || '').indexOf(ROUTE) === 0
        ? '' : (win.location.hash || '');
      if (id !== activeId) editingRatings = false;
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
      activeId: function() { return activeId; }, saveForm: saveForm, statsFor: statsFor,
      saveRatingsForm: saveRatingsForm, editRatings: function() {
        if (!activeId || activeId === 'YOU') return false;
        editingRatings = true;
        refreshRatingsSection();
        return true;
      }, cancelRatings: function() {
        editingRatings = false;
        refreshRatingsSection();
      } };
  }
  global.TaskPointsPlayerProfiles = { create: create, profileThemeForColors: profileThemeForColors };
})(typeof window !== 'undefined' ? window : globalThis);
