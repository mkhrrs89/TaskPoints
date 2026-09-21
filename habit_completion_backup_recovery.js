(function installHabitCompletionBackupRecovery(global) {
  'use strict';
  if (global.TaskPointsHabitCompletionBackupRecovery) return;

  const core = global.TaskPointsCore || {};
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const ROLLING_KEYS = ['taskpoints_backup_latest','taskpoints_backup_prev1','taskpoints_backup_prev2','taskpoints_backup_prev3'];
  const VAULT_SLOTS = ['latest','prev1','prev2','prev3'];

  const clone = (value) => typeof global.structuredClone === 'function' ? global.structuredClone(value) : JSON.parse(JSON.stringify(value));
  const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const habitIdFor = (row) => String(row?.habitId || row?.viceId || '').trim();
  const expectedSource = (habit) => habit?.category === 'vice' ? 'vice' : 'habit';
  const habitLabel = (habit) => String(habit?.name || habit?.title || habit?.label || habit?.id || 'Unknown habit');

  function dayFor(row) {
    if (validDay(row?.dayKey)) return row.dayKey;
    if (validDay(row?.dateKey)) return row.dateKey;
    const raw = row?.completedAtISO || row?.createdAtISO;
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    try {
      const shared = core.dateKey?.(date);
      if (validDay(shared)) return shared;
    } catch (_) {}
    return date.toISOString().slice(0, 10);
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    Object.keys(value).sort().forEach((key) => { out[key] = stable(value[key]); });
    return out;
  }

  function fnv(textInput) {
    const text = String(textInput || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
  }

  const rowFingerprint = (row) => fnv(JSON.stringify(stable(row || {})));

  function parseRaw(raw) {
    if (!raw) return null;
    try {
      const state = typeof core.parseTaskPointsStorageJson === 'function' ? core.parseTaskPointsStorageJson(String(raw), null) : JSON.parse(String(raw));
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
    } catch (_) { return null; }
  }

  function readCurrent() {
    try {
      if (typeof core.readTaskPointsStoredState === 'function') return core.readTaskPointsStoredState(STORAGE_KEY, null);
      return parseRaw(global.localStorage?.getItem?.(STORAGE_KEY));
    } catch (_) { return null; }
  }

  function currentKeys(state) {
    const set = new Set();
    (Array.isArray(state?.completions) ? state.completions : []).forEach((row) => {
      if (!row || !['habit','vice'].includes(row.source)) return;
      const habitId = habitIdFor(row);
      const dayKey = dayFor(row);
      if (habitId && validDay(dayKey)) set.add(habitId + '|' + dayKey);
    });
    return set;
  }

  function buildMissingTargets(state) {
    const completionKeys = currentKeys(state || {});
    const targets = [];
    (Array.isArray(state?.habits) ? state.habits : []).forEach((habit) => {
      const habitId = String(habit?.id || '').trim();
      if (!habitId) return;
      const failed = new Set(Array.isArray(habit.failedKeys) ? habit.failedKeys : []);
      const seen = new Set();
      (Array.isArray(habit.doneKeys) ? habit.doneKeys : []).forEach((dayKey) => {
        if (!validDay(dayKey) || seen.has(dayKey)) return;
        seen.add(dayKey);
        const key = habitId + '|' + dayKey;
        if (completionKeys.has(key)) return;
        targets.push({ key, habitId, habitName: habitLabel(habit), dayKey, expectedSource: expectedSource(habit), failed: failed.has(dayKey) });
      });
    });
    return targets.sort((a,b) => a.dayKey.localeCompare(b.dayKey) || a.habitName.localeCompare(b.habitName));
  }

  function liveFingerprint(state) {
    const habits = (state?.habits || []).map((h) => ({ id:h?.id, category:h?.category, doneKeys:h?.doneKeys, failedKeys:h?.failedKeys, iceKeys:h?.iceKeys }));
    const completions = (state?.completions || []).map((c) => ({ id:c?.id, source:c?.source, habitId:c?.habitId, viceId:c?.viceId, dayKey:c?.dayKey, dateKey:c?.dateKey, completedAtISO:c?.completedAtISO, createdAtISO:c?.createdAtISO, points:c?.points, completionFraction:c?.completionFraction }));
    return fnv(JSON.stringify(stable({ habits, completions })));
  }

  function validateRow(row, target, currentIds) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'Backup row is malformed.';
    const id = String(row.id || '').trim();
    if (!id) return 'Backup row has no completion ID.';
    if (row.source !== target.expectedSource) return 'Backup row has the wrong habit/vice source.';
    if (habitIdFor(row) !== target.habitId || dayFor(row) !== target.dayKey) return 'Backup row does not exactly match the habit/date.';
    if (!row.completedAtISO) return 'Backup row has no completedAtISO, so it would not contribute to historical scoring.';
    const completedAt = new Date(row.completedAtISO);
    if (Number.isNaN(completedAt.getTime())) return 'Backup row has an invalid completedAtISO.';
    let scoredDay = '';
    try { scoredDay = typeof core.dateKey === 'function' ? core.dateKey(completedAt) : completedAt.toISOString().slice(0, 10); }
    catch (_) { scoredDay = ''; }
    if (scoredDay !== target.dayKey) return 'Backup row completedAtISO would score on a different day.';
    if (!Number.isFinite(Number(row.points))) return 'Backup row has no finite stored point value.';
    const fraction = row.completionFraction == null ? 1 : Number(row.completionFraction);
    if (fraction !== 0.5 && fraction !== 1) return 'Backup row has an invalid completionFraction.';
    if (currentIds.has(id)) return 'Its completion ID is already used by a current row.';
    return '';
  }

  function buildRecoveryPlan(currentState, candidatesInput) {
    const state = currentState || {};
    const candidates = Array.isArray(candidatesInput) ? candidatesInput : [];
    const targets = buildMissingTargets(state);
    const currentIds = new Set((state.completions || []).map((row) => String(row?.id || '').trim()).filter(Boolean));
    const recoverable = [], conflicts = [], notFound = [];

    targets.forEach((target) => {
      if (target.failed) {
        conflicts.push({ ...target, reason:'Date is also marked failed; automatic recovery is blocked.' });
        return;
      }
      const evidence = [];
      let sourceDuplicate = false;
      candidates.forEach((candidate) => {
        const rows = (candidate?.state?.completions || []).filter((row) => ['habit','vice'].includes(row?.source) && habitIdFor(row) === target.habitId && dayFor(row) === target.dayKey);
        if (rows.length > 1) sourceDuplicate = true;
        rows.forEach((row) => evidence.push({ row:clone(row), fingerprint:rowFingerprint(row), label:candidate.label || candidate.id || 'Backup', error:validateRow(row,target,currentIds) }));
      });
      if (!evidence.length) {
        notFound.push({ ...target, reason:'No exact completion row was found in the scanned backups.' });
        return;
      }
      if (sourceDuplicate) {
        conflicts.push({ ...target, reason:'A backup contains multiple rows for this same habit/date.' });
        return;
      }
      const valid = evidence.filter((item) => !item.error);
      if (!valid.length) {
        conflicts.push({ ...target, reason:evidence[0].error || 'Backup evidence is not safe to restore.' });
        return;
      }
      const groups = new Map();
      valid.forEach((item) => {
        if (!groups.has(item.fingerprint)) groups.set(item.fingerprint, []);
        groups.get(item.fingerprint).push(item);
      });
      if (groups.size !== 1) {
        conflicts.push({ ...target, reason:'Different exact backup-row versions disagree for this habit/date.' });
        return;
      }
      const agreed = [...groups.values()][0];
      const chosen = agreed[0];
      recoverable.push({ ...target, row:clone(chosen.row), rowFingerprint:chosen.fingerprint, completionId:String(chosen.row.id), points:Number(chosen.row.points), sourceLabels:agreed.map((x) => x.label) });
    });

    return { liveFingerprint:liveFingerprint(state), missingCount:targets.length, sourceCount:candidates.length, recoverable, conflicts, notFound };
  }

  function applyRecoveryPlan(currentState, plan) {
    if (!plan || !Array.isArray(plan.recoverable)) throw new Error('Run the backup scan first.');
    if (liveFingerprint(currentState) !== plan.liveFingerprint) throw new Error('Habit/completion data changed after the scan. Scan again.');
    const state = clone(currentState || {});
    state.completions = Array.isArray(state.completions) ? state.completions.slice() : [];
    const keys = currentKeys(state);
    const ids = new Set(state.completions.map((row) => String(row?.id || '').trim()).filter(Boolean));
    const habits = new Map((state.habits || []).map((habit) => [String(habit?.id || ''), habit]));
    let added = 0;

    plan.recoverable.forEach((item) => {
      const habit = habits.get(item.habitId);
      if (!habit) throw new Error(item.habitName + ' no longer exists.');
      const done = new Set(Array.isArray(habit.doneKeys) ? habit.doneKeys : []);
      const failed = new Set(Array.isArray(habit.failedKeys) ? habit.failedKeys : []);
      if (!done.has(item.dayKey) || failed.has(item.dayKey) || keys.has(item.key) || ids.has(item.completionId)) throw new Error(item.habitName + ' ' + item.dayKey + ' changed after preview.');
      const error = validateRow(item.row, { habitId:item.habitId, dayKey:item.dayKey, expectedSource:expectedSource(habit) }, ids);
      if (error || rowFingerprint(item.row) !== item.rowFingerprint) throw new Error(item.habitName + ' ' + item.dayKey + ': ' + (error || 'backup row changed after preview.'));
      state.completions.push(clone(item.row));
      keys.add(item.key); ids.add(item.completionId); added += 1;
    });
    return { state, added };
  }

  const requestResult = (request) => new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error || new Error('IndexedDB request failed.')); });
  const transactionDone = (tx) => new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error || new Error('IndexedDB transaction aborted.')); tx.onerror=()=>undefined; });

  async function openExistingDatabase(name) {
    if (!global.indexedDB) return null;
    if (typeof global.indexedDB.databases === 'function') {
      try { if (!(await global.indexedDB.databases()).some((row) => row?.name === name)) return null; } catch (_) {}
    }
    return new Promise((resolve,reject) => {
      const request = global.indexedDB.open(name); let created = false;
      request.onupgradeneeded = () => { created = true; try { request.transaction?.abort(); } catch (_) {} };
      request.onsuccess = () => { if (created) { request.result?.close?.(); resolve(null); } else resolve(request.result); };
      request.onerror = () => created || request.error?.name === 'AbortError' ? resolve(null) : reject(request.error || new Error('Could not open ' + name + '.'));
      request.onblocked = () => reject(new Error(name + ' is blocked by another TaskPoints tab.'));
    });
  }

  async function collectBackupCandidates() {
    const candidates = [], errors = [];
    ROLLING_KEYS.forEach((key,index) => {
      try {
        const record = JSON.parse(global.localStorage?.getItem?.(key) || 'null');
        if (record?.state) candidates.push({ id:'rolling-' + index, label:index === 0 ? 'Rolling backup — latest' : 'Rolling backup — previous ' + index, state:record.state });
      } catch (error) { errors.push(key + ': ' + (error?.message || error)); }
    });

    try {
      const db = await openExistingDatabase('taskpoints_safety_vault_v1');
      if (db) {
        try {
          if (db.objectStoreNames.contains('snapshots')) {
            const tx = db.transaction('snapshots','readonly'); const done = transactionDone(tx); const store = tx.objectStore('snapshots');
            const rows = await Promise.all(VAULT_SLOTS.map((id) => requestResult(store.get(id)))); await done;
            rows.filter(Boolean).forEach((record,index) => {
              if (!record.raw) return;
              if (record.rawHash && record.rawHash !== fnv(record.raw)) { errors.push('Safety vault ' + (record.id || VAULT_SLOTS[index]) + ': hash mismatch.'); return; }
              const state = parseRaw(record.raw);
              if (state) candidates.push({ id:'vault-' + (record.id || index), label:'Safety vault — ' + (record.id || VAULT_SLOTS[index]), state });
            });
          }
        } finally { db.close(); }
      }
    } catch (error) { errors.push('Safety vault: ' + (error?.message || error)); }

    try {
      const db = await openExistingDatabase('taskpoints_verified_secondary_v1');
      if (db) {
        try {
          if (db.objectStoreNames.contains('snapshots')) {
            const tx = db.transaction('snapshots','readonly'); const done = transactionDone(tx); const store = tx.objectStore('snapshots');
            const rows = await Promise.all([requestResult(store.get('latest')), requestResult(store.get('home_native_latest'))]); await done;
            const latest = rows[0], native = rows[1];
            if (latest?.status === 'passed_verification' && latest.raw && (!latest.rawHash || latest.rawHash === fnv(latest.raw))) {
              const state = parseRaw(latest.raw); if (state) candidates.push({ id:'secondary-latest', label:'Verified secondary — latest', state });
            }
            if (native?.status === 'passed_verification' && native?.state) candidates.push({ id:'secondary-native', label:'Verified secondary — native latest', state:native.state });
          }
        } finally { db.close(); }
      }
    } catch (error) { errors.push('Verified secondary: ' + (error?.message || error)); }
    return { candidates, errors };
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
  function renderRows(items, formatter) {
    if (!items.length) return '<div class="muted text-sm mt-1">None.</div>';
    const shown = items.slice(0,12).map((item)=>'<li>' + formatter(item) + '</li>').join('');
    const more = items.length > 12 ? '<li class="muted">… ' + (items.length - 12) + ' more</li>' : '';
    return '<ul class="text-sm space-y-1 mt-2" style="padding-left:1.25rem;list-style:disc">' + shown + more + '</ul>';
  }

  function installPanel() {
    const parent = global.document?.getElementById('habitLedgerRepairPanel');
    if (!parent || global.document.getElementById('habitCompletionBackupRecovery')) return false;
    const backupCheckbox = parent.querySelector('#habitLedgerBackupConfirmed');
    if (!backupCheckbox) return false;
    const section = global.document.createElement('div');
    section.id = 'habitCompletionBackupRecovery'; section.className = 'border-t border-zinc-700/60 pt-4 space-y-3';
    section.innerHTML = [
      '<div class="font-semibold">Recover missing Habit completion rows from backups</div>',
      '<p class="muted text-sm">Scans rolling backups, Safety Vault snapshots, and the verified secondary mirror for the exact original row behind each doneKey that has no completion row. Historical points are never recalculated from the Habit\'s current value.</p>',
      '<div class="flex flex-wrap gap-2"><button id="scanHabitCompletionBackupsBtn" type="button" class="btn btn-primary">Scan Backups for Missing Rows</button><button id="restoreHabitCompletionBackupsBtn" type="button" class="btn btn-ghost" disabled>Restore Exact Recovered Rows</button></div>',
      '<div id="habitCompletionBackupRecoveryStatus" class="muted text-sm">Run the backup scan first. The scan is read-only.</div>',
      '<div id="habitCompletionBackupRecoverySummary" class="text-sm"></div>',
      '<div id="habitCompletionRecoverableCount" class="font-semibold">Exact rows recoverable: 0</div><div id="habitCompletionRecoverableRows"></div>',
      '<div id="habitCompletionConflictCount" class="font-semibold">Backup conflicts / blocked rows: 0</div><div id="habitCompletionConflictRows"></div>',
      '<div id="habitCompletionNotFoundCount" class="font-semibold">Not found in backups: 0</div><div id="habitCompletionNotFoundRows"></div>'
    ].join('');
    parent.appendChild(section);
    const scan = section.querySelector('#scanHabitCompletionBackupsBtn');
    const restore = section.querySelector('#restoreHabitCompletionBackupsBtn');
    const status = section.querySelector('#habitCompletionBackupRecoveryStatus');
    let plan = null;
    const enabled = () => { restore.disabled = !(plan?.recoverable?.length && backupCheckbox.checked); };

    scan.addEventListener('click', async () => {
      plan = null; backupCheckbox.checked = false; enabled(); scan.disabled = true; status.textContent = 'Scanning rolling and verified backups…';
      try {
        const state = readCurrent(); if (!state) throw new Error('No TaskPoints state was found.');
        const found = await collectBackupCandidates(); plan = buildRecoveryPlan(state, found.candidates);
        section.querySelector('#habitCompletionBackupRecoverySummary').innerHTML = 'Missing doneKeys scanned: <strong>' + plan.missingCount + '</strong><br>Readable backup sources scanned: <strong>' + plan.sourceCount + '</strong>' + (found.errors.length ? '<br>Backup read warning(s): <strong>' + found.errors.length + '</strong>' : '');
        section.querySelector('#habitCompletionRecoverableCount').textContent = 'Exact rows recoverable: ' + plan.recoverable.length;
        section.querySelector('#habitCompletionConflictCount').textContent = 'Backup conflicts / blocked rows: ' + plan.conflicts.length;
        section.querySelector('#habitCompletionNotFoundCount').textContent = 'Not found in backups: ' + plan.notFound.length;
        section.querySelector('#habitCompletionRecoverableRows').innerHTML = renderRows(plan.recoverable,(item)=>escapeHtml(item.habitName) + ' on ' + escapeHtml(item.dayKey) + ': restore ' + escapeHtml(item.points) + ' point(s), ID ' + escapeHtml(item.completionId) + ', from ' + escapeHtml(item.sourceLabels.join(', ')));
        section.querySelector('#habitCompletionConflictRows').innerHTML = renderRows(plan.conflicts,(item)=>escapeHtml(item.habitName) + ' on ' + escapeHtml(item.dayKey) + ': ' + escapeHtml(item.reason));
        section.querySelector('#habitCompletionNotFoundRows').innerHTML = renderRows(plan.notFound,(item)=>escapeHtml(item.habitName) + ' on ' + escapeHtml(item.dayKey));
        status.textContent = plan.recoverable.length ? 'Scan complete: ' + plan.recoverable.length + ' exact original row(s) can be restored without guessing points. Confirm the fresh-backup checkbox above to enable restore.' : 'Scan complete, but none of the missing rows can be restored exactly from these backups.';
        if (found.errors.length) status.textContent += ' ' + found.errors.length + ' backup source(s) also reported a read/verification warning.';
      } catch (error) { status.textContent = 'Backup scan failed: ' + (error?.message || error); }
      finally { scan.disabled = false; enabled(); }
    });

    backupCheckbox.addEventListener('change', enabled);
    restore.addEventListener('click', () => {
      if (!plan?.recoverable?.length || !backupCheckbox.checked) return;
      restore.disabled = true;
      try {
        const live = readCurrent(); if (!live) throw new Error('No TaskPoints state was found.');
        const beforeCount = Array.isArray(live.completions) ? live.completions.length : 0;
        const result = applyRecoveryPlan(live, plan);
        const saved = core.saveStateSnapshot?.(result.state,{ savePath:'audit-habit-completion-backup-recovery', source:'audit-habit-completion-backup-recovery', userInitiated:true, interactive:true, immediateWrite:true, replaceCompletions:true, allowDestructiveOverwrite:true });
        if (!saved?.state || saved?.blocked || saved?.ok === false || saved?.skipped) throw new Error(saved?.reason || saved?.error || 'The recovered rows could not be saved.');
        const persisted = readCurrent(); if (!persisted || !Array.isArray(persisted.completions)) throw new Error('The saved completion ledger could not be verified.');
        if (persisted.completions.length !== beforeCount + result.added) throw new Error('Completion count verification failed after recovery.');
        plan.recoverable.forEach((item) => {
          const matches = persisted.completions.filter((row)=>String(row?.id || '') === item.completionId);
          if (matches.length !== 1 || rowFingerprint(matches[0]) !== item.rowFingerprint) throw new Error(item.habitName + ' ' + item.dayKey + ' did not persist as the exact backup row.');
        });
        status.textContent = 'Recovered and verified ' + result.added + ' exact historical completion row(s). ' + buildMissingTargets(persisted).length + ' missing-row warning(s) remain. Re-run the audit to refresh the count.';
        backupCheckbox.checked = false; plan = null;
      } catch (error) { status.textContent = 'Recovery stopped without guessing historical points: ' + (error?.message || error); }
      finally { enabled(); }
    });
    return true;
  }

  const api = { buildMissingTargets, buildRecoveryPlan, applyRecoveryPlan, collectBackupCandidates, liveFingerprint, rowFingerprint };
  global.TaskPointsHabitCompletionBackupRecovery = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global.document) {
    let tries = 0;
    const install = () => { if (installPanel()) return; tries += 1; if (tries < 40) global.setTimeout?.(install,50); };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded',install,{once:true}); else install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
