(function installTaskPointsIndexedDbRequalificationGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__indexedDbRequalificationGuardInstalled || typeof core.setPhase4StorageMode !== 'function') return;
  core.__indexedDbRequalificationGuardInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const DIAG_KEY = 'taskpoints_indexeddb_requalification_diagnostics_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HABIT_JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const originalSetMode = core.setPhase4StorageMode.bind(core);

  const get = (key) => { try { return storage.getItem(key); } catch (_) { return null; } };
  const parse = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const rawHash = (raw) => {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  };
  const journalCount = () => {
    const raw = get(HABIT_JOURNAL_KEY);
    if (!raw) return 0;
    const value = parse(raw, null);
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value?.operations)) return value.operations.length;
    return value && typeof value === 'object' ? Object.keys(value).length : 1;
  };
  const writeDiagnostic = (patch) => {
    const previous = parse(get(DIAG_KEY), {}) || {};
    try {
      storage.setItem(DIAG_KEY, JSON.stringify({ schemaVersion: 1, ...previous, ...patch }));
    } catch (_) {}
  };

  function permission(mode) {
    const requested = String(mode || 'off');
    if (requested === 'off') return { allowed: true, reason: '' };
    if (get(HOLD_KEY)) return { allowed: false, reason: 'recovery_hold_active' };
    if (get(ATTEMPT_LOCK_KEY)) return { allowed: false, reason: 'recovery_attempt_active' };
    if (get(LEGACY_JOURNAL_KEY)) return { allowed: false, reason: 'older_recovery_changes_waiting' };
    const raw = get(STORAGE_KEY);
    if (!raw) return { allowed: false, reason: 'current_save_missing' };
    const gate = parse(get(GATE_KEY), {}) || {};
    const status = String(gate.status || '');
    const currentHash = rawHash(raw);
    const configuredMode = get(MODE_KEY) || 'off';
    const keepingCompletedFastMode = requested === 'indexeddb_primary'
      && status === 'fast_mode_enabled'
      && configuredMode === 'indexeddb_primary';
    const keepingActiveShortTest = requested === 'verify_primary_writes'
      && configuredMode === 'verify_primary_writes'
      && ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(status);

    // Pending habit changes already force the read path to use the authoritative
    // working copy. They should not permanently erase either a completed Faster
    // Mode choice or an already-authorized short test while that brief fallback
    // is active.
    if (journalCount() > 0 && !keepingCompletedFastMode && !keepingActiveShortTest) {
      return { allowed: false, reason: 'habit_changes_waiting_to_save' };
    }

    if (requested === 'verify_primary_writes') {
      const allowedStatuses = new Set(['authorizing_test_mode', 'awaiting_smoke_test', 'ready_for_fast_mode', 'fast_mode_enabled']);
      if (!allowedStatuses.has(status)) return { allowed: false, reason: 'safety_check_not_started' };
      if (status === 'authorizing_test_mode' && gate.authorizedRawHash !== currentHash) {
        return { allowed: false, reason: 'current_save_changed_before_test' };
      }
      return { allowed: true, reason: '', gate, currentHash };
    }

    if (requested === 'indexeddb_primary') {
      if (status === 'fast_mode_enabled') {
        if (configuredMode === 'indexeddb_primary') return { allowed: true, reason: '', gate, currentHash };
        return { allowed: false, reason: 'fresh_reauthorization_required' };
      }
      if (status !== 'ready_for_fast_mode') return { allowed: false, reason: 'short_test_not_finished' };
      if (configuredMode !== 'verify_primary_writes') return { allowed: false, reason: 'storage_mode_changed_before_enable' };
      if (gate.lastVerifiedRawHash !== currentHash) return { allowed: false, reason: 'current_save_changed_after_final_check' };
      return { allowed: true, reason: '', gate, currentHash };
    }

    return { allowed: false, reason: 'unknown_storage_mode' };
  }

  core.getIndexedDbRequalificationPermission = permission;
  core.getIndexedDbRequalificationStatus = () => ({
    gate: parse(get(GATE_KEY), {}) || {},
    configuredMode: get(MODE_KEY) || 'off',
    recoveryHoldActive: Boolean(get(HOLD_KEY)),
    recoveryAttemptActive: Boolean(get(ATTEMPT_LOCK_KEY)),
    pendingHabitChanges: journalCount(),
    legacyChangesPresent: Boolean(get(LEGACY_JOURNAL_KEY))
  });

  core.setPhase4StorageMode = function guardedPhase4StorageMode(mode) {
    const requested = String(mode || 'off');
    const decision = permission(requested);
    if (!decision.allowed) {
      const result = originalSetMode('off');
      writeDiagnostic({
        lastBlockedAtISO: new Date().toISOString(),
        requestedMode: requested,
        blockedReason: decision.reason,
        resultingMode: result
      });
      return result;
    }
    const result = originalSetMode(requested);
    writeDiagnostic({
      lastAllowedAtISO: new Date().toISOString(),
      requestedMode: requested,
      blockedReason: null,
      resultingMode: result
    });
    return result;
  };

  const currentMode = core.getPhase4StorageMode?.() || get(MODE_KEY) || 'off';
  if (currentMode !== 'off' && !permission(currentMode).allowed) originalSetMode('off');
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsSeasonChampionGoldBonus(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__seasonChampionGoldBonusInstalled) return;
  core.__seasonChampionGoldBonusInstalled = true;

  const BONUS_GOLD = 25;
  const GOLD_START_DATE = '2026-07-01';
  const MAX_INSTALL_ATTEMPTS = 120;
  let installAttempts = 0;

  function roundGold(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function loadState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      if (loaded?.state) return loaded.state;
      if (loaded && typeof loaded === 'object') return loaded;
    } catch (_) {}

    try {
      const raw = global.localStorage?.getItem?.(core.STORAGE_KEY || 'taskpoints_v1');
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function stateWithSeasonData(candidate) {
    if (candidate && typeof candidate === 'object' && (candidate.currentSeason || Array.isArray(candidate.seasonHistory))) {
      return candidate;
    }
    return loadState() || candidate || {};
  }

  function seasonBoundaryDate(season) {
    const explicit = String(season?.endDateKey || season?.endDate || '').slice(0, 10);
    if (explicit) return explicit;
    const monthKey = String(season?.monthKey || season?.month || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(monthKey) ? `${monthKey}-31` : '';
  }

  function seasonIdentity(season, index) {
    return String(
      season?.id
      || `${season?.monthKey || season?.month || ''}|${season?.startDateKey || season?.startDate || ''}|${season?.endDateKey || season?.endDate || ''}|${season?.name || season?.label || ''}`
      || `season-${index}`
    );
  }

  function championIdForSeason(season) {
    const stored = season?.championSummary?.championId || season?.championId || '';
    if (stored) return String(stored);
    try {
      return String(core.getSeasonChampionFromFinals?.(season)?.playerId || '');
    } catch (_) {
      return '';
    }
  }

  function getTournamentChampionGoldBonus(playerId, stateInput = null) {
    const id = String(playerId || '').trim();
    if (!id) return 0;

    const state = stateWithSeasonData(stateInput);
    const seasons = [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean);
    const seen = new Set();
    let bonus = 0;

    seasons.forEach((season, index) => {
      const key = seasonIdentity(season, index);
      if (seen.has(key)) return;
      seen.add(key);

      const boundary = seasonBoundaryDate(season);
      if (!boundary || boundary < GOLD_START_DATE) return;
      if (championIdForSeason(season) === id) bonus += BONUS_GOLD;
    });

    return bonus;
  }

  function patchHomepageGold() {
    const original = global.getHomepageGoldValue;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsChampionBonusIncluded) return true;

    const wrapped = function getHomepageGoldValueWithChampionBonus(playerId) {
      const base = original.apply(this, arguments);
      if (base == null) return base;
      return roundGold((Number(base) || 0) + getTournamentChampionGoldBonus(playerId));
    };
    wrapped.__taskPointsChampionBonusIncluded = true;
    wrapped.__taskPointsOriginal = original;
    global.getHomepageGoldValue = wrapped;

    global.formatHomepageGold = function formatHomepageGoldWithChampionBonus(playerId) {
      const gold = global.getHomepageGoldValue(playerId);
      return gold === null ? 'Gold: —' : `Gold: ${Number(gold).toFixed(1)}`;
    };
    global.formatHomepageGold.__taskPointsChampionBonusIncluded = true;
    return true;
  }

  function patchRankingsGold() {
    const original = global.computeRankingExtrasForPlayer;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsChampionBonusIncluded) return true;

    const wrapped = function computeRankingExtrasWithChampionBonus(player, row, state) {
      const result = original.apply(this, arguments) || {};
      const playerId = String(row?.playerId || player?.id || '').trim();
      return {
        ...result,
        gold: roundGold((Number(result.gold) || 0) + getTournamentChampionGoldBonus(playerId, state))
      };
    };
    wrapped.__taskPointsChampionBonusIncluded = true;
    wrapped.__taskPointsOriginal = original;
    global.computeRankingExtrasForPlayer = wrapped;
    return true;
  }

  function refreshHomeGold() {
    if (typeof global.getHomepageGoldValue !== 'function') return;
    const state = loadState();
    const youElement = global.document?.getElementById?.('matchupYourGold');
    if (youElement) youElement.textContent = global.formatHomepageGold?.('YOU') || `Gold: ${global.getHomepageGoldValue('YOU').toFixed(1)}`;

    const today = typeof global.getGameDayKey === 'function'
      ? global.getGameDayKey(new Date())
      : new Date().toISOString().slice(0, 10);
    const matchup = state && typeof core.chooseUserMatchupForDate === 'function'
      ? core.chooseUserMatchupForDate(state, today, 'YOU')
      : null;
    const opponentId = matchup
      ? (matchup.playerAId === 'YOU' ? matchup.playerBId : matchup.playerAId)
      : '';
    const opponentElement = global.document?.getElementById?.('matchupOpponentGold');
    if (opponentElement && opponentId) opponentElement.textContent = global.formatHomepageGold?.(opponentId) || `Gold: ${global.getHomepageGoldValue(opponentId).toFixed(1)}`;
  }

  function installGoldDisplayPatches() {
    const pathname = String(global.location?.pathname || '');
    const isRankings = pathname.endsWith('/rankings.html') || pathname === 'rankings.html';
    const isHome = pathname === '' || pathname === '/' || pathname.endsWith('/index.html');
    const homepageReady = !isHome || patchHomepageGold();
    const rankingsReady = !isRankings || patchRankingsGold();

    if (!homepageReady || !rankingsReady) return false;
    if (isHome) refreshHomeGold();
    if (isRankings && typeof global.renderRankings === 'function') {
      try { global.renderRankings(); } catch (_) {}
    }
    return true;
  }

  function installWhenReady() {
    if (installGoldDisplayPatches()) return;
    installAttempts += 1;
    if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installWhenReady, 50);
  }

  core.SEASON_CHAMPION_GOLD_BONUS = BONUS_GOLD;
  core.SEASON_CHAMPION_GOLD_START_DATE = GOLD_START_DATE;
  core.getTournamentChampionGoldBonus = getTournamentChampionGoldBonus;
  global.TaskPointsSeasonChampionGoldBonus = {
    BONUS_GOLD,
    GOLD_START_DATE,
    getTournamentChampionGoldBonus,
    installGoldDisplayPatches,
    patchHomepageGold,
    patchRankingsGold
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
