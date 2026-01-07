(function(global){
  const STORAGE_KEY = "taskpoints_v1";
  const PROJECTS_STORAGE_KEY = "tp_projects_v1";
  const IMAGE_DB_NAME = "taskpoints";
  const IMAGE_STORE_NAME = "images";

  if (!global.scheduleRender) {
    const queue = new Set();
    let scheduled = false;
    global.scheduleRender = (fn) => {
      if (typeof fn !== 'function') return;
      queue.add(fn);
      if (scheduled) return;
      scheduled = true;
      const raf = global.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
      raf(() => {
        scheduled = false;
        const toRun = Array.from(queue);
        queue.clear();
        toRun.forEach((cb) => cb());
      });
    };
  }

  let imageDbPromise = null;

  function openImageDb() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(IMAGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
          db.createObjectStore(IMAGE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return imageDbPromise;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function generateImageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
    if (!match) return null;
    const mime = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const data = match[3] || '';

    if (isBase64) {
      const binary = atob(data);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }

    return new Blob([decodeURIComponent(data)], { type: mime });
  }

  async function saveImageBlob(imageId, blob) {
    if (!imageId || !blob) return;
    const db = await openImageDb();
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IMAGE_STORE_NAME);
    await requestToPromise(store.put(blob, imageId));
  }

  async function getImageBlob(imageId) {
    if (!imageId) return null;
    const db = await openImageDb();
    const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
    const store = tx.objectStore(IMAGE_STORE_NAME);
    const result = await requestToPromise(store.get(imageId));
    return result || null;
  }

  async function deleteImageBlob(imageId) {
    if (!imageId) return;
    const db = await openImageDb();
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IMAGE_STORE_NAME);
    await requestToPromise(store.delete(imageId));
  }

  function isImageDataUrl(value) {
    return typeof value === 'string' && value.startsWith('data:image/');
  }

  async function migrateLegacyImages(rawState) {
    if (!rawState || typeof rawState !== 'object') {
      return { state: normalizeState(rawState || {}), migrated: false };
    }

    const next = { ...rawState };
    let migrated = false;

    if (isImageDataUrl(next.youImage) && !next.youImageId) {
      const blob = dataUrlToBlob(next.youImage);
      if (blob) {
        const imageId = generateImageId();
        await saveImageBlob(imageId, blob);
        next.youImageId = imageId;
        migrated = true;
      }
    }
    if (next.youImage) {
      delete next.youImage;
      migrated = true;
    }

    if (Array.isArray(next.players)) {
      const updatedPlayers = [];
      for (const player of next.players) {
        if (!player || typeof player !== 'object') {
          updatedPlayers.push(player);
          continue;
        }
        let updated = { ...player };
        if (isImageDataUrl(updated.imageData) && !updated.imageId) {
          const blob = dataUrlToBlob(updated.imageData);
          if (blob) {
            const imageId = generateImageId();
            await saveImageBlob(imageId, blob);
            updated.imageId = imageId;
            migrated = true;
          }
        }
        if (updated.imageData) {
          delete updated.imageData;
          migrated = true;
        }
        updatedPlayers.push(updated);
      }
      next.players = updatedPlayers;
    }

    return { state: next, migrated };
  }

  async function migrateLegacyImagesInStorage(options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    let parsed = {};
    try {
      const raw = localStorage.getItem(storageKey);
      parsed = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      console.error('Failed to parse stored state for image migration', e);
      parsed = {};
    }

    const { state: migratedState, migrated } = await migrateLegacyImages(parsed);
    if (!migrated) {
      return { state: normalizeState(parsed), migrated: false };
    }

    const { state: savedState } = mergeAndSaveState(migratedState, { storageKey });
    return { state: savedState, migrated: true };
  }

  const CATEGORY_DEFS = [
    { key: "sleep",    label: "Sleep",    match: c => typeof c?.title === "string" && c.title.startsWith("Sleep Score (") },
    { key: "calories", label: "Calories", match: c => typeof c?.title === "string" && c.title.toLowerCase().startsWith("calories") },
    { key: "mood",     label: "Mood",     match: c => typeof c?.title === "string" && c.title.startsWith("Mood Score (") },
    { key: "habits",   label: "Habits",   match: c => c?.source === "habit" },
    { key: "vices",    label: "Vices",    match: c => c?.source === "vice" },
    { key: "flex",     label: "Flex",     match: c => c?.source === "flex" },
    { key: "work",     label: "Work",     match: c => c?.source === "work" || (typeof c?.title === "string" && c.title.startsWith("Work Score")) },
    { key: "game",     label: "Game",     match: c => c?.source === "game" },
    { key: "tasks",    label: "Tasks",    match: () => true }
  ];

  const DEFAULT_SCORING_SETTINGS = {
    sleep: {
      baseDivisor: 10,
      baseMultiplier: 1,
      baseOffset: 0,
      restedMultiplier: 1,
      bonusTiers: [
        { min: 100, bonus: 3 },
        { min: 98, bonus: 2 },
        { min: 95, bonus: 1 }
      ]
    },
    work: {
      baseMultiplier: 1,
      baseOffset: 0,
      hoursMultiplier: 10,
      hoursOffset: 0,
      hoursMin: 0,
      hoursMax: null
    },
    calories: {
      target: 2400,
      pointsPer100: 1,
      minPoints: 0,
      maxPoints: 10
    },
    mood: {
      multiplier: 1,
      offset: 0,
      minPoints: null,
      maxPoints: null
    },
    inertia: {
      windowDays: 7,
      multiplier: 0.25
    }
  };

  function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function normalizeBonusTiers(tiers, fallback) {
    const source = Array.isArray(tiers) ? tiers : fallback;
    const cleaned = [];
    source.forEach(tier => {
      if (!tier || typeof tier !== 'object') return;
      const min = toFiniteNumber(tier.min);
      const bonus = toFiniteNumber(tier.bonus);
      if (min == null || bonus == null) return;
      cleaned.push({ min, bonus });
    });
    return cleaned.sort((a, b) => b.min - a.min);
  }

  function normalizeScoringSettings(settings = {}) {
    const source = isPlainObject(settings) ? settings : {};
    const sleepInput = isPlainObject(source.sleep) ? source.sleep : {};
    const workInput = isPlainObject(source.work) ? source.work : {};
    const caloriesInput = isPlainObject(source.calories) ? source.calories : {};
    const moodInput = isPlainObject(source.mood) ? source.mood : {};
    const inertiaInput = isPlainObject(source.inertia) ? source.inertia : {};

    const sleepBaseDivisor = toFiniteNumber(sleepInput.baseDivisor);
    const sleepBaseMultiplier = toFiniteNumber(sleepInput.baseMultiplier);
    const sleepBaseOffset = toFiniteNumber(sleepInput.baseOffset);
    const sleepRestedMultiplier = toFiniteNumber(sleepInput.restedMultiplier);

    const workBaseMultiplier = toFiniteNumber(workInput.baseMultiplier);
    const workBaseOffset = toFiniteNumber(workInput.baseOffset);
    const workHoursMultiplier = toFiniteNumber(workInput.hoursMultiplier);
    const workHoursOffset = toFiniteNumber(workInput.hoursOffset);
    const workHoursMin = Object.prototype.hasOwnProperty.call(workInput, 'hoursMin')
      ? toFiniteNumber(workInput.hoursMin)
      : null;
    const workHoursMax = Object.prototype.hasOwnProperty.call(workInput, 'hoursMax')
      ? toFiniteNumber(workInput.hoursMax)
      : null;

    const caloriesTarget = toFiniteNumber(caloriesInput.target);
    const caloriesPointsPer100 = toFiniteNumber(caloriesInput.pointsPer100);
    const caloriesMin = Object.prototype.hasOwnProperty.call(caloriesInput, 'minPoints')
      ? (caloriesInput.minPoints === null ? null : toFiniteNumber(caloriesInput.minPoints))
      : null;
    const caloriesMax = Object.prototype.hasOwnProperty.call(caloriesInput, 'maxPoints')
      ? (caloriesInput.maxPoints === null ? null : toFiniteNumber(caloriesInput.maxPoints))
      : null;

    const moodMultiplier = toFiniteNumber(moodInput.multiplier);
    const moodOffset = toFiniteNumber(moodInput.offset);
    const moodMin = Object.prototype.hasOwnProperty.call(moodInput, 'minPoints')
      ? (moodInput.minPoints === null ? null : toFiniteNumber(moodInput.minPoints))
      : null;
    const moodMax = Object.prototype.hasOwnProperty.call(moodInput, 'maxPoints')
      ? (moodInput.maxPoints === null ? null : toFiniteNumber(moodInput.maxPoints))
      : null;

    const inertiaWindow = toFiniteNumber(inertiaInput.windowDays);
    const inertiaMultiplier = toFiniteNumber(inertiaInput.multiplier);

    const normalized = {
      sleep: {
        baseDivisor: sleepBaseDivisor && sleepBaseDivisor > 0 ? sleepBaseDivisor : DEFAULT_SCORING_SETTINGS.sleep.baseDivisor,
        baseMultiplier: sleepBaseMultiplier != null ? sleepBaseMultiplier : DEFAULT_SCORING_SETTINGS.sleep.baseMultiplier,
        baseOffset: sleepBaseOffset != null ? sleepBaseOffset : DEFAULT_SCORING_SETTINGS.sleep.baseOffset,
        restedMultiplier: sleepRestedMultiplier != null ? sleepRestedMultiplier : DEFAULT_SCORING_SETTINGS.sleep.restedMultiplier,
        bonusTiers: normalizeBonusTiers(sleepInput.bonusTiers, DEFAULT_SCORING_SETTINGS.sleep.bonusTiers)
      },
      work: {
        baseMultiplier: workBaseMultiplier != null ? workBaseMultiplier : DEFAULT_SCORING_SETTINGS.work.baseMultiplier,
        baseOffset: workBaseOffset != null ? workBaseOffset : DEFAULT_SCORING_SETTINGS.work.baseOffset,
        hoursMultiplier: workHoursMultiplier != null ? workHoursMultiplier : DEFAULT_SCORING_SETTINGS.work.hoursMultiplier,
        hoursOffset: workHoursOffset != null ? workHoursOffset : DEFAULT_SCORING_SETTINGS.work.hoursOffset,
        hoursMin: workHoursMin != null ? workHoursMin : DEFAULT_SCORING_SETTINGS.work.hoursMin,
        hoursMax: Object.prototype.hasOwnProperty.call(workInput, 'hoursMax')
          ? workHoursMax
          : DEFAULT_SCORING_SETTINGS.work.hoursMax
      },
      calories: {
        target: caloriesTarget != null ? caloriesTarget : DEFAULT_SCORING_SETTINGS.calories.target,
        pointsPer100: caloriesPointsPer100 != null ? caloriesPointsPer100 : DEFAULT_SCORING_SETTINGS.calories.pointsPer100,
        minPoints: Object.prototype.hasOwnProperty.call(caloriesInput, 'minPoints')
          ? caloriesMin
          : DEFAULT_SCORING_SETTINGS.calories.minPoints,
        maxPoints: Object.prototype.hasOwnProperty.call(caloriesInput, 'maxPoints')
          ? caloriesMax
          : DEFAULT_SCORING_SETTINGS.calories.maxPoints
      },
      mood: {
        multiplier: moodMultiplier != null ? moodMultiplier : DEFAULT_SCORING_SETTINGS.mood.multiplier,
        offset: moodOffset != null ? moodOffset : DEFAULT_SCORING_SETTINGS.mood.offset,
        minPoints: Object.prototype.hasOwnProperty.call(moodInput, 'minPoints')
          ? moodMin
          : DEFAULT_SCORING_SETTINGS.mood.minPoints,
        maxPoints: Object.prototype.hasOwnProperty.call(moodInput, 'maxPoints')
          ? moodMax
          : DEFAULT_SCORING_SETTINGS.mood.maxPoints
      },
      inertia: {
        windowDays: inertiaWindow && inertiaWindow >= 1 ? Math.round(inertiaWindow) : DEFAULT_SCORING_SETTINGS.inertia.windowDays,
        multiplier: inertiaMultiplier != null ? inertiaMultiplier : DEFAULT_SCORING_SETTINGS.inertia.multiplier
      }
    };

    return {
      ...source,
      sleep: { ...sleepInput, ...normalized.sleep },
      work: { ...workInput, ...normalized.work },
      calories: { ...caloriesInput, ...normalized.calories },
      mood: { ...moodInput, ...normalized.mood },
      inertia: { ...inertiaInput, ...normalized.inertia }
    };
  }

  function getScoringSettings(stateOrSettings) {
    if (stateOrSettings && typeof stateOrSettings === 'object') {
      if (Object.prototype.hasOwnProperty.call(stateOrSettings, 'sleep')
        || Object.prototype.hasOwnProperty.call(stateOrSettings, 'work')
        || Object.prototype.hasOwnProperty.call(stateOrSettings, 'calories')) {
        return normalizeScoringSettings(stateOrSettings);
      }
      if (Object.prototype.hasOwnProperty.call(stateOrSettings, 'scoringSettings')) {
        return normalizeScoringSettings(stateOrSettings.scoringSettings);
      }
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) || {};
        return normalizeScoringSettings(parsed.scoringSettings || {});
      }
    } catch (err) {
      console.warn('Failed to load scoring settings from storage', err);
    }
    return normalizeScoringSettings({});
  }

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

  function normalizeCompletion(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const c = { ...entry };
    const title = typeof c.title === 'string' ? c.title : '';
    const isMetric = title.startsWith('Sleep Score')
      || title.startsWith('Mood Score')
      || title.toLowerCase().startsWith('calories');
    if (isMetric && (!c.source || c.source === 'task')) {
      c.source = 'metric';
    }
    return c;
  }

  function normalizeHexColor(value) {
    if (!value) return null;
    let hex = String(value).trim();
    if (!hex) return null;
    if (!hex.startsWith('#')) hex = `#${hex}`;
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return null;
    if (hex.length === 4) {
      hex = `#${hex.slice(1).split('').map((c) => c + c).join('')}`;
    }
    return hex.toLowerCase();
  }

  function normalizeHabitTagColors(value) {
    if (!value || typeof value !== 'object') return {};
    const next = {};
    Object.entries(value).forEach(([tag, color]) => {
      const normalized = normalizeHexColor(color);
      if (normalized) next[String(tag)] = normalized;
    });
    return next;
  }

  function normalizeHabit(habit) {
    if (!habit || typeof habit !== 'object') return habit;
    return {
      ...habit,
      tag: typeof habit.tag === 'string' ? habit.tag.trim() : ''
    };
  }

  function normalizeState(s) {
    return {
      tasks:       Array.isArray(s?.tasks)       ? s.tasks.map(normalizeTask)       : [],
      completions: Array.isArray(s?.completions) ? s.completions.map(normalizeCompletion) : [],
      players:     Array.isArray(s?.players)     ? s.players     : [],
      habits:      Array.isArray(s?.habits)      ? s.habits.map(normalizeHabit)      : [],
      flexActions: Array.isArray(s?.flexActions) ? s.flexActions : [],
      gameHistory: Array.isArray(s?.gameHistory) ? s.gameHistory : [],
      matchups:    Array.isArray(s?.matchups)    ? s.matchups    : [],
      schedule:    Array.isArray(s?.schedule)    ? s.schedule    : [],
      opponentDripSchedules: Array.isArray(s?.opponentDripSchedules) ? s.opponentDripSchedules : [],
      workHistory: Array.isArray(s?.workHistory) ? s.workHistory : [],
      youImageId:  typeof s?.youImageId === "string" ? s.youImageId : "",
      projects:    Array.isArray(s?.projects)    ? s.projects    : [],
      habitTagColors: normalizeHabitTagColors(s?.habitTagColors),
      scoringSettings: normalizeScoringSettings(s?.scoringSettings)
    };
  }

  function loadAppState(options = {}) {
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

    let state = normalizeState(parsed);
    const shouldSync = options.syncDerived !== false;
    const shouldPersist = options.persistSync !== false;
    let changed = false;

    if (shouldSync) {
      const derivedSync = syncDerivedPoints(state, { normalized: true });
      state = derivedSync.state;
      changed = changed || derivedSync.changed;

      const matchupSync = syncYouMatchups(state, { normalized: true });
      state = matchupSync.state;
      changed = changed || matchupSync.changed;
    }

    if (changed && shouldPersist) {
      mergeAndSaveState(state, { storageKey: STORAGE_KEY });
    }

    return { state, storageKeysFound };
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
    const merged = { ...(state || {}), ...normalized };
    const maxCompletions = Number.isFinite(limits.maxCompletions) ? limits.maxCompletions : 10000;
    const maxGameHistory = Number.isFinite(limits.maxGameHistory) ? limits.maxGameHistory : 2500;
    const maxMatchups = Number.isFinite(limits.maxMatchups) ? limits.maxMatchups : 2500;
    const maxWorkHistory = Number.isFinite(limits.maxWorkHistory) ? limits.maxWorkHistory : 2500;
    if (merged.completions.length > maxCompletions) {
      merged.completions = merged.completions.slice(0, maxCompletions);
    }
    if (merged.gameHistory.length > maxGameHistory) {
      merged.gameHistory = merged.gameHistory.slice(-maxGameHistory);
    }
    if (merged.matchups.length > maxMatchups) {
      merged.matchups = merged.matchups.slice(-maxMatchups);
    }
    if (merged.workHistory.length > maxWorkHistory) {
      merged.workHistory = merged.workHistory.slice(-maxWorkHistory);
    }

    return merged;
  }

  function capLimit(current, cap) {
    if (Number.isFinite(current)) return Math.min(current, cap);
    return cap;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function deepMerge(base, update) {
    if (!isPlainObject(base)) base = {};
    if (!isPlainObject(update)) return { ...base };
    const result = { ...base };
    Object.entries(update).forEach(([key, value]) => {
      if (value === undefined) return;
      const baseValue = result[key];
      if (isPlainObject(value) && isPlainObject(baseValue)) {
        result[key] = deepMerge(baseValue, value);
      } else {
        result[key] = value;
      }
    });
    return result;
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }

  function isDevMode(options = {}) {
    if (options.devMode === true) return true;
    if (typeof window === 'undefined') return false;
    const host = window.location?.hostname || '';
    return host === 'localhost' || host === '127.0.0.1';
  }

  const STICKY_KEYS = ['youImageId', 'habitTagColors'];

  function shouldAllowStickyOverwrite(key, options = {}) {
    if (key === 'scoringSettings') return Boolean(options.allowScoringSettingsOverwrite);
    if (options.allowStickyOverwrite) return true;
    if (options.allowStickyOverwriteKeys && options.allowStickyOverwriteKeys[key]) return true;
    if (Array.isArray(options.allowStickyOverwriteKeys) && options.allowStickyOverwriteKeys.includes(key)) return true;
    return false;
  }

  function isStickyEmptyValue(key, value) {
    if (value == null) return true;
    if (key === 'youImageId') {
      if (typeof value !== 'string') return true;
      return value.trim() === '';
    }
    if (key === 'habitTagColors' || key === 'scoringSettings') {
      if (!isPlainObject(value)) return true;
      return Object.keys(value).length === 0;
    }
    return false;
  }

  function getDefaultScoringSettings() {
    return normalizeScoringSettings({});
  }

  function hasMissingCustomScoringKeys(existing, incoming, defaults) {
    if (!isPlainObject(existing)) return false;
    const incomingObj = isPlainObject(incoming) ? incoming : {};
    const defaultsObj = isPlainObject(defaults) ? defaults : {};

    for (const [key, value] of Object.entries(existing)) {
      const hasDefault = Object.prototype.hasOwnProperty.call(defaultsObj, key);
      if (!hasDefault) {
        if (!Object.prototype.hasOwnProperty.call(incomingObj, key)) return true;
        continue;
      }
      const defaultValue = defaultsObj[key];
      if (isPlainObject(value) && isPlainObject(defaultValue)) {
        if (hasMissingCustomScoringKeys(value, incomingObj[key], defaultValue)) return true;
      }
    }
    return false;
  }

  function isScoringSettingsEmptyLike(incoming, existing) {
    if (incoming == null) return true;
    if (!isPlainObject(incoming)) return true;
    if (Object.keys(incoming).length === 0) return true;

    const defaults = getDefaultScoringSettings();
    const normalizedIncoming = normalizeScoringSettings(incoming);
    const missingCustom = hasMissingCustomScoringKeys(existing, incoming, defaults);
    const matchesDefaults = deepEqual(normalizedIncoming, defaults);

    return missingCustom || matchesDefaults;
  }

  function applyStickyKeyGuard({ existing, nextState, mergedSnapshot, options, storageKey }) {
    if (!nextState || typeof nextState !== 'object') return;
    STICKY_KEYS.forEach((key) => {
      const allowOverwrite = shouldAllowStickyOverwrite(key, options)
        || (key === 'habitTagColors' && options.allowHabitTagColorReset);
      if (allowOverwrite) return;
      if (!Object.prototype.hasOwnProperty.call(nextState, key)) return;

      const incoming = nextState[key];
      const shouldPreserve = isStickyEmptyValue(key, incoming);
      if (!shouldPreserve) return;

      if (isDevMode(options)) {
        console.warn(`TaskPointsCore: prevented sticky key "${key}" from being wiped`, {
          storageKey,
          incoming
        });
      }
      if (Object.prototype.hasOwnProperty.call(existing || {}, key)) {
        mergedSnapshot[key] = existing[key];
      } else {
        delete mergedSnapshot[key];
      }
    });
  }

  function mergeState(nextState, options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    const allowHabitTagColorReset = Boolean(options.allowHabitTagColorReset);
    let existing = {};
    if (options.existing && typeof options.existing === 'object') {
      existing = options.existing;
    } else {
      try {
        const raw = options.raw ?? localStorage.getItem(storageKey);
        existing = raw ? (JSON.parse(raw) || {}) : {};
      } catch (e) {
        console.warn('Failed to parse existing TaskPoints storage; saving fresh state.', e);
        existing = {};
      }
    }

    const mergedSnapshot = deepMerge(existing, nextState || {});
    applyStickyKeyGuard({ existing, nextState, mergedSnapshot, options, storageKey });
    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'habitTagColors')) {
      const nextColors = normalizeHabitTagColors(nextState?.habitTagColors);
      const existingColors = normalizeHabitTagColors(existing?.habitTagColors);
      const nextIsEmpty = Object.keys(nextColors).length === 0;
      const existingHasColors = Object.keys(existingColors).length > 0;

      if (allowHabitTagColorReset || shouldAllowStickyOverwrite('habitTagColors', options)) {
        mergedSnapshot.habitTagColors = nextColors;
      } else if (nextIsEmpty && existingHasColors) {
        mergedSnapshot.habitTagColors = existingColors;
      } else if (existingHasColors) {
        mergedSnapshot.habitTagColors = { ...existingColors, ...nextColors };
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'youImageId')) {
      const allowOverwrite = shouldAllowStickyOverwrite('youImageId', options);
      const incoming = nextState?.youImageId;
      if (!allowOverwrite && isStickyEmptyValue('youImageId', incoming)) {
        mergedSnapshot.youImageId = existing?.youImageId || '';
      } else if (typeof incoming === 'string') {
        mergedSnapshot.youImageId = incoming;
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'scoringSettings')) {
      const allowOverwrite = shouldAllowStickyOverwrite('scoringSettings', options);
      const incoming = nextState?.scoringSettings;
      const existingSettings = existing?.scoringSettings || {};
      const emptyLike = isScoringSettingsEmptyLike(incoming, existingSettings);

      if (!allowOverwrite && emptyLike) {
        if (isDevMode(options)) {
          console.warn('scoringSettings overwrite attempt', {
            prev: existingSettings,
            next: incoming,
            allowFlags: {
              allowScoringSettingsOverwrite: Boolean(options.allowScoringSettingsOverwrite),
              allowStickyOverwrite: Boolean(options.allowStickyOverwrite),
              allowStickyOverwriteKeys: options.allowStickyOverwriteKeys
            }
          });
          console.trace();
        }
        mergedSnapshot.scoringSettings = existingSettings;
      } else if (!allowOverwrite && isPlainObject(incoming)) {
        const mergedSettings = deepMerge(existingSettings, incoming);
        mergedSnapshot.scoringSettings = normalizeScoringSettings(mergedSettings);
      } else if (allowOverwrite && isPlainObject(incoming)) {
        const normalizedIncoming = normalizeScoringSettings(incoming);
        mergedSnapshot.scoringSettings = deepMerge(existingSettings, normalizedIncoming);
      } else if (allowOverwrite && incoming == null) {
        mergedSnapshot.scoringSettings = existingSettings;
      }
    }

    const normalized = normalizeState(mergedSnapshot);
    const merged = { ...mergedSnapshot, ...normalized };

    return { state: merged, storageKey };
  }

  function saveStateSnapshot(state, options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    const attemptSave = (candidate, trimmed) => {
      localStorage.setItem(storageKey, JSON.stringify(candidate));
      return { state: candidate, trimmed };
    };

    try {
      return attemptSave(state, false);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }

    const trimmed = pruneStateForStorage(state, options.limits);
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
      const tightened = pruneStateForStorage(state, tightenedLimits);
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
      workHistory: []
    };

    return attemptSave(emergency, true);
  }

  function mergeAndSaveState(nextState, options = {}) {
    const merged = mergeState(nextState, options);
    return saveStateSnapshot(merged.state, { ...options, storageKey: merged.storageKey });
  }

  function saveAppState(nextState, options = {}, maybeOptions = {}) {
    if (typeof nextState === 'string') {
      return mergeAndSaveState(options || {}, { ...maybeOptions, storageKey: nextState });
    }
    return mergeAndSaveState(nextState || {}, options || {});
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

  function sleepBonus(score, settings) {
    const scoring = getScoringSettings(settings);
    const tiers = scoring.sleep.bonusTiers || [];
    const numScore = Number(score);
    if (!Number.isFinite(numScore)) return 0;
    for (const tier of tiers) {
      if (numScore >= tier.min) return tier.bonus;
    }
    return 0;
  }

  function getSleepInfo(entry) {
    const title = typeof entry?.title === 'string' ? entry.title : '';
    const match = title.match(/^Sleep Score\s*\((\d+(?:\.\d+)?)\)/i);
    const score = match ? Number(match[1]) : null;

    const restedRaw = entry && Object.prototype.hasOwnProperty.call(entry, 'sleepRested')
      ? Number(entry.sleepRested)
      : 0;
    const rested = Number.isFinite(restedRaw) ? restedRaw : 0;

    return { score, rested };
  }

  function sleepPoints(score, rested = 0, settings) {
    if (!Number.isFinite(score)) return 0;
    const scoring = getScoringSettings(settings);
    const sleep = scoring.sleep;
    const base = (score / sleep.baseDivisor) * sleep.baseMultiplier + sleep.baseOffset;
    const bonus = sleepBonus(score, scoring);
    const restedValue = Number.isFinite(rested) ? rested : 0;
    return base + bonus + (restedValue * sleep.restedMultiplier);
  }

  function getWorkInfo(entry) {
    const title = typeof entry?.title === 'string' ? entry.title : '';
    const match = title.match(/^Work Score\s*\((\d+(?:\.\d+)?)\)/i);
    const score = match ? Number(match[1]) : null;

    const hoursRaw = entry && Object.prototype.hasOwnProperty.call(entry, 'workHours')
      ? Number(entry.workHours)
      : 0;
    const hours = Number.isFinite(hoursRaw) ? hoursRaw : 0;

    return { score, hours };
  }

  function workHoursBonus(hours = 0, settings) {
    const scoring = getScoringSettings(settings);
    const work = scoring.work;
    let hoursValue = Number.isFinite(hours) ? hours : 0;
    if (Number.isFinite(work.hoursMin)) {
      hoursValue = Math.max(work.hoursMin, hoursValue);
    }
    if (Number.isFinite(work.hoursMax)) {
      hoursValue = Math.min(work.hoursMax, hoursValue);
    }
    return (hoursValue * work.hoursMultiplier) + work.hoursOffset;
  }

  function workPoints(score, hours = 0, settings) {
    if (!Number.isFinite(score)) return 0;
    const scoring = getScoringSettings(settings);
    const work = scoring.work;
    const base = (score * work.baseMultiplier) + work.baseOffset;
    return base + workHoursBonus(hours, scoring);
  }

  function roundPoints(value, decimals = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
  }

  function addPoints(current, delta, decimals = 2) {
    return roundPoints((Number(current) || 0) + (Number(delta) || 0), decimals);
  }

  function parseCaloriesFromTitle(title) {
    if (typeof title !== 'string') return null;
    const match = title.match(/calories[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
    if (!match) return null;
    const raw = Number(match[1]);
    return Number.isFinite(raw) ? raw : null;
  }

  function getMoodInfo(entry) {
    const title = typeof entry?.title === 'string' ? entry.title : '';
    const match = title.match(/^Mood Score\s*\(([-0-9]+(?:\.\d+)?)\)/i);
    const score = match ? Number(match[1]) : null;
    return { score };
  }

  function moodPoints(score, settings) {
    if (!Number.isFinite(score)) return 0;
    const scoring = getScoringSettings(settings);
    const mood = scoring.mood;
    let points = (score * mood.multiplier) + mood.offset;
    if (Number.isFinite(mood.minPoints)) {
      points = Math.max(mood.minPoints, points);
    }
    if (Number.isFinite(mood.maxPoints)) {
      points = Math.min(mood.maxPoints, points);
    }
    return points;
  }

  function deriveCompletionPoints(entry, settings) {
    if (!entry) return null;
    const scoring = getScoringSettings(settings);
    const sleepInfo = getSleepInfo(entry);
    if (Number.isFinite(sleepInfo.score)) {
      return {
        points: roundPoints(sleepPoints(sleepInfo.score, sleepInfo.rested, scoring)),
        formula: 'sleep',
        inputs: sleepInfo
      };
    }

    const workInfo = getWorkInfo(entry);
    if (Number.isFinite(workInfo.score)) {
      return {
        points: roundPoints(workPoints(workInfo.score, workInfo.hours, scoring)),
        formula: 'work',
        inputs: workInfo
      };
    }

    const caloriesRaw = parseCaloriesFromTitle(entry.title);
    if (Number.isFinite(caloriesRaw)) {
      return {
        points: caloriesToPoints(caloriesRaw, scoring),
        formula: 'calories',
        inputs: { calories: caloriesRaw }
      };
    }

    const title = typeof entry?.title === 'string' ? entry.title : '';
    const entryPoints = Number(entry?.points);
    if (/^calories\b/i.test(title) && Number.isFinite(entryPoints) && entryPoints > 50 && entryPoints < 10000) {
      return {
        points: caloriesToPoints(entryPoints, scoring),
        formula: 'calories',
        inputs: { calories: entryPoints }
      };
    }

    const moodInfo = getMoodInfo(entry);
    if (Number.isFinite(moodInfo.score)) {
      return {
        points: roundPoints(moodPoints(moodInfo.score, scoring)),
        formula: 'mood',
        inputs: moodInfo
      };
    }

    return null;
  }

  function pointsForCompletion(entry, settings) {
    const derived = deriveCompletionPoints(entry, settings);
    if (derived) return derived.points;
    return roundPoints(entry?.points);
  }

  function caloriesToPoints(cal, settings){
    const scoring = getScoringSettings(settings);
    const calories = scoring.calories;
    let pts = ((calories.target - cal) / 100) * calories.pointsPer100;

    if (Number.isFinite(calories.minPoints)) {
      pts = Math.max(calories.minPoints, pts);
    }
    if (Number.isFinite(calories.maxPoints)) {
      pts = Math.min(calories.maxPoints, pts);
    }

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

  function aggregateCompletionsByDate(completions, settings){
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

      const pts = pointsForCompletion(c, settings);

      dailyTotals[dk]   = addPoints(dailyTotals[dk], pts);
      weeklyTotals[wk]  = addPoints(weeklyTotals[wk], pts);
      monthlyTotals[mk] = addPoints(monthlyTotals[mk], pts);
    });

    return { dailyTotals, weeklyTotals, monthlyTotals };
  }

  function computeInertia(dailyTotals, todayK, settings){
    const scoring = getScoringSettings(settings);
    const inertiaSettings = scoring.inertia;
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

      for (let i = 1; i <= inertiaSettings.windowDays; i++) {
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
      const inertia = count ? average * inertiaSettings.multiplier : 0;

      inertiaMap.set(k, { inertia, average });
      const base = Number(dailyTotals[k]) || 0;
      totalsWithInertia.set(k, base + inertia);
    });

    return inertiaMap.get(todayK) || { inertia: 0, average: 0 };
  }

  function deriveTodayWithInertia(dailyTotals, todayK, settings){
    const { inertia, average } = computeInertia(dailyTotals, todayK, settings);
    const todayBase = Number(dailyTotals[todayK]) || 0;
    const todayPoints = roundPoints(todayBase + inertia, 2);

    return { todayPoints, inertia, average, base: todayBase };
  }

  function buildDailyBreakdowns(state){
    const daily = {};
    const comps = Array.isArray(state?.completions) ? state.completions : [];
    const scoringSettings = state?.scoringSettings || state;

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

      const pts = pointsForCompletion(c, scoringSettings);
      if (!pts) return;

      const catKey = categorizeCompletion(c);
      daily[key].total = addPoints(daily[key].total, pts);
      daily[key].categories[catKey] = addPoints(daily[key].categories[catKey], pts);
    });

    const dailyTotals = Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, Number(v.total) || 0]));
    Object.keys(dailyTotals).forEach(k => {
      const { inertia } = computeInertia(dailyTotals, k, scoringSettings);
      if (!inertia) return;

      daily[k].total = addPoints(daily[k].total, inertia);
      daily[k].categories.inertia = addPoints(daily[k].categories.inertia, inertia);
    });

    return daily;
  }

  function buildRollups(state){
    const normalized = normalizeState(state || {});
    const { dailyTotals } = aggregateCompletionsByDate(normalized.completions, normalized);
    const dailyTotalsWithInertia = {};
    const weeklyTotalsWithInertia = {};
    const monthlyTotalsWithInertia = {};

    Object.entries(dailyTotals).forEach(([k, base]) => {
      const { inertia } = computeInertia(dailyTotals, k, normalized);
      const inertiaVal = Number.isFinite(inertia) ? inertia : 0;
      const total = addPoints(base, inertiaVal);
      dailyTotalsWithInertia[k] = total;

      const d = fromKey(k);
      if (!d || isNaN(d.getTime())) return;

      const wk = isoWeekKey(d);
      const mk = monthKey(d);
      weeklyTotalsWithInertia[wk]  = addPoints(weeklyTotalsWithInertia[wk], total);
      monthlyTotalsWithInertia[mk] = addPoints(monthlyTotalsWithInertia[mk], total);
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
      const pts = pointsForCompletion(c, normalized);
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

    const baseTotal = items.reduce((s, item) => addPoints(s, item.points), 0);
    const { dailyTotals } = aggregateCompletionsByDate(comps, normalized);
    const { inertia, average } = computeInertia(dailyTotals, key, normalized);
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
      byCategory[def.key] = 0;
    });
    byCategory.inertia = 0;

    snapshot.items.forEach(item => {
      const def = CATEGORY_DEFS.find(d => d.key === item.category) || CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
      const key = def.key;
      byCategory[key] = addPoints(byCategory[key], item.points);
    });

    if (snapshot.inertia) {
      byCategory.inertia = addPoints(byCategory.inertia, snapshot.inertia);
    }

    const rawTotal = addPoints(snapshot.baseTotal, snapshot.inertia || 0);
    const total = roundPoints(rawTotal, 2);
    const roundingNotes = Math.abs(rawTotal - total) > 1e-9
      ? [`Rounded to two decimal places from ${rawTotal}`]
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

  function isMatchupRevealed(dateKeyStr, options = {}){
    if (!dateKeyStr) return false;
    const includeToday = options.includeToday === true;
    const today = todayKey();
    if (includeToday) return dateKeyStr <= today;
    return dateKeyStr < today;
  }

  function youDailyTotalsWithInertia(state, options = {}){
    // Invariant: options.normalized is only set when state already passed through normalizeState().
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const { dailyTotals } = aggregateCompletionsByDate(normalized.completions, normalized);

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
      totals[key] = roundPoints(totalsForDay.total, 1);
    });

    return totals;
  }

  function syncDerivedPoints(state, options = {}){
    // Invariant: options.normalized is only set when state already passed through normalizeState().
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const mismatches = [];
    let changed = false;

    normalized.completions = (normalized.completions || []).map(c => {
      if (!c) return c;
      const derived = deriveCompletionPoints(c, normalized);
      if (!derived) return c;

      const storedRaw = Number(c.points);
      const stored = Number.isFinite(storedRaw) ? storedRaw : 0;
      const delta = derived.points - stored;
      if (Math.abs(delta) <= 0.01) return c;

      changed = true;
      mismatches.push({
        id: c.id || c.taskId || c.title,
        title: c.title,
        storedPoints: stored,
        derivedPoints: derived.points,
        delta,
        formula: derived.formula,
        inputs: derived.inputs
      });
      return { ...c, points: derived.points };
    });

    return { state: normalized, changed, mismatches };
  }

  function isPlayerActive(player) {
    return !!player && player.active !== false;
  }

  function activePlayerIds(state) {
    const ids = new Set(['YOU']);
    if (Array.isArray(state?.players)) {
      state.players.forEach((player) => {
        if (player && player.id && isPlayerActive(player)) {
          ids.add(player.id);
        }
      });
    }
    return ids;
  }

  function computeMatchupRecord(state, playerId, options = {}){
    const matchups = Array.isArray(state?.matchups) ? state.matchups : [];
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let games = 0;
    const activeIds = activePlayerIds(state);
    const includeToday = typeof options.includeToday === 'boolean'
      ? options.includeToday
      : (typeof options.includeUnrevealedToday === 'boolean' ? options.includeUnrevealedToday : false);

    if (playerId && !activeIds.has(playerId)) {
      return { wins, losses, ties, games, source: 'matchups' };
    }

    matchups.forEach(m => {
      if (!m) return;
      const key = matchupDateKey(m);
      if (!isMatchupRevealed(key, { includeToday })) return;
      const isA = m.playerAId === playerId;
      const isB = m.playerBId === playerId;
      if (!isA && !isB) return;

      const aScore = Number(m.scoreA);
      const bScore = Number(m.scoreB);
      if (!Number.isFinite(aScore) || !Number.isFinite(bScore)) return;

      games++;
      const playerScore = isA ? aScore : bScore;
      const oppScore = isA ? bScore : aScore;

      if (playerScore > oppScore) wins++;
      else if (playerScore < oppScore) losses++;
      else ties++;
    });

    return { wins, losses, ties, games, source: 'matchups' };
  }

  function computeCompletionRecord(state){
    const comps = Array.isArray(state?.completions) ? state.completions : [];
    if (!comps.length) {
      return { wins: 0, losses: 0, ties: 0, games: 0, source: 'completions' };
    }

    const dayTotals = {};
    comps.forEach(c => {
      if (!c || !c.completedAtISO) return;
      const k = dateKey(c.completedAtISO);
      const pts = pointsForCompletion(c, state);
      dayTotals[k] = addPoints(dayTotals[k], pts);
    });

    const totals = Object.values(dayTotals);
    if (!totals.length) {
      return { wins: 0, losses: 0, ties: 0, games: 0, source: 'completions' };
    }

    const avg = totals.reduce((a, b) => a + b, 0) / totals.length || 0;
    let wins = 0;
    let losses = 0;
    let ties = 0;

    totals.forEach(total => {
      if (total > avg) wins++;
      else if (total < avg) losses++;
      else ties++;
    });

    return { wins, losses, ties, games: totals.length, source: 'completions' };
  }

  function computeGameHistoryRecord(state, playerId){
    const history = Array.isArray(state?.gameHistory) ? state.gameHistory : [];
    const activeIds = activePlayerIds(state);
    if (playerId && !activeIds.has(playerId)) {
      return { wins: 0, losses: 0, ties: 0, games: 0, source: 'gameHistory' };
    }
    const players = Array.isArray(state?.players) ? state.players : [];
    const player = players.find(p => p && p.id === playerId);
    const baseline = typeof player?.baseline === 'number'
      ? player.baseline
      : Number(player?.baseline) || 0;

    let games = 0;
    let wins = 0;
    let losses = 0;

    history.forEach(g => {
      if (!g || g.playerId !== playerId) return;
      games++;
      const score = typeof g.score === 'number' ? g.score : Number(g.score) || 0;
      if (baseline) {
        if (score >= baseline) wins++;
        else losses++;
      }
    });

    return { wins, losses, ties: 0, games, source: 'gameHistory' };
  }

  function computeRecord(state, playerId = 'YOU', options = {}){
    const includeToday = typeof options.includeToday === 'boolean'
      ? options.includeToday
      : (typeof options.includeUnrevealedToday === 'boolean' ? options.includeUnrevealedToday : false);
    const allowFallback = options.allowFallback !== false;
    const matchupRecord = computeMatchupRecord(state, playerId, { includeToday });
    if (matchupRecord.games > 0) return matchupRecord;
    if (!allowFallback) return matchupRecord;
    if (playerId === 'YOU') return computeCompletionRecord(state);
    return computeGameHistoryRecord(state, playerId);
  }

  function syncYouMatchups(state, options = {}){
    // Invariant: options.normalized is only set when state already passed through normalizeState().
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const youTotals = youDailyTotalsWithInertia(normalized, { normalized: true });

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
    IMAGE_DB_NAME,
    IMAGE_STORE_NAME,
    CATEGORY_DEFS,
    DEFAULT_SCORING_SETTINGS,
    normalizeTask,
    normalizeScoringSettings,
    getScoringSettings,
    normalizeState,
    loadAppState,
    pruneStateForStorage,
    mergeState,
    saveStateSnapshot,
    mergeAndSaveState,
    saveAppState,
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
    roundPoints,
    deriveCompletionPoints,
    pointsForCompletion,
    syncDerivedPoints,
    computeMatchupRecord,
    computeCompletionRecord,
    computeGameHistoryRecord,
    computeRecord,
    caloriesToPoints,
    moodPoints,
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
    isMatchupRevealed,
    generateImageId,
    dataUrlToBlob,
    saveImageBlob,
    getImageBlob,
    deleteImageBlob,
    migrateLegacyImages,
    migrateLegacyImagesInStorage,
  };
})(window);
