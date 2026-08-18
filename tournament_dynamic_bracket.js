(function installDynamicTournamentBracket(global) {
  'use strict';

  const FORMAT_ID = 'dynamic_current_season';
  const STYLE_ID = 'tp-classic-tournament-bracket-style';
  const imageUrls = new Map();
  const layoutMetrics = {
    roundWidth: 132,
    columnGap: 104,
    nodeHeight: 74,
    nodeGap: 14,
    seriesPitch: 236,
    stagePad: 84
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function selectorValue(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

  function getParticipant(state, series, side, players, seeds) {
    const suffix = side === 'B' ? 'B' : 'A';
    const id = String(series?.[`player${suffix}Id`] || '').trim();
    const seriesSeed = Number(series?.[`player${suffix}Seed`]);
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
    const seed = Number.isFinite(seriesSeed) && seriesSeed > 0
      ? seriesSeed
      : (Number(seedRow?.seed) || null);
    const wins = Number(series?.[`wins${suffix}`]) || 0;
    return { id, name, imageId, seed, wins, placeholder, isTbd: !id };
  }

  function participantById(state, playerId, players, seeds) {
    const id = String(playerId || '').trim();
    if (!id) return { id: '', name: 'Champion', imageId: '', seed: null, wins: 0, isTbd: true };
    const seedRow = seeds.get(id) || null;
    const player = players.get(id) || null;
    return {
      id,
      name: String(seedRow?.playerName || seedRow?.name || player?.name || (id === 'YOU' ? 'You' : id)),
      imageId: String(seedRow?.imageId || player?.imageId || (id === 'YOU' ? state?.youImageId : '') || ''),
      seed: Number(seedRow?.seed) || null,
      wins: 0,
      isTbd: false
    };
  }

  function participantHtml(participant, side, winnerId) {
    const isWinner = participant.id && participant.id === winnerId;
    const classes = ['tp-classic-participant'];
    if (isWinner) classes.push('is-winner');
    if (participant.isTbd) classes.push('is-tbd');
    const aria = participant.isTbd
      ? participant.name
      : `Seed ${participant.seed ?? 'unknown'}, ${participant.name}, ${participant.wins} series wins`;
    return `
      <div class="${classes.join(' ')}" data-slot="${side}" data-player-id="${escapeHtml(participant.id)}" aria-label="${escapeHtml(aria)}" title="${escapeHtml(participant.name)}">
        <div class="tp-classic-seedblock">
          <strong>${participant.seed ?? '—'}</strong>
          <span>${participant.wins}</span>
        </div>
        <div class="tp-classic-photo" data-image-id="${escapeHtml(participant.imageId)}">
          ${participant.imageId ? '<img alt="" loading="lazy" decoding="async">' : '<span class="tp-classic-placeholder">?</span>'}
        </div>
      </div>`;
  }

  function seriesHtml(state, series, players, seeds) {
    const winnerId = String(series?.winnerId || '').trim();
    const a = getParticipant(state, series, 'A', players, seeds);
    const b = getParticipant(state, series, 'B', players, seeds);
    return `
      <article class="tp-classic-series"
        data-series-id="${escapeHtml(series?.id)}"
        data-next-series-id="${escapeHtml(series?.nextSeriesId || '')}"
        data-next-slot="${escapeHtml(series?.nextSlot || '')}">
        ${participantHtml(a, 'A', winnerId)}
        ${participantHtml(b, 'B', winnerId)}
      </article>`;
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] {
        --tp-classic-round-width: ${layoutMetrics.roundWidth}px;
        --tp-classic-column-gap: ${layoutMetrics.columnGap}px;
        --tp-classic-node-height: ${layoutMetrics.nodeHeight}px;
        position: relative !important;
        display: flex !important;
        align-items: flex-start !important;
        gap: var(--tp-classic-column-gap) !important;
        width: max-content !important;
        min-width: 100% !important;
        min-height: 0 !important;
        padding: .35rem .5rem 1.5rem !important;
        grid-template-columns: none !important;
        grid-template-rows: none !important;
        background:
          linear-gradient(rgba(30, 64, 72, .12) 1px, transparent 1px),
          linear-gradient(90deg, rgba(30, 64, 72, .12) 1px, transparent 1px),
          rgba(3, 13, 19, .82) !important;
        background-size: 112px 112px !important;
        border: 1px solid rgba(45, 212, 191, .16);
        border-radius: 1rem;
        overflow: visible;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-round {
        position: relative;
        z-index: 2;
        flex: 0 0 var(--tp-classic-round-width);
        width: var(--tp-classic-round-width);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-round-head {
        position: relative;
        z-index: 4;
        height: 3.15rem;
        display: flex;
        align-items: center;
        padding: 0 .65rem;
        border: 1px solid rgba(45, 212, 191, .42);
        border-radius: .8rem;
        background: linear-gradient(180deg, rgba(19, 76, 76, .95), rgba(7, 31, 36, .97));
        box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 8px 20px rgba(0,0,0,.2);
        color: #f8fafc;
        font-size: .92rem;
        font-weight: 850;
        white-space: nowrap;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-round-stage {
        position: relative;
        width: 100%;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-series {
        position: absolute;
        left: 0;
        width: 100%;
        transform: translateY(-50%);
        display: grid;
        gap: ${layoutMetrics.nodeGap}px;
        padding: 0;
        margin: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-participant {
        position: relative;
        display: grid;
        grid-template-columns: 2.35rem 4rem;
        gap: .35rem;
        align-items: center;
        width: 6.7rem;
        min-height: var(--tp-classic-node-height);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-seedblock {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        line-height: 1;
        text-shadow: 0 2px 8px rgba(0,0,0,.45);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-seedblock strong {
        color: #f8fafc;
        font-size: 1.35rem;
        font-weight: 900;
        letter-spacing: -.04em;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-seedblock span {
        color: #fdba74;
        font-size: .72rem;
        font-weight: 900;
        margin-top: .18rem;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-photo {
        position: relative;
        width: 4rem;
        height: var(--tp-classic-node-height);
        overflow: hidden;
        border-radius: .8rem;
        border: 1px solid rgba(94, 234, 212, .34);
        background: linear-gradient(180deg, rgba(30,41,59,.96), rgba(15,23,42,.98));
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.07),
          0 0 0 1px rgba(45,212,191,.08),
          0 7px 18px rgba(0,0,0,.28);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-photo img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: rgba(148,163,184,.55);
        font-size: 1rem;
        font-weight: 800;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-participant.is-winner .tp-classic-photo {
        border-color: rgba(251, 146, 60, .88);
        box-shadow:
          inset 0 0 0 2px rgba(251, 146, 60, .22),
          0 0 0 1px rgba(251,146,60,.22),
          0 8px 20px rgba(0,0,0,.3);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-participant.is-tbd {
        opacity: .48;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-champion .tp-classic-photo {
        border-color: rgba(251, 191, 36, .72);
        box-shadow: 0 0 0 1px rgba(251,191,36,.16), 0 0 24px rgba(251,146,60,.12);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-connector-layer {
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: visible;
        pointer-events: none;
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-connector {
        fill: none;
        stroke: rgba(94, 234, 212, .78);
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
        filter: drop-shadow(0 0 2px rgba(45,212,191,.18));
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-connector.is-complete {
        stroke: rgba(251, 146, 60, .86);
      }

      #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-empty {
        color: #94a3b8;
        width: min(36rem, 90vw);
        padding: 2rem;
        text-align: center;
      }

      @media (max-width: 767px) {
        .tournament-bracket-scroll { padding-bottom: .6rem; }
        #tournamentBracket[data-bracket-format="${FORMAT_ID}"] {
          --tp-classic-column-gap: 90px;
          --tp-classic-round-width: 126px;
          padding-left: .4rem !important;
          padding-right: .4rem !important;
        }
        #tournamentBracket[data-bracket-format="${FORMAT_ID}"] .tp-classic-round-head {
          font-size: .86rem;
          height: 2.95rem;
        }
      }
    `;
    document.head.appendChild(style);
  }

  async function hydrateImages(root) {
    const core = global.TaskPointsCore;
    if (!core?.getImageBlob) return;
    const nodes = Array.from(root.querySelectorAll('.tp-classic-photo[data-image-id]'));
    const tasks = nodes.map(async (node) => {
      const imageId = node.getAttribute('data-image-id');
      const img = node.querySelector('img');
      if (!imageId || !img) return;
      try {
        let url = imageUrls.get(imageId);
        if (!url) {
          const blob = await core.getImageBlob(imageId);
          if (!blob) return;
          url = URL.createObjectURL(blob);
          imageUrls.set(imageId, url);
        }
        if (node.getAttribute('data-image-id') === imageId) img.src = url;
      } catch (_) {}
    });
    await Promise.allSettled(tasks);
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

  function slotOffset(slot) {
    const distance = (layoutMetrics.nodeHeight + layoutMetrics.nodeGap) / 2;
    return String(slot || '').toUpperCase() === 'B' ? distance : -distance;
  }

  function computePositions(rounds) {
    const positions = new Map();
    if (!rounds.length) return positions;

    let maxCount = 0;
    let anchorIndex = 0;
    rounds.forEach((round, index) => {
      const count = round.series.length;
      if (count >= maxCount) {
        maxCount = count;
        anchorIndex = index;
      }
    });

    const anchor = rounds[anchorIndex];
    anchor.series.forEach((series, index) => {
      positions.set(String(series.id), layoutMetrics.stagePad + index * layoutMetrics.seriesPitch);
    });

    const seriesById = new Map();
    rounds.forEach((round) => round.series.forEach((series) => seriesById.set(String(series.id), series)));

    for (let roundIndex = anchorIndex - 1; roundIndex >= 0; roundIndex -= 1) {
      rounds[roundIndex].series.forEach((series, index) => {
        const targetId = String(series?.nextSeriesId || '');
        const targetY = positions.get(targetId);
        if (Number.isFinite(targetY)) {
          positions.set(String(series.id), targetY + slotOffset(series?.nextSlot));
        } else {
          positions.set(String(series.id), layoutMetrics.stagePad + index * layoutMetrics.seriesPitch);
        }
      });
    }

    for (let roundIndex = anchorIndex + 1; roundIndex < rounds.length; roundIndex += 1) {
      rounds[roundIndex].series.forEach((series, index) => {
        const id = String(series.id);
        const incoming = [];
        rounds.slice(0, roundIndex).forEach((previousRound) => {
          previousRound.series.forEach((previous) => {
            if (String(previous?.nextSeriesId || '') !== id) return;
            const sourceY = positions.get(String(previous.id));
            if (!Number.isFinite(sourceY)) return;
            incoming.push(sourceY - slotOffset(previous?.nextSlot));
          });
        });

        if (incoming.length) {
          positions.set(id, incoming.reduce((sum, value) => sum + value, 0) / incoming.length);
        } else {
          const stride = Math.pow(2, Math.max(0, roundIndex - anchorIndex));
          positions.set(id, layoutMetrics.stagePad + ((index + .5) * stride - .5) * layoutMetrics.seriesPitch);
        }
      });
    }

    const min = Math.min(...Array.from(positions.values()));
    if (Number.isFinite(min) && min < layoutMetrics.stagePad) {
      const shift = layoutMetrics.stagePad - min;
      positions.forEach((value, key) => positions.set(key, value + shift));
    }

    return positions;
  }

  function championHtml(state, finals, players, seeds) {
    const winnerId = String(finals?.winnerId || '').trim();
    const champion = participantById(state, winnerId, players, seeds);
    return `
      <section class="tp-classic-round tp-classic-champion-round" data-round-id="champion">
        <header class="tp-classic-round-head">Champion</header>
        <div class="tp-classic-round-stage">
          <article class="tp-classic-series tp-classic-champion" data-series-id="__champion__">
            ${participantHtml(champion, 'winner', winnerId)}
          </article>
        </div>
      </section>`;
  }

  function renderMarkup(state, season, rounds, players, seeds) {
    const columns = rounds.map((round) => `
      <section class="tp-classic-round" data-round-id="${escapeHtml(round.id)}">
        <header class="tp-classic-round-head">${escapeHtml(round.displayName)}</header>
        <div class="tp-classic-round-stage">
          ${round.series.map((series) => seriesHtml(state, series, players, seeds)).join('')}
        </div>
      </section>`).join('');

    const finals = rounds[rounds.length - 1]?.series?.[0] || null;
    return `<svg class="tp-classic-connector-layer" aria-hidden="true"></svg>${columns}${championHtml(state, finals, players, seeds)}`;
  }

  function applyPositions(bracket, rounds, positions) {
    let maxY = layoutMetrics.stagePad;
    rounds.forEach((round) => {
      round.series.forEach((series) => {
        const y = positions.get(String(series.id));
        if (!Number.isFinite(y)) return;
        maxY = Math.max(maxY, y);
        const node = bracket.querySelector(`.tp-classic-series[data-series-id="${selectorValue(String(series.id))}"]`);
        if (node) node.style.top = `${y}px`;
      });
    });

    const finals = rounds[rounds.length - 1]?.series?.[0] || null;
    const finalY = finals ? positions.get(String(finals.id)) : layoutMetrics.stagePad;
    const champion = bracket.querySelector('.tp-classic-champion');
    if (champion) champion.style.top = `${Number.isFinite(finalY) ? finalY : layoutMetrics.stagePad}px`;

    const stageHeight = Math.ceil(maxY + layoutMetrics.stagePad + layoutMetrics.nodeHeight + layoutMetrics.nodeGap);
    bracket.querySelectorAll('.tp-classic-round-stage').forEach((stage) => {
      stage.style.height = `${stageHeight}px`;
    });
  }

  function svgPath(layer, d, complete = false) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', `tp-classic-connector${complete ? ' is-complete' : ''}`);
    path.setAttribute('d', d);
    layer.appendChild(path);
  }

  function point(rect, bracketRect, side, yMode = 'center') {
    const x = (side === 'left' ? rect.left : rect.right) - bracketRect.left;
    const y = (yMode === 'center' ? rect.top + rect.height / 2 : rect.top) - bracketRect.top;
    return { x, y };
  }

  function drawConnectors(bracket, rounds) {
    const layer = bracket.querySelector('.tp-classic-connector-layer');
    if (!layer) return;
    layer.replaceChildren();

    const bracketRect = bracket.getBoundingClientRect();
    const width = Math.max(bracket.scrollWidth, bracketRect.width);
    const height = Math.max(bracket.scrollHeight, bracketRect.height);
    layer.setAttribute('width', String(width));
    layer.setAttribute('height', String(height));
    layer.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const allSeries = rounds.flatMap((round) => round.series);
    const byId = new Map(allSeries.map((series) => [String(series.id), series]));

    allSeries.forEach((series) => {
      const source = bracket.querySelector(`.tp-classic-series[data-series-id="${selectorValue(String(series.id))}"]`);
      if (!source) return;
      const a = source.querySelector('.tp-classic-participant[data-slot="A"] .tp-classic-photo');
      const b = source.querySelector('.tp-classic-participant[data-slot="B"] .tp-classic-photo');
      if (!a || !b) return;

      const aPoint = point(a.getBoundingClientRect(), bracketRect, 'right');
      const bPoint = point(b.getBoundingClientRect(), bracketRect, 'right');
      const joinX = Math.max(aPoint.x, bPoint.x) + 26;
      const midY = (aPoint.y + bPoint.y) / 2;
      const winnerId = String(series?.winnerId || '').trim();

      svgPath(layer, `M ${aPoint.x} ${aPoint.y} H ${joinX} M ${bPoint.x} ${bPoint.y} H ${joinX} M ${joinX} ${aPoint.y} V ${bPoint.y}`, Boolean(winnerId));

      const nextId = String(series?.nextSeriesId || '').trim();
      if (nextId && byId.has(nextId)) {
        const target = bracket.querySelector(`.tp-classic-series[data-series-id="${selectorValue(nextId)}"]`);
        const targetSlot = String(series?.nextSlot || '').toUpperCase() === 'B' ? 'B' : 'A';
        const targetPhoto = target?.querySelector(`.tp-classic-participant[data-slot="${targetSlot}"] .tp-classic-photo`);
        if (!targetPhoto) return;
        const targetPoint = point(targetPhoto.getBoundingClientRect(), bracketRect, 'left');
        const bendX = joinX + Math.max(24, (targetPoint.x - joinX) * .52);
        svgPath(layer, `M ${joinX} ${midY} H ${bendX} V ${targetPoint.y} H ${targetPoint.x}`, Boolean(winnerId));
        return;
      }

      const isFinal = series === rounds[rounds.length - 1]?.series?.[0];
      if (isFinal) {
        const championPhoto = bracket.querySelector('.tp-classic-champion .tp-classic-photo');
        if (!championPhoto) return;
        const targetPoint = point(championPhoto.getBoundingClientRect(), bracketRect, 'left');
        const bendX = joinX + Math.max(24, (targetPoint.x - joinX) * .52);
        svgPath(layer, `M ${joinX} ${midY} H ${bendX} V ${targetPoint.y} H ${targetPoint.x}`, Boolean(winnerId));
      }
    });
  }

  function scheduleConnectorDraw(bracket, rounds) {
    global.requestAnimationFrame?.(() => {
      drawConnectors(bracket, rounds);
      global.setTimeout?.(() => drawConnectors(bracket, rounds), 120);
    });
  }

  function render() {
    const bracket = document.getElementById('tournamentBracket');
    if (!bracket) return { ok: false, reason: 'mount_missing' };

    const state = loadState();
    const season = state?.currentSeason;
    const rounds = orderedRounds(season);
    installStyles();

    bracket.setAttribute('data-bracket-format', FORMAT_ID);
    bracket.setAttribute('data-tournament-bracket-rendered', 'dynamic-classic');

    if (!season || !rounds.length) {
      bracket.innerHTML = '<div class="tp-classic-empty">No current Season tournament bracket is available.</div>';
      return { ok: false, reason: 'season_missing' };
    }

    const players = playerMap(state);
    const seeds = seedMap(season);
    const positions = computePositions(rounds);
    bracket.innerHTML = renderMarkup(state, season, rounds, players, seeds);
    applyPositions(bracket, rounds, positions);
    hydrateImages(bracket).finally(() => scheduleConnectorDraw(bracket, rounds));
    scheduleConnectorDraw(bracket, rounds);

    return {
      ok: true,
      entrantCount: Number(season?.bracketConfig?.entrantCount || season?.seeds?.length) || 0,
      roundCount: rounds.length,
      seriesCount: rounds.reduce((sum, round) => sum + round.series.length, 0)
    };
  }

  global.TaskPointsDynamicTournamentBracket = { render, orderedRounds };

  const run = () => {
    global.setTimeout?.(render, 0);
    global.setTimeout?.(render, 250);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();

  global.addEventListener?.('pageshow', render);
  global.addEventListener?.('resize', () => {
    const bracket = document.getElementById('tournamentBracket');
    if (!bracket || bracket.getAttribute('data-bracket-format') !== FORMAT_ID) return;
    const state = loadState();
    const rounds = orderedRounds(state?.currentSeason);
    scheduleConnectorDraw(bracket, rounds);
  });
})(typeof window !== 'undefined' ? window : globalThis);
