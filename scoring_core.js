(function(global){
  const STORAGE_KEY = "taskpoints_v1";
  const PROJECTS_STORAGE_KEY = "tp_projects_v1";
  const IMAGE_DB_NAME = "taskpoints";
  const IMAGE_STORE_NAME = "images";
  const QUARANTINE_SNAPSHOT_KEY = "taskpoints_quarantined_snapshot";
  const QUARANTINE_INLINE_MAX_BYTES = 200 * 1024;
  const BACKUP_SLOT_KEYS = [
    "taskpoints_backup_latest",
    "taskpoints_backup_prev1",
    "taskpoints_backup_prev2",
    "taskpoints_backup_prev3"
  ];

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

  const CAL_LOG_BONUS_POINTS = 2;
  const CAL_LOG_BONUS_SOURCE = 'cal_log_bonus';


  const SEASON_STATUSES = ['preview', 'locked', 'active', 'champion_crowned', 'finalized'];
  const JUNE_2026_SEASON_DATE_WINDOWS = [
    { id: 'play_in', startDate: '2026-06-01', endDate: '2026-06-03', displayName: 'Play-In', bestOf: 3 },
    { id: 'round_of_32', startDate: '2026-06-04', endDate: '2026-06-08', displayName: 'Round of 32', bestOf: 5 },
    { id: 'sweet_16', startDate: '2026-06-09', endDate: '2026-06-13', displayName: 'Sweet 16', bestOf: 5 },
    { id: 'quarterfinals', startDate: '2026-06-14', endDate: '2026-06-18', displayName: 'Quarterfinals', bestOf: 5 },
    { id: 'semifinals', startDate: '2026-06-19', endDate: '2026-06-23', displayName: 'Semifinals', bestOf: 5 },
    { id: 'finals', startDate: '2026-06-24', endDate: '2026-06-30', displayName: 'Finals', bestOf: 7 }
  ];
  const DEFAULT_SEASON_NAME = 'June 2026 TaskPoints Championship';
  const DEFAULT_SEASON_MONTH_KEY = '2026-06';

  function isSeasonObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeSeasonArray(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function normalizeSeasonObjectMap(value) {
    return isSeasonObject(value) ? { ...value } : {};
  }

  function isSeasonMonthKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value.trim());
  }

  function dateFromLocalDateKey(dateKeyStr) {
    const parts = String(dateKeyStr || '').split('-').map(Number);
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return new Date(NaN);
    const [year, month, day] = parts;
    return new Date(year, month - 1, day);
  }

  function getLocalMonthEndDateKey(monthKeyStr) {
    if (!isSeasonMonthKey(monthKeyStr)) return '';
    const [year, month] = String(monthKeyStr).split('-').map(Number);
    return dateKey(new Date(year, month, 0));
  }

  function getSeasonMonthBoundaryKeys(monthKeyStr) {
    const month = isSeasonMonthKey(monthKeyStr) ? String(monthKeyStr).trim() : DEFAULT_SEASON_MONTH_KEY;
    return { startDate: `${month}-01`, endDate: getLocalMonthEndDateKey(month) || `${month}-30` };
  }

  function adjacentLocalDateKey(dateKeyStr, offsetDays) {
    const date = dateFromLocalDateKey(dateKeyStr);
    if (!date || Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + Number(offsetDays || 0));
    return dateKey(date);
  }

  function shouldRepairSeasonBoundary(existing, expected, kind) {
    if (typeof existing !== 'string' || !existing) return true;
    if (existing === expected) return false;
    if (kind === 'start' && existing === adjacentLocalDateKey(expected, -1)) return true;
    if (kind === 'end' && existing === adjacentLocalDateKey(expected, -1)) return true;
    return false;
  }

  function normalizeSeasonDateFields(season, monthKeyStr) {
    const bounds = getSeasonMonthBoundaryKeys(monthKeyStr);
    const startDate = shouldRepairSeasonBoundary(season?.startDate, bounds.startDate, 'start') ? bounds.startDate : season.startDate;
    const endDate = shouldRepairSeasonBoundary(season?.endDate, bounds.endDate, 'end') ? bounds.endDate : season.endDate;
    const startDateKey = shouldRepairSeasonBoundary(season?.startDateKey, bounds.startDate, 'start') ? bounds.startDate : season.startDateKey;
    const endDateKey = shouldRepairSeasonBoundary(season?.endDateKey, bounds.endDate, 'end') ? bounds.endDate : season.endDateKey;
    return { startDate, endDate, startDateKey, endDateKey };
  }

  function normalizeSeasonState(season) {
    if (!isSeasonObject(season)) return null;
    const month = isSeasonMonthKey(season.monthKey)
      ? season.monthKey.trim()
      : (isSeasonMonthKey(season.month) ? season.month.trim() : DEFAULT_SEASON_MONTH_KEY);
    const dateFields = normalizeSeasonDateFields(season, month);
    const name = typeof season.name === 'string' && season.name.trim()
      ? season.name.trim()
      : DEFAULT_SEASON_NAME;
    const id = typeof season.id === 'string' && season.id.trim()
      ? season.id.trim()
      : buildSeasonId(name, month);
    const status = SEASON_STATUSES.includes(season.status) ? season.status : 'preview';

    return {
      ...season,
      id,
      name,
      label: typeof season.label === 'string' ? season.label : name,
      monthKey: month,
      month: typeof season.month === 'string' ? season.month : month,
      startDate: dateFields.startDate,
      endDate: dateFields.endDate,
      startDateKey: dateFields.startDateKey,
      endDateKey: dateFields.endDateKey,
      status,
      createdAtISO: typeof season.createdAtISO === 'string' ? season.createdAtISO : '',
      updatedAtISO: typeof season.updatedAtISO === 'string' ? season.updatedAtISO : '',
      playerPool: normalizeSeasonArray(season.playerPool),
      seedMode: typeof season.seedMode === 'string' ? season.seedMode : 'standings',
      seeds: normalizeSeasonArray(season.seeds),
      bracket: normalizeSeasonObjectMap(season.bracket),
      series: normalizeSeasonObjectMap(season.series),
      dailyTournamentResults: normalizeSeasonObjectMap(season.dailyTournamentResults),
      championSummary: isSeasonObject(season.championSummary) ? { ...season.championSummary } : null,
      finalPlacements: normalizeSeasonArray(season.finalPlacements),
      warnings: normalizeSeasonArray(season.warnings),
      meta: { seasonMatchupControlEnabled: false, ...normalizeSeasonObjectMap(season.meta) }
    };
  }

  function normalizeSeasonHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.map(normalizeSeasonState).filter(Boolean);
  }

  function normalizeCurrentSeason(season) {
    return normalizeSeasonState(season);
  }

  function getSeasonRoundDefs() {
    return JUNE_2026_SEASON_DATE_WINDOWS.map((round) => ({ ...round }));
  }

  function getSeasonDateWindows() {
    return getSeasonRoundDefs();
  }

  function getSeasonRoundForDate(dateKey) {
    if (typeof dateKey !== 'string') return null;
    return JUNE_2026_SEASON_DATE_WINDOWS.find((round) => dateKey >= round.startDate && dateKey <= round.endDate) || null;
  }

  function getSeasonSeriesLength(roundId) {
    const round = JUNE_2026_SEASON_DATE_WINDOWS.find((item) => item.id === roundId);
    return round ? round.bestOf : null;
  }

  function getSeasonDisplayName(roundId) {
    const round = JUNE_2026_SEASON_DATE_WINDOWS.find((item) => item.id === roundId);
    return round ? round.displayName : '';
  }

  function isSeasonDate(dateKey) {
    return Boolean(getSeasonRoundForDate(dateKey));
  }

  function isJuneSeasonDate(dateKey) {
    return isSeasonDate(dateKey);
  }

  function buildSeasonId(name, monthKey) {
    const slug = String(name || 'season')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'season';
    const month = String(monthKey || '').trim().replace(/[^0-9-]/g, '') || DEFAULT_SEASON_MONTH_KEY;
    return `${month}-${slug}`;
  }

  function createEmptySeasonDraft(options = {}) {
    const nowISO = typeof options.nowISO === 'string' ? options.nowISO : new Date().toISOString();
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : DEFAULT_SEASON_NAME;
    const monthKey = isSeasonMonthKey(options.monthKey) ? options.monthKey.trim() : DEFAULT_SEASON_MONTH_KEY;
    const dateBounds = getSeasonMonthBoundaryKeys(monthKey);
    const draft = {
      id: typeof options.id === 'string' && options.id.trim() ? options.id.trim() : buildSeasonId(name, monthKey),
      name,
      label: typeof options.label === 'string' ? options.label : name,
      monthKey,
      month: typeof options.month === 'string' ? options.month : monthKey,
      startDate: typeof options.startDate === 'string' ? options.startDate : dateBounds.startDate,
      endDate: typeof options.endDate === 'string' ? options.endDate : dateBounds.endDate,
      startDateKey: typeof options.startDateKey === 'string' ? options.startDateKey : (typeof options.startDate === 'string' ? options.startDate : dateBounds.startDate),
      endDateKey: typeof options.endDateKey === 'string' ? options.endDateKey : (typeof options.endDate === 'string' ? options.endDate : dateBounds.endDate),
      status: SEASON_STATUSES.includes(options.status) ? options.status : 'preview',
      createdAtISO: typeof options.createdAtISO === 'string' ? options.createdAtISO : nowISO,
      updatedAtISO: typeof options.updatedAtISO === 'string' ? options.updatedAtISO : nowISO,
      playerPool: Array.isArray(options.playerPool) ? options.playerPool.slice() : [],
      seedMode: typeof options.seedMode === 'string' ? options.seedMode : 'standings',
      seeds: Array.isArray(options.seeds) ? options.seeds.slice() : [],
      bracket: isSeasonObject(options.bracket) ? { ...options.bracket } : {},
      series: isSeasonObject(options.series) ? { ...options.series } : {},
      dailyTournamentResults: isSeasonObject(options.dailyTournamentResults) ? { ...options.dailyTournamentResults } : {},
      championSummary: isSeasonObject(options.championSummary) ? { ...options.championSummary } : null,
      finalPlacements: Array.isArray(options.finalPlacements) ? options.finalPlacements.slice() : [],
      warnings: Array.isArray(options.warnings) ? options.warnings.slice() : [],
      meta: { seasonMatchupControlEnabled: false, ...(isSeasonObject(options.meta) ? options.meta : {}) }
    };
    return normalizeSeasonState(draft);
  }


  const OFFICIAL_SEASON_ROUND_COUNTS = {
    play_in: 2,
    round_of_32: 16,
    sweet_16: 8,
    quarterfinals: 4,
    semifinals: 2,
    finals: 1
  };
  const OFFICIAL_ROUND_OF_32_PAIRINGS = [
    [1, 'play_in_lowest'], [16, 17], [8, 25], [9, 24],
    [4, 29], [13, 20], [5, 28], [12, 21],
    [2, 'play_in_other'], [15, 18], [7, 26], [10, 23],
    [3, 30], [14, 19], [6, 27], [11, 22]
  ];
  const OFFICIAL_SEASON_ROUND_ORDER = ['play_in', 'round_of_32', 'sweet_16', 'quarterfinals', 'semifinals', 'finals'];

  function seasonNowISO(options = {}) {
    return typeof options.nowISO === 'string' ? options.nowISO : new Date().toISOString();
  }

  function sanitizeOfficialSeasonId(options = {}) {
    return typeof options.seasonId === 'string' && options.seasonId.trim()
      ? options.seasonId.trim()
      : buildSeasonId(options.name || DEFAULT_SEASON_NAME, options.monthKey || DEFAULT_SEASON_MONTH_KEY);
  }

  function seedEntryForOfficial(seeds, seedNumber) {
    const row = (Array.isArray(seeds) ? seeds : []).find((seed) => Number(seed?.seed) === Number(seedNumber));
    if (!row) return null;
    const playerId = row.playerId || row.id || '';
    return {
      playerId,
      playerName: row.playerName || row.name || playerId || `Seed ${seedNumber}`,
      seed: Number(seedNumber)
    };
  }

  function officialRoundDef(roundId) {
    return JUNE_2026_SEASON_DATE_WINDOWS.find((round) => round.id === roundId) || { id: roundId, displayName: getSeasonDisplayName(roundId) || roundId, bestOf: 5 };
  }

  function officialSeriesId(seasonId, roundId, seriesIndex) {
    return `${seasonId}_${roundId}_${seriesIndex}`;
  }

  function createOfficialSeries(options) {
    const round = officialRoundDef(options.roundId);
    const bestOf = Number(options.bestOf || round.bestOf || 5);
    const now = options.nowISO || seasonNowISO(options);
    const playerA = options.playerA || null;
    const playerB = options.playerB || null;
    return {
      id: options.id,
      seasonId: options.seasonId,
      roundId: options.roundId,
      roundName: round.displayName || getSeasonDisplayName(options.roundId) || options.roundId,
      roundIndex: Number(options.roundIndex) || 0,
      seriesIndex: Number(options.seriesIndex) || 1,
      bestOf,
      winsNeeded: Math.floor(bestOf / 2) + 1,
      status: options.status || (playerA?.playerId && playerB?.playerId ? 'active' : 'pending'),
      playerAId: playerA?.playerId || '',
      playerBId: playerB?.playerId || '',
      playerASeed: Number.isFinite(Number(playerA?.seed)) ? Number(playerA.seed) : null,
      playerBSeed: Number.isFinite(Number(playerB?.seed)) ? Number(playerB.seed) : null,
      playerAName: playerA?.playerName || '',
      playerBName: playerB?.playerName || '',
      placeholderA: options.placeholderA || '',
      placeholderB: options.placeholderB || '',
      winsA: 0,
      winsB: 0,
      winnerId: '',
      loserId: '',
      gameResults: [],
      nextSeriesId: options.nextSeriesId || '',
      nextSlot: options.nextSlot === 'B' ? 'B' : (options.nextSlot === 'A' ? 'A' : ''),
      createdAtISO: now,
      updatedAtISO: now
    };
  }

  function setSeriesSlot(series, slot, player, options = {}) {
    if (!series || !player) return series;
    const next = { ...series };
    const prefix = slot === 'B' ? 'B' : 'A';
    next[`player${prefix}Id`] = player.playerId || player.id || '';
    next[`player${prefix}Seed`] = Number.isFinite(Number(player.seed)) ? Number(player.seed) : null;
    next[`player${prefix}Name`] = player.playerName || player.name || player.playerId || player.id || '';
    next[`placeholder${prefix}`] = '';
    next.updatedAtISO = seasonNowISO(options);
    if (next.playerAId && next.playerBId && next.status === 'pending') next.status = 'active';
    return next;
  }

  function buildOfficialSeasonBracketFromSeeds(seeds, options = {}) {
    const seasonId = sanitizeOfficialSeasonId(options);
    const now = seasonNowISO(options);
    const rounds = OFFICIAL_SEASON_ROUND_ORDER.map((roundId, roundIndex) => {
      const round = officialRoundDef(roundId);
      return {
        id: roundId,
        displayName: round.displayName,
        roundIndex,
        bestOf: round.bestOf,
        seriesIds: Array.from({ length: OFFICIAL_SEASON_ROUND_COUNTS[roundId] || 0 }, (_, index) => officialSeriesId(seasonId, roundId, index + 1))
      };
    });
    return {
      type: 'official_34_player_championship',
      seasonId,
      lockedAtISO: now,
      generatedAtISO: now,
      roundOrder: OFFICIAL_SEASON_ROUND_ORDER.slice(),
      rounds,
      playInProtection: 'lowest_remaining_play_in_winner_faces_seed_1',
      roundOf32Pairings: OFFICIAL_ROUND_OF_32_PAIRINGS.map((pair) => pair.slice())
    };
  }

  function createOfficialSeasonSeriesFromSeeds(seeds, options = {}) {
    const seasonId = sanitizeOfficialSeasonId(options);
    const now = seasonNowISO(options);
    const series = {};
    const add = (entry) => { series[entry.id] = entry; return entry; };
    const nextFor = (roundId, index) => {
      const nextRoundMap = { round_of_32: 'sweet_16', sweet_16: 'quarterfinals', quarterfinals: 'semifinals', semifinals: 'finals' };
      const nextRoundId = nextRoundMap[roundId];
      if (!nextRoundId) return { nextSeriesId: '', nextSlot: '' };
      const nextIndex = Math.ceil(index / 2);
      return { nextSeriesId: officialSeriesId(seasonId, nextRoundId, nextIndex), nextSlot: index % 2 === 1 ? 'A' : 'B' };
    };

    [[31, 34], [32, 33]].forEach((pair, index) => {
      add(createOfficialSeries({
        id: officialSeriesId(seasonId, 'play_in', index + 1), seasonId, roundId: 'play_in', roundIndex: 0, seriesIndex: index + 1,
        bestOf: 3, status: 'active', playerA: seedEntryForOfficial(seeds, pair[0]), playerB: seedEntryForOfficial(seeds, pair[1]), nowISO: now
      }));
    });

    OFFICIAL_ROUND_OF_32_PAIRINGS.forEach((pair, index) => {
      const next = nextFor('round_of_32', index + 1);
      const playerA = typeof pair[0] === 'number' ? seedEntryForOfficial(seeds, pair[0]) : null;
      const playerB = typeof pair[1] === 'number' ? seedEntryForOfficial(seeds, pair[1]) : null;
      add(createOfficialSeries({
        id: officialSeriesId(seasonId, 'round_of_32', index + 1), seasonId, roundId: 'round_of_32', roundIndex: 1, seriesIndex: index + 1,
        bestOf: 5, status: 'pending', playerA, playerB, placeholderA: playerA ? '' : 'Awaiting winner',
        placeholderB: pair[1] === 'play_in_lowest' ? 'Lowest Play-In winner' : (pair[1] === 'play_in_other' ? 'Other Play-In winner' : (playerB ? '' : 'Awaiting winner')),
        nowISO: now, ...next
      }));
    });

    ['sweet_16', 'quarterfinals', 'semifinals', 'finals'].forEach((roundId, roundOffset) => {
      const count = OFFICIAL_SEASON_ROUND_COUNTS[roundId];
      for (let index = 1; index <= count; index += 1) {
        const next = nextFor(roundId, index);
        const priorRound = roundId === 'sweet_16' ? 'round_of_32' : roundId === 'quarterfinals' ? 'sweet_16' : roundId === 'semifinals' ? 'quarterfinals' : 'semifinals';
        const priorA = officialSeriesId(seasonId, priorRound, index * 2 - 1);
        const priorB = officialSeriesId(seasonId, priorRound, index * 2);
        add(createOfficialSeries({
          id: officialSeriesId(seasonId, roundId, index), seasonId, roundId, roundIndex: roundOffset + 2, seriesIndex: index,
          bestOf: roundId === 'finals' ? 7 : 5, status: 'pending', placeholderA: `Winner of Series ${priorA}`, placeholderB: `Winner of Series ${priorB}`,
          nowISO: now, ...next
        }));
      }
    });
    return series;
  }

  function lockSeasonPreviewToOfficialBracket(state, options = {}) {
    const normalized = normalizeState(state || {});
    const currentSeason = normalizeSeasonState(normalized.currentSeason || createEmptySeasonDraft(options));
    const seasonId = currentSeason.id || sanitizeOfficialSeasonId(options);
    const now = seasonNowISO(options);
    const seeds = Array.isArray(currentSeason.seeds) ? currentSeason.seeds.map((seed, index) => ({ ...seed, seed: index + 1 })) : [];
    const bracket = buildOfficialSeasonBracketFromSeeds(seeds, { ...options, seasonId, name: currentSeason.name, monthKey: currentSeason.monthKey, nowISO: now });
    const series = createOfficialSeasonSeriesFromSeeds(seeds, { ...options, seasonId, name: currentSeason.name, monthKey: currentSeason.monthKey, nowISO: now });
    const nextSeason = normalizeSeasonState({
      ...currentSeason,
      status: 'locked',
      seeds,
      bracket,
      series,
      seedMode: currentSeason.seedMode,
      warnings: Array.isArray(currentSeason.warnings) ? currentSeason.warnings.slice() : [],
      updatedAtISO: now,
      meta: { ...(currentSeason.meta || {}), previewOnly: false, officialBracketCreatedAtISO: now, seedsLocked: true }
    });
    return normalizeState({ ...normalized, currentSeason: nextSeason, latestSeasonId: nextSeason.id || normalized.latestSeasonId || '' });
  }

  function getSeasonSeriesWinner(series) {
    if (!series || typeof series !== 'object') return null;
    if (series.winnerId) return series.winnerId;
    const winsNeeded = Number(series.winsNeeded) || (Math.floor((Number(series.bestOf) || 1) / 2) + 1);
    const winsA = Number(series.winsA) || 0;
    const winsB = Number(series.winsB) || 0;
    if (winsA >= winsNeeded && winsA > winsB) return series.playerAId || null;
    if (winsB >= winsNeeded && winsB > winsA) return series.playerBId || null;
    return null;
  }

  function isSeasonSeriesComplete(series) {
    return Boolean(getSeasonSeriesWinner(series)) || series?.status === 'complete';
  }

  function seasonSeriesCompetitor(series, slot) {
    const prefix = slot === 'B' ? 'B' : 'A';
    return {
      playerId: series?.[`player${prefix}Id`] || '',
      playerName: series?.[`player${prefix}Name`] || '',
      seed: series?.[`player${prefix}Seed`]
    };
  }

  function recordSeasonSeriesGameResult(season, seriesId, gameResult, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const series = nextSeason.series?.[seriesId];
    if (!series) return { ok: false, error: 'series_not_found', season: nextSeason };
    if (series.status === 'complete') return { ok: false, error: 'series_already_complete', season: nextSeason, series };
    const winnerId = gameResult?.winnerId;
    if (!winnerId || (winnerId !== series.playerAId && winnerId !== series.playerBId)) return { ok: false, error: 'invalid_or_ambiguous_winner', season: nextSeason, series };
    const loserId = winnerId === series.playerAId ? series.playerBId : series.playerAId;
    if (!loserId || (gameResult?.loserId && gameResult.loserId !== loserId)) return { ok: false, error: 'invalid_or_ambiguous_loser', season: nextSeason, series };
    const results = Array.isArray(series.gameResults) ? series.gameResults.slice() : [];
    const matchupId = typeof gameResult?.matchupId === 'string' ? gameResult.matchupId : '';
    const dateKey = typeof gameResult?.dateKey === 'string' ? gameResult.dateKey : '';
    const duplicate = results.some((result) => (matchupId && result.matchupId === matchupId) || (!matchupId && dateKey && result.dateKey === dateKey));
    if (duplicate) return { ok: false, error: 'duplicate_game_result', season: nextSeason, series };
    const now = seasonNowISO(options);
    const nextSeries = {
      ...series,
      winsA: (Number(series.winsA) || 0) + (winnerId === series.playerAId ? 1 : 0),
      winsB: (Number(series.winsB) || 0) + (winnerId === series.playerBId ? 1 : 0),
      gameResults: results.concat({
        dateKey,
        matchupId,
        winnerId,
        loserId,
        playerAScore: gameResult?.playerAScore,
        playerBScore: gameResult?.playerBScore,
        source: gameResult?.source === 'matchup' ? 'matchup' : 'manual',
        recordedAtISO: now
      }),
      updatedAtISO: now
    };
    const winner = getSeasonSeriesWinner(nextSeries);
    if (winner) {
      nextSeries.status = 'complete';
      nextSeries.winnerId = winner;
      nextSeries.loserId = winner === nextSeries.playerAId ? nextSeries.playerBId : nextSeries.playerAId;
    }
    nextSeason.series = { ...(nextSeason.series || {}), [seriesId]: nextSeries };
    nextSeason.updatedAtISO = now;
    return { ok: true, season: nextSeason, series: nextSeries, complete: nextSeries.status === 'complete' };
  }

  function findSeasonSeedEntryByPlayerId(season, playerId) {
    return (Array.isArray(season?.seeds) ? season.seeds : []).find((seed) => (seed?.playerId || seed?.id) === playerId) || null;
  }

  function withSeasonSeedFallback(season, competitor) {
    const seedRow = findSeasonSeedEntryByPlayerId(season, competitor?.playerId);
    return {
      playerId: competitor?.playerId || seedRow?.playerId || seedRow?.id || '',
      playerName: competitor?.playerName || seedRow?.playerName || seedRow?.name || competitor?.playerId || '',
      seed: Number.isFinite(Number(competitor?.seed)) ? Number(competitor.seed) : (Number.isFinite(Number(seedRow?.seed)) ? Number(seedRow.seed) : null)
    };
  }

  function findRoundOf32ProtectedSeries(season, seedNumber, fallbackIndex) {
    const playerId = (Array.isArray(season?.seeds) ? season.seeds : []).find((seed) => Number(seed?.seed) === Number(seedNumber))?.playerId || '';
    const r32 = Object.values(season?.series || {}).filter((series) => series?.roundId === 'round_of_32');
    return r32.find((series) => Number(series?.playerASeed) === Number(seedNumber) || Number(series?.playerBSeed) === Number(seedNumber) || (playerId && (series?.playerAId === playerId || series?.playerBId === playerId)))
      || r32.sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0))[fallbackIndex]
      || null;
  }

  function setProtectedPlayInOpponent(series, protectedSeedNumber, player, options = {}) {
    if (!series || !player?.playerId) return series;
    const slot = Number(series.playerASeed) === Number(protectedSeedNumber) ? 'B' : (Number(series.playerBSeed) === Number(protectedSeedNumber) ? 'A' : 'B');
    return setSeriesSlot(series, slot, player, options);
  }

  function repairPlayInAdvancementForSeason(season, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const allSeries = nextSeason.series || {};
    const nextSeries = { ...allSeries };
    let changed = false;
    const playIn = Object.values(allSeries).filter((series) => series?.roundId === 'play_in').sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));
    if (playIn.length < 2) return { ok: false, error: 'play_in_series_missing', season: nextSeason };

    const winners = [];
    playIn.forEach((series) => {
      const recalculatedRaw = Array.isArray(series?.gameResults) && series.gameResults.length ? recalculateSeasonSeriesFromGameResults(series, options) : series;
      const recalculated = (Number(recalculatedRaw?.winsA) || 0) === (Number(series?.winsA) || 0)
        && (Number(recalculatedRaw?.winsB) || 0) === (Number(series?.winsB) || 0)
        && String(recalculatedRaw?.winnerId || '') === String(series?.winnerId || '')
        && String(recalculatedRaw?.loserId || '') === String(series?.loserId || '')
        && String(recalculatedRaw?.status || '') === String(series?.status || '')
        ? series
        : recalculatedRaw;
      const winnerId = getSeasonSeriesWinner(recalculated);
      let repairedSeries = recalculated;
      if (winnerId && (recalculated.winnerId !== winnerId || recalculated.status !== 'complete')) {
        repairedSeries = {
          ...recalculated,
          winnerId,
          loserId: winnerId === recalculated.playerAId ? recalculated.playerBId : recalculated.playerAId,
          status: 'complete',
          updatedAtISO: seasonNowISO(options)
        };
      }
      if (JSON.stringify(repairedSeries) !== JSON.stringify(series)) {
        nextSeries[series.id] = repairedSeries;
        changed = true;
      }
      if (winnerId) {
        const slot = winnerId === repairedSeries.playerAId ? 'A' : 'B';
        const competitor = withSeasonSeedFallback(nextSeason, seasonSeriesCompetitor(repairedSeries, slot));
        if (competitor.playerId && Number.isFinite(Number(competitor.seed))) winners.push(competitor);
      }
    });

    if (winners.length < 2) {
      nextSeason.series = nextSeries;
      if (changed) nextSeason.updatedAtISO = seasonNowISO(options);
      return { ok: false, error: 'play_in_not_complete', season: nextSeason, changed };
    }

    winners.sort((a, b) => (Number(b.seed) || 0) - (Number(a.seed) || 0));
    const worseSeedWinner = winners[0];
    const otherWinner = winners[1];
    const seed1Series = findRoundOf32ProtectedSeries({ ...nextSeason, series: nextSeries }, 1, 0);
    const seed2Series = findRoundOf32ProtectedSeries({ ...nextSeason, series: nextSeries }, 2, 8);
    if (!seed1Series || !seed2Series) return { ok: false, error: 'round_of_32_slots_missing', season: nextSeason, changed };

    const now = seasonNowISO(options);
    const repairedSeed1 = setProtectedPlayInOpponent(seed1Series, 1, worseSeedWinner, { nowISO: now });
    const repairedSeed2 = setProtectedPlayInOpponent(seed2Series, 2, otherWinner, { nowISO: now });
    if (JSON.stringify(repairedSeed1) !== JSON.stringify(seed1Series)) { nextSeries[seed1Series.id] = repairedSeed1; changed = true; }
    if (JSON.stringify(repairedSeed2) !== JSON.stringify(seed2Series)) { nextSeries[seed2Series.id] = repairedSeed2; changed = true; }
    nextSeason.series = nextSeries;
    if (changed) nextSeason.updatedAtISO = now;
    if (changed && global.console && typeof global.console.info === 'function') {
      console.info('[Season repair] Resolved Play-In winners into Round of 32', { seed1Opponent: worseSeedWinner, seed2Opponent: otherWinner });
    }
    return { ok: true, season: nextSeason, changed, seed1Opponent: worseSeedWinner, seed2Opponent: otherWinner };
  }

  function resolvePlayInWinnersIntoRoundOf32(season, options = {}) {
    return repairPlayInAdvancementForSeason(season, options);
  }

  function repairPlayInAdvancementForCurrentSeason(state, options = {}) {
    const normalized = normalizeState(state || {});
    const repaired = repairPlayInAdvancementForSeason(normalized.currentSeason, options);
    if (!repaired.season) return { ok: false, state: normalized, changed: false, error: repaired.error || 'invalid_season' };
    const changed = Boolean(repaired.changed);
    return {
      ...repaired,
      state: changed ? normalizeState({ ...normalized, currentSeason: repaired.season, latestSeasonId: repaired.season.id || normalized.latestSeasonId || '' }) : normalized,
      changed
    };
  }

  function advanceSeasonSeriesWinner(season, seriesId, options = {}) {
    let nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const series = nextSeason.series?.[seriesId];
    if (!series) return { ok: false, error: 'series_not_found', season: nextSeason };
    const winnerId = getSeasonSeriesWinner(series);
    if (!winnerId) return { ok: false, error: 'series_not_complete', season: nextSeason, series };
    if (series.roundId === 'play_in') return resolvePlayInWinnersIntoRoundOf32(nextSeason, options);
    const slot = series.nextSlot;
    const nextSeriesId = series.nextSeriesId;
    if (!nextSeriesId || !slot) {
      if (series.roundId === 'finals') {
        const winner = seasonSeriesCompetitor(series, winnerId === series.playerAId ? 'A' : 'B');
        nextSeason.championSummary = { playerId: winner.playerId, playerName: winner.playerName, seed: winner.seed, sourceSeriesId: series.id };
        nextSeason.status = 'champion_crowned';
        nextSeason.updatedAtISO = seasonNowISO(options);
        return { ok: true, season: nextSeason, champion: winner };
      }
      return { ok: true, season: nextSeason, advanced: false };
    }
    const target = nextSeason.series?.[nextSeriesId];
    if (!target) return { ok: false, error: 'next_series_not_found', season: nextSeason, series };
    const winner = seasonSeriesCompetitor(series, winnerId === series.playerAId ? 'A' : 'B');
    nextSeason.series = { ...(nextSeason.series || {}), [nextSeriesId]: setSeriesSlot(target, slot, winner, options) };
    nextSeason.updatedAtISO = seasonNowISO(options);
    return { ok: true, season: nextSeason, advanced: true, nextSeries: nextSeason.series[nextSeriesId] };
  }

  function getCurrentSeasonRoundIdForDate(dateKey) {
    return getSeasonRoundForDate(dateKey)?.id || '';
  }

  function getActiveSeasonSeriesForDate(season, dateKey) {
    const roundId = getCurrentSeasonRoundIdForDate(dateKey);
    if (!roundId || !season?.series) return [];

    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);
    const seasonControlEnabled = season?.meta?.seasonMatchupControlEnabled === true;

    return Object.values(season.series)
      .filter((series) => {
        if (!series || series.status !== 'active' || isSeasonSeriesComplete(series)) return false;
        if (!series.playerAId || !series.playerBId) return false;

        if (series.roundId === roundId) return true;

        const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series.roundId);
        return seasonControlEnabled
          && currentRoundIndex >= 0
          && seriesRoundIndex >= 0
          && seriesRoundIndex < currentRoundIndex;
      })
      .sort((a, b) =>
        (Number(a.roundIndex) || 0) - (Number(b.roundIndex) || 0)
        || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0)
      );
  }


  function prepareSeasonForDailySlate(season, dateKeyStr, options = {}) {
    const normalized = normalizeSeasonState(season);
    if (!normalized) return { season: normalized, changed: false, activatedSeriesIds: [] };
    const roundId = getCurrentSeasonRoundIdForDate(dateKeyStr);
    if (!roundId || !normalized.series) return { season: normalized, changed: false, activatedSeriesIds: [] };
    const now = seasonNowISO(options);
    const nextSeries = { ...(normalized.series || {}) };
    const activatedSeriesIds = [];
    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);
    const seasonControlEnabled = normalized?.meta?.seasonMatchupControlEnabled === true;
    Object.values(normalized.series || {}).forEach((series) => {
      if (!series || series.status !== 'pending') return;
      if (!series.playerAId || !series.playerBId) return;
      const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series.roundId);
      const isCurrentRound = series.roundId === roundId;
      const isOverduePriorRound = seasonControlEnabled
        && currentRoundIndex >= 0
        && seriesRoundIndex >= 0
        && seriesRoundIndex < currentRoundIndex;
      if (!isCurrentRound && !isOverduePriorRound) return;
      nextSeries[series.id] = { ...series, status: 'active', updatedAtISO: now };
      activatedSeriesIds.push(series.id);
    });
    if (!activatedSeriesIds.length) return { season: normalized, changed: false, activatedSeriesIds };
    return {
      season: normalizeSeasonState({ ...normalized, series: nextSeries, updatedAtISO: now }),
      changed: true,
      activatedSeriesIds
    };
  }

  function getSeasonScheduleSignature(stateOrSeason, dateKeyStr) {
    if (!dateKeyStr) return '';
    const directSeason = stateOrSeason?.series && !stateOrSeason?.currentSeason
      ? normalizeSeasonState(stateOrSeason)
      : null;
    const normalized = directSeason ? null : normalizeState(stateOrSeason || {});
    const seasonGateOpen = directSeason
      ? directSeason.meta?.seasonMatchupControlEnabled === true && isJuneSeasonDate(dateKeyStr)
      : shouldUseSeasonMatchupControl(normalized, dateKeyStr);
    if (!seasonGateOpen) return '';

    const prepared = prepareSeasonForDailySlate(directSeason || normalized.currentSeason, dateKeyStr);
    const season = prepared.season || directSeason || normalized.currentSeason;
    const activeSeries = getActiveSeasonSeriesForDate(season, dateKeyStr);
    const seriesRevision = activeSeries
      .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
      .map((series) => [
        series.id,
        series.roundId || '',
        series.status,
        series.playerAId,
        series.playerBId,
        Number(series.winsA) || 0,
        Number(series.winsB) || 0,
        Number(series.bestOf) || 0,
        Number(series.winsNeeded) || 0,
        series.winnerId || '',
        Array.isArray(series.gameResults) ? series.gameResults.map((result) => `${result.matchupId || ''}:${result.dateKey || ''}:${result.winnerId || ''}:${result.playerAScore ?? ''}:${result.playerBScore ?? ''}`).join(',') : ''
      ].join('~'))
      .join('|');
    return [season?.id || '', getCurrentSeasonRoundIdForDate(dateKeyStr), season?.meta?.seasonMatchupControlEnabled === true ? 'on' : 'off', seriesRevision].join('::');
  }

  function isValidSeasonControlledScheduleDay(state, dateKeyStr, scheduleDay) {
    const normalized = normalizeState(state || {});
    if (!shouldUseSeasonMatchupControl(normalized, dateKeyStr)) return false;
    if (!scheduleDay || scheduleDay.seasonMatchupControl !== true) return false;
    const expectedSignature = getSeasonScheduleSignature(normalized, dateKeyStr);
    if (!expectedSignature || scheduleDay.seasonScheduleSignature !== expectedSignature) return false;
    const matchups = Array.isArray(scheduleDay.matchups) ? scheduleDay.matchups : [];
    if (!matchups.length) return false;
    const seasonId = normalized.currentSeason?.id || '';
    const validMatchupRows = matchups.every((matchup) => matchup && matchup.seasonId === seasonId && matchup.dateKey === dateKeyStr && (matchup.matchupType === 'tournament' || matchup.matchupType === 'exhibition'));
    if (!validMatchupRows) return false;
    const tournamentSeriesIds = new Set(matchups
      .filter((matchup) => matchup?.matchupType === 'tournament' || matchup?.matchupType === 'season')
      .map((matchup) => getRecordedSeriesId(matchup))
      .filter(Boolean));
    const prepared = prepareSeasonForDailySlate(normalized.currentSeason, dateKeyStr);
    const season = prepared.season || normalized.currentSeason;
    return getActiveSeasonSeriesForDate(season, dateKeyStr)
      .every((series) => tournamentSeriesIds.has(series.id));
  }


  function shouldRegenerateScheduleDayForSeasonControl(state, dateKeyStr, scheduleDay) {
    const normalized = normalizeState(state || {});
    return shouldUseSeasonMatchupControl(normalized, dateKeyStr)
      && !isValidSeasonControlledScheduleDay(normalized, dateKeyStr, scheduleDay);
  }

  function getSeriesStatusText(series) {
    if (!series) return 'Series unavailable';
    if (!series.playerAId || !series.playerBId) return 'Awaiting opponent';
    if (series.status === 'complete') {
      const winnerName = series.winnerId === series.playerAId ? series.playerAName : series.winnerId === series.playerBId ? series.playerBName : 'Winner';
      return `${winnerName || 'Winner'} wins series ${Number(series.winsA) || 0}–${Number(series.winsB) || 0}`;
    }
    const a = Number(series.winsA) || 0;
    const b = Number(series.winsB) || 0;
    if (a === b) return a === 0 ? `Series tied 0–0` : `Series tied ${a}–${b}`;
    const leader = a > b ? (series.playerAName || 'Player A') : (series.playerBName || 'Player B');
    return `${leader} leads series ${Math.max(a, b)}–${Math.min(a, b)}`;
  }

  function getWinnerFacesText(season, series) {
    if (!series) return 'Winner faces: TBD';
    if (series.roundId === 'play_in') return 'Winner enters Round of 32 with Play-In protection';
    if (!series.nextSeriesId || !series.nextSlot) return series.roundId === 'finals' ? 'Winner becomes champion candidate' : 'Winner faces: TBD';
    const next = season?.series?.[series.nextSeriesId];
    if (!next) return 'Winner faces: TBD';
    const oppositeSlot = series.nextSlot === 'A' ? 'B' : 'A';
    const name = next[`player${oppositeSlot}Name`] || next[`placeholder${oppositeSlot}`] || 'TBD';
    return `Winner faces: ${name}`;
  }

  function normalizeSeasonPlayerId(playerId) {
    return String(playerId || '').trim();
  }

  function getSeasonPlayerDisplayName(state, playerId) {
    const id = normalizeSeasonPlayerId(playerId);
    if (!id) return 'TBD';
    const normalized = normalizeState(state || {});
    if (id === 'YOU') return normalized.youName || 'Miggy';
    const seed = (normalized.currentSeason?.seeds || []).find((entry) => (entry?.playerId || entry?.id) === id);
    if (seed?.playerName || seed?.name) return seed.playerName || seed.name;
    const player = (normalized.players || []).find((entry) => entry?.id === id || entry?.playerId === id);
    return player?.name || id;
  }

  function getSeriesPlayerLabel(series, slot) {
    const prefix = slot === 'B' ? 'B' : 'A';
    const seed = series?.[`player${prefix}Seed`];
    const name = series?.[`player${prefix}Name`] || series?.[`player${prefix}Id`];
    if (name) return `${Number.isFinite(Number(seed)) ? `#${Number(seed)} ` : ''}${name}`;
    return series?.[`placeholder${prefix}`] || 'Awaiting opponent';
  }

  function getSeriesCompactTitle(series) {
    if (!series) return 'Series unavailable';
    return `${getSeriesPlayerLabel(series, 'A')} vs ${getSeriesPlayerLabel(series, 'B')}`;
  }

  function getSeriesGameNumber(series, dateKeyStr) {
    if (!series) return null;
    const results = Array.isArray(series.gameResults) ? series.gameResults : [];
    const sameDate = typeof dateKeyStr === 'string' && dateKeyStr
      ? results.find((result) => result?.dateKey === dateKeyStr)
      : null;
    if (sameDate) {
      const index = results.indexOf(sameDate);
      return index >= 0 ? index + 1 : null;
    }
    if (isSeasonSeriesComplete(series)) return null;
    const next = results.length + 1;
    const bestOf = Number(series.bestOf) || 1;
    return next <= bestOf ? next : null;
  }

  function getCurrentSeriesGameNumberForHome(series, dateKeyStr) {
    if (!series) return 1;
    const hasWinsA = series.winsA !== undefined && series.winsA !== null && series.winsA !== '';
    const hasWinsB = series.winsB !== undefined && series.winsB !== null && series.winsB !== '';
    const winsA = Number(series.winsA);
    const winsB = Number(series.winsB);
    if (hasWinsA && hasWinsB && Number.isFinite(winsA) && Number.isFinite(winsB) && winsA >= 0 && winsB >= 0) {
      const derivedGameNumber = Math.floor(winsA) + Math.floor(winsB) + 1;
      if (Number.isFinite(derivedGameNumber) && derivedGameNumber >= 1) return derivedGameNumber;
    }

    const fallback = Number(series.gameNumber)
      || Number(series.currentGameNumber)
      || Number(series.seriesGameNumber)
      || Number(getSeriesGameNumber(series, dateKeyStr))
      || 1;
    return Math.max(1, fallback);
  }

  function isSeasonEliminationGame(series) {
    if (!series || isSeasonSeriesComplete(series) || !series.playerAId || !series.playerBId) return false;
    const winsNeeded = Number(series.winsNeeded) || Math.floor((Number(series.bestOf) || 1) / 2) + 1;
    return (Number(series.winsA) || 0) === winsNeeded - 1 || (Number(series.winsB) || 0) === winsNeeded - 1;
  }

  function getSeasonSeriesEntries(season) {
    return Object.values(season?.series || {}).filter(Boolean).sort((a, b) => {
      const ar = Number(a?.roundIndex) || 0;
      const br = Number(b?.roundIndex) || 0;
      if (ar !== br) return ar - br;
      return (Number(a?.seriesIndex) || 0) - (Number(b?.seriesIndex) || 0);
    });
  }

  function getFeaturedSeasonMatchup(season, dateKeyStr, state = {}) {
    const entries = getSeasonSeriesEntries(season).filter((series) => series && !isSeasonSeriesComplete(series) && series.playerAId && series.playerBId);
    if (!entries.length) return null;
    const activeRoundId = getCurrentSeasonRoundIdForDate(dateKeyStr) || '';
    const todayMatchups = (Array.isArray(state?.matchups) ? state.matchups : []).filter((matchup) => matchup?.matchupType === 'tournament' && matchup?.dateKey === dateKeyStr && matchup?.seriesId);
    const todaySeriesIds = new Set(todayMatchups.map((matchup) => matchup.seriesId));
    const candidates = entries.map((series) => ({
      series,
      today: todaySeriesIds.has(series.id) || (!!activeRoundId && series.roundId === activeRoundId),
      seedSum: (Number(series.playerASeed) || 99) + (Number(series.playerBSeed) || 99),
      upsetThreat: Math.abs((Number(series.playerASeed) || 99) - (Number(series.playerBSeed) || 99)),
      tied: (Number(series.winsA) || 0) === (Number(series.winsB) || 0) && ((Number(series.winsA) || 0) + (Number(series.winsB) || 0) > 0),
      elimination: isSeasonEliminationGame(series)
    }));
    const byOrder = (a, b) => {
      if (a.today !== b.today) return a.today ? -1 : 1;
      if (a.series.roundId === 'finals' && b.series.roundId !== 'finals') return -1;
      if (b.series.roundId === 'finals' && a.series.roundId !== 'finals') return 1;
      if (a.series.roundIndex !== b.series.roundIndex) return (Number(b.series.roundIndex) || 0) - (Number(a.series.roundIndex) || 0);
      return (Number(a.series.seriesIndex) || 0) - (Number(b.series.seriesIndex) || 0);
    };
    const priorityGroups = [
      (item) => item.series.roundId === 'finals' && item.today,
      (item) => item.elimination && item.today,
      (item) => item.tied && item.today,
      (item) => item.today,
      (item) => true
    ];
    for (let i = 0; i < priorityGroups.length; i += 1) {
      let group = candidates.filter(priorityGroups[i]);
      if (!group.length) continue;
      if (i === 3) group = group.sort((a, b) => b.upsetThreat - a.upsetThreat || a.seedSum - b.seedSum || byOrder(a, b));
      else if (i === 4) group = group.sort((a, b) => a.seedSum - b.seedSum || byOrder(a, b));
      else group = group.sort(byOrder);
      const chosen = group[0];
      return {
        series: chosen.series,
        title: getSeriesCompactTitle(chosen.series),
        roundName: chosen.series.roundName || getSeasonDisplayName(chosen.series.roundId),
        statusText: getSeriesStatusText(chosen.series),
        gameNumber: getCurrentSeriesGameNumberForHome(chosen.series, dateKeyStr),
        isEliminationGame: isSeasonEliminationGame(chosen.series)
      };
    }
    return null;
  }

  function findUserSeasonPlayerId(state) {
    const normalized = normalizeState(state || {});
    if ((normalized.currentSeason?.seeds || []).some((seed) => seed?.playerId === 'YOU')) return 'YOU';
    const miggySeed = (normalized.currentSeason?.seeds || []).find((seed) => String(seed?.playerName || seed?.name || '').toLowerCase() === 'miggy');
    if (miggySeed?.playerId) return miggySeed.playerId;
    const miggyPlayer = (normalized.players || []).find((player) => String(player?.name || '').toLowerCase() === 'miggy');
    if (miggyPlayer?.id) return miggyPlayer.id;
    return 'YOU';
  }

  function getUserSeasonStatus(season, dateKeyStr, state = {}) {
    if (!season) return { playerId: '', playerName: 'You', statusText: 'No active Season Championship.' };
    const normalized = normalizeState({ ...(state || {}), currentSeason: season });
    const playerId = findUserSeasonPlayerId(normalized);
    const playerName = getSeasonPlayerDisplayName(normalized, playerId);
    const entries = getSeasonSeriesEntries(season);
    const active = entries.find((series) => !isSeasonSeriesComplete(series) && series.playerAId && series.playerBId && (series.playerAId === playerId || series.playerBId === playerId));
    if (active) {
      const gameNumber = getCurrentSeriesGameNumberForHome(active, dateKeyStr);
      const title = getSeriesCompactTitle(active).replace(/^#\d+\s+/, '').replace(/ vs #\d+\s+/g, ' vs ');
      return { playerId, playerName, series: active, statusText: `${title} — ${active.roundName || getSeasonDisplayName(active.roundId)}${gameNumber ? `, Game ${gameNumber}` : ''}`, detailText: getSeriesStatusText(active) };
    }
    const lost = entries.find((series) => isSeasonSeriesComplete(series) && series.loserId === playerId);
    if (lost) {
      const winnerName = lost.winnerId === lost.playerAId ? lost.playerAName : lost.playerBName;
      return { playerId, playerName, series: lost, eliminated: true, statusText: `${playerName} is eliminated — lost in ${lost.roundName || getSeasonDisplayName(lost.roundId)} to ${winnerName || 'TBD'}`, detailText: getSeriesStatusText(lost) };
    }
    const awaiting = entries.find((series) => !isSeasonSeriesComplete(series) && (series.playerAId === playerId || series.playerBId === playerId || series.placeholderA || series.placeholderB));
    if (awaiting && (awaiting.playerAId === playerId || awaiting.playerBId === playerId)) {
      return { playerId, playerName, series: awaiting, awaiting: true, statusText: `${playerName} is awaiting opponent`, detailText: getWinnerFacesText(season, awaiting) };
    }
    const exhibition = (Array.isArray(normalized.matchups) ? normalized.matchups : []).find((matchup) => matchup?.dateKey === dateKeyStr && matchup?.matchupType === 'exhibition' && (matchup.playerAId === playerId || matchup.playerBId === playerId));
    if (exhibition) {
      const opponentId = exhibition.playerAId === playerId ? exhibition.playerBId : exhibition.playerAId;
      return { playerId, playerName, matchup: exhibition, exhibition: true, statusText: `Today: exhibition matchup vs ${getSeasonPlayerDisplayName(normalized, opponentId)}` };
    }
    return { playerId, playerName, statusText: `${playerName} has no tournament game today.`, detailText: '' };
  }

  function getEliminatedPlayers(season) {
    return getSeasonSeriesEntries(season)
      .filter((series) => isSeasonSeriesComplete(series) && series.loserId)
      .map((series) => {
        const loserSlot = series.loserId === series.playerAId ? 'A' : 'B';
        const winnerSlot = loserSlot === 'A' ? 'B' : 'A';
        return {
          playerId: series.loserId,
          playerName: series[`player${loserSlot}Name`] || series.loserId,
          seed: series[`player${loserSlot}Seed`],
          eliminatedById: series.winnerId,
          eliminatedByName: series[`player${winnerSlot}Name`] || series.winnerId || 'TBD',
          roundLost: series.roundName || getSeasonDisplayName(series.roundId) || series.roundId,
          seriesScore: `${Number(series.winsA) || 0}–${Number(series.winsB) || 0}`,
          roundIndex: Number(series.roundIndex) || 0
        };
      })
      .sort((a, b) => b.roundIndex - a.roundIndex || (Number(a.seed) || 99) - (Number(b.seed) || 99));
  }

  function getTournamentStatsForPlayer(season, state, playerId) {
    let wins = 0;
    let losses = 0;
    let totalPoints = 0;
    let games = 0;
    getSeasonSeriesEntries(season).forEach((series) => {
      (Array.isArray(series.gameResults) ? series.gameResults : []).forEach((result) => {
        const involved = series.playerAId === playerId || series.playerBId === playerId || result.winnerId === playerId || result.loserId === playerId;
        if (!involved) return;
        games += 1;
        if (result.winnerId === playerId) wins += 1;
        if (result.loserId === playerId) losses += 1;
        const score = series.playerAId === playerId ? Number(result.playerAScore) : series.playerBId === playerId ? Number(result.playerBScore) : NaN;
        if (Number.isFinite(score)) totalPoints += score;
      });
    });
    return { wins, losses, games, winPct: games ? wins / games : 0, totalPoints, averageScore: games ? totalPoints / games : null };
  }

  function getFinalPlacements(season, state = {}) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds : [];
    const eliminated = new Map(getEliminatedPlayers(season).map((entry) => [entry.playerId, entry]));
    const champion = getChampionSummary(season, state).championId || '';
    return seeds.map((seed) => {
      const playerId = seed.playerId || seed.id || '';
      const stats = getTournamentStatsForPlayer(season, state, playerId);
      const elim = eliminated.get(playerId);
      const finishTier = champion && playerId === champion ? 0 : elim ? (10 - Number(elim.roundIndex || 0)) : 9;
      return { playerId, playerName: seed.playerName || seed.name || playerId, seed: seed.seed, finishTier, finish: champion && playerId === champion ? 'Champion' : (elim ? `Lost in ${elim.roundLost}` : 'Pending'), ...stats };
    }).sort((a, b) => a.finishTier - b.finishTier || b.winPct - a.winPct || b.wins - a.wins || (Number(b.averageScore) || 0) - (Number(a.averageScore) || 0) || (Number(b.totalPoints) || 0) - (Number(a.totalPoints) || 0) || (Number(a.seed) || 999) - (Number(b.seed) || 999));
  }

  function getChampionSummary(season, state = {}) {
    const finals = getSeasonSeriesEntries(season).find((series) => series?.roundId === 'finals' && isSeasonSeriesComplete(series));
    if (!finals) return { championId: '', championName: '', runnerUpId: '', runnerUpName: '', finalsResult: 'Finals pending', path: [] };
    const championId = getSeasonSeriesWinner(finals) || finals.winnerId || '';
    const runnerUpId = finals.loserId || (championId === finals.playerAId ? finals.playerBId : finals.playerAId) || '';
    const championName = championId === finals.playerAId ? finals.playerAName : championId === finals.playerBId ? finals.playerBName : championId || 'Champion';
    const runnerUpName = runnerUpId === finals.playerAId ? finals.playerAName : runnerUpId === finals.playerBId ? finals.playerBName : runnerUpId || 'Runner-up';
    const stats = getTournamentStatsForPlayer(season, state, championId);
    const path = getSeasonSeriesEntries(season)
      .filter((series) => isSeasonSeriesComplete(series) && series.winnerId === championId)
      .map((series) => {
        const loserId = series.loserId || (championId === series.playerAId ? series.playerBId : series.playerAId);
        const opponentName = loserId === series.playerAId ? series.playerAName : loserId === series.playerBId ? series.playerBName : loserId || 'TBD';
        return { roundName: series.roundName || getSeasonDisplayName(series.roundId), opponentName, score: `${Number(series.winsA) || 0}–${Number(series.winsB) || 0}` };
      });
    return { championId, championName, runnerUpId, runnerUpName, finalsResult: `${championName} defeats ${runnerUpName}, ${Number(finals.winsA) || 0}–${Number(finals.winsB) || 0}`, record: `${stats.wins}–${stats.losses}`, ...stats, path };
  }

  function getSeasonChampionFromFinals(season) {
    const finals = getSeasonSeriesEntries(season).find((series) => series?.roundId === 'finals' && isSeasonSeriesComplete(series));
    if (!finals) return null;
    const championId = getSeasonSeriesWinner(finals) || finals.winnerId || '';
    if (!championId) return null;
    const slot = championId === finals.playerAId ? 'A' : championId === finals.playerBId ? 'B' : '';
    return {
      playerId: championId,
      playerName: slot ? finals[`player${slot}Name`] || championId : championId,
      seed: slot ? finals[`player${slot}Seed`] : null,
      seriesId: finals.id,
      finals
    };
  }

  function getSeasonFinalPlacements(season, state = {}) {
    return getFinalPlacements(season, state);
  }

  function getSeasonFinalsSeries(season) {
    return getSeasonSeriesEntries(season).find((series) => series?.roundId === 'finals') || null;
  }

  function canFinalizeSeason(season, state = {}, dateKeyStr = '') {
    const normalized = normalizeSeasonState(season);
    if (!normalized) return false;
    const finals = getSeasonFinalsSeries(normalized);
    if (!finals || !isSeasonSeriesComplete(finals)) return false;
    return Boolean(getSeasonChampionFromFinals(normalized));
  }

  function buildSeriesArchiveResult(series) {
    if (!series) return null;
    const winnerSlot = series.winnerId === series.playerAId ? 'A' : series.winnerId === series.playerBId ? 'B' : '';
    const loserSlot = series.loserId === series.playerAId ? 'A' : series.loserId === series.playerBId ? 'B' : '';
    return {
      id: series.id || '',
      roundId: series.roundId || '',
      roundName: series.roundName || getSeasonDisplayName(series.roundId) || series.roundId || '',
      roundIndex: Number(series.roundIndex) || 0,
      seriesIndex: Number(series.seriesIndex) || 0,
      bestOf: Number(series.bestOf) || null,
      winsA: Number(series.winsA) || 0,
      winsB: Number(series.winsB) || 0,
      status: series.status || '',
      playerAId: series.playerAId || '',
      playerAName: series.playerAName || '',
      playerASeed: series.playerASeed ?? null,
      playerBId: series.playerBId || '',
      playerBName: series.playerBName || '',
      playerBSeed: series.playerBSeed ?? null,
      winnerId: series.winnerId || '',
      winnerName: winnerSlot ? series[`player${winnerSlot}Name`] || series.winnerId || '' : '',
      loserId: series.loserId || '',
      loserName: loserSlot ? series[`player${loserSlot}Name`] || series.loserId || '' : '',
      resultText: series.winnerId ? getSeriesStatusText(series) : `${Number(series.winsA) || 0}–${Number(series.winsB) || 0}`,
      gameResults: Array.isArray(series.gameResults) ? series.gameResults.map((result) => ({ ...result })) : []
    };
  }

  function collectTournamentMatchupResults(state, season) {
    const seasonId = season?.id || '';
    return (Array.isArray(state?.matchups) ? state.matchups : [])
      .filter((matchup) => matchup?.seasonId === seasonId && matchup?.matchupType === 'tournament')
      .map((matchup) => ({ ...matchup }));
  }

  function buildSeasonArchiveEntry(season, state = {}) {
    const normalized = normalizeSeasonState(season);
    if (!normalized) return null;
    const summary = getChampionSummary(normalized, { ...(state || {}), currentSeason: normalized });
    const finals = getSeasonFinalsSeries(normalized);
    const placements = getSeasonFinalPlacements(normalized, { ...(state || {}), currentSeason: normalized });
    const seriesResults = getSeasonSeriesEntries(normalized).map(buildSeriesArchiveResult).filter(Boolean);
    const tournamentMatchupResults = collectTournamentMatchupResults(state || {}, normalized);
    const nowISO = seasonNowISO({});
    return normalizeSeasonState({
      ...normalized,
      status: 'finalized',
      archivedAtISO: nowISO,
      finalizedAtISO: nowISO,
      championSummary: summary,
      championId: summary.championId || '',
      championName: summary.championName || '',
      runnerUpId: summary.runnerUpId || '',
      runnerUpName: summary.runnerUpName || '',
      finalsResult: summary.finalsResult || '',
      finalsSeries: finals ? buildSeriesArchiveResult(finals) : null,
      seriesResults,
      originalSeeds: Array.isArray(normalized.seeds) ? normalized.seeds.map((seed) => ({ ...seed })) : [],
      finalPlacements: placements,
      tournamentStats: placements,
      tournamentMatchupResults,
      dailyTournamentResults: isSeasonObject(normalized.dailyTournamentResults) ? { ...normalized.dailyTournamentResults } : {}
    });
  }

  function finalizeCurrentSeason(state, options = {}) {
    const normalized = normalizeState(state || {});
    const season = normalizeSeasonState(normalized.currentSeason);
    if (!season) return { ok: false, error: 'no_current_season', state: normalized, archiveEntry: null };
    const dateKeyStr = typeof options.dateKey === 'string' ? options.dateKey : (typeof todayKey === 'function' ? todayKey() : '');
    if (!options.force && !canFinalizeSeason(season, normalized, dateKeyStr)) {
      return { ok: false, error: 'finals_not_complete', state: normalized, archiveEntry: null };
    }
    const archiveEntry = buildSeasonArchiveEntry(season, normalized);
    if (!archiveEntry) return { ok: false, error: 'archive_failed', state: normalized, archiveEntry: null };
    const history = normalizeSeasonHistory(normalized.seasonHistory)
      .filter((entry) => entry.id !== archiveEntry.id)
      .concat(archiveEntry);
    const nextState = normalizeState({
      ...normalized,
      currentSeason: null,
      latestSeasonId: archiveEntry.id,
      seasonHistory: history
    });
    return { ok: true, state: nextState, archiveEntry };
  }

  function updateSeasonSeriesManualResult(season, seriesId, patch = {}, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const series = nextSeason.series?.[seriesId];
    if (!series) return { ok: false, error: 'series_not_found', season: nextSeason };
    if (patch.clear === true) {
      const cleared = { ...series, winsA: 0, winsB: 0, winnerId: '', loserId: '', status: series.playerAId && series.playerBId ? 'active' : 'pending', updatedAtISO: seasonNowISO(options) };
      nextSeason.series = { ...(nextSeason.series || {}), [seriesId]: cleared };
      nextSeason.updatedAtISO = seasonNowISO(options);
      return { ok: true, season: nextSeason, series: cleared };
    }
    if (patch.recalculate === true) {
      const recalculated = recalculateSeasonSeriesFromGameResults(series, options);
      nextSeason.series = { ...(nextSeason.series || {}), [seriesId]: recalculated };
      nextSeason.updatedAtISO = seasonNowISO(options);
      return { ok: true, season: nextSeason, series: recalculated };
    }
    const winsA = Number.isFinite(Number(patch.winsA)) ? Math.max(0, Math.floor(Number(patch.winsA))) : (Number(series.winsA) || 0);
    const winsB = Number.isFinite(Number(patch.winsB)) ? Math.max(0, Math.floor(Number(patch.winsB))) : (Number(series.winsB) || 0);
    const winsNeeded = Number(series.winsNeeded) || Math.floor((Number(series.bestOf) || 1) / 2) + 1;
    let winnerId = typeof patch.winnerId === 'string' ? patch.winnerId : (series.winnerId || '');
    if (winnerId && winnerId !== series.playerAId && winnerId !== series.playerBId) winnerId = '';
    if (!winnerId && (winsA >= winsNeeded || winsB >= winsNeeded)) winnerId = winsA >= winsNeeded ? series.playerAId : series.playerBId;
    let status = series.playerAId && series.playerBId ? 'active' : 'pending';
    let loserId = '';
    if (winnerId) {
      status = 'complete';
      loserId = winnerId === series.playerAId ? series.playerBId : series.playerAId;
    }
    const updated = { ...series, winsA, winsB, winnerId, loserId, status, updatedAtISO: seasonNowISO(options) };
    nextSeason.series = { ...(nextSeason.series || {}), [seriesId]: updated };
    nextSeason.updatedAtISO = seasonNowISO(options);
    let advanced = null;
    if (patch.advance === true && winnerId) {
      advanced = advanceSeasonSeriesWinner(nextSeason, seriesId, options);
      if (advanced.ok) return { ok: true, season: advanced.season, series: advanced.season.series?.[seriesId] || updated, advanced };
    }
    return { ok: true, season: nextSeason, series: updated, advanced };
  }

  function assignSeasonBracketSlot(season, targetSeriesId, slot, playerId, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const target = nextSeason.series?.[targetSeriesId];
    if (!target) return { ok: false, error: 'series_not_found', season: nextSeason };
    const prefix = slot === 'B' ? 'B' : 'A';
    if (!playerId) {
      const cleared = { ...target, [`player${prefix}Id`]: '', [`player${prefix}Name`]: '', [`player${prefix}Seed`]: null, [`placeholder${prefix}`]: 'Awaiting winner', updatedAtISO: seasonNowISO(options) };
      if (!cleared.playerAId || !cleared.playerBId) cleared.status = 'pending';
      nextSeason.series = { ...(nextSeason.series || {}), [targetSeriesId]: cleared };
      nextSeason.updatedAtISO = seasonNowISO(options);
      return { ok: true, season: nextSeason, series: cleared };
    }
    const seed = (Array.isArray(nextSeason.seeds) ? nextSeason.seeds : []).find((entry) => (entry?.playerId || entry?.id) === playerId) || {};
    const poolPlayer = (Array.isArray(nextSeason.playerPool) ? nextSeason.playerPool : []).find((entry) => (entry?.id || entry?.playerId) === playerId) || {};
    const player = { playerId, playerName: seed.playerName || seed.name || poolPlayer.name || playerId, seed: seed.seed ?? null };
    const assigned = setSeriesSlot(target, prefix, player, options);
    nextSeason.series = { ...(nextSeason.series || {}), [targetSeriesId]: assigned };
    nextSeason.updatedAtISO = seasonNowISO(options);
    return { ok: true, season: nextSeason, series: assigned };
  }

  function recalculateAllSeasonSeriesFromGameResults(season, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const nextSeries = {};
    let changed = false;
    Object.entries(nextSeason.series || {}).forEach(([id, series]) => {
      if (!series) return;
      const recalculated = recalculateSeasonSeriesFromGameResults(series, options);
      nextSeries[id] = recalculated;
      if (JSON.stringify(recalculated) !== JSON.stringify(series)) changed = true;
    });
    nextSeason.series = nextSeries;
    nextSeason.updatedAtISO = seasonNowISO(options);
    return { ok: true, changed, season: nextSeason };
  }

  function repairSeasonDateRange(state, options = {}) {
    const normalized = normalizeState(state || {});
    let changed = false;
    const repairSeason = (season) => {
      const before = normalizeSeasonState(season);
      if (!before) return null;
      const after = normalizeSeasonState(before);
      if (JSON.stringify(after) !== JSON.stringify(before)) changed = true;
      return after;
    };
    const currentSeason = repairSeason(normalized.currentSeason);
    const seasonHistory = normalizeSeasonHistory(normalized.seasonHistory).map(repairSeason).filter(Boolean);
    const nextState = changed ? normalizeState({ ...normalized, currentSeason, seasonHistory }) : normalized;
    return { ok: true, state: nextState, changed };
  }

  function repairSeasonChampionshipData(state, options = {}) {
    const normalized = normalizeState(state || {});
    const cleanSeriesMap = (seriesMap) => {
      const cleaned = {};
      Object.entries(isSeasonObject(seriesMap) ? seriesMap : {}).forEach(([id, series]) => {
        if (!series || typeof series !== 'object') return;
        const seriesId = series.id || id;
        if (!seriesId || (!series.roundId && !series.playerAId && !series.playerBId && !series.placeholderA && !series.placeholderB)) return;
        cleaned[seriesId] = { ...series, id: seriesId };
      });
      return cleaned;
    };
    const repairSeason = (season) => {
      const fixed = normalizeSeasonState(season);
      if (!fixed) return null;
      let repaired = normalizeSeasonState({ ...fixed, series: cleanSeriesMap(fixed.series) });
      const playInRepair = repairPlayInAdvancementForSeason(repaired, options);
      if (playInRepair.season) repaired = playInRepair.season;
      return normalizeSeasonState(repaired);
    };
    const currentSeason = repairSeason(normalized.currentSeason);
    const seasonHistory = normalizeSeasonHistory(normalized.seasonHistory).map(repairSeason).filter(Boolean);
    return { ok: true, state: normalizeState({ ...normalized, currentSeason, seasonHistory }) };
  }





  function isSeasonOneJune2026Compatible(season) {
    if (!season) return false;
    const id = String(season.id || '').toLowerCase();
    return season.monthKey === DEFAULT_SEASON_MONTH_KEY
      || id === 'season_1_june_2026'
      || id.includes('june_2026')
      || id.includes('2026-06');
  }

  function shouldUseSeasonMatchupControl(state, dateKeyStr) {
    const normalized = normalizeState(state || {});
    const season = normalized.currentSeason;
    const seriesEntries = Object.values(season?.series || {});
    const playerPool = getActiveSeasonPlayerPool(normalized);
    return Boolean(
      season
      && isSeasonOneJune2026Compatible(season)
      && ['locked', 'active', 'champion_crowned'].includes(season.status)
      && season.meta?.seasonMatchupControlEnabled === true
      && isJuneSeasonDate(dateKeyStr)
      && seriesEntries.length > 0
      && playerPool.length >= 2
    );
  }

  function getPairingKey(playerAId, playerBId) {
    return normalizePairIds(playerAId, playerBId).join('|');
  }

  function getJunePairingHistory(state, season, beforeDateKey) {
    const normalized = normalizeState(state || {});
    const start = season?.startDate || '2026-06-01';
    const end = season?.endDate || '2026-06-30';
    const history = new Map();
    (normalized.matchups || []).forEach((matchup) => {
      const key = matchupDateKey(matchup);
      if (!key || key < start || key > end || (beforeDateKey && key >= beforeDateKey)) return;
      if (!matchup?.playerAId || !matchup?.playerBId) return;
      const pairingKey = getPairingKey(matchup.playerAId, matchup.playerBId);
      const existing = history.get(pairingKey);
      const entry = {
        key: pairingKey,
        playerAId: normalizePairIds(matchup.playerAId, matchup.playerBId)[0],
        playerBId: normalizePairIds(matchup.playerAId, matchup.playerBId)[1],
        firstDateKey: existing?.firstDateKey && existing.firstDateKey < key ? existing.firstDateKey : key,
        lastDateKey: existing?.lastDateKey && existing.lastDateKey > key ? existing.lastDateKey : key,
        count: (existing?.count || 0) + 1,
        matchups: (existing?.matchups || []).concat(matchup.id || '')
      };
      history.set(pairingKey, entry);
    });
    return history;
  }

  function hasJunePairingOccurred(history, playerAId, playerBId) {
    if (!history) return false;
    return history.has(getPairingKey(playerAId, playerBId));
  }

  function generateRandomNonRepeatPairs(pool, history, options = {}) {
    const ids = (Array.isArray(pool) ? pool : []).map((item) => typeof item === 'string' ? item : item?.id || item?.playerId).filter(Boolean);
    const warnings = [];
    const errors = [];
    if (ids.length % 2 === 1) {
      errors.push(`Odd player pool (${ids.length}) cannot be fully paired.`);
      return { ok: false, pairs: [], warnings, errors, relaxedRepeatCount: 0 };
    }

    const random = typeof options.random === 'function' ? options.random : Math.random;
    const attempts = Math.max(25, Number(options.attempts) || 200);
    const shuffleWithRandom = (arr) => {
      const next = arr.slice();
      for (let i = next.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    };

    function backtrack(remaining, pairs) {
      if (!remaining.length) return pairs;
      const [first, ...rest] = remaining;
      const candidates = shuffleWithRandom(rest).filter((candidate) => !hasJunePairingOccurred(history, first, candidate));
      for (const candidate of candidates) {
        const nextRest = rest.filter((id) => id !== candidate);
        const result = backtrack(nextRest, pairs.concat({ playerAId: first, playerBId: candidate, repeated: false }));
        if (result) return result;
      }
      return null;
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = backtrack(shuffleWithRandom(ids), []);
      if (result) return { ok: true, pairs: result, warnings, errors, relaxedRepeatCount: 0 };
    }

    const remaining = shuffleWithRandom(ids);
    const fallbackPairs = [];
    let relaxedRepeatCount = 0;
    while (remaining.length) {
      const first = remaining.shift();
      let bestIndex = -1;
      let bestRank = null;
      remaining.forEach((candidate, index) => {
        const occurred = hasJunePairingOccurred(history, first, candidate);
        const entry = history?.get(getPairingKey(first, candidate));
        const rank = occurred ? (entry?.lastDateKey || '0000-00-00') : '';
        if (bestIndex === -1) {
          bestIndex = index; bestRank = rank; return;
        }
        if (!occurred && bestRank) { bestIndex = index; bestRank = rank; return; }
        if (occurred === Boolean(bestRank) && rank < bestRank) { bestIndex = index; bestRank = rank; }
      });
      if (bestIndex < 0) break;
      const [second] = remaining.splice(bestIndex, 1);
      const repeated = hasJunePairingOccurred(history, first, second);
      if (repeated) relaxedRepeatCount += 1;
      fallbackPairs.push({ playerAId: first, playerBId: second, repeated });
    }
    if (fallbackPairs.length * 2 !== ids.length) {
      errors.push('Unable to create a full fallback pairing slate.');
      return { ok: false, pairs: fallbackPairs, warnings, errors, relaxedRepeatCount };
    }
    if (relaxedRepeatCount) warnings.push(`No-repeat June pairing rule relaxed for ${relaxedRepeatCount} matchup(s).`);
    return { ok: true, pairs: fallbackPairs, warnings, errors, relaxedRepeatCount };
  }

  function buildSeasonDailySlate(state, dateKeyStr, options = {}) {
    const warnings = [];
    const errors = [];
    const normalized = normalizeState(state || {});
    const season = normalizeSeasonState(normalized.currentSeason);
    if (!shouldUseSeasonMatchupControl(normalized, dateKeyStr)) {
      errors.push('Season matchup control gate is closed.');
      return { ok: false, dateKey: dateKeyStr, tournamentMatchups: [], exhibitionMatchups: [], allMatchups: [], warnings, errors, updatedSeason: season };
    }

    const preparedSeason = prepareSeasonForDailySlate(season, dateKeyStr, options);
    const slateSeason = preparedSeason.season || season;
    if (preparedSeason.changed) warnings.push(`Activated ${preparedSeason.activatedSeriesIds.length} ready ${getSeasonDisplayName(getCurrentSeasonRoundIdForDate(dateKeyStr)) || 'Season'} series for slate generation.`);

    const playerPool = getActiveSeasonPlayerPool(normalized);
    const playerById = new Map(playerPool.map((player) => [player.id || player.playerId, player]));
    const activeSeries = getActiveSeasonSeriesForDate(slateSeason, dateKeyStr)
      .filter((series) => series && !isSeasonSeriesComplete(series) && series.playerAId && series.playerBId)
      .sort((a, b) => (Number(a.roundIndex) || 0) - (Number(b.roundIndex) || 0) || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));

    const used = new Set();
    const tournamentMatchups = [];
    activeSeries.forEach((series) => {
      const seriesGameNumber = (Array.isArray(series.gameResults) ? series.gameResults.length : 0) + 1;
      if (seriesGameNumber > (Number(series.bestOf) || 1)) return;
      if (used.has(series.playerAId) || used.has(series.playerBId)) {
        warnings.push(`Skipped tournament series ${series.id} because a player was already assigned today.`);
        return;
      }
      used.add(series.playerAId);
      used.add(series.playerBId);
      const roundName = series.roundName || getSeasonDisplayName(series.roundId) || series.roundId;
      tournamentMatchups.push({
        id: `${dateKeyStr}_${series.id}_g${seriesGameNumber}`,
        date: dateKeyStr,
        dateKey: dateKeyStr,
        playerAId: series.playerAId,
        playerBId: series.playerBId,
        playerAName: series.playerAName || playerById.get(series.playerAId)?.name || series.playerAId,
        playerBName: series.playerBName || playerById.get(series.playerBId)?.name || series.playerBId,
        seasonId: slateSeason.id,
        seriesId: series.id,
        roundId: series.roundId,
        roundName,
        seriesGameNumber,
        bestOf: Number(series.bestOf) || null,
        winsNeeded: Number(series.winsNeeded) || Math.floor((Number(series.bestOf) || 1) / 2) + 1,
        matchupType: 'tournament',
        seasonMatchupLabel: `${roundName}, Game ${seriesGameNumber}`
      });
    });

    const exhibitionPool = playerPool
      .map((player) => player.id || player.playerId)
      .filter((id) => id && !used.has(id));
    if (exhibitionPool.length % 2 === 1) {
      errors.push(`Odd exhibition player pool (${exhibitionPool.length}) cannot be fully paired.`);
      return { ok: false, dateKey: dateKeyStr, tournamentMatchups, exhibitionMatchups: [], allMatchups: tournamentMatchups, warnings, errors, updatedSeason: slateSeason };
    }
    const history = getJunePairingHistory(normalized, season, dateKeyStr);
    tournamentMatchups.forEach((matchup) => {
      history.set(getPairingKey(matchup.playerAId, matchup.playerBId), {
        key: getPairingKey(matchup.playerAId, matchup.playerBId),
        firstDateKey: dateKeyStr,
        lastDateKey: dateKeyStr,
        count: 1,
        matchups: [matchup.id]
      });
    });
    const generated = generateRandomNonRepeatPairs(exhibitionPool, history, options);
    warnings.push(...generated.warnings);
    errors.push(...generated.errors);
    if (!generated.ok) return { ok: false, dateKey: dateKeyStr, tournamentMatchups, exhibitionMatchups: [], allMatchups: tournamentMatchups, warnings, errors, updatedSeason: slateSeason };

    const exhibitionMatchups = generated.pairs.map((pair, index) => ({
      id: `${dateKeyStr}_exhibition_${index + 1}_${pair.playerAId}_${pair.playerBId}`,
      date: dateKeyStr,
      dateKey: dateKeyStr,
      playerAId: pair.playerAId,
      playerBId: pair.playerBId,
      playerAName: playerById.get(pair.playerAId)?.name || pair.playerAId,
      playerBName: playerById.get(pair.playerBId)?.name || pair.playerBId,
      seasonId: slateSeason.id,
      matchupType: 'exhibition',
      seasonMatchupLabel: 'Exhibition'
    }));

    const allMatchups = tournamentMatchups.concat(exhibitionMatchups);
    const sameDayPlayers = new Set();
    for (const matchup of allMatchups) {
      if (sameDayPlayers.has(matchup.playerAId) || sameDayPlayers.has(matchup.playerBId)) {
        errors.push('Duplicate player detected in Season daily slate.');
        return { ok: false, dateKey: dateKeyStr, tournamentMatchups, exhibitionMatchups, allMatchups, warnings, errors, updatedSeason: slateSeason };
      }
      sameDayPlayers.add(matchup.playerAId);
      sameDayPlayers.add(matchup.playerBId);
    }

    return { ok: true, dateKey: dateKeyStr, tournamentMatchups, exhibitionMatchups, allMatchups, warnings, errors, updatedSeason: slateSeason };
  }

  function getMatchupWinnerIds(matchup) {
    const scoreA = Number(matchup?.scoreA);
    const scoreB = Number(matchup?.scoreB);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return null;
    return scoreA > scoreB
      ? { winnerId: matchup.playerAId, loserId: matchup.playerBId, playerAScore: scoreA, playerBScore: scoreB }
      : { winnerId: matchup.playerBId, loserId: matchup.playerAId, playerAScore: scoreA, playerBScore: scoreB };
  }


  function buildSeasonGameResultPayload(matchup, dateKeyStr, winner) {
    return {
      dateKey: dateKeyStr,
      matchupId: matchup.id || `${dateKeyStr}_${matchup.seriesId}`,
      winnerId: winner.winnerId,
      loserId: winner.loserId,
      playerAScore: winner.playerAScore,
      playerBScore: winner.playerBScore,
      source: 'matchup'
    };
  }

  function seasonGameResultsEqual(existing, next) {
    return String(existing?.winnerId || '') === String(next?.winnerId || '')
      && String(existing?.loserId || '') === String(next?.loserId || '')
      && Number(existing?.playerAScore) === Number(next?.playerAScore)
      && Number(existing?.playerBScore) === Number(next?.playerBScore);
  }

  function recalculateSeasonSeriesFromGameResults(series, options = {}) {
    if (!series) return series;
    const winsNeeded = Number(series.winsNeeded) || Math.floor((Number(series.bestOf) || 1) / 2) + 1;
    let winsA = 0;
    let winsB = 0;
    (Array.isArray(series.gameResults) ? series.gameResults : []).forEach((result) => {
      if (result?.winnerId === series.playerAId) winsA += 1;
      else if (result?.winnerId === series.playerBId) winsB += 1;
    });
    let winnerId = '';
    let loserId = '';
    let status = (series.playerAId && series.playerBId) ? 'active' : 'pending';
    if (winsA >= winsNeeded && winsA > winsB) {
      winnerId = series.playerAId;
      loserId = series.playerBId;
      status = 'complete';
    } else if (winsB >= winsNeeded && winsB > winsA) {
      winnerId = series.playerBId;
      loserId = series.playerAId;
      status = 'complete';
    }
    return {
      ...series,
      winsA,
      winsB,
      winnerId,
      loserId,
      status,
      updatedAtISO: seasonNowISO(options)
    };
  }

  function replaceSeasonSeriesGameResult(season, seriesId, gameResult, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const series = nextSeason.series?.[seriesId];
    if (!series) return { ok: false, error: 'series_not_found', season: nextSeason };
    const results = Array.isArray(series.gameResults) ? series.gameResults.slice() : [];
    const matchupId = typeof gameResult?.matchupId === 'string' ? gameResult.matchupId : '';
    const resultDateKey = typeof gameResult?.dateKey === 'string' ? gameResult.dateKey : '';
    const existingIndex = results.findIndex((result) => (matchupId && result.matchupId === matchupId) || (!matchupId && resultDateKey && result.dateKey === resultDateKey));
    if (existingIndex < 0) return { ok: false, error: 'game_result_not_found', season: nextSeason, series };
    if (gameResult.winnerId !== series.playerAId && gameResult.winnerId !== series.playerBId) return { ok: false, error: 'invalid_or_ambiguous_winner', season: nextSeason, series };
    const loserId = gameResult.winnerId === series.playerAId ? series.playerBId : series.playerAId;
    if (!loserId || (gameResult.loserId && gameResult.loserId !== loserId)) return { ok: false, error: 'invalid_or_ambiguous_loser', season: nextSeason, series };
    const existing = results[existingIndex];
    if (seasonGameResultsEqual(existing, { ...gameResult, loserId })) {
      return { ok: true, changed: false, season: nextSeason, series, unchanged: true };
    }
    const beforeWinnerId = getSeasonSeriesWinner(series) || '';
    const replacement = {
      ...existing,
      dateKey: resultDateKey || existing.dateKey || '',
      matchupId: matchupId || existing.matchupId || '',
      winnerId: gameResult.winnerId,
      loserId,
      playerAScore: gameResult.playerAScore,
      playerBScore: gameResult.playerBScore,
      source: 'matchup',
      recordedAtISO: existing.recordedAtISO || seasonNowISO(options),
      updatedAtISO: seasonNowISO(options)
    };
    results[existingIndex] = replacement;
    const recalculated = recalculateSeasonSeriesFromGameResults({ ...series, gameResults: results }, options);
    const afterWinnerId = getSeasonSeriesWinner(recalculated) || '';
    const nextSeries = { ...(nextSeason.series || {}), [seriesId]: recalculated };
    const updatedSeason = normalizeSeasonState({ ...nextSeason, series: nextSeries, updatedAtISO: seasonNowISO(options) });
    return {
      ok: true,
      changed: true,
      season: updatedSeason,
      series: recalculated,
      beforeWinnerId,
      afterWinnerId,
      winnerChanged: Boolean(beforeWinnerId && afterWinnerId && beforeWinnerId !== afterWinnerId)
    };
  }

  function getSeasonSeriesWinsNeeded(series) {
    const explicit = Number(series?.winsNeeded);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    const bestOf = Number(series?.bestOf);
    if (Number.isFinite(bestOf) && bestOf > 0) return Math.floor(bestOf / 2) + 1;
    return series?.roundId === 'play_in' ? 2 : (series?.roundId === 'round_of_32' ? 3 : 1);
  }

  function getRecordedResultDateKey(record) {
    return record?.dateKey || record?.dayKey || record?.date || (record?.dateISO ? dateKey(record.dateISO) : '') || (record?.completedAtISO ? dateKey(record.completedAtISO) : '');
  }

  function getRecordedResultTime(record) {
    return record?.completedAtISO || record?.updatedAtISO || record?.recordedAtISO || record?.dateISO || record?.createdAtISO || '';
  }

  function getRecordedSeriesId(record) {
    return String(record?.seasonSeriesId || record?.seriesId || record?.seasonSeriesID || record?.seriesID || '').trim();
  }

  function inferSeasonSeriesIdFromRecord(state, season, record, options = {}) {
    const explicit = getRecordedSeriesId(record);
    if (explicit && season?.series?.[explicit]) return explicit;
    if (!season?.series || !record?.playerAId || !record?.playerBId) return '';

    const recordDate = getRecordedResultDateKey(record) || options.dateKey || '';
    const recordRoundId = record?.roundId || (recordDate && getSeasonRoundForDate(recordDate)?.id) || '';
    const pairKey = getPairingKey(record.playerAId, record.playerBId);

    const entries = Object.values(season.series || {}).filter((series) => {
      if (!series?.playerAId || !series?.playerBId) return false;
      if (getPairingKey(series.playerAId, series.playerBId) !== pairKey) return false;
      if (recordRoundId && series.roundId && series.roundId !== recordRoundId) return false;
      return true;
    });

    if (entries.length === 1) return entries[0].id || '';

    if (!recordRoundId) {
      const activeOrIncomplete = entries.filter((series) => !isSeasonSeriesComplete(series));
      if (activeOrIncomplete.length === 1) return activeOrIncomplete[0].id || '';
    }

    return '';
  }

  function withInferredSeasonMatchupMetadata(state, season, record, options = {}) {
    const type = String(record?.matchupType || '').toLowerCase();
    const explicitSeriesId = getRecordedSeriesId(record);
    const hasExplicitValidSeries = Boolean(explicitSeriesId && season?.series?.[explicitSeriesId]);
    if (type === 'exhibition' && !hasExplicitValidSeries) return record;

    const seriesId = inferSeasonSeriesIdFromRecord(state, season, record, options);
    if (!seriesId || !season?.series?.[seriesId]) return record;

    const series = season.series[seriesId];

    return {
      ...record,
      seasonId: record?.seasonId || season.id || '',
      seriesId: record?.seriesId || seriesId,
      seasonSeriesId: record?.seasonSeriesId || seriesId,
      roundId: record?.roundId || series.roundId || '',
      roundName: record?.roundName || series.roundName || getSeasonDisplayName(series.roundId) || '',
      matchupType: record?.matchupType || 'tournament',
      bestOf: record?.bestOf || series.bestOf || null,
      winsNeeded: record?.winsNeeded || series.winsNeeded || getSeasonSeriesWinsNeeded(series)
    };
  }

  function getRecordedResultWinner(record) {
    let winnerId = String(record?.winnerId || record?.winningPlayerId || record?.winner?.playerId || record?.winner?.id || record?.result?.winnerId || record?.result?.winningPlayerId || record?.result?.winner?.playerId || record?.result?.winner?.id || '').trim();
    let loserId = String(record?.loserId || record?.losingPlayerId || record?.loser?.playerId || record?.loser?.id || record?.result?.loserId || record?.result?.losingPlayerId || record?.result?.loser?.playerId || record?.result?.loser?.id || '').trim();
    const scoreA = Number(record?.scoreA ?? record?.playerAScore ?? record?.aScore ?? record?.result?.scoreA ?? record?.result?.playerAScore);
    const scoreB = Number(record?.scoreB ?? record?.playerBScore ?? record?.bScore ?? record?.result?.scoreB ?? record?.result?.playerBScore);
    if (!winnerId && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) {
      winnerId = scoreA > scoreB ? String(record?.playerAId || '').trim() : String(record?.playerBId || '').trim();
      loserId = scoreA > scoreB ? String(record?.playerBId || '').trim() : String(record?.playerAId || '').trim();
    }
    return {
      winnerId,
      loserId,
      playerAScore: Number.isFinite(scoreA) ? scoreA : undefined,
      playerBScore: Number.isFinite(scoreB) ? scoreB : undefined
    };
  }

  function getSeasonResultDedupeKey(record, seriesId, fallbackIndex = 0) {
    const directId = record?.matchupId || record?.gameId || record?.id || record?.completionId;
    if (directId) return `id:${directId}`;
    const date = getRecordedResultDateKey(record);
    const gameNumber = record?.gameNumber || record?.seriesGameNumber || record?.game || '';
    const winnerId = record?.winnerId || record?.winningPlayerId || '';
    const scoreA = record?.playerAScore ?? record?.scoreA ?? '';
    const scoreB = record?.playerBScore ?? record?.scoreB ?? '';
    if (date || gameNumber || winnerId) return `cmp:${date}:${seriesId}:${gameNumber}:${winnerId}:${scoreA}:${scoreB}`;
    return `fallback:${seriesId}:${fallbackIndex}`;
  }

  function normalizeSeasonResultRecord(raw, series, source, fallbackIndex = 0) {
    if (!raw || !series) return null;
    const seriesId = getRecordedSeriesId(raw) || series.id || '';
    if (seriesId && series.id && seriesId !== series.id) return null;
    const winner = getRecordedResultWinner(raw);
    if (!winner.winnerId || (winner.winnerId !== series.playerAId && winner.winnerId !== series.playerBId)) return null;
    const loserId = winner.winnerId === series.playerAId ? series.playerBId : series.playerAId;
    if (!loserId || (winner.loserId && winner.loserId !== loserId)) return null;
    const date = getRecordedResultDateKey(raw);
    const matchupId = raw.matchupId || raw.id || raw.gameId || (date ? `${date}_${series.id}_${raw.gameNumber || raw.seriesGameNumber || ''}` : '');
    return {
      dateKey: date,
      matchupId: String(matchupId || ''),
      gameNumber: raw.gameNumber || raw.seriesGameNumber || raw.game || null,
      winnerId: winner.winnerId,
      loserId,
      playerAScore: winner.playerAScore,
      playerBScore: winner.playerBScore,
      source: raw.source || source || 'matchup',
      _containerSource: source || '',
      recordedAtISO: raw.recordedAtISO || raw.completedAtISO || raw.dateISO || raw.createdAtISO || '',
      updatedAtISO: raw.updatedAtISO || '',
      _dedupeKey: getSeasonResultDedupeKey({ ...raw, matchupId }, series.id, fallbackIndex),
      _sortKey: getRecordedResultTime(raw) || date || ''
    };
  }

  function collectSeasonResultCandidates(state, season, options = {}) {
    const candidatesBySeries = new Map();
    const add = (seriesId, raw, source, index, includeRegardlessOfDate = false) => {
      if (!seriesId || !season?.series?.[seriesId]) return;
      const normalized = normalizeSeasonResultRecord(raw, season.series[seriesId], source, index);
      if (!normalized) return;
      if (!includeRegardlessOfDate && options.dateKey && normalized.dateKey && normalized.dateKey !== options.dateKey) return;
      if (!candidatesBySeries.has(seriesId)) candidatesBySeries.set(seriesId, []);
      candidatesBySeries.get(seriesId).push(normalized);
    };

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach((matchup, index) => {
      const type = String(matchup?.matchupType || '').toLowerCase();
      const explicitSeriesId = getRecordedSeriesId(matchup);
      const hasExplicitValidSeries = Boolean(explicitSeriesId && season?.series?.[explicitSeriesId]);

      if (type === 'exhibition' && !hasExplicitValidSeries) return;

      const canInfer =
        !explicitSeriesId
        && (!type || type === 'tournament' || type === 'season')
        && (!matchup?.seasonId || matchup.seasonId === season?.id);

      const seriesId = hasExplicitValidSeries
        ? explicitSeriesId
        : canInfer
          ? inferSeasonSeriesIdFromRecord(state, season, matchup, options)
          : '';

      if (!seriesId || !season?.series?.[seriesId]) return;

      const isSeasonMatchup =
        matchup?.seasonId === season?.id
        || type === 'tournament'
        || type === 'season'
        || hasExplicitValidSeries
        || canInfer;

      if (!isSeasonMatchup) return;

      add(seriesId, withInferredSeasonMatchupMetadata(state, season, matchup, options), 'matchup', index);
    });

    Object.entries(season?.series || {}).forEach(([seriesId, series]) => {
      (Array.isArray(series?.gameResults) ? series.gameResults : []).forEach((result, index) => {
        add(seriesId, { ...result, seriesId, seasonSeriesId: seriesId }, 'series.gameResults', index, true);
      });
    });

    const scanResultContainer = (container, source) => {
      if (Array.isArray(container)) {
        container.forEach((entry, index) => add(getRecordedSeriesId(entry), entry, source, index));
      } else if (container && typeof container === 'object') {
        Object.entries(container).forEach(([key, value], outerIndex) => {
          if (Array.isArray(value)) value.forEach((entry, index) => add(getRecordedSeriesId(entry) || key, { ...entry, seriesId: getRecordedSeriesId(entry) || key }, source, index));
          else if (value && typeof value === 'object') add(getRecordedSeriesId(value) || key, { ...value, seriesId: getRecordedSeriesId(value) || key }, source, outerIndex);
        });
      }
    };
    scanResultContainer(season?.gameResults, 'season.gameResults');
    scanResultContainer(season?.dailyTournamentResults, 'season.dailyTournamentResults');
    scanResultContainer(state?.gameHistory, 'gameHistory');

    return candidatesBySeries;
  }

  function rebuildSeasonSeriesFromRecordedResults(series, rawResults, options = {}) {
    const byKey = new Map();
    rawResults.forEach((result, index) => {
      const key = result._dedupeKey || getSeasonResultDedupeKey(result, series.id, index);
      const existing = byKey.get(key);
      const resultSource = String(result._containerSource || result.source || '');
      const existingSource = String(existing?._containerSource || existing?.source || '');
      if (existing && resultSource.includes('series.gameResults') && !existingSource.includes('series.gameResults')) return;
      byKey.set(key, result);
    });
    const gameResults = Array.from(byKey.values()).sort((a, b) => String(a._sortKey || a.dateKey || '').localeCompare(String(b._sortKey || b.dateKey || '')));
    let winsA = 0;
    let winsB = 0;
    gameResults.forEach((result) => {
      if (result.winnerId === series.playerAId) winsA += 1;
      else if (result.winnerId === series.playerBId) winsB += 1;
    });
    const winsNeeded = getSeasonSeriesWinsNeeded(series);
    let winnerId = '';
    let loserId = '';
    let status = series.playerAId && series.playerBId ? (series.status === 'pending' ? 'active' : (series.status || 'active')) : 'pending';
    if (winsA >= winsNeeded && winsA > winsB) {
      winnerId = series.playerAId;
      loserId = series.playerBId;
      status = 'complete';
    } else if (winsB >= winsNeeded && winsB > winsA) {
      winnerId = series.playerBId;
      loserId = series.playerAId;
      status = 'complete';
    } else if (series.status === 'complete' || series.winnerId || series.loserId) {
      status = series.playerAId && series.playerBId ? 'active' : 'pending';
    }
    const latest = gameResults.map((result) => result._sortKey || result.recordedAtISO || result.dateKey || '').filter(Boolean).sort().pop() || '';
    return {
      ...series,
      winsA,
      winsB,
      winnerId,
      loserId,
      status,
      gameResults: gameResults.map(({ _dedupeKey, _sortKey, _containerSource, ...result }) => result),
      completedAtISO: winnerId ? (latest || series.completedAtISO || seasonNowISO(options)) : '',
      updatedAtISO: seasonNowISO(options)
    };
  }

  function syncCurrentSeasonSeriesFromRecordedResults(state, options = {}) {
    const normalized = normalizeState(state || {});
    let season = normalizeSeasonState(normalized.currentSeason);
    const warnings = [];
    const errors = [];
    if (!season) return { ok: false, state: normalized, updatedSeason: season, changed: false, warnings, errors: ['No current season.'] };
    const beforeSeries = season.series || {};
    const candidates = collectSeasonResultCandidates(normalized, season, options);
    const nextSeries = { ...beforeSeries };
    let resultCount = 0;
    let changed = false;
    Object.entries(beforeSeries).forEach(([seriesId, series]) => {
      const rawResults = candidates.get(seriesId) || [];
      resultCount += rawResults.length;
      if (!rawResults.length) return;
      const beforeWinnerId = getSeasonSeriesWinner(series) || '';
      const repaired = rebuildSeasonSeriesFromRecordedResults(series, rawResults, options);
      const afterWinnerId = getSeasonSeriesWinner(repaired) || '';
      if (beforeWinnerId && afterWinnerId && beforeWinnerId !== afterWinnerId) {
        warnings.push(`Edited result changed the winner of ${seriesId}; bracket advancement may need manual admin repair.`);
      }
      const stableRepaired = { ...repaired, updatedAtISO: series.updatedAtISO };
      if (JSON.stringify(stableRepaired) === JSON.stringify(series)) {
        nextSeries[seriesId] = series;
        return;
      }
      if (JSON.stringify(repaired) !== JSON.stringify(series)) {
        nextSeries[seriesId] = repaired;
        changed = true;
      }
    });
    season = normalizeSeasonState({ ...season, series: nextSeries, updatedAtISO: changed ? seasonNowISO(options) : season.updatedAtISO });
    const playInRepair = repairPlayInAdvancementForSeason(season, options);
    if (playInRepair.season) {
      season = playInRepair.season;
      if (playInRepair.changed) changed = true;
      else if (!playInRepair.ok && playInRepair.error && playInRepair.error !== 'play_in_not_complete') warnings.push(`Play-In repair pending: ${playInRepair.error}.`);
    }
    const repairedMatchups = (Array.isArray(normalized.matchups) ? normalized.matchups : [])
      .map((matchup) => withInferredSeasonMatchupMetadata(normalized, season, matchup, options));
    const matchupsChanged = JSON.stringify(repairedMatchups) !== JSON.stringify(normalized.matchups || []);
    if (matchupsChanged) changed = true;

    const completedCount = Object.values(season?.series || {}).filter((series) => isSeasonSeriesComplete(series)).length;
    const playInCompletedCount = Object.values(season?.series || {}).filter((series) => series?.roundId === 'play_in' && isSeasonSeriesComplete(series)).length;
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[Season result sync]', {
        seriesCount: Object.keys(season?.series || {}).length,
        resultCount,
        completedCount,
        playInCompletedCount,
        changed
      });
    }
    const nextState = changed ? normalizeState({
      ...normalized,
      currentSeason: season,
      matchups: repairedMatchups,
      latestSeasonId: season?.id || normalized.latestSeasonId || ''
    }) : normalized;
    return { ok: errors.length === 0, state: nextState, updatedSeason: season, changed, warnings, errors };
  }

  function syncSeasonResultsFromDailyMatchups(state, dateKeyStr, options = {}) {
    return syncCurrentSeasonSeriesFromRecordedResults(state, { ...options, dateKey: dateKeyStr || options.dateKey || '' });
  }

  function getActiveSeasonPlayerPool(state) {
    try {
      return rankablePlayers(state || {}).map((player) => ({ ...player }));
    } catch (e) {
      const youName = (typeof state?.youName === 'string' && state.youName.trim()) ? state.youName.trim() : 'You';
      const players = Array.isArray(state?.players) ? state.players : [];
      return [{ id: 'YOU', name: youName, isYou: true }]
        .concat(players.filter((player) => player && player.active !== false && player.id && player.id !== 'YOU'));
    }
  }

  function computeSeedPointsFromMatchups(state, playerId) {
    const matchups = Array.isArray(state?.matchups) ? state.matchups : [];
    let totalPoints = 0;
    let games = 0;
    let marginTotal = 0;
    matchups.forEach((matchup) => {
      if (!matchup || (matchup.playerAId !== playerId && matchup.playerBId !== playerId)) return;
      if (!isMatchupRevealed(matchupDateKey(matchup), { includeToday: false })) return;
      const scoreA = Number(matchup.scoreA);
      const scoreB = Number(matchup.scoreB);
      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return;
      const score = matchup.playerAId === playerId ? scoreA : scoreB;
      const oppScore = matchup.playerAId === playerId ? scoreB : scoreA;
      totalPoints += score;
      marginTotal += score - oppScore;
      games += 1;
    });
    return {
      totalPoints,
      averageScore: games ? totalPoints / games : null,
      marginOfVictory: games ? marginTotal / games : null
    };
  }

  function getSeasonSeedSourceRows(state) {
    const warnings = [];
    const rows = [];
    const pool = getActiveSeasonPlayerPool(state || {});
    if (!pool.length) warnings.push({ code: 'no_players', message: 'No active season player pool could be found.' });

    let rankings = [];
    try {
      rankings = computeRankings(state || {}, { includeToday: false, allowFallback: true });
    } catch (e) {
      warnings.push({ code: 'rankings_unavailable', message: 'Ranking data could not be computed for season seeding.' });
      rankings = [];
    }
    const rankingMap = new Map(rankings.map((row) => [row.playerId || row.id, row]));

    pool.forEach((player) => {
      const playerId = player?.id || player?.playerId;
      if (!playerId) return;
      const ranking = rankingMap.get(playerId) || {};
      let record = null;
      try {
        record = computeRecord(state || {}, playerId, { includeToday: false, allowFallback: true });
      } catch (e) {
        warnings.push({ code: 'record_unavailable', playerId, message: `Record data could not be computed for ${playerId}.` });
      }
      const wins = Number(record?.wins ?? ranking.wins) || 0;
      const losses = Number(record?.losses ?? ranking.losses) || 0;
      const ties = Number(record?.ties ?? ranking.ties) || 0;
      const games = Number(record?.games ?? ranking.games) || 0;
      const seedStats = computeSeedPointsFromMatchups(state || {}, playerId);
      const averageScore = Number.isFinite(seedStats.averageScore)
        ? seedStats.averageScore
        : (Number.isFinite(ranking.avgPPD) ? ranking.avgPPD : null);
      rows.push({
        playerId,
        id: playerId,
        name: player.name || (playerId === 'YOU' ? 'You' : 'Unnamed'),
        isYou: playerId === 'YOU' || player.isYou === true,
        wins,
        losses,
        ties,
        games,
        winPct: games ? wins / games : null,
        totalPoints: seedStats.totalPoints,
        averageScore,
        marginOfVictory: seedStats.marginOfVictory,
        rank: Number.isFinite(ranking.rank) ? ranking.rank : null,
        recordSource: record?.source || ranking.recordSource || 'unknown',
        warnings: []
      });
    });

    rows.sort((a, b) => {
      const awp = Number.isFinite(a.winPct) ? a.winPct : -1;
      const bwp = Number.isFinite(b.winPct) ? b.winPct : -1;
      if (bwp !== awp) return bwp - awp;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      const avgA = Number.isFinite(a.averageScore) ? a.averageScore : -1;
      const avgB = Number.isFinite(b.averageScore) ? b.averageScore : -1;
      if (avgB !== avgA) return avgB - avgA;
      const movA = Number.isFinite(a.marginOfVictory) ? a.marginOfVictory : -1e9;
      const movB = Number.isFinite(b.marginOfVictory) ? b.marginOfVictory : -1e9;
      if (movB !== movA) return movB - movA;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return { rows, warnings };
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
    { key: "calLogBonus", label: "Cal Log Bonus", match: c => c?.source === CAL_LOG_BONUS_SOURCE },
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
      logBonus: 2,
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
  ? (workInput.hoursMax === null ? null : toFiniteNumber(workInput.hoursMax))
  : null;

    const caloriesTarget = toFiniteNumber(caloriesInput.target);
    const caloriesPointsPer100 = toFiniteNumber(caloriesInput.pointsPer100);
    const caloriesLogBonus = toFiniteNumber(caloriesInput.logBonus);
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
        logBonus: caloriesLogBonus != null ? caloriesLogBonus : DEFAULT_SCORING_SETTINGS.calories.logBonus,
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
    const status = typeof t.status === 'string' ? t.status : '';
    if (!['active', 'done', 'hidden', 'wontdo', 'trashed'].includes(status)) {
      if (t.deletedAtISO || t.deletedAt) t.status = 'trashed';
      else if (t.hidden) t.status = 'hidden';
      else if (t.completedAtISO) t.status = 'done';
      else t.status = 'active';
    }
    if (t.status === 'trashed') {
      t.deletedAtISO = t.deletedAtISO || t.deletedAt || null;
      t.deletedAt = t.deletedAt || t.deletedAtISO || null;
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

  function normalizeTagKey(tag) {
    const key = String(tag ?? '').trim();
    return key;
  }

  function normalizeHabitTagColors(value) {
    if (!value || typeof value !== 'object') return {};
    const next = {};
    Object.entries(value).forEach(([tag, color]) => {
      const key = normalizeTagKey(tag);
      if (!key) return;
      const normalized = normalizeHexColor(color);
      if (normalized) next[key] = normalized;
    });
    return next;
  }

  function parseHabitTagColorPatch(value) {
    const out = { set: {}, del: [] };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;

    Object.entries(value).forEach(([tag, color]) => {
      const key = normalizeTagKey(tag);
      if (!key) return;

      // deletion signal (only applies when overwrite is allowed)
      if (color == null || String(color).trim() === '') {
        out.del.push(key);
        return;
      }

      const normalized = normalizeHexColor(color);
      if (normalized) out.set[key] = normalized;
    });

    return out;
  }

  function normalizeHabit(habit) {
    if (!habit || typeof habit !== 'object') return habit;
    const normalizedDaysPerCompleteWeek = Number(habit.daysPerCompleteWeek);
    return {
      ...habit,
      tag: typeof habit.tag === 'string' ? habit.tag.trim() : '',
      ...(Number.isFinite(normalizedDaysPerCompleteWeek)
        ? { daysPerCompleteWeek: Math.max(0, Math.min(7, Math.round(normalizedDaysPerCompleteWeek))) }
        : {})
    };
  }

  function getOpponentDripScheduleCleanupSummary(state, options = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const beforeCount = Array.isArray(source.opponentDripSchedules) ? source.opponentDripSchedules.length : 0;
    const cleaned = cleanupOpponentDripSchedules(state, options);
    const afterCount = Array.isArray(cleaned.opponentDripSchedules) ? cleaned.opponentDripSchedules.length : 0;
    const today = options.todayKey || dateKey(new Date());
    const yesterday = addDaysToDateKey(today, -1);
    const tomorrow = addDaysToDateKey(today, 1);
    const validKey = /^\d{4}-\d{2}-\d{2}$/;
    const protectedCount = (cleaned.opponentDripSchedules || []).filter((item) => {
      const d = typeof item?.date === 'string' ? item.date : '';
      return d === today || d === yesterday || d === tomorrow || (validKey.test(d) && d > tomorrow);
    }).length;
    return {
      beforeCount,
      afterCount,
      removedCount: beforeCount - afterCount,
      protectedCount
    };
  }

  function cleanupOpponentDripSchedules(state, options = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const schedules = Array.isArray(source.opponentDripSchedules) ? source.opponentDripSchedules : [];
    const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 120;
    const today = options.todayKey || dateKey(new Date());
    const yesterday = addDaysToDateKey(today, -1);
    const tomorrow = addDaysToDateKey(today, 1);
    const validKey = /^\d{4}-\d{2}-\d{2}$/;
    const gameHistory = Array.isArray(source.gameHistory) ? source.gameHistory : [];
    const finalScoreSet = new Set(gameHistory.map((g) => `${String(g?.date || '')}|${String(g?.playerId || '')}`));
    const isProtected = (item) => {
      const d = typeof item?.date === 'string' ? item.date : '';
      return d === today || d === yesterday || d === tomorrow || (validKey.test(d) && d > tomorrow);
    };
    const isRecoveryCandidate = (item) => {
      const d = typeof item?.date === 'string' ? item.date : '';
      const p = item?.playerId;
      return validKey.test(d) && p != null && !finalScoreSet.has(`${d}|${String(p)}`);
    };
    const sorted = schedules.slice().sort((a, b) => {
      const d = String(b?.date || '').localeCompare(String(a?.date || ''));
      if (d) return d;
      return String(a?.playerId || '').localeCompare(String(b?.playerId || ''));
    });
    const protectedSchedules = [];
    const recoverableOld = [];
    const removableOld = [];
    sorted.forEach((item) => {
      const d = typeof item?.date === 'string' ? item.date : '';
      if (isProtected(item)) protectedSchedules.push(item);
      else if (isRecoveryCandidate(item)) recoverableOld.push(item);
      else removableOld.push(item);
    });
    const base = protectedSchedules.concat(recoverableOld);
    let finalSchedules = base;
    if (finalSchedules.length > maxEntries) {
      finalSchedules = finalSchedules.slice(0, maxEntries);
    }
    const cleanedState = { ...source, opponentDripSchedules: finalSchedules };
    return cleanedState;
  }

  function normalizeState(s) {
    const normalized = {
      tasks:       Array.isArray(s?.tasks)       ? s.tasks.map(normalizeTask)       : [],
      reminders:   Array.isArray(s?.reminders)   ? s.reminders   : [],
      completions: Array.isArray(s?.completions) ? s.completions.map(normalizeCompletion) : [],
      players:     Array.isArray(s?.players)     ? s.players     : [],
      habits:      Array.isArray(s?.habits)      ? s.habits.map(normalizeHabit)      : [],
      flexActions: Array.isArray(s?.flexActions) ? s.flexActions : [],
      gameHistory: Array.isArray(s?.gameHistory) ? s.gameHistory : [],
      matchups:    Array.isArray(s?.matchups)    ? s.matchups    : [],
      schedule:    Array.isArray(s?.schedule)    ? s.schedule    : [],
opponentDripSchedules: Array.isArray(s?.opponentDripSchedules) ? s.opponentDripSchedules : [],
weightHistory: Array.isArray(s?.weightHistory) ? s.weightHistory : [],
vo2MaxHistory: Array.isArray(s?.vo2MaxHistory) ? s.vo2MaxHistory : [],
workHistory: Array.isArray(s?.workHistory) ? s.workHistory : [],
      liveDiffHistory: s?.liveDiffHistory && typeof s.liveDiffHistory === 'object' ? s.liveDiffHistory : {},
      liveDiffSnapshots: s?.liveDiffSnapshots && typeof s.liveDiffSnapshots === 'object' ? s.liveDiffSnapshots : {},
      youImageId:  typeof s?.youImageId === "string" ? s.youImageId : "",
      youName: typeof s?.youName === "string" ? s.youName : "",
      youPrimaryColor: normalizeHexColor(s?.youPrimaryColor) || "#1a383b",
      youSecondaryColor: normalizeHexColor(s?.youSecondaryColor) || "#254c52",
      projects:    Array.isArray(s?.projects)    ? s.projects    : [],
      notes: typeof s?.notes === "string" ? s.notes : "",
      habitTagColors: normalizeHabitTagColors(s?.habitTagColors),
      scoringSettings: normalizeScoringSettings(s?.scoringSettings),
      playerBadges: s?.playerBadges && typeof s.playerBadges === 'object' && !Array.isArray(s.playerBadges) ? s.playerBadges : {},
      currentSeason: normalizeCurrentSeason(s?.currentSeason),
      latestSeasonId: typeof s?.latestSeasonId === 'string' ? s.latestSeasonId : '',
      seasonHistory: normalizeSeasonHistory(s?.seasonHistory)
    };
    return cleanupOpponentDripSchedules(normalized, { maxEntries: 120 });
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

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const beforeCount = state.tasks.length;
    state.tasks = state.tasks.filter((task) => {
      if (!task || task.status !== 'trashed') return true;
      const deletedMs = isoToMs(task.deletedAtISO || task.deletedAt);
      return deletedMs >= cutoff;
    });
    if (state.tasks.length !== beforeCount) changed = true;

    if (shouldSync) {
      const derivedSync = syncDerivedPoints(state, { normalized: true });
      state = derivedSync.state;
      changed = changed || derivedSync.changed;

      const matchupSync = syncYouMatchups(state, { normalized: true });
      state = matchupSync.state;
      changed = changed || matchupSync.changed;

      const seasonRepair = repairSeasonChampionshipData(state, options);
      if (seasonRepair.ok) {
        const beforeSeasonRepair = JSON.stringify(state.currentSeason || null);
        state = seasonRepair.state;
        changed = changed || beforeSeasonRepair !== JSON.stringify(state.currentSeason || null);
      }
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
  const maxOpponentDripSchedules = Number.isFinite(limits.maxOpponentDripSchedules)
    ? limits.maxOpponentDripSchedules
    : 120;
  const allowCompletionPrune = limits.allowCompletionPrune === true;
  const allowHistoryPrune = limits.allowHistoryPrune === true;

  merged.completions = Array.isArray(merged.completions)
    ? merged.completions
        .slice()
        .sort((a, b) => isoToMs(b?.completedAtISO) - isoToMs(a?.completedAtISO))
    : [];

  merged.gameHistory = Array.isArray(merged.gameHistory) ? merged.gameHistory : [];
  merged.matchups = Array.isArray(merged.matchups) ? merged.matchups : [];
  merged.workHistory = Array.isArray(merged.workHistory) ? merged.workHistory : [];
  merged.reminders = Array.isArray(merged.reminders) ? merged.reminders : [];

  merged.opponentDripSchedules = cleanupOpponentDripSchedules(merged, { maxEntries: maxOpponentDripSchedules }).opponentDripSchedules;

  if (allowCompletionPrune && merged.completions.length > maxCompletions) {
    const beforeCompletions = merged.completions.length;
    const beforeOldest = merged.completions[merged.completions.length - 1]?.completedAtISO || null;
    merged.completions = merged.completions.slice(0, maxCompletions);
    const afterOldest = merged.completions[merged.completions.length - 1]?.completedAtISO || null;
    merged.lastCompletionPruneWarning = {
      type: 'completion-history-pruned',
      atISO: new Date().toISOString(),
      beforeCompletions,
      afterCompletions: merged.completions.length,
      firstBeforeDate: beforeOldest,
      firstAfterDate: afterOldest
    };
  }
  if (allowHistoryPrune && merged.gameHistory.length > maxGameHistory) {
    const beforeGameHistory = merged.gameHistory.length;
    merged.gameHistory = merged.gameHistory.slice(-maxGameHistory);
    merged.lastGameHistoryPruneWarning = {
      type: 'game-history-pruned',
      atISO: new Date().toISOString(),
      beforeGameHistory,
      afterGameHistory: merged.gameHistory.length
    };
  }
  if (allowHistoryPrune && merged.matchups.length > maxMatchups) {
    const beforeMatchups = merged.matchups.length;
    merged.matchups = merged.matchups.slice(-maxMatchups);
    merged.lastMatchupPruneWarning = {
      type: 'matchup-history-pruned',
      atISO: new Date().toISOString(),
      beforeMatchups,
      afterMatchups: merged.matchups.length
    };
  }
  if (merged.workHistory.length > maxWorkHistory) {
    merged.workHistory = merged.workHistory.slice(-maxWorkHistory);
  }
  if (merged.opponentDripSchedules.length > maxOpponentDripSchedules) {
    merged.opponentDripSchedules = merged.opponentDripSchedules.slice(0, maxOpponentDripSchedules);
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

  const PROTECTED_HISTORY_KEYS = ['weightHistory', 'vo2MaxHistory', 'liveDiffHistory', 'liveDiffSnapshots'];
  const STICKY_KEYS = ['youImageId', 'youName', 'youPrimaryColor', 'youSecondaryColor', 'habitTagColors', ...PROTECTED_HISTORY_KEYS];

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
    if (key === 'youName') {
      if (typeof value !== 'string') return true;
      return value.trim() === '';
    }
    if (key === 'youPrimaryColor' || key === 'youSecondaryColor') {
      return !normalizeHexColor(value);
    }
    if (key === 'weightHistory' || key === 'vo2MaxHistory') {
      if (!Array.isArray(value)) return true;
      return value.length === 0;
    }
    if (key === 'liveDiffHistory' || key === 'liveDiffSnapshots' || key === 'habitTagColors' || key === 'scoringSettings') {
      if (!isPlainObject(value)) return true;
      return Object.keys(value).length === 0;
    }
    return false;
  }

  function shouldAllowProtectedHistoryOverwrite(key, options = {}) {
    if (!PROTECTED_HISTORY_KEYS.includes(key)) return false;
    if (options.allowProtectedHistoryOverwrite === true) return true;
    if (options.allowDestructiveOverwrite === true) return true;
    const allowKeys = options.allowProtectedHistoryOverwriteKeys;
    if (allowKeys && allowKeys[key]) return true;
    if (Array.isArray(allowKeys) && allowKeys.includes(key)) return true;
    return shouldAllowStickyOverwrite(key, options);
  }

  function protectedHistorySize(key, value) {
    if (key === 'weightHistory' || key === 'vo2MaxHistory') {
      return Array.isArray(value) ? value.length : 0;
    }
    if (key === 'liveDiffHistory') {
      if (!isPlainObject(value)) return 0;
      return Object.values(value).reduce((sum, samples) => sum + (Array.isArray(samples) ? samples.length : 0), 0);
    }
    if (key === 'liveDiffSnapshots') {
      if (!isPlainObject(value)) return 0;
      return Object.values(value).reduce((sum, snapshots) => {
        if (!isPlainObject(snapshots)) return sum;
        return sum + Object.keys(snapshots).length;
      }, 0);
    }
    return 0;
  }

  function warnProtectedHistoryWipe(key, existing, incoming, options = {}, storageKey = STORAGE_KEY) {
    const before = protectedHistorySize(key, existing?.[key]);
    const after = protectedHistorySize(key, incoming?.[key]);
    const hasIncoming = Object.prototype.hasOwnProperty.call(incoming || {}, key);
    if (!hasIncoming || before <= 0 || after !== 0 || shouldAllowProtectedHistoryOverwrite(key, options)) return;
    console.warn(`TaskPointsCore: prevented protected history "${key}" from being wiped`, {
      storageKey,
      savePath: options.savePath || options.source || options.reason || options.caller || 'unknown',
      before,
      after,
      hint: 'Pass allowProtectedHistoryOverwriteKeys for explicit history delete/reset actions only.'
    });
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
        || (key === 'habitTagColors' && options.allowHabitTagColorReset)
        || shouldAllowProtectedHistoryOverwrite(key, options);
      if (allowOverwrite) return;
      if (!Object.prototype.hasOwnProperty.call(nextState, key)) return;

      const incoming = nextState[key];
      const shouldPreserve = isStickyEmptyValue(key, incoming);
      if (!shouldPreserve) return;

      warnProtectedHistoryWipe(key, existing, nextState, options, storageKey);
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

  function isoToMs(iso) {
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
  }

  function mergeStringArrayUnique(a, b) {
    const out = [];
    const seen = new Set();
    const pushAll = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        const s = String(v || '').trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    };
    pushAll(a);
    pushAll(b);
    return out;
  }

  function taskVersionMs(t) {
    if (!isPlainObject(t)) return 0;
    return Math.max(
      isoToMs(t.updatedAtISO),
      isoToMs(t.createdAtISO),
      isoToMs(t.completedAtISO),
      isoToMs(t.deletedAtISO)
    );
  }

  function mergeTaskRecords(a, b) {
    const left = isPlainObject(a) ? a : {};
    const right = isPlainObject(b) ? b : {};
    const leftV = taskVersionMs(left);
    const rightV = taskVersionMs(right);

    const newer = rightV >= leftV ? right : left;
    const older = rightV >= leftV ? left : right;

    // Older first, then newer overwrites
    let merged = deepMerge(older, newer);

    // Union array fields that should never shrink during merges
    merged.tags = mergeStringArrayUnique(older.tags, newer.tags);
    merged.skipDates = mergeStringArrayUnique(older.skipDates, newer.skipDates);

    // Preserve earliest createdAtISO if both exist
    const createdA = left.createdAtISO;
    const createdB = right.createdAtISO;
    if (createdA && createdB) {
      merged.createdAtISO = isoToMs(createdA) <= isoToMs(createdB) ? createdA : createdB;
    } else {
      merged.createdAtISO = createdA || createdB || merged.createdAtISO;
    }

    // Keep latest deletedAtISO if either side deleted it
    const delA = left.deletedAtISO;
    const delB = right.deletedAtISO;
    if (delA || delB) {
      merged.deletedAtISO = isoToMs(delA) >= isoToMs(delB) ? delA : delB;
    }

    // Ensure updatedAtISO exists for versioning
    merged.updatedAtISO = newer.updatedAtISO || older.updatedAtISO || merged.updatedAtISO || merged.createdAtISO || null;

    return merged;
  }

  function habitVersionMs(h) {
    if (!isPlainObject(h)) return 0;
    return Math.max(
      isoToMs(h.updatedAtISO),
      isoToMs(h.createdAtISO)
    );
  }

  function mergeHabitRecords(a, b) {
    const left = isPlainObject(a) ? a : {};
    const right = isPlainObject(b) ? b : {};
    const leftV = habitVersionMs(left);
    const rightV = habitVersionMs(right);

    const newer = rightV >= leftV ? right : left;
    const older = rightV >= leftV ? left : right;

    // Older first, then newer overwrites
    let merged = deepMerge(older, newer);

    // Preserve earliest createdAtISO if both exist
    const createdA = left.createdAtISO;
    const createdB = right.createdAtISO;
    if (createdA && createdB) {
      merged.createdAtISO = isoToMs(createdA) <= isoToMs(createdB) ? createdA : createdB;
    } else {
      merged.createdAtISO = createdA || createdB || merged.createdAtISO;
    }

    // Ensure updatedAtISO exists for versioning
    merged.updatedAtISO = newer.updatedAtISO || older.updatedAtISO || merged.updatedAtISO || merged.createdAtISO || null;

    // De-dupe day key arrays (don’t force union so untoggles can win)
    merged.doneKeys = mergeStringArrayUnique(merged.doneKeys, []);
    merged.failedKeys = mergeStringArrayUnique(merged.failedKeys, []);

    return merged;
  }

  function mergeById(existingArr, incomingArr, mergeFn) {
    const existing = Array.isArray(existingArr) ? existingArr : [];
    const incoming = Array.isArray(incomingArr) ? incomingArr : [];

    const map = new Map();
    const order = [];
    const orderSeen = new Set();

    const upsert = (item, preferOrder) => {
      if (!isPlainObject(item)) return;
      const id = item.id;
      if (!id) return;

      const prev = map.get(id);
      map.set(id, prev ? mergeFn(prev, item) : item);

      if (preferOrder && !orderSeen.has(id)) {
        orderSeen.add(id);
        order.push(id);
      }
    };

    // Keep incoming order first (writer snapshot order)
    for (const item of incoming) upsert(item, true);

    // Add/merge any existing not mentioned in incoming
    for (const item of existing) {
      if (!isPlainObject(item) || !item.id) continue;
      const id = item.id;

      if (!map.has(id)) {
        map.set(id, item);
        if (!orderSeen.has(id)) {
          orderSeen.add(id);
          order.push(id);
        }
      } else {
        // merge without changing order
        map.set(id, mergeFn(map.get(id), item));
      }
    }

    return order.map((id) => map.get(id)).filter(Boolean);
  }

  function completionKey(c) {
    if (!isPlainObject(c)) return null;
    if (c.id) return `id:${c.id}`;
    const taskId = c.taskId || '';
    const at = c.completedAtISO || '';
    const src = c.source || '';
    const dk = c.dayKey || c.dateKey || '';
    return `k:${taskId}|${at}|${src}|${dk}`;
  }

  function mergeCompletions(existingArr, incomingArr) {
    const existing = Array.isArray(existingArr) ? existingArr : [];
    const incoming = Array.isArray(incomingArr) ? incomingArr : [];

    const seen = new Set();
    const out = [];

    const pushAll = (arr) => {
      for (const c of arr) {
        const key = completionKey(c);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    };

    // incoming first so newest snapshot stays “newest-first”
    pushAll(incoming);
    pushAll(existing);

    return out;
  }

function fastEnsureStateShape(s) {
  const src = (s && typeof s === 'object') ? s : {};
  return {
    ...src,
    tasks: Array.isArray(src.tasks) ? src.tasks : [],
    reminders: Array.isArray(src.reminders) ? src.reminders : [],
    completions: Array.isArray(src.completions) ? src.completions : [],
    habits: Array.isArray(src.habits) ? src.habits : [],
    players: Array.isArray(src.players) ? src.players : [],
    flexActions: Array.isArray(src.flexActions) ? src.flexActions : [],
    gameHistory: Array.isArray(src.gameHistory) ? src.gameHistory : [],
    matchups: Array.isArray(src.matchups) ? src.matchups : [],
    schedule: Array.isArray(src.schedule) ? src.schedule : [],
    opponentDripSchedules: Array.isArray(src.opponentDripSchedules) ? src.opponentDripSchedules : [],
    weightHistory: Array.isArray(src.weightHistory) ? src.weightHistory : [],
    vo2MaxHistory: Array.isArray(src.vo2MaxHistory) ? src.vo2MaxHistory : [],
    liveDiffHistory: isPlainObject(src.liveDiffHistory) ? src.liveDiffHistory : {},
    liveDiffSnapshots: isPlainObject(src.liveDiffSnapshots) ? src.liveDiffSnapshots : {},
    workHistory: Array.isArray(src.workHistory) ? src.workHistory : [],
    projects: Array.isArray(src.projects) ? src.projects : [],
    notes: typeof src.notes === 'string' ? src.notes : '',
    youImageId: typeof src.youImageId === 'string' ? src.youImageId : '',
    youName: typeof src.youName === 'string' ? src.youName : '',
    youPrimaryColor: normalizeHexColor(src.youPrimaryColor) || '#1a383b',
    youSecondaryColor: normalizeHexColor(src.youSecondaryColor) || '#254c52',
    habitTagColors: isPlainObject(src.habitTagColors) ? src.habitTagColors : {},
    scoringSettings: isPlainObject(src.scoringSettings)
      ? src.scoringSettings
      : normalizeScoringSettings(src.scoringSettings),
    currentSeason: normalizeCurrentSeason(src.currentSeason),
    latestSeasonId: typeof src.latestSeasonId === 'string' ? src.latestSeasonId : '',
    seasonHistory: normalizeSeasonHistory(src.seasonHistory)
  };
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

    // Protected Home histories are sticky across unrelated page saves. Matchups and
    // other feature pages often send partial state snapshots; those must never empty
    // weight/VO2/live-diff history unless the history-owning action passes an
    // explicit allowProtectedHistoryOverwrite flag/key.
    PROTECTED_HISTORY_KEYS.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(nextState || {}, key)) return;
      if (shouldAllowProtectedHistoryOverwrite(key, options)) return;
      if (protectedHistorySize(key, existing?.[key]) > 0 && protectedHistorySize(key, nextState?.[key]) === 0) {
        mergedSnapshot[key] = existing[key];
      }
    });

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'habitTagColors')) {
      const existingColors = normalizeHabitTagColors(existing?.habitTagColors);
      const existingHasColors = Object.keys(existingColors).length > 0;

      const { set: nextSet, del: nextDel } = parseHabitTagColorPatch(nextState?.habitTagColors);

      // allowChange is ONLY true when we explicitly allow overwriting sticky key behavior
      const allowChange =
        allowHabitTagColorReset || shouldAllowStickyOverwrite('habitTagColors', options);

      if (!allowChange) {
        // If overwrite isn’t allowed, preserve existing colors (don’t accept incoming empty maps)
        mergedSnapshot.habitTagColors = existingHasColors ? existingColors : nextSet;
      } else if (allowHabitTagColorReset) {
        // Full replace (import / explicit reset only)
        mergedSnapshot.habitTagColors = nextSet;
      } else {
        // PATCH merge:
        // - delete only requested keys
        // - set/update only requested keys
        // - preserve everything else
        const mergedColors = existingHasColors ? { ...existingColors } : {};
        for (const key of nextDel) delete mergedColors[key];
        Object.assign(mergedColors, nextSet);
        mergedSnapshot.habitTagColors = mergedColors;
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

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'youName')) {
      const allowOverwrite = shouldAllowStickyOverwrite('youName', options);
      const incoming = nextState?.youName;
      if (!allowOverwrite && isStickyEmptyValue('youName', incoming)) {
        mergedSnapshot.youName = existing?.youName || '';
      } else if (typeof incoming === 'string') {
        mergedSnapshot.youName = incoming;
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'youPrimaryColor')) {
      const allowOverwrite = shouldAllowStickyOverwrite('youPrimaryColor', options);
      const incoming = normalizeHexColor(nextState?.youPrimaryColor);
      if (!allowOverwrite && isStickyEmptyValue('youPrimaryColor', incoming)) {
        mergedSnapshot.youPrimaryColor = normalizeHexColor(existing?.youPrimaryColor) || '#1a383b';
      } else if (incoming) {
        mergedSnapshot.youPrimaryColor = incoming;
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'youSecondaryColor')) {
      const allowOverwrite = shouldAllowStickyOverwrite('youSecondaryColor', options);
      const incoming = normalizeHexColor(nextState?.youSecondaryColor);
      if (!allowOverwrite && isStickyEmptyValue('youSecondaryColor', incoming)) {
        mergedSnapshot.youSecondaryColor = normalizeHexColor(existing?.youSecondaryColor) || '#254c52';
      } else if (incoming) {
        mergedSnapshot.youSecondaryColor = incoming;
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextState || {}, 'scoringSettings')) {
      const allowOverwrite = shouldAllowStickyOverwrite('scoringSettings', options);
      const incoming = nextState?.scoringSettings;
      const hasExisting = Object.prototype.hasOwnProperty.call(existing || {}, 'scoringSettings');
      const existingSettings = normalizeScoringSettings(existing?.scoringSettings || {});

      if (!allowOverwrite) {
        if (hasExisting) {
          mergedSnapshot.scoringSettings = existingSettings;
        } else if (isPlainObject(incoming)) {
          mergedSnapshot.scoringSettings = normalizeScoringSettings(incoming);
        }
      } else if (isPlainObject(incoming)) {
        const normalizedIncoming = normalizeScoringSettings(incoming);
        mergedSnapshot.scoringSettings = deepMerge(existingSettings, normalizedIncoming);
      } else if (allowOverwrite && incoming == null) {
        mergedSnapshot.scoringSettings = existingSettings;
      }
    }

    mergedSnapshot.tasks = mergeById(existing?.tasks, (nextState || {})?.tasks, mergeTaskRecords);
    mergedSnapshot.completions = mergeCompletions(existing?.completions, (nextState || {})?.completions);
    mergedSnapshot.habits = mergeById(existing?.habits, (nextState || {})?.habits, mergeHabitRecords);


// 🔥 New: skip heavy normalize on “known-normalized” incremental saves
if (options.assumeNormalized) {
  return { state: fastEnsureStateShape(mergedSnapshot), storageKey };
}

const normalized = normalizeState(mergedSnapshot);
const merged = { ...mergedSnapshot, ...normalized };
return { state: merged, storageKey };


  }

  function summarizeSnapshotCounts(snapshot) {
    const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
      tasks: Array.isArray(safe.tasks) ? safe.tasks.length : 0,
      completions: Array.isArray(safe.completions) ? safe.completions.length : 0,
      habits: Array.isArray(safe.habits) ? safe.habits.length : 0,
      players: Array.isArray(safe.players) ? safe.players.length : 0,
      flexActions: Array.isArray(safe.flexActions) ? safe.flexActions.length : 0,
      gameHistory: Array.isArray(safe.gameHistory) ? safe.gameHistory.length : 0,
      matchups: Array.isArray(safe.matchups) ? safe.matchups.length : 0,
      schedule: Array.isArray(safe.schedule) ? safe.schedule.length : 0,
      opponentDripSchedules: Array.isArray(safe.opponentDripSchedules) ? safe.opponentDripSchedules.length : 0,
      workHistory: Array.isArray(safe.workHistory) ? safe.workHistory.length : 0,
      projects: Array.isArray(safe.projects) ? safe.projects.length : 0,
      reminders: Array.isArray(safe.reminders) ? safe.reminders.length : 0,
      seasonHistory: Array.isArray(safe.seasonHistory) ? safe.seasonHistory.length : 0
    };
  }

  function readStoredStateRaw(storageKey) {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      console.warn('Failed to parse existing TaskPoints snapshot for validation.', e);
      return {};
    }
  }

  function validateSnapshotShape(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { ok: false, reason: 'Incoming snapshot must be an object.' };
    }
    const requiredArrayKeys = [
      'tasks',
      'reminders',
      'completions',
      'habits',
      'players',
      'flexActions',
      'gameHistory',
      'matchups',
      'schedule',
      'opponentDripSchedules'
    ];

    const missingRequired = requiredArrayKeys.filter((key) => !Object.prototype.hasOwnProperty.call(snapshot, key));
    if (missingRequired.length > 0) {
      return { ok: false, reason: `Incoming snapshot missing required domains: ${missingRequired.join(', ')}` };
    }

    const wrongArrayTypes = requiredArrayKeys.filter((key) => !Array.isArray(snapshot[key]));
    if (wrongArrayTypes.length > 0) {
      return { ok: false, reason: `Expected array domains with wrong type: ${wrongArrayTypes.join(', ')}` };
    }

    const objectLikeChecks = ['scoringSettings', 'habitTagColors'];
    const wrongObjectTypes = objectLikeChecks.filter((key) =>
      Object.prototype.hasOwnProperty.call(snapshot, key)
      && snapshot[key] != null
      && (typeof snapshot[key] !== 'object' || Array.isArray(snapshot[key]))
    );
    if (wrongObjectTypes.length > 0) {
      return { ok: false, reason: `Expected object domains with wrong type: ${wrongObjectTypes.join(', ')}` };
    }

    const keys = Object.keys(snapshot);
    if (keys.length < 8) {
      return { ok: false, reason: `Incoming snapshot has too few top-level keys (${keys.length}).` };
    }

    const majorCollectionPresence = requiredArrayKeys.reduce((acc, key) => {
      if (Array.isArray(snapshot[key])) acc += 1;
      return acc;
    }, 0);
    if (majorCollectionPresence < 8) {
      return { ok: false, reason: 'Incoming snapshot appears partial; major collection domains are missing.' };
    }

    return { ok: true };
  }

  function detectSuspiciousDrop(nextSnapshot, storedSnapshot) {
    const next = summarizeSnapshotCounts(nextSnapshot);
    const current = summarizeSnapshotCounts(storedSnapshot);
    const trackedKeys = ['tasks', 'reminders', 'completions', 'habits', 'players', 'matchups', 'schedule', 'gameHistory'];

    let currentTotal = 0;
    let nextTotal = 0;
    let majorDrops = 0;
    const droppedDomains = [];
    trackedKeys.forEach((key) => {
      const before = Number(current[key]) || 0;
      const after = Number(next[key]) || 0;
      currentTotal += before;
      nextTotal += after;
      if (before < 12) return;
      const ratio = before === 0 ? 1 : (after / before);
      if (ratio <= 0.2) {
        majorDrops += 1;
        droppedDomains.push(`${key}:${before}->${after}`);
      }
    });

    if (currentTotal < 80) return { suspicious: false };
    if (majorDrops >= 2) {
      return {
        suspicious: true,
        reason: `Suspicious multi-domain drop detected (${droppedDomains.join(', ')})`
      };
    }
    if (currentTotal >= 250 && nextTotal <= Math.floor(currentTotal * 0.2)) {
      return {
        suspicious: true,
        reason: `Incoming snapshot shrank too aggressively (${currentTotal} -> ${nextTotal} tracked items).`
      };
    }
    return { suspicious: false };
  }

  function quarantineRejectedSnapshot(payload, reason, options = {}) {
    const payloadJson = (() => {
      try { return JSON.stringify(payload); } catch (_) { return ''; }
    })();
    const payloadBytes = payloadJson ? payloadJson.length * 2 : 0;
    const quarantined = {
      timestamp: new Date().toISOString(),
      reason,
      source: options.source || options.savePath || options.reason || options.caller || 'unknown',
      saveMode: options.saveMode || 'snapshot',
      summary: summarizeSnapshotCounts(payload),
      payloadBytes,
      payloadOmitted: payloadBytes > QUARANTINE_INLINE_MAX_BYTES
    };
    if (payloadBytes <= QUARANTINE_INLINE_MAX_BYTES) {
      quarantined.payload = payload;
    }
    try {
      localStorage.setItem(QUARANTINE_SNAPSHOT_KEY, JSON.stringify(quarantined));
      if (payloadBytes > QUARANTINE_INLINE_MAX_BYTES) {
        console.warn(`[TaskPoints] Quarantined snapshot payload is large (${(payloadBytes / (1024 * 1024)).toFixed(2)} MiB). Export a backup if needed; localStorage now stores metadata only.`);
      }
    } catch (e) {
      console.warn('Failed to persist quarantined TaskPoints snapshot.', e);
    }
  }

  function getLocalStorageSizeReport() {
    const entries = [];
    let totalBytes = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) || '';
      const bytes = (key.length + value.length) * 2;
      totalBytes += bytes;
      entries.push({ key, bytes });
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    return { totalBytes, entries };
  }

  function storeRollingBackup(storageKey, options = {}) {
    const currentRaw = localStorage.getItem(storageKey);
    if (!currentRaw) return;
    let parsedCurrent = {};
    try {
      parsedCurrent = JSON.parse(currentRaw) || {};
    } catch (e) {
      return;
    }
    const backupRecord = {
      timestamp: new Date().toISOString(),
      reason: options.source || options.savePath || options.reason || options.caller || 'snapshot-save',
      storageKey,
      summary: summarizeSnapshotCounts(parsedCurrent),
      state: parsedCurrent
    };
    try {
      for (let i = BACKUP_SLOT_KEYS.length - 1; i > 0; i -= 1) {
        const prev = localStorage.getItem(BACKUP_SLOT_KEYS[i - 1]);
        if (prev != null) {
          localStorage.setItem(BACKUP_SLOT_KEYS[i], prev);
        }
      }
      localStorage.setItem(BACKUP_SLOT_KEYS[0], JSON.stringify(backupRecord));
    } catch (e) {
      console.warn('Failed to rotate TaskPoints backups.', e);
    }
  }

  function preserveStickyFieldsBeforeSave(candidateState, storageKey = STORAGE_KEY, options = {}) {
    const next = candidateState && typeof candidateState === 'object' ? { ...candidateState } : {};
    let latest = null;
    try {
      latest = JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch (_) {
      latest = null;
    }
    const stickyArrayFields = [
      'tasks', 'completions', 'habits', 'players', 'flexActions',
      'gameHistory', 'matchups', 'schedule', 'weightHistory', 'vo2MaxHistory', 'reminders', 'seasonHistory'
    ];
    const stickyObjectFields = ['playerBadges', 'liveDiffHistory', 'liveDiffSnapshots'];
    const deletedReminderIds = new Set(Array.isArray(options.deletedReminderIds) ? options.deletedReminderIds.map(String) : []);
    stickyArrayFields.forEach((key) => {
      if (Array.isArray(next[key])) {
        if (!shouldAllowProtectedHistoryOverwrite(key, options) && Array.isArray(latest?.[key]) && latest[key].length > 0 && next[key].length === 0) {
          // Defensive data-loss guard: partial saves from pages like Matchups may
          // carry default empty Home histories. Preserve non-empty saved history
          // unless a history-owning delete/reset explicitly opts in.
          warnProtectedHistoryWipe(key, latest, next, options, storageKey);
          next[key] = latest[key];
        }
        return;
      }
      if (latest && Array.isArray(latest[key])) {
        next[key] = latest[key];
        return;
      }
      next[key] = [];
    });
    if (!options.allowDestructiveOverwrite && Array.isArray(latest?.seasonHistory) && latest.seasonHistory.length && (!Array.isArray(next.seasonHistory) || next.seasonHistory.length === 0)) {
      next.seasonHistory = latest.seasonHistory;
    }
    if (!options.allowDestructiveOverwrite && isSeasonObject(latest?.currentSeason) && !isSeasonObject(next.currentSeason)) {
      next.currentSeason = latest.currentSeason;
    }
    if (!options.allowDestructiveOverwrite && typeof latest?.latestSeasonId === 'string' && latest.latestSeasonId && (typeof next.latestSeasonId !== 'string' || !next.latestSeasonId)) {
      next.latestSeasonId = latest.latestSeasonId;
    }

    if (!options.allowDestructiveOverwrite && Array.isArray(latest?.reminders)) {
      const currentReminders = Array.isArray(next.reminders) ? next.reminders : [];
      const seen = new Set();
      const reminderKey = (reminder) => {
        if (!reminder || typeof reminder !== 'object') return '';
        if (reminder.id != null) return `id:${String(reminder.id)}`;
        const text = typeof reminder.text === 'string' ? reminder.text.trim() : '';
        return text ? `text:${text}|created:${String(reminder.createdAtISO || '')}` : '';
      };
      const mergedReminders = [];
      currentReminders.forEach((reminder) => {
        const key = reminderKey(reminder);
        if (!key || seen.has(key)) return;
        seen.add(key);
        mergedReminders.push(reminder);
      });
      latest.reminders.forEach((reminder) => {
        const key = reminderKey(reminder);
        const id = reminder && reminder.id != null ? String(reminder.id) : '';
        if (!key || seen.has(key) || (id && deletedReminderIds.has(id))) return;
        seen.add(key);
        mergedReminders.push(reminder);
      });
      next.reminders = mergedReminders;
    }
    stickyObjectFields.forEach((key) => {
      if (next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
        if (!shouldAllowProtectedHistoryOverwrite(key, options) && protectedHistorySize(key, latest?.[key]) > 0 && protectedHistorySize(key, next[key]) === 0) {
          // Keep live H2H differential samples/snapshots sticky across unrelated
          // saves; graph code can still intentionally reset at its 5 AM boundary
          // by passing an explicit allowProtectedHistoryOverwrite key.
          warnProtectedHistoryWipe(key, latest, next, options, storageKey);
          next[key] = latest[key];
        }
        return;
      }
      if (latest && latest[key] && typeof latest[key] === 'object' && !Array.isArray(latest[key])) {
        next[key] = latest[key];
        return;
      }
      next[key] = {};
    });
    return next;
  }

  function saveStateSnapshot(state, options = {}) {
    const debugEnabled = Boolean(global && global.TP_DEBUG_PERF);
    const summarizeStateSizes = (snapshot) => ({
      completions: Array.isArray(snapshot?.completions) ? snapshot.completions.length : 0,
      gameHistory: Array.isArray(snapshot?.gameHistory) ? snapshot.gameHistory.length : 0,
      matchups: Array.isArray(snapshot?.matchups) ? snapshot.matchups.length : 0,
      workHistory: Array.isArray(snapshot?.workHistory) ? snapshot.workHistory.length : 0,
      schedule: Array.isArray(snapshot?.schedule) ? snapshot.schedule.length : 0
    });
    const savePath = options.savePath || options.source || options.reason || options.caller || 'unknown';
    let lastQuotaError = null;
    const callsite = debugEnabled ? (new Error().stack || '').split('\n').slice(2, 4).map(line => line.trim()).join(' <- ') : '';
    const beforeSummary = summarizeStateSizes(state);
    const logStage = (stage, snapshot) => {
      if (!debugEnabled) return;
      const size = summarizeStateSizes(snapshot);
      console.log(`[TP saveStateSnapshot] stage=${stage} completions=${size.completions} gameHistory=${size.gameHistory} matchups=${size.matchups} workHistory=${size.workHistory} schedule=${size.schedule}`);
    };
    const setQuotaTrimMarker = (stage, afterSummary, trimmed) => {
      if (!global || !global.window || !trimmed) return;
      global.window.__tpLastQuotaTrim = {
        time: new Date().toISOString(),
        stage,
        before: beforeSummary,
        after: afterSummary,
        trimmed: true
      };
    };

    const storageKey = options.storageKey || STORAGE_KEY;
    const logQuotaDebug = () => {
      try {
        const report = getLocalStorageSizeReport();
        const keySizeBytes = (key) => {
          const raw = localStorage.getItem(key);
          return raw ? (key.length + raw.length) * 2 : 0;
        };
        console.warn('[TaskPoints] saveStateSnapshot quota debug', {
          storageKey,
          taskpoints_v1_bytes: keySizeBytes(STORAGE_KEY),
          taskpoints_quarantined_snapshot_bytes: keySizeBytes(QUARANTINE_SNAPSHOT_KEY),
          localStorage_total_bytes: report.totalBytes,
          largest_keys: report.entries.slice(0, 8)
        });
      } catch (e) {
        console.warn('[TaskPoints] quota debug logging failed', e);
      }
    };
    const appendStorageWarning = (snapshot, warning) => {
      const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const warnings = Array.isArray(base.storageWarnings) ? base.storageWarnings.slice() : [];
      warnings.push(warning);
      return { ...base, storageWarnings: warnings };
    };
    const attemptSave = (candidate, trimmed, stage = 'initial') => {
      const candidateWithSticky = preserveStickyFieldsBeforeSave(candidate, storageKey, options);
      localStorage.setItem(storageKey, JSON.stringify(candidateWithSticky));
      const savedRaw = localStorage.getItem(storageKey);
      const saved = savedRaw ? (JSON.parse(savedRaw) || {}) : {};
      const criticalArrays = ['completions', 'matchups', 'gameHistory', 'weightHistory', 'vo2MaxHistory', 'reminders'];
      const failed = criticalArrays.filter((key) => (
        Array.isArray(candidateWithSticky[key])
        && candidateWithSticky[key].length > 0
        && (!Array.isArray(saved[key]) || saved[key].length < candidateWithSticky[key].length)
      ));
      ['liveDiffHistory', 'liveDiffSnapshots'].forEach((key) => {
        if (protectedHistorySize(key, candidateWithSticky[key]) > 0 && protectedHistorySize(key, saved[key]) < protectedHistorySize(key, candidateWithSticky[key])) {
          failed.push(key);
        }
      });
      if (failed.length) {
        if (typeof alert === 'function') {
          alert('Save verification failed: reminders, weightHistory, vo2MaxHistory, or live diff history were not preserved.');
        }
        throw new Error(`Save verification failed: reminders, weightHistory, vo2MaxHistory, or live diff history were not preserved. Failed keys: ${failed.join(', ')}`);
      }
      if (debugEnabled) {
        const size = summarizeStateSizes(candidateWithSticky);
        console.log(`[TP saveStateSnapshot] success stage=${stage} trimmed=${trimmed} savePath=${savePath} storageKey=${storageKey} completions=${size.completions} gameHistory=${size.gameHistory} matchups=${size.matchups} workHistory=${size.workHistory} schedule=${size.schedule}`);
      }
      setQuotaTrimMarker(stage, summarizeStateSizes(candidateWithSticky), trimmed);
      return { state: candidateWithSticky, trimmed };
    };

    if (debugEnabled) {
      console.log(`[TP saveStateSnapshot] start savePath=${savePath} storageKey=${storageKey} completionsBeforeFirstSave=${beforeSummary.completions}${callsite ? ` callsite=${callsite}` : ''}`);
    }

    const initialCandidate = cleanupOpponentDripSchedules(state, {
      maxEntries: Number.isFinite(options?.limits?.maxOpponentDripSchedules) ? options.limits.maxOpponentDripSchedules : 120
    });
    try {
      return attemptSave(initialCandidate, false, 'initial');
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
      if (debugEnabled) {
        console.log(`[TP saveStateSnapshot] firstSaveQuotaError=true savePath=${savePath} storageKey=${storageKey}`);
      }
    }

    logStage('initial pruneStateForStorage(state, options.limits)', state);
    const trimmed = pruneStateForStorage(state, options.limits);
    logStage('initial-pruned', trimmed);
    try {
      return attemptSave(trimmed, true, 'initial-pruned');
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
    }

    const imagePreservingLimitSets = [
      { maxWorkHistory: 2000 },
      { maxWorkHistory: 1500 },
      { maxWorkHistory: 1000 },
      { maxWorkHistory: 800 },
      { maxWorkHistory: 500 },
      { maxWorkHistory: 250 }
    ];

    for (let i = 0; i < imagePreservingLimitSets.length; i += 1) {
      const limits = imagePreservingLimitSets[i];
      const tightenedLimits = {
        ...options.limits,
        maxWorkHistory: capLimit(options.limits?.maxWorkHistory, limits.maxWorkHistory),
        stripImages: false
      };
      const tightened = pruneStateForStorage(state, tightenedLimits);
      logStage(`imagePreserving[${i}]`, tightened);
      try {
        return attemptSave(tightened, true, `imagePreserving[${i}]`);
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        lastQuotaError = err;
      }
    }

    const stripped = pruneStateForStorage(trimmed, { ...options.limits, stripImages: true });
    logStage('stripImages', stripped);
    try {
      return attemptSave(stripped, true, 'stripImages');
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
    }

    const aggressiveLimits = {
      ...options.limits,
      maxWorkHistory: capLimit(options.limits?.maxWorkHistory, 1000),
      stripImages: true
    };
    const aggressive = pruneStateForStorage(stripped, aggressiveLimits);
    logStage('aggressive', aggressive);
    try {
      return attemptSave(aggressive, true, 'aggressive');
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
    }

    const fallbackLimitSets = [
      { maxWorkHistory: 500 },
      { maxWorkHistory: 250 },
      { maxWorkHistory: 125 },
      { maxWorkHistory: 50 }
    ];

    for (let i = 0; i < fallbackLimitSets.length; i += 1) {
      const limits = fallbackLimitSets[i];
      const tightenedLimits = {
        ...options.limits,
        maxWorkHistory: capLimit(options.limits?.maxWorkHistory, limits.maxWorkHistory),
        stripImages: true
      };
      const tightened = pruneStateForStorage(aggressive, tightenedLimits);
      logStage(`fallback[${i}]`, tightened);
      try {
        return attemptSave(tightened, true, `fallback[${i}]`);
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        lastQuotaError = err;
      }
    }

    const emergency = {
      ...aggressive,
      schedule: [],
      opponentDripSchedules: [],
      workHistory: []
    };
    logStage('emergency', emergency);
    try {
      return attemptSave(emergency, true, 'emergency');
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
    }

    const largestKeysSummary = (() => {
      try {
        const report = getLocalStorageSizeReport();
        return report.entries.slice(0, 3).map((entry) => `${entry.key} ${(entry.bytes / (1024 * 1024)).toFixed(2)} MiB`).join(', ');
      } catch (_) {
        return '';
      }
    })();
    const quarantineHint = localStorage.getItem(QUARANTINE_SNAPSHOT_KEY)
      ? ' Tip: delete taskpoints_quarantined_snapshot from Settings → Storage Health.'
      : '';
    const latestBackupRaw = localStorage.getItem('taskpoints_backup_latest');
    const latestBackupHint = latestBackupRaw
      ? ` taskpoints_backup_latest is using ${(getUtf8SizeBytes(latestBackupRaw) / (1024 * 1024)).toFixed(2)} MiB. Delete it from Storage Health to free space.`
      : '';
    const quotaMessage = `Browser storage is full. Save failed. Biggest localStorage keys: ${largestKeysSummary || 'unavailable'}.${latestBackupHint} Historical completions, matchups, game history, weight history, and VO2 Max history were preserved.${quarantineHint}`;
    const quotaWarning = {
      type: 'storage-quota-save-failed',
      atISO: new Date().toISOString(),
      message: quotaMessage
    };
    const warningState = appendStorageWarning(state, quotaWarning);
    try {
      localStorage.setItem(storageKey, JSON.stringify(warningState));
    } catch (warningErr) {
      console.warn('TaskPointsCore: unable to persist storage warning after quota failure.', warningErr);
    }
    console.error('TaskPointsCore: save failed due to browser storage quota. Critical historical data was preserved and not pruned.', lastQuotaError || new Error('Quota exceeded'));
    if (typeof alert === 'function') {
      alert(quotaMessage);
    }
    logQuotaDebug();
    throw lastQuotaError || new Error('TaskPointsCore save failed: browser storage quota exceeded');
  }

  // Full snapshot writes are potentially destructive. Use this helper for replace-all flows:
  // imports, explicit resets, and restore operations. Patch/merge saves should keep using
  // mergeAndSaveState/saveAppState and should not go through this guard.
  function saveValidatedSnapshot(state, options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    const shapeCheck = validateSnapshotShape(state);
    if (!shapeCheck.ok) {
      quarantineRejectedSnapshot(state, shapeCheck.reason, options);
      console.warn(`[TaskPoints] Blocked full snapshot write (shape validation failed): ${shapeCheck.reason}`);
      return { state: readStoredStateRaw(storageKey), blocked: true, reason: shapeCheck.reason, trimmed: false };
    }

    const storedState = readStoredStateRaw(storageKey);
    if (!options.allowDestructiveOverwrite) {
      const dropCheck = detectSuspiciousDrop(state, storedState);
      if (dropCheck.suspicious) {
        quarantineRejectedSnapshot(state, dropCheck.reason, options);
        console.warn(`[TaskPoints] Blocked full snapshot write (suspicious drop): ${dropCheck.reason}`);
        return { state: storedState, blocked: true, reason: dropCheck.reason, trimmed: false };
      }
    }

    storeRollingBackup(storageKey, options);
    return saveStateSnapshot(state, options);
  }

  function getRecoveryCandidate(options = {}) {
    const storageKey = options.storageKey || STORAGE_KEY;
    const current = readStoredStateRaw(storageKey);
    const currentShape = validateSnapshotShape(current);
    const currentSummary = summarizeSnapshotCounts(current);

    const currentTotal =
      currentSummary.tasks + currentSummary.completions + currentSummary.habits + currentSummary.players
      + currentSummary.matchups + currentSummary.schedule + currentSummary.gameHistory;
    if (currentShape.ok && currentTotal >= 30) return null;

    for (let i = 0; i < BACKUP_SLOT_KEYS.length; i += 1) {
      const slotKey = BACKUP_SLOT_KEYS[i];
      let parsed = null;
      try {
        const raw = localStorage.getItem(slotKey);
        parsed = raw ? (JSON.parse(raw) || null) : null;
      } catch (e) {
        parsed = null;
      }
      if (!parsed || !parsed.state) continue;
      const backupShape = validateSnapshotShape(parsed.state);
      if (!backupShape.ok) continue;
      const summary = summarizeSnapshotCounts(parsed.state);
      const backupTotal =
        summary.tasks + summary.completions + summary.habits + summary.players
        + summary.matchups + summary.schedule + summary.gameHistory;
      if (backupTotal > Math.max(40, currentTotal + 20)) {
        return {
          slotKey,
          timestamp: parsed.timestamp || '',
          reason: parsed.reason || '',
          summary,
          state: parsed.state
        };
      }
    }
    return null;
  }

  function restoreBackupSlot(slotKey, options = {}) {
    if (!slotKey) return { restored: false, reason: 'Missing backup slot key.' };
    let parsed = null;
    try {
      const raw = localStorage.getItem(slotKey);
      parsed = raw ? (JSON.parse(raw) || null) : null;
    } catch (e) {
      return { restored: false, reason: 'Backup slot is unreadable.' };
    }
    if (!parsed?.state) return { restored: false, reason: 'Backup slot is empty.' };
    const result = saveValidatedSnapshot(parsed.state, {
      ...options,
      allowDestructiveOverwrite: true,
      source: options.source || `backup-restore:${slotKey}`
    });
    return { restored: !result?.blocked, result, slotKey };
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
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) d = fromKey(d);
    else if (!(d instanceof Date)) d = new Date(d);
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

  let rawHours = Number.isFinite(hours) ? hours : 0;
  rawHours = Math.max(0, rawHours);

  const threshold = Number.isFinite(work.hoursMin) ? work.hoursMin : 0;
  let overtimeHours = Math.max(0, rawHours - threshold);

  if (Number.isFinite(work.hoursMax)) {
    overtimeHours = Math.min(overtimeHours, work.hoursMax);
  }

  return (overtimeHours * work.hoursMultiplier) + work.hoursOffset;
}

  function workPoints(score, hours = 0, settings) {
    if (!Number.isFinite(score)) return 0;
    const scoring = getScoringSettings(settings);
    const work = scoring.work;
    const base = (score * work.baseMultiplier) + work.baseOffset;
    return base + workHoursBonus(hours, scoring);
  }

