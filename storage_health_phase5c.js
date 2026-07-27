(function installTaskPointsPhase5CHealth(global) {
  'use strict';
  const api = global.TaskPointsStorageHealth || {};
  const STORAGE_KEY = 'taskpoints_v1';
  const DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const DB_NAME = 'taskpoints_verified_secondary_v1';
  const STORE_NAME = 'snapshots';
  const MAJOR_KEYS = api.MAJOR_KEYS || ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'];
  const $ = (id) => document.getElementById(id);
  const safeJson = api.safeJson || ((raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } });
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Verified secondary read failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('Verified secondary transaction aborted.'));
      transaction.onerror = () => undefined;
    });
  }

  async function openExistingDatabase() {
    if (!global.indexedDB) return null;
    if (typeof global.indexedDB.databases === 'function') {
      try {
        const databases = await global.indexedDB.databases();
        if (!databases.some((entry) => entry?.name === DB_NAME)) return null;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
        try { request.transaction?.abort(); } catch (_) {}
      };
      request.onsuccess = () => {
        if (created) { request.result?.close?.(); resolve(null); }
        else resolve(request.result);
      };
      request.onerror = () => created || request.error?.name === 'AbortError'
        ? resolve(null)
        : reject(request.error || new Error('Verified secondary database could not be opened.'));
      request.onblocked = () => reject(new Error('Verified secondary database is blocked by another TaskPoints page.'));
    });
  }

  async function readLatestSecondary() {
    const db = await openExistingDatabase();
    if (!db) return { available: false, record: null, error: '' };
    try {
      if (!db.objectStoreNames.contains(STORE_NAME)) return { available: false, record: null, error: 'Snapshot store is missing.' };
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const finished = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore(STORE_NAME).get('latest'));
      await finished;
      return { available: true, record: record || null, error: '' };
    } finally { db.close(); }
  }

  function snapshot(secondary) {
    const raw = localStorage.getItem(STORAGE_KEY);
    const diagnostics = safeJson(localStorage.getItem(DIAG_KEY), {}) || {};
    let currentCounts = {};
    let recordCounts = secondary.record?.counts || {};
    try { currentCounts = api.countsFor?.(api.parseStoredRaw?.(raw)?.state) || {}; } catch (_) {}
    if (!recordCounts.majorTotal && secondary.record?.raw) {
      try { recordCounts = api.countsFor?.(api.parseStoredRaw?.(secondary.record.raw)?.state) || {}; } catch (_) {}
    }
    const currentRawHash = api.rawHash?.(raw) || '';
    const diagnosticCounts = diagnostics.phase5cLastVerifiedCounts || {};
    const diagnosticHashMatches = Boolean(raw && diagnostics.phase5cLastVerifiedRawHash && diagnostics.phase5cLastVerifiedRawHash === currentRawHash);
    const diagnosticCountsMatch = MAJOR_KEYS.every((key) => Number(currentCounts[key] || 0) === Number(diagnosticCounts[key] || 0));
    const recordRawMatches = Boolean(raw && secondary.record?.raw === raw);
    const recordHashMatches = Boolean(currentRawHash && secondary.record?.rawHash === currentRawHash);
    const recordCountsMatch = MAJOR_KEYS.every((key) => Number(currentCounts[key] || 0) === Number(recordCounts[key] || 0));
    const installed = diagnostics.phase5cEnabled === true && diagnostics.phase5cHookInstalled === true;
    const verified = installed
      && secondary.record?.status === 'passed_verification'
      && recordRawMatches
      && recordHashMatches
      && recordCountsMatch
      && diagnostics.phase5cMirrorsCurrentSave === true
      && diagnosticHashMatches
      && diagnosticCountsMatch;
    let level = 'warn';
    let title = 'Verified secondary mirror is waiting';
    let detail = installed
      ? 'Make one successful TaskPoints change, then refresh this page.'
      : 'Open the normal TaskPoints app once after deployment, then return here.';
    if (verified) {
      level = 'good';
      title = 'Verified secondary mirror matches the current save';
      detail = `${Number(recordCounts.majorTotal || 0).toLocaleString()} major records were directly read, hash-checked, and count-verified in independent IndexedDB storage.`;
    } else if (diagnostics.phase5cLastStatus === 'verification_failed' || diagnostics.phase5cLastStatus === 'hook_install_failed' || secondary.error) {
      level = 'bad';
      title = 'Verified secondary mirror needs attention';
      detail = secondary.error || diagnostics.phase5cLastError || diagnostics.phase5cLastStatus;
    } else if (diagnostics.phase5cLastStatus === 'waiting_for_habit_journal') {
      detail = 'A pending habit journal is being preserved. The mirror will update after a completed save.';
    } else if (secondary.record || diagnostics.phase5cLastVerifiedAtISO) {
      title = 'Verified secondary mirror is behind the current save';
      detail = 'A verified copy exists, but its exact raw snapshot or record counts do not yet match the newest localStorage save.';
    }
    return {
      level, title, detail, installed, verified,
      status: diagnostics.phase5cLastStatus || 'not_installed',
      lastVerifiedAtISO: secondary.record?.verifiedAtISO || diagnostics.phase5cLastVerifiedAtISO || '',
      lastVerifiedRawHash: secondary.record?.rawHash || diagnostics.phase5cLastVerifiedRawHash || '',
      lastVerifiedCounts: recordCounts,
      mirrorsCurrentSave: diagnostics.phase5cMirrorsCurrentSave === true,
      diagnosticHashMatches, diagnosticCountsMatch,
      recordAvailable: secondary.available,
      recordPresent: Boolean(secondary.record),
      recordRawMatches, recordHashMatches, recordCountsMatch,
      authoritativeSource: diagnostics.phase5cAuthoritativeSource || 'localStorage',
      indexedDbReadsEnabled: diagnostics.phase5cIndexedDbReadsEnabled === true,
      indexedDbWriteBackEnabled: diagnostics.phase5cIndexedDbWriteBackEnabled === true,
      lastError: secondary.error || diagnostics.phase5cLastError || null
    };
  }

  function updateOverall() {
    const checks = [...document.querySelectorAll('#healthChecks .check')];
    const bad = checks.filter((item) => item.classList.contains('bad')).length;
    const warn = checks.filter((item) => item.classList.contains('warn')).length;
    const good = checks.filter((item) => item.classList.contains('good')).length;
    if ($('overallLabel')) $('overallLabel').textContent = bad ? 'Needs attention' : (warn ? 'Protected with warnings' : 'Storage looks healthy');
    if ($('overallDetail')) $('overallDetail').textContent = bad ? `${bad} critical check(s) failed.` : `${good} checks passed${warn ? ` with ${warn} warning(s)` : ''}.`;
  }

  let renderRevision = 0;
  let renderTimer = null;
  async function render() {
    const revision = ++renderRevision;
    let secondary;
    try { secondary = await readLatestSecondary(); }
    catch (error) { secondary = { available: false, record: null, error: String(error?.message || error) }; }
    if (revision !== renderRevision) return;
    const data = snapshot(secondary);
    const checks = $('healthChecks');
    if (checks && !checks.querySelector('[data-phase5c-check]')) {
      checks.insertAdjacentHTML('beforeend', `<div class="check ${data.level}" data-phase5c-check><span class="dot"></span><div><div class="font-semibold">${escapeHtml(data.title)}</div><div class="text-sm muted">${escapeHtml(data.detail)}</div></div></div>`);
    }
    const protection = $('protectionRows');
    if (protection && !protection.querySelector('[data-phase5c-row]')) {
      const value = data.verified
        ? `Current — verified ${api.formatTimestamp?.(data.lastVerifiedAtISO) || data.lastVerifiedAtISO}`
        : data.status.replaceAll('_', ' ');
      protection.insertAdjacentHTML('beforeend', `<div class="flex justify-between gap-4 border-b border-zinc-800 py-2 last:border-0" data-phase5c-row><span class="muted">Verified secondary mirror</span><strong class="text-right break-words">${escapeHtml(value)}</strong></div>`);
    }
    const cards = $('summaryCards');
    if (cards && !cards.querySelector('[data-phase5c-card]')) {
      cards.insertAdjacentHTML('beforeend', `<div class="metric" data-phase5c-card><div class="metric-label">Secondary mirror</div><div class="metric-value">${data.verified ? 'Current' : (data.level === 'bad' ? 'Issue' : 'Waiting')}</div></div>`);
    }
    const technical = $('technicalReport');
    if (technical) {
      const report = safeJson(technical.textContent, null);
      if (report && typeof report === 'object') {
        report.verifiedSecondary = data;
        const next = JSON.stringify(report, null, 2);
        if (technical.textContent !== next) technical.textContent = next;
      }
    }
    updateOverall();
  }

  const schedule = () => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 0);
  };
  ['healthChecks','protectionRows','summaryCards','technicalReport'].forEach((id) => {
    const target = $(id);
    if (target) new MutationObserver(schedule).observe(target, { childList: true, subtree: true, characterData: true });
  });
  schedule();
})(typeof window !== 'undefined' ? window : globalThis);
