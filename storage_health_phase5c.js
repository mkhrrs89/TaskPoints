(function installTaskPointsPhase5CHealth(global) {
  'use strict';
  const api = global.TaskPointsStorageHealth || {};
  const STORAGE_KEY = 'taskpoints_v1';
  const DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const MAJOR_KEYS = api.MAJOR_KEYS || ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'];
  const $ = (id) => document.getElementById(id);
  const safeJson = api.safeJson || ((raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } });
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function snapshot() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const diagnostics = safeJson(localStorage.getItem(DIAG_KEY), {}) || {};
    let currentCounts = {};
    try { currentCounts = api.countsFor?.(api.parseStoredRaw?.(raw)?.state) || {}; } catch (_) {}
    const verifiedCounts = diagnostics.phase5cLastVerifiedCounts || {};
    const hashMatches = Boolean(raw && diagnostics.phase5cLastVerifiedRawHash && diagnostics.phase5cLastVerifiedRawHash === api.rawHash?.(raw));
    const countsMatch = MAJOR_KEYS.every((key) => Number(currentCounts[key] || 0) === Number(verifiedCounts[key] || 0));
    const installed = diagnostics.phase5cEnabled === true && diagnostics.phase5cHookInstalled === true;
    const verified = installed
      && diagnostics.phase5cLastStatus === 'passed_verification'
      && diagnostics.phase5cMirrorsCurrentSave === true
      && hashMatches
      && countsMatch;
    let level = 'warn';
    let title = 'Verified secondary mirror is waiting';
    let detail = installed
      ? 'Make one successful TaskPoints change, then refresh this page.'
      : 'Open the normal TaskPoints app once after deployment, then return here.';
    if (verified) {
      level = 'good';
      title = 'Verified secondary mirror matches the current save';
      detail = `${Number(verifiedCounts.majorTotal || 0).toLocaleString()} major records were hash- and count-verified in independent IndexedDB storage.`;
    } else if (diagnostics.phase5cLastStatus === 'verification_failed' || diagnostics.phase5cLastStatus === 'hook_install_failed') {
      level = 'bad';
      title = 'Verified secondary mirror needs attention';
      detail = diagnostics.phase5cLastError || diagnostics.phase5cLastStatus;
    } else if (diagnostics.phase5cLastStatus === 'waiting_for_habit_journal') {
      detail = 'A pending habit journal is being preserved. The mirror will update after a completed save.';
    } else if (diagnostics.phase5cLastStatus === 'passed_verification_stale' || (diagnostics.phase5cLastVerifiedAtISO && !verified)) {
      title = 'Verified secondary mirror is behind the current save';
      detail = 'The stored copy is valid but does not yet match the newest localStorage snapshot.';
    }
    return {
      level, title, detail, installed, verified,
      status: diagnostics.phase5cLastStatus || 'not_installed',
      lastVerifiedAtISO: diagnostics.phase5cLastVerifiedAtISO || '',
      lastVerifiedRawHash: diagnostics.phase5cLastVerifiedRawHash || '',
      lastVerifiedCounts: verifiedCounts,
      mirrorsCurrentSave: diagnostics.phase5cMirrorsCurrentSave === true,
      hashMatches, countsMatch,
      authoritativeSource: diagnostics.phase5cAuthoritativeSource || 'localStorage',
      indexedDbReadsEnabled: diagnostics.phase5cIndexedDbReadsEnabled === true,
      indexedDbWriteBackEnabled: diagnostics.phase5cIndexedDbWriteBackEnabled === true,
      lastError: diagnostics.phase5cLastError || null
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

  function render() {
    const data = snapshot();
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

  const schedule = () => setTimeout(render, 0);
  ['healthChecks','protectionRows','summaryCards','technicalReport'].forEach((id) => {
    const target = $(id);
    if (target) new MutationObserver(schedule).observe(target, { childList: true, subtree: true, characterData: true });
  });
  schedule();
})(typeof window !== 'undefined' ? window : globalThis);
