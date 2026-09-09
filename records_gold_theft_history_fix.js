(function installTaskPointsGoldTheftRecordsHistoryFix(global) {
  'use strict';

  if (!global?.document || global.__taskPointsGoldTheftRecordsHistoryFixInstalled) return;
  global.__taskPointsGoldTheftRecordsHistoryFixInstalled = true;

  const STORAGE_KEY = 'taskpoints_v1';
  const $ = (id) => global.document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const roundGold = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
  const imageUrls = new Map();
  const imageLoads = new Map();

  function loadFullState() {
    const core = global.TaskPointsCore || {};
    try {
      if (typeof core.loadAppState === 'function') {
        const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
        const state = loaded?.state || loaded;
        if (state && typeof state === 'object') return state;
      }
    } catch (error) {
      console.warn('Gold Theft records full-state load failed; falling back to stored snapshot.', error);
    }
    try {
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

  function maps(state) {
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
    if (cached) return `<div class="recordPhotoSlot" data-gold-history-image-id="${esc(imageId)}"><img class="recordPhoto" src="${esc(cached)}" alt="${esc(row.playerName)} photo"></div>`;
    return `<div class="recordPhotoSlot" ${imageId ? `data-gold-history-image-id="${esc(imageId)}"` : ''}><img class="recordPhoto hidden" alt="${esc(row.playerName)} photo"><div class="recordPhotoFallback">${esc(initials(row.playerName))}</div></div>`;
  }

  async function hydrateImages(rows) {
    const ids = [...new Set(rows.map((row) => row.imageId).filter(Boolean))];
    if (!ids.length) return;
    await Promise.all(ids.map(imageUrl));
    global.document.querySelectorAll('[data-gold-history-image-id]').forEach((slot) => {
      const id = slot.getAttribute('data-gold-history-image-id') || '';
      const url = imageUrls.get(id);
      if (!url) return;
      const img = slot.querySelector('img.recordPhoto');
      if (img) { img.src = url; img.classList.remove('hidden'); }
      slot.querySelector('.recordPhotoFallback')?.classList.add('hidden');
    });
  }

  function allTheftRows(state) {
    const { names, images } = maps(state);
    const seenTransfers = new Set();
    const rows = [];

    (Array.isArray(state?.goldLedger) ? state.goldLedger : []).forEach((entry) => {
      if (entry?.type !== 'matchup_theft') return;
      const amount = Number(entry.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const transferKey = String(entry.transferId || entry.id || `${entry.matchupId || ''}:${entry.playerId || ''}:${entry.dateKey || ''}:${amount}`);
      if (seenTransfers.has(transferKey)) return;
      seenTransfers.add(transferKey);

      const playerId = String(entry.playerId || '');
      const opponentId = String(entry.opponentId || '');
      rows.push({
        playerId,
        playerName: names.get(playerId) || 'Unknown Player',
        imageId: images.get(playerId) || '',
        opponentId,
        opponentName: names.get(opponentId) || 'Unknown Player',
        date: String(entry.dateKey || entry.createdAtISO || '').slice(0, 10),
        amount: roundGold(amount),
        transferId: transferKey
      });
    });

    rows.sort((a, b) => b.amount - a.amount || String(b.date).localeCompare(String(a.date)) || a.playerName.localeCompare(b.playerName));
    return rows;
  }

  function currentFilters() {
    return {
      include: $('goldRecordsIncludeSelect')?.value || 'all',
      topN: Number($('goldRecordsTopSelect')?.value || 50),
      search: String($('goldRecordsSearchInput')?.value || '').trim().toLowerCase()
    };
  }

  function render() {
    if (!$('goldRecordsTabPanel')) return false;
    const state = loadFullState();
    const name = youName(state);
    const all = allTheftRows(state);
    const filters = currentFilters();
    let shown = all.slice();
    if (filters.include === 'you') shown = shown.filter((row) => row.playerId === 'YOU');
    else if (filters.include === 'players') shown = shown.filter((row) => row.playerId !== 'YOU');
    if (filters.search) shown = shown.filter((row) => row.playerName.toLowerCase().includes(filters.search));
    shown = shown.slice(0, filters.topN);

    const summary = $('goldRecordsControlsSummary');
    if (summary) {
      const includeLabel = filters.include === 'you' ? `${name} only` : filters.include === 'players' ? 'Players only' : 'All';
      const searchLabel = filters.search ? `Search: ${$('goldRecordsSearchInput')?.value || ''}` : '';
      summary.textContent = [includeLabel, `Top ${filters.topN}`, searchLabel].filter(Boolean).join(' · ');
    }
    if ($('goldRecordsIncludeAllOption')) $('goldRecordsIncludeAllOption').textContent = `All (${name} + Players)`;
    if ($('goldRecordsIncludeYouOption')) $('goldRecordsIncludeYouOption').textContent = `${name} only`;
    if ($('goldRecordsMetaLine')) $('goldRecordsMetaLine').textContent = `Saved: ${all.length.toLocaleString()} Gold theft records`;

    const tbody = $('goldRecordsTbody');
    const empty = $('goldRecordsEmptyState');
    const wrap = $('goldRecordsTableWrap');
    const sub = $('goldRecordsSubtitleLine');

    if (!shown.length) {
      empty?.classList.remove('hidden');
      wrap?.classList.add('hidden');
      if (sub) sub.textContent = 'No matching records.';
      if (tbody) tbody.innerHTML = '';
      global.__lastTopGoldTheftRecords = [];
      return true;
    }

    empty?.classList.add('hidden');
    wrap?.classList.remove('hidden');
    const best = shown[0]?.amount || 0;
    const avg = shown.reduce((sum, row) => sum + row.amount, 0) / shown.length;
    if (sub) sub.textContent = `Showing ${shown.length} — Best: ${best.toFixed(1)} · Avg (shown): ${avg.toFixed(1)}`;

    if (tbody) {
      tbody.innerHTML = shown.map((row, index) => {
        const sourcePill = row.playerId === 'YOU'
          ? `<span class="pill pill-orange">${esc(name)}</span>`
          : '<span class="pill pill-blue">Player</span>';
        return `<tr><td class="rankCell num font-extrabold">${index + 1}</td><td class="scoreCell num font-extrabold">${row.amount.toFixed(1)}</td><td class="imageCell">${photoHtml(row)}</td><td class="playerCell"><div class="font-semibold">${esc(row.playerName)}</div></td><td class="dateCell num">${esc(formatDate(row.date))}</td><td class="srcCell">${sourcePill}</td></tr>`;
      }).join('');
    }
    global.__lastTopGoldTheftRecords = shown;
    hydrateImages(shown);
    return true;
  }

  function install() {
    if (!$('goldRecordsTab')) return false;
    const rerender = () => global.setTimeout(render, 0);
    $('goldRecordsTab')?.addEventListener('click', rerender);
    $('goldRecordsIncludeSelect')?.addEventListener('change', rerender);
    $('goldRecordsTopSelect')?.addEventListener('change', rerender);
    $('goldRecordsSearchInput')?.addEventListener('input', rerender);
    $('goldRecordsRefreshBtn')?.addEventListener('click', rerender);
    return true;
  }

  let attempts = 0;
  const timer = global.setInterval(() => {
    attempts += 1;
    if (install() || attempts > 80) global.clearInterval(timer);
  }, 50);
})(typeof window !== 'undefined' ? window : globalThis);