function computeMomentumEffects(options = {}) {
  const baseline = Number(options.baseline);
  const variance = Number(options.variance);
  const varianceTiltRaw = Number(options.varianceTiltRaw);
  const momentum = Number(options.momentum);
  const prevScore = Number(options.prevScore);

  const safeBaseline = Number.isFinite(baseline) ? baseline : 0;
  const safeVariance = Math.max(1, Math.abs(Number.isFinite(variance) ? variance : 0));
  const baseTiltRaw = Math.min(
    100,
    Math.max(0, Number.isFinite(varianceTiltRaw) ? varianceTiltRaw : 50)
  );

  const momentumStrength = Math.min(
    100,
    Math.max(0, Number.isFinite(momentum) ? momentum : 0)
  ) / 100;

  // A previous score has to be meaningfully above/below baseline to start a streak.
  const deadZone = Number.isFinite(Number(options.deadZone))
    ? Number(options.deadZone)
    : 5;

  // How much previous performance affects today's raw score.
  const scoreMultiplier = Number.isFinite(Number(options.scoreMultiplier))
    ? Number(options.scoreMultiplier)
    : 0.35;

  // Maximum temporary Tilt shift in either direction.
  const maxTiltShift = Number.isFinite(Number(options.maxTiltShift))
    ? Number(options.maxTiltShift)
    : 15;

  // Prevent one absurd score from creating an infinite heater/slump.
  const maxDeltaVarianceMultiplier = Number.isFinite(Number(options.maxDeltaVarianceMultiplier))
    ? Number(options.maxDeltaVarianceMultiplier)
    : 2;

  const maxDelta = Math.max(
    deadZone + safeVariance,
    safeVariance * maxDeltaVarianceMultiplier
  );

  let momentumBonus = 0;
  let momentumTiltShift = 0;
  let prevDelta = null;
  let streakActive = false;

  if (momentumStrength > 0 && Number.isFinite(prevScore)) {
    prevDelta = prevScore - safeBaseline;
    const absDelta = Math.abs(prevDelta);

    if (absDelta > deadZone) {
      const cappedDelta = Math.max(-maxDelta, Math.min(maxDelta, prevDelta));
      const absCappedDelta = Math.abs(cappedDelta);
      const direction = cappedDelta > 0 ? 1 : -1;

      const streakSeverity = Math.min(
        1,
        Math.max(0, (absCappedDelta - deadZone) / safeVariance)
      );

      momentumBonus = cappedDelta * momentumStrength * scoreMultiplier;
      momentumTiltShift = direction * streakSeverity * momentumStrength * maxTiltShift;
      streakActive = true;
    }
  }

  const effectiveVarianceTiltRaw = Math.min(
    100,
    Math.max(0, baseTiltRaw + momentumTiltShift)
  );

  return {
    momentumBonus,
    momentumTiltShift,
    effectiveVarianceTiltRaw,
    effectiveVarianceTilt: effectiveVarianceTiltRaw / 100,
    baseVarianceTiltRaw: baseTiltRaw,
    prevDelta,
    streakActive
  };
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

  function computeCalLogBonusPoints(calorieEntries, settings) {
    const scoring = getScoringSettings(settings);
    const logBonus = Number(scoring?.calories?.logBonus) || 0;
    if (!logBonus) return 0;

    const hasLoggedCalories = Array.isArray(calorieEntries) && calorieEntries.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const rawCalories = Object.prototype.hasOwnProperty.call(entry, 'calories')
        ? Number(entry.calories)
        : parseCaloriesFromTitle(entry.title);
      const calories = Number.isFinite(rawCalories) ? rawCalories : 0;
      return calories > 0;
    });
    return hasLoggedCalories ? logBonus : 0;
  }

  function getMoodInfo(entry) {
    const title = typeof entry?.title === 'string' ? entry.title : '';
    const match = title.match(/^Mood Score\s*\(([-0-9]+(?:\.\d+)?)\)/i);
    const score = match ? Number(match[1]) : null;
    return { score };
  }

  function parseOptionalNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function parseSleepRestedFromTitle(title) {
    if (typeof title !== 'string') return null;
    const match = title.match(/rest(?:ed)?[^0-9-]*([-0-9]+(?:\.\d+)?)/i);
    return match ? parseOptionalNumber(match[1]) : null;
  }

  function parseWorkHoursFromTitle(title) {
    if (typeof title !== 'string') return null;
    const match = title.match(/hours?[^0-9-]*([-0-9]+(?:\.\d+)?)/i);
    return match ? parseOptionalNumber(match[1]) : null;
  }

  function classifyPersonalMetricCompletion(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const sleep = getSleepInfo(entry);
    if (Number.isFinite(sleep.score)) {
      const explicitRested = Object.prototype.hasOwnProperty.call(entry, 'sleepRested')
        ? parseOptionalNumber(entry.sleepRested)
        : null;
      return {
        type: 'sleep',
        rawValue: sleep.score,
        secondaryValue: explicitRested ?? parseSleepRestedFromTitle(entry.title)
      };
    }

    const work = getWorkInfo(entry);
    if (Number.isFinite(work.score)) {
      const explicitHours = Object.prototype.hasOwnProperty.call(entry, 'workHours')
        ? parseOptionalNumber(entry.workHours)
        : null;
      return {
        type: 'work',
        rawValue: work.score,
        secondaryValue: explicitHours ?? parseWorkHoursFromTitle(entry.title)
      };
    }

    const calories = Object.prototype.hasOwnProperty.call(entry, 'calories')
      ? parseOptionalNumber(entry.calories)
      : parseCaloriesFromTitle(entry.title);
    if (Number.isFinite(calories)) {
      return { type: 'calories', rawValue: calories, secondaryValue: null };
    }

    const mood = getMoodInfo(entry);
    if (Number.isFinite(mood.score)) {
      return { type: 'mood', rawValue: mood.score, secondaryValue: null };
    }

    return null;
  }

  function buildPersonalScoreHistoryRows(inputState) {
    const state = normalizeState(inputState || {});
    const completions = Array.isArray(state?.completions) ? state.completions : [];
    const rows = [];

    completions.forEach((entry) => {
      const parsed = classifyPersonalMetricCompletion(entry);
      if (!parsed) return;

      const completedAtISO = typeof entry?.completedAtISO === 'string'
        ? entry.completedAtISO
        : (typeof entry?.completedAt === 'string' ? entry.completedAt : '');
      const date = completedAtISO ? dateKey(completedAtISO) : dateKey(entry?.dateKey);
      const safeDate = date === 'invalid' ? '' : date;
      const points = parseOptionalNumber(entry?.points);

      rows.push({
        completion_id: entry?.id || '',
        date: safeDate,
        type: parsed.type,
        raw_value: parsed.rawValue,
        secondary_value: parsed.secondaryValue,
        points: points == null ? '' : points,
        title: typeof entry?.title === 'string' ? entry.title : '',
        completed_at_iso: completedAtISO || '',
        source: typeof entry?.source === 'string' ? entry.source : ''
      });
    });

    return rows.sort((a, b) => {
      const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
      if (dateCmp !== 0) return dateCmp;
      const isoCmp = String(a.completed_at_iso || '').localeCompare(String(b.completed_at_iso || ''));
      if (isoCmp !== 0) return isoCmp;
      return String(a.completion_id || '').localeCompare(String(b.completion_id || ''));
    });
  }

  function buildCsvTextFromRows(rows, headers) {
    const list = Array.isArray(rows) ? rows : [];
    const cols = Array.isArray(headers) && headers.length ? headers : [];
    const escapeCell = (value) => {
      if (value == null) return '';
      const str = String(value);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [];
    lines.push(cols.join(','));
    list.forEach((row) => {
      lines.push(cols.map((col) => escapeCell(row?.[col])).join(','));
    });
    return `\uFEFF${lines.join('\n')}`;
  }

  function buildPersonalScoreHistoryCsv(inputState) {
    const headers = [
      'completion_id',
      'date',
      'type',
      'raw_value',
      'secondary_value',
      'points',
      'title',
      'completed_at_iso',
      'source'
    ];
    const rows = buildPersonalScoreHistoryRows(inputState);
    return {
      headers,
      rows,
      csvText: buildCsvTextFromRows(rows, headers)
    };
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
    const flexId = entry?.flexId;
    if (flexId && Array.isArray(settings?.flexActions)) {
      const flexAction = settings.flexActions.find(f => f && f.id === flexId);
      const flexPoints = Number(flexAction?.points);
      if (Number.isFinite(flexPoints)) {
        return {
          points: roundPoints(flexPoints),
          formula: 'flex',
          inputs: { flexId, name: flexAction?.name }
        };
      }
    }
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

    const calorieEntriesByDay = new Map();

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

      const caloriesRaw = Object.prototype.hasOwnProperty.call(c, 'calories')
        ? Number(c.calories)
        : parseCaloriesFromTitle(c.title);
      if (Number.isFinite(caloriesRaw)) {
        if (!calorieEntriesByDay.has(dk)) calorieEntriesByDay.set(dk, []);
        calorieEntriesByDay.get(dk).push(c);
      }
    });

    calorieEntriesByDay.forEach((entries, dk) => {
      const bonus = computeCalLogBonusPoints(entries, settings);
      if (!bonus) return;

      const d = fromKey(dk);
      if (!d || isNaN(d.getTime())) return;
      const wk = isoWeekKey(d);
      const mk = monthKey(d);

      dailyTotals[dk] = addPoints(dailyTotals[dk], bonus);
      weeklyTotals[wk] = addPoints(weeklyTotals[wk], bonus);
      monthlyTotals[mk] = addPoints(monthlyTotals[mk], bonus);
    });

    return { dailyTotals, weeklyTotals, monthlyTotals };
  }

  // Compute totals-with-inertia for ALL days in one pass (avoids O(N^2) callers)
  function computeInertiaMaps(dailyTotals, settings, extraKeys){
    const scoring = getScoringSettings(settings);
    const inertiaSettings = scoring.inertia;
    const totalsObj = dailyTotals && typeof dailyTotals === 'object' ? dailyTotals : {};
    const extras = Array.isArray(extraKeys) ? extraKeys : (extraKeys ? [extraKeys] : []);

    const keys = Array.from(new Set([...Object.keys(totalsObj), ...extras]))
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
      const base = Number(totalsObj[k]) || 0;
      totalsWithInertia.set(k, base + inertia);
    });

    return { keys, inertiaMap, totalsWithInertia };
  }

  // Convenience: return a plain object of totals already including inertia
  function computeDailyTotalsWithInertia(dailyTotals, settings, extraKeys){
    const { totalsWithInertia } = computeInertiaMaps(dailyTotals, settings, extraKeys);
    const out = {};
    totalsWithInertia.forEach((v, k) => { out[k] = v; });
    return out;
  }

  function computeInertia(dailyTotals, todayK, settings){
    const { inertiaMap } = computeInertiaMaps(dailyTotals, settings, todayK);
    return inertiaMap.get(todayK) || { inertia: 0, average: 0 };
  }


  function deriveTodayWithInertia(dailyTotals, todayK, settings){
    const { inertia, average } = computeInertia(dailyTotals, todayK, settings);
    const todayBase = Number(dailyTotals[todayK]) || 0;
    const todayPoints = roundPoints(todayBase + inertia, 2);

    return { todayPoints, inertia, average, base: todayBase };
  }

