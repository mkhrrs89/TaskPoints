;(function installTaskPointsGoldSeasonInterest(global) {
  'use strict';

  const STORAGE_KEY = 'taskpoints_v1';
  const RECOVERY_HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const FIRST_SEASON = '2027-01-01';
  const RATE_MAX = 100;
  const DECISION_KEY = 'seasonInterestDecisions';
  let activePrompt = null;
  let pendingCommit = false;

  function roundOne(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }
  function localDateKey(now = new Date()) {
    return String(now.getFullYear()).padStart(4, '0') + '-'
      + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0');
  }

  // The first interest-eligible season is 2027-01-01. Thereafter seasons
  // begin on the first of Jan, Mar, May, Jul, Sep and Nov (local time).
  function seasonStartOn(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime()) || d.getDate() !== 1 || d.getMonth() % 2 !== 0) return null;
    const key = localDateKey(d);
    return key >= FIRST_SEASON ? key : null;
  }

  function nextSeasonStart(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return FIRST_SEASON;
    const year = d.getFullYear();
    const month = d.getMonth();
    const candidate = month % 2 === 0
      ? new Date(year, month, 1)
      : new Date(year, month + 1, 1);
    if (localDateKey(candidate) <= localDateKey(d)) candidate.setMonth(candidate.getMonth() + 2);
    return localDateKey(candidate) < FIRST_SEASON ? FIRST_SEASON : localDateKey(candidate);
  }

  function readRate(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      throw new Error('Enter a rate from 0% to 100%, with up to two decimal places.');
    }
    const rate = Number(text);
    if (!Number.isFinite(rate) || rate < 0 || rate > RATE_MAX) {
      throw new Error('The Gold interest rate must be between 0% and 100%.');
    }
    return rate;
  }

  function existingDecision(economy, key) {
    return Array.isArray(economy?.[DECISION_KEY])
      ? economy[DECISION_KEY].find(row => String(row?.seasonStartDateKey || '') === key) || null
      : null;
  }

  function recoveryHoldActive(storage) {
    const raw = storage.getItem(RECOVERY_HOLD_KEY);
    if (!raw) return false;
    try { return JSON.parse(raw)?.active === true; }
    catch (_) { return true; }
  }

  function readLatest() {
    const core = global.TaskPointsCore;
    const storage = global.localStorage;
    if (!core || typeof core.loadAppState !== 'function'
      || typeof core.saveValidatedSnapshot !== 'function'
      || typeof core.parseTaskPointsStorageJson !== 'function') {
      throw new Error('Protected Gold storage is unavailable.');
    }
    if (!storage || recoveryHoldActive(storage)) {
      throw new Error('Emergency Recovery is active or saved data is unavailable. Interest was not changed.');
    }
    if (!storage.getItem(STORAGE_KEY)) throw new Error('No authoritative TaskPoints data was found.');
    const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    const state = loaded?.state || loaded;
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || !state || Number(state.goldEconomy?.version) !== 1
      || !Array.isArray(state.goldLedger) || !Array.isArray(state.players)) {
      throw new Error('The verified Gold economy is not ready. No interest was changed.');
    }
    return { core, storage, state, raw };
  }

  function balanceMap(state) {
    const balances = new Map([['YOU', 0]]);
    for (const player of state.players) {
      const id = String(player?.id || player?.playerId || '').trim();
      if (id && !balances.has(id)) balances.set(id, 0);
    }
    for (const entry of state.goldLedger) {
      const id = String(entry?.playerId || '').trim();
      const amount = Number(entry?.amount);
      if (!id || entry?.amount == null || entry.amount === ''
        || !Number.isFinite(amount) || Math.abs(amount * 10 - Math.round(amount * 10)) > 0.00001) {
        throw new Error('Gold history contains an invalid transaction. Review the ledger before applying interest.');
      }
      const current = (balances.get(id) || 0) + Math.round(amount * 10);
      if (!Number.isSafeInteger(current) || current < 0) {
        throw new Error('A Gold wallet has an invalid balance. Interest was not applied.');
      }
      balances.set(id, current);
    }
    return balances;
  }

  function plan(state, seasonStartDateKey) {
    if (!state || Number(state.goldEconomy?.version) !== 1 || !Array.isArray(state.goldLedger)) {
      throw new Error('Gold Ledger is not initialized.');
    }
    if (!/^\d{4}-\d{2}-01$/.test(seasonStartDateKey)
      || seasonStartOn(new Date(Number(seasonStartDateKey.slice(0, 4)),
        Number(seasonStartDateKey.slice(5, 7)) - 1, 1)) !== seasonStartDateKey) {
      throw new Error('Invalid two-month season start date.');
    }
    if (existingDecision(state.goldEconomy, seasonStartDateKey)) {
      throw new Error('Interest has already been decided for this season.');
    }
    const rate = readRate(String(state.goldEconomy.interestRatePercent ?? 0));
    const wallets = balanceMap(state);
    const awards = [];
    let totalTenths = 0;
    for (const [playerId, beforeTenths] of wallets) {
      if (beforeTenths <= 0) continue;
      const interestTenths = Math.round(beforeTenths * rate / 100);
      if (!interestTenths) continue; // Gold is tracked in 0.1-unit increments.
      const afterTenths = beforeTenths + interestTenths;
      if (!Number.isSafeInteger(afterTenths)) throw new Error('Interest exceeds the supported Gold range.');
      awards.push({
        playerId,
        before: beforeTenths / 10,
        interest: interestTenths / 10,
        after: afterTenths / 10
      });
      totalTenths += interestTenths;
    }
    if (!Number.isSafeInteger(totalTenths)) throw new Error('Total interest is outside the supported Gold range.');
    return {
      seasonStartDateKey,
      ratePercent: rate,
      awards,
      walletCount: wallets.size,
      recipientCount: awards.length,
      totalInterest: totalTenths / 10,
      totalBefore: [...wallets.values()].reduce((sum, n) => sum + n, 0) / 10
    };
  }

  function preview(seasonKey = seasonStartOn(new Date())) {
    if (!seasonKey) throw new Error('Interest is only offered on a new two-month season start.');
    const latest = readLatest();
    return { ...plan(latest.state, seasonKey), raw: latest.raw };
  }

  function protectedSave(latest, candidate, options) {
    if (latest.storage.getItem(STORAGE_KEY) !== latest.raw) {
      throw new Error('Saved data changed before confirmation. Review the latest Gold and try again.');
    }
    const result = latest.core.saveValidatedSnapshot(candidate, {
      storageKey: STORAGE_KEY,
      immediateWrite: true,
      savePath: options.savePath,
      ...(options.allowGoldInterestRateOverwrite ? { allowGoldInterestRateOverwrite: true } : {})
    });
    if (!result || result.blocked || result.skipped || result.blockedByQuotaCircuit || result.ok === false) {
      throw new Error('The protected save was blocked. No successful change was confirmed.');
    }
    const written = latest.storage.getItem(STORAGE_KEY);
    if (!written) throw new Error('The saved result could not be verified. Do not retry until reviewing the ledger.');
    const saved = latest.core.parseTaskPointsStorageJson(written, null);
    if (!saved || !Array.isArray(saved.goldLedger) || Number(saved.goldEconomy?.version) !== 1) {
      throw new Error('The saved Gold data could not be verified. Do not retry until reviewing the ledger.');
    }
    return saved;
  }

  function saveRate(rawRate) {
    if (pendingCommit) throw new Error('Another Gold change is already being saved.');
    pendingCommit = true;
    try {
      const ratePercent = readRate(rawRate);
      const latest = readLatest();
      if (Number(latest.state.goldEconomy.interestRatePercent ?? 0) === ratePercent) {
        return { ratePercent, unchanged: true };
      }
      const candidate = {
        ...latest.state,
        goldEconomy: { ...latest.state.goldEconomy, interestRatePercent: ratePercent }
      };
      const saved = protectedSave(latest, candidate, {
        savePath: 'gold-season-interest-rate-setting',
        allowGoldInterestRateOverwrite: true
      });
      if (Number(saved.goldEconomy.interestRatePercent) !== ratePercent) {
        throw new Error('Interest rate verification failed. Inspect Settings before trying again.');
      }
      return { ratePercent, unchanged: false };
    } finally { pendingCommit = false; }
  }

  function interestId(seasonKey, playerId) {
    return 'gold:season-interest:' + seasonKey + ':' + encodeURIComponent(playerId);
  }

  function decide(decision, confirmed) {
    if (!['applied', 'skipped'].includes(decision)) throw new Error('Choose Yes or No.');
    if (pendingCommit) throw new Error('A Gold change is already being saved.');
    pendingCommit = true;
    try {
      const dateKey = seasonStartOn(new Date());
      if (!dateKey || dateKey !== confirmed?.seasonStartDateKey) {
        throw new Error('The current date is not the eligible season start.');
      }
      const latest = readLatest();
      if (latest.raw !== confirmed.raw) {
        throw new Error('Gold changed since this offer. Review the updated amounts before confirming.');
      }
      const planned = plan(latest.state, dateKey);
      if (planned.ratePercent !== confirmed.ratePercent
        || planned.totalInterest !== confirmed.totalInterest
        || planned.recipientCount !== confirmed.recipientCount
        || planned.walletCount !== confirmed.walletCount) {
        throw new Error('Interest details changed before confirmation.');
      }
      const ids = new Set(latest.state.goldLedger.map(row => String(row?.id || '')));
      const now = new Date();
      const createdAtISO = now.toISOString();
      const newEntries = decision === 'applied' ? planned.awards.map(award => {
        const id = interestId(dateKey, award.playerId);
        if (ids.has(id)) throw new Error('Interest has already been credited to a wallet. No changes were made.');
        ids.add(id);
        return {
          id,
          type: 'season_interest',
          playerId: award.playerId,
          opponentId: '',
          matchupId: '',
          seasonId: dateKey,
          dateKey,
          createdAtISO,
          amount: award.interest,
          balanceAfter: award.after,
          meta: {
            source: 'confirmed_season_start_interest',
            seasonStartDateKey: dateKey,
            interestRatePercent: planned.ratePercent,
            balanceBefore: award.before
          }
        };
      }) : [];
      const record = {
        seasonStartDateKey: dateKey,
        status: decision,
        interestRatePercent: planned.ratePercent,
        recordedAtISO: createdAtISO,
        recipientCount: decision === 'applied' ? planned.recipientCount : 0,
        goldAdded: decision === 'applied' ? planned.totalInterest : 0
      };
      const candidate = {
        ...latest.state,
        goldLedger: [...latest.state.goldLedger, ...newEntries],
        goldEconomy: {
          ...latest.state.goldEconomy,
          seasonInterestDecisions: [
            ...(Array.isArray(latest.state.goldEconomy.seasonInterestDecisions)
              ? latest.state.goldEconomy.seasonInterestDecisions : []),
            record
          ]
        }
      };
      const saved = protectedSave(latest, candidate, { savePath: 'gold-season-interest-' + decision });
      const savedRecord = existingDecision(saved.goldEconomy, dateKey);
      const savedRows = new Map(saved.goldLedger.map(row => [String(row?.id || ''), row]));
      const originalIntact = latest.state.goldLedger.every(row => savedRows.has(String(row?.id || '')));
      const awardsVerified = newEntries.every(row => {
        const actual = savedRows.get(row.id);
        return actual && Number(actual.amount) === row.amount
          && Number(actual.balanceAfter) === row.balanceAfter
          && saved.goldLedger.filter(other => other?.id === row.id).length === 1;
      });
      if (!savedRecord || savedRecord.status !== decision
        || savedRecord.interestRatePercent !== planned.ratePercent
        || !originalIntact || !awardsVerified) {
        throw new Error('Interest save was not fully verified. Inspect the Gold Ledger before retrying.');
      }
      return { ...record, savedState: saved };
    } finally { pendingCommit = false; }
  }

  function formatGold(value) {
    return Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 1, maximumFractionDigits: 1
    });
  }

  function installSettings() {
    const form = global.document?.getElementById?.('goldInterestRateForm');
    if (!form || form.dataset.installed === '1') return;
    form.dataset.installed = '1';
    const input = global.document.getElementById('goldInterestRateInput');
    const status = global.document.getElementById('goldInterestRateStatus');
    const nextDate = global.document.getElementById('goldInterestNextSeasonDate');
    if (nextDate) nextDate.textContent = nextSeasonStart(new Date());
    try {
      const current = readLatest();
      input.value = String(current.state.goldEconomy.interestRatePercent ?? 0);
      status.textContent = 'Saved rate applies whenever you approve interest at a future season start.';
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      const button = global.document.getElementById('goldInterestRateSaveBtn');
      button.disabled = true;
      try {
        const saved = saveRate(input.value);
        status.textContent = saved.unchanged
          ? 'Interest rate is already set to ' + saved.ratePercent + '%.'
          : 'Saved ' + saved.ratePercent + '% Gold interest for upcoming seasons.';
      } catch (error) {
        status.textContent = error?.message || 'Interest rate was not saved.';
      } finally { button.disabled = false; }
    });
  }

  function showOffer(planned, resolve) {
    const doc = global.document;
    const backdrop = doc.createElement('div');
    backdrop.id = 'tpSeasonInterestModal';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;';
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'tpSeasonInterestTitle');
    dialog.style.cssText = 'max-width:430px;width:100%;padding:22px;border:1px solid #fb923c;border-radius:18px;background:#181c26;color:#f8fafc;box-shadow:0 22px 65px #000b;font:15px/1.55 system-ui,sans-serif;';
    const title = doc.createElement('h2');
    title.id = 'tpSeasonInterestTitle';
    title.textContent = 'New Season — Gold Interest';
    title.style.cssText = 'font-size:20px;font-weight:800;margin:0 0 12px;color:#fb923c;';
    const summary = doc.createElement('p');
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.style.cssText = 'min-height:18px;color:#fca5a5;margin:12px 0;';
    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;';
    const yes = doc.createElement('button');
    const no = doc.createElement('button');
    for (const button of [yes, no]) {
      button.type = 'button';
      button.style.cssText = 'border-radius:10px;min-height:44px;padding:10px 14px;border:1px solid #64748b;background:#253042;color:#f8fafc;font-weight:700;cursor:pointer;flex:1;min-width:145px;';
    }
    yes.textContent = 'Yes, Apply Interest';
    yes.style.background = '#0c706d';
    no.textContent = 'No, Skip This Season';
    const explain = () => {
      summary.textContent = 'The ' + planned.seasonStartDateKey + ' season has begun. '
        + 'Apply ' + planned.ratePercent + '% interest to all ' + planned.walletCount
        + ' player wallets (including yours and inactive players)? '
        + 'This would add ' + formatGold(planned.totalInterest) + ' Gold across '
        + planned.recipientCount + ' wallets. '
        + 'Interest rounds to the nearest 0.1 Gold per player. '
        + 'No will skip interest for this season. You can only decide once per season.';
    };
    explain();
    actions.append(yes, no);
    dialog.append(title, summary, status, actions);
    backdrop.appendChild(dialog);
    doc.body.appendChild(backdrop);
    yes.focus?.();

    function handle(choice) {
      if (pendingCommit) return;
      yes.disabled = true;
      no.disabled = true;
      status.textContent = '';
      try {
        const outcome = decide(choice, planned);
        backdrop.remove();
        try {
          global.dispatchEvent?.(new CustomEvent('taskpoints:season-gold-interest-recorded', {
            detail: { seasonStartDateKey: outcome.seasonStartDateKey, status: outcome.status }
          }));
        } catch (_) {}
        resolve(outcome);
      } catch (error) {
        const message = error?.message || String(error);
        // A stale preview must be reconfirmed against current authoritative
        // bytes. Do not silently apply an outdated rate or Gold balance.
        try { planned = preview(planned.seasonStartDateKey); explain(); }
        catch (_) {}
        status.textContent = message;
        yes.disabled = false;
        no.disabled = false;
      }
    }
    yes.addEventListener('click', () => handle('applied'));
    no.addEventListener('click', () => handle('skipped'));
  }

  function ensureSeasonDecision() {
    const key = seasonStartOn(new Date());
    if (!key) return Promise.resolve({ status: 'not-due' });
    if (activePrompt) return activePrompt;
    activePrompt = new Promise(resolve => {
      const waitForHome = () => {
        if (!global.document?.body) { global.setTimeout(waitForHome, 250); return; }
        const coordinator = global.__tpMobileBootCoordinator;
        if ((coordinator && !coordinator.isRevealed()) || global.document.hidden) {
          global.setTimeout(waitForHome, 250);
          return;
        }
        try {
          const current = readLatest();
          const existing = existingDecision(current.state.goldEconomy, key);
          if (existing) { resolve(existing); return; }
          showOffer({ ...plan(current.state, key), raw: current.raw }, resolve);
        } catch (error) {
          // Refuse to apply interest if storage/recovery is unavailable.
          // Daily game simulation must not proceed using an unverified season
          // opening balance; Settings/Recovery remain accessible.
          console.error('TaskPoints seasonal Gold interest is unavailable:', error);
          resolve({ status: 'unavailable', error: String(error?.message || error) });
        }
      };
      waitForHome();
    });
    return activePrompt;
  }

  const api = {
    FIRST_SEASON, seasonStartOn, nextSeasonStart,
    readRate, plan, preview, saveRate, decide, ensureSeasonDecision,
    existingDecision, readLatest, balanceMap, interestId
  };
  global.TaskPointsGoldSeasonInterest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function install() {
    installSettings();
    const pathname = String(global.location?.pathname || '');
    if (global.document?.body && typeof global.setTimeout === 'function'
      && (pathname === '/' || pathname === '/index.html' || pathname === '')) {
      if (seasonStartOn(new Date())) global.setTimeout(() => ensureSeasonDecision(), 0);
    }
  }
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', install, { once: true });
  } else install();
})(typeof window !== 'undefined' ? window : globalThis);
