(function (global) {
  'use strict';

  const core = global.TaskPointsCore || {};
  let enhancementScheduled = false;

  function readState() {
    if (typeof core.loadAppState !== 'function') return {};
    const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    return loaded?.state || loaded || {};
  }

  function enhance() {
    enhancementScheduled = false;
    const root = global.document?.getElementById('seasonView');
    if (!root) return;
    const state = readState();
    const season = state?.currentSeason;
    if (!season || season.status !== 'preview') return;

    const existing = root.querySelector('[data-season-action="create-official-bracket"], [data-season-action="open-bracket-builder"]');
    if (existing) {
      if (existing.dataset.seasonAction !== 'open-bracket-builder') existing.dataset.seasonAction = 'open-bracket-builder';
      const label = season.bracketConfig ? 'Continue Building Bracket' : 'Build Bracket';
      if (existing.textContent !== label) existing.textContent = label;
      const shouldDisable = !Array.isArray(season.seeds) || season.seeds.length < 2;
      if (existing.disabled !== shouldDisable) existing.disabled = shouldDisable;
    }

    const hero = root.querySelector('.season-hero-card');
    if (hero && !hero.querySelector('[data-bracket-builder-next-step]')) {
      const note = global.document.createElement('p');
      note.className = 'muted text-sm mt-3';
      note.setAttribute('data-bracket-builder-next-step', '');
      note.textContent = 'Next step: use Build Bracket to choose the field size, byes, round formats, and full tournament calendar before creating the official bracket.';
      hero.appendChild(note);
    }

    root.querySelectorAll('.season-manual-banner').forEach((banner) => {
      if (!/designed for 34 players/i.test(banner.textContent || '')) return;
      const message = 'This seed list is ready for the dynamic bracket builder. Choose the tournament field and format before official creation.';
      if (banner.textContent !== message) banner.textContent = message;
    });
  }

  function scheduleEnhance() {
    if (enhancementScheduled) return;
    enhancementScheduled = true;
    global.requestAnimationFrame ? global.requestAnimationFrame(enhance) : setTimeout(enhance, 0);
  }

  global.document?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-season-action="open-bracket-builder"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    global.location.href = 'season_bracket_builder.html';
  }, true);

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', scheduleEnhance, { once: true });
    else scheduleEnhance();
    const root = global.document.getElementById('seasonView');
    if (root && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(scheduleEnhance);
      observer.observe(root, { childList: true, subtree: true });
    }
  }
})(window);