function buildDailyBreakdowns(state){
  const normalized = normalizeState(state || {});
  const comps = Array.isArray(normalized.completions) ? normalized.completions : [];

  const loggedKeys = Array.from(new Set(
    comps
      .map(c => (c && c.completedAtISO ? dateKey(c.completedAtISO) : null))
      .filter(Boolean)
  ))
    .filter(k => {
      const d = fromKey(k);
      return d && !isNaN(d.getTime());
    })
    .sort((a, b) => fromKey(a) - fromKey(b));

  if (!loggedKeys.length) return {};

  const start = fromKey(loggedKeys[0]);
  const latestLogged = fromKey(loggedKeys[loggedKeys.length - 1]);
  const today = fromKey(todayKey());
  const end = latestLogged > today ? latestLogged : today;

  const out = {};

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateKey(cursor);
    const snapshot = buildDaySnapshot(key, normalized);
    const totals = computeDayTotals(snapshot);

    const hasItems = Array.isArray(snapshot.items) && snapshot.items.length > 0;
    const hasInertia = Math.abs(Number(snapshot.inertia) || 0) > 0.01;
    const hasTotal = Math.abs(Number(totals.total) || 0) > 0.01;

    if (!hasItems && !hasInertia && !hasTotal) continue;

    out[key] = {
      total: totals.total,
      categories: { ...totals.byCategory }
    };
  }

  return out;
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

    const calorieEntries = dayComps.filter((entry) => {
      const caloriesRaw = Object.prototype.hasOwnProperty.call(entry || {}, 'calories')
        ? Number(entry.calories)
        : parseCaloriesFromTitle(entry?.title);
      return Number.isFinite(caloriesRaw);
    });
    const calLogBonusPoints = computeCalLogBonusPoints(calorieEntries, normalized);
    if (calLogBonusPoints) {
      items.push({
        source: CAL_LOG_BONUS_SOURCE,
        id: CAL_LOG_BONUS_SOURCE,
        label: 'Cal Log Bonus',
        category: 'calLogBonus',
        points: calLogBonusPoints,
        details: { reason: 'Applied when any calories over 0 are logged' }
      });
    }

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

  function addDaysToDateKey(baseKey, days = 1){
    const baseDate = fromKey(baseKey);
    if (!baseDate || isNaN(baseDate.getTime())) return '';
    const next = new Date(baseDate);
    next.setDate(next.getDate() + (Number(days) || 0));
    return dateKey(next);
  }

  function normalizePairIds(aId, bId){
    const a = String(aId || '');
    const b = String(bId || '');
    return a <= b ? [a, b] : [b, a];
  }

  function auditTodayScheduleVsMatchups(state, options = {}){
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const today = options.todayKey || todayKey();

    const scheduleDay = (normalized.schedule || []).find((day) => (
      day && (day.date === today || day.dateKey === today)
    ));
    const schedulePairsRaw = Array.isArray(scheduleDay?.matchups) ? scheduleDay.matchups : [];
    const matchupPairsRaw = (normalized.matchups || []).filter((m) => matchupDateKey(m) === today);

    const toPairKey = (aId, bId) => normalizePairIds(aId, bId).join('|');
    const toPairList = (pairs) => pairs.map((m) => {
      const [playerAId, playerBId] = normalizePairIds(m?.playerAId, m?.playerBId);
      return { playerAId, playerBId, key: toPairKey(playerAId, playerBId) };
    });

    const schedulePairs = toPairList(schedulePairsRaw);
    const matchupPairs = toPairList(matchupPairsRaw);

    const countKeys = (pairs) => {
      const map = new Map();
      pairs.forEach((pair) => {
        map.set(pair.key, (map.get(pair.key) || 0) + 1);
      });
      return map;
    };

    const scheduleCounts = countKeys(schedulePairs);
    const matchupCounts = countKeys(matchupPairs);

    const toDuplicateList = (counts) => Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([key, count]) => {
        const [playerAId, playerBId] = key.split('|');
        return { playerAId, playerBId, count };
      });

    const allKeys = new Set([
      ...Array.from(scheduleCounts.keys()),
      ...Array.from(matchupCounts.keys())
    ]);

    const missingInSchedule = [];
    const missingInMatchups = [];

    allKeys.forEach((key) => {
      const scheduleCount = scheduleCounts.get(key) || 0;
      const matchupCount = matchupCounts.get(key) || 0;
      const [playerAId, playerBId] = key.split('|');
      if (scheduleCount > matchupCount) {
        missingInMatchups.push({ playerAId, playerBId, count: scheduleCount - matchupCount });
      } else if (matchupCount > scheduleCount) {
        missingInSchedule.push({ playerAId, playerBId, count: matchupCount - scheduleCount });
      }
    });

    const duplicateSchedulePairs = toDuplicateList(scheduleCounts);
    const duplicateMatchupPairs = toDuplicateList(matchupCounts);
    const countsMatch = schedulePairs.length === matchupPairs.length;

    return {
      ok: countsMatch
        && !missingInSchedule.length
        && !missingInMatchups.length
        && !duplicateSchedulePairs.length
        && !duplicateMatchupPairs.length,
      todayKey: today,
      schedulePairs,
      matchupPairs,
      missingInSchedule,
      missingInMatchups,
      duplicateSchedulePairs,
      duplicateMatchupPairs
    };
  }

  function isMatchupRevealed(dateKeyStr, options = {}){
    if (!dateKeyStr) return false;
    const includeToday = options.includeToday === true;
    const today = todayKey();
    if (includeToday) return dateKeyStr <= today;
    return dateKeyStr < today;
  }

  function computeInertiaForExtraDayKey(dayKey, totalsWithInertiaMap, settings){
    const keyDate = fromKey(dayKey);
    if (!keyDate || isNaN(keyDate.getTime())) return { inertia: 0, average: 0 };

    const scoring = getScoringSettings(settings);
    const inertiaSettings = scoring.inertia;
    let sum = 0;
    let count = 0;

    for (let i = 1; i <= inertiaSettings.windowDays; i++) {
      const d = new Date(keyDate);
      d.setDate(keyDate.getDate() - i);
      const prevKey = dateKey(d);
      const total = totalsWithInertiaMap.get(prevKey);
      if (Number.isFinite(total)) {
        sum += total;
        count++;
      }
    }

    const average = count ? sum / count : 0;
    const inertia = count ? average * inertiaSettings.multiplier : 0;
    return { inertia, average };
  }

  function buildYouDayScoreMap(state, options = {}){
    // Invariant: options.normalized is only set when state already passed through normalizeState().
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const perfEnabled = !!global.TP_DEBUG_PERF;
    const t0 = perfEnabled && global.performance && typeof global.performance.now === 'function'
      ? global.performance.now()
      : 0;
    let aggregateCalls = 0;

    const aggregated = (() => {
      aggregateCalls += 1;
      return aggregateCompletionsByDate(normalized.completions, normalized);
    })();
    const dailyTotals = aggregated.dailyTotals || {};
    const dayKeys = Array.from(new Set([
      ...Object.keys(dailyTotals),
      ...(normalized.matchups || [])
        .map(matchupDateKey)
        .filter(Boolean),
    ]));

    const { inertiaMap: baseInertiaMap, totalsWithInertia } = computeInertiaMaps(dailyTotals, normalized);
    const dayScoreMap = new Map();
    const dailyKeySet = new Set(Object.keys(dailyTotals));

    dayKeys.forEach((key) => {
      const rawBaseTotal = Number(dailyTotals[key]) || 0;
      const sourceInertia = dailyKeySet.has(key)
        ? (baseInertiaMap.get(key) || { inertia: 0, average: 0 })
        : computeInertiaForExtraDayKey(key, totalsWithInertia, normalized);
      const rawInertia = Number.isFinite(sourceInertia.inertia) ? sourceInertia.inertia : 0;
      const rawAverage = Number.isFinite(sourceInertia.average) ? sourceInertia.average : 0;
      const roundedInertia = roundPoints(rawInertia, 2);
      const rawFinalTotal = rawBaseTotal + rawInertia;
      const roundedFinalTotal = roundPoints(rawFinalTotal, 2);

      if (perfEnabled) {
        console.debug('[TP_DEBUG_PERF] day-score', {
          dayKey: key,
          path: dailyKeySet.has(key) ? 'precomputed-existing-day' : 'precomputed-extra-day',
          rawBaseTotal,
          rawInertia,
          roundedInertia,
          rawFinalTotal,
          roundedFinalTotal
        });

        const legacyInertiaInfo = computeInertia(dailyTotals, key, normalized);
        const legacyInertia = Number.isFinite(legacyInertiaInfo.inertia) ? legacyInertiaInfo.inertia : 0;
        const legacyRoundedFinalTotal = roundPoints(rawBaseTotal + legacyInertia, 2);
        if (Math.abs(legacyRoundedFinalTotal - roundedFinalTotal) > 1e-9) {
          console.warn('[TP_DEBUG_PERF] parity-mismatch', {
            dayKey: key,
            path: 'precomputed-vs-legacy',
            legacyRoundedFinalTotal,
            roundedFinalTotal,
            rawBaseTotal,
            rawInertia,
            legacyInertia
          });
        }
      }

      dayScoreMap.set(key, {
        total: roundedFinalTotal,
        baseTotal: rawBaseTotal,
        inertia: rawInertia,
        average: rawAverage,
        finalTotal: roundedFinalTotal,
        rawBaseTotal,
        rawInertia,
        rawAverage,
        rawFinalTotal
      });
    });

    if (perfEnabled) {
      const t1 = global.performance && typeof global.performance.now === 'function'
        ? global.performance.now()
        : t0;
      console.debug('[TP_DEBUG_PERF] buildYouDayScoreMap', {
        aggregateCompletionsByDateCalls: aggregateCalls,
        dayCount: dayScoreMap.size,
        elapsedMs: Math.round((t1 - t0) * 100) / 100
      });
    }

    return { dayScoreMap, dailyTotals };
  }

  function youDailyTotalsWithInertia(state, options = {}){
    const totals = {};
    const { dayScoreMap } = buildYouDayScoreMap(state, options);
    dayScoreMap.forEach((entry, key) => {
      totals[key] = entry.finalTotal;
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

  function rankablePlayers(state){
    const players = Array.isArray(state?.players) ? state.players : [];
    const youName = (typeof state?.youName === 'string' && state.youName.trim())
      ? state.youName.trim()
      : 'You';
    const active = players.filter((player) => player && isPlayerActive(player) && player.id && player.id !== 'YOU');
    return [{ id: 'YOU', name: youName, isYou: true }, ...active];
  }

  function computeRankingAvgPPD(state, playerId, record, options = {}){
    if (!state || !playerId) return null;
    const includeToday = options.includeToday === true;

    if (record?.source === 'matchups') {
      const matchups = Array.isArray(state.matchups) ? state.matchups : [];
      const activeIds = activePlayerIds(state);
      let games = 0;
      let totalPoints = 0;

      matchups.forEach((matchup) => {
        if (!matchup || (matchup.playerAId !== playerId && matchup.playerBId !== playerId)) return;
        if (!activeIds.has(matchup.playerAId) || !activeIds.has(matchup.playerBId)) return;
        if (!isMatchupRevealed(matchupDateKey(matchup), { includeToday })) return;
        const scoreA = Number(matchup.scoreA);
        const scoreB = Number(matchup.scoreB);
        if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return;

        totalPoints += matchup.playerAId === playerId ? scoreA : scoreB;
        games++;
      });

      return games ? (totalPoints / games) : null;
    }

    if (playerId === 'YOU') {
      const comps = Array.isArray(state.completions) ? state.completions : [];
      const dayMap = {};

      comps.forEach((completion) => {
        if (!completion) return;
        const day = dateKey(completion.completedAtISO || completion.dateKey);
        if (!day) return;
        const points = pointsForCompletion(completion, state);
        dayMap[day] = (dayMap[day] || 0) + points;
      });

      const totals = Object.values(dayMap).map(Number).filter(Number.isFinite);
      if (!totals.length) return null;
      return totals.reduce((sum, value) => sum + value, 0) / totals.length;
    }

    const history = Array.isArray(state.gameHistory) ? state.gameHistory : [];
    const entries = history.filter((item) => {
      if (!item || item.playerId !== playerId) return false;
      const points = Number(item.points);
      const score = Number(item.score);
      return Number.isFinite(points) || Number.isFinite(score);
    });
    if (!entries.length) return null;
    const totalPoints = entries.reduce((sum, item) => {
      const points = Number(item.points);
      if (Number.isFinite(points)) return sum + points;
      const score = Number(item.score);
      return Number.isFinite(score) ? (sum + score) : sum;
    }, 0);
    return totalPoints / entries.length;
  }

  function computeRankings(state, options = {}){
    const includeToday = options.includeToday === true;
    const allowFallback = options.allowFallback !== false;
    const rows = rankablePlayers(state).map((player) => {
      const record = computeRecord(state, player.id, { includeToday, allowFallback });
      const wins = Number(record?.wins) || 0;
      const losses = Number(record?.losses) || 0;
      const ties = Number(record?.ties) || 0;
      const games = Number(record?.games) || 0;
      const winPct = games > 0 ? (wins / games) : -1;
      const avgPPD = computeRankingAvgPPD(state, player.id, record, { includeToday });

      return {
        ...player,
        wins,
        losses,
        ties,
        games,
        winPct,
        avgPPD,
        hasGames: games > 0,
        recordSource: record?.source || 'unknown'
      };
    });

    rows.sort((a, b) => {
      if (a.hasGames !== b.hasGames) return a.hasGames ? -1 : 1;
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      const aPpd = Number.isFinite(a.avgPPD) ? a.avgPPD : -1e9;
      const bPpd = Number.isFinite(b.avgPPD) ? b.avgPPD : -1e9;
      if (bPpd !== aPpd) return bPpd - aPpd;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return rows;
  }

  function roundDisplayPpd(value){
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Number(num.toFixed(1));
  }

function computeHomeScoreboardRankings(state){
  const ranked = computeCanonicalRankings(state || {});
  return ranked.map((row) => ({
    id: row.playerId,
    name: row.name,
    rank: row.rank,
    ppdRaw: Number.isFinite(row.rawPpd) ? row.rawPpd : null,
    ppdDisplay: Number.isFinite(row.ppd) ? row.ppd : null
  }));
}

function computeRankingsPageRows(state){
  const ranked = computeCanonicalRankings(state || {});
  return ranked.map((row) => ({
    id: row.playerId,
    name: row.name,
    rank: row.rank,
    ppdRaw: Number.isFinite(row.rawPpd) ? row.rawPpd : null,
    ppdDisplay: Number.isFinite(row.ppd) ? row.ppd : null
  }));
}

  function syncYouMatchups(state, options = {}){
    // Invariant: options.normalized is only set when state already passed through normalizeState().
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    const { dayScoreMap } = buildYouDayScoreMap(normalized, { normalized: true });

    if (!dayScoreMap.size) {
      return { state: normalized, changed: false };
    }

    let changed = false;

    const updated = (normalized.matchups || []).map(m => {
      const key = matchupDateKey(m);
      const scoreEntry = dayScoreMap.get(key);
      const youScore = scoreEntry ? scoreEntry.finalTotal : undefined;
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

function computeCanonicalRankings(state, options = {}) {
  if (!state) state = {};
  const includeToday = options.includeToday === true;

  const rows = [];
  const players = Array.isArray(state.players) ? state.players.filter(p => p && p.active !== false) : [];

  const youRow = computeCanonicalRankingRow(state, null, true, { includeToday });
  rows.push(youRow);

  players.forEach((player) => {
    rows.push(computeCanonicalRankingRow(state, player, false, { includeToday }));
  });

  rows.sort((a, b) => {
    if ((b.winPct || 0) !== (a.winPct || 0)) return (b.winPct || 0) - (a.winPct || 0);
    if ((b.ppd || 0) !== (a.ppd || 0)) return (b.ppd || 0) - (a.ppd || 0);
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });

  return rows;
}

function computeCanonicalRankingRow(state, player, isYou, options = {}) {
  const includeToday = options.includeToday === true;
  const playerId = isYou ? "YOU" : player?.id;
  const name = isYou
    ? ((typeof state.youName === "string" && state.youName.trim()) ? state.youName.trim() : "You")
    : (player?.name || "Unnamed");

  const matchupStats = computeCanonicalMatchupStats(state, playerId, { includeToday });

  return {
    id: playerId,
    playerId,
    name,
    isYou,
    wins: matchupStats.wins,
    losses: matchupStats.losses,
    games: matchupStats.games,
    winPct: matchupStats.games ? matchupStats.wins / matchupStats.games : 0,
    ppd: matchupStats.ppd,
    rawPpd: matchupStats.rawPpd
  };
}

function computeCanonicalMatchupStats(state, playerId, options = {}) {
  const includeToday = options.includeToday === true;
  const matchups = Array.isArray(state.matchups) ? state.matchups : [];
  const today = dateKey(new Date());

  let wins = 0;
  let losses = 0;
  let totalScore = 0;
  let scoredGames = 0;

  matchups.forEach((m) => {
    if (!m) return;
    const matchupDay = matchupDateKey(m);
    if (!includeToday && matchupDay === today) return;

    const isA = m.playerAId === playerId;
    const isB = m.playerBId === playerId;
    if (!isA && !isB) return;

    const score = isA ? m.scoreA : m.scoreB;
    const oppScore = isA ? m.scoreB : m.scoreA;

    const hasOwnScore = Number.isFinite(score);
    const hasOppScore = Number.isFinite(oppScore);

    if (hasOwnScore) {
      totalScore += score;
      scoredGames += 1;
    }

    if (hasOwnScore && hasOppScore) {
      if (score > oppScore) wins += 1;
      else if (score < oppScore) losses += 1;
    }
  });

  return {
    wins,
    losses,
    games: wins + losses,
    rawPpd: scoredGames ? totalScore / scoredGames : 0,
    ppd: scoredGames ? Number((totalScore / scoredGames).toFixed(1)) : 0
  };
}

// Centralized NPC drip/reveal schedule generator.
// This is the canonical implementation for opponent drip timing/reveal math.
// Page-level generateOpponentDripSchedule functions in index/game/matchups/gamehub
// should remain thin compatibility wrappers only (signature/state plumbing + return).
// Future drip behavior changes must be made here in scoring_core.js, not copied into pages.
function generateOpponentDripScheduleCore(finalScore, dateKey, options = {}) {
  const playerId = options.playerId;
  const totalRounded = Math.max(0, Math.round((Number(finalScore) || 0) * 10) / 10);
  const totalUnits = Math.round(totalRounded * 10);

  const startHour = 6;
  const endHour = 23;
  const count = Math.max(12, Math.min(40, Math.round(Math.random() * 20) + 15));

  const baseDate = new Date(`${dateKey}T00:00:00`);

  const hourBuckets = [];
  for (let h = startHour; h <= endHour; h++) {
    let weight = 1;

    // Slightly favor earlier hours, but less aggressively than before.
    // Goal: still make NPCs score earlier in the day, just not dump almost everything by noon.
    if (h >= 6 && h <= 11) weight += 0.7;
    if (h >= 12 && h <= 15) weight += 0.45;
    if (h >= 16 && h <= 17) weight += 0.25;
    if (h >= 18 && h <= 23) weight += 0.15;

    if (Math.random() < 0.15) weight *= 0.4;

    hourBuckets.push({ hour: h, weight: Math.max(0.2, weight) });
  }

  const totalHourWeight = hourBuckets.reduce((s, h) => s + h.weight, 0) || 1;

  function pickTime() {
    let r = Math.random() * totalHourWeight;
    let chosenHour = startHour;
    for (const h of hourBuckets) {
      if (r <= h.weight) { chosenHour = h.hour; break; }
      r -= h.weight;
    }

    const m = Math.floor(Math.random() * 60);
    const s = Math.floor(Math.random() * 60);
    const d = new Date(baseDate.getTime());
    d.setHours(chosenHour, m, s, 0);
    return d;
  }

  const weights = [];
  for (let i = 0; i < count; i++) {
    const base = Math.pow(Math.random(), 1.4);
    const burst = Math.random() < 0.35 ? Math.random() * 1.2 : 0;
    weights.push(base + burst);
  }

  const weightSum = weights.reduce((s, n) => s + n, 0) || 1;

  let remaining = totalUnits;
  const pointUnits = [];
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      pointUnits.push(Math.max(0, remaining));
    } else {
      const share = Math.min(
        remaining,
        Math.max(0, Math.round((weights[i] / weightSum) * totalUnits))
      );
      pointUnits.push(share);
      remaining -= share;
    }
  }

  const times = pointUnits.map(() => pickTime()).sort((a, b) => a - b);
  const sizedUnits = pointUnits
    .slice()
    .sort(() => Math.random() - 0.5);

  const events = sizedUnits
    .map((units, idx) => ({ t: times[idx].toISOString(), pts: units / 10 }))
    .filter(e => e.pts > 0)
    .sort((a, b) => new Date(a.t) - new Date(b.t));

  return {
    date: dateKey,
    playerId,
    total: totalRounded,
    events
  };
}
  

// Centralized final NPC scoring implementation.
// This is the single source of truth for NPC final score math.
// Page-level simulateAiScoreForPlayer functions should remain thin compatibility
// wrappers only (signature/state/context forwarding + return).
// Future scoring behavior changes must be made here in scoring_core.js, not copied into pages.
function simulateAiScoreForPlayerCore(player, dateKey, options = {}) {
  if (!player || !player.baseline) return 0;

  const state = options.state || null;
  const context = options.context || {};

  const baseline = Number(player.baseline);
  const variance = Number(player.variance);
  const varianceTiltRaw = Number(
    typeof player.varianceTilt === "number" ? player.varianceTilt : (player.varianceTilt || 50)
  );
  const momentum = Number(player.momentum);

  let riskyRating = Number(player.risky);
  if (isNaN(riskyRating)) riskyRating = 0;
  const riskyNormalized = riskyRating > 10 ? riskyRating / 10 : riskyRating;

  let previousScore = null;
  if (momentum && Array.isArray(state?.gameHistory) && state.gameHistory.length) {
    const prev = state.gameHistory
      .filter(g => g.playerId === player.id)
      .sort((a,b) => b.date.localeCompare(a.date))[0];

    if (prev && prev.date !== dateKey) {
      const parsedPrevScore = Number(prev.score);
      if (Number.isFinite(parsedPrevScore)) {
        previousScore = parsedPrevScore;
      }
    }
  }

  const momentumEffects = computeMomentumEffects({
    prevScore: previousScore,
    baseline,
    variance,
    varianceTiltRaw,
    momentum
  });

  const varianceTilt = momentumEffects.effectiveVarianceTilt;
  const momentumBonus = momentumEffects.momentumBonus;

  const variationMagnitude = Math.random() * variance;
  const variationSign = Math.random() < varianceTilt ? 1 : -1;
  const variation = variationMagnitude * variationSign;

  let riskyMod = 0;
  if (Math.random() < riskyNormalized / 10) {
    const boom = Math.random() < 0.5;
    const riskyScale = 0.5 + Math.random() * 2.5;
    riskyMod = boom
      ? variance * riskyScale
      : -variance * riskyScale;
  }

  const rawScore = baseline + variation + momentumBonus + riskyMod;
  const originalUpside = Math.max(0, rawScore - baseline);
  let finalUpside = originalUpside;
  let intimidationApplied = false;

  const opponent = context.opponent || null;
  const playerId = player?.id || null;
  const opponentId = opponent?.id || null;
  const isNpcVsNpc = Boolean(playerId && opponentId && playerId !== "YOU" && opponentId !== "YOU");

  if (isNpcVsNpc && originalUpside > 0) {
    const opponentInt = Math.min(100, Math.max(0, Number(opponent.intimidation) || 0));
    const intimidationChance = opponentInt / 100;
    const intimidationStrength = opponentInt * 0.005;

    if (opponentInt > 0 && Math.random() < intimidationChance) {
      finalUpside = originalUpside * (1 - intimidationStrength);
      intimidationApplied = true;
    }

    const ranked = typeof computeCanonicalRankings === "function" && state
      ? computeCanonicalRankings(state)
      : [];
    const rankingMap = new Map(ranked.map(row => [row.playerId, row]));
    const playerRank = rankingMap.get(playerId)?.rank ?? null;
    const opponentRank = rankingMap.get(opponentId)?.rank ?? null;

    if (Number.isFinite(playerRank) && Number.isFinite(opponentRank) && playerRank > 1) {
      const poiseThreshold = Math.ceil(playerRank / 2);
      const qualifiesForPoise = opponentRank <= poiseThreshold;

      if (qualifiesForPoise) {
        const poiseRating = Math.min(100, Math.max(0, Number(player.poise) || 0));
        const poiseChance = poiseRating / 100;
        const poiseStrength = poiseRating * 0.005;

        if (poiseRating > 0 && Math.random() < poiseChance) {
          finalUpside = intimidationApplied ? originalUpside : finalUpside;
          finalUpside = finalUpside * (1 + poiseStrength);
        }
      }
    }
  }

const score = baseline + finalUpside + Math.min(0, rawScore - baseline);

// Soft-cap only very high NPC scores.
// Scores at or below 70 are unchanged.
// Scores above 70 still rise, but increasingly slowly.
// The absolute ceiling approaches 85 without making every big game exactly 85.
const SOFT_CAP_START = 70;
const SOFT_CAP_MAX = 85;

let cappedScore = score;

if (score > SOFT_CAP_START) {
  const over = score - SOFT_CAP_START;
  cappedScore = SOFT_CAP_START + (SOFT_CAP_MAX - SOFT_CAP_START) * (over / (over + (SOFT_CAP_MAX - SOFT_CAP_START)));
}

return Number(cappedScore.toFixed(1));
}

  global.TaskPointsCore = {
    STORAGE_KEY,
    PROJECTS_STORAGE_KEY,
    QUARANTINE_SNAPSHOT_KEY,
    QUARANTINE_INLINE_MAX_BYTES,
    BACKUP_SLOT_KEYS,
    IMAGE_DB_NAME,
    IMAGE_STORE_NAME,
    CATEGORY_DEFS,
    DEFAULT_SCORING_SETTINGS,
    SEASON_STATUSES,
    DEFAULT_SEASON_NAME,
    DEFAULT_SEASON_MONTH_KEY,
    JUNE_2026_SEASON_DATE_WINDOWS,
    normalizeTask,
    normalizeScoringSettings,
    getScoringSettings,
    normalizeState,
    normalizeSeasonState,
    normalizeSeasonHistory,
    normalizeCurrentSeason,
    getSeasonRoundDefs,
    getSeasonRoundForDate,
    getSeasonSeriesLength,
    getSeasonDisplayName,
    getSeasonDateWindows,
    isSeasonDate,
    isJuneSeasonDate,
    buildSeasonId,
    createEmptySeasonDraft,
    getActiveSeasonPlayerPool,
    getSeasonSeedSourceRows,
    buildOfficialSeasonBracketFromSeeds,
    createOfficialSeasonSeriesFromSeeds,
    lockSeasonPreviewToOfficialBracket,
    recordSeasonSeriesGameResult,
    getSeasonSeriesWinner,
    isSeasonSeriesComplete,
    advanceSeasonSeriesWinner,
    resolvePlayInWinnersIntoRoundOf32,
    getLocalMonthEndDateKey,
    dateFromLocalDateKey,
    repairPlayInAdvancementForCurrentSeason,
    repairSeasonDateRange,
    getActiveSeasonSeriesForDate,
    prepareSeasonForDailySlate,
    getSeasonScheduleSignature,
    isValidSeasonControlledScheduleDay,
    shouldRegenerateScheduleDayForSeasonControl,
    getCurrentSeasonRoundIdForDate,
    getSeriesStatusText,
    getWinnerFacesText,
    getSeasonPlayerDisplayName,
    getSeriesCompactTitle,
    getSeriesGameNumber,
    getCurrentSeriesGameNumberForHome,
    isSeasonEliminationGame,
    getFeaturedSeasonMatchup,
    getUserSeasonStatus,
    getEliminatedPlayers,
    getFinalPlacements,
    getChampionSummary,
    repairSeasonChampionshipData,
    recalculateAllSeasonSeriesFromGameResults,
    recalculateSeasonSeriesFromGameResults,
    assignSeasonBracketSlot,
    updateSeasonSeriesManualResult,
    finalizeCurrentSeason,
    buildSeasonArchiveEntry,
    canFinalizeSeason,
    getSeasonFinalPlacements,
    getSeasonChampionFromFinals,
    shouldUseSeasonMatchupControl,
    buildSeasonDailySlate,
    getPairingKey,
    inferSeasonSeriesIdFromRecord,
    withInferredSeasonMatchupMetadata,
    getJunePairingHistory,
    hasJunePairingOccurred,
    generateRandomNonRepeatPairs,
    syncSeasonResultsFromDailyMatchups,
    syncCurrentSeasonSeriesFromRecordedResults,
    cleanupOpponentDripSchedules,
    getOpponentDripScheduleCleanupSummary,
    loadAppState,
    pruneStateForStorage,
    mergeState,
    saveStateSnapshot,
    saveValidatedSnapshot,
    mergeAndSaveState,
    saveAppState,
    getRecoveryCandidate,
    restoreBackupSlot,
    getLocalStorageSizeReport,
    dateKey,
    todayKey,
    addDaysToDateKey,
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
    classifyPersonalMetricCompletion,
    buildPersonalScoreHistoryRows,
    buildPersonalScoreHistoryCsv,
    roundPoints,
    computeMomentumEffects,
    generateOpponentDripScheduleCore,
    simulateAiScoreForPlayerCore,
    deriveCompletionPoints,
    pointsForCompletion,
    syncDerivedPoints,
    computeMatchupRecord,
    computeCompletionRecord,
    computeGameHistoryRecord,
    computeRecord,
    computeRankings,
    computeHomeScoreboardRankings,
    computeRankingsPageRows,
    caloriesToPoints,
    computeCalLogBonusPoints,
    CAL_LOG_BONUS_POINTS,
    moodPoints,
    categorizeCompletion,
    aggregateCompletionsByDate,
    computeInertia,
    computeDailyTotalsWithInertia,
    deriveTodayWithInertia,
    buildDailyBreakdowns,
    buildRollups,
    computeLeaderboards,
    computeCanonicalRankings,
    computeCanonicalRankingRow,
    computeCanonicalMatchupStats,
    buildDaySnapshot,
    computeDayTotals,
    auditTodayScheduleVsMatchups,
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
