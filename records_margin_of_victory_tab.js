(function installTaskPointsMarginOfVictoryRecordsTab(global) {
  'use strict';

  if (!global?.document || global.__taskPointsMarginOfVictoryRecordsTabInstalled) return;
  global.__taskPointsMarginOfVictoryRecordsTabInstalled = true;

  const STORAGE_KEY = 'taskpoints_v1';
  const $ = (id) => global.document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const ui = { include: 'all', topN: 50, search: '' };
  const imageUrls = new Map();
  const imageLoads = new Map();
  let lastRows = [];
  let listenersInstalled = false;

  function isRecordsPage() {
    return /(^|\/)records(?:\.html)?$/i.test(String(global.location?.pathname || ''));
  }

  function addState(list, candidate) {
    const state = candidate?.state || candidate;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    if (!list.includes(state)) list.push(state);
  }

  function loadFullStates() {
    try {
      const existing = global.TaskPointsGoldTheftRecordsHistoryFix?.loadFullStates?.();
      if (Array.isArray(existing) && existing.length) return existing;
    } catch (_) {}

    const core = global.TaskPointsCore || {};
    const states = [];
    try {
      if (typeof core.loadAppState === 'function') {
        addState(states, core.loadAppState({ syncDerived: false, persistSync: false }));
      }
    } catch (_) {}
    try {
      if (typeof core.readTaskPointsStoredState === 'function') {
        addState(states, core.readTaskPointsStoredState(STORAGE_KEY, {}) || {});
      }
    } catch (_) {}
    try {
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (raw) {
        const parsed = typeof core.parseTaskPointsStorageJson === 'function'
          ? core.parseTaskPointsStorageJson(raw, null)
          : JSON.parse(raw);
        addState(states, parsed);
      }
    } catch (_) {}
    if (!states.length) states.push({});
    return states;
  }

  function youName(state) {
    const name = typeof state?.youName === 'string' ? state.youName.trim() : '';
    return name || 'You';
  }

  function playerMaps(statesInput) {
    const states = Array.isArray(statesInput) ? statesInput : [statesInput || {}];
    const names = new Map();
    const images = new Map();

    states.forEach((state) => {
      (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
        const id = String(player?.id || player?.playerId || '');
        if (!id) return;
        if (!names.has(id)) names.set(id, String(player?.name || 'Unknown Player'));
        if (!images.has(id)) images.set(id, String(player?.imageId || ''));
      });
      if (!names.has('YOU')) names.set('YOU', youName(state));
      if (!images.has('YOU')) images.set('YOU', String(state?.youImageId || ''));
    });

    return { names, images };
  }

  function rowDateKey(row) {
    for (const value of [
      row?.dateKey,
      row?.date,
      row?.dateISO,
      row?.completedAtISO,
      row?.finalizedAtISO,
      row?.recordedAtISO,
      row?.createdAtISO
    ]) {
      if (value == null || value === '') continue;
      const direct = String(value).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function isRevealed(dateKey, now = new Date()) {
    const key = String(dateKey || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;

    if (typeof global.isRecordResultRevealed === 'function') {
      try { return global.isRecordResultRevealed(key, now); } catch (_) {}
    }

    const revealDay = new Date(now);
    if (revealDay.getHours() < 5) revealDay.setDate(revealDay.getDate() - 1);
    revealDay.setHours(0, 0, 0, 0);

    const y = revealDay.getFullYear();
    const m = String(revealDay.getMonth() + 1).padStart(2, '0');
    const d = String(revealDay.getDate()).padStart(2, '0');
    return key < y + '-' + m + '-' + d;
  }

  function matchupName(matchup, side, playerId, names) {
    if (names.has(playerId)) return names.get(playerId);
    const direct = matchup?.[side + 'Name']
      || matchup?.[side]?.name
      || matchup?.[side + 'PlayerName'];
    return String(direct || 'Unknown Player');
  }

  function visitHistoricalMatchups(state, callback) {
    (Array.isArray(state?.matchups) ? state.matchups : []).forEach(callback);
    (Array.isArray(state?.gameHistory) ? state.gameHistory : []).forEach(callback);
    (Array.isArray(state?.currentSeason?.tournamentMatchupResults) ? state.currentSeason.tournamentMatchupResults : []).forEach(callback);
    (Array.isArray(state?.seasonHistory) ? state.seasonHistory : []).forEach((season) => {
      (Array.isArray(season?.tournamentMatchupResults) ? season.tournamentMatchupResults : []).forEach(callback);
    });
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach(callback);
    });
  }

  function buildMarginRows(statesInput, options = {}) {
    const states = Array.isArray(statesInput) ? statesInput : [statesInput || {}];
    const { names, images } = playerMaps(states);
    const rowsByKey = new Map();
    const now = options.now instanceof Date ? options.now : new Date();

    states.forEach((state) => {
      visitHistoricalMatchups(state, (matchup) => {
        const playerAId = String(matchup?.playerAId || '');
        const playerBId = String(matchup?.playerBId || '');
        const scoreA = Number(matchup?.scoreA);
        const scoreB = Number(matchup?.scoreB);
        const date = rowDateKey(matchup);

        if (!playerAId || !playerBId) return;
        if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return;
        if (scoreA === scoreB) return;
        if (!isRevealed(date, now)) return;

        const aWon = scoreA > scoreB;
        const winnerId = aWon ? playerAId : playerBId;
        const loserId = aWon ? playerBId : playerAId;
        const winnerScore = aWon ? scoreA : scoreB;
        const loserScore = aWon ? scoreB : scoreA;
        const margin = Math.abs(scoreA - scoreB);
        const matchupId = String(matchup?.id || matchup?.matchupId || '').trim();
        const matchupType = String(matchup?.matchupType || matchup?.type || 'game');

        const row = {
          winnerId,
          winnerName: matchupName(matchup, aWon ? 'playerA' : 'playerB', winnerId, names),
          winnerImageId: images.get(winnerId) || '',
          loserId,
          loserName: matchupName(matchup, aWon ? 'playerB' : 'playerA', loserId, names),
          date,
          margin,
          winnerScore,
          loserScore,
          matchupId,
          matchupType
        };

        const fallbackKey = [
          date,
          playerAId,
          playerBId,
          scoreA,
          scoreB,
          matchupType
        ].join('|');
        const key = matchupId ? 'matchup:' + matchupId : 'fallback:' + fallbackKey;

        if (!rowsByKey.has(key)) rowsByKey.set(key, row);
      });
    });

    return [...rowsByKey.values()].sort((a, b) =>
      b.margin - a.margin
      || b.winnerScore - a.winnerScore
      || String(b.date).localeCompare(String(a.date))
      || a.winnerName.localeCompare(b.winnerName)
    );
  }

  function formatDate(value) {
    const raw = String(value || '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return raw || '—';
    try {
      const dt = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return dt.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
    } catch (_) {
      return raw;
    }
  }

  function formatScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return String((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
  }

  async function imageUrl(imageId) {
    if (!imageId) return '';
    if (imageUrls.has(imageId)) return imageUrls.get(imageId);
    if (imageLoads.has(imageId)) return imageLoads.get(imageId);

    const promise = (async () => {
      try {
        const blob = await global.TaskPointsCore?.getImageBlob?.(imageId);
        if (!blob) return '';
        const url = URL.createObjectURL(blob);
        imageUrls.set(imageId, url);
        return url;
      } catch (_) {
        return '';
      } finally {
        imageLoads.delete(imageId);
      }
    })();

    imageLoads.set(imageId, promise);
    return promise;
  }

  function photoHtml(row) {
    const imageId = String(row?.winnerImageId || '');
    const cached = imageUrls.get(imageId) || '';
    if (cached) {
      return '<div class="recordPhotoSlot" data-margin-image-id="' + esc(imageId) + '"><img class="recordPhoto" src="' + esc(cached) + '" alt="' + esc(row.winnerName) + ' photo"></div>';
    }
    return '<div class="recordPhotoSlot"' + (imageId ? ' data-margin-image-id="' + esc(imageId) + '"' : '') + '><img class="recordPhoto hidden" alt="' + esc(row.winnerName) + ' photo"><div class="recordPhotoFallback">' + esc(initials(row.winnerName)) + '</div></div>';
  }

  async function hydrateImages(rows) {
    const ids = [...new Set(rows.map((row) => row.winnerImageId).filter(Boolean))];
    if (!ids.length) return;
    await Promise.all(ids.map(imageUrl));

    global.document.querySelectorAll?.('[data-margin-image-id]').forEach((slot) => {
      const id = slot.getAttribute('data-margin-image-id') || '';
      const url = imageUrls.get(id);
      if (!url) return;
      const img = slot.querySelector('img.recordPhoto');
      if (img) {
        img.src = url;
        img.classList.remove('hidden');
      }
      slot.querySelector('.recordPhotoFallback')?.classList.add('hidden');
    });
  }

  function filteredRows(rows) {
    let out = rows.slice();
    if (ui.include === 'you') out = out.filter((row) => row.winnerId === 'YOU');
    else if (ui.include === 'players') out = out.filter((row) => row.winnerId !== 'YOU');

    const q = ui.search.trim().toLowerCase();
    if (q) out = out.filter((row) => row.winnerName.toLowerCase().includes(q));

    return out.slice(0, ui.topN);
  }

  function updateSummary() {
    const states = loadFullStates();
    const name = youName(states[0] || {});
    const label = ui.include === 'you'
      ? name + ' only'
      : ui.include === 'players'
        ? 'Players only'
        : 'All';
    const search = ui.search.trim() ? 'Search: ' + ui.search.trim() : '';
    const summary = $('marginRecordsControlsSummary');
    if (summary) summary.textContent = [label, 'Top ' + ui.topN, search].filter(Boolean).join(' · ');
  }

  function setControlsCollapsed(collapsed) {
    const card = $('marginRecordsControlsCard');
    const toggle = $('marginRecordsControlsToggle');
    card?.classList.toggle('collapsed', collapsed);
    toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function renderMargin() {
    const states = loadFullStates();
    const state = states[0] || {};
    const name = youName(state);
    const all = buildMarginRows(states);
    const top = filteredRows(all);

    if ($('marginRecordsIncludeAllOption')) $('marginRecordsIncludeAllOption').textContent = 'All (' + name + ' + Players)';
    if ($('marginRecordsIncludeYouOption')) $('marginRecordsIncludeYouOption').textContent = name + ' only';
    if ($('marginRecordsMetaLine')) $('marginRecordsMetaLine').textContent = 'Saved: ' + all.length.toLocaleString() + ' winning game results';

    const tbody = $('marginRecordsTbody');
    const empty = $('marginRecordsEmptyState');
    const wrap = $('marginRecordsTableWrap');
    const sub = $('marginRecordsSubtitleLine');

    if (!top.length) {
      empty?.classList.remove('hidden');
      wrap?.classList.add('hidden');
      if (sub) sub.textContent = 'No matching records.';
      if (tbody) tbody.innerHTML = '';
      lastRows = [];
      return true;
    }

    empty?.classList.add('hidden');
    wrap?.classList.remove('hidden');

    const best = top[0]?.margin || 0;
    const avg = top.reduce((sum, row) => sum + row.margin, 0) / top.length;
    if (sub) sub.textContent = 'Showing ' + top.length + ' — Best: ' + best.toFixed(1) + ' · Avg (shown): ' + avg.toFixed(1);

    if (tbody) {
      tbody.innerHTML = top.map((row, index) => {
        const sourcePill = row.winnerId === 'YOU'
          ? '<span class="pill pill-orange">' + esc(name) + '</span>'
          : '<span class="pill pill-blue">Player</span>';
        return '<tr>'
          + '<td class="rankCell num font-extrabold">' + (index + 1) + '</td>'
          + '<td class="scoreCell num font-extrabold">' + row.margin.toFixed(1) + '</td>'
          + '<td class="imageCell">' + photoHtml(row) + '</td>'
          + '<td class="playerCell"><div class="font-semibold">' + esc(row.winnerName) + '</div></td>'
          + '<td class="opponentCell"><div class="font-semibold">' + esc(row.loserName) + '</div></td>'
          + '<td class="finalScoreCell num font-semibold">' + esc(formatScore(row.winnerScore) + '–' + formatScore(row.loserScore)) + '</td>'
          + '<td class="dateCell num">' + esc(formatDate(row.date)) + '</td>'
          + '<td class="srcCell">' + sourcePill + '</td>'
          + '</tr>';
      }).join('');
    }

    lastRows = top;
    hydrateImages(top);
    return true;
  }

  async function copyMarginList() {
    if (!lastRows.length) return;
    const states = loadFullStates();
    const name = youName(states[0] || {});
    const text = lastRows.map((row, index) =>
      (index + 1) + '. ' + row.margin.toFixed(1) + ' margin — '
      + row.winnerName + ' def. ' + row.loserName + ', '
      + formatScore(row.winnerScore) + '–' + formatScore(row.loserScore)
      + ' — ' + row.date + ' — ' + (row.winnerId === 'YOU' ? name : 'Player')
    ).join('\n');

    try {
      if (typeof global.navigator?.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await global.navigator.clipboard.writeText(text);
      const button = $('marginRecordsCopyBtn');
      if (!button) return;
      const previous = button.textContent;
      button.textContent = 'Copied!';
      global.setTimeout(() => { button.textContent = previous; }, 900);
    } catch (_) {
      global.alert?.('Couldn’t copy automatically. (Clipboard blocked.)\n\nTip: select and copy from the table.');
    }
  }

  function addStyles() {
    if ($('recordsMarginOfVictoryTabStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'recordsMarginOfVictoryTabStyles';
    style.textContent = [
      '#marginRecordsSubtitleLine{font-size:15px;line-height:1.35}',
      '#marginRecordsCopyBtn{font-size:15px;padding:10px 14px;min-height:44px;white-space:nowrap}',
      '#marginRecordsRefreshBtn{background:linear-gradient(180deg,#fdba74,#fb923c);color:#111827;border-color:transparent;outline:none;box-shadow:none;font-weight:700}',
      '#marginRecordsTableWrap .opponentCell{white-space:nowrap}',
      '.finalScoreCell{width:120px;min-width:120px;white-space:nowrap}',
      '@media(max-width:640px){#marginRecordsSubtitleLine{font-size:14px;line-height:1.3}#marginRecordsCopyBtn{font-size:14px;padding:8px 12px;min-height:40px}.finalScoreCell{width:92px;min-width:92px}}'
    ].join('');
    global.document.head.appendChild(style);
  }

  function selectMarginTab() {
    $('scoreRecordsTabPanel')?.classList.add('hidden');
    $('goldRecordsTabPanel')?.classList.add('hidden');
    $('marginRecordsTabPanel')?.classList.remove('hidden');

    $('scoreRecordsTab')?.classList.remove('active');
    $('goldRecordsTab')?.classList.remove('active');
    $('marginRecordsTab')?.classList.add('active');

    $('scoreRecordsTab')?.setAttribute('aria-selected', 'false');
    $('goldRecordsTab')?.setAttribute('aria-selected', 'false');
    $('marginRecordsTab')?.setAttribute('aria-selected', 'true');

    renderMargin();
  }

  function leaveMarginTab() {
    $('marginRecordsTabPanel')?.classList.add('hidden');
    $('marginRecordsTab')?.classList.remove('active');
    $('marginRecordsTab')?.setAttribute('aria-selected', 'false');
  }

  function buildUi() {
    if (!isRecordsPage()) return false;
    const tabBar = $('recordsTabBar');
    const goldPanel = $('goldRecordsTabPanel');
    if (!tabBar || !goldPanel) return false;
    if ($('marginRecordsTab')) return true;

    addStyles();

    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = 'recordsTabButton';
    button.id = 'marginRecordsTab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('aria-controls', 'marginRecordsTabPanel');
    button.textContent = 'Margin of Victory';
    tabBar.appendChild(button);

    const panel = global.document.createElement('div');
    panel.id = 'marginRecordsTabPanel';
    panel.className = 'recordsTabPanel hidden';
    panel.setAttribute('role', 'tabpanel');
    panel.innerHTML = [
      '<section class="glass mb-4 recordsControlsCard collapsed" id="marginRecordsControlsCard">',
      '<button type="button" class="recordsControlsToggle" id="marginRecordsControlsToggle" aria-expanded="false">',
      '<span>Filters</span>',
      '<span class="recordsControlsSummary" id="marginRecordsControlsSummary">All · Top 50</span>',
      '<span class="recordsControlsChevron">▾</span>',
      '</button>',
      '<div class="recordsControlsBody" id="marginRecordsControlsBody">',
      '<div class="grid gap-3 sm:grid-cols-12 sm:items-end">',
      '<div class="sm:col-span-4"><label class="muted">Search player</label><input id="marginRecordsSearchInput" class="input" placeholder="Type a name…" /></div>',
      '<div class="sm:col-span-3"><label class="muted">Include</label><select id="marginRecordsIncludeSelect" class="input"><option value="all" id="marginRecordsIncludeAllOption">All (You + Players)</option><option value="you" id="marginRecordsIncludeYouOption">You only</option><option value="players">Players only</option></select></div>',
      '<div class="sm:col-span-3"><label class="muted">Top</label><select id="marginRecordsTopSelect" class="input"><option value="50">Top 50</option><option value="25">Top 25</option><option value="100">Top 100</option><option value="250">Top 250</option></select></div>',
      '<div class="sm:col-span-2 flex gap-2"><button id="marginRecordsRefreshBtn" class="btn btn-warn w-full">Refresh</button></div>',
      '</div>',
      '<div class="flex flex-col sm:flex-row sm:items-center gap-2 mt-3">',
      '<span class="pill pill-orange">Scoring source: finalized matchup results</span>',
      '<span class="pill pill-blue">Records: winning score margins</span>',
      '<span class="muted sm:ml-auto" id="marginRecordsMetaLine">—</span>',
      '</div>',
      '</div>',
      '</section>',
      '<section class="glass">',
      '<div class="flex justify-between gap-3 mb-3 recordsTitleRow">',
      '<div><div class="font-extrabold recordsTitle">Largest Single-Game Margins of Victory</div><div class="muted" id="marginRecordsSubtitleLine">—</div></div>',
      '<button id="marginRecordsCopyBtn" class="btn btn-ghost">Copy list</button>',
      '</div>',
      '<div id="marginRecordsEmptyState" class="muted hidden">No winning matchup records found.</div>',
      '<div class="tableWrap" id="marginRecordsTableWrap">',
      '<table><thead><tr>',
      '<th class="rankCell">Rank</th>',
      '<th class="scoreCell">Margin</th>',
      '<th class="imageCell"></th>',
      '<th class="playerCell">Winner</th>',
      '<th class="opponentCell">Opponent</th>',
      '<th class="finalScoreCell">Final Score</th>',
      '<th class="dateCell">Date</th>',
      '<th class="srcCell">Source</th>',
      '</tr></thead><tbody id="marginRecordsTbody"></tbody></table>',
      '</div>',
      '</section>'
    ].join('');
    goldPanel.insertAdjacentElement('afterend', panel);

    if (!listenersInstalled) {
      listenersInstalled = true;
      $('marginRecordsTab')?.addEventListener('click', selectMarginTab);
      $('scoreRecordsTab')?.addEventListener('click', leaveMarginTab);
      $('goldRecordsTab')?.addEventListener('click', leaveMarginTab);
      $('marginRecordsControlsToggle')?.addEventListener('click', () => setControlsCollapsed(!$('marginRecordsControlsCard')?.classList.contains('collapsed')));
      $('marginRecordsIncludeSelect')?.addEventListener('change', (event) => {
        ui.include = event.target.value;
        updateSummary();
        renderMargin();
      });
      $('marginRecordsTopSelect')?.addEventListener('change', (event) => {
        ui.topN = Number(event.target.value || 50);
        updateSummary();
        renderMargin();
      });

      let searchTimer = null;
      $('marginRecordsSearchInput')?.addEventListener('input', (event) => {
        ui.search = event.target.value || '';
        updateSummary();
        global.clearTimeout(searchTimer);
        searchTimer = global.setTimeout(renderMargin, 120);
      });

      $('marginRecordsRefreshBtn')?.addEventListener('click', renderMargin);
      $('marginRecordsCopyBtn')?.addEventListener('click', copyMarginList);
      global.addEventListener?.('pageshow', () => {
        if ($('marginRecordsTab')?.classList.contains('active')) renderMargin();
      });
      global.addEventListener?.('taskpoints:state-revision', () => {
        if ($('marginRecordsTab')?.classList.contains('active')) renderMargin();
      });
    }

    updateSummary();
    setControlsCollapsed(true);
    return true;
  }

  function install() {
    if (buildUi()) return true;
    return false;
  }

  global.TaskPointsMarginOfVictoryRecordsTab = {
    installed: true,
    loadFullStates,
    buildMarginRows,
    render: renderMargin,
    install
  };

  function start() {
    if (!isRecordsPage()) return;
    if (install()) return;
    let attempts = 0;
    const timer = global.setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 80) global.clearInterval(timer);
    }, 50);
  }

  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
