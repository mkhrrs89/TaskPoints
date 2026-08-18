;(function installHabitCompletionSourceGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__habitCompletionSourceGuardInstalled || typeof core.saveStateSnapshot !== 'function') return;
  core.__habitCompletionSourceGuardInstalled = true;
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const originalSave = core.saveStateSnapshot.bind(core);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  function readPreviousState() {
    if (typeof core.readTaskPointsStoredState === 'function') {
      const decoded = core.readTaskPointsStoredState(STORAGE_KEY, null);
      return decoded && typeof decoded === 'object' ? decoded : null;
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (typeof core.parseTaskPointsStorageJson === 'function') {
      const decoded = core.parseTaskPointsStorageJson(raw, {});
      return decoded && typeof decoded === 'object' ? decoded : null;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.__taskpointsStorageEncoding || parsed?.__taskpointsPacked) return null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  function completionHabitId(row) {
    return String(row?.habitId || row?.viceId || '').trim();
  }

  function validDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function completionDay(row) {
    for (const value of [row?.dayKey, row?.dateKey]) {
      if (validDayKey(value)) return value;
    }
    for (const value of [row?.completedAtISO, row?.createdAtISO]) {
      if (!populated(value)) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) continue;
      if (typeof core.dateKey === 'function') {
        try {
          const shared = core.dateKey(date);
          if (validDayKey(shared)) return shared;
        } catch (_) {}
      }
      const direct = date.toISOString().slice(0, 10);
      if (validDayKey(direct)) return direct;
    }
    return '';
  }

  core.saveStateSnapshot = function guardedHabitCompletionSave(nextState, options) {
    let adjusted = nextState;
    try {
      const previous = readPreviousState();
      const previousRows = Array.isArray(previous?.completions) ? previous.completions : null;
      const nextRows = Array.isArray(nextState?.completions) ? nextState.completions : null;
      if (!previousRows || !nextRows || nextRows.length !== previousRows.length + 1) {
        return originalSave(nextState, options);
      }

      const previousIds = new Set(
        previousRows.map((row) => String(row?.id || '').trim()).filter(Boolean)
      );
      const additions = nextRows.filter((row) => {
        const id = String(row?.id || '').trim();
        return id && !previousIds.has(id);
      });
      if (additions.length !== 1) return originalSave(nextState, options);

      const added = additions[0];
      if (added.source !== 'habit' && added.source !== 'vice') {
        return originalSave(nextState, options);
      }
      const habitId = completionHabitId(added);
      const habitIndex = (Array.isArray(nextState?.habits) ? nextState.habits : [])
        .findIndex((item) => item && String(item.id) === habitId);
      if (habitIndex < 0) return originalSave(nextState, options);
      const habit = nextState.habits[habitIndex];
      const expected = habit.category === 'vice' ? 'vice' : 'habit';
      const dayKey = completionDay(added);
      let changed = false;

      let completions = nextRows;
      if (added.source !== expected || (!populated(added.habitId) && populated(added.viceId))) {
        completions = nextRows.map((row) => {
          if (row !== added) return row;
          const next = { ...row, source: expected };
          if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
          return next;
        });
        changed = true;
      }

      let habits = nextState.habits;
      if (validDayKey(dayKey)) {
        const doneKeys = habit.doneKeys == null
          ? []
          : (Array.isArray(habit.doneKeys) ? habit.doneKeys : null);
        const failedKeys = habit.failedKeys == null
          ? []
          : (Array.isArray(habit.failedKeys) ? habit.failedKeys : null);

        if (doneKeys && failedKeys) {
          const hasDone = doneKeys.includes(dayKey);
          const hasFailed = failedKeys.includes(dayKey);
          if (!hasDone || hasFailed) {
            habits = nextState.habits.map((item, index) => {
              if (index !== habitIndex) return item;
              const nextHabit = { ...item };
              if (!hasDone) nextHabit.doneKeys = doneKeys.concat(dayKey);
              if (hasFailed) nextHabit.failedKeys = failedKeys.filter((key) => key !== dayKey);
              return nextHabit;
            });
            changed = true;
          }
        }
      }

      if (changed) adjusted = { ...nextState, completions, habits };
    } catch (error) {
      console.warn('Habit completion source/status guard skipped normalization', error);
    }
    return originalSave(adjusted, options);
  };
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadHabitLedgerScoreReconciliation(global) {
  'use strict';

  const SCRIPT_ID = 'tpHabitLedgerScoreReconciliationScript';
  const SCRIPT_SRC = '/habit_ledger_score_reconciliation.js?v=20260803-1';

  function load() {
    if (global.TaskPointsHabitLedgerScoreReconciliation?.installed) return true;
    const document = global.document;
    if (!document?.getElementById?.('auditChecks') || !document.createElement) return false;
    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-habit-score-reconciliation', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadHabitLedgerScoreReconciliationHardening(global) {
  'use strict';

  const SCRIPT_ID = 'tpHabitLedgerScoreReconciliationHardeningScript';
  const SCRIPT_SRC = '/habit_ledger_score_reconciliation_hardening.js?v=20260803-1';
  let attempts = 0;

  function load() {
    if (global.TaskPointsHabitLedgerScoreReconciliationCopyDomainHardening?.installed) return true;
    const document = global.document;
    if (!document?.getElementById?.('auditChecks') || !document.createElement) return false;
    if (!global.TaskPointsHabitLedgerScoreReconciliation?.installed) {
      if (++attempts < 240) global.setTimeout?.(load, 50);
      return false;
    }
    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-habit-score-reconciliation-hardening', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsWorkEntryFastPath(global) {
  'use strict';

  const SCRIPT_ID = 'tpWorkEntryFastPathScript';
  const SCRIPT_SRC = '/work_entry_fast_path.js?v=20260815-2';

  function isHomePage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/' || pathname === '' || pathname.endsWith('/index.html');
  }

  function load() {
    if (!isHomePage()) return false;
    if (global.TaskPointsWorkEntryFastPath?.installed) {
      global.TaskPointsWorkEntryFastPath.install?.();
      return true;
    }
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-work-entry-fast-path', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsStreaksNavLink(global) {
  'use strict';

  const SCRIPT_ID = 'tpStreaksNavLinkScript';
  const SCRIPT_SRC = '/streaks_nav_link.js?v=20260815-1';

  function load() {
    if (global.TaskPointsStreaksNavLink?.installed) {
      global.TaskPointsStreaksNavLink.install?.();
      return true;
    }
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-streaks-nav-link', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadVerifiedSecondaryLogQuietGuard(global) {
  'use strict';

  const SCRIPT_ID = 'tpVerifiedSecondaryLogQuietGuardScript';
  const SCRIPT_SRC = '/verified_secondary_log_quiet_guard.js?v=20260816-1';

  function isLogPage() {
    const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
    return pathname === '/log' || pathname.endsWith('/log.html');
  }

  function load() {
    if (!isLogPage()) return false;
    if (global.TaskPointsCore?.__verifiedSecondaryLogQuietGuardInstalled) return true;
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-verified-secondary-log-quiet-guard', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTournamentBracketVisualRefresh(global) {
  'use strict';

  const document = global.document;
  if (!document?.createElement) return;
  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  if (!(pathname === '/tournament' || pathname.endsWith('/tournament.html'))) return;
  if (document.getElementById('taskpointsTournamentBracketVisualRefresh')) return;

  const style = document.createElement('style');
  style.id = 'taskpointsTournamentBracketVisualRefresh';
  style.textContent = `
    body.tp-tournament-bracket-refresh section.glass:has(#tournamentBracket) {
      padding: 14px 12px 12px !important;
      overflow: visible !important;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025)),
        #11161c;
    }

    body.tp-tournament-bracket-refresh .tournament-bracket-scroll {
      position: relative;
      margin: 0 -3px;
      padding: 10px 3px 16px;
      overflow-x: auto;
      overflow-y: hidden;
      border-radius: 16px;
      border: 1px solid rgba(94, 234, 212, 0.12);
      background:
        linear-gradient(90deg, rgba(94,234,212,0.018) 1px, transparent 1px) 0 0 / 52px 100%,
        linear-gradient(180deg, rgba(255,255,255,0.018) 1px, transparent 1px) 0 0 / 100% 77px,
        linear-gradient(180deg, #0a1117 0%, #0b1016 100%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.035),
        inset 0 -1px 0 rgba(0,0,0,0.35);
      scroll-snap-type: x proximity;
      scrollbar-width: thin;
      scrollbar-color: rgba(94,234,212,0.38) rgba(15,23,42,0.45);
    }

    body.tp-tournament-bracket-refresh .tournament-bracket {
      --slot-height: 60px;
      --bracket-row-gap: 14px;
      --info-col-width: 56px;
      position: relative;
      padding: 70px 18px 28px !important;
    }

    body.tp-tournament-bracket-refresh .tournament-round {
      position: relative;
      min-width: 176px !important;
      padding-inline: 5px;
      scroll-snap-align: start;
    }

    body.tp-tournament-bracket-refresh .tournament-round::before {
      content: attr(aria-label);
      position: absolute;
      top: -56px;
      left: 5px;
      right: 5px;
      min-height: 42px;
      display: flex;
      align-items: center;
      padding: 8px 11px;
      border-radius: 12px;
      border: 1px solid rgba(94, 234, 212, 0.28);
      background:
        linear-gradient(180deg, rgba(26,56,59,0.96), rgba(10,47,47,0.92));
      color: #e6edf6;
      font-weight: 800;
      font-size: 0.92rem;
      line-height: 1.05;
      letter-spacing: 0.01em;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.08),
        0 8px 22px rgba(0,0,0,0.28);
      z-index: 5;
      pointer-events: none;
    }

    body.tp-tournament-bracket-refresh .tournament-round::after {
      content: '';
      position: absolute;
      top: -9px;
      left: 16px;
      right: 16px;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(94,234,212,0.3), transparent);
      pointer-events: none;
    }

    body.tp-tournament-bracket-refresh .tournament-info-col {
      width: var(--info-col-width) !important;
      position: relative;
    }

    body.tp-tournament-bracket-refresh .tournament-info-col::before {
      content: '';
      position: absolute;
      top: -18px;
      bottom: 8px;
      left: 50%;
      width: 1px;
      transform: translateX(-0.5px);
      background: linear-gradient(180deg, rgba(94,234,212,0.16), rgba(94,234,212,0.035) 22%, rgba(94,234,212,0.035) 78%, rgba(94,234,212,0.12));
      pointer-events: none;
    }

    body.tp-tournament-bracket-refresh .tournament-connector-layer {
      filter: drop-shadow(0 0 3px rgba(45, 212, 191, 0.13));
    }

    body.tp-tournament-bracket-refresh .tournament-connector-line {
      stroke: rgba(94, 234, 212, 0.72) !important;
      stroke-width: 2.15 !important;
      stroke-linecap: round !important;
      stroke-linejoin: round !important;
      vector-effect: non-scaling-stroke;
    }

    body.tp-tournament-bracket-refresh .tournament-slot,
    body.tp-tournament-bracket-refresh .tournament-slot-row {
      min-width: 0;
    }

    body.tp-tournament-bracket-refresh .tournament-slot {
      border-radius: 12px;
    }

    body.tp-tournament-bracket-refresh .tournament-slot::after {
      border-radius: 11px !important;
      border-color: rgba(71, 85, 105, 0.78) !important;
      background:
        linear-gradient(180deg, rgba(15,23,42,0.94), rgba(11,18,29,0.97)) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.045),
        0 5px 14px rgba(0,0,0,0.24) !important;
    }

    body.tp-tournament-bracket-refresh .tournament-slot[data-slot-kind="placeholder"]:not(.has-tourney-player-node)::after,
    body.tp-tournament-bracket-refresh .tournament-slot[data-advance-hidden-until-day-complete="true"]::after {
      border-style: dashed !important;
      border-color: rgba(100,116,139,0.46) !important;
      background:
        linear-gradient(180deg, rgba(15,23,42,0.5), rgba(11,18,29,0.45)) !important;
      opacity: 0.68;
    }

    body.tp-tournament-bracket-refresh .tourney-player-node {
      min-width: 0;
      border-radius: 11px;
      transition: transform 140ms ease, filter 140ms ease;
    }

    body.tp-tournament-bracket-refresh .tourney-player-image-slot {
      border-radius: 10px !important;
      border-color: rgba(71,85,105,0.9) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.075),
        0 5px 13px rgba(0,0,0,0.27) !important;
    }

    body.tp-tournament-bracket-refresh .tournament-slot.has-tourney-player-node .tourney-player-image-slot {
      border-color: rgba(94,234,212,0.34) !important;
    }

    body.tp-tournament-bracket-refresh .tournament-play-in-matchup .tourney-player-image-slot,
    body.tp-tournament-bracket-refresh .tournament-play-in-matchup .tournament-slot::after {
      border-color: rgba(251,146,60,0.58) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.08),
        0 0 0 1px rgba(251,146,60,0.09),
        0 6px 15px rgba(0,0,0,0.25) !important;
    }

    body.tp-tournament-bracket-refresh .tourney-player-meta {
      border-radius: 8px;
      background: rgba(8,15,23,0.72);
      box-shadow: inset 0 0 0 1px rgba(148,163,184,0.08);
    }

    body.tp-tournament-bracket-refresh .tournament-slot-champion {
      z-index: 4;
      transform: scale(1.04);
      transform-origin: left center;
    }

    body.tp-tournament-bracket-refresh .tournament-slot-champion::after,
    body.tp-tournament-bracket-refresh .tournament-slot-champion .tourney-player-image-slot {
      border-color: rgba(250,204,21,0.68) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.12),
        0 0 0 1px rgba(250,204,21,0.14),
        0 0 22px rgba(250,204,21,0.11),
        0 8px 18px rgba(0,0,0,0.32) !important;
    }

    body.tp-tournament-bracket-refresh .tournament-round-7::before {
      border-color: rgba(250,204,21,0.42);
      background: linear-gradient(180deg, rgba(91,70,22,0.94), rgba(45,39,17,0.95));
    }

    @media (max-width: 767px) {
      body.tp-tournament-bracket-refresh section.glass:has(#tournamentBracket) {
        padding-left: 10px !important;
        padding-right: 10px !important;
      }

      body.tp-tournament-bracket-refresh .tournament-bracket {
        --slot-height: 58px;
        --bracket-row-gap: 12px;
        --info-col-width: 48px;
        padding-left: 12px !important;
        padding-right: 12px !important;
      }

      body.tp-tournament-bracket-refresh .tournament-round {
        min-width: 164px !important;
        padding-inline: 3px;
      }

      body.tp-tournament-bracket-refresh .tournament-round::before {
        left: 3px;
        right: 3px;
        font-size: 0.86rem;
        padding-inline: 9px;
      }

      body.tp-tournament-bracket-refresh .tournament-connector-line {
        stroke-width: 2 !important;
      }
    }

    @media (prefers-color-scheme: light) {
      body.tp-tournament-bracket-refresh .tournament-bracket-scroll {
        background:
          linear-gradient(90deg, rgba(13,148,136,0.035) 1px, transparent 1px) 0 0 / 52px 100%,
          linear-gradient(180deg, rgba(15,23,42,0.035) 1px, transparent 1px) 0 0 / 100% 77px,
          #f8fafc;
        border-color: rgba(13,148,136,0.18);
      }

      body.tp-tournament-bracket-refresh .tournament-round::before {
        color: #0f172a;
        background: linear-gradient(180deg, #d9efee, #cbe5e4);
        border-color: rgba(13,148,136,0.28);
      }

      body.tp-tournament-bracket-refresh .tournament-connector-line {
        stroke: rgba(13,148,136,0.62) !important;
      }
    }
  `;

  (document.head || document.documentElement).appendChild(style);
  const installClass = () => document.body?.classList.add('tp-tournament-bracket-refresh');
  installClass();
  if (!document.body) global.addEventListener?.('DOMContentLoaded', installClass, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
