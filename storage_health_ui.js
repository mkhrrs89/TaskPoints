(function installTaskPointsStorageHealthUI(global) {
  'use strict';
  const api = global.TaskPointsStorageHealth || {};
  const { COUNT_KEYS, MAJOR_KEYS, safeJson, parseStoredRaw, countsFor, rawHash,
    formatBytes, formatTimestamp, readSafetyVault, readImageReport,
    readBrowserStorage, rollingBackups, parseJournalCount } = api;
  const STORAGE_KEY = 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GUARD_DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const PHASE5B_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const JOURNAL_MARKER_KEY = 'taskpoints_phase5b_journal_reconciled_v1';
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function check(level, title, detail) { return { level, title, detail }; }

  function renderCounts(target, counts) {
    target.innerHTML = COUNT_KEYS.map((key) => `<div class="count-row"><span class="muted">${escapeHtml(key)}</span><strong>${Number(counts?.[key] || 0).toLocaleString()}</strong></div>`).join('');
  }

  function renderChecks(checks) {
    $('healthChecks').innerHTML = checks.map((item) => `<div class="check ${item.level}"><span class="dot"></span><div><div class="font-semibold">${escapeHtml(item.title)}</div><div class="text-sm muted">${escapeHtml(item.detail)}</div></div></div>`).join('');
  }

  function renderProtection(report) {
    const diagnostics = report.guardDiagnostics || {};
    const rows = [
      ['Configured storage mode', report.mode || 'off'],
      ['Recovery hold', report.hold?.active ? `Active since ${formatTimestamp(report.hold.enteredAtISO)}` : 'Not active'],
      ['Phase 5B deferred saving', diagnostics.phase5bLiveBundleDisabled === true ? 'Disabled' : 'Not confirmed'],
      ['Data-loss guard', diagnostics.enabled === true ? `Enabled since ${formatTimestamp(diagnostics.installedAtISO)}` : 'Not confirmed'],
      ['Blocked destructive writes', Number(diagnostics.blockedWritesTotal || 0).toLocaleString()],
      ['Last blocked reason', diagnostics.lastBlockedReason || 'None'],
      ['Legacy Phase 5B journal', report.phase5bJournal.present ? `${report.phase5bJournal.count} pending operation(s)` : 'None'],
      ['Pending habit journal', report.habitJournal.present ? `${report.habitJournal.count} pending change(s)` : 'None'],
      ['Journal reconciliation marker', report.journalMarker ? `Present — revision ${report.journalMarker.revision ?? '—'}` : 'None'],
      ['Rolling local backup slots', `${report.rollingBackups.length} of 4 populated`]
    ];
    $('protectionRows').innerHTML = rows.map(([label,value]) => `<div class="flex justify-between gap-4 border-b border-zinc-800 py-2 last:border-0"><span class="muted">${escapeHtml(label)}</span><strong class="text-right break-words">${escapeHtml(value)}</strong></div>`).join('');
  }

  function renderVault(vault, currentCounts) {
    const list = $('vaultList');
    if (!vault.available || !vault.slots.length) {
      $('vaultSummary').textContent = 'No snapshots found';
      $('vaultSummary').className = 'pill bad-pill';
      list.innerHTML = `<div class="check bad"><span class="dot"></span><div><div class="font-semibold">Safety vault is empty</div><div class="text-sm muted">Open the normal TaskPoints app after deployment and make a successful save, then check again.</div></div></div>`;
      return;
    }
    $('vaultSummary').textContent = `${vault.slots.length} of 4 populated`;
    $('vaultSummary').className = vault.slots.length >= 1 ? 'pill good-pill' : 'pill bad-pill';
    list.innerHTML = vault.slots.map((slot) => {
      const counts = slot.counts || (() => { try { return countsFor(parseStoredRaw(slot.raw).state); } catch (_) { return {}; } })();
      const ratio = currentCounts.majorTotal ? Number(counts.majorTotal || 0) / currentCounts.majorTotal : 0;
      const comparison = ratio >= .98 ? 'Matches current scale' : (ratio >= .8 ? 'Older but substantial' : 'Much smaller than current');
      const comparisonClass = ratio >= .98 ? 'good-pill' : (ratio >= .8 ? 'warn-pill' : 'bad-pill');
      return `<article class="snapshot ${slot.id === 'latest' ? 'latest' : ''}"><div class="flex items-start justify-between gap-3"><div><div class="font-bold">${escapeHtml(slot.id)}</div><div class="text-xs muted">${escapeHtml(formatTimestamp(slot.createdAtISO || slot.updatedAtISO))} · ${escapeHtml(slot.reason || 'known-good snapshot')}</div></div><span class="pill ${comparisonClass}">${escapeHtml(comparison)}</span></div><div class="count-grid mt-3">${MAJOR_KEYS.map((key) => `<div class="count-row"><span class="muted">${escapeHtml(key)}</span><strong>${Number(counts[key] || 0).toLocaleString()}</strong></div>`).join('')}</div></article>`;
    }).join('');
  }

  function renderBrowserStorage(browser) {
    const estimate = browser.estimate || {};
    const usage = Number(estimate.usage || 0);
    const quota = Number(estimate.quota || 0);
    const ratio = quota > 0 ? usage / quota : null;
    const rows = [
      ['Origin usage', browser.available && estimate.usage != null ? formatBytes(usage) : 'Unavailable'],
      ['Estimated origin quota', browser.available && estimate.quota != null ? formatBytes(quota) : 'Unavailable'],
      ['Origin quota used', ratio == null ? 'Unavailable' : `${(ratio * 100).toFixed(1)}%`],
      ['Persistent storage', browser.persisted === true ? 'Granted' : (browser.persisted === false ? 'Not granted' : 'Unavailable')]
    ];
    $('browserStorage').innerHTML = rows.map(([label,value]) => `<div class="flex justify-between gap-4 border-b border-zinc-800 py-2 last:border-0"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  async function scan() {
    const startedAt = new Date().toISOString();
    const refresh = $('refreshBtn');
    refresh.disabled = true;
    refresh.textContent = 'Checking…';
    let mirror = null;
    let mirrorError = '';
    const mirrorRaw = localStorage.getItem(STORAGE_KEY);
    try { mirror = parseStoredRaw(mirrorRaw); } catch (error) { mirrorError = String(error?.message || error); }
    const currentCounts = countsFor(mirror?.state);
    const mode = localStorage.getItem(MODE_KEY) || 'off';
    const hold = safeJson(localStorage.getItem(HOLD_KEY), null);
    const guardDiagnostics = safeJson(localStorage.getItem(GUARD_DIAG_KEY), null);
    const phase5bJournal = parseJournalCount(PHASE5B_JOURNAL_KEY);
    const habitJournal = parseJournalCount(HABIT_JOURNAL_KEY);
    const journalMarker = safeJson(localStorage.getItem(JOURNAL_MARKER_KEY), null);
    const backups = rollingBackups();
    const [vaultResult, imageResult, browserResult] = await Promise.allSettled([readSafetyVault(), readImageReport(mirror?.state), readBrowserStorage()]);
    const vault = vaultResult.status === 'fulfilled' ? vaultResult.value : { available:false, slots:[], error:String(vaultResult.reason || '') };
    const images = imageResult.status === 'fulfilled' ? imageResult.value : { available:false, count:0, referencedCount:0, missingReferences:[], unreferenced:[], error:String(imageResult.reason || '') };
    const browser = browserResult.status === 'fulfilled' ? browserResult.value : { available:false, persisted:null, estimate:null, error:String(browserResult.reason || '') };

    const latest = vault.slots?.find((slot) => slot.id === 'latest') || vault.slots?.[0] || null;
    const latestCounts = latest?.counts || {};
    const vaultRatio = currentCounts.majorTotal ? Number(latestCounts.majorTotal || 0) / currentCounts.majorTotal : 0;
    const browserUsage = Number(browser.estimate?.usage || 0);
    const browserQuota = Number(browser.estimate?.quota || 0);
    const browserRatio = browserQuota > 0 ? browserUsage / browserQuota : null;
    const checks = [];
    checks.push(mirror && currentCounts.majorTotal > 0
      ? check('good','Current save is readable',`${currentCounts.majorTotal.toLocaleString()} major records were decoded from the active mirror.`)
      : check('bad','Current save is not healthy',mirrorError || 'The active mirror is missing or contains no major records.'));
    checks.push(mode === 'off'
      ? check('good','IndexedDB Primary is Off','The stabilized localStorage path remains authoritative.')
      : check('bad','IndexedDB Primary is not Off',`Configured mode is ${mode}. Keep it Off during stabilization.`));
    checks.push(guardDiagnostics?.enabled === true && guardDiagnostics?.phase5bLiveBundleDisabled === true
      ? check('good','Data-loss protection is active','The catastrophic-overwrite guard is installed and Phase 5B is disabled.')
      : check('bad','Protection is not confirmed','Open the normal TaskPoints app once after the safety deployment, then scan again.'));
    checks.push(!phase5bJournal.present
      ? check('good','No legacy Phase 5B journal remains','There are no unreconciled deferred-save operations.')
      : check('warn','Legacy Phase 5B journal is present',`${phase5bJournal.count} operation(s) remain and should be reviewed before migration continues.`));
    checks.push(vault.available && latest && Number(latestCounts.majorTotal || 0) > 0
      ? check(vaultRatio >= .8 ? 'good' : 'warn','Safety vault is populated',`${vault.slots.length} slot(s) exist; latest contains ${Number(latestCounts.majorTotal || 0).toLocaleString()} major records.`)
      : check('bad','Safety vault is not populated','No known-good independent snapshot was found.'));
    if (!images.available) {
      checks.push(check('warn','Player image integrity is unavailable',images.error || 'The image database could not be read.'));
    } else if (images.missingReferences.length) {
      checks.push(check('bad','Referenced player images are missing',`${images.missingReferences.length.toLocaleString()} referenced image blob(s) were not found.`));
    } else {
      checks.push(check('good','Referenced player images are intact',`${images.referencedCount.toLocaleString()} referenced image ID(s) are present; ${images.unreferenced.length.toLocaleString()} unreferenced blob(s) are preserved.`));
    }
    if (Number(guardDiagnostics?.blockedWritesTotal || 0) > 0) {
      checks.push(check('warn','The guard has blocked a destructive write',`${Number(guardDiagnostics.blockedWritesTotal).toLocaleString()} write(s) were blocked; the previous save was preserved.`));
    }
    if (browserRatio != null && browserRatio >= .8) checks.push(check('warn','Browser-origin storage is running high',`${(browserRatio * 100).toFixed(1)}% of the estimated origin quota is in use.`));
    else if (browser.persisted === false) checks.push(check('warn','Persistent browser storage is not granted','Continue keeping full exports because iOS may evict website data under storage pressure.'));
    else checks.push(check('good','No browser-origin quota warning detected',browserRatio == null ? 'The browser did not expose an origin quota estimate.' : `${(browserRatio * 100).toFixed(1)}% of the estimated origin quota is used.`));

    const badCount = checks.filter((item) => item.level === 'bad').length;
    const warningCount = checks.filter((item) => item.level === 'warn').length;
    $('overallLabel').textContent = badCount ? 'Needs attention' : (warningCount ? 'Protected with warnings' : 'Storage looks healthy');
    $('overallDetail').textContent = badCount ? `${badCount} critical check(s) failed.` : `${checks.filter((item) => item.level === 'good').length} checks passed${warningCount ? ` with ${warningCount} warning(s)` : ''}.`;
    $('summaryCards').innerHTML = [
      ['Major records',currentCounts.majorTotal.toLocaleString()],
      ['Player images',images.available ? images.count.toLocaleString() : '—'],
      ['Vault slots',`${vault.slots?.length || 0} / 4`],
      ['Blocked writes',Number(guardDiagnostics?.blockedWritesTotal || 0).toLocaleString()]
    ].map(([label,value]) => `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`).join('');
    $('mirrorEncoding').textContent = mirror?.encoding || 'Unreadable';
    $('mirrorEncoding').className = mirror ? 'pill good-pill' : 'pill bad-pill';
    renderCounts($('currentCounts'), currentCounts);
    renderChecks(checks);
    renderVault(vault, currentCounts);
    renderProtection({ mode, hold, guardDiagnostics, phase5bJournal, habitJournal, journalMarker, rollingBackups: backups });
    renderBrowserStorage(browser);

    const report = {
      scannedAtISO: startedAt,
      readOnly: true,
      currentMirror: { readable: Boolean(mirror), error: mirrorError, encoding: mirror?.encoding || '', rawChars: mirrorRaw?.length || 0, rawHash: rawHash(mirrorRaw), counts: currentCounts },
      storageMode: mode,
      recoveryHold: hold,
      guardDiagnostics,
      phase5bJournal,
      habitJournal,
      journalReconciliationMarker: journalMarker,
      rollingBackups: backups,
      safetyVault: { available: vault.available, error: vault.error || '', slots: (vault.slots || []).map((slot) => ({ id:slot.id, createdAtISO:slot.createdAtISO || slot.updatedAtISO || '', reason:slot.reason || '', rawHash:slot.rawHash || '', counts:slot.counts || null })) },
      images,
      browserStorage: browser,
      checks
    };
    $('technicalReport').textContent = JSON.stringify(report, null, 2);
    refresh.disabled = false;
    refresh.textContent = 'Refresh';
  }

  $('refreshBtn').addEventListener('click', () => { scan().catch((error) => { $('overallLabel').textContent = 'Scan failed'; $('overallDetail').textContent = String(error?.message || error); $('refreshBtn').disabled = false; $('refreshBtn').textContent = 'Refresh'; }); });
  scan().catch((error) => { $('overallLabel').textContent = 'Scan failed'; $('overallDetail').textContent = String(error?.message || error); $('refreshBtn').disabled = false; $('refreshBtn').textContent = 'Refresh'; });
})(typeof window !== 'undefined' ? window : globalThis);
