(function(global){
  const STORAGE_KEY = "taskpoints_v1";
  const PROJECTS_STORAGE_KEY = "tp_projects_v1";

  const CATEGORY_DEFS = [
    { key: "sleep",    label: "Sleep",    match: c => typeof c?.title === "string" && c.title.startsWith("Sleep Score (") },
    { key: "calories", label: "Calories", match: c => typeof c?.title === "string" && c.title.startsWith("Calories (") },
    { key: "habits",   label: "Habits",   match: c => c?.source === "habit" },
    { key: "vices",    label: "Vices",    match: c => c?.source === "vice" },
    { key: "flex",     label: "Flex",     match: c => c?.source === "flex" },
    { key: "work",     label: "Work",     match: c => c?.source === "work" || (typeof c?.title === "string" && c.title.startsWith("Work Score")) },
    { key: "game",     label: "Game",     match: c => c?.source === "game" },
    { key: "tasks",    label: "Tasks",    match: () => true }
  ];

  function normalizeTask(task){
    if(!task || typeof task !== 'object') return task;
    const t = { ...task };
    if (typeof t.postponedDays !== 'number' || Number.isNaN(t.postponedDays)) {
      t.postponedDays = 0;
    }
    if (!t.originalDueDateISO && t.dueDateISO) {
      t.originalDueDateISO = t.dueDateISO;
    }
    return t;
  }

  function normalizeState(s) {
    return {
      tasks:       Array.isArray(s?.tasks)       ? s.tasks.map(normalizeTask)       : [],
      completions: Array.isArray(s?.completions) ? s.completions : [],
      players:     Array.isArray(s?.players)     ? s.players     : [],
      habits:      Array.isArray(s?.habits)      ? s.habits      : [],
      flexActions: Array.isArray(s?.flexActions) ? s.flexActions : [],
      gameHistory: Array.isArray(s?.gameHistory) ? s.gameHistory : [],
      matchups:    Array.isArray(s?.matchups)    ? s.matchups    : [],
      schedule:    Array.isArray(s?.schedule)    ? s.schedule    : [],
      opponentDripSchedules: Array.isArray(s?.opponentDripSchedules) ? s.opponentDripSchedules : [],
      workHistory: Array.isArray(s?.workHistory) ? s.workHistory : [],
      youImage:    typeof s?.youImage === "string" ? s.youImage : "",
      projects:    Array.isArray(s?.projects)    ? s.projects    : []
    };
  }

  function loadAppState() {
    let parsed = {};
    let storageKeysFound = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        parsed = JSON.parse(raw) || {};
        storageKeysFound.push(STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to parse stored state", e);
    }

    return { state: normalizeState(parsed), storageKeysFound };
  }

  function isQuotaError(err) {
    if (!err) return false;
    return err.name === 'QuotaExceededError'
      || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || err.code === 22
      || err.code === 1014;
  }

  function pruneStateForStorage(state, limits = {}) {
    const normalized = normalizeState(state || {});
    const maxCompletions = Number.isFinite(limits.maxCompletions) ? limits.maxCompletions : 10000;
    const maxGameHistory = Number.isFinite(limits.maxGameHistory) ? limits.maxGameHistory : 2500;
    const maxMatchups = Number.isFinite(limits.maxMatchups) ? limits.maxMatchups : 2500;
    const maxWorkHistory = Number.isFinite(limits.maxWorkHistory) ? limits.maxWorkHistory : 2500;
    const stripImages = Boolean(limits.stripImages);

    if (normalized.completions.length > maxCompletions) {
      normalized.completions = normalized.completions.slice(0, maxCompletions);
    }
    if (normalized.gameHistory.length > maxGameHistory) {
      normalized.gameHistory = normalized.gameHistory.slice(-maxGameHistory);
    }
    if (normalized.matchups.length > maxMatchups) {
      normalized.matchups = normalized.matchups.slice(-maxMatchups);
    }
    if (normalized.workHistory.length > maxWorkHistory) {
      normalized.workHistory = normalized.workHistory.slice(-maxWorkHistory);
    }
    if (stripImages) {
      normalized.youImage = "";
      normalized.players = normalized.players.map(p => {
        if (!p || typeof p !== 'object') return p;
        return { ...p, imageData: "" };
      });
    }

    return normalized;
  }

  function capLimit(current, cap) {
    if (Number.isFinite(current)) return Math.min(current, cap);
    return cap;
  }

  function mergeAndSaveState(nextState, options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    let existing = {};
    try {
      const raw = options.raw ?? localStorage.getItem(storageKey);
      existing = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      console.warn('Failed to parse existing TaskPoints storage; saving fresh state.', e);
      existing = {};
    }

    const merged = normalizeState({ ...existing, ...nextState });

    const attemptSave = (candidate, trimmed) => {
      localStorage.setItem(storageKey, JSON.stringify(candidate));
      return { state: candidate, trimmed };
    };

    try {
      return attemptSave(merged, false);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }

    const trimmed = pruneStateForStorage(merged, options.limits);
    try {
      return attemptSave(trimmed, true);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }

    const imagePreservingLimitSets = [
      { maxCompletions: 8000, maxGameHistory: 2000, maxMatchups: 2000, maxWorkHistory: 2000 },
      { maxCompletions: 5000, maxGameHistory: 1500, maxMatchups: 1500, maxWorkHistory: 1500 },
      { maxCompletions: 3000, maxGameHistory: 1000, maxMatchups: 1000, maxWorkHistory: 1000 },
      { maxCompletions: 2000, maxGameHistory: 800, maxMatchups: 800, maxWorkHistory: 800 },
      { maxCompletions: 1000, maxGameHistory: 500, maxMatchups: 500, maxWorkHistory: 500 },
      { maxCompletions: 500, maxGameHistory: 250, maxMatchups: 250, maxWorkHistory: 250 }
    ];

    for (const limits of imagePreservingLimitSets) {
      const tightenedLimits = {
        ...options.limits,
        maxCompletions: capLimit(options.limits?.maxCompletions, limits.maxCompletions),
        maxGameHistory: capLimit(options.limits?.maxGameHistory, limits.maxGameHistory),
        maxMatchups: capLimit(options.limits?.maxMatchups, limits.maxMatchups),
        maxWorkHistory: capLimit(options.limits?.maxWorkHistory, limits.maxWorkHistory),
        stripImages: false
      };
      const tightened = pruneStateForStorage(merged, tightenedLimits);
      try {
        return attemptSave(tightened, true);
      } catch (err) {
        if (!isQuotaError(err)) throw err;
      }
    }

    const stripped = pruneStateForStorage(trimmed, { ...options.limits, stripImages: true });
    try {
      return attemptSave(stripped, true);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }

    const aggressiveLimits = {
      ...options.limits,
      maxCompletions: capLimit(options.limits?.maxCompletions, 2000),
      maxGameHistory: capLimit(options.limits?.maxGameHistory, 1000),
      maxMatchups: capLimit(options.limits?.maxMatchups, 1000),
      maxWorkHistory: capLimit(options.limits?.maxWorkHistory, 1000),
      stripImages: true
    };
    const aggressive = pruneStateForStorage(stripped, aggressiveLimits);
    try {
      return attemptSave(aggressive, true);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }

    const fallbackLimitSets = [
      { maxCompletions: 1000, maxGameHistory: 500, maxMatchups: 500, maxWorkHistory: 500 },
      { maxCompletions: 500, maxGameHistory: 250, maxMatchups: 250, maxWorkHistory: 250 },
      { maxCompletions: 250, maxGameHistory: 125, maxMatchups: 125, maxWorkHistory: 125 },
      { maxCompletions: 100, maxGameHistory: 50, maxMatchups: 50, maxWorkHistory: 50 }
    ];

    for (const limits of fallbackLimitSets) {
      const tightenedLimits = {
        ...options.limits,
        maxCompletions: capLimit(options.limits?.maxCompletions, limits.maxCompletions),
        maxGameHistory: capLimit(options.limits?.maxGameHistory, limits.maxGameHistory),
        maxMatchups: capLimit(options.limits?.maxMatchups, limits.maxMatchups),
        maxWorkHistory: capLimit(options.limits?.maxWorkHistory, limits.maxWorkHistory),
        stripImages: true
      };
      const tightened = pruneStateForStorage(aggressive, tightenedLimits);
      try {
        return attemptSave(tightened, true);
      } catch (err) {
        if (!isQuotaError(err)) throw err;
      }
    }

    const emergency = {
      ...aggressive,
      completions: aggressive.completions.slice(0, 50),
      gameHistory: [],
      matchups: [],
      schedule: [],
      opponentDripSchedules: [],
      workHistory: [],
      youImage: "",
      players: aggressive.players.map(p => {
        if (!p || typeof p !== 'object') return p;
        return { ...p, imageData: "" };
      })
    };

    return attemptSave(emergency, true);
  }

  function dateKey(d){
    if (typeof d === 'string') {
      const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const [, y, mon, day] = m;
        d = new Date(Number(y), Number(mon) - 1, Number(day));
      } else {
        d = new Date(d);
      }
    } else if (!(d instanceof Date)) {
      d = new Date(d);
    }

    if (!d || isNaN(d.getTime())) return 'invalid';
    const y  = d.getFullYear();
    const m  = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  }

  function todayKey(){
    const d = new Date();
    d.setHours(0,0,0,0);
    return dateKey(d);
  }

  function fromKey(k){
    if (!k || typeof k !== 'string') return new Date(NaN);
    const parts = k.split('-');
    if (parts.length < 3) return new Date(NaN);
    const [yStr,mStr,dStr] = parts;
    const y = parseInt(yStr,10);
    const m = parseInt(mStr,10);
    const d = parseInt(dStr,10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return new Date(NaN);
    }
    const dt = new Date(y, m-1, d);
    dt.setHours(0,0,0,0);
    return dt;
  }

  function niceDate(d){
    if (!(d instanceof Date)) d = new Date(d);
    if (!d || isNaN(d.getTime())) return 'Invalid date';
    return d.toLocaleDateString(undefined,{
      year:'numeric',
      month:'short',
      day:'numeric'
    });
  }

  function monthKey(d){
    if (!(d instanceof Date)) d = new Date(d);
    if (!d || isNaN(d.getTime())) return 'invalid-month';
    const y  = d.getFullYear();
    const m  = String(d.getMonth()+1).padStart(2,'0');
    return `${y}-${m}`;
  }

  function formatMonthKey(k){
    const parts = (k || '').split('-');
    if (parts.length < 2) return 'Invalid month';
    const [yStr,mStr] = parts;
    const y = parseInt(yStr,10);
    const m = parseInt(mStr,10);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return 'Invalid month';
    const dt = new Date(y, m-1, 1);
    if (isNaN(dt.getTime())) return 'Invalid month';
    return dt.toLocaleString(undefined,{month:'long',year:'numeric'});
  }

  function isoWeekKey(d){
    if (!(d instanceof Date)) d = new Date(d);
    if (!d || isNaN(d.getTime())) return 'invalid-week';

    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
    const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
  }

  function isoWeekRange(weekKey){
    const [yStr, wStr] = weekKey.split('-W');
    const y = parseInt(yStr, 10);
    const w = parseInt(wStr, 10);

    const simple = new Date(y, 0, 1 + (w - 1) * 7);
    let dow = simple.getDay();
    if (dow === 0) dow = 7;

    const start = new Date(simple);
    start.setDate(simple.getDate() + 1 - dow);

    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    return { start, end };
  }

  function sleepBonus(score) {
    if (score >= 100) return 3;
    if (score >= 98) return 2;
    if (score >= 95) return 1;
    return 0;
  }

  function getSleepInfo(entry) {
    const match = entry?.title?.match(/\((\d+)\)/);
    const score = match ? Number(match[1]) : null;

    const restedRaw = entry && Object.prototype.hasOwnProperty.call(entry, 'sleepRested')
      ? Number(entry.sleepRested)
      : 0;
    const rested = Number.isFinite(restedRaw) ? restedRaw : 0;

    return { score, rested };
  }

  function sleepPoints(score, rested = 0) {
    if (!Number.isFinite(score)) return 0;
    const base  = score / 10;
    const bonus = sleepBonus(score);
    return base + bonus + (Number.isFinite(rested) ? rested : 0);
  }

  function getWorkInfo(entry) {
    const match = entry?.title?.match(/\(([^)]+)\)/);
    const score = match ? Number(match[1]) : null;

    const hoursRaw = entry && Object.prototype.hasOwnProperty.call(entry, 'workHours')
      ? Number(entry.workHours)
      : 0;
    const hours = Number.isFinite(hoursRaw) ? hoursRaw : 0;

    return { score, hours };
  }

  function workHoursBonus(hours = 0) {
    if (!Number.isFinite(hours)) return 0;
    return Math.max(0, hours) * 10;
  }

  function workPoints(score, hours = 0) {
    if (!Number.isFinite(score)) return 0;
    return score + workHoursBonus(hours);
  }

  function caloriesToPoints(cal){
    let pts = (2400 - cal) / 100;

    if (pts < 0) pts = 0;
    if (pts > 10) pts = 10;

    pts = Math.round(pts * 10) / 10;
    return pts;
  }

  function categorizeCompletion(c) {
    for (const def of CATEGORY_DEFS) {
      try {
        if (def.match(c)) return def.key;
      } catch (err) {
        console.warn("Category match failed", err);
      }
    }
    return 'tasks';
  }

  function aggregateCompletionsByDate(completions){
    const dailyTotals   = {};
    const weeklyTotals  = {};
    const monthlyTotals = {};

    if (!Array.isArray(completions)) return { dailyTotals, weeklyTotals, monthlyTotals };

    completions.forEach(c => {
      if (!c || !c.completedAtISO) return;

      const d = new Date(c.completedAtISO);
      if (!d || isNaN(d.getTime())) return;

      const dk = dateKey(d);
      const wk = isoWeekKey(d);
      const mk = monthKey(d);

      const pts = c.points || 0;

      dailyTotals[dk]   = (dailyTotals[dk]   || 0) + pts;
      weeklyTotals[wk]  = (weeklyTotals[wk]  || 0) + pts;
      monthlyTotals[mk] = (monthlyTotals[mk] || 0) + pts;
    });

    return { dailyTotals, weeklyTotals, monthlyTotals };
  }

  function computeInertia(dailyTotals, todayK){
    const today = fromKey(todayK);
    if (!today || isNaN(today.getTime())) return { inertia: 0, average: 0 };

    const keys = Array.from(new Set([...Object.keys(dailyTotals), todayK]))
      .filter(k => {
        const d = fromKey(k);
        return d && !isNaN(d.getTime());
      })
      .sort((a, b) => fromKey(a) - fromKey(b));

    const inertiaMap = new Map();
    const totalsWithInertia = new Map();

    keys.forEach(k => {
      const current = fromKey(k);
      if (!current || isNaN(current.getTime())) return;

      let sum = 0;
      let count = 0;

      for (let i = 1; i <= 7; i++) {
        const d = new Date(current);
        d.setDate(current.getDate() - i);
        const key = dateKey(d);
        const total = totalsWithInertia.get(key);
        if (Number.isFinite(total)) {
          sum += total;
          count++;
        }
      }

      const average = count ? sum / count : 0;
      const inertia = count ? average * 0.25 : 0;

      inertiaMap.set(k, { inertia, average });
      const base = Number(dailyTotals[k]) || 0;
      totalsWithInertia.set(k, base + inertia);
    });

    return inertiaMap.get(todayK) || { inertia: 0, average: 0 };
  }

  function deriveTodayWithInertia(dailyTotals, todayK){
    const { inertia, average } = computeInertia(dailyTotals, todayK);
    const todayBase = Number(dailyTotals[todayK]) || 0;
    const todayPoints = Math.round((todayBase + inertia) * 10) / 10;

    return { todayPoints, inertia, average, base: todayBase };
  }

  function buildDailyBreakdowns(state){
    const daily = {};
    const comps = Array.isArray(state?.completions) ? state.completions : [];

    comps.forEach(c => {
      if (!c || !c.completedAtISO) return;
      const d = new Date(c.completedAtISO);
      if (!d || isNaN(d.getTime())) return;
      d.setHours(0, 0, 0, 0);
      const key = dateKey(d);

      if (!daily[key]) {
        daily[key] = {
          total: 0,
          categories: {}
        };
      }

      const pts = Number(c.points) || 0;
      if (!pts) return;

      const catKey = categorizeCompletion(c);
      daily[key].total += pts;
      daily[key].categories[catKey] = (daily[key].categories[catKey] || 0) + pts;
    });

    const dailyTotals = Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, Number(v.total) || 0]));
    Object.keys(dailyTotals).forEach(k => {
      const { inertia } = computeInertia(dailyTotals, k);
      if (!inertia) return;

      daily[k].total += inertia;
      daily[k].categories.inertia = (daily[k].categories.inertia || 0) + inertia;
    });

    return daily;
  }

  function buildRollups(state){
    const normalized = normalizeState(state || {});
    const { dailyTotals } = aggregateCompletionsByDate(normalized.completions);
    const dailyTotalsWithInertia = {};
    const weeklyTotalsWithInertia = {};
    const monthlyTotalsWithInertia = {};

    Object.entries(dailyTotals).forEach(([k, base]) => {
      const { inertia } = computeInertia(dailyTotals, k);
      const inertiaVal = Number.isFinite(inertia) ? inertia : 0;
      const total = base + inertiaVal;
      dailyTotalsWithInertia[k] = total;

      const d = fromKey(k);
      if (!d || isNaN(d.getTime())) return;

      const wk = isoWeekKey(d);
      const mk = monthKey(d);
      weeklyTotalsWithInertia[wk]  = (weeklyTotalsWithInertia[wk]  || 0) + total;
      monthlyTotalsWithInertia[mk] = (monthlyTotalsWithInertia[mk] || 0) + total;
    });

    return { dailyTotals, dailyTotalsWithInertia, weeklyTotalsWithInertia, monthlyTotalsWithInertia };
  }

  function computeLeaderboards(state){
    const rollups = buildRollups(state);
    const bestDays = Object.entries(rollups.dailyTotalsWithInertia)
      .map(([key, total]) => ({ key, total }))
      .sort((a,b) => b.total - a.total);

    const bestWeeks = Object.entries(rollups.weeklyTotalsWithInertia)
      .map(([key, total]) => ({ key, total, ...isoWeekRange(key) }))
      .sort((a,b) => b.total - a.total);

    const bestMonths = Object.entries(rollups.monthlyTotalsWithInertia)
      .map(([key, total]) => ({ key, total }))
      .sort((a,b) => b.total - a.total);

    return { bestDays, bestWeeks, bestMonths, rollups };
  }

  function buildDaySnapshot(dateKeyStr, state){
    const normalized = normalizeState(state || {});
    const key = dateKey(dateKeyStr);
    const comps = Array.isArray(normalized.completions) ? normalized.completions : [];

    const dayComps = comps.filter(c => {
      if (!c || !c.completedAtISO) return false;
      const d = new Date(c.completedAtISO);
      return dateKey(d) === key;
    });

    const items = dayComps.map(c => {
      const category = categorizeCompletion(c);
      const label = typeof c.title === 'string' ? c.title : 'Untitled';
      const pts = Number(c.points) || 0;
      return {
        source: c.source || 'task',
        id: c.id || c.taskId || label,
        label,
        category,
        points: pts,
        details: {
          completedAtISO: c.completedAtISO,
          taskId: c.taskId,
        }
      };
    });

    const baseTotal = items.reduce((s, item) => s + (Number(item.points) || 0), 0);
    const { dailyTotals } = aggregateCompletionsByDate(comps);
    const { inertia, average } = computeInertia(dailyTotals, key);
    const inertiaVal = Number.isFinite(inertia) ? inertia : 0;

    return {
      dateKey: key,
      items,
      baseTotal,
      inertia: inertiaVal,
      inertiaAverage: average,
      rollups: { dailyTotals },
      state: normalized,
    };
  }

  function computeDayTotals(snapshot){
    const byCategory = {};

    CATEGORY_DEFS.forEach(def => {
      byCategory[def.label] = 0;
    });
    byCategory.Inertia = 0;

    snapshot.items.forEach(item => {
      const def = CATEGORY_DEFS.find(d => d.key === item.category) || CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
      const label = def.label;
      byCategory[label] = (byCategory[label] || 0) + (Number(item.points) || 0);
    });

    if (snapshot.inertia) {
      byCategory.Inertia = (byCategory.Inertia || 0) + snapshot.inertia;
    }

    const rawTotal = snapshot.baseTotal + (snapshot.inertia || 0);
    const total = Math.round(rawTotal * 10) / 10;
    const roundingNotes = Math.abs(rawTotal - total) > 1e-9
      ? [`Rounded to one decimal place from ${rawTotal}`]
      : [];

    return {
      total,
      rawTotal,
      byCategory,
      items: snapshot.items,
      roundingNotes,
    };
  }

  function matchupDateKey(matchup){
    if (!matchup) return '';
    return matchup.dateKey
      || matchup.date
      || (matchup.dateISO ? dateKey(matchup.dateISO) : '');
  }

  function youDailyTotalsWithInertia(state){
    const normalized = normalizeState(state || {});
    const { dailyTotals } = aggregateCompletionsByDate(normalized.completions);

    const keys = new Set([
      ...Object.keys(dailyTotals),
      ...normalized.matchups
        .map(matchupDateKey)
        .filter(Boolean),
    ]);

    const totals = {};

    keys.forEach(key => {
      const snapshot = buildDaySnapshot(key, normalized);
      const totalsForDay = computeDayTotals(snapshot);
      totals[key] = totalsForDay.total;
    });

    return totals;
  }

  function syncYouMatchups(state){
    const normalized = normalizeState(state || {});
    const youTotals = youDailyTotalsWithInertia(normalized);

    if (!Object.keys(youTotals).length) {
      return { state: normalized, changed: false };
    }

    let changed = false;

    const updated = (normalized.matchups || []).map(m => {
      const key = matchupDateKey(m);
      const youScore = youTotals[key];
      const aIsYou = m && m.playerAId === 'YOU';
      const bIsYou = m && m.playerBId === 'YOU';

      if (!youScore && youScore !== 0) return m;
      if (!aIsYou && !bIsYou) return m;

      const next = { ...m };
      let localChange = false;

      if (aIsYou && Number(next.scoreA) !== youScore) {
        next.scoreA = youScore;
        localChange = true;
      }
      if (bIsYou && Number(next.scoreB) !== youScore) {
        next.scoreB = youScore;
        localChange = true;
      }

      if (!localChange && next.dateKey) return next;

      next.dateKey = key || next.dateKey;

      const aScore = Number(next.scoreA);
      const bScore = Number(next.scoreB);
      const diff = (Number.isFinite(aScore) ? aScore : 0) - (Number.isFinite(bScore) ? bScore : 0);
      next.diff = diff;

      if (aIsYou || bIsYou) {
        const yourScore = aIsYou ? aScore : bScore;
        const oppScore  = aIsYou ? bScore : aScore;
        if (yourScore > oppScore) next.result = 'you-win';
        else if (yourScore < oppScore) next.result = 'you-loss';
        else next.result = 'tie';
      } else {
        if (aScore > bScore) next.result = 'a-win';
        else if (aScore < bScore) next.result = 'b-win';
        else next.result = 'tie';
      }

      changed = changed || localChange;
      return next;
    });

    if (changed) {
      normalized.matchups = updated;
    }

    return { state: normalized, changed };
  }

  global.TaskPointsCore = {
    STORAGE_KEY,
    PROJECTS_STORAGE_KEY,
    CATEGORY_DEFS,
    normalizeTask,
    normalizeState,
    loadAppState,
    pruneStateForStorage,
    mergeAndSaveState,
    dateKey,
    todayKey,
    fromKey,
    niceDate,
    monthKey,
    formatMonthKey,
    isoWeekKey,
    isoWeekRange,
    sleepBonus,
    getSleepInfo,
    sleepPoints,
    getWorkInfo,
    workHoursBonus,
    workPoints,
    caloriesToPoints,
    categorizeCompletion,
    aggregateCompletionsByDate,
    computeInertia,
    deriveTodayWithInertia,
    buildDailyBreakdowns,
    buildRollups,
    computeLeaderboards,
    buildDaySnapshot,
    computeDayTotals,
    youDailyTotalsWithInertia,
    syncYouMatchups,
  };
})(window);
