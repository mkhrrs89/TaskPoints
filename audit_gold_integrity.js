;(function installTaskPointsAuditGoldIntegrity(global) {
  'use strict';

  // Pure, read-only checks. No Gold recalculation or historical recovery.
  // Pre-launch transactions belong to the legacy economy and cannot be
  // reconstructed from goldOutcome without double-counting opening balances.
  const EPS = 0.11;
  const LIMIT = 60;
  const round = value => Math.round((value + Number.EPSILON) * 10) / 10;
  const asId = value => String(value == null ? '' : value).trim();
  const entries = value => Array.isArray(value) ? value : [];
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  const day = row => {
    for (const value of [row?.dateKey, row?.date, row?.completedAtISO, row?.finalizedAtISO,
      row?.recordedAtISO, row?.createdAtISO]) {
      const candidate = asId(value).slice(0, 10);
      if (validDate(candidate)) return candidate;
    }
    return '';
  };
  const issue = (list, message) => {
    if (list.length < LIMIT) list.push(message);
  };
  const make = (id, title, status, expected, actual, details, trace, tips) => ({
    id, title, section: 'Gold Integrity', status, expected, actual,
    details, trace, ...(tips ? { tips } : {})
  });

  function buildGoldIntegrityChecks(inputState, options = {}) {
    const state = inputState && typeof inputState === 'object' ? inputState : {};
    const ledger = entries(state.goldLedger);
    const economy = state.goldEconomy && typeof state.goldEconomy === 'object' ? state.goldEconomy : null;
    const launch = asId(economy?.launchDateKey).slice(0, 10);
    const hasEconomy = Number(economy?.version) === 1 && validDate(launch);
    const participantNames = new Map([['YOU', asId(state.youName) || 'You']]);
    entries(state.players).forEach(player => {
      const id = asId(player?.id || player?.playerId);
      if (id) participantNames.set(id, asId(player?.name) || id);
    });
    const name = id => participantNames.get(id) || id;
    const money = value => (Number.isFinite(value) ? round(value).toFixed(1) : '?');

    // 1: Recompute each running balance from append order and compare balanceAfter.
    // Include every player, even if inactive or missing from state.players.
    const balanceIssues = [];
    const balanceWarnings = [];
    const ids = new Set();
    const balances = new Map();
    const rowIds = new Set();
    const allPlayers = new Set([...participantNames.keys()]);
    ledger.forEach((row, index) => {
      const label = 'Row ' + (index + 1) + ' (' + asId(row?.id || 'no ID') + ')';
      const rowId = asId(row?.id);
      const playerId = asId(row?.playerId);
      const amount = row?.amount == null || row.amount === '' ? NaN : Number(row.amount);
      if (!rowId) issue(balanceIssues, label + ': missing transaction ID.');
      else if (rowIds.has(rowId)) issue(balanceIssues, label + ': duplicate transaction ID.');
      else rowIds.add(rowId);
      if (!playerId) { issue(balanceIssues, label + ': missing player ID.'); return; }
      if (!Number.isFinite(amount)) { issue(balanceIssues, label + ': invalid Gold amount.'); return; }
      ids.add(playerId);
      allPlayers.add(playerId);
      const next = round((balances.get(playerId) || 0) + amount);
      balances.set(playerId, next);
      if (next < -EPS) issue(balanceIssues, name(playerId) + ': wallet became negative (' + money(next) + ') after ' + label + '.');
      if (row.balanceAfter == null || row.balanceAfter === '') {
        issue(balanceWarnings, label + ': saved balanceAfter is missing.');
      } else if (!Number.isFinite(Number(row.balanceAfter)) || Math.abs(Number(row.balanceAfter) - next) > EPS) {
        issue(balanceIssues, name(playerId) + ': ' + label + ' stored balanceAfter ' +
          money(Number(row.balanceAfter)) + ', but running total is ' + money(next) + '.');
      }
    });
    if (typeof options.getGoldBalance === 'function' && hasEconomy) {
      allPlayers.forEach(playerId => {
        try {
          const displayed = Number(options.getGoldBalance(state, playerId));
          const actual = balances.get(playerId) || 0;
          if (!Number.isFinite(displayed) || Math.abs(displayed - actual) > EPS) {
            issue(balanceIssues, name(playerId) + ': displayed Gold ' + money(displayed) +
              ' differs from ledger ' + money(actual) + '.');
          }
        } catch (error) {
          issue(balanceWarnings, name(playerId) + ': could not verify displayed Gold (' +
            String(error?.message || error) + ').');
        }
      });
    }
    const balanceStatus = !hasEconomy ? 'WARN' : balanceIssues.length ? 'FAIL' : balanceWarnings.length ? 'WARN' : 'PASS';
    const balanceCheck = make('gold-ledger-balance-integrity', 'Gold balances and ledger entries reconcile',
      balanceStatus, 'All player balances equal the signed ledger sum; transaction IDs are unique; saved running balances agree; no negative wallets',
      ledger.length + ' transactions • ' + ids.size + ' ledger players • ' + balanceIssues.length +
      ' error(s) • ' + balanceWarnings.length + ' warning(s)',
      [...balanceIssues, ...balanceWarnings, ...(!hasEconomy ? ['Gold economy is absent or has invalid version/launch date.'] : [])],
      'state.goldLedger[] amount/balanceAfter/id + TaskPointsCore.getGoldBalance',
      'Investigate the saved Gold ledger; do not automatically recreate or credit missing transactions.');

    // 2: A transfer must have exactly one loss and one equal gain, no duplicates.
    const transferIssues = [];
    const transferWarnings = [];
    const transfers = new Map();
    ledger.forEach((row, index) => {
      if (row?.type !== 'matchup_theft') return;
      const transferId = asId(row.transferId);
      const matchupId = asId(row.matchupId);
      const key = transferId || (matchupId ? 'legacy-matchup:' + matchupId : '');
      if (!key) {
        issue(transferWarnings, 'Theft row ' + (index + 1) + ' has no transferId or matchupId.');
        return;
      }
      if (!transfers.has(key)) transfers.set(key, []);
      transfers.get(key).push(row);
    });
    transfers.forEach((rows, transferId) => {
      const positives = rows.filter(row => Number(row.amount) > 0);
      const negatives = rows.filter(row => Number(row.amount) < 0);
      if (rows.length !== 2 || positives.length !== 1 || negatives.length !== 1) {
        issue(transferIssues, transferId + ': expected one gain and one loss; found ' +
          positives.length + ' gain(s), ' + negatives.length + ' loss(es), ' + rows.length + ' total.');
        return;
      }
      const gain = positives[0];
      const loss = negatives[0];
      if (Math.abs(Number(gain.amount) + Number(loss.amount)) > 0.051) {
        issue(transferIssues, transferId + ': gain ' + money(Number(gain.amount)) +
          ' and loss ' + money(Number(loss.amount)) + ' do not cancel.');
      }
      const winner = asId(gain.playerId);
      const loser = asId(loss.playerId);
      if (!winner || !loser || winner === loser ||
          asId(gain.opponentId) !== loser || asId(loss.opponentId) !== winner) {
        issue(transferIssues, transferId + ': theft player/opponent IDs do not form a reciprocal transfer.');
      }
      if (asId(gain.matchupId) !== asId(loss.matchupId)) {
        issue(transferIssues, transferId + ': gain and loss refer to different matchups.');
      }
    });
    const theftCheck = make('gold-theft-pair-integrity', 'Gold theft transfers are paired and unique',
      !hasEconomy ? 'WARN' : transferIssues.length ? 'FAIL' : transferWarnings.length ? 'WARN' : 'PASS',
      'Every theft has one positive and one matching negative transaction, opposite players and matching matchup IDs',
      transfers.size + ' transfers checked • ' + transferIssues.length + ' error(s) • ' +
      transferWarnings.length + ' warning(s)',
      [...transferIssues, ...transferWarnings],
      'state.goldLedger[] type=matchup_theft, transferId, matchupId, playerId, opponentId, amount');

    // 3: Every saved post-launch settled matchup outcome must have its matching
    // win-margin and theft gain, except intentionally ignored launch-day games.
    const coverageIssues = [];
    const coverageWarnings = [];
    const prelaunch = { count: 0 };
    const covered = new Set();
    const marginIndex = new Set();
    const theftIndex = new Set();
    ledger.forEach(row => {
      const match = asId(row?.matchupId);
      const player = asId(row?.playerId);
      if (!match || !player || !Number.isFinite(Number(row?.amount)) || Number(row.amount) <= 0) return;
      if (row.type === 'matchup_margin') marginIndex.add(match + '|' + player);
      if (row.type === 'matchup_theft') theftIndex.add(match + '|' + player);
    });
    const ignored = new Set(entries(economy?.ignoredSameDayMatchupKeys).map(asId));
    const walk = rows => entries(rows).forEach(row => {
      const outcome = row?.goldOutcome;
      if (outcome?.settled !== true) return;
      const theft = Number(outcome.theftGoldStolen || 0);
      const margin = Number(outcome.marginGoldAwarded || 0);
      if (!(theft > 0 || margin > 0)) return;
      const winner = asId(outcome.winnerId);
      const match = asId(row?.id || row?.matchupId);
      const when = day(row);
      if (!winner || !match || !when) {
        issue(coverageWarnings, 'Settled Gold outcome has missing winner, matchup ID, or date; cannot check matching transactions.');
        return;
      }
      const key = match + '|' + winner;
      if (covered.has(key)) return;
      covered.add(key);
      if (hasEconomy && when < launch) { prelaunch.count++; return; }
      if (!hasEconomy) return;
      const identity = typeof options.matchupIdentity === 'function'
        ? options.matchupIdentity(row) : 'id:' + match;
      if (when === launch && ignored.has(asId(identity))) return;
      if (theft > 0 && !theftIndex.has(key)) {
        issue(coverageIssues, when + ' ' + name(winner) + ': settled theft of ' + money(theft) +
          ' Gold has no positive ledger entry (' + match + ').');
      }
      if (margin > 0 && !marginIndex.has(key)) {
        issue(coverageIssues, when + ' ' + name(winner) + ': settled margin award of ' + money(margin) +
          ' Gold has no matching ledger entry (' + match + ').');
      }
    });
    walk(state.matchups);
    walk(state.gameHistory);
    walk(state.currentSeason?.tournamentMatchupResults);
    entries(state.seasonHistory).forEach(season => walk(season?.tournamentMatchupResults));
    entries(state.schedule).forEach(slate => walk(slate?.matchups));
    const coverageCheck = make('gold-post-launch-outcome-coverage', 'Settled Gold outcomes have ledger transactions',
      !hasEconomy ? 'WARN' : coverageIssues.length ? 'FAIL' : coverageWarnings.length ? 'WARN' : 'PASS',
      'Every post-launch settled Gold theft/margin has a corresponding ledger gain; historical pre-launch outcomes are exempt',
      covered.size + ' unique outcome(s) • ' + prelaunch.count + ' pre-launch excluded • ' +
      coverageIssues.length + ' missing entry/entries',
      [...coverageIssues, ...coverageWarnings, ...(!hasEconomy ? ['Gold launch date unavailable; post-launch coverage cannot be assessed.'] : [])],
      'matchups/gameHistory/seasonHistory goldOutcome vs goldLedger[] dateKey/matchupId',
      'Investigate missing post-launch entries before correcting Gold totals. Do not replay pre-launch thefts on top of opening balances.');

    // 4: Detect a changed launch epoch or disappearing ledger IDs relative to
    // older rolling snapshots. This is a read-only comparison, not a restore.
    const launchIssues = [];
    const launchWarnings = [];
    let comparable = 0;
    if (!hasEconomy) issue(launchIssues, 'Gold economy version or launch date missing/invalid.');
    if (!Array.isArray(state.goldLedger)) issue(launchIssues, 'Gold ledger array is missing.');
    const nowLaunch = asId(economy?.launchedAtISO);
    if (hasEconomy && (!nowLaunch || !Number.isFinite(Date.parse(nowLaunch)))) {
      issue(launchIssues, 'Gold economy has no valid initialization timestamp.');
    }
    ledger.filter(row => row?.type === 'opening_balance').forEach(row => {
      if (hasEconomy && asId(row.dateKey).slice(0,10) !== launch) {
        issue(launchIssues, 'Opening balance for ' + name(asId(row.playerId)) +
          ' is dated ' + asId(row.dateKey) + ', not the ledger launch date ' + launch + '.');
      }
    });
    entries(options.rollingBackups).forEach(snapshot => {
      const previous = snapshot?.state || snapshot;
      if (!previous || typeof previous !== 'object') return;
      const prevEconomy = previous.goldEconomy;
      const prevLedger = previous.goldLedger;
      if (!prevEconomy || Number(prevEconomy.version) !== 1 || !Array.isArray(prevLedger)) return;
      const before = asId(prevEconomy.launchedAtISO);
      if (!before || !Number.isFinite(Date.parse(before))) return;
      const source = asId(snapshot?.source) || 'rolling backup';
      comparable++;
      if (nowLaunch && before !== nowLaunch) {
        issue(launchIssues, source + ': Gold ledger initialization changed from ' +
          before + ' to ' + nowLaunch + '.');
      }
      const currentIds = rowIds;
      const missing = prevLedger.filter(row => row?.id && !currentIds.has(asId(row.id)));
      if (missing.length) issue(launchIssues, source + ': ' + missing.length +
        ' previously saved Gold transaction ID(s) are missing from the current ledger.');
    });
    entries(options.backupReadErrors).forEach(message => issue(launchWarnings, String(message)));
    if (!comparable) issue(launchWarnings,
      'No earlier readable Gold ledger snapshot was available for launch-date/transaction continuity comparison.');
    const launchCheck = make('gold-ledger-launch-continuity', 'Gold Ledger initialization and history stay stable',
      launchIssues.length ? 'FAIL' : launchWarnings.length ? 'WARN' : 'PASS',
      'Ledger launch timestamp is valid and unchanged from available rolling backups, and previously saved transactions are retained',
      'Launch ' + (nowLaunch || 'missing') + ' • ' + comparable + ' prior snapshot(s) compared',
      [...launchIssues, ...launchWarnings],
      'state.goldEconomy + goldLedger[] + localStorage rolling backup snapshots',
      'Do not reset the Gold economy automatically; inspect older verified backups if the launch date unexpectedly changed.');

    return [balanceCheck, theftCheck, coverageCheck, launchCheck];
  }

  const api = { buildGoldIntegrityChecks };
  global.TaskPointsAuditGoldIntegrity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
