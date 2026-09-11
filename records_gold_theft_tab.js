(function installTaskPointsGoldTheftRecordsTab(global) {
  'use strict';

  if (!global?.document || global.__taskPointsGoldTheftRecordsTabInstalled) return;
  global.__taskPointsGoldTheftRecordsTabInstalled = true;

  const STORAGE_KEY = 'taskpoints_v1';
  const $ = (id) => global.document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const roundGold = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
  const ui = { include: 'all', topN: 50, search: '' };
  let imageUrls = new Map();
  let imageLoads = new Map();
  let lastRows = [];

  function isRecordsPage() {
    return /(^|\/)records(?:\.html)?$/i.test(String(global.location?.pathname || ''));
  }

  function loadState() {
    try {
      const core = global.TaskPointsCore || {};
      if (typeof core.readTaskPointsStoredState === 'function') {
        return core.readTaskPointsStoredState(STORAGE_KEY, {}) || {};
      }
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.error('Gold Theft records could not load state', error);
      return {};
    }
  }

  function youName(state) {
    const name = typeof state?.youName === 'string' ? state.youName.trim() : '';
    return name || 'You';
  }

  function playerMaps(state) {
    const names = new Map();
    const images = new Map();
    (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
      const id = String(player?.id || player?.playerId || '');
      if (!id) return;
      names.set(id, String(player?.name || 'Unknown Player'));
      images.set(id, String(player?.imageId || ''));
    });
    names.set('YOU', youName(state));
    images.set('YOU', String(state?.youImageId || ''));
    return { names, images };
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

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
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
    const imageId = String(row?.imageId || '');
    const cached = imageUrls.get(imageId) || '';
    if (cached) {
      return `<div class="recordPhotoSlot" data-gold-image-id="${esc(imageId)}"><img class="recordPhoto" src="${esc(cached)}" alt="${esc(row.playerName)} photo"></div>`;
    }
    return `<div class="recordPhotoSlot" ${imageId ? `data-gold-image-id="${esc(imageId)}"` : ''}><img class="recordPhoto hidden" alt="${esc(row.playerName)} photo"><div class="recordPhotoFallback">${esc(initials(row.playerName))}</div></div>`;
  }

  async function hydrateImages(rows) {
    const ids = [...new Set(rows.map((row) => row.imageId).filter(Boolean))];
    if (!ids.length) return;
    await Promise.all(ids.map(imageUrl));
    global.document.querySelectorAll('[data-gold-image-id]').forEach((slot) => {
      const id = slot.getAttribute('data-gold-image-id') || '';
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

  function buildRows(state) {
    const { names, images } = playerMaps(state);
    return (Array.isArray(state?.goldLedger) ? state.goldLedger : [])
      .filter((row) => row?.type === 'matchup_theft' && Number(row.amount) > 0)
      .map((row) => {
        const playerId = String(row.playerId || '');
        return {
          playerId,
          playerName: names.get(playerId) || 'Unknown Player',
          imageId: images.get(playerId) || '',
          date: String(row.dateKey || row.createdAtISO || '').slice(0, 10),
          amount: roundGold(row.amount),
          opponentId: String(row.opponentId || ''),
          opponentName: names.get(String(row.opponentId || '')) || 'Unknown Player',
          matchupId: String(row.matchupId || ''),
          source: 'Gold Theft'
        };
      })
      .sort((a, b) => b.amount - a.amount || String(b.date).localeCompare(String(a.date)) || a.playerName.localeCompare(b.playerName));
  }

  function filteredRows(rows) {
    let out = rows.slice();
    if (ui.include === 'you') out = out.filter((row) => row.playerId === 'YOU');
    else if (ui.include === 'players') out = out.filter((row) => row.playerId !== 'YOU');
    const q = ui.search.trim().toLowerCase();
    if (q) out = out.filter((row) => row.playerName.toLowerCase().includes(q));
    return out.slice(0, ui.topN);
  }

  function updateSummary() {
    const label = ui.include === 'you' ? `${youName(loadState())} only` : ui.include === 'players' ? 'Players only' : 'All';
    const search = ui.search.trim() ? `Search: ${ui.search.trim()}` : '';
    $('goldRecordsControlsSummary').textContent = [label, `Top ${ui.topN}`, search].filter(Boolean).join(' · ');
  }

  function setControlsCollapsed(collapsed) {
    const card = $('goldRecordsControlsCard');
    const toggle = $('goldRecordsControlsToggle');
    card?.classList.toggle('collapsed', collapsed);
    toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function renderGold() {
    const state = loadState();
    const all = buildRows(state);
    const top = filteredRows(all);
    const tbody = $('goldRecordsTbody');
    const empty = $('goldRecordsEmptyState');
    const wrap = $('goldRecordsTableWrap');
    const meta = $('goldRecordsMetaLine');
    const sub = $('goldRecordsSubtitleLine');
    const name = youName(state);

    const allOption = $('goldRecordsIncludeAllOption');
    const youOption = $('goldRecordsIncludeYouOption');
    if (allOption) allOption.textContent = `All (${name} + Players)`;
    if (youOption) youOption.textContent = `${name} only`;
    if (meta) meta.textContent = `Saved: ${all.length.toLocaleString()} Gold theft records`;

    if (!top.length) {
      empty?.classList.remove('hidden');
      wrap?.classList.add('hidden');
      if (sub) sub.textContent = 'No matching records.';
      if (tbody) tbody.innerHTML = '';
      lastRows = [];
      return;
    }

    empty?.classList.add('hidden');
    wrap?.classList.remove('hidden');
    const best = top[0]?.amount || 0;
    const avg = top.reduce((sum, row) => sum + row.amount, 0) / top.length;
    if (sub) sub.textContent = `Showing ${top.length} — Best: ${best.toFixed(1)} · Avg (shown): ${avg.toFixed(1)}`;

    if (tbody) {
      tbody.innerHTML = top.map((row, index) => {
        const sourcePill = row.playerId === 'YOU'
          ? `<span class="pill pill-orange">${esc(name)}</span>`
          : '<span class="pill pill-blue">Player</span>';
        return `<tr>
          <td class="rankCell num font-extrabold">${index + 1}</td>
          <td class="scoreCell num font-extrabold">${row.amount.toFixed(1)}</td>
          <td class="imageCell">${photoHtml(row)}</td>
          <td class="playerCell"><div class="font-semibold">${esc(row.playerName)}</div></td>
          <td class="dateCell num">${esc(formatDate(row.date))}</td>
          <td class="srcCell">${sourcePill}</td>
        </tr>`;
      }).join('');
    }
    lastRows = top;
    hydrateImages(top);
  }

  async function copyGoldList() {
    if (!lastRows.length) return;
    const name = youName(loadState());
    const text = lastRows.map((row, index) => `${index + 1}. ${row.amount.toFixed(1)} Gold — ${row.playerName} — ${row.date} — ${row.playerId === 'YOU' ? name : 'Player'}`).join('\n');
    try {
      await global.navigator.clipboard.writeText(text);
      const button = $('goldRecordsCopyBtn');
      const previous = button.textContent;
      button.textContent = 'Copied!';
      global.setTimeout(() => { button.textContent = previous; }, 900);
    } catch (_) {
      global.alert('Couldn’t copy automatically. (Clipboard blocked.)\n\nTip: select and copy from the table.');
    }
  }

  function addStyles() {
    if ($('recordsGoldTheftTabStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'recordsGoldTheftTabStyles';
    style.textContent = `
      .recordsTabBar{display:flex;gap:8px;margin:0 0 16px;padding:5px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.035)}
      .recordsTabButton{flex:1;min-height:42px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-weight:800;font-size:14px;cursor:pointer}
      .recordsTabButton.active{background:linear-gradient(180deg,rgba(37,76,82,.78),rgba(26,56,59,.68));color:#d8fbff;box-shadow:inset 0 0 0 1px rgba(30,102,109,.75)}
      .recordsTabPanel.hidden{display:none!important}
      #goldRecordsSubtitleLine{font-size:15px;line-height:1.35}
      #goldRecordsCopyBtn{font-size:15px;padding:10px 14px;min-height:44px;white-space:nowrap}
      #goldRecordsRefreshBtn{background:linear-gradient(180deg,#fdba74,#fb923c);color:#111827;border-color:transparent;outline:none;box-shadow:none;font-weight:700}
      @media(max-width:640px){#goldRecordsSubtitleLine{font-size:14px;line-height:1.3}#goldRecordsCopyBtn{font-size:14px;padding:8px 12px;min-height:40px}}
    `;
    global.document.head.appendChild(style);
  }

  function buildUi() {
    if (!isRecordsPage() || $('recordsTabBar')) return false;
    const controls = $('recordsControlsCard');
    const tableWrap = $('tableWrap');
    const scoreSection = tableWrap?.closest?.('section.glass');
    if (!controls || !scoreSection || !controls.parentNode || controls.parentNode !== scoreSection.parentNode) return false;

    addStyles();
    const parent = controls.parentNode;
    const scorePanel = global.document.createElement('div');
    scorePanel.id = 'scoreRecordsTabPanel';
    scorePanel.className = 'recordsTabPanel';
    parent.insertBefore(scorePanel, controls);
    scorePanel.appendChild(controls);
    scorePanel.appendChild(scoreSection);

    const tabBar = global.document.createElement('div');
    tabBar.id = 'recordsTabBar';
    tabBar.className = 'recordsTabBar';
    tabBar.setAttribute('role', 'tablist');
    tabBar.innerHTML = `
      <button type="button" class="recordsTabButton active" id="scoreRecordsTab" role="tab" aria-selected="true" aria-controls="scoreRecordsTabPanel">Single-Game Scores</button>
      <button type="button" class="recordsTabButton" id="goldRecordsTab" role="tab" aria-selected="false" aria-controls="goldRecordsTabPanel">Gold Theft</button>`;
    parent.insertBefore(tabBar, scorePanel);

    const goldPanel = global.document.createElement('div');
    goldPanel.id = 'goldRecordsTabPanel';
    goldPanel.className = 'recordsTabPanel hidden';
    goldPanel.setAttribute('role', 'tabpanel');
    goldPanel.innerHTML = `
      <section class="glass mb-4 recordsControlsCard collapsed" id="goldRecordsControlsCard">
        <button type="button" class="recordsControlsToggle" id="goldRecordsControlsToggle" aria-expanded="false">
          <span>Filters</span>
          <span class="recordsControlsSummary" id="goldRecordsControlsSummary">All · Top 50</span>
          <span class="recordsControlsChevron">▾</span>
        </button>
        <div class="recordsControlsBody" id="goldRecordsControlsBody">
          <div class="grid gap-3 sm:grid-cols-12 sm:items-end">
            <div class="sm:col-span-4"><label class="muted">Search player</label><input id="goldRecordsSearchInput" class="input" placeholder="Type a name…" /></div>
            <div class="sm:col-span-3"><label class="muted">Include</label><select id="goldRecordsIncludeSelect" class="input"><option value="all" id="goldRecordsIncludeAllOption">All (You + Players)</option><option value="you" id="goldRecordsIncludeYouOption">You only</option><option value="players">Players only</option></select></div>
            <div class="sm:col-span-3"><label class="muted">Top</label><select id="goldRecordsTopSelect" class="input"><option value="50">Top 50</option><option value="25">Top 25</option><option value="100">Top 100</option><option value="250">Top 250</option></select></div>
            <div class="sm:col-span-2 flex gap-2"><button id="goldRecordsRefreshBtn" class="btn btn-warn w-full">Refresh</button></div>
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center gap-2 mt-3">
            <span class="pill pill-orange">Scoring source: Gold Theft ledger</span>
            <span class="pill pill-blue">Records: positive theft transfers</span>
            <span class="muted sm:ml-auto" id="goldRecordsMetaLine">—</span>
          </div>
        </div>
      </section>
      <section class="glass">
        <div class="flex justify-between gap-3 mb-3 recordsTitleRow">
          <div><div class="font-extrabold recordsTitle">Top Single-Game Gold Thefts</div><div class="muted" id="goldRecordsSubtitleLine">—</div></div>
          <button id="goldRecordsCopyBtn" class="btn btn-ghost">Copy list</button>
        </div>
        <div id="goldRecordsEmptyState" class="muted hidden">No Gold theft records found.</div>
        <div class="tableWrap" id="goldRecordsTableWrap">
          <table>
            <thead><tr><th class="rankCell">Rank</th><th class="scoreCell">Gold Stolen</th><th class="imageCell"></th><th class="playerCell">Player</th><th class="dateCell">Date</th><th class="srcCell">Source</th></tr></thead>
            <tbody id="goldRecordsTbody"></tbody>
          </table>
        </div>
      </section>`;
    scorePanel.insertAdjacentElement('afterend', goldPanel);

    $('scoreRecordsTab').addEventListener('click', () => selectTab('scores'));
    $('goldRecordsTab').addEventListener('click', () => selectTab('gold'));
    $('goldRecordsControlsToggle').addEventListener('click', () => setControlsCollapsed(!$('goldRecordsControlsCard').classList.contains('collapsed')));
    $('goldRecordsIncludeSelect').addEventListener('change', (event) => { ui.include = event.target.value; updateSummary(); renderGold(); });
    $('goldRecordsTopSelect').addEventListener('change', (event) => { ui.topN = Number(event.target.value || 50); updateSummary(); renderGold(); });
    let searchTimer = null;
    $('goldRecordsSearchInput').addEventListener('input', (event) => {
      ui.search = event.target.value || '';
      updateSummary();
      global.clearTimeout(searchTimer);
      searchTimer = global.setTimeout(renderGold, 120);
    });
    $('goldRecordsRefreshBtn').addEventListener('click', renderGold);
    $('goldRecordsCopyBtn').addEventListener('click', copyGoldList);
    updateSummary();
    setControlsCollapsed(true);
    return true;
  }

  function selectTab(tab) {
    const gold = tab === 'gold';
    $('scoreRecordsTabPanel')?.classList.toggle('hidden', gold);
    $('goldRecordsTabPanel')?.classList.toggle('hidden', !gold);
    $('scoreRecordsTab')?.classList.toggle('active', !gold);
    $('goldRecordsTab')?.classList.toggle('active', gold);
    $('scoreRecordsTab')?.setAttribute('aria-selected', gold ? 'false' : 'true');
    $('goldRecordsTab')?.setAttribute('aria-selected', gold ? 'true' : 'false');
    if (gold) renderGold();
  }

  function start() {
    if (!isRecordsPage()) return;
    if (buildUi()) return;
    let attempts = 0;
    const timer = global.setInterval(() => {
      attempts += 1;
      if (buildUi() || attempts >= 20) global.clearInterval(timer);
    }, 100);
  }

  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
