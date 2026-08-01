(function installTaskPointsSharedSaveWork(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__sharedSaveWorkInstalled) return;
  if (typeof core.parseTaskPointsStorageJson !== 'function' || typeof core.shadowSourceSummary !== 'function') return;
  core.__sharedSaveWorkInstalled = true;

  const originalParse = core.parseTaskPointsStorageJson.bind(core);
  const originalSummary = core.shadowSourceSummary.bind(core);
  const originalStructuredClone = typeof global.structuredClone === 'function'
    ? global.structuredClone.bind(global)
    : null;
  const snapshotMeta = new WeakMap();
  let recentParse = null;
  let parseReuseCount = 0;
  let summaryReuseCount = 0;
  let clonePropagationCount = 0;

  function pendingJournalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; }
    catch (_) { return 1; }
  }

  function verifiedCacheForRaw(raw) {
    const cache = core.getPhase4VerifiedPrimaryCache?.();
    if (!cache || cache.status !== 'passed_verification') return null;
    if (!cache.state || typeof cache.state !== 'object' || Array.isArray(cache.state)) return null;
    if (typeof raw !== 'string' || cache.mirrorRaw !== raw) return null;
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return null;
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return null;
    if (pendingJournalCount() > 0) return null;
    return cache;
  }

  function summaryFromCache(cache) {
    const stateHash = cache.destinationHash || cache.sourceHash || cache.stateHash || null;
    if (!stateHash) return null;
    return {
      counts: cache.destinationCounts || cache.sourceCounts || null,
      hashes: { state: stateHash }
    };
  }

  function cloneSnapshot(value) {
    if (originalStructuredClone) return originalStructuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function rememberSnapshot(value, metadata) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !metadata) return value;
    snapshotMeta.set(value, metadata);
    return value;
  }

  function rememberRecentParse(raw, parsed) {
    if (typeof raw !== 'string' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      recentParse = null;
      return;
    }
    recentParse = {
      raw,
      source: parsed,
      snapshot: cloneSnapshot(parsed),
      summary: null
    };
  }

  if (originalStructuredClone) {
    global.structuredClone = function taskPointsSharedStructuredClone(value, options) {
      const cloned = originalStructuredClone(value, options);
      const metadata = value && typeof value === 'object' ? snapshotMeta.get(value) : null;
      if (metadata && cloned && typeof cloned === 'object') {
        snapshotMeta.set(cloned, metadata);
        clonePropagationCount += 1;
      }
      return cloned;
    };
  }

  core.parseTaskPointsStorageJson = function sharedSaveParse(raw, fallback = {}) {
    const cache = verifiedCacheForRaw(raw);
    const cachedSummary = cache ? summaryFromCache(cache) : null;
    if (cache && cachedSummary) {
      parseReuseCount += 1;
      return rememberSnapshot(cloneSnapshot(cache.state), {
        raw,
        sequence: Number(cache.sequence) || 0,
        summary: cachedSummary,
        verifiedAt: cache.verifiedAt || null
      });
    }

    if (recentParse && typeof raw === 'string' && recentParse.raw === raw) {
      parseReuseCount += 1;
      const cloned = cloneSnapshot(recentParse.snapshot);
      if (recentParse.summary) {
        rememberSnapshot(cloned, {
          raw,
          sequence: 0,
          summary: recentParse.summary,
          verifiedAt: null
        });
      }
      return cloned;
    }

    const parsed = originalParse(raw, fallback);
    rememberRecentParse(raw, parsed);
    return parsed;
  };

  core.shadowSourceSummary = function sharedSaveSummary(state) {
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const metadata = snapshotMeta.get(state);
      if (metadata?.summary) {
        summaryReuseCount += 1;
        return metadata.summary;
      }

      const cache = core.getPhase4VerifiedPrimaryCache?.();
      if (cache?.status === 'passed_verification' && cache.state === state) {
        const cachedSummary = summaryFromCache(cache);
        if (cachedSummary) {
          snapshotMeta.set(state, {
            raw: cache.mirrorRaw,
            sequence: Number(cache.sequence) || 0,
            summary: cachedSummary,
            verifiedAt: cache.verifiedAt || null
          });
          summaryReuseCount += 1;
          return cachedSummary;
        }
      }
    }

    const result = originalSummary(state);
    if (recentParse && recentParse.source === state) {
      recentParse.summary = result;
      rememberSnapshot(recentParse.snapshot, {
        raw: recentParse.raw,
        sequence: 0,
        summary: result,
        verifiedAt: null
      });
    }
    return result;
  };

  core.getSharedVerifiedSavePackage = function getSharedVerifiedSavePackage(raw = null) {
    const targetRaw = typeof raw === 'string'
      ? raw
      : (() => {
          try { return global.localStorage?.getItem?.(core.STORAGE_KEY) ?? null; }
          catch (_) { return null; }
        })();
    const cache = verifiedCacheForRaw(targetRaw);
    if (!cache) return null;
    const summary = summaryFromCache(cache);
    if (!summary) return null;
    rememberSnapshot(cache.state, {
      raw: targetRaw,
      sequence: Number(cache.sequence) || 0,
      summary,
      verifiedAt: cache.verifiedAt || null
    });
    return {
      schemaVersion: 1,
      sequence: Number(cache.sequence) || 0,
      raw: targetRaw,
      state: cache.state,
      summary,
      mirrorHash: cache.mirrorHash || null,
      verifiedAt: cache.verifiedAt || null,
      status: 'passed_verification'
    };
  };

  core.clearSharedSaveWork = function clearSharedSaveWork() {
    recentParse = null;
  };

  core.getSharedSaveWorkStatus = () => ({
    installed: true,
    parseReuseCount,
    summaryReuseCount,
    clonePropagationCount,
    recentRawPresent: Boolean(recentParse?.raw),
    packageReady: Boolean(core.getSharedVerifiedSavePackage?.())
  });
})(typeof window !== 'undefined' ? window : globalThis);
;(function installTaskPointsYouScoreAliasSync(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__youScoreAliasSyncInstalled || typeof core.saveStateSnapshot !== 'function') return;
  core.__youScoreAliasSyncInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const EPSILON = 0.0001;
  const MAX_SAMPLE_ROWS = 12;
  const originalSaveStateSnapshot = core.saveStateSnapshot.bind(core);
  let baselineBySide = null;
  let automaticSynchronizedSides = 0;
  let automaticScheduleCopies = 0;

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));
  const isYou = (playerId) => String(playerId || '').toUpperCase() === 'YOU';
  const equalScore = (left, right) =>
    finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= EPSILON;

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function dateKey(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dateKey, row.dayKey, row.date, row.completedAtISO, row.finalizedAtISO]) {
      if (!populated(value)) continue;
      const direct = String(value).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    }
    return '';
  }

  function matchupId(row) {
    return String(row?.id || row?.matchupId || '').trim();
  }

  function contextKey(row) {
    if (!row || typeof row !== 'object') return '';
    return [
      row.seasonId,
      row.seriesId || row.seasonSeriesId,
      row.roundId,
      row.gameNumber || row.seriesGameNumber,
      row.matchupType
    ].map((value) => populated(value) ? String(value).trim() : '').join('|');
  }

  function matchupIdentity(row, index = -1) {
    const id = matchupId(row);
    if (id) return `id:${id}`;
    return [
      'legacy',
      dateKey(row),
      String(row?.playerAId || ''),
      String(row?.playerBId || ''),
      contextKey(row),
      Number.isInteger(index) ? String(index) : ''
    ].join('|');
  }

  function sideFields(side) {
    return side === 'B'
      ? { primaryName: 'scoreB', aliasName: 'playerBScore', playerIdName: 'playerBId' }
      : { primaryName: 'scoreA', aliasName: 'playerAScore', playerIdName: 'playerAId' };
  }

  function sameMatchup(left, right) {
    if (!left || !right) return false;
    const leftId = matchupId(left);
    const rightId = matchupId(right);
    if (leftId && rightId) return leftId === rightId;
    if (dateKey(left) !== dateKey(right)) return false;
    if (String(left.playerAId || '') !== String(right.playerAId || '')) return false;
    if (String(left.playerBId || '') !== String(right.playerBId || '')) return false;
    const leftContext = contextKey(left);
    const rightContext = contextKey(right);
    return !leftContext || !rightContext || leftContext === rightContext;
  }

  function scheduleCopyCount(state, sourceMatchup) {
    let count = 0;
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach((candidate) => {
        if (sameMatchup(candidate, sourceMatchup)) count += 1;
      });
    });
    return count;
  }

  function updateScheduleCopies(state, sourceMatchup, side, score) {
    const fields = sideFields(side);
    let copies = 0;
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach((candidate) => {
        if (!sameMatchup(candidate, sourceMatchup)) return;
        candidate[fields.aliasName] = score;
        copies += 1;
      });
    });
    return copies;
  }

  function buildYouScoreAliasRepairPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const repairs = [];
    let scannedYouSides = 0;
    let consistentYouSides = 0;

    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup, matchupIndex) => {
      if (!matchup) return;
      ['A', 'B'].forEach((side) => {
        const fields = sideFields(side);
        if (!isYou(matchup[fields.playerIdName])) return;
        scannedYouSides += 1;
        const primary = matchup[fields.primaryName];
        const alias = matchup[fields.aliasName];
        if (!finite(primary)) return;
        if (equalScore(primary, alias)) {
          consistentYouSides += 1;
          return;
        }
        repairs.push({
          matchupIndex,
          matchupId: matchupId(matchup),
          matchupIdentity: matchupIdentity(matchup, matchupIndex),
          dateKey: dateKey(matchup),
          side,
          primaryName: fields.primaryName,
          aliasName: fields.aliasName,
          primaryScore: Number(primary),
          aliasPresent: populated(alias),
          aliasScore: finite(alias) ? Number(alias) : null,
          scheduleCopies: scheduleCopyCount(state, matchup)
        });
      });
    });

    const matchupKeys = new Set(repairs.map((item) => item.matchupIdentity));
    return {
      scannedYouSides,
      consistentYouSides,
      repairs,
      repairedMatchups: matchupKeys.size,
      scheduleCopies: repairs.reduce((sum, item) => sum + item.scheduleCopies, 0)
    };
  }

  function planFingerprint(plan) {
    return JSON.stringify((plan?.repairs || []).map((item) => [
      item.matchupIdentity,
      item.side,
      item.primaryName,
      item.aliasName,
      item.primaryScore,
      item.aliasPresent,
      item.aliasScore
    ]));
  }

  function snapshotOutsideMatchupsAndSchedule(state) {
    const copy = {};
    Object.keys(state || {}).sort().forEach((key) => {
      if (key === 'matchups' || key === 'schedule') return;
      copy[key] = state[key];
    });
    return JSON.stringify(copy);
  }

  function applyYouScoreAliasRepair(stateInput, previewPlan = null) {
    const sourceState = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const livePlan = buildYouScoreAliasRepairPlan(sourceState);
    if (previewPlan && planFingerprint(livePlan) !== planFingerprint(previewPlan)) {
      throw new Error('The YOU score-alias data changed after the preview. Run the preview again.');
    }

    const state = clone(sourceState);
    const beforeOtherDomains = snapshotOutsideMatchupsAndSchedule(state);
    const matchups = Array.isArray(state.matchups) ? state.matchups : [];
    const repairedIds = new Set();
    let repairedSides = 0;
    let scheduleCopies = 0;
    let skippedStale = 0;

    livePlan.repairs.forEach((item) => {
      let matchup = null;
      if (item.matchupId) {
        matchup = matchups.find((candidate) => matchupId(candidate) === item.matchupId) || null;
      }
      if (!matchup) matchup = matchups[item.matchupIndex] || null;
      if (!matchup || matchupIdentity(matchup, item.matchupIndex) !== item.matchupIdentity) {
        skippedStale += 1;
        return;
      }

      const fields = sideFields(item.side);
      const primary = matchup[fields.primaryName];
      const alias = matchup[fields.aliasName];
      const aliasStillMatchesPreview = item.aliasPresent
        ? equalScore(alias, item.aliasScore)
        : !populated(alias);
      if (!isYou(matchup[fields.playerIdName]) || !equalScore(primary, item.primaryScore) || !aliasStillMatchesPreview) {
        skippedStale += 1;
        return;
      }

      matchup[fields.aliasName] = Number(primary);
      repairedSides += 1;
      repairedIds.add(item.matchupIdentity);
      scheduleCopies += updateScheduleCopies(state, matchup, item.side, Number(primary));
    });

    if (snapshotOutsideMatchupsAndSchedule(state) !== beforeOtherDomains) {
      throw new Error('The YOU score-alias repair attempted to change unrelated data.');
    }

    return {
      state,
      changed: repairedSides > 0,
      repairedSides,
      repairedMatchups: repairedIds.size,
      scheduleCopies,
      skippedStale,
      remainingPlan: buildYouScoreAliasRepairPlan(state)
    };
  }

  function readPersistedState() {
    try {
      if (typeof core.readTaskPointsStoredState === 'function') {
        const decoded = core.readTaskPointsStoredState(STORAGE_KEY, null);
        if (decoded && typeof decoded === 'object') return decoded;
      }
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return null;
      if (typeof core.parseTaskPointsStorageJson === 'function') {
        const decoded = core.parseTaskPointsStorageJson(raw, null);
        if (decoded && typeof decoded === 'object') return decoded;
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function buildBaseline(stateInput) {
    const map = new Map();
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!matchup) return;
      ['A', 'B'].forEach((side) => {
        const fields = sideFields(side);
        if (!isYou(matchup[fields.playerIdName]) || !finite(matchup[fields.primaryName])) return;
        map.set(`${matchupIdentity(matchup, index)}|${side}`, Number(matchup[fields.primaryName]));
      });
    });
    return map;
  }

  function ensureBaseline() {
    if (baselineBySide) return baselineBySide;
    baselineBySide = buildBaseline(readPersistedState() || {});
    return baselineBySide;
  }

  function synchronizeFutureYouAliases(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const baseline = ensureBaseline();
    let synchronizedSides = 0;
    let scheduleCopies = 0;

    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!matchup) return;
      ['A', 'B'].forEach((side) => {
        const fields = sideFields(side);
        if (!isYou(matchup[fields.playerIdName]) || !finite(matchup[fields.primaryName])) return;
        const key = `${matchupIdentity(matchup, index)}|${side}`;
        const primary = Number(matchup[fields.primaryName]);
        const priorPrimary = baseline.get(key);
        const isNewSide = !baseline.has(key);
        const primaryChanged = finite(priorPrimary) && Math.abs(primary - Number(priorPrimary)) > EPSILON;
        if (!isNewSide && !primaryChanged) return;
        if (!equalScore(matchup[fields.aliasName], primary)) {
          matchup[fields.aliasName] = primary;
          synchronizedSides += 1;
          scheduleCopies += updateScheduleCopies(state, matchup, side, primary);
        }
      });
    });

    return { state, synchronizedSides, scheduleCopies };
  }

  function saveSucceeded(result) {
    if (result?.blocked || result?.blockedByQuotaCircuit || result?.skipped || result?.ok === false) return false;
    return true;
  }

  core.saveStateSnapshot = function saveStateSnapshotWithYouAliasSync(state, options = {}) {
    const sync = synchronizeFutureYouAliases(state);
    const result = originalSaveStateSnapshot(sync.state, options);
    if (saveSucceeded(result)) {
      const savedState = result?.state && typeof result.state === 'object' ? result.state : sync.state;
      if (Array.isArray(savedState?.matchups)) baselineBySide = buildBaseline(savedState);
      automaticSynchronizedSides += sync.synchronizedSides;
      automaticScheduleCopies += sync.scheduleCopies;
    }
    return result;
  };
  core.saveStateSnapshot.__taskPointsYouScoreAliasSync = true;
  core.saveStateSnapshot.__taskPointsOriginal = originalSaveStateSnapshot;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function formatScore(value) {
    return finite(value) ? String(Number(Number(value).toFixed(2))) : 'missing';
  }

  function loadCurrentState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      return loaded?.state || loaded || readPersistedState() || {};
    } catch (_) {
      return readPersistedState() || {};
    }
  }

  function sampleList(repairs) {
    if (!repairs.length) return '<p class="muted text-sm mt-2">No stale YOU aliases found.</p>';
    const rows = repairs.slice(0, MAX_SAMPLE_ROWS).map((item) => (
      `<li>${escapeHtml(item.dateKey || 'Unknown date')} · side ${escapeHtml(item.side)}: ` +
      `${escapeHtml(item.aliasName)} ${escapeHtml(formatScore(item.aliasScore))} → ` +
      `${escapeHtml(formatScore(item.primaryScore))}</li>`
    )).join('');
    const omitted = repairs.length > MAX_SAMPLE_ROWS
      ? `<li class="muted">… ${repairs.length - MAX_SAMPLE_ROWS} additional repair(s)</li>`
      : '';
    return `<ul class="text-xs muted mt-2 space-y-1 list-disc pl-5">${rows}${omitted}</ul>`;
  }

  function installAuditRepairPanel() {
    const document = global.document;
    if (!document?.createElement) return false;
    const checks = document.getElementById('auditChecks');
    if (!checks) return false;
    if (document.getElementById('youScoreAliasRepairPanel')) return true;
    const main = checks.closest?.('main') || document.querySelector?.('main');
    if (!main) return false;

    const panel = document.createElement('section');
    panel.id = 'youScoreAliasRepairPanel';
    panel.className = 'glass space-y-3';
    panel.innerHTML = `
      <div>
        <div class="text-lg font-semibold">YOU Score-Alias Repair</div>
        <p class="muted text-sm mt-1">
          Preview stale <code>playerAScore/playerBScore</code> values on matchups involving You.
          The verified <code>scoreA/scoreB</code> values remain unchanged, as do winners, results,
          game history, Gold, and Season data.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="previewYouScoreAliasRepairBtn" type="button" class="btn btn-teal">Preview YOU Alias Repair</button>
        <button id="repairYouScoreAliasesBtn" type="button" class="btn btn-ghost" disabled>Repair YOU Score Aliases</button>
      </div>
      <label class="flex items-start gap-2 text-sm">
        <input id="youScoreAliasBackupConfirmed" type="checkbox" class="mt-1">
        <span>I exported a fresh full backup of the current phone data.</span>
      </label>
      <div id="youScoreAliasRepairStatus" class="rounded-xl border border-zinc-800/60 bg-white/5 dark:bg-zinc-900/35 p-3 text-sm muted">
        Run the preview before making changes.
      </div>
    `;
    main.appendChild(panel);

    const previewButton = panel.querySelector('#previewYouScoreAliasRepairBtn');
    const repairButton = panel.querySelector('#repairYouScoreAliasesBtn');
    const backupCheckbox = panel.querySelector('#youScoreAliasBackupConfirmed');
    const status = panel.querySelector('#youScoreAliasRepairStatus');
    let previewPlan = null;
    let previewFingerprint = '';

    function updateAvailability() {
      repairButton.disabled = !(previewPlan?.repairs?.length > 0 && backupCheckbox.checked);
    }

    function renderPreview(plan) {
      previewPlan = plan;
      previewFingerprint = planFingerprint(plan);
      status.innerHTML = `
        <div class="grid sm:grid-cols-3 gap-2">
          <div><strong>${plan.repairs.length}</strong><br><span class="muted text-xs">YOU aliases to repair</span></div>
          <div><strong>${plan.repairedMatchups}</strong><br><span class="muted text-xs">matchups affected</span></div>
          <div><strong>${plan.scheduleCopies}</strong><br><span class="muted text-xs">schedule copies to update</span></div>
        </div>
        ${sampleList(plan.repairs)}
        <p class="muted text-xs mt-2">Primary matchup scores changed: 0. Winners/results changed: 0.</p>
      `;
      updateAvailability();
    }

    previewButton.addEventListener('click', () => {
      backupCheckbox.checked = false;
      renderPreview(buildYouScoreAliasRepairPlan(loadCurrentState()));
    });
    backupCheckbox.addEventListener('change', updateAvailability);

    repairButton.addEventListener('click', () => {
      if (!previewPlan || !backupCheckbox.checked) return;
      const currentState = loadCurrentState();
      const freshPlan = buildYouScoreAliasRepairPlan(currentState);
      if (planFingerprint(freshPlan) !== previewFingerprint) {
        previewPlan = null;
        updateAvailability();
        status.textContent = 'The saved data changed after the preview. Run Preview YOU Alias Repair again.';
        return;
      }
      if (!freshPlan.repairs.length) {
        renderPreview(freshPlan);
        return;
      }

      const confirmed = global.confirm?.(
        `Repair ${freshPlan.repairs.length} YOU score alias(es) across ${freshPlan.repairedMatchups} matchup(s)?\n\n` +
        'scoreA/scoreB, winners, results, game history, Gold, and Season data will not be changed.'
      );
      if (confirmed === false) return;

      try {
        const result = applyYouScoreAliasRepair(currentState, freshPlan);
        const saved = core.saveStateSnapshot(result.state, {
          savePath: 'audit-you-score-alias-repair',
          userInitiated: true,
          interactive: true,
          immediateWrite: true
        });
        if (!saveSucceeded(saved)) {
          throw new Error(saved?.reason || saved?.error || 'The save was blocked or skipped.');
        }

        backupCheckbox.checked = false;
        const postState = saved?.state || result.state;
        const postPlan = buildYouScoreAliasRepairPlan(postState);
        renderPreview(postPlan);
        status.insertAdjacentHTML('afterbegin',
          `<p class="text-emerald-400 font-semibold mb-2">Repaired ${result.repairedSides} YOU aliases across ` +
          `${result.repairedMatchups} matchup(s). Updated ${result.scheduleCopies} schedule copy/copies. ` +
          `Primary scores changed: 0. Winners/results changed: 0. Stale rows skipped: ${result.skippedStale}.</p>`
        );
        try { global.runAudit?.(); } catch (_) {}
      } catch (error) {
        status.textContent = `Repair failed: ${error?.message || error}`;
      }
    });

    return true;
  }

  const api = {
    buildYouScoreAliasRepairPlan,
    applyYouScoreAliasRepair,
    synchronizeFutureYouAliases,
    planFingerprint,
    installAuditRepairPanel,
    getStatus() {
      return {
        installed: true,
        baselineReady: Boolean(baselineBySide),
        automaticSynchronizedSides,
        automaticScheduleCopies
      };
    },
    resetBaseline(state = null) {
      baselineBySide = state ? buildBaseline(state) : null;
    }
  };
  core.YouScoreAliasSync = api;
  global.TaskPointsYouScoreAliasSync = api;

  let installAttempts = 0;
  function installWhenReady() {
    if (!global.document) return;
    if (installAuditRepairPanel()) return;
    installAttempts += 1;
    if (installAttempts < 120) global.setTimeout?.(installWhenReady, 50);
  }
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
