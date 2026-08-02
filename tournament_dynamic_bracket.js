(function installDynamicTournamentBracket(global) {
  'use strict';

  const FORMAT_ID = 'dynamic_current_season';
  const STYLE_ID = 'tp-dynamic-tournament-bracket-style';
  const imageUrls = new Map();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function seriesEntries(season) {
    const value = season?.series;
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === 'object') return Object.values(value).filter(Boolean);
    return [];
  }

  function orderedRounds(season) {
    const byId = new Map();
    const configured = Array.isArray(season?.bracket?.rounds) ? season.bracket.rounds : [];
    configured.forEach((round, index) => {
      const id = String(round?.id || '').trim();
      if (id) byId.set(id, { ...round, roundIndex: Number(round.roundIndex ?? index) });
    });

    const windows = Array.isArray(season?.dateWindows) ? season.dateWindows : [];
    windows.forEach((round, index) => {
      const id = String(round?.id || '').trim();
      if (!id) return;
      const previous = byId.get(id) || {};
      byId.set(id, {
        ...round,
        ...previous,
        id,
        displayName: previous.displayName || round.displayName || round.name || id,
        bestOf: Number(previous.bestOf || round.bestOf) || 1,
        roundIndex: Number(previous.roundIndex ?? index)
      });
    });

    const order = Array.isArray(season?.bracket?.roundOrder) && season.bracket.roundOrder.length
      ? season.bracket.roundOrder
      : Array.from(byId.values()).sort((a, b) => a.roundIndex - b.roundIndex).map((round) => round.id);

    return order.map((id, index) => {
      const configuredRound = byId.get(id) || {};
      const roundSeries = seriesEntries(season)
        .filter((series) => String(series?.roundId || '') === String(id))
        .sort((a, b) => Number(a?.seriesIndex || 0) - Number(b?.seriesIndex || 0));
      return {
        id,
        displayName: configuredRound.displayName || configuredRound.name || roundSeries[0]?.roundName || id.replace(/_/g, ' '),
        bestOf: Number(configuredRound.bestOf || roundSeries[0]?.bestOf) || 1,
        series: roundSeries,
        roundIndex: index
      };
    }).filter((round) => round.series.length);
  }

  function playerMap(state) {
    const map = new Map();
    (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
      if (player?.id) map.set(String(player.id), player);
    });
    return map;
  }

  function seedMap(season) {
    const map = new Map();
    (Array.isArray(season?.seeds) ? season.seeds : []).forEach((seed) => {
      const id = String(seed?.playerId || seed?.id || '');
      if (id) map.set(id, seed);
    });
    return map;
  }

  function getParticipant(state, season, series, side, players, seeds) {
    const suffix = side === 'B' ? 'B' : 'A';
    const id = String(series?.[`player${suffix}Id`] || '').trim();
    const seedValue = Number(series?.[`player${suffix}Seed`]);
    const seedRow = id ? seeds.get(id) : null;
    const player = id ? players.get(id) : null;
    const placeholder = String(series?.[`placeholder${suffix}`] || '').trim();
    const name = String(
      series?.[`player${suffix}Name`]
      || seedRow?.playerName
      || seedRow?.name
      || player?.name
      || (id === 'YOU' ? 'You' : '')
      || placeholder
      || 'TBD'
    );
    const imageId = String(
      series?.[`player${suffix}ImageId`]
      || seedRow?.imageId
      || player?.imageId
      || (id === 'YOU' ? state?.youImageId : '')
      || ''
    );
    const seed = Number.isFinite(seedValue) && seedValue > 0
      ? seedValue
      : Number(seedRow?.seed) || null;
    const wins = Number(series?.[`wins${suffix}`]) || 0;
    return { id, name, imageId, seed, wins, placeholder, isTbd: !id };
  }

  function participantHtml(participant, winnerId) {
    const winner = participant.id && participant.id === winnerId;
    const classes = ['tp-dyn-participant'];
    if (winner) classes.push('is-winner');
    if (participant.isTbd) classes.push('is-tbd');
    return `
      <div class="${classes.join(' ')}" data-player-id="${escapeHtml(participant.id)}">
        <div class="tp-dyn-seedblock">
          <strong>${participant.seed ?? '—'}</strong>
          <span>${participant.wins}</span>
        </div>
        <div class="tp-dyn-photo" data-image-id="${escapeHtml(participant.imageId)}">
          ${participant.imageId ? '<img alt="" loading="lazy" decoding="async">' : '<span>?</span>'}
        </div>
        <div class="tp-dyn-name">${escapeHtml(participant.name)}</div>
      </div>`;
  }

  function seriesHtml(state, season, series, players, seeds) {
    const a = getParticipant(state, season, series, 'A', players, seeds);
    const b = getParticipant(state, season, series, 'B', players, seeds);
    const winnerId = String(series?.winnerId || '').trim();
    const status = winnerId
      ? 'Complete'
      : (a.id && b.id ? `Series ${a.wins}–${b.wins}` : 'Awaiting opponent');
    return `
      <article class="tp-dyn-series" data-series-id="${escapeHtml(series?.id)}">
        <div class="tp-dyn-series-label">#${escapeHtml(series?.seriesIndex || '')} · Best of ${escapeHtml(series?.bestOf || 1)}</div>
        ${participantHtml(a, winnerId)}
        ${participantHtml(b, winnerId)}
        <div class="tp-dyn-series-status">${escapeHtml(status)}</div>
      </article>`;
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] {
        display: flex !important;
        align-items: flex-start;
        gap: 1rem;
        width: max-content;
        min-width: 100%;
        padding: .25rem .25rem 1.25rem;
        grid-template-columns: none !important;
        grid-template-rows: none !important;
        min-height: 0 !important;
      }
      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-dyn-round {
        width: 15rem;
        flex: 0 0 15rem;
        display: flex;
        flex-direction: column;
        gap: .75rem;
      }
      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-dyn-round-head {
        position: sticky;
        top: 0;
        z-index: 3;
        padding: .65rem .75rem;
        border: 1px solid rgba(45,212,191,.35);
        border-radius: .9rem;
        background: rgba(10,23,30,.96);
        box-shadow: 0 8px 18px rgba(0,0,0,.22);
      }
      .tp-dyn-round-title { color: #f8fafc; font-size: .98rem; font-weight: 800; }
      .tp-dyn-round-meta { color: #7dd3c7; font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin-top: .15rem; }
      .tp-dyn-round-series { display: flex; flex-direction: column; gap: .7rem; }
      .tp-dyn-series {
        border: 1px solid rgba(71,85,105,.55);
        border-radius: 1rem;
        background: rgba(10,18,30,.82);
        padding: .55rem;
        box-shadow: 0 7px 16px rgba(0,0,0,.18);
      }
      .tp-dyn-series-label { color: #94a3b8; font-size: .66rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin: 0 .15rem .4rem; }
      .tp-dyn-participant {
        display: grid;
        grid-template-columns: 2rem 2.45rem minmax(0,1fr);
        gap: .45rem;
        align-items: center;
        min-height: 2.8rem;
        padding: .3rem .4rem;
        border: 1px solid rgba(51,65,85,.8);
        background: rgba(15,23,42,.9);
      }
      .tp-dyn-participant:first-of-type { border-radius: .7rem .7rem .2rem .2rem; }
      .tp-dyn-participant:nth-of-type(3) { border-radius: .2rem .2rem .7rem .7rem; margin-top: .2rem; }
      .tp-dyn-participant.is-winner { border-color: rgba(251,146,60,.72); box-shadow: inset 3px 0 0 #fb923c; }
      .tp-dyn-participant.is-tbd { opacity: .62; }
      .tp-dyn-seedblock { display:flex; flex-direction:column; align-items:center; line-height:1; }
      .tp-dyn-seedblock strong { color:#f8fafc; font-size:.92rem; }
      .tp-dyn-seedblock span { color:#fdba74; font-size:.68rem; font-weight:800; margin-top:.18rem; }
      .tp-dyn-photo { width:2.45rem; height:2.45rem; overflow:hidden; border-radius:.45rem; border:1px solid rgba(71,85,105,.8); display:grid; place-items:center; color:#64748b; background:#111827; }
      .tp-dyn-photo img { width:100%; height:100%; object-fit:cover; display:block; }
      .tp-dyn-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e2e8f0; font-size:.84rem; font-weight:750; }
      .tp-dyn-series-status { color:#94a3b8; font-size:.68rem; text-align:center; margin-top:.4rem; }
      .tp-dyn-empty { color:#94a3b8; padding:2rem; text-align:center; width:min(36rem,90vw); }
      @media (max-width: 767px) {
        .tournament-bracket-scroll { padding-bottom: .5rem; }
        #tournamentBracket[data-bracket-format="${FORMAT_ID}"] { gap:.7rem; }
        #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-dyn-round { width:13.5rem; flex-basis:13.5rem; }
      }
    `;
    document.head.appendChild(style);
  }

  async function hydrateImages(root) {
    const core = global.TaskPointsCore;
    if (!core?.getImageBlob) return;
    const nodes = Array.from(root.querySelectorAll('.tp-dyn-photo[data-image-id]'));
    for (const node of nodes) {
      const imageId = node.getAttribute('data-image-id');
      const img = node.querySelector('img');
      if (!imageId || !img) continue;
      try {
        let url = imageUrls.get(imageId);
        if (!url) {
          const blob = await core.getImageBlob(imageId);
          if (!blob) continue;
          url = URL.createObjectURL(blob);
          imageUrls.set(imageId, url);
        }
        if (node.getAttribute('data-image-id') === imageId) img.src = url;
      } catch (_) {}
    }
  }

  function loadState() {
    const core = global.TaskPointsCore;
    if (!core?.loadAppState) return {};
    try {
      return core.loadAppState({ syncDerived: false, persistSync: false })?.state || {};
    } catch (_) {
      return {};
    }
  }

  function render() {
    const bracket = document.getElementById('tournamentBracket');
    if (!bracket) return { ok: false, reason: 'mount_missing' };
    const state = loadState();
    const season = state?.currentSeason;
    const rounds = orderedRounds(season);
    installStyles();
    bracket.setAttribute('data-bracket-format', FORMAT_ID);
    bracket.setAttribute('data-tournament-bracket-rendered', 'dynamic');

    if (!season || !rounds.length) {
      bracket.innerHTML = '<div class="tp-dyn-empty">No current Season tournament bracket is available.</div>';
      return { ok: false, reason: 'season_missing' };
    }

    const players = playerMap(state);
    const seeds = seedMap(season);
    bracket.innerHTML = rounds.map((round) => `
      <section class="tp-dyn-round" data-round-id="${escapeHtml(round.id)}">
        <header class="tp-dyn-round-head">
          <div class="tp-dyn-round-title">${escapeHtml(round.displayName)}</div>
          <div class="tp-dyn-round-meta">${round.series.length} series · Best of ${round.bestOf}</div>
        </header>
        <div class="tp-dyn-round-series">
          ${round.series.map((series) => seriesHtml(state, season, series, players, seeds)).join('')}
        </div>
      </section>`).join('');

    hydrateImages(bracket);
    return {
      ok: true,
      entrantCount: Number(season?.bracketConfig?.entrantCount || season?.seeds?.length) || 0,
      roundCount: rounds.length,
      seriesCount: rounds.reduce((sum, round) => sum + round.series.length, 0)
    };
  }

  global.TaskPointsDynamicTournamentBracket = { render, orderedRounds };

  const run = () => {
    window.setTimeout(render, 0);
    window.setTimeout(render, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
  global.addEventListener?.('pageshow', render);
})(typeof window !== 'undefined' ? window : globalThis);
