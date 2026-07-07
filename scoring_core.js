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

  const TASKPOINTS_LARGE_SAVE_WARN_BYTES = 4.25 * 1024 * 1024;

  const TASKPOINTS_PACKED_STORAGE_VERSION = 1;
  const PACKED_ARRAY_SCHEMAS = {
    completions: ['id','taskId','habitId','viceId','flexId','projectId','title','points','completedAtISO','dateKey','source','kind','note','meta'],
    matchups: ['id','matchupId','date','dateKey','playerAId','playerBId','scoreA','scoreB','playerAScore','playerBScore','winnerId','loserId','result','matchupType','seasonId','seriesId','seasonSeriesId','roundId','gameNumber','seriesGameNumber','bestOf','winsNeeded','completedAtISO','finalizedAtISO','source'],
    gameHistory: ['id','date','dateKey','playerId','score','points','total','source','winnerId','loserId','matchupId','seasonId','seriesId','seasonSeriesId','roundId','gameNumber','completedAtISO','createdAtISO'],
    seasonHistory: []
  };


  const TASKPOINTS_STORAGE_ENCODING_KEY = "__taskpointsStorageEncoding";
  const TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1 = "lz16-packed-v1";
  const TASKPOINTS_STORAGE_ENCODING_VERSION = 1;
  const TASKPOINTS_COMPRESSED_MIN_RATIO = 0.90;

  // UTF-16 localStorage-safe LZ compression derived from lz-string 1.4.4
  // (Pieroxy, MIT License): https://github.com/pieroxy/lz-string
  const TaskPointsLZString = (() => {
    const f = String.fromCharCode;
    function compress(uncompressed, bitsPerChar, getCharFromInt) {
      if (uncompressed == null) return "";
      let i; let value; const context_dictionary = {}; const context_dictionaryToCreate = {}; let context_c = ""; let context_wc = ""; let context_w = ""; let context_enlargeIn = 2; let context_dictSize = 3; let context_numBits = 2; const context_data = []; let context_data_val = 0; let context_data_position = 0;
      for (let ii = 0; ii < uncompressed.length; ii += 1) {
        context_c = uncompressed.charAt(ii);
        if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) { context_dictionary[context_c] = context_dictSize++; context_dictionaryToCreate[context_c] = true; }
        context_wc = context_w + context_c;
        if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) { context_w = context_wc; } else {
          if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
            if (context_w.charCodeAt(0) < 256) { for (i = 0; i < context_numBits; i += 1) { context_data_val <<= 1; if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; } value = context_w.charCodeAt(0); for (i = 0; i < 8; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
            else { value = 1; for (i = 0; i < context_numBits; i += 1) { context_data_val = (context_data_val << 1) | value; if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value = 0; } value = context_w.charCodeAt(0); for (i = 0; i < 16; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
            context_enlargeIn--; if (context_enlargeIn === 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; } delete context_dictionaryToCreate[context_w];
          } else { value = context_dictionary[context_w]; for (i = 0; i < context_numBits; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
          context_enlargeIn--; if (context_enlargeIn === 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; } context_dictionary[context_wc] = context_dictSize++; context_w = String(context_c);
        }
      }
      if (context_w !== "") {
        if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
          if (context_w.charCodeAt(0) < 256) { for (i = 0; i < context_numBits; i += 1) { context_data_val <<= 1; if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; } value = context_w.charCodeAt(0); for (i = 0; i < 8; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
          else { value = 1; for (i = 0; i < context_numBits; i += 1) { context_data_val = (context_data_val << 1) | value; if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value = 0; } value = context_w.charCodeAt(0); for (i = 0; i < 16; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
          context_enlargeIn--; if (context_enlargeIn === 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; } delete context_dictionaryToCreate[context_w];
        } else { value = context_dictionary[context_w]; for (i = 0; i < context_numBits; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; } }
        context_enlargeIn--; if (context_enlargeIn === 0) context_numBits++;
      }
      value = 2; for (i = 0; i < context_numBits; i += 1) { context_data_val = (context_data_val << 1) | (value & 1); if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; } else context_data_position += 1; value >>= 1; }
      while (true) { context_data_val <<= 1; if (context_data_position == bitsPerChar - 1) { context_data.push(getCharFromInt(context_data_val)); break; } else context_data_position += 1; }
      return context_data.join('');
    }
    function decompress(length, resetValue, getNextValue) {
      const dictionary = []; let enlargeIn = 4; let dictSize = 4; let numBits = 3; let entry = ''; const result = []; let i; let w; let bits; let resb; let maxpower; let power; let c; const data = { val: getNextValue(0), position: resetValue, index: 1 };
      for (i = 0; i < 3; i += 1) dictionary[i] = i;
      bits = 0; maxpower = Math.pow(2, 2); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
      switch (bits) { case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } c = f(bits); break; case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } c = f(bits); break; case 2: return ''; default: c = ''; }
      dictionary[3] = c; w = c; result.push(c);
      while (true) {
        if (data.index > length) return '';
        bits = 0; maxpower = Math.pow(2, numBits); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
        c = bits;
        switch (c) { case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn--; break; case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn--; break; case 2: return result.join(''); }
        if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
        if (dictionary[c]) entry = dictionary[c]; else if (c === dictSize) entry = w + w.charAt(0); else return null;
        result.push(entry); dictionary[dictSize++] = w + entry.charAt(0); enlargeIn--; w = entry;
        if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
      }
    }
    return {
      compressToUTF16(input) { if (input == null) return ''; return compress(input, 15, (a) => f(a + 32)) + ' '; },
      decompressFromUTF16(compressed) { if (compressed == null) return ''; if (compressed === '') return null; return decompress(compressed.length, 16384, (index) => compressed.charCodeAt(index) - 32); }
    };
  })();

  const PACKED_ARRAY_MIN_SAVINGS_RATIO = 0.95;
  const SHORT_KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function getShortKeyAlias(index) {
    let value = index;
    let alias = '';
    do {
      alias = SHORT_KEY_ALPHABET[value % SHORT_KEY_ALPHABET.length] + alias;
      value = Math.floor(value / SHORT_KEY_ALPHABET.length) - 1;
    } while (value >= 0);
    return alias;
  }

  function getPackedArrayFields(rows, preferredFields) {
    const fieldSet = new Set(preferredFields || []);
    const list = Array.isArray(rows) ? rows : [];
    list.forEach((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      Object.keys(row).forEach((key) => fieldSet.add(key));
    });
    return Array.from(fieldSet);
  }

  function packObjectArray(rows, preferredFields) {
    const list = Array.isArray(rows) ? rows : [];
    const fields = getPackedArrayFields(list, preferredFields);
    const packedRows = list.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      return fields.map((field) => {
        const value = row[field];
        return value === undefined ? null : value;
      });
    });
    return { fields, rows: packedRows };
  }

  function packObjectArrayShortKeys(rows, preferredFields) {
    const list = Array.isArray(rows) ? rows : [];
    const fields = getPackedArrayFields(list, preferredFields);
    const aliases = {};
    const fieldToAlias = {};
    fields.forEach((field, index) => {
      const alias = getShortKeyAlias(index);
      aliases[alias] = field;
      fieldToAlias[field] = alias;
    });
    const packedRows = list.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const packedRow = {};
      Object.keys(row).forEach((field) => {
        const value = row[field];
        if (value === undefined) return;
        packedRow[fieldToAlias[field] || field] = value;
      });
      return packedRow;
    });
    return { mode: 'shortKeys', aliases, rows: packedRows };
  }

  function unpackObjectArray(packed) {
    if (!packed || !Array.isArray(packed.rows)) {
      return Array.isArray(packed) ? packed : [];
    }
    if (packed.mode === 'shortKeys' && packed.aliases && typeof packed.aliases === 'object' && !Array.isArray(packed.aliases)) {
      return packed.rows.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const obj = {};
        Object.entries(row).forEach(([key, value]) => {
          if (value === undefined) return;
          obj[packed.aliases[key] || key] = value;
        });
        return obj;
      });
    }
    if (!Array.isArray(packed.fields)) return [];
    return packed.rows.map((row) => {
      if (!Array.isArray(row)) return row;
      const obj = {};
      packed.fields.forEach((field, index) => {
        const value = row[index];
        if (value !== null && value !== undefined) obj[field] = value;
      });
      return obj;
    });
  }

  function getPackedArrayCandidate(rows, preferredFields) {
    const originalRaw = JSON.stringify(Array.isArray(rows) ? rows : []);
    const fixedPacked = packObjectArray(rows, preferredFields);
    const shortKeyPacked = packObjectArrayShortKeys(rows, preferredFields);
    const fixedRaw = JSON.stringify(fixedPacked);
    const shortKeyRaw = JSON.stringify(shortKeyPacked);
    const candidates = [
      { mode: 'fixed', value: fixedPacked, chars: fixedRaw.length },
      { mode: 'shortKeys', value: shortKeyPacked, chars: shortKeyRaw.length }
    ];
    const best = candidates.reduce((winner, candidate) => candidate.chars < winner.chars ? candidate : winner, candidates[0]);
    const shouldPack = best.chars < originalRaw.length * PACKED_ARRAY_MIN_SAVINGS_RATIO;
    return {
      originalChars: originalRaw.length,
      fixedPackedChars: fixedRaw.length,
      shortKeyPackedChars: shortKeyRaw.length,
      chosenMode: shouldPack ? best.mode : 'original',
      chosenChars: shouldPack ? best.chars : originalRaw.length,
      savedChars: shouldPack ? originalRaw.length - best.chars : 0,
      savedPercent: shouldPack && originalRaw.length ? ((originalRaw.length - best.chars) / originalRaw.length) * 100 : 0,
      packed: shouldPack,
      value: shouldPack ? best.value : null
    };
  }

  function getTaskPointsPackDiagnostics(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
    return Object.entries(PACKED_ARRAY_SCHEMAS).filter(([key]) => Array.isArray(state[key])).map(([key, fields]) => {
      const candidate = getPackedArrayCandidate(state[key], fields);
      return {
        array: key,
        originalChars: candidate.originalChars,
        fixedPackedChars: candidate.fixedPackedChars,
        shortKeyPackedChars: candidate.shortKeyPackedChars,
        chosenMode: candidate.chosenMode,
        chosenChars: candidate.chosenChars,
        savedChars: candidate.savedChars,
        savedPercent: Number(candidate.savedPercent.toFixed(2)),
        packed: candidate.packed
      };
    });
  }

  function packTaskPointsStorageState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const packed = { ...state };
    const packedArrays = {};
    Object.entries(PACKED_ARRAY_SCHEMAS).forEach(([key, fields]) => {
      if (!Array.isArray(packed[key])) return;
      const candidate = getPackedArrayCandidate(packed[key], fields);
      if (!candidate.packed) return;
      packedArrays[key] = candidate.value;
      delete packed[key];
    });
    if (Object.keys(packedArrays).length) {
      packed.__packedStorageVersion = TASKPOINTS_PACKED_STORAGE_VERSION;
      packed.__packedArrays = packedArrays;
    } else {
      delete packed.__packedStorageVersion;
      delete packed.__packedArrays;
    }
    return packed;
  }

  function unpackTaskPointsStorageState(rawState) {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return rawState;
    const packedArrays = rawState.__packedArrays;
    if (!packedArrays || typeof packedArrays !== 'object' || Array.isArray(packedArrays)) return rawState;
    const unpacked = { ...rawState };
    Object.keys(packedArrays).forEach((key) => {
      unpacked[key] = unpackObjectArray(packedArrays[key]);
    });
    delete unpacked.__packedArrays;
    delete unpacked.__packedStorageVersion;
    return unpacked;
  }

  function compressStorageString(rawJson) {
    return TaskPointsLZString.compressToUTF16(String(rawJson || ''));
  }

  function decompressStorageString(encoded) {
    const decoded = TaskPointsLZString.decompressFromUTF16(String(encoded || ''));
    if (typeof decoded !== 'string') throw new Error('TaskPoints storage decompression failed: invalid compressed payload.');
    return decoded;
  }

  function isCompressedTaskPointsStorageWrapper(parsed) {
    return Boolean(parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && parsed[TASKPOINTS_STORAGE_ENCODING_KEY] === TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1);
  }

  function makeCompressedStorageWrapper(packedRawJson) {
    return {
      [TASKPOINTS_STORAGE_ENCODING_KEY]: TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1,
      __taskpointsStorageVersion: TASKPOINTS_STORAGE_ENCODING_VERSION,
      data: compressStorageString(packedRawJson)
    };
  }

  function encodeTaskPointsStorageJson(rawJson) {
    const packedRawJson = String(rawJson || '{}');
    const compressedWrapperRaw = JSON.stringify(makeCompressedStorageWrapper(packedRawJson));
    return compressedWrapperRaw.length < packedRawJson.length * TASKPOINTS_COMPRESSED_MIN_RATIO
      ? compressedWrapperRaw
      : packedRawJson;
  }

  function getTaskPointsStorageEncodingInfo(raw) {
    const info = {
      encoding: 'plain-json',
      label: 'plain JSON',
      packed: false,
      compressed: false,
      rawChars: raw ? String(raw).length : 0,
      unpackedNormalJsonChars: 0,
      packedRawChars: 0,
      compressedRawChars: 0,
      savingsChars: 0
    };
    if (!raw) return info;
    try {
      const parsed = JSON.parse(raw);
      if (isCompressedTaskPointsStorageWrapper(parsed) && typeof parsed.data === 'string') {
        const packedRaw = decompressStorageString(parsed.data);
        const packedState = JSON.parse(packedRaw);
        const unpacked = unpackTaskPointsStorageState(packedState);
        info.encoding = TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1;
        info.label = 'compressed packed JSON';
        info.packed = Boolean(packedState?.__packedArrays && Object.keys(packedState.__packedArrays).length);
        info.compressed = true;
        info.compressedRawChars = raw.length;
        info.packedRawChars = packedRaw.length;
        info.unpackedNormalJsonChars = JSON.stringify(unpacked || {}).length;
        info.savingsChars = Math.max(0, info.unpackedNormalJsonChars - raw.length);
        return info;
      }
      info.packed = Boolean(parsed?.__packedArrays && Object.keys(parsed.__packedArrays).length);
      info.encoding = info.packed ? 'packed-json' : 'plain-json';
      info.label = info.packed ? 'packed JSON' : 'plain JSON';
      const unpacked = unpackTaskPointsStorageState(parsed);
      info.unpackedNormalJsonChars = JSON.stringify(unpacked || {}).length;
      info.packedRawChars = info.packed ? raw.length : 0;
      info.savingsChars = Math.max(0, info.unpackedNormalJsonChars - raw.length);
    } catch (_) {}
    return info;
  }

  function decodeTaskPointsStorageJson(raw) {
    if (!raw) return raw;
    const parsed = JSON.parse(raw);
    if (!isCompressedTaskPointsStorageWrapper(parsed)) return raw;
    if (typeof parsed.data !== 'string') throw new Error('TaskPoints compressed storage decode failed: wrapper data is missing or invalid.');
    try {
      return decompressStorageString(parsed.data);
    } catch (error) {
      throw new Error(`TaskPoints compressed storage decode failed: ${error && error.message ? error.message : error}`);
    }
  }

  function parseTaskPointsStorageJson(raw, fallback = {}) {
    if (!raw) return fallback;
    const decodedRaw = decodeTaskPointsStorageJson(raw);
    return unpackTaskPointsStorageState(JSON.parse(decodedRaw) || fallback);
  }

  function buildOptimizedTaskPointsStorageRaw(state) {
    const packedState = packTaskPointsStorageState(state);
    const packedRawJson = JSON.stringify(packedState);
    const compressedWrapperRaw = JSON.stringify(makeCompressedStorageWrapper(packedRawJson));
    const useCompressed = compressedWrapperRaw.length < packedRawJson.length * TASKPOINTS_COMPRESSED_MIN_RATIO;
    const chosenRaw = useCompressed ? compressedWrapperRaw : packedRawJson;
    return {
      packedState,
      packedRawJson,
      compressedWrapperRaw,
      chosenRaw,
      chosenEncoding: useCompressed ? TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1 : (packedState?.__packedArrays ? 'packed-json' : 'plain-json'),
      packedRawChars: packedRawJson.length,
      compressedRawChars: compressedWrapperRaw.length,
      chosenChars: chosenRaw.length,
      chosenBytes: chosenRaw.length * 2
    };
  }

  function safeReplaceTaskPointsStorage(storageKey, serializedCandidate) {
    const previousRaw = localStorage.getItem(storageKey);
    if (previousRaw && serializedCandidate.length < previousRaw.length) {
      localStorage.removeItem(storageKey);
      try {
        localStorage.setItem(storageKey, serializedCandidate);
      } catch (err) {
        try { localStorage.setItem(storageKey, previousRaw); } catch (restoreErr) { console.warn('TaskPointsCore: failed to restore previous storage after packed write failure.', restoreErr); }
        throw err;
      }
      return;
    }
    localStorage.setItem(storageKey, serializedCandidate);
  }
  const TASKPOINTS_QUOTA_ALERT_COOLDOWN_MS = 60 * 1000;
  const TASKPOINTS_SAVE_BLOCK_COOLDOWN_MS = 15 * 1000;
  const TASKPOINTS_STORAGE_WARNING_MAX = 5;
  
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
      parsed = raw ? (parseTaskPointsStorageJson(raw, {}) || {}) : {};
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

const AUGUST_2026_SEASON_DATE_WINDOWS = [
  { id: 'play_in', startDate: '2026-08-01', endDate: '2026-08-03', displayName: 'Play-In', bestOf: 3 },
  { id: 'round_of_32', startDate: '2026-08-04', endDate: '2026-08-08', displayName: 'Round of 32', bestOf: 5 },
  { id: 'sweet_16', startDate: '2026-08-09', endDate: '2026-08-13', displayName: 'Sweet 16', bestOf: 5 },
  { id: 'quarterfinals', startDate: '2026-08-14', endDate: '2026-08-18', displayName: 'Quarterfinals', bestOf: 5 },
  { id: 'semifinals', startDate: '2026-08-19', endDate: '2026-08-23', displayName: 'Semifinals', bestOf: 5 },
  { id: 'finals', startDate: '2026-08-25', endDate: '2026-08-31', displayName: 'Finals', bestOf: 7 }
];

const DEFAULT_SEASON_NAME = 'June 2026 TaskPoints Championship';
const DEFAULT_SEASON_MONTH_KEY = '2026-06';

  function getSeasonDateWindowsForSeason(season) {
  const custom = Array.isArray(season?.dateWindows) ? season.dateWindows : [];
  if (custom.length) return custom.map((round) => ({ ...round }));

  if (season?.monthKey === '2026-08' || String(season?.id || '').includes('2026-08')) {
    return AUGUST_2026_SEASON_DATE_WINDOWS.map((round) => ({ ...round }));
  }

  return JUNE_2026_SEASON_DATE_WINDOWS.map((round) => ({ ...round }));
}

function getSeasonDateWindowsForStateOrSeason(stateOrSeason) {
  const season = stateOrSeason?.currentSeason || stateOrSeason || null;
  return getSeasonDateWindowsForSeason(season);
}

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
      dateWindows: Array.isArray(season.dateWindows)
  ? season.dateWindows.map((round) => ({ ...round }))
  : [],
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


  function daysBetweenDateKeys(startDateKey, endDateKey) {
    const start = dateFromLocalDateKey(startDateKey);
    const end = dateFromLocalDateKey(endDateKey);
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  }

  function isSeasonRoundFullyReady(season, roundId) {
    const series = Object.values(season?.series || {}).filter((s) => s?.roundId === roundId);
    return series.length > 0 && series.every((s) => s?.playerAId && s?.playerBId);
  }

  function hasSeasonRoundActivationOverride(season, roundId, options = {}) {
    if (options.forceRoundActivation === true || options.adminRoundActivationOverride === true) return true;
    const overrides = season?.meta?.roundActivationOverrides;
    if (Array.isArray(overrides)) return overrides.includes(roundId);
    return overrides && typeof overrides === 'object' && overrides[roundId] === true;
  }

  function getSeasonRoundActualStartDateKey(season, roundId) {
    const stored = season?.meta?.roundStartDateKeys?.[roundId];
    return typeof stored === 'string' && stored ? stored : '';
  }

function getRoundScheduledGameNumberForDate(season, roundId, dateKeyStr) {
  const round = getSeasonDateWindowsForSeason(season).find((item) => item.id === roundId);
  const startDate = getSeasonRoundActualStartDateKey(season, roundId) || round?.startDate || '';
  if (!round || !startDate || !dateKeyStr || dateKeyStr < startDate || dateKeyStr > round.endDate) return null;
  const offset = daysBetweenDateKeys(startDate, dateKeyStr);
  if (!Number.isFinite(offset) || offset < 0) return null;
  const gameNumber = offset + 1;
  return gameNumber <= round.bestOf ? gameNumber : null;
}


  function normalizeSeasonEvidenceDateKey(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const key = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
    if (!key) return '';
    const date = dateFromLocalDateKey(key);
    return date && !Number.isNaN(date.getTime()) ? key : '';
  }

function isValidSeasonRoundStartDateKey(roundId, dateKeyStr, season = null) {
  const key = normalizeSeasonEvidenceDateKey(dateKeyStr);
  if (!key) return false;
  const round = getSeasonDateWindowsForSeason(season).find((item) => item.id === roundId);
  return Boolean(round && key >= round.startDate && key <= round.endDate);
}

  function inferSeasonRoundActualStartDateKey(season, roundId, options = {}) {
    const round = getSeasonDateWindowsForSeason(season).find((item) => item.id === roundId);
    if (!round || !season?.series) return '';

    const existingStart = normalizeSeasonEvidenceDateKey(season?.meta?.roundStartDateKeys?.[roundId]);
if (isValidSeasonRoundStartDateKey(roundId, existingStart, season)) return existingStart;
    const roundSeries = Object.values(season.series || {}).filter((series) => series?.roundId === roundId);
    const evidenceDates = [];
    const addEvidenceDate = (rawDate) => {
      const key = normalizeSeasonEvidenceDateKey(rawDate);
      if (key && key >= round.startDate && key <= round.endDate) evidenceDates.push(key);
    };

    roundSeries.forEach((series) => {
      (Array.isArray(series?.gameResults) ? series.gameResults : []).forEach((result) => {
        addEvidenceDate(getRecordedResultDateKey(result));
      });
    });

    const state = options.state || options.currentState || null;
    const scanSafeEvidence = (records) => {
      (Array.isArray(records) ? records : []).forEach((record) => {
        const recordDate = getRecordedResultDateKey(record);
        if (!recordDate) return;
        const safeMatches = roundSeries
          .map((series) => getSafeSeasonTournamentEvidenceRecord(state, season, series, record, { ...options, dateKey: recordDate }))
          .filter(Boolean);
        if (safeMatches.length === 1) addEvidenceDate(recordDate);
      });
    };

    scanSafeEvidence(state?.matchups);
    scanSafeEvidence(state?.gameHistory);

    const daily = season?.dailyTournamentResults;
    if (Array.isArray(daily)) {
      scanSafeEvidence(daily);
    } else if (daily && typeof daily === 'object') {
      Object.entries(daily).forEach(([key, value]) => {
        const decorate = (entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          if (!season?.series?.[key] || getRecordedSeriesId(entry)) return entry;
          return { ...entry, seriesId: key, seasonSeriesId: key };
        };
        if (Array.isArray(value)) scanSafeEvidence(value.map(decorate));
        else if (value && typeof value === 'object') scanSafeEvidence([decorate(value)]);
      });
    }

    const earliestEvidence = evidenceDates.sort()[0] || '';
    if (earliestEvidence) {
      return round.startDate && round.startDate <= earliestEvidence ? round.startDate : earliestEvidence;
    }

    const fallback = normalizeSeasonEvidenceDateKey(options.fallbackDateKey);
    if (options.allowFallbackTodayOnlyWhenNoPriorEvidence === true && fallback && fallback >= round.startDate && fallback <= round.endDate) {
      return fallback;
    }

    return '';
  }

function getSeasonRoundDefs(seasonOrState = null) {
  return getSeasonDateWindowsForStateOrSeason(seasonOrState).map((round) => ({ ...round }));
}

  function getSeasonDateWindows() {
    return getSeasonRoundDefs();
  }

function getSeasonRoundForDate(dateKey, seasonOrState = null) {
  if (typeof dateKey !== 'string') return null;
  return getSeasonDateWindowsForStateOrSeason(seasonOrState)
    .find((round) => dateKey >= round.startDate && dateKey <= round.endDate) || null;
}

function getSeasonSeriesLength(roundId, seasonOrState = null) {
  const round = getSeasonDateWindowsForStateOrSeason(seasonOrState).find((item) => item.id === roundId);
  return round ? round.bestOf : null;
}

function getSeasonDisplayName(roundId, seasonOrState = null) {
  const round = getSeasonDateWindowsForStateOrSeason(seasonOrState).find((item) => item.id === roundId);
  return round ? round.displayName : '';
}

function isSeasonDate(dateKey, seasonOrState = null) {
  return Boolean(getSeasonRoundForDate(dateKey, seasonOrState));
}

function isJuneSeasonDate(dateKey) {
  return isSeasonDate(dateKey, { monthKey: DEFAULT_SEASON_MONTH_KEY });
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
      dateWindows: Array.isArray(options.dateWindows) ? options.dateWindows.map((round) => ({ ...round })) : [],
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

function officialRoundDef(roundId, seasonOrOptions = null) {
  return getSeasonDateWindowsForStateOrSeason(seasonOrOptions)
    .find((round) => round.id === roundId)
    || { id: roundId, displayName: getSeasonDisplayName(roundId, seasonOrOptions) || roundId, bestOf: 5 };
}

  function officialSeriesId(seasonId, roundId, seriesIndex) {
    return `${seasonId}_${roundId}_${seriesIndex}`;
  }

  function createOfficialSeries(options) {
    const round = officialRoundDef(options.roundId, options);
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
    const playerId = player.playerId || player.id || '';
    const playerSeed = Number.isFinite(Number(player.seed)) ? Number(player.seed) : null;
    const playerName = player.playerName || player.name || player.playerId || player.id || '';
    const beforeStatus = next.status;
    const changed = String(next[`player${prefix}Id`] || '') !== String(playerId || '')
      || String(next[`player${prefix}Name`] || '') !== String(playerName || '')
      || String(next[`placeholder${prefix}`] || '') !== ''
      || (Number.isFinite(Number(next[`player${prefix}Seed`])) ? Number(next[`player${prefix}Seed`]) : null) !== playerSeed;
    next[`player${prefix}Id`] = playerId;
    next[`player${prefix}Seed`] = playerSeed;
    next[`player${prefix}Name`] = playerName;
    next[`placeholder${prefix}`] = '';
    if (next.playerAId && next.playerBId && next.status === 'pending') next.status = 'active';
    if (changed || beforeStatus !== next.status) next.updatedAtISO = seasonNowISO(options);
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
        bestOf: getSeasonSeriesLength('play_in', options) || 3, status: 'active', playerA: seedEntryForOfficial(seeds, pair[0]), playerB: seedEntryForOfficial(seeds, pair[1]), nowISO: now
      }));
    });

    OFFICIAL_ROUND_OF_32_PAIRINGS.forEach((pair, index) => {
      const next = nextFor('round_of_32', index + 1);
      const playerA = typeof pair[0] === 'number' ? seedEntryForOfficial(seeds, pair[0]) : null;
      const playerB = typeof pair[1] === 'number' ? seedEntryForOfficial(seeds, pair[1]) : null;
      add(createOfficialSeries({
        id: officialSeriesId(seasonId, 'round_of_32', index + 1), seasonId, roundId: 'round_of_32', roundIndex: 1, seriesIndex: index + 1,
        bestOf: getSeasonSeriesLength('round_of_32', options) || 5, status: 'pending', playerA, playerB, placeholderA: playerA ? '' : 'Awaiting winner',
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
         bestOf: getSeasonSeriesLength(roundId, options) || (roundId === 'finals' ? 7 : 5), status: 'pending', placeholderA: `Winner of Series ${priorA}`, placeholderB: `Winner of Series ${priorB}`,
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
    if (series.winnerId && (series.winnerId === series.playerAId || series.winnerId === series.playerBId)) return series.winnerId;
    const winsNeeded = Number(series.winsNeeded) || (Math.floor((Number(series.bestOf) || 1) / 2) + 1);
    const winsA = Number(series.winsA) || 0;
    const winsB = Number(series.winsB) || 0;
    if (winsA >= winsNeeded && winsA > winsB) return series.playerAId || null;
    if (winsB >= winsNeeded && winsB > winsA) return series.playerBId || null;
    return null;
  }

  function isSeasonSeriesComplete(series) {
    return Boolean(getSeasonSeriesWinner(series));
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
    const resultWinner = getSeasonResultWinnerForSeries(gameResult, series);
    const winnerId = resultWinner.winnerId;
    if (!winnerId || (winnerId !== series.playerAId && winnerId !== series.playerBId)) return { ok: false, error: 'invalid_or_ambiguous_winner', season: nextSeason, series };
    const loserId = resultWinner.loserId || (winnerId === series.playerAId ? series.playerBId : series.playerAId);
    if (!loserId) return { ok: false, error: 'invalid_or_ambiguous_loser', season: nextSeason, series };
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
        playerAScore: resultWinner.playerAScore ?? gameResult?.playerAScore,
        playerBScore: resultWinner.playerBScore ?? gameResult?.playerBScore,
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
    let nextSeason = normalizeSeasonState(season);
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
    const catchUpRepair = backfillLateBoundSeasonSeriesResults({ currentSeason: nextSeason }, nextSeason, options);
    if (catchUpRepair.updatedSeason) {
      nextSeason = catchUpRepair.updatedSeason;
      if (catchUpRepair.changed) changed = true;
    }
    if (changed && global.console && typeof global.console.info === 'function') {
      console.info('[Season repair] Resolved Play-In winners into Round of 32', { seed1Opponent: worseSeedWinner, seed2Opponent: otherWinner });
    }
    return { ok: true, season: nextSeason, changed, seed1Opponent: worseSeedWinner, seed2Opponent: otherWinner };
  }



  function getProtectedRoundOf32PlayInAssignment(season, protectedSeedNumber, fallbackIndex) {
    const series = findRoundOf32ProtectedSeries(season, protectedSeedNumber, fallbackIndex);
    if (!series) return null;
    const protectedSlot = Number(series.playerASeed) === Number(protectedSeedNumber) ? 'A'
      : (Number(series.playerBSeed) === Number(protectedSeedNumber) ? 'B' : 'A');
    const playInSlot = protectedSlot === 'A' ? 'B' : 'A';
    const assigned = withSeasonSeedFallback(season, seasonSeriesCompetitor(series, playInSlot));
    return { series, protectedSlot, playInSlot, assigned };
  }

  function stablePlayInProtectedSlotRepairResultId(series, gameNumber) {
    return `${series?.id || 'play_in'}_protected_slot_repair_game_${gameNumber}`;
  }

  function buildPlayInProtectedSlotRepairGameResult(season, series, winnerId, gameNumber, options = {}) {
    const loserId = winnerId === series.playerAId ? series.playerBId : series.playerAId;
    const winnerIsA = winnerId === series.playerAId;
    const dateKeyStr = getSeasonManualResultDateKey(series, gameNumber) || '2026-06-03';
    const stableId = stablePlayInProtectedSlotRepairResultId(series, gameNumber);
    const now = seasonNowISO(options);
    return {
      id: stableId,
      seasonId: season?.id || series.seasonId || '',
      seriesId: series.id,
      seasonSeriesId: series.id,
      roundId: series.roundId,
      dateKey: dateKeyStr,
      gameNumber,
      seriesGameNumber: gameNumber,
      game: gameNumber,
      matchupType: 'tournament',
      matchupId: stableId,
      playerAId: series.playerAId,
      playerBId: series.playerBId,
      winnerId,
      loserId,
      playerAScore: winnerIsA ? 40 : 25,
      playerBScore: winnerIsA ? 25 : 40,
      source: 'admin_manual',
      manualResult: true,
      catchUpResult: true,
      playInProtectedSlotRepair: true,
      recordedAtISO: now,
      updatedAtISO: now
    };
  }


  function isPlayInProtectedSlotRepairResult(result) {
    if (!result) return false;
    const idText = [result.id, result.matchupId, result.gameId].map((id) => String(id || '')).join(' ').toLowerCase();
    const source = String(result.source || '').toLowerCase();
    return result.playInProtectedSlotRepair === true
      || idText.includes('_protected_slot_repair_game_')
      || (source === 'admin_manual' && result.catchUpResult === true && result.roundId === 'play_in');
  }

  function collectPlayInRepairResultCandidates(season, series, options = {}) {
    const state = options.state || options.currentState || null;
    if (state) {
      const candidates = collectSeasonResultCandidates({ ...state, currentSeason: season }, season, options);
      return (candidates.get(series.id) || []).slice();
    }
    return (Array.isArray(series?.gameResults) ? series.gameResults : [])
      .map((result, index) => normalizeSeasonResultRecord({ ...result, seriesId: series.id, seasonSeriesId: series.id }, series, 'series.gameResults', index))
      .filter(Boolean);
  }

  function normalizePlayInProtectedSlotRepairResults(season, series, rawResults, protectedWinnerId, options = {}) {
    const seenRepairSlots = new Set();
    return (Array.isArray(rawResults) ? rawResults : []).reduce((results, result) => {
      if (!isPlayInProtectedSlotRepairResult(result)) {
        results.push(result);
        return results;
      }
      if (result.winnerId !== protectedWinnerId) return results;
      const gameNumber = Number(result.gameNumber || result.seriesGameNumber || result.game);
      if (!Number.isFinite(gameNumber) || gameNumber <= 0) return results;
      const slotKey = `${gameNumber}:${protectedWinnerId}`;
      if (seenRepairSlots.has(slotKey)) return results;
      seenRepairSlots.add(slotKey);
      results.push({
        ...buildPlayInProtectedSlotRepairGameResult(season, series, protectedWinnerId, gameNumber, options),
        recordedAtISO: result.recordedAtISO || result.completedAtISO || result.dateISO || seasonNowISO(options),
        updatedAtISO: result.updatedAtISO || result.recordedAtISO || seasonNowISO(options),
        _containerSource: result._containerSource || 'series.gameResults',
        _sortKey: result._sortKey || getRecordedResultTime(result) || result.dateKey || ''
      });
      return results;
    }, []);
  }

  function sameSeasonSeriesRepairPayload(a, b) {
    const strip = (series) => {
      if (!series) return series;
      const { updatedAtISO, completedAtISO, ...rest } = series;
      return rest;
    };
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  function repairPlayInSeriesFromProtectedRoundOf32Slots(season, options = {}) {
    let nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season, changed: false, repairedSeriesIds: [] };
    const allSeries = nextSeason.series || {};
    const playIn = Object.values(allSeries)
      .filter((series) => series?.roundId === 'play_in')
      .sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));
    if (playIn.length < 2) return { ok: false, error: 'play_in_series_missing', season: nextSeason, changed: false, repairedSeriesIds: [] };

    const participantIds = new Set();
    const playInByParticipant = new Map();
    playIn.forEach((series) => {
      [series.playerAId, series.playerBId].filter(Boolean).forEach((playerId) => {
        participantIds.add(playerId);
        playInByParticipant.set(playerId, series);
      });
    });

    const seed1Assignment = getProtectedRoundOf32PlayInAssignment(nextSeason, 1, 0);
    const seed2Assignment = getProtectedRoundOf32PlayInAssignment(nextSeason, 2, 8);
    const assigned = [seed1Assignment?.assigned, seed2Assignment?.assigned];
    if (!seed1Assignment?.assigned?.playerId || !seed2Assignment?.assigned?.playerId) {
      return { ok: false, error: 'protected_slots_empty_or_ambiguous', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }
    if (!assigned.every((player) => participantIds.has(player.playerId))) {
      return { ok: false, error: 'protected_slot_non_play_in_participant', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }
    if (assigned[0].playerId === assigned[1].playerId) {
      return { ok: false, error: 'protected_slots_duplicate_winner', reason: 'Protected slots are ambiguous: both protected slots contain the same Play-In player.', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }

    const mappedAssignments = assigned.map((winner) => ({
      ...winner,
      originalSeries: playInByParticipant.get(winner.playerId) || null
    }));
    const missingSeries = mappedAssignments.filter((item) => !item.originalSeries);
    if (missingSeries.length) {
      return { ok: false, error: 'protected_slot_play_in_series_missing', reason: 'Protected slots include player(s) that do not map to a Play-In series.', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }
    const distinctSeriesIds = new Set(mappedAssignments.map((item) => item.originalSeries.id));
    if (distinctSeriesIds.size !== mappedAssignments.length) {
      return { ok: false, error: 'protected_slots_same_play_in_series', reason: 'Protected slots are ambiguous: both assigned Play-In winners map to the same Play-In series.', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }

    const sortedByWorstSeed = assigned.slice().sort((a, b) => (Number(b.seed) || 0) - (Number(a.seed) || 0));
    if (sortedByWorstSeed[0].playerId !== seed1Assignment.assigned.playerId || sortedByWorstSeed[1].playerId !== seed2Assignment.assigned.playerId) {
      return { ok: false, error: 'protected_slots_do_not_match_play_in_protection', season: nextSeason, changed: false, repairedSeriesIds: [] };
    }

    const nextSeries = { ...allSeries };
    const repairedSeriesIds = [];
    let changed = false;
    mappedAssignments.forEach((winner) => {
      const originalSeries = winner.originalSeries;
      const currentSeries = nextSeries[originalSeries.id] || originalSeries;
      const existingWinner = getSeasonSeriesWinner(currentSeries);
      if (existingWinner && existingWinner !== winner.playerId && options.force !== true) return;
      if (winner.playerId !== currentSeries.playerAId && winner.playerId !== currentSeries.playerBId) return;

      const winsNeeded = getSeasonSeriesWinsNeeded(currentSeries);
      let gameResults = collectPlayInRepairResultCandidates(nextSeason, currentSeries, options);
      gameResults = normalizePlayInProtectedSlotRepairResults(nextSeason, currentSeries, gameResults, winner.playerId, options);
      let recalculated = gameResults.length ? rebuildSeasonSeriesFromRecordedResults(currentSeries, gameResults, options) : currentSeries;
      let winsForWinner = winner.playerId === currentSeries.playerAId ? (Number(recalculated.winsA) || 0) : (Number(recalculated.winsB) || 0);
      const usedGameNumbers = new Set((Array.isArray(recalculated.gameResults) ? recalculated.gameResults : gameResults)
        .map((result) => Number(result.gameNumber || result.seriesGameNumber || result.game))
        .filter((value) => Number.isFinite(value) && value > 0));
      let nextGameNumber = 1;
      while (winsForWinner < winsNeeded) {
        while (usedGameNumbers.has(nextGameNumber)) nextGameNumber += 1;
        const stableId = stablePlayInProtectedSlotRepairResultId(currentSeries, nextGameNumber);
        const alreadyHasStable = gameResults.some((result) => result?.id === stableId || result?.matchupId === stableId);
        usedGameNumbers.add(nextGameNumber);
        if (!alreadyHasStable) {
          gameResults.push(buildPlayInProtectedSlotRepairGameResult(nextSeason, currentSeries, winner.playerId, nextGameNumber, options));
        }
        winsForWinner += 1;
      }

      const repaired = rebuildSeasonSeriesFromRecordedResults({ ...currentSeries, gameResults }, gameResults, options);
      const complete = getSeasonSeriesWinner(repaired) === winner.playerId;
      const finalized = complete ? {
        ...repaired,
        winnerId: winner.playerId,
        loserId: winner.playerId === repaired.playerAId ? repaired.playerBId : repaired.playerAId,
        status: 'complete',
        updatedAtISO: sameSeasonSeriesRepairPayload(repaired, currentSeries) ? currentSeries.updatedAtISO : seasonNowISO(options)
      } : repaired;
      if (!sameSeasonSeriesRepairPayload(finalized, currentSeries) || String(finalized.updatedAtISO || '') !== String(currentSeries.updatedAtISO || '')) {
        nextSeries[currentSeries.id] = sameSeasonSeriesRepairPayload(finalized, currentSeries) ? { ...finalized, updatedAtISO: currentSeries.updatedAtISO, completedAtISO: currentSeries.completedAtISO } : finalized;
        repairedSeriesIds.push(currentSeries.id);
        changed = true;
      }
    });

    nextSeason = normalizeSeasonState({ ...nextSeason, series: nextSeries, updatedAtISO: changed ? seasonNowISO(options) : nextSeason.updatedAtISO });
    const advancementRepair = repairPlayInAdvancementForSeason(nextSeason, options);
    if (advancementRepair.season) {
      if (advancementRepair.changed) changed = true;
      nextSeason = advancementRepair.season;
    }
    return { ok: true, season: nextSeason, changed, repairedSeriesIds, seed1Opponent: seed1Assignment.assigned, seed2Opponent: seed2Assignment.assigned };
  }

  function repairPlayInSeriesFromProtectedRoundOf32SlotsForCurrentSeason(state, options = {}) {
    const normalized = normalizeState(state || {});
    const repaired = repairPlayInSeriesFromProtectedRoundOf32Slots(normalized.currentSeason, { ...options, state: normalized });
    if (!repaired.season) return { ...repaired, ok: false, state: normalized, changed: false, error: repaired.error || 'invalid_season', repairedSeriesIds: [] };
    const changed = Boolean(repaired.changed);
    return {
      ...repaired,
      state: changed ? normalizeState({ ...normalized, currentSeason: repaired.season, latestSeasonId: repaired.season.id || normalized.latestSeasonId || '' }) : normalized,
      changed
    };
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

  function repairCompletedSeasonAdvancementForSeason(season, options = {}) {
    let nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season, changed: false };
    let changed = false;
    OFFICIAL_SEASON_ROUND_ORDER.forEach((roundId) => {
      const entries = Object.values(nextSeason.series || {})
        .filter((series) => series?.roundId === roundId && getSeasonSeriesWinner(series))
        .sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));
      entries.forEach((series) => {
        const before = JSON.stringify(nextSeason);
        const advanced = advanceSeasonSeriesWinner(nextSeason, series.id, options);
        if (advanced?.season) {
          nextSeason = advanced.season;
          if (JSON.stringify(nextSeason) !== before) changed = true;
        }
      });
    });
    return { ok: true, season: nextSeason, changed };
  }

function getCurrentSeasonRoundIdForDate(dateKey, seasonOrState = null) {
  return getSeasonRoundForDate(dateKey, seasonOrState)?.id || '';
}

  function getActiveSeasonSeriesForDate(season, dateKey) {
    const roundId = getCurrentSeasonRoundIdForDate(dateKey, season);
    if (!roundId || !season?.series) return [];

    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);
    const seasonControlEnabled = season?.meta?.seasonMatchupControlEnabled === true;
    const currentRoundCanPlay = isSeasonRoundFullyReady(season, roundId) || hasSeasonRoundActivationOverride(season, roundId);

    return Object.values(season.series)
      .filter((series) => {
        if (!series || series.status !== 'active' || isSeasonSeriesComplete(series)) return false;
        if (!series.playerAId || !series.playerBId) return false;

        if (series.roundId === roundId) return currentRoundCanPlay;

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
    if (!normalized) return { season: normalized, changed: false, activatedSeriesIds: [], warnings: [] };
    const roundId = getCurrentSeasonRoundIdForDate(dateKeyStr, normalized);
    if (!roundId || !normalized.series) return { season: normalized, changed: false, activatedSeriesIds: [], warnings: [] };
    const now = seasonNowISO(options);
    const nextSeries = { ...(normalized.series || {}) };
    const activatedSeriesIds = [];
    const warnings = [];
    let changed = false;
    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);
    const seasonControlEnabled = normalized?.meta?.seasonMatchupControlEnabled === true;
    const currentRoundSeries = Object.values(normalized.series || {}).filter((series) => series?.roundId === roundId);
    const currentRoundReady = isSeasonRoundFullyReady(normalized, roundId);
    const currentRoundOverride = hasSeasonRoundActivationOverride(normalized, roundId, options);
    const canActivateCurrentRound = currentRoundReady || currentRoundOverride;

    if (currentRoundSeries.length && !canActivateCurrentRound) {
      const readyCount = currentRoundSeries.filter((series) => series?.playerAId && series?.playerBId).length;
      warnings.push(`${getSeasonDisplayName(roundId) || roundId} is waiting for all series to be ready (${readyCount}/${currentRoundSeries.length}).`);
    }

    Object.values(normalized.series || {}).forEach((series) => {
      if (!series || series.status !== 'pending') return;
      if (!series.playerAId || !series.playerBId) return;
      const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series.roundId);
      const isCurrentRound = series.roundId === roundId;
      const isOverduePriorRound = seasonControlEnabled
        && currentRoundIndex >= 0
        && seriesRoundIndex >= 0
        && seriesRoundIndex < currentRoundIndex;
      if (isCurrentRound && !canActivateCurrentRound) return;
      if (!isCurrentRound && !isOverduePriorRound) return;
      nextSeries[series.id] = { ...series, status: 'active', updatedAtISO: now };
      activatedSeriesIds.push(series.id);
      changed = true;
    });

    const roundHasActiveSeries = Object.values(nextSeries).some((series) => series?.roundId === roundId && series?.status === 'active' && series?.playerAId && series?.playerBId);
    if (canActivateCurrentRound && roundHasActiveSeries && !getSeasonRoundActualStartDateKey(normalized, roundId)) {
      const inferredStart = inferSeasonRoundActualStartDateKey({ ...normalized, series: nextSeries }, roundId, {
        ...options,
        state: options.state || options.currentState,
        currentState: options.currentState || options.state,
        fallbackDateKey: dateKeyStr,
        allowFallbackTodayOnlyWhenNoPriorEvidence: true
      });
      if (inferredStart) {
        normalized.meta = normalizeSeasonObjectMap(normalized.meta);
        normalized.meta.roundStartDateKeys = { ...(normalized.meta.roundStartDateKeys || {}), [roundId]: inferredStart };
        changed = true;
      }
    }

    if (!changed) return { season: normalized, changed: false, activatedSeriesIds, warnings };
    const nextMeta = {
      ...(normalized.meta || {}),
      roundStartDateKeys: { ...(normalized.meta?.roundStartDateKeys || {}) }
    };
    return {
      season: normalizeSeasonState({ ...normalized, meta: nextMeta, series: nextSeries, updatedAtISO: now }),
      changed: true,
      activatedSeriesIds,
      warnings
    };
  }

  function getSeasonScheduleSignature(stateOrSeason, dateKeyStr) {
    if (!dateKeyStr) return '';
    const directSeason = stateOrSeason?.series && !stateOrSeason?.currentSeason
      ? normalizeSeasonState(stateOrSeason)
      : null;
    const normalized = directSeason ? null : normalizeState(stateOrSeason || {});
const seasonGateOpen = directSeason
  ? directSeason.meta?.seasonMatchupControlEnabled === true && isSeasonDate(dateKeyStr, directSeason)
  : shouldUseSeasonMatchupControl(normalized, dateKeyStr);
    if (!seasonGateOpen) return '';

    const prepared = prepareSeasonForDailySlate(directSeason || normalized.currentSeason, dateKeyStr, normalized ? { state: normalized, currentState: normalized } : {});
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
    return [
  season?.id || '',
  getCurrentSeasonRoundIdForDate(dateKeyStr, season),
  season?.meta?.seasonMatchupControlEnabled === true ? 'on' : 'off',
  seriesRevision
].join('::');
  }

  function getScheduleDayDateKey(day) {
    return String(day?.dateKey || day?.date || day?.dayKey || '').slice(0, 10);
  }

  function isValidSeasonControlledScheduleDay(state, dateKeyStr, scheduleDay) {
    const normalized = normalizeState(state || {});
    if (!shouldUseSeasonMatchupControl(normalized, dateKeyStr)) return false;
    if (!scheduleDay || getScheduleDayDateKey(scheduleDay) !== dateKeyStr || scheduleDay.seasonMatchupControl !== true) return false;
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
    const prepared = prepareSeasonForDailySlate(normalized.currentSeason, dateKeyStr, { state: normalized, currentState: normalized });
    const season = prepared.season || normalized.currentSeason;
    return getActiveSeasonSeriesForDate(season, dateKeyStr)
      .every((series) => tournamentSeriesIds.has(series.id));
  }

  function isSeasonSeriesCurrentForMatchupDate(season, series, dateKeyStr) {
    if (!season || !series || !dateKeyStr) return false;
    if (!series.playerAId || !series.playerBId) return false;
    if (series.status !== 'active' || isSeasonSeriesComplete(series)) return false;
    const prepared = prepareSeasonForDailySlate(season, dateKeyStr);
    const slateSeason = prepared.season || season;
    return getActiveSeasonSeriesForDate(slateSeason, dateKeyStr).some((activeSeries) => activeSeries?.id === series.id);
  }

  function isTournamentSeasonMatchupType(matchup) {
    const type = String(matchup?.matchupType || '').toLowerCase();
    return !type || type === 'tournament' || type === 'season';
  }

  function resolveHomeSeasonSeriesForMatchup(state, matchup, dateKeyStr) {
    const normalized = normalizeState(state || {});
    const season = normalized.currentSeason;
    if (!season) return { series: null, ambiguous: true, isExhibition: false };

    const type = String(matchup?.matchupType || '').toLowerCase();
    if (type === 'exhibition') return { series: null, ambiguous: false, isExhibition: true };

    const pairKey = getPairingKey(matchup?.playerAId, matchup?.playerBId);
    const seriesId = getRecordedSeriesId(matchup);
    if (seriesId) {
      const directSeries = season.series?.[seriesId] || null;
      const validDirect = Boolean(
        directSeries
        && isTournamentSeasonMatchupType(matchup)
        && isSeasonSeriesCurrentForMatchupDate(season, directSeries, dateKeyStr)
        && pairKey === getPairingKey(directSeries.playerAId, directSeries.playerBId)
      );
      return { series: validDirect ? directSeries : null, ambiguous: !directSeries, isExhibition: !validDirect && Boolean(directSeries) };
    }

    if (!pairKey) return { series: null, ambiguous: true, isExhibition: false };
    const matches = Object.values(season.series || {}).filter((series) => (
      isSeasonSeriesCurrentForMatchupDate(season, series, dateKeyStr)
      && pairKey === getPairingKey(series.playerAId, series.playerBId)
    ));
    if (matches.length === 1) return { series: matches[0], ambiguous: false, isExhibition: false };
    if (matches.length > 1) return { series: null, ambiguous: true, isExhibition: false };
    return { series: null, ambiguous: false, isExhibition: true };
  }

  function sanitizeSeasonMatchupMetadataForDate(state, matchup, dateKeyStr) {
    if (!matchup || typeof matchup !== 'object') return matchup;
    const type = String(matchup.matchupType || '').toLowerCase();
    const hasSeasonEvidence = Boolean(
      getRecordedSeriesId(matchup)
      || matchup.roundId
      || matchup.roundName
      || matchup.seriesGameNumber
      || matchup.bestOf
      || matchup.winsNeeded
      || matchup.seasonMatchupLabel
      || type === 'tournament'
      || type === 'season'
    );
    if (!hasSeasonEvidence && type !== 'exhibition') return matchup;

    const resolved = resolveHomeSeasonSeriesForMatchup(state, matchup, dateKeyStr);
    if (resolved.series && type !== 'exhibition') return matchup;

    const sanitized = { ...matchup };
    delete sanitized.seriesId;
    delete sanitized.seasonSeriesId;
    delete sanitized.seasonSeriesID;
    delete sanitized.seriesID;
    delete sanitized.roundId;
    delete sanitized.roundName;
    delete sanitized.seriesGameNumber;
    delete sanitized.bestOf;
    delete sanitized.winsNeeded;
    sanitized.matchupType = 'exhibition';
    sanitized.seasonMatchupLabel = 'Exhibition';
    return sanitized;
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

  function getSeriesGameNumber(series, dateKeyStr, season = null) {
    if (!series) return null;
    const results = Array.isArray(series.gameResults) ? series.gameResults : [];
    const sameDate = typeof dateKeyStr === 'string' && dateKeyStr
      ? results.find((result) => result?.dateKey === dateKeyStr)
      : null;
    if (sameDate) {
      const explicitGame = Number(sameDate.gameNumber || sameDate.seriesGameNumber || sameDate.game);
      if (Number.isFinite(explicitGame) && explicitGame > 0) return explicitGame;
      const index = results.indexOf(sameDate);
      return index >= 0 ? index + 1 : null;
    }
    if (isSeasonSeriesComplete(series)) return null;
    const roundGameNumber = season ? getRoundScheduledGameNumberForDate(season, series.roundId, dateKeyStr) : null;
    const next = roundGameNumber || (results.length + 1);
    const bestOf = Number(series.bestOf) || 1;
    if (results.length >= next) return null;
    return next <= bestOf ? next : null;
  }

  function getCurrentSeriesGameNumberForHome(series, dateKeyStr, season = null) {
    if (!series) return 1;
    const roundGameNumber = season && !isSeasonSeriesComplete(series) ? getRoundScheduledGameNumberForDate(season, series.roundId, dateKeyStr) : null;
    if (roundGameNumber && (Array.isArray(series.gameResults) ? series.gameResults.length : 0) < roundGameNumber) return roundGameNumber;
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
      || Number(getSeriesGameNumber(series, dateKeyStr, season))
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
    const activeRoundId = getCurrentSeasonRoundIdForDate(dateKeyStr, season) || '';
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


function getSeasonManualResultDateKey(series, gameNumber, season = null) {
  const seasonRef = season || { id: series?.seasonId || '', monthKey: String(series?.seasonId || '').includes('august_2026') ? '2026-08' : DEFAULT_SEASON_MONTH_KEY };
  const round = getSeasonDateWindowsForSeason(seasonRef).find((item) => item.id === series?.roundId);
  if (!round) return '';

  const offset = Math.max(0, Math.floor(Number(gameNumber) || 1) - 1);
  const candidate = adjacentLocalDateKey(round.startDate, offset);
  return candidate && candidate <= round.endDate ? candidate : round.endDate;
}

  function isSyntheticSeasonRepairResult(result) {
    if (!result) return false;
    const source = String(result?.source || '').toLowerCase();
    const idText = [result?.id, result?.matchupId, result?.gameId]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    return result?.playInProtectedSlotRepair === true
      || result?.lateBoundSeriesCatchUp === true
      || result?.catchUpResult === true
      || source === 'admin_catch_up'
      || idText.includes('_protected_slot_repair_game_')
      || idText.includes('_catch_up_');
  }

  function isTrueManualSeasonOverrideResult(result) {
    if (!result) return false;
    if (isSyntheticSeasonRepairResult(result)) return false;
    const source = String(result?.source || '').toLowerCase();
    return result?.manualResult === true
      || result?.adminManual === true
      || source === 'admin_manual'
      || source === 'admin'
      || source === 'manual';
  }

  function isAdminManualSeasonGameResult(result) {
    return isTrueManualSeasonOverrideResult(result) || isSyntheticSeasonRepairResult(result);
  }

  function reconcileManualSeasonSeriesGameResults(series, patch = {}, options = {}) {
    if (!series) return series;
    const desiredWinsA = Number.isFinite(Number(patch.winsA)) ? Math.max(0, Math.floor(Number(patch.winsA))) : (Number(series.winsA) || 0);
    const desiredWinsB = Number.isFinite(Number(patch.winsB)) ? Math.max(0, Math.floor(Number(patch.winsB))) : (Number(series.winsB) || 0);
    const now = seasonNowISO(options);
    const existingResults = (Array.isArray(series.gameResults) ? series.gameResults : [])
      .filter((result) => result && (result.winnerId === series.playerAId || result.winnerId === series.playerBId))
      .map((result, index) => ({ ...result, _originalIndex: index }))
      .sort((a, b) => {
        const aGame = Number(a.gameNumber || a.seriesGameNumber || a.game);
        const bGame = Number(b.gameNumber || b.seriesGameNumber || b.game);
        if (Number.isFinite(aGame) && Number.isFinite(bGame) && aGame !== bGame) return aGame - bGame;
        return String(a.dateKey || a.recordedAtISO || a._originalIndex).localeCompare(String(b.dateKey || b.recordedAtISO || b._originalIndex));
      });
    const preserved = [];
    let winsA = 0;
    let winsB = 0;
    existingResults.filter((result) => !isAdminManualSeasonGameResult(result)).forEach((result) => {
      if (result.winnerId === series.playerAId) winsA += 1;
      else if (result.winnerId === series.playerBId) winsB += 1;
      preserved.push(result);
    });
    const neededA = Math.max(0, desiredWinsA - winsA);
    const neededB = Math.max(0, desiredWinsB - winsB);
    let keptManualA = 0;
    let keptManualB = 0;
    existingResults.filter(isAdminManualSeasonGameResult).forEach((result) => {
      if (result.winnerId === series.playerAId && keptManualA < neededA) {
        keptManualA += 1;
        preserved.push(result);
      } else if (result.winnerId === series.playerBId && keptManualB < neededB) {
        keptManualB += 1;
        preserved.push(result);
      }
    });
    const usedGameNumbers = new Set(preserved.map((result) => Number(result.gameNumber || result.seriesGameNumber || result.game)).filter((value) => Number.isFinite(value) && value > 0));
    const nextGameNumber = () => {
      let gameNumber = 1;
      while (usedGameNumbers.has(gameNumber)) gameNumber += 1;
      usedGameNumbers.add(gameNumber);
      return gameNumber;
    };
    const addManual = (winnerId) => {
      const gameNumber = nextGameNumber();
      const loserId = winnerId === series.playerAId ? series.playerBId : series.playerAId;
      const dateKey = getSeasonManualResultDateKey(series, gameNumber);
      preserved.push({
        dateKey,
        gameNumber,
        matchupId: `${series.id}_admin_manual_game_${gameNumber}`,
        seriesId: series.id,
        seasonSeriesId: series.id,
        winnerId,
        loserId,
        source: 'admin_manual',
        manualResult: true,
        recordedAtISO: now,
        updatedAtISO: now
      });
    };
    const manualWinnerSequence = [];
    const winsNeeded = getSeasonSeriesWinsNeeded(series);
    const finalWinnerId = patch.winnerId || (desiredWinsA >= winsNeeded && desiredWinsA > desiredWinsB ? series.playerAId : (desiredWinsB >= winsNeeded && desiredWinsB > desiredWinsA ? series.playerBId : ''));
    if (finalWinnerId === series.playerAId && neededA > 0) {
      for (let index = keptManualA; index < neededA - 1; index += 1) manualWinnerSequence.push(series.playerAId);
      for (let index = keptManualB; index < neededB; index += 1) manualWinnerSequence.push(series.playerBId);
      manualWinnerSequence.push(series.playerAId);
    } else if (finalWinnerId === series.playerBId && neededB > 0) {
      for (let index = keptManualB; index < neededB - 1; index += 1) manualWinnerSequence.push(series.playerBId);
      for (let index = keptManualA; index < neededA; index += 1) manualWinnerSequence.push(series.playerAId);
      manualWinnerSequence.push(series.playerBId);
    } else {
      for (let index = keptManualA; index < neededA; index += 1) manualWinnerSequence.push(series.playerAId);
      for (let index = keptManualB; index < neededB; index += 1) manualWinnerSequence.push(series.playerBId);
    }
    manualWinnerSequence.forEach(addManual);
    const gameResults = preserved
      .map(({ _originalIndex, ...result }) => ({
        ...result,
        seriesId: result.seriesId || series.id,
        seasonSeriesId: result.seasonSeriesId || series.id,
        loserId: result.loserId || (result.winnerId === series.playerAId ? series.playerBId : series.playerAId)
      }))
      .sort((a, b) => {
        const aGame = Number(a.gameNumber || a.seriesGameNumber || a.game);
        const bGame = Number(b.gameNumber || b.seriesGameNumber || b.game);
        if (Number.isFinite(aGame) && Number.isFinite(bGame) && aGame !== bGame) return aGame - bGame;
        return String(a.dateKey || a.recordedAtISO || '').localeCompare(String(b.dateKey || b.recordedAtISO || ''));
      });
    return recalculateSeasonSeriesFromGameResults({ ...series, gameResults, manualResult: true, resultSource: 'manual' }, options);
  }

  function updateSeasonSeriesManualResult(season, seriesId, patch = {}, options = {}) {
    const nextSeason = normalizeSeasonState(season);
    if (!nextSeason) return { ok: false, error: 'invalid_season', season };
    const series = nextSeason.series?.[seriesId];
    if (!series) return { ok: false, error: 'series_not_found', season: nextSeason };
    if (patch.clear === true) {
      const retainedResults = (Array.isArray(series.gameResults) ? series.gameResults : []).filter((result) => !isAdminManualSeasonGameResult(result));
      const clearedBase = { ...series, gameResults: retainedResults, manualResult: false, resultSource: '' };
      const cleared = retainedResults.length
        ? recalculateSeasonSeriesFromGameResults(clearedBase, options)
        : { ...clearedBase, winsA: 0, winsB: 0, winnerId: '', loserId: '', status: series.playerAId && series.playerBId ? 'active' : 'pending', updatedAtISO: seasonNowISO(options) };
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
    const reconciled = reconcileManualSeasonSeriesGameResults(series, { ...patch, winsA, winsB, winnerId }, options);
    const updated = {
      ...reconciled,
      winnerId: winnerId || reconciled.winnerId || '',
      loserId: (winnerId || reconciled.winnerId) ? ((winnerId || reconciled.winnerId) === series.playerAId ? series.playerBId : series.playerAId) : (reconciled.loserId || ''),
      status: (winnerId || reconciled.winnerId) ? 'complete' : reconciled.status,
      manualResult: true,
      resultSource: 'manual',
      updatedAtISO: seasonNowISO(options)
    };
    nextSeason.series = { ...(nextSeason.series || {}), [seriesId]: updated };
    nextSeason.updatedAtISO = seasonNowISO(options);
    let advanced = null;
    if ((patch.advance === true || updated.status === 'complete') && (winnerId || updated.winnerId)) {
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
    if (assigned.roundId === 'round_of_32' && isLateBoundRoundOf32PlayInSeries(assigned)) {
      const catchUpRepair = backfillLateBoundSeasonSeriesResults({ currentSeason: nextSeason }, nextSeason, options);
      if (catchUpRepair.updatedSeason) {
        return { ok: true, season: catchUpRepair.updatedSeason, series: catchUpRepair.updatedSeason.series?.[targetSeriesId] || assigned, catchUp: catchUpRepair };
      }
    }
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
      const winnerIdRepair = repairSeasonSeriesResultWinnerIds({ ...normalized, currentSeason: repaired }, options);
      if (winnerIdRepair?.state?.currentSeason) repaired = winnerIdRepair.state.currentSeason;
      const repairState = normalizeState({ ...normalized, currentSeason: repaired });
      const upstreamPlayInRepair = repairPlayInSeriesFromProtectedRoundOf32Slots(repaired, {
        ...options,
        state: repairState,
        currentState: repairState
      });
      if (upstreamPlayInRepair.season && (upstreamPlayInRepair.ok || upstreamPlayInRepair.changed)) repaired = upstreamPlayInRepair.season;
      const playInRepair = repairPlayInAdvancementForSeason(repaired, options);
      if (playInRepair.season) repaired = playInRepair.season;
      return normalizeSeasonState(repaired);
    };
    const currentSeason = repairSeason(normalized.currentSeason);
    const seasonHistory = normalizeSeasonHistory(normalized.seasonHistory).map(repairSeason).filter(Boolean);
    const nextState = normalizeState({ ...normalized, currentSeason, seasonHistory });
    return { ok: true, state: nextState, changed: JSON.stringify(nextState.currentSeason || null) !== JSON.stringify(normalized.currentSeason || null) || JSON.stringify(nextState.seasonHistory || []) !== JSON.stringify(normalized.seasonHistory || []) };
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
    && ['locked', 'active', 'champion_crowned'].includes(season.status)
    && season.meta?.seasonMatchupControlEnabled === true
    && isSeasonDate(dateKeyStr, season)
    && seriesEntries.length > 0
    && playerPool.length >= 2
  );
}

  function getPairingKey(playerAId, playerBId) {
    return normalizePairIds(playerAId, playerBId).join('|');
  }

  function createSeasonSlateSeededRandom(seedInput) {
    let seed = 2166136261;
    const text = String(seedInput || 'taskpoints-season-slate');
    for (let i = 0; i < text.length; i += 1) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
    return function seededSeasonSlateRandom() {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function getJunePairingHistory(state, season, beforeDateKey) {
    const normalized = normalizeState(state || {});
    const start = season?.startDate || '2026-06-01';
    const end = season?.endDate || '2026-06-30';
    const history = new Map();

    const addHistory = (playerAId, playerBId, key, source = 'matchup', id = '') => {
      if (!key || key < start || key > end || (beforeDateKey && key >= beforeDateKey)) return;
      if (!playerAId || !playerBId) return;
      const pairingKey = getPairingKey(playerAId, playerBId);
      const existing = history.get(pairingKey);
      const [normalizedA, normalizedB] = normalizePairIds(playerAId, playerBId);
      const isTournament = source === 'tournament' || source === 'season';
      const entry = {
        key: pairingKey,
        playerAId: normalizedA,
        playerBId: normalizedB,
        firstDateKey: existing?.firstDateKey && existing.firstDateKey < key ? existing.firstDateKey : key,
        lastDateKey: existing?.lastDateKey && existing.lastDateKey > key ? existing.lastDateKey : key,
        tournamentLastDateKey: isTournament && (!existing?.tournamentLastDateKey || existing.tournamentLastDateKey < key) ? key : (existing?.tournamentLastDateKey || ''),
        exhibitionLastDateKey: !isTournament && (!existing?.exhibitionLastDateKey || existing.exhibitionLastDateKey < key) ? key : (existing?.exhibitionLastDateKey || ''),
        count: (existing?.count || 0) + 1,
        tournamentCount: (existing?.tournamentCount || 0) + (isTournament ? 1 : 0),
        exhibitionCount: (existing?.exhibitionCount || 0) + (isTournament ? 0 : 1),
        matchups: (existing?.matchups || []).concat(id || '')
      };
      history.set(pairingKey, entry);
    };

    (normalized.matchups || []).forEach((matchup) => {
      const key = matchupDateKey(matchup);
      const type = String(matchup?.matchupType || '').toLowerCase();
      addHistory(matchup?.playerAId, matchup?.playerBId, key, type === 'tournament' || type === 'season' || getRecordedSeriesId(matchup) ? 'tournament' : 'exhibition', matchup?.id || '');
    });

    Object.values(season?.series || {}).forEach((series) => {
      if (!series?.playerAId || !series?.playerBId) return;
      (Array.isArray(series.gameResults) ? series.gameResults : []).forEach((result) => {
        addHistory(series.playerAId, series.playerBId, result?.dateKey || '', 'tournament', result?.matchupId || series.id || '');
      });
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

    const currentDateKey = String(options.dateKey || options.beforeDateKey || '2026-06-30');
    const daysAgo = (dateKey) => {
      if (!dateKey) return 999;
      const current = Date.parse(`${currentDateKey}T00:00:00Z`);
      const prior = Date.parse(`${dateKey}T00:00:00Z`);
      if (!Number.isFinite(current) || !Number.isFinite(prior)) return 999;
      return Math.max(0, Math.round((current - prior) / 86400000));
    };
    const fallbackPenalty = (first, candidate) => {
      const entry = history?.get(getPairingKey(first, candidate));
      if (!entry) return 0;
      const recentTournamentPenalty = entry.tournamentLastDateKey ? Math.max(0, 500 - daysAgo(entry.tournamentLastDateKey) * 25) : 0;
      const recentOverallPenalty = entry.lastDateKey ? Math.max(0, 120 - daysAgo(entry.lastDateKey) * 8) : 0;
      return 1000 + recentTournamentPenalty + recentOverallPenalty + (Number(entry.count) || 0) + (entry.lastDateKey ? Number(String(entry.lastDateKey).replace(/-/g, '')) / 100000 : 0);
    };

    const remaining = shuffleWithRandom(ids);
    const fallbackPairs = [];
    let relaxedRepeatCount = 0;
    const relaxedDetails = [];
    while (remaining.length) {
      const first = remaining.shift();
      let bestIndex = -1;
      let bestPenalty = Infinity;
      remaining.forEach((candidate, index) => {
        const penalty = fallbackPenalty(first, candidate);
        if (bestIndex === -1 || penalty < bestPenalty) {
          bestIndex = index;
          bestPenalty = penalty;
        }
      });
      if (bestIndex < 0) break;
      const [second] = remaining.splice(bestIndex, 1);
      const repeated = hasJunePairingOccurred(history, first, second);
      if (repeated) {
        relaxedRepeatCount += 1;
        const entry = history?.get(getPairingKey(first, second));
        relaxedDetails.push(`${first}-${second}${entry?.lastDateKey ? ` last played ${entry.lastDateKey}` : ''}`);
      }
      fallbackPairs.push({ playerAId: first, playerBId: second, repeated });
    }
    if (fallbackPairs.length * 2 !== ids.length) {
      errors.push('Unable to create a full fallback pairing slate.');
      return { ok: false, pairs: fallbackPairs, warnings, errors, relaxedRepeatCount };
    }
    if (relaxedRepeatCount) warnings.push(`No-repeat June pairing rule relaxed for ${relaxedRepeatCount} matchup(s): ${relaxedDetails.join('; ')}.`);
    return { ok: true, pairs: fallbackPairs, warnings, errors, relaxedRepeatCount };
  }

  function prepareSeasonStateForScheduling(state, dateKeyStr, options = {}) {
    const warnings = [];
    const errors = [];
    let normalized = normalizeState(state || {});
    let changed = false;
    const scheduleDateKey = String(dateKeyStr || options.todayDateKey || options.dateKey || '').slice(0, 10);
    const nowISO = options.nowISO || (scheduleDateKey ? `${scheduleDateKey}T12:00:00.000Z` : seasonNowISO(options));

    const { dateKey: _ignoredDateKey, ...syncOptions } = options || {};
    if (typeof syncCurrentSeasonSeriesFromRecordedResults === 'function') {
      const synced = syncCurrentSeasonSeriesFromRecordedResults(normalized, {
        ...syncOptions,
        nowISO,
        todayDateKey: scheduleDateKey,
        includeCurrentDayResults: options.includeCurrentDayResults === true
      });
      if (synced?.state) {
        normalized = synced.state;
        changed = changed || Boolean(synced.changed);
        if (Array.isArray(synced.warnings)) warnings.push(...synced.warnings);
        if (Array.isArray(synced.errors)) errors.push(...synced.errors);
      }
    }

    if (typeof repairCurrentRoundSeriesGameAlignment === 'function') {
      const aligned = repairCurrentRoundSeriesGameAlignment(normalized, {
        ...options,
        nowISO,
        dateKey: scheduleDateKey,
        todayDateKey: scheduleDateKey,
        includeCurrentDayResults: options.includeCurrentDayResults === true,
        requireRecordedResultForAlignment: true
      });
      if (aligned?.state) {
        normalized = aligned.state;
        changed = changed || Boolean(aligned.changed);
        if (Array.isArray(aligned.warnings)) warnings.push(...aligned.warnings);
        if (Array.isArray(aligned.errors)) errors.push(...aligned.errors);
      }
    }

    if (typeof repairSeasonChampionshipData === 'function') {
      const beforeRepairSnapshot = JSON.stringify(normalized.currentSeason || null);
      const repaired = repairSeasonChampionshipData(normalized, { ...options, nowISO, dateKey: scheduleDateKey });
      if (repaired?.state) {
        normalized = repaired.state;
        changed = changed || Boolean(repaired.changed) || JSON.stringify(normalized.currentSeason || null) !== beforeRepairSnapshot;
        if (Array.isArray(repaired.warnings)) warnings.push(...repaired.warnings);
        if (Array.isArray(repaired.errors)) errors.push(...repaired.errors);
      }
    }

    return { state: normalized, changed, warnings, errors };
  }

  function isTournamentOrSeasonMatchup(matchup) {
    const type = String(matchup?.matchupType || '').toLowerCase();
    return type === 'tournament' || type === 'season';
  }

  function isExhibitionMatchup(matchup) {
    return String(matchup?.matchupType || '').toLowerCase() === 'exhibition';
  }

  function removeInvalidExhibitionsForTournamentParticipants(state, dateKeyStr, options = {}) {
    const normalized = options.normalized ? { ...(state || {}) } : normalizeState(state || {});
    const targetDate = String(dateKeyStr || '').slice(0, 10);
    if (!targetDate) return { state: normalized, changed: false, removedCount: 0 };

    const tournamentPlayerIds = new Set();
    const collectTournamentPlayers = (matchups) => {
      (Array.isArray(matchups) ? matchups : []).forEach((matchup) => {
        if (!matchup || matchupDateKey(matchup) !== targetDate || !isTournamentOrSeasonMatchup(matchup)) return;
        if (matchup.playerAId) tournamentPlayerIds.add(String(matchup.playerAId));
        if (matchup.playerBId) tournamentPlayerIds.add(String(matchup.playerBId));
      });
    };

    collectTournamentPlayers(normalized.matchups);
    (Array.isArray(normalized.schedule) ? normalized.schedule : []).forEach((day) => {
      const dayKey = getScheduleDayDateKey(day);
      if (dayKey === targetDate) {
        const datedMatchups = (Array.isArray(day.matchups) ? day.matchups : []).map((matchup) => ({
          ...matchup,
          date: matchup?.date || dayKey,
          dateKey: matchup?.dateKey || dayKey
        }));
        collectTournamentPlayers(datedMatchups);
      }
    });

    if (!tournamentPlayerIds.size) return { state: normalized, changed: false, removedCount: 0 };

    const isInvalidExhibition = (matchup) => {
      if (!matchup || matchupDateKey(matchup) !== targetDate || !isExhibitionMatchup(matchup)) return false;
      return tournamentPlayerIds.has(String(matchup.playerAId || '')) || tournamentPlayerIds.has(String(matchup.playerBId || ''));
    };

    let removedCount = 0;
    const nextMatchups = (Array.isArray(normalized.matchups) ? normalized.matchups : []).filter((matchup) => {
      const remove = isInvalidExhibition(matchup);
      if (remove) removedCount += 1;
      return !remove;
    });

    const nextSchedule = (Array.isArray(normalized.schedule) ? normalized.schedule : []).map((day) => {
      const dayKey = getScheduleDayDateKey(day);
      if (dayKey !== targetDate || !Array.isArray(day?.matchups)) return day;
      let removedFromDay = 0;
      const matchups = day.matchups.filter((matchup) => {
        const remove = isInvalidExhibition({ ...matchup, dateKey: matchup.dateKey || dayKey, date: matchup.date || dayKey });
        if (remove) removedFromDay += 1;
        return !remove;
      });
      if (!removedFromDay) return day;
      removedCount += removedFromDay;
      return { ...day, matchups };
    });

    const changed = removedCount > 0;
    return {
      state: changed ? normalizeState({ ...normalized, matchups: nextMatchups, schedule: nextSchedule }) : normalized,
      changed,
      removedCount
    };
  }

  function scheduleRowHasRecordedScore(row) {
    const matchups = Array.isArray(row?.matchups) ? row.matchups : [];
    return matchups.some((matchup) => {
      const a = Number(matchup?.scoreA ?? matchup?.playerAScore);
      const b = Number(matchup?.scoreB ?? matchup?.playerBScore);
      return Number.isFinite(a) || Number.isFinite(b) || Boolean(matchup?.result || matchup?.winnerId || matchup?.completedAtISO);
    });
  }

  function repairSeasonControlledScheduleFromSyncedSeason(state, options = {}) {
    let normalized = normalizeState(state || {});
    const today = String(options.todayDateKey || options.dateKey || (options.nowISO ? dateKey(options.nowISO) : dateKey(new Date())) || '').slice(0, 10);
    const prepared = prepareSeasonStateForScheduling(normalized, today, options);
    if (prepared?.state) normalized = prepared.state;
    let changed = Boolean(prepared?.changed);
    const repairDates = new Set([today]);
    (Array.isArray(normalized.schedule) ? normalized.schedule : []).forEach((day) => {
      const dayKey = getScheduleDayDateKey(day);
      if (dayKey && dayKey >= today) repairDates.add(dayKey);
    });
    repairDates.forEach((dayKey) => {
      const overlapRepair = removeInvalidExhibitionsForTournamentParticipants(normalized, dayKey, { normalized: true });
      if (overlapRepair?.state) normalized = overlapRepair.state;
      changed = changed || Boolean(overlapRepair?.changed);
    });
    const repairedDates = [];
    const schedule = Array.isArray(normalized.schedule) ? normalized.schedule : [];
    if (!today || !schedule.length) return { state: normalized, changed, repairedDates };

    const nextSchedule = schedule.map((day) => {
      const dayKey = getScheduleDayDateKey(day);
      if (!dayKey || dayKey < today) return day;
      if (dayKey === today && shouldUseSeasonMatchupControl(normalized, dayKey)) {
        const materialized = materializeSeasonSlateMatchupsForDate(normalized, dayKey, options);
        if (materialized?.state) normalized = materialized.state;
        if (materialized?.changed) {
          repairedDates.push(dayKey);
          changed = true;
          const repairedDay = (Array.isArray(normalized.schedule) ? normalized.schedule : []).find((candidate) => getScheduleDayDateKey(candidate) === dayKey);
          if (repairedDay) return repairedDay;
        }
        if (day?.seasonMatchupControl === true && scheduleRowHasRecordedScore(day)) return day;
      }
      if (day?.seasonMatchupControl !== true) return day;
      if (!shouldUseSeasonMatchupControl(normalized, dayKey)) return day;

      const expectedSignature = getSeasonScheduleSignature(normalized, dayKey);
      if (expectedSignature && day.seasonScheduleSignature === expectedSignature && isValidSeasonControlledScheduleDay(normalized, dayKey, day)) return day;

      const slate = buildSeasonDailySlate(normalized, dayKey, options);
      if (!slate?.ok) return day;
      if (slate.updatedSeason) {
        normalized = normalizeState({ ...normalized, currentSeason: slate.updatedSeason, latestSeasonId: slate.updatedSeason.id || normalized.latestSeasonId || '' });
      }
      repairedDates.push(dayKey);
      changed = true;
      return {
        ...day,
        date: dayKey,
        dateKey: dayKey,
        matchups: slate.allMatchups,
        byeIds: [],
        seasonMatchupControl: true,
        seasonScheduleSignature: getSeasonScheduleSignature(normalized, dayKey),
        seasonWarnings: slate.warnings || []
      };
    });

    if (changed) normalized = normalizeState({ ...normalized, schedule: nextSchedule });
    return { state: normalized, changed, repairedDates };
  }

  function buildSeasonDailySlate(state, dateKeyStr, options = {}) {
    const warnings = [];
    const errors = [];
    let normalized = normalizeState(state || {});
    const preparedForScheduling = prepareSeasonStateForScheduling(normalized, dateKeyStr, options);
    if (preparedForScheduling?.state) normalized = preparedForScheduling.state;
    if (Array.isArray(preparedForScheduling?.warnings)) warnings.push(...preparedForScheduling.warnings);
    if (Array.isArray(preparedForScheduling?.errors)) errors.push(...preparedForScheduling.errors);
    const season = normalizeSeasonState(normalized.currentSeason);
    if (!shouldUseSeasonMatchupControl(normalized, dateKeyStr)) {
      errors.push('Season matchup control gate is closed.');
      return { ok: false, dateKey: dateKeyStr, tournamentMatchups: [], exhibitionMatchups: [], allMatchups: [], warnings, errors, updatedSeason: season };
    }

    const preparedSeason = prepareSeasonForDailySlate(season, dateKeyStr, { ...options, state: normalized, currentState: normalized });
    const slateSeason = preparedSeason.season || season;
    if (preparedSeason.changed && preparedSeason.activatedSeriesIds.length) warnings.push(`Activated ${preparedSeason.activatedSeriesIds.length} ready ${getSeasonDisplayName(getCurrentSeasonRoundIdForDate(dateKeyStr, slateSeason), slateSeason) || 'Season'} series for slate generation.`);
    if (Array.isArray(preparedSeason.warnings)) warnings.push(...preparedSeason.warnings);

    const playerPool = getActiveSeasonPlayerPool(normalized);
    const playerById = new Map(playerPool.map((player) => [player.id || player.playerId, player]));
    const activeSeries = getActiveSeasonSeriesForDate(slateSeason, dateKeyStr)
      .filter((series) => series && !isSeasonSeriesComplete(series) && series.playerAId && series.playerBId)
      .sort((a, b) => (Number(a.roundIndex) || 0) - (Number(b.roundIndex) || 0) || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));

    const used = new Set();
    const tournamentMatchups = [];
    activeSeries.forEach((series) => {
      const playedCount = Array.isArray(series.gameResults) ? series.gameResults.length : 0;
      const roundGameNumber = getRoundScheduledGameNumberForDate(slateSeason, series.roundId, dateKeyStr);
      const seriesGameNumber = options.forceCalendarGameNumbers === true
        ? (roundGameNumber || playedCount + 1)
        : playedCount + 1;
      if (seriesGameNumber > (Number(series.bestOf) || 1)) return;
      if (playedCount >= seriesGameNumber) return;
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
    const slateRandom = typeof options.random === 'function'
      ? options.random
      : createSeasonSlateSeededRandom(`${slateSeason.id || 'season'}:${dateKeyStr}:exhibitions`);
    const generated = generateRandomNonRepeatPairs(exhibitionPool, history, { ...options, dateKey: dateKeyStr, random: slateRandom });
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


  function getSeasonSlateTournamentMatchups(state, dateKeyStr, options = {}) {
    const slate = buildSeasonDailySlate(state, dateKeyStr, options);
    const matchups = Array.isArray(slate?.tournamentMatchups)
      ? slate.tournamentMatchups
      : (Array.isArray(slate?.allMatchups) ? slate.allMatchups.filter((matchup) => {
          const type = String(matchup?.matchupType || '').toLowerCase();
          return type === 'tournament' || type === 'season';
        }) : []);
    return { slate, matchups };
  }

  function matchupHasRecordedScoreOrResult(matchup) {
    if (!matchup) return false;
    const scoreA = Number(matchup.scoreA ?? matchup.playerAScore);
    const scoreB = Number(matchup.scoreB ?? matchup.playerBScore);
    return Number.isFinite(scoreA)
      || Number.isFinite(scoreB)
      || Boolean(matchup.result || matchup.winnerId || matchup.completedAtISO || matchup.completedAt || matchup.finalizedAtISO);
  }

  function getStoredMatchupDateKey(matchup) {
    return String(matchup?.dateKey || matchup?.date || (matchup?.dateISO ? dateKey(matchup.dateISO) : '') || '').slice(0, 10);
  }

  function isSeasonTournamentMatchup(matchup) {
    const type = String(matchup?.matchupType || '').toLowerCase();
    return type === 'tournament' || type === 'season' || Boolean(matchup?.seriesId || matchup?.seasonSeriesId);
  }



  function finiteNumberValue(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function matchupStableIdentity(matchup, dateKeyStr = '') {
    if (!matchup || typeof matchup !== 'object') return '';
    const id = String(matchup.id || matchup.matchupId || '').trim();
    if (id) return `id:${id}`;
    const seriesId = String(matchup.seriesId || matchup.seasonSeriesId || matchup.seasonSeriesID || '').trim();
    const gameNumber = String(matchup.gameNumber || matchup.game || matchup.roundGameNumber || '').trim();
    const date = String(dateKeyStr || getStoredMatchupDateKey(matchup)).slice(0, 10);
    if (seriesId && gameNumber) return `series:${seriesId}|${date}|${gameNumber}`;
    const a = String(matchup.playerAId || matchup.playerA || matchup.aPlayerId || '').trim();
    const b = String(matchup.playerBId || matchup.playerB || matchup.bPlayerId || '').trim();
    if (!date || !a || !b) return '';
    const pair = [a, b].sort().join('|');
    const type = String(matchup.matchupType || matchup.type || '').trim().toLowerCase();
    return `pair:${date}|${pair}|${type}`;
  }

  function matchupKeepScore(row) {
    if (!row || typeof row !== 'object') return -1;
    const scoreA = finiteNumberValue(row.scoreA ?? row.playerAScore);
    const scoreB = finiteNumberValue(row.scoreB ?? row.playerBScore);
    let score = 0;
    if (scoreA != null || scoreB != null) score += 1000;
    if (scoreA != null && scoreB != null) score += 1000;
    if (row.result || row.winnerId || row.final === true || row.isFinal === true || row.completedAtISO || row.recordedAtISO || row.finalizedAtISO) score += 3000;
    score += Object.keys(row).filter((key) => row[key] != null && row[key] !== '').length;
    return score;
  }

  function mergePreferredMatchupRow(existing, incoming) {
    const preferred = matchupKeepScore(incoming) > matchupKeepScore(existing) ? incoming : existing;
    const other = preferred === incoming ? existing : incoming;
    return { ...(other || {}), ...(preferred || {}) };
  }

  function compactScheduleMatchupRow(row) {
    if (!row || typeof row !== 'object') return row;
    const keep = ['id','matchupId','date','dateKey','playerAId','playerBId','scoreA','scoreB','playerAScore','playerBScore','matchupType','type','seasonId','seriesId','seasonSeriesId','gameNumber','roundGameNumber','result','winnerId','loserId','completedAtISO','recordedAtISO','finalizedAtISO','final','isFinal'];
    const out = {};
    keep.forEach((key) => { if (row[key] != null && row[key] !== '') out[key] = row[key]; });
    if (out.date && !out.dateKey) out.dateKey = out.date;
    if (out.dateKey && !out.date) out.date = out.dateKey;
    return out;
  }

  function dedupeSameDayMatchups(state, dateKeyStr) {
    const key = String(dateKeyStr || '').slice(0, 10);
    if (!key || !Array.isArray(state?.matchups)) return { state, changed: false, removed: 0 };
    const byIdentity = new Map();
    const next = [];
    let removed = 0;
    state.matchups.forEach((row) => {
      if (getStoredMatchupDateKey(row) !== key) { next.push(row); return; }
      const identity = matchupStableIdentity(row, key);
      if (!identity) { next.push(row); return; }
      if (!byIdentity.has(identity)) {
        byIdentity.set(identity, next.length);
        next.push(row);
        return;
      }
      const idx = byIdentity.get(identity);
      next[idx] = mergePreferredMatchupRow(next[idx], row);
      removed += 1;
    });
    return removed ? { state: { ...state, matchups: next }, changed: true, removed } : { state, changed: false, removed: 0 };
  }

  function gameHistoryKeepScore(row) {
    const score = finiteNumberValue(row?.score ?? row?.points ?? row?.total);
    let rank = score != null ? 1000 : 0;
    if (row?.result || row?.winnerId || row?.final === true || row?.isFinal === true || row?.completedAtISO || row?.recordedAtISO || row?.finalizedAtISO) rank += 2000;
    if (row && typeof row === 'object') rank += Object.keys(row).filter((key) => row[key] != null && row[key] !== '').length;
    return rank;
  }

  function dedupeSameDayGameHistory(state, dateKeyStr) {
    const key = String(dateKeyStr || '').slice(0, 10);
    if (!key || !Array.isArray(state?.gameHistory)) return { state, changed: false, removed: 0 };
    const byPlayer = new Map();
    const next = [];
    let removed = 0;
    state.gameHistory.forEach((row) => {
      const rowDate = String(row?.dateKey || row?.date || (row?.dateISO ? dateKey(row.dateISO) : '') || '').slice(0, 10);
      const playerId = String(row?.playerId || '').trim();
      if (rowDate !== key || !playerId) { next.push(row); return; }
      const identity = `${key}|${playerId}`;
      if (!byPlayer.has(identity)) { byPlayer.set(identity, next.length); next.push(row); return; }
      const idx = byPlayer.get(identity);
      next[idx] = gameHistoryKeepScore(row) > gameHistoryKeepScore(next[idx]) ? { ...next[idx], ...row } : { ...row, ...next[idx] };
      removed += 1;
    });
    return removed ? { state: { ...state, gameHistory: next }, changed: true, removed } : { state, changed: false, removed: 0 };
  }

  function dedupeSameDayGeneratedSlateState(state, dateKeyStr) {
    let next = state || {};
    let changed = false;
    let removedMatchups = 0;
    let removedGameHistory = 0;
    const m = dedupeSameDayMatchups(next, dateKeyStr);
    if (m.changed) { next = m.state; changed = true; removedMatchups += m.removed; }
    const g = dedupeSameDayGameHistory(next, dateKeyStr);
    if (g.changed) { next = g.state; changed = true; removedGameHistory += g.removed; }
    if (Array.isArray(next.schedule)) {
      const schedule = next.schedule.map((day) => {
        if (getScheduleDayDateKey(day) !== String(dateKeyStr).slice(0, 10) || !Array.isArray(day?.matchups)) return day;
        const seen = new Map();
        const rows = [];
        day.matchups.forEach((row) => {
          const compact = compactScheduleMatchupRow(row);
          const id = matchupStableIdentity(compact, dateKeyStr);
          if (!id || !seen.has(id)) { if (id) seen.set(id, rows.length); rows.push(compact); return; }
          rows[seen.get(id)] = compactScheduleMatchupRow(mergePreferredMatchupRow(rows[seen.get(id)], compact));
        });
        return { ...day, matchups: rows };
      });
      if (JSON.stringify(schedule) !== JSON.stringify(next.schedule)) { next = { ...next, schedule }; changed = true; }
    }
    return { state: next, changed, removedMatchups, removedGameHistory };
  }

  function normalizeMaterializedSeasonMatchup(matchup, dateKeyStr) {
    const seriesId = matchup.seriesId || matchup.seasonSeriesId || '';
    const gameNumber = Number(matchup.seriesGameNumber || matchup.gameNumber) || 1;
    const id = matchup.id || matchup.matchupId || `${dateKeyStr}_${seriesId || `${matchup.playerAId}_${matchup.playerBId}`}_g${gameNumber}`;
    const roundName = matchup.roundName || getSeasonDisplayName(matchup.roundId) || matchup.roundId || 'Season';
    return {
      ...matchup,
      id,
      matchupId: matchup.matchupId || id,
      date: dateKeyStr,
      dateKey: dateKeyStr,
      seasonSeriesId: matchup.seasonSeriesId || seriesId,
      seriesId,
      roundName,
      matchupType: String(matchup.matchupType || 'tournament').toLowerCase() === 'season' ? 'season' : 'tournament',
      seriesGameNumber: gameNumber,
      gameNumber,
      seasonMatchupLabel: matchup.seasonMatchupLabel || `${roundName}, Game ${gameNumber}`
    };
  }

  function mergeMaterializedSeasonMatchup(existing, next) {
    if (!existing) return next;
    const scored = matchupHasRecordedScoreOrResult(existing);
    const merged = { ...existing };
    ['id','matchupId','date','dateKey','playerAId','playerBId','playerAName','playerBName','seasonId','seriesId','seasonSeriesId','roundId','roundName','matchupType','seriesGameNumber','gameNumber','bestOf','winsNeeded','seasonMatchupLabel'].forEach((key) => {
      if (next[key] !== undefined && next[key] !== null && next[key] !== '') merged[key] = next[key];
    });
    if (!scored) {
      ['scoreA','scoreB','playerAScore','playerBScore','result','winnerId','completedAtISO','diff'].forEach((key) => {
        if (next[key] !== undefined) merged[key] = next[key];
      });
    }
    return merged;
  }

  function chooseUserMatchupForDate(state, dateKeyStr, userId = 'YOU', options = {}) {
    const normalized = options.normalized ? (state || {}) : normalizeState(state || {});
    return (Array.isArray(normalized.matchups) ? normalized.matchups : [])
      .filter((matchup) => getStoredMatchupDateKey(matchup) === dateKeyStr && (matchup.playerAId === userId || matchup.playerBId === userId))
      .sort((a, b) => {
        const ap = isSeasonTournamentMatchup(a) ? 0 : String(a?.matchupType || '').toLowerCase() === 'exhibition' ? 2 : 1;
        const bp = isSeasonTournamentMatchup(b) ? 0 : String(b?.matchupType || '').toLowerCase() === 'exhibition' ? 2 : 1;
        if (ap !== bp) return ap - bp;
        return String(a.id || a.matchupId || '').localeCompare(String(b.id || b.matchupId || ''));
      })[0] || null;
  }

  function collectReferencedSeasonResultMatchupIds(season) {
    const ids = new Set();
    const seriesList = Array.isArray(season?.series) ? season.series : Object.values(season?.series || {});
    seriesList.forEach((series) => {
      (Array.isArray(series?.gameResults) ? series.gameResults : []).forEach((result) => {
        const id = String(result?.matchupId || result?.id || '').trim();
        if (id) ids.add(id);
      });
    });
    return ids;
  }

  function getSameDayPlayerScoreFromHistory(state, dateKeyStr, playerId) {
    const row = (Array.isArray(state?.gameHistory) ? state.gameHistory : []).find((entry) => {
      const entryDate = String(entry?.dateKey || entry?.date || (entry?.dateISO ? dateKey(entry.dateISO) : '') || '').slice(0, 10);
      return entryDate === dateKeyStr && String(entry?.playerId || '') === String(playerId || '');
    });
    const score = Number(row?.score ?? row?.points ?? row?.total);
    return Number.isFinite(score) ? score : null;
  }

  function ensureSameDayGameHistoryScore(state, dateKeyStr, playerId, score, options = {}) {
    const numeric = Number(score);
    if (!playerId || playerId === 'YOU' || !Number.isFinite(numeric)) return { state, changed: false };
    const gameHistory = Array.isArray(state?.gameHistory) ? state.gameHistory.slice() : [];
    const index = gameHistory.findIndex((entry) => {
      const entryDate = String(entry?.dateKey || entry?.date || (entry?.dateISO ? dateKey(entry.dateISO) : '') || '').slice(0, 10);
      return entryDate === dateKeyStr && String(entry?.playerId || '') === String(playerId);
    });
    if (index >= 0) return { state, changed: false };
    gameHistory.push({
      date: dateKeyStr,
      dateKey: dateKeyStr,
      playerId: String(playerId),
      score: Math.round(numeric * 10) / 10,
      source: options.source || 'season-materialization'
    });
    return { state: { ...state, gameHistory }, changed: true };
  }

  function materializeSeasonSlateMatchupsForDate(state, dateKeyStr, options = {}) {
    let normalized = normalizeState(state || {});
    const key = String(dateKeyStr || '').slice(0, 10);
    if (!key || typeof buildSeasonDailySlate !== 'function') return { state: normalized, changed: false, materializedCount: 0, removedExhibitionCount: 0, removedStaleSeasonCount: 0 };
    const initialReferencedIds = collectReferencedSeasonResultMatchupIds(normalized.currentSeason);
    const slate = buildSeasonDailySlate(normalized, key, options);
    if (slate?.updatedSeason) normalized = normalizeState({ ...normalized, currentSeason: slate.updatedSeason, latestSeasonId: slate.updatedSeason.id || normalized.latestSeasonId || '' });

    const slateRows = Array.isArray(slate?.allMatchups) && slate.allMatchups.length
      ? slate.allMatchups
      : (Array.isArray(slate?.tournamentMatchups) ? slate.tournamentMatchups : []);
    const expectedRows = slateRows
      .map((matchup) => String(matchup?.matchupType || '').toLowerCase() === 'exhibition'
        ? { ...matchup, id: matchup.id || matchup.matchupId, matchupId: matchup.matchupId || matchup.id, date: key, dateKey: key }
        : normalizeMaterializedSeasonMatchup(matchup, key))
      .filter((m) => m && m.id && m.playerAId && m.playerBId);
    if (!expectedRows.length) return { state: normalized, changed: Boolean(slate?.updatedSeason), materializedCount: 0, removedExhibitionCount: 0, removedStaleSeasonCount: 0 };

    const seasonId = String(normalized.currentSeason?.id || slate.updatedSeason?.id || '');
    const expectedIds = new Set();
    const expectedSeriesIds = new Set();
    const tournamentPlayers = new Set();
    expectedRows.forEach((m) => {
      expectedIds.add(String(m.id));
      if (m.matchupId) expectedIds.add(String(m.matchupId));
      if (m.seriesId || m.seasonSeriesId) expectedSeriesIds.add(String(m.seriesId || m.seasonSeriesId));
      if (isSeasonTournamentMatchup(m)) { tournamentPlayers.add(String(m.playerAId)); tournamentPlayers.add(String(m.playerBId)); }
    });
    const referencedIds = collectReferencedSeasonResultMatchupIds(normalized.currentSeason);
    initialReferencedIds.forEach((id) => referencedIds.add(id));
    const playerById = new Map((Array.isArray(normalized.players) ? normalized.players : []).map((player) => [String(player?.id || player?.playerId || ''), player]));
    const youTotals = youDailyTotalsWithInertia(normalized);
    let changed = Boolean(slate?.updatedSeason);
    let historyChanged = false;

    const filledRows = expectedRows.map((row) => {
      const next = { ...row };
      ['A', 'B'].forEach((side) => {
        const playerId = String(next[`player${side}Id`] || '');
        const scoreKey = `score${side}`;
        if (Number.isFinite(Number(next[scoreKey]))) return;
        if (playerId === 'YOU') {
          const youScore = Number(youTotals[key]);
          if (Number.isFinite(youScore)) next[scoreKey] = youScore;
          return;
        }
        const historyScore = getSameDayPlayerScoreFromHistory(normalized, key, playerId);
        if (Number.isFinite(historyScore)) {
          next[scoreKey] = historyScore;
          return;
        }
        const simulated = simulateAiScoreForPlayerCore(playerById.get(playerId), key, { state: normalized, context: { matchup: next, source: 'season-materialization' } });
        if (Number.isFinite(Number(simulated))) {
          next[scoreKey] = Number(simulated);
          const ensured = ensureSameDayGameHistoryScore(normalized, key, playerId, next[scoreKey]);
          if (ensured.changed) { normalized = normalizeState(ensured.state); historyChanged = true; changed = true; }
        }
      });
      return next;
    });

    let removedExhibitionCount = 0;
    let removedStaleSeasonCount = 0;
    const nextMatchups = [];
    const byId = new Map();
    (Array.isArray(normalized.matchups) ? normalized.matchups : []).forEach((existing) => {
      const sameDay = getStoredMatchupDateKey(existing) === key;
      const id = String(existing?.id || existing?.matchupId || '');
      const seriesId = String(existing?.seriesId || existing?.seasonSeriesId || '');
      const type = String(existing?.matchupType || '').toLowerCase();
      const expected = expectedIds.has(id) || (seriesId && expectedSeriesIds.has(seriesId));
      const referenced = referencedIds.has(id) || referencedIds.has(String(existing?.matchupId || ''));
      const seasonLooking = type === 'tournament' || type === 'season' || Boolean(seriesId) || (seasonId && id.includes(`${seasonId}_`));
      if (sameDay && seasonLooking && !expected && !referenced) { removedStaleSeasonCount += 1; changed = true; return; }
      if (sameDay && type === 'exhibition') {
        const hasTournamentPlayer = tournamentPlayers.has(String(existing.playerAId || '')) || tournamentPlayers.has(String(existing.playerBId || ''));
        if (!expected || hasTournamentPlayer) { removedExhibitionCount += 1; changed = true; return; }
      }
      byId.set(id, nextMatchups.length);
      if (existing?.matchupId) byId.set(String(existing.matchupId), nextMatchups.length);
      nextMatchups.push(existing);
    });

    let materializedCount = 0;
    filledRows.forEach((next) => {
      let index = [next.id, next.matchupId].filter(Boolean).map(String).map((id) => byId.get(id)).find((idx) => idx !== undefined);
      if (index === undefined && (next.seriesId || next.seasonSeriesId)) {
        const sid = String(next.seriesId || next.seasonSeriesId);
        index = nextMatchups.findIndex((existing) => getStoredMatchupDateKey(existing) === key && String(existing?.seriesId || existing?.seasonSeriesId || '') === sid);
      }
      if (index >= 0) {
        const merged = isSeasonTournamentMatchup(next) ? mergeMaterializedSeasonMatchup(nextMatchups[index], next) : { ...nextMatchups[index], ...next, scoreA: Number.isFinite(Number(nextMatchups[index].scoreA)) ? nextMatchups[index].scoreA : next.scoreA, scoreB: Number.isFinite(Number(nextMatchups[index].scoreB)) ? nextMatchups[index].scoreB : next.scoreB };
        if (JSON.stringify(merged) !== JSON.stringify(nextMatchups[index])) changed = true;
        nextMatchups[index] = merged;
      } else { nextMatchups.push(next); materializedCount += 1; changed = true; }
    });

    const sameDayById = new Map(nextMatchups.filter((m) => getStoredMatchupDateKey(m) === key).map((m) => [String(m.id || m.matchupId || ''), m]));
    const scheduleRows = filledRows.map((row) => compactScheduleMatchupRow(sameDayById.get(String(row.id || row.matchupId || '')) || row));
    const schedule = Array.isArray(normalized.schedule) ? normalized.schedule.slice() : [];
    let dayIndex = schedule.findIndex((day) => getScheduleDayDateKey(day) === key);
    const previousDay = dayIndex >= 0 ? schedule[dayIndex] : { date: key, dateKey: key };
    const upsertDay = { ...previousDay, date: key, dateKey: key, matchups: scheduleRows, byeIds: [], seasonMatchupControl: true, seasonScheduleSignature: getSeasonScheduleSignature(normalized, key), seasonWarnings: slate.warnings || previousDay.seasonWarnings || [] };
    if (dayIndex >= 0) schedule[dayIndex] = upsertDay; else schedule.push(upsertDay);
    if (changed || historyChanged || JSON.stringify(schedule) !== JSON.stringify(normalized.schedule || [])) {
      normalized = normalizeState({ ...normalized, matchups: nextMatchups, schedule });
      changed = true;
    }
    const deduped = dedupeSameDayGeneratedSlateState(normalized, key);
    if (deduped.changed) {
      normalized = normalizeState(deduped.state);
      changed = true;
    }
    return { state: normalized, changed, materializedCount, removedExhibitionCount, removedStaleSeasonCount, removedDuplicateMatchups: deduped.removedMatchups || 0, removedDuplicateGameHistory: deduped.removedGameHistory || 0, warnings: slate.warnings || [], errors: slate.errors || [] };
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
    const countedGameResults = [];
    (Array.isArray(series.gameResults) ? series.gameResults : []).forEach((result) => {
      if (winsA >= winsNeeded || winsB >= winsNeeded) return;
      const normalized = normalizeSeasonResultWinnerForSeries(result, series).record;
      if (normalized?.winnerId === series.playerAId) {
        winsA += 1;
        countedGameResults.push(normalized);
      } else if (normalized?.winnerId === series.playerBId) {
        winsB += 1;
        countedGameResults.push(normalized);
      }
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
      gameResults: countedGameResults,
      updatedAtISO: seasonNowISO(options)
    };
  }

  function repairSeasonSeriesResultWinnerIds(state, options = {}) {
    const normalized = normalizeState(state || {});
    const repairSeason = (season) => {
      const fixed = normalizeSeasonState(season);
      if (!fixed) return { season: fixed, changed: false, repairedCount: 0, seriesIds: [] };
      const nextSeries = { ...(fixed.series || {}) };
      let changed = false;
      let repairedCount = 0;
      const seriesIds = [];

      Object.entries(nextSeries).forEach(([seriesId, series]) => {
        if (!series || !Array.isArray(series.gameResults) || !series.gameResults.length) return;
        let seriesChanged = false;
        const normalizedResults = series.gameResults.map((result) => {
          const normalizedWinner = normalizeSeasonResultWinnerForSeries(result, series);
          if (normalizedWinner.changed) {
            repairedCount += 1;
            seriesChanged = true;
          }
          return normalizedWinner.record;
        });
        const recalculated = recalculateSeasonSeriesFromGameResults({ ...series, gameResults: normalizedResults }, options);
        if (seriesChanged || JSON.stringify(recalculated) !== JSON.stringify(series)) {
          nextSeries[seriesId] = recalculated;
          if (!seriesIds.includes(seriesId)) seriesIds.push(seriesId);
          changed = true;
        }
      });

      return {
        season: changed ? normalizeSeasonState({ ...fixed, series: nextSeries, updatedAtISO: seasonNowISO(options) }) : fixed,
        changed,
        repairedCount,
        seriesIds
      };
    };

    const currentRepair = repairSeason(normalized.currentSeason);
    const historyRepairs = normalizeSeasonHistory(normalized.seasonHistory).map(repairSeason);
    const historyChanged = historyRepairs.some((repair) => repair.changed);
    const changed = currentRepair.changed || historyChanged;
    const repairedCount = currentRepair.repairedCount + historyRepairs.reduce((sum, repair) => sum + repair.repairedCount, 0);
    const seriesIds = Array.from(new Set(currentRepair.seriesIds.concat(...historyRepairs.map((repair) => repair.seriesIds))));
    const nextState = changed
      ? normalizeState({
          ...normalized,
          currentSeason: currentRepair.season,
          seasonHistory: historyRepairs.map((repair) => repair.season).filter(Boolean)
        })
      : normalized;
    return { ok: true, state: nextState, changed, repairedCount, seriesIds };
  }

  function isLateBoundRoundOf32PlayInSeries(series) {
    if (!series || series.roundId !== 'round_of_32') return false;
    const index = Number(series.seriesIndex);
    if (index === 1 || index === 9) return true;
    const placeholderText = `${series.placeholderA || ''} ${series.placeholderB || ''}`.toLowerCase();
    if (placeholderText.includes('play-in') || placeholderText.includes('play in')) return true;
    return Number(series.playerASeed) === 1 || Number(series.playerBSeed) === 1 || Number(series.playerASeed) === 2 || Number(series.playerBSeed) === 2;
  }

  function getSeasonRoundPlayedDatesBefore(roundId, todayDateKey) {
    const round = JUNE_2026_SEASON_DATE_WINDOWS.find((item) => item.id === roundId);
    if (!round || !todayDateKey || todayDateKey <= round.startDate) return [];
    const endExclusive = todayDateKey <= round.endDate ? todayDateKey : adjacentLocalDateKey(round.endDate, 1);
    const dates = [];
    let current = round.startDate;
    while (current && current < endExclusive && current <= round.endDate) {
      dates.push(current);
      current = adjacentLocalDateKey(current, 1);
    }
    return dates;
  }

  function stableCatchUpResultId(seasonId, seriesId, dateKeyStr) {
    return `${seasonId || 'season'}_${seriesId || 'series'}_catchup_${String(dateKeyStr || '').replace(/-/g, '_')}`;
  }

  function getSafeSeasonTournamentEvidenceRecord(state, season, series, record, options = {}) {
    if (!record || !season || !series) return null;

    const recordDate = getRecordedResultDateKey(record) || options.dateKey || '';
    if (!recordDate || !isDateWithinSeasonBounds(season, recordDate)) return null;

    if (options.includeCurrentDayResults !== true) {
      const today = options.todayDateKey || options.dateKeyToday || dateKey(options.nowISO || new Date());
      if (today && today !== 'invalid' && recordDate >= today) return null;
    }

    if (!record.playerAId || !record.playerBId || !series.playerAId || !series.playerBId) return null;
    const pairKey = getPairingKey(record.playerAId, record.playerBId);
    if (!pairKey || pairKey !== getPairingKey(series.playerAId, series.playerBId)) return null;

    const winner = getSeasonResultWinnerForSeries(record, series);
    if (!winner.winnerId || (winner.winnerId !== series.playerAId && winner.winnerId !== series.playerBId)) return null;

    const type = String(record.matchupType || '').toLowerCase();
    const explicitSeriesId = getRecordedSeriesId(record);

    if (type === 'exhibition' && explicitSeriesId !== series.id) return null;
    if (type && type !== 'tournament' && type !== 'season' && explicitSeriesId !== series.id) return null;

    if (explicitSeriesId) {
      if (explicitSeriesId !== series.id) return null;
      const explicitRecord = {
        ...record,
        seriesId: series.id,
        seasonSeriesId: series.id,
        matchupType: type === 'exhibition' ? 'tournament' : (record.matchupType || 'tournament')
      };
      if (!isValidSeasonResultDateForSeries(season, series, explicitRecord, options)) return null;
      return withInferredSeasonMatchupMetadata(state, season, explicitRecord, options);
    }

    const repaired = withInferredSeasonMatchupMetadata(state, season, record, options);
    if (getRecordedSeriesId(repaired) === series.id && isValidSeasonResultDateForSeries(season, series, repaired, options)) {
      return repaired;
    }

    if (type === 'tournament' || type === 'season' || hasStrippedSeasonTournamentEvidence(state, season, record, series, options)) {
      const decorated = {
        ...record,
        seasonId: season.id || record.seasonId || '',
        seriesId: series.id,
        seasonSeriesId: series.id,
        roundId: series.roundId || record.roundId || '',
        roundName: series.roundName || record.roundName || getSeasonDisplayName(series.roundId) || '',
        matchupType: type || 'tournament',
        bestOf: series.bestOf || record.bestOf || null,
        winsNeeded: series.winsNeeded || record.winsNeeded || getSeasonSeriesWinsNeeded(series)
      };
      if (!isValidSeasonResultDateForSeries(season, series, decorated, options)) return null;
      return decorated;
    }

    return null;
  }

  function findRecordedTournamentResultForSeriesDate(state, season, series, dateKeyStr, options = {}) {
    const records = [];

    if (Array.isArray(state?.matchups)) records.push(...state.matchups);
    if (Array.isArray(state?.gameHistory)) records.push(...state.gameHistory);

    const daily = season?.dailyTournamentResults;
    if (Array.isArray(daily)) {
      records.push(...daily);
    } else if (daily && typeof daily === 'object') {
      Object.entries(daily).forEach(([key, value]) => {
        const decorate = (entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          if (!season?.series?.[key] || getRecordedSeriesId(entry)) return entry;
          return { ...entry, seriesId: key, seasonSeriesId: key };
        };
        if (Array.isArray(value)) records.push(...value.map(decorate));
        else if (value && typeof value === 'object') records.push(decorate(value));
      });
    }

    for (const record of records) {
      if (!record || getRecordedResultDateKey(record) !== dateKeyStr) continue;
      const safe = getSafeSeasonTournamentEvidenceRecord(state, season, series, record, {
        ...options,
        dateKey: dateKeyStr
      });
      if (safe) return safe;
    }

    return null;
  }

  function buildDeterministicCatchUpWinner(series, dateKeyStr, gameNumber) {
    const seedA = Number.isFinite(Number(series.playerASeed)) ? Number(series.playerASeed) : 99;
    const seedB = Number.isFinite(Number(series.playerBSeed)) ? Number(series.playerBSeed) : 99;
    const text = `${series.id}|${dateKeyStr}|${gameNumber}|${series.playerAId}|${series.playerBId}`;
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
    const seedBiasA = Math.max(0, seedB - seedA);
    const seedBiasB = Math.max(0, seedA - seedB);
    const ratingA = 50 + seedBiasA * 2 + (hash % 17);
    const ratingB = 50 + seedBiasB * 2 + ((hash >>> 5) % 17);
    const aWins = ratingA >= ratingB;
    const winnerId = aWins ? series.playerAId : series.playerBId;
    return {
      winnerId,
      loserId: aWins ? series.playerBId : series.playerAId,
      playerAScore: Number((aWins ? Math.max(ratingA, ratingB + 1) : ratingA).toFixed(1)),
      playerBScore: Number((aWins ? ratingB : Math.max(ratingB, ratingA + 1)).toFixed(1))
    };
  }

  function buildLateBoundCatchUpGameResult(state, season, series, dateKeyStr, gameNumber, options = {}) {
    const recorded = findRecordedTournamentResultForSeriesDate(state, season, series, dateKeyStr, options);
    const winner = recorded ? getSeasonResultWinnerForSeries(recorded, series) : buildDeterministicCatchUpWinner(series, dateKeyStr, gameNumber);
    const matchupId = recorded?.id || recorded?.matchupId || stableCatchUpResultId(season?.id || series.seasonId, series.id, dateKeyStr);
    const now = seasonNowISO(options);
    return {
      id: stableCatchUpResultId(season?.id || series.seasonId, series.id, dateKeyStr),
      seasonId: season?.id || series.seasonId || '',
      seriesId: series.id,
      seasonSeriesId: series.id,
      roundId: series.roundId,
      gameNumber,
      dateKey: dateKeyStr,
      matchupType: 'tournament',
      matchupId,
      playerAId: series.playerAId,
      playerBId: series.playerBId,
      winnerId: winner.winnerId,
      loserId: winner.loserId || (winner.winnerId === series.playerAId ? series.playerBId : series.playerAId),
      playerAScore: winner.playerAScore,
      playerBScore: winner.playerBScore,
      source: 'admin_catch_up',
      manualResult: true,
      catchUpResult: true,
      lateBoundSeriesCatchUp: true,
      recordedAtISO: recorded?.recordedAtISO || recorded?.completedAtISO || now,
      updatedAtISO: now
    };
  }

  function normalizeSeasonSeriesGameResultOrder(results) {
    return (Array.isArray(results) ? results : [])
      .slice()
      .sort((a, b) => {
        const dateCompare = String(getRecordedResultDateKey(a) || a?._sortKey || '').localeCompare(String(getRecordedResultDateKey(b) || b?._sortKey || ''));
        if (dateCompare !== 0) return dateCompare;
        const aGame = Number(a?.gameNumber || a?.seriesGameNumber || a?.game);
        const bGame = Number(b?.gameNumber || b?.seriesGameNumber || b?.game);
        if (Number.isFinite(aGame) && Number.isFinite(bGame) && aGame !== bGame) return aGame - bGame;
        return String(a?.matchupId || a?.id || '').localeCompare(String(b?.matchupId || b?.id || ''));
      })
      .map((result, index) => ({
        ...result,
        gameNumber: index + 1,
        seriesGameNumber: index + 1,
        game: index + 1
      }));
  }

  function backfillLateBoundSeasonSeriesResults(state, seasonArg, options = {}) {
    const normalizedState = normalizeState(state || {});
    let season = normalizeSeasonState(seasonArg || normalizedState.currentSeason);
    if (!season) return { ok: false, state: normalizedState, season, updatedSeason: season, changed: false, backfilledCount: 0, seriesIds: [], errors: ['No current season.'] };
    const today = options.dateKey || (options.nowISO ? dateKey(options.nowISO) : dateKey(new Date()));
    const missedDates = getSeasonRoundPlayedDatesBefore('round_of_32', today);
    if (!missedDates.length) return { ok: true, state: normalizedState, season, updatedSeason: season, changed: false, backfilledCount: 0, seriesIds: [] };
    const nextSeries = { ...(season.series || {}) };
    const changedSeriesIds = [];
    let backfilledCount = 0;
    Object.entries(season.series || {}).forEach(([seriesId, series]) => {
      if (!series || series.roundId !== 'round_of_32') return;
      if (!isLateBoundRoundOf32PlayInSeries(series)) return;
      if (!series.playerAId || !series.playerBId || isSeasonSeriesComplete(series)) return;
      const existingResults = Array.isArray(series.gameResults) ? series.gameResults.slice() : [];
      const additions = [];
      missedDates.forEach((missedDate, index) => {
        const stableId = stableCatchUpResultId(season?.id || series.seasonId, series.id, missedDate);
        const alreadyHasDate = existingResults.some((result) => getRecordedResultDateKey(result) === missedDate);
        const alreadyHasStableId = existingResults.some((result) => result?.id === stableId || result?.matchupId === stableId || result?.gameId === stableId || result?.completionId === stableId);
        if (alreadyHasDate || alreadyHasStableId) return;
        additions.push(buildLateBoundCatchUpGameResult(normalizedState, season, series, missedDate, index + 1, options));
      });
      if (!additions.length) return;
      const orderedResults = normalizeSeasonSeriesGameResultOrder(existingResults.concat(additions));
      const repaired = rebuildSeasonSeriesFromRecordedResults(series, orderedResults, options);
      nextSeries[seriesId] = repaired;
      changedSeriesIds.push(seriesId);
      backfilledCount += additions.length;
    });
    if (!backfilledCount) return { ok: true, state: normalizedState, season, updatedSeason: season, changed: false, backfilledCount: 0, seriesIds: [] };
    season = normalizeSeasonState({ ...season, series: nextSeries, updatedAtISO: seasonNowISO(options) });
    const nextState = normalizeState({ ...normalizedState, currentSeason: season, latestSeasonId: season.id || normalizedState.latestSeasonId || '' });
    return { ok: true, state: nextState, season, updatedSeason: season, changed: true, backfilledCount, seriesIds: changedSeriesIds };
  }


  function buildRoundAlignmentRepairGameResult(state, season, series, dateKeyStr, gameNumber, options = {}) {
    const recorded = findRecordedTournamentResultForSeriesDate(state, season, series, dateKeyStr, options);
    const winner = recorded ? getSeasonResultWinnerForSeries(recorded, series) : buildDeterministicCatchUpWinner(series, dateKeyStr, gameNumber);
    const now = seasonNowISO(options);
    if (recorded) {
      return {
        id: recorded.id || recorded.matchupId || stableCatchUpResultId(season?.id || series.seasonId, series.id, dateKeyStr),
        matchupId: recorded.matchupId || recorded.id || '',
        seasonId: season?.id || series.seasonId || recorded.seasonId || '',
        seriesId: series.id,
        seasonSeriesId: series.id,
        roundId: series.roundId,
        gameNumber,
        seriesGameNumber: gameNumber,
        game: gameNumber,
        dateKey: dateKeyStr,
        matchupType: 'tournament',
        playerAId: series.playerAId,
        playerBId: series.playerBId,
        winnerId: winner.winnerId,
        loserId: winner.loserId || (winner.winnerId === series.playerAId ? series.playerBId : series.playerAId),
        playerAScore: winner.playerAScore,
        playerBScore: winner.playerBScore,
        source: 'matchup',
        recordedAtISO: recorded.recordedAtISO || recorded.completedAtISO || now,
        updatedAtISO: now
      };
    }
    return {
      ...buildLateBoundCatchUpGameResult(state, season, series, dateKeyStr, gameNumber, options),
      seriesGameNumber: gameNumber,
      game: gameNumber,
      roundAlignmentRepair: true
    };
  }

  function repairCurrentRoundSeriesGameAlignment(state, options = {}) {
    const normalizedState = normalizeState(state || {});
    let season = normalizeSeasonState(options.season || normalizedState.currentSeason);
    if (!season) return { ok: false, state: normalizedState, season, updatedSeason: season, changed: false, repairedCount: 0, seriesIds: [], errors: ['No current season.'], warnings: [] };
    const today = options.dateKey || (options.nowISO ? dateKey(options.nowISO) : dateKey(new Date()));
    const roundId = options.roundId || getCurrentSeasonRoundIdForDate(today);
    const warnings = [];
    if (!roundId) return { ok: false, state: normalizedState, season, updatedSeason: season, changed: false, repairedCount: 0, seriesIds: [], errors: ['No current round for repair date.'], warnings };
    const roundSeries = Object.values(season.series || {}).filter((series) => series?.roundId === roundId && series.playerAId && series.playerBId);
    if (!roundSeries.length) return { ok: true, state: normalizedState, season, updatedSeason: season, changed: false, repairedCount: 0, seriesIds: [], warnings };

    const recordedEvidenceDates = [];
    const addRecordedEvidenceDates = (records) => {
      (Array.isArray(records) ? records : []).forEach((record) => {
        const resultDate = getRecordedResultDateKey(record);
        if (!resultDate || resultDate >= today) return;

        const explicitSeriesId = getRecordedSeriesId(record);
        const seriesForWinner = explicitSeriesId ? roundSeries.find((item) => item?.id === explicitSeriesId) : null;
        const winner = seriesForWinner ? getSeasonResultWinnerForSeries(record, seriesForWinner) : getRecordedResultWinner(record);
        if (!winner.winnerId) return;

        if (explicitSeriesId) {
          const series = roundSeries.find((item) => item?.id === explicitSeriesId);
          if (!series) return;
          const safeRecord = getSafeSeasonTournamentEvidenceRecord(normalizedState, season, series, record, { ...options, dateKey: resultDate });
          if (safeRecord) recordedEvidenceDates.push(resultDate);
          return;
        }

        const safeMatches = roundSeries
          .map((series) => getSafeSeasonTournamentEvidenceRecord(normalizedState, season, series, record, { ...options, dateKey: resultDate }))
          .filter(Boolean);

        if (safeMatches.length === 1) recordedEvidenceDates.push(resultDate);
      });
    };

    addRecordedEvidenceDates(normalizedState.matchups);
    addRecordedEvidenceDates(normalizedState.gameHistory);

    const daily = season?.dailyTournamentResults;
    if (Array.isArray(daily)) {
      addRecordedEvidenceDates(daily);
    } else if (daily && typeof daily === 'object') {
      Object.entries(daily).forEach(([key, value]) => {
        const decorate = (entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          if (!season?.series?.[key] || getRecordedSeriesId(entry)) return entry;
          return { ...entry, seriesId: key, seasonSeriesId: key };
        };

        if (Array.isArray(value)) addRecordedEvidenceDates(value.map(decorate));
        else if (value && typeof value === 'object') addRecordedEvidenceDates([decorate(value)]);
      });
    }

    const earliestStartedDate = roundSeries
      .flatMap((series) => (Array.isArray(series.gameResults) ? series.gameResults : []).map((result) => getRecordedResultDateKey(result)).filter(Boolean))
      .concat(recordedEvidenceDates)
      .sort()[0] || getSeasonRoundActualStartDateKey(season, roundId) || today;
    const targetGameNumber = Math.max(1, (daysBetweenDateKeys(earliestStartedDate, today) || 0) + 1);
    const missingGameCount = Math.max(0, targetGameNumber - 1);
    if (!missingGameCount) return { ok: true, state: normalizedState, season, updatedSeason: season, changed: false, repairedCount: 0, seriesIds: [], warnings };

    const repairDates = [];
    let cursor = earliestStartedDate;
    while (cursor && cursor < today && repairDates.length < missingGameCount) {
      repairDates.push(cursor);
      cursor = adjacentLocalDateKey(cursor, 1);
    }

    const nextSeries = { ...(season.series || {}) };
    const changedSeriesIds = [];
    let repairedCount = 0;
    roundSeries.forEach((series) => {
      if (!series || isSeasonSeriesComplete(series)) return;
      const existingResults = Array.isArray(series.gameResults) ? series.gameResults.slice() : [];
      const additions = [];
      repairDates.forEach((repairDate, index) => {
        const gameNumber = index + 1;
        const stableId = stableCatchUpResultId(season?.id || series.seasonId, series.id, repairDate);
        const alreadyHasDate = existingResults.concat(additions).some((result) => getRecordedResultDateKey(result) === repairDate);
        const alreadyHasGame = existingResults.concat(additions).some((result) => Number(result?.gameNumber || result?.seriesGameNumber || result?.game) === gameNumber);
        const alreadyHasStableId = existingResults.concat(additions).some((result) => result?.id === stableId || result?.matchupId === stableId || result?.gameId === stableId || result?.completionId === stableId);
        if (alreadyHasDate || alreadyHasGame || alreadyHasStableId) return;
        const recorded = findRecordedTournamentResultForSeriesDate(normalizedState, season, series, repairDate, options);
        if (options.requireRecordedResultForAlignment === true && !recorded) return;
        additions.push(buildRoundAlignmentRepairGameResult(normalizedState, season, series, repairDate, gameNumber, options));
      });
      if (!additions.length) return;
      const orderedResults = normalizeSeasonSeriesGameResultOrder(existingResults.concat(additions));
      const repaired = rebuildSeasonSeriesFromRecordedResults(series, orderedResults, options);
      nextSeries[series.id] = repaired;
      changedSeriesIds.push(series.id);
      repairedCount += additions.length;
    });

    const nextMeta = {
      ...(season.meta || {}),
      roundStartDateKeys: { ...(season.meta?.roundStartDateKeys || {}), [roundId]: earliestStartedDate }
    };
    const metaChanged = season.meta?.roundStartDateKeys?.[roundId] !== earliestStartedDate;
    if (!repairedCount && !metaChanged) return { ok: true, state: normalizedState, season, updatedSeason: season, changed: false, repairedCount: 0, seriesIds: [], warnings };
    season = normalizeSeasonState({ ...season, meta: nextMeta, series: nextSeries, updatedAtISO: seasonNowISO(options) });
    const nextState = normalizeState({ ...normalizedState, currentSeason: season, latestSeasonId: season.id || normalizedState.latestSeasonId || '' });
    warnings.push(`Aligned ${getSeasonDisplayName(roundId) || roundId} to round game ${targetGameNumber} using start date ${earliestStartedDate}.`);
    return { ok: true, state: nextState, season, updatedSeason: season, changed: true, repairedCount, seriesIds: changedSeriesIds, roundId, targetGameNumber, roundStartDateKey: earliestStartedDate, warnings };
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
    const winner = getSeasonResultWinnerForSeries(gameResult, series);
    if (winner.winnerId !== series.playerAId && winner.winnerId !== series.playerBId) return { ok: false, error: 'invalid_or_ambiguous_winner', season: nextSeason, series };
    const loserId = winner.loserId || (winner.winnerId === series.playerAId ? series.playerBId : series.playerAId);
    if (!loserId) return { ok: false, error: 'invalid_or_ambiguous_loser', season: nextSeason, series };
    const existing = results[existingIndex];
    if (seasonGameResultsEqual(existing, { ...gameResult, loserId })) {
      return { ok: true, changed: false, season: nextSeason, series, unchanged: true };
    }
    const beforeWinnerId = getSeasonSeriesWinner(series) || '';
    const replacement = {
      ...existing,
      dateKey: resultDateKey || existing.dateKey || '',
      matchupId: matchupId || existing.matchupId || '',
      winnerId: winner.winnerId,
      loserId,
      playerAScore: winner.playerAScore ?? gameResult.playerAScore,
      playerBScore: winner.playerBScore ?? gameResult.playerBScore,
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

  function getSeasonStartDateKey(season) {
    return season?.startDateKey || season?.startDate || '';
  }

  function getSeasonEndDateKey(season) {
    return season?.endDateKey || season?.endDate || '';
  }

  function isDateWithinSeasonBounds(season, dateKeyStr) {
    const date = String(dateKeyStr || '');
    const start = getSeasonStartDateKey(season);
    const end = getSeasonEndDateKey(season);
    return Boolean(date && start && end && date >= start && date <= end);
  }

  function isValidSeasonResultDateForSeries(season, series, raw, options = {}) {
    const date = getRecordedResultDateKey(raw) || options.dateKey || '';
    if (!date || !isDateWithinSeasonBounds(season, date)) return false;
    const type = String(raw?.matchupType || '').toLowerCase();
    if (type === 'exhibition') return false;

    const dateRound = getSeasonRoundForDate(date, season)?.id || '';
    if (!dateRound) return false;

    if (series?.roundId === dateRound) return true;

    const explicitSeriesId = getRecordedSeriesId(raw);
    const hasExplicitSeries = Boolean(explicitSeriesId && explicitSeriesId === series?.id);
    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(dateRound);
    const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series?.roundId);
    const isOverduePriorRound =
      currentRoundIndex >= 0
      && seriesRoundIndex >= 0
      && seriesRoundIndex < currentRoundIndex
      && series?.status === 'active'
      && !isSeasonSeriesComplete(series);

    return isOverduePriorRound && hasExplicitSeries && (type === 'tournament' || type === 'season');
  }

  function isRecordInSeasonControlledScheduleDay(state, record, dateKeyStr, seriesId) {
    const schedules = Array.isArray(state?.schedule) ? state.schedule : [];
    const recordIds = [record?.id, record?.matchupId, record?.gameId].map((id) => String(id || '')).filter(Boolean);
    if (!record?.playerAId || !record?.playerBId) return false;
    const recordPairKey = getPairingKey(record.playerAId, record.playerBId);
    const recordSeriesId = getRecordedSeriesId(record);
    return schedules.some((day) => {
      if (!day || getScheduleDayDateKey(day) !== dateKeyStr || day.seasonMatchupControl !== true) return false;
      return (Array.isArray(day.matchups) ? day.matchups : []).some((matchup) => {
        if (!matchup) return false;
        const matchupType = String(matchup.matchupType || '').toLowerCase();
        if (matchupType && matchupType !== 'tournament' && matchupType !== 'season') return false;
        if (getPairingKey(matchup.playerAId, matchup.playerBId) !== recordPairKey) return false;

        const scheduleSeasonId = String(matchup.seasonId || '').trim();
        const recordSeasonId = String(record?.seasonId || '').trim();
        if (scheduleSeasonId && recordSeasonId && scheduleSeasonId !== recordSeasonId) return false;

        const scheduleSeriesId = getRecordedSeriesId(matchup);
        if (seriesId && scheduleSeriesId && scheduleSeriesId !== seriesId) return false;
        if (recordSeriesId && scheduleSeriesId && scheduleSeriesId !== recordSeriesId) return false;

        const matchupIds = [matchup.id, matchup.matchupId, matchup.gameId].map((id) => String(id || '')).filter(Boolean);
        const idsOverlap = recordIds.length > 0 && matchupIds.some((id) => recordIds.includes(id));
        if (idsOverlap) return true;
        if (seriesId && scheduleSeriesId === seriesId) return true;
        return Boolean(recordSeriesId && scheduleSeriesId === recordSeriesId);
      });
    });
  }

  function hasStrippedSeasonTournamentEvidence(state, season, record, series, options = {}) {
    const type = String(record?.matchupType || '').toLowerCase();
    if (type === 'tournament' || type === 'season') return true;
    if (type) return false;
    const idText = [record?.id, record?.matchupId, record?.gameId].map((id) => String(id || '')).join(' ');
    if (series?.id && idText.includes(series.id)) return true;
    const date = getRecordedResultDateKey(record) || options.dateKey || '';
    return isRecordInSeasonControlledScheduleDay(state, record, date, series?.id || '');
  }

  function getValidSeasonSeriesForRecord(state, season, record, options = {}) {
    const explicitSeriesId = getRecordedSeriesId(record);
    if (explicitSeriesId && season?.series?.[explicitSeriesId]) {
      const series = season.series[explicitSeriesId];
      return isValidSeasonResultDateForSeries(season, series, record, options) ? series : null;
    }

    const inferredSeriesId = inferSeasonSeriesIdFromRecord(state, season, record, options);
    if (inferredSeriesId && season?.series?.[inferredSeriesId]) {
      const series = season.series[inferredSeriesId];
      return isValidSeasonResultDateForSeries(season, series, record, options) ? series : null;
    }

    return null;
  }

  function stripInvalidSeasonMetadataFromMatchup(matchup, season, state = {}, options = {}) {
    const type = String(matchup?.matchupType || '').toLowerCase();
    const hasSeasonMetadata =
      matchup?.seasonId === season?.id
      || Boolean(matchup?.seriesId)
      || Boolean(matchup?.seasonSeriesId)
      || Boolean(matchup?.seasonSeriesID)
      || Boolean(matchup?.seriesID)
      || Boolean(matchup?.roundId)
      || type === 'tournament'
      || type === 'season';

    if (!hasSeasonMetadata) return matchup;

    const validSeries = getValidSeasonSeriesForRecord(state, season, matchup, options);
    if (validSeries) return withInferredSeasonMatchupMetadata(state, season, matchup, options);

    const cleaned = { ...matchup };
    delete cleaned.seasonId;
    delete cleaned.seriesId;
    delete cleaned.seasonSeriesId;
    delete cleaned.seasonSeriesID;
    delete cleaned.seriesID;
    delete cleaned.roundId;
    delete cleaned.roundName;
    delete cleaned.seriesGameNumber;
    delete cleaned.bestOf;
    delete cleaned.winsNeeded;
    delete cleaned.seasonMatchupLabel;

    if (type === 'tournament' || type === 'season') delete cleaned.matchupType;

    return cleaned;
  }

  function inferSeasonSeriesIdFromRecord(state, season, record, options = {}) {
    const explicit = getRecordedSeriesId(record);
    if (explicit && season?.series?.[explicit]) {
      const explicitSeries = season.series[explicit];
      return isValidSeasonResultDateForSeries(season, explicitSeries, record, options) ? explicit : '';
    }
    if (!season?.series || !record?.playerAId || !record?.playerBId) return '';

    const recordDate = getRecordedResultDateKey(record) || options.dateKey || '';
    if (!recordDate || !isDateWithinSeasonBounds(season, recordDate)) return '';

    const type = String(record?.matchupType || '').toLowerCase();
    if (type === 'exhibition') return '';

    const pairKey = getPairingKey(record.playerAId, record.playerBId);
    const validPairMatches = Object.values(season.series || {}).filter((series) => {
      if (!series?.playerAId || !series?.playerBId) return false;
      if (getPairingKey(series.playerAId, series.playerBId) !== pairKey) return false;
      if (!isValidSeasonResultDateForSeries(season, series, record, options)) return false;
      if (!hasStrippedSeasonTournamentEvidence(state, season, record, series, options)) return false;
      return true;
    });

    return validPairMatches.length === 1 ? (validPairMatches[0].id || '') : '';
  }

  function withInferredSeasonMatchupMetadata(state, season, record, options = {}) {
    const type = String(record?.matchupType || '').toLowerCase();
    const explicitSeriesId = getRecordedSeriesId(record);
    const hasExplicitValidSeries = Boolean(explicitSeriesId && season?.series?.[explicitSeriesId]);
    if (type === 'exhibition' && !hasExplicitValidSeries) return record;

    const seriesId = inferSeasonSeriesIdFromRecord(state, season, record, options);
    if (!seriesId || !season?.series?.[seriesId]) return record;

    const series = season.series[seriesId];
    if (!isValidSeasonResultDateForSeries(season, series, record, options)) return record;

    const repaired = {
      ...record,
      seasonId: season.id || record?.seasonId || '',
      seriesId,
      seasonSeriesId: seriesId,
      roundId: series.roundId || record?.roundId || '',
      roundName: series.roundName || record?.roundName || getSeasonDisplayName(series.roundId) || '',
      matchupType: record?.matchupType || 'tournament',
      bestOf: series.bestOf || record?.bestOf || null,
      winsNeeded: series.winsNeeded || record?.winsNeeded || getSeasonSeriesWinsNeeded(series)
    };
    delete repaired.seriesID;
    delete repaired.seasonSeriesID;
    return repaired;
  }

  function toFiniteSeasonScore(value) {
    if (value == null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function firstFiniteSeasonScore(...values) {
    for (const value of values) {
      const score = toFiniteSeasonScore(value);
      if (score != null) return score;
    }
    return null;
  }

  function getCanonicalSeasonScorePair(record) {
    const result = record?.result || {};
    const scoreA = firstFiniteSeasonScore(record?.scoreA, result.scoreA);
    const scoreB = firstFiniteSeasonScore(record?.scoreB, result.scoreB);
    if (scoreA != null && scoreB != null) {
      return { playerAScore: scoreA, playerBScore: scoreB, source: 'scoreA_scoreB' };
    }

    const playerAScore = firstFiniteSeasonScore(record?.playerAScore, record?.aScore, record?.playerA?.score, result.playerAScore, result.aScore, result.playerA?.score);
    const playerBScore = firstFiniteSeasonScore(record?.playerBScore, record?.bScore, record?.playerB?.score, result.playerBScore, result.bScore, result.playerB?.score);
    return {
      playerAScore,
      playerBScore,
      source: playerAScore != null && playerBScore != null ? 'playerAScore_playerBScore' : 'incomplete'
    };
  }

  function getSeasonRecordScorePair(record) {
    const { playerAScore, playerBScore } = getCanonicalSeasonScorePair(record);
    return { playerAScore, playerBScore };
  }

  function getRecordedResultWinner(record) {
    let winnerId = String(record?.winnerId || record?.winningPlayerId || record?.winner?.playerId || record?.winner?.id || record?.result?.winnerId || record?.result?.winningPlayerId || record?.result?.winner?.playerId || record?.result?.winner?.id || '').trim();
    let loserId = String(record?.loserId || record?.losingPlayerId || record?.loser?.playerId || record?.loser?.id || record?.result?.loserId || record?.result?.losingPlayerId || record?.result?.loser?.playerId || record?.result?.loser?.id || '').trim();
    const { playerAScore, playerBScore } = getSeasonRecordScorePair(record);
    if (!winnerId && playerAScore != null && playerBScore != null && playerAScore !== playerBScore) {
      winnerId = playerAScore > playerBScore ? String(record?.playerAId || '').trim() : String(record?.playerBId || '').trim();
      loserId = playerAScore > playerBScore ? String(record?.playerBId || '').trim() : String(record?.playerAId || '').trim();
    }
    return {
      winnerId,
      loserId,
      playerAScore: playerAScore == null ? undefined : playerAScore,
      playerBScore: playerBScore == null ? undefined : playerBScore
    };
  }

  function getSeasonResultWinnerForSeries(record, series) {
    const rawScores = getSeasonRecordScorePair(record);
    let playerAScore = rawScores.playerAScore;
    let playerBScore = rawScores.playerBScore;
    if (!record || !series) return { winnerId: '', loserId: '', playerAScore, playerBScore, source: 'none' };

    const playerAId = String(series.playerAId || '').trim();
    const playerBId = String(series.playerBId || '').trim();
    const recordPlayerAId = String(record?.playerAId || record?.result?.playerAId || '').trim();
    const recordPlayerBId = String(record?.playerBId || record?.result?.playerBId || '').trim();
    if (recordPlayerAId && recordPlayerBId && playerAId && playerBId) {
      if (recordPlayerAId === playerBId && recordPlayerBId === playerAId) {
        playerAScore = rawScores.playerBScore;
        playerBScore = rawScores.playerAScore;
      } else if (recordPlayerAId !== playerAId || recordPlayerBId !== playerBId) {
        const scoreByPlayerId = new Map([[recordPlayerAId, rawScores.playerAScore], [recordPlayerBId, rawScores.playerBScore]]);
        if (scoreByPlayerId.has(playerAId)) playerAScore = scoreByPlayerId.get(playerAId);
        if (scoreByPlayerId.has(playerBId)) playerBScore = scoreByPlayerId.get(playerBId);
      }
    }

    if (playerAScore != null && playerBScore != null && playerAScore !== playerBScore && playerAId && playerBId) {
      const winnerId = playerAScore > playerBScore ? playerAId : playerBId;
      const loserId = playerAScore > playerBScore ? playerBId : playerAId;
      return { winnerId, loserId, playerAScore, playerBScore, source: 'scores' };
    }

    const fallback = getRecordedResultWinner(record);
    const winnerId = String(fallback.winnerId || '').trim();
    if (winnerId === playerAId || winnerId === playerBId) {
      return {
        winnerId,
        loserId: winnerId === playerAId ? playerBId : playerAId,
        playerAScore,
        playerBScore,
        source: 'winnerId'
      };
    }

    return { winnerId: '', loserId: '', playerAScore, playerBScore, source: 'none' };
  }

  function normalizeSeasonResultWinnerForSeries(record, series) {
    const winner = getSeasonResultWinnerForSeries(record, series);
    if (!winner.winnerId) return { record, winner, changed: false };
    const normalized = {
      ...record,
      winnerId: winner.winnerId,
      loserId: winner.loserId
    };
    if (winner.playerAScore != null) normalized.playerAScore = winner.playerAScore;
    if (winner.playerBScore != null) normalized.playerBScore = winner.playerBScore;
    return {
      record: normalized,
      winner,
      changed: String(record?.winnerId || '') !== winner.winnerId
        || String(record?.loserId || '') !== winner.loserId
        || (winner.playerAScore != null && Number(record?.playerAScore) !== winner.playerAScore)
        || (winner.playerBScore != null && Number(record?.playerBScore) !== winner.playerBScore)
    };
  }

  function getSeasonResultLogicalDedupeKey(record, seriesId) {
    const date = getRecordedResultDateKey(record);
    const gameNumber = record?.gameNumber || record?.seriesGameNumber || record?.game || '';
    const winnerId = record?.winnerId || record?.winningPlayerId || '';
    if (date && gameNumber && winnerId) return `game:${date}:${seriesId}:${gameNumber}:${winnerId}`;
    if (date && record?.playerAId && record?.playerBId && winnerId) return `pair:${date}:${getPairingKey(record.playerAId, record.playerBId)}:${winnerId}`;
    return '';
  }

  function getSeasonResultDedupeKey(record, seriesId, fallbackIndex = 0) {
    const directId = record?.matchupId || record?.gameId || record?.id || record?.completionId;
    if (directId) return `id:${directId}`;
    const logical = getSeasonResultLogicalDedupeKey(record, seriesId);
    if (logical) return logical;
    const date = getRecordedResultDateKey(record);
    const gameNumber = record?.gameNumber || record?.seriesGameNumber || record?.game || '';
    const winnerId = record?.winnerId || record?.winningPlayerId || '';
    const scoreA = record?.playerAScore ?? record?.scoreA ?? '';
    const scoreB = record?.playerBScore ?? record?.scoreB ?? '';
    if (date || gameNumber || winnerId) return `cmp:${date}:${seriesId}:${gameNumber}:${winnerId}:${scoreA}:${scoreB}`;
    return `fallback:${seriesId}:${fallbackIndex}`;
  }


  function getSeasonResultConflictDedupeKey(record, seriesId, fallbackIndex = 0) {
    const date = getRecordedResultDateKey(record) || record?.dateKey || '';
    const gameNumber = record?.gameNumber || record?.seriesGameNumber || record?.game || '';
    if (date && gameNumber) return `slot:${seriesId}:${date}:${gameNumber}`;
    if (date && record?.playerAId && record?.playerBId) return `pairdate:${seriesId}:${date}:${getPairingKey(record.playerAId, record.playerBId)}`;
    const directId = record?.matchupId || record?.gameId || record?.id || record?.completionId;
    if (directId) return `id:${directId}`;
    return getSeasonResultDedupeKey(record, seriesId, fallbackIndex);
  }

  function getSeasonResultPriority(result) {
    if (isTrueManualSeasonOverrideResult(result)) return 3;
    if (isSyntheticSeasonRepairResult(result)) return 1;
    return 2;
  }

  function getSeasonResultActiveTodayKey(options = {}) {
    const explicit = String(options.todayDateKey || '').trim();
    if (explicit) return explicit;
    return dateKey(options.nowISO || new Date());
  }

  function hasExplicitCompletedSeasonResult(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.resultFinal === true || record.final === true || record.isFinal === true || record.completed === true) return true;
    if (record.completedAtISO || record.finalizedAtISO || record.resultFinalAtISO) return true;
    const status = String(record.status || record.resultStatus || record.state || '').toLowerCase();
    if (['complete', 'completed', 'final', 'finalized', 'finished'].includes(status)) return true;
    const winnerId = String(record.winnerId || record.winningPlayerId || record?.result?.winnerId || record?.result?.winningPlayerId || '').trim();
    return Boolean(winnerId);
  }

  function isRecordedSeasonResultCountableForDate(result, options = {}) {
    const resultDate = getRecordedResultDateKey(result) || result?.dateKey || '';
    if (!resultDate) return true;
    const todayDateKey = getSeasonResultActiveTodayKey(options);
    if (!todayDateKey || todayDateKey === 'invalid') return true;
    if (String(resultDate) < String(todayDateKey)) return true;
    if (options.includeCurrentDayResults === true && String(resultDate) === String(todayDateKey)) {
      return hasExplicitCompletedSeasonResult(result);
    }
    return false;
  }

  function isRecordedSeasonResultBeforeToday(result, options = {}) {
    return isRecordedSeasonResultCountableForDate(result, options);
  }

  function normalizeSeasonResultRecord(raw, series, source, fallbackIndex = 0) {
    if (!raw || !series) return null;
    const seriesId = getRecordedSeriesId(raw) || series.id || '';
    if (seriesId && series.id && seriesId !== series.id) return null;
    const winner = getSeasonResultWinnerForSeries(raw, series);
    if (!winner.winnerId || (winner.winnerId !== series.playerAId && winner.winnerId !== series.playerBId)) return null;
    const loserId = winner.loserId || (winner.winnerId === series.playerAId ? series.playerBId : series.playerAId);
    if (!loserId) return null;
    const date = getRecordedResultDateKey(raw);
    const matchupId = raw.matchupId || raw.id || raw.gameId || (date ? `${date}_${series.id}_${raw.gameNumber || raw.seriesGameNumber || ''}` : '');
    return {
      dateKey: date,
      matchupId: String(matchupId || ''),
      gameNumber: raw.gameNumber || raw.seriesGameNumber || raw.game || null,
      seriesId,
      seasonSeriesId: seriesId,
      winnerId: winner.winnerId,
      loserId,
      playerAScore: winner.playerAScore,
      playerBScore: winner.playerBScore,
      source: raw.source || source || 'matchup',
      manualResult: raw.manualResult === true,
      adminManual: raw.adminManual === true,
      catchUpResult: raw.catchUpResult === true,
      lateBoundSeriesCatchUp: raw.lateBoundSeriesCatchUp === true,
      matchupType: raw.matchupType || 'tournament',
      roundId: raw.roundId || series.roundId || '',
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
      const series = season.series[seriesId];
      if (!isValidSeasonResultDateForSeries(season, series, raw, options)) return;
      if (!isRecordedSeasonResultBeforeToday(raw, options)) return;
      const normalized = normalizeSeasonResultRecord(raw, series, source, index);
      if (!normalized) return;
      if (!isRecordedSeasonResultBeforeToday(normalized, options)) return;
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
      if (!isValidSeasonResultDateForSeries(season, season.series[seriesId], matchup, options)) return;

      const repaired = withInferredSeasonMatchupMetadata(state, season, matchup, options);
      if (repaired === matchup && !hasExplicitValidSeries && !type) return;
      add(seriesId, repaired, 'matchup', index);
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

  function hasManualSeasonSeriesResult(series) {
    if (!series) return false;
    if (series.manualResult === true) return true;
    const source = String(series.resultSource || series.source || '').toLowerCase();
    if (source === 'manual' || source === 'admin') return true;
    const hasPersistedGames = Array.isArray(series.gameResults) && series.gameResults.length > 0;
    if (hasPersistedGames) return false;
    const winsA = Number(series.winsA) || 0;
    const winsB = Number(series.winsB) || 0;
    const winnerId = String(series.winnerId || '');
    const loserId = String(series.loserId || '');
    if (winsA > 0 || winsB > 0 || winnerId || loserId) return true;
    return false;
  }

  function rebuildSeasonSeriesFromRecordedResults(series, rawResults, options = {}) {
    const byKey = new Map();
    const keyByConflict = new Map();
    rawResults.forEach((rawResult, index) => {
      const normalizedWinner = normalizeSeasonResultWinnerForSeries(rawResult, series);
      const result = normalizedWinner.record;
      const key = result._dedupeKey || getSeasonResultDedupeKey(result, series.id, index);
      const conflictKey = getSeasonResultConflictDedupeKey(result, series.id, index);
      const existingKey = (conflictKey && keyByConflict.get(conflictKey)) || key;
      const existing = byKey.get(existingKey);
      const resultPriority = getSeasonResultPriority(result);
      const existingPriority = getSeasonResultPriority(existing);
      const resultSource = String(result._containerSource || result.source || '');
      const existingSource = String(existing?._containerSource || existing?.source || '');

      if (existing) {
        if (existingPriority > resultPriority) return;
        if (existingPriority === resultPriority) {
          const resultIsPersistedSeries = resultSource.includes('series.gameResults');
          const existingIsPersistedSeries = existingSource.includes('series.gameResults');
          const resultIsRealMatchup = resultPriority === 2 && !resultIsPersistedSeries;
          const existingIsRealMatchup = existingPriority === 2 && !existingIsPersistedSeries;
          if (existingIsRealMatchup && !resultIsRealMatchup) return;
          if (existingIsPersistedSeries && !resultIsPersistedSeries && resultPriority !== 2) return;
        }
        if (existingKey !== key) byKey.delete(existingKey);
      }

      byKey.set(key, result);
      if (conflictKey) keyByConflict.set(conflictKey, key);
    });

    const allResults = Array.from(byKey.values());
    const manualSlots = new Set(allResults.filter(isTrueManualSeasonOverrideResult).map((result) => `${result.dateKey || ''}:${result.gameNumber || result.seriesGameNumber || result.game || ''}`).filter((key) => key !== ':'));
    const manualDates = new Set(allResults.filter(isTrueManualSeasonOverrideResult).map((result) => result.dateKey || '').filter(Boolean));
    const resultsForOrdering = allResults.filter((result) => isTrueManualSeasonOverrideResult(result)
      || (!manualSlots.has(`${result.dateKey || ''}:${result.gameNumber || result.seriesGameNumber || result.game || ''}`) && !(result.dateKey && manualDates.has(result.dateKey))));
    const orderedGameResults = resultsForOrdering.sort((a, b) => {
      const aGame = Number(a.gameNumber || a.seriesGameNumber || a.game);
      const bGame = Number(b.gameNumber || b.seriesGameNumber || b.game);
      if (Number.isFinite(aGame) && Number.isFinite(bGame) && aGame !== bGame) return aGame - bGame;
      const dateCompare = String(a.dateKey || a._sortKey || '').localeCompare(String(b.dateKey || b._sortKey || ''));
      if (dateCompare !== 0) return dateCompare;
      const priorityCompare = getSeasonResultPriority(b) - getSeasonResultPriority(a);
      if (priorityCompare !== 0) return priorityCompare;
      return 0;
    });
    const winsNeeded = getSeasonSeriesWinsNeeded(series);
    const countedResults = [];
    let winsA = 0;
    let winsB = 0;
    orderedGameResults.forEach((result) => {
      if (winsA >= winsNeeded || winsB >= winsNeeded) return;
      if (result.winnerId === series.playerAId) {
        winsA += 1;
        countedResults.push(result);
      } else if (result.winnerId === series.playerBId) {
        winsB += 1;
        countedResults.push(result);
      }
    });
    const gameResults = countedResults;
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

  function getSeasonSeriesRecordedResultSummary(state, season, series, options = {}) {
    const normalizedSeason = normalizeSeasonState(season);
    if (!normalizedSeason || !series?.id) return { winsA: 0, winsB: 0, sources: [], gameResults: [] };
    const seriesForRebuild = normalizedSeason.series?.[series.id] || series;
    const candidates = collectSeasonResultCandidates({ ...(state || {}), currentSeason: normalizedSeason }, normalizedSeason, options);
    const rawResults = candidates.get(series.id) || [];
    const rebuilt = rebuildSeasonSeriesFromRecordedResults(seriesForRebuild, rawResults, options);
    const gameResults = Array.isArray(rebuilt.gameResults) ? rebuilt.gameResults : [];
    return {
      winsA: Number(rebuilt.winsA) || 0,
      winsB: Number(rebuilt.winsB) || 0,
      sources: gameResults.map((result) => result.matchupId || result.id || result.dateKey || result.source || 'recorded-result'),
      gameResults
    };
  }

  function syncCurrentSeasonSeriesFromRecordedResults(state, options = {}) {
    const normalized = normalizeState(state || {});
    let season = normalizeSeasonState(normalized.currentSeason);
    const warnings = [];
    const errors = [];
    if (!season) return { ok: false, state: normalized, updatedSeason: season, changed: false, warnings, errors: ['No current season.'] };
    let changed = false;
    const strippedMatchups = (Array.isArray(normalized.matchups) ? normalized.matchups : [])
      .map((matchup) => stripInvalidSeasonMetadataFromMatchup(matchup, season, normalized, options));
    const strippedState = { ...normalized, matchups: strippedMatchups };
    if (JSON.stringify(strippedMatchups) !== JSON.stringify(normalized.matchups || [])) changed = true;

    const beforeSeries = season.series || {};
    const candidates = collectSeasonResultCandidates(strippedState, season, options);
    const nextSeries = { ...beforeSeries };
    let resultCount = 0;
    Object.entries(beforeSeries).forEach(([seriesId, series]) => {
      const rawResults = candidates.get(seriesId) || [];
      resultCount += rawResults.length;
      const hasManualResultToPreserve = rawResults.length === 0 && hasManualSeasonSeriesResult(series);
      const shouldRebuild = rawResults.length
        || (!hasManualResultToPreserve && Array.isArray(series?.gameResults) && series.gameResults.length)
        || (!hasManualResultToPreserve && series?.status === 'complete' && !getSeasonSeriesWinner(series));
      if (!shouldRebuild) {
        nextSeries[seriesId] = series;
        return;
      }
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
    const advancementRepair = repairCompletedSeasonAdvancementForSeason(season, options);
    if (advancementRepair.season) {
      season = advancementRepair.season;
      if (advancementRepair.changed) changed = true;
      else if (!advancementRepair.ok && advancementRepair.error) warnings.push(`Advancement repair pending: ${advancementRepair.error}.`);
    }
    const catchUpRepair = backfillLateBoundSeasonSeriesResults({ ...strippedState, currentSeason: season }, season, options);
    if (catchUpRepair.updatedSeason) {
      season = catchUpRepair.updatedSeason;
      if (catchUpRepair.changed) {
        changed = true;
        warnings.push(`Backfilled ${catchUpRepair.backfilledCount} late Play-In Round of 32 game result${catchUpRepair.backfilledCount === 1 ? '' : 's'}.`);
      }
      const postCatchUpAdvancementRepair = repairCompletedSeasonAdvancementForSeason(season, options);
      if (postCatchUpAdvancementRepair.season) {
        season = postCatchUpAdvancementRepair.season;
        if (postCatchUpAdvancementRepair.changed) changed = true;
        else if (!postCatchUpAdvancementRepair.ok && postCatchUpAdvancementRepair.error) warnings.push(`Post-catch-up advancement repair pending: ${postCatchUpAdvancementRepair.error}.`);
      }
    }

    const repairedMatchups = strippedMatchups
      .map((matchup) => withInferredSeasonMatchupMetadata(strippedState, season, matchup, options));
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
        const parsed = parseTaskPointsStorageJson(raw, {}) || {};
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
const hasMaxEntries = Number.isFinite(options.maxEntries) && options.maxEntries >= 0;
const maxEntries = hasMaxEntries ? Math.floor(options.maxEntries) : null;
const todayOnly = options.todayOnly !== false;
const today = options.todayKey || dateKey(new Date());
const yesterday = addDaysToDateKey(today, -1);
const tomorrow = addDaysToDateKey(today, 1);
    const validKey = /^\d{4}-\d{2}-\d{2}$/;
    const gameHistory = Array.isArray(source.gameHistory) ? source.gameHistory : [];
    const finalScoreSet = new Set(gameHistory.map((g) => `${String(g?.date || '')}|${String(g?.playerId || '')}`));
const isProtected = (item) => {
  const d = typeof item?.date === 'string' ? item.date : '';

  if (todayOnly) {
    return d === today;
  }

  return d === today || d === yesterday || d === tomorrow || (validKey.test(d) && d > tomorrow);
};
const isRecoveryCandidate = (item) => {
  if (todayOnly) return false;

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

if (maxEntries !== null && finalSchedules.length > maxEntries) {
  finalSchedules = finalSchedules.slice(0, maxEntries);
}
    const cleanedState = { ...source, opponentDripSchedules: finalSchedules };
    return cleanedState;
  }

  function normalizeState(s) {
    const src = inflateRedundantFieldsFromStorage((s && typeof s === 'object') ? s : {});
    const normalized = {
      ...src,
      tasks:       Array.isArray(src.tasks)       ? src.tasks.map(normalizeTask)       : [],
      reminders:   Array.isArray(src.reminders)   ? src.reminders   : [],
      completions: Array.isArray(src.completions) ? src.completions.map(normalizeCompletion) : [],
      players:     Array.isArray(src.players)     ? src.players     : [],
      habits:      Array.isArray(src.habits)      ? src.habits.map(normalizeHabit)      : [],
      flexActions: Array.isArray(src.flexActions) ? src.flexActions : [],
      gameHistory: Array.isArray(src.gameHistory) ? src.gameHistory : [],
      matchups:    Array.isArray(src.matchups)    ? src.matchups    : [],
      schedule:    Array.isArray(src.schedule)    ? src.schedule    : [],
opponentDripSchedules: Array.isArray(src.opponentDripSchedules) ? src.opponentDripSchedules : [],
weightHistory: Array.isArray(src.weightHistory) ? src.weightHistory : [],
vo2MaxHistory: Array.isArray(src.vo2MaxHistory) ? src.vo2MaxHistory : [],
workHistory: Array.isArray(src.workHistory) ? src.workHistory : [],
      liveDiffHistory: src.liveDiffHistory && typeof src.liveDiffHistory === 'object' ? src.liveDiffHistory : {},
      liveDiffSnapshots: src.liveDiffSnapshots && typeof src.liveDiffSnapshots === 'object' ? src.liveDiffSnapshots : {},
      youImageId:  typeof src.youImageId === "string" ? src.youImageId : "",
      youName: typeof src.youName === "string" ? src.youName : "",
      youPrimaryColor: normalizeHexColor(src.youPrimaryColor) || "#1a383b",
      youSecondaryColor: normalizeHexColor(src.youSecondaryColor) || "#254c52",
      projects:    Array.isArray(src.projects)    ? src.projects    : [],
      notes: typeof src.notes === "string" ? src.notes : "",
      habitTagColors: normalizeHabitTagColors(src.habitTagColors),
      scoringSettings: normalizeScoringSettings(src.scoringSettings),
      playerBadges: src.playerBadges && typeof src.playerBadges === 'object' && !Array.isArray(src.playerBadges) ? src.playerBadges : {},
      currentSeason: normalizeCurrentSeason(src.currentSeason),
      latestSeasonId: typeof src.latestSeasonId === 'string' ? src.latestSeasonId : '',
      seasonHistory: normalizeSeasonHistory(src.seasonHistory)
    };
    return cleanupOpponentDripSchedules(normalized, { maxEntries: 120 });
  }


  function extractImportStateRoot(data) {
    if (data && Array.isArray(data.tasks) && Array.isArray(data.completions)) return data;
    if (data && data.state && Array.isArray(data.state.tasks) && Array.isArray(data.state.completions)) return data.state;
    return null;
  }

  function normalizeImportedFullBackupState(root, currentState = {}, options = {}) {
    const src = extractImportStateRoot(root) || ((root && typeof root === 'object') ? root : {});
    const current = (currentState && typeof currentState === 'object') ? currentState : {};
    const preserveMissingReminders = options.preserveMissingReminders !== false;
    const preserveMissingProjects = options.preserveMissingProjects !== false;
    const hasImportedReminders = Array.isArray(src.reminders);
    const hasImportedProjects = Array.isArray(src.projects);
    const normalized = normalizeState({
      ...src,
      reminders: hasImportedReminders ? src.reminders : (preserveMissingReminders ? current.reminders : []),
      projects: hasImportedProjects ? src.projects : (preserveMissingProjects ? current.projects : []),
      currentSeason: Object.prototype.hasOwnProperty.call(src, 'currentSeason') ? src.currentSeason : null,
      latestSeasonId: typeof src.latestSeasonId === 'string' ? src.latestSeasonId : '',
      seasonHistory: Array.isArray(src.seasonHistory) ? src.seasonHistory : []
    });
    if (Array.isArray(src.opponentDripSchedules)) {
      normalized.opponentDripSchedules = src.opponentDripSchedules;
    }
    return normalized;
  }

  function loadAppState(options = {}) {
    let parsed = {};
    let storageKeysFound = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        parsed = parseTaskPointsStorageJson(raw, {}) || {};
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
const hasOpponentDripScheduleLimit = Number.isFinite(limits.maxOpponentDripSchedules);
const maxOpponentDripSchedules = hasOpponentDripScheduleLimit
  ? limits.maxOpponentDripSchedules
  : null;
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

  merged.opponentDripSchedules = cleanupOpponentDripSchedules(merged, {
  todayOnly: limits.opponentDripSchedulesTodayOnly !== false,
  ...(hasOpponentDripScheduleLimit ? { maxEntries: maxOpponentDripSchedules } : {})
}).opponentDripSchedules;

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
if (
  hasOpponentDripScheduleLimit
  && merged.opponentDripSchedules.length > maxOpponentDripSchedules
) {
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
        existing = raw ? (parseTaskPointsStorageJson(raw, {}) || {}) : {};
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
      return raw ? (parseTaskPointsStorageJson(raw, {}) || {}) : {};
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

  function getRuntimeRoot() {
    return (global && global.window) ? global.window : global;
  }

  function getJsonSizeBytes(value) {
    try {
      const json = JSON.stringify(value);
      return json ? json.length * 2 : 0;
    } catch (_) {
      return 0;
    }
  }

  function getStorageKeySizeBytes(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? 0 : (String(key || '').length + value.length) * 2;
    } catch (_) {
      return 0;
    }
  }

  function getStateFieldSizeReport(snapshot) {
    const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const keys = [
      'tasks', 'reminders', 'completions', 'habits', 'players', 'flexActions',
      'gameHistory', 'matchups', 'schedule', 'opponentDripSchedules',
      'weightHistory', 'vo2MaxHistory', 'liveDiffHistory', 'liveDiffSnapshots',
      'workHistory', 'currentSeason', 'seasonHistory', 'storageWarnings',
      'notes', 'projects', 'playerBadges'
    ];
    return keys
      .map((key) => ({ key, bytes: getJsonSizeBytes(safe[key]) }))
      .filter((entry) => entry.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10);
  }

  function recordQuotaFailureDiagnostics(info) {
    const root = getRuntimeRoot();
    const diagnostic = {
      atISO: new Date().toISOString(),
      savePath: info?.savePath || 'unknown',
      stage: info?.stage || 'unknown',
      storageKey: info?.storageKey || STORAGE_KEY,
      storedBytes: Number(info?.storedBytes) || 0,
      candidateBytes: Number(info?.candidateBytes) || 0,
      unpackedCandidateBytes: Number(info?.unpackedCandidateBytes) || 0,
      packedCandidateBytes: Number(info?.packedCandidateBytes) || 0,
      compressedCandidateBytes: Number(info?.compressedCandidateBytes) || 0,
      packedRawChars: Number(info?.packedRawChars) || 0,
      compressedRawChars: Number(info?.compressedRawChars) || 0,
      chosenStorageEncoding: info?.chosenStorageEncoding || 'unknown',
      chosenStorageChars: Number(info?.chosenStorageChars) || 0,
      chosenStorageBytes: Number(info?.chosenStorageBytes) || 0,
      localStorageTotalBytes: (() => {
        try { return getLocalStorageSizeReport().totalBytes; } catch (_) { return 0; }
      })(),
      counts: summarizeSnapshotCounts(info?.snapshot || {}),
      currentDateCounts: (() => {
        const snapshot = info?.snapshot || {};
        const currentDateKey = String(info?.dateKey || todayKey()).slice(0, 10);
        const matchupsForDate = (Array.isArray(snapshot.matchups) ? snapshot.matchups : []).filter((row) => getStoredMatchupDateKey(row) === currentDateKey).length;
        const gameHistoryForDate = (Array.isArray(snapshot.gameHistory) ? snapshot.gameHistory : []).filter((row) => String(row?.dateKey || row?.date || (row?.dateISO ? dateKey(row.dateISO) : '') || '').slice(0, 10) === currentDateKey).length;
        const scheduleForDate = (Array.isArray(snapshot.schedule) ? snapshot.schedule : []).filter((row) => getScheduleDayDateKey(row) === currentDateKey).length;
        return { dateKey: currentDateKey, matchups: matchupsForDate, gameHistory: gameHistoryForDate, schedule: scheduleForDate };
      })(),
      biggestFields: getStateFieldSizeReport(info?.snapshot || {})
    };
    if (root) root.__tpLastQuotaFailure = diagnostic;
    console.warn('[TaskPoints] quota/save-size diagnostic', diagnostic);
    return diagnostic;
  }

  function shouldShowQuotaAlertNow() {
    const root = getRuntimeRoot();
    if (!root) return true;
    const now = Date.now();
    const last = Number(root.__tpLastQuotaAlertAt || 0);
    if (last && now - last < TASKPOINTS_QUOTA_ALERT_COOLDOWN_MS) return false;
    root.__tpLastQuotaAlertAt = now;
    return true;
  }

  function getPlayerNameMapForStorage(state) {
    const map = new Map();
    (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
      if (!player || typeof player !== 'object') return;
      const id = typeof player.id === 'string' ? player.id : '';
      const name = typeof player.name === 'string' ? player.name : '';
      if (id && name) map.set(id, name);
    });
    return map;
  }

  function stripRedundantFieldsForStorage(state) {
    const source = state && typeof state === 'object' ? state : {};
    const playerNames = getPlayerNameMapForStorage(source);
    const compacted = { ...source };

    if (Array.isArray(source.matchups)) {
      compacted.matchups = source.matchups.map((matchup) => {
        if (!matchup || typeof matchup !== 'object') return matchup;
        const row = { ...matchup };
        if (row.playerAId && row.playerAName && playerNames.get(row.playerAId) === row.playerAName) delete row.playerAName;
        if (row.playerBId && row.playerBName && playerNames.get(row.playerBId) === row.playerBName) delete row.playerBName;
        if (row.date && row.dateKey === row.date) delete row.dateKey;
        if (row.id && row.matchupId === row.id) delete row.matchupId;
        if (Number.isFinite(Number(row.scoreA)) && Number(row.playerAScore) === Number(row.scoreA)) delete row.playerAScore;
        if (Number.isFinite(Number(row.scoreB)) && Number(row.playerBScore) === Number(row.scoreB)) delete row.playerBScore;
        return row;
      });
    }

    if (Array.isArray(source.gameHistory)) {
      compacted.gameHistory = source.gameHistory.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const row = { ...entry };
        if (row.date && row.dateKey === row.date) delete row.dateKey;
        if (row.opponentId === '') delete row.opponentId;
        return row;
      });
    }

    if (Array.isArray(source.tasks)) {
      compacted.tasks = source.tasks.map((task) => {
        if (!task || typeof task !== 'object') return task;
        const row = { ...task };
        if (row.originalDueDateISO && row.dueDateISO && row.originalDueDateISO === row.dueDateISO) delete row.originalDueDateISO;
        if (row.recurrence && typeof row.recurrence === 'object' && row.recurrence.mode === 'none' && Object.keys(row.recurrence).length === 1) delete row.recurrence;
        if (Array.isArray(row.tags) && row.tags.length === 0) delete row.tags;
        if (Array.isArray(row.skipDates) && row.skipDates.length === 0) delete row.skipDates;
        if (Array.isArray(row.skills) && row.skills.length === 2 && row.skills.every((slot) => slot && slot.skill === '' && slot.pts === '')) delete row.skills;
        if (row.hidden === false) delete row.hidden;
        ['deletedAt', 'deletedFrom', 'prevStatus', 'completedAtISO'].forEach((key) => {
          if (row[key] == null) delete row[key];
        });
        if (Number(row.postponedDays) === 0) delete row.postponedDays;
        return row;
      });
    }

    return compacted;
  }

  function inflateRedundantFieldsFromStorage(state) {
    const source = state && typeof state === 'object' ? state : {};
    if (source.__storageCompactVersion !== 1) return source;
    const playerNames = getPlayerNameMapForStorage(source);
    const inflated = { ...source };
    delete inflated.__storageCompactVersion;

    if (Array.isArray(source.matchups)) {
      inflated.matchups = source.matchups.map((matchup) => {
        if (!matchup || typeof matchup !== 'object') return matchup;
        const row = { ...matchup };
        if (!row.playerAName && row.playerAId && playerNames.has(row.playerAId)) row.playerAName = playerNames.get(row.playerAId);
        if (!row.playerBName && row.playerBId && playerNames.has(row.playerBId)) row.playerBName = playerNames.get(row.playerBId);
        if (!row.dateKey && row.date) row.dateKey = row.date;
        if (!row.date && row.dateKey) row.date = row.dateKey;
        if (!row.matchupId && row.id && (row.seasonId || row.seriesId || row.seasonSeriesId || row.matchupType)) row.matchupId = row.id;
        if (row.playerAScore == null && Number.isFinite(Number(row.scoreA))) row.playerAScore = Number(row.scoreA);
        if (row.playerBScore == null && Number.isFinite(Number(row.scoreB))) row.playerBScore = Number(row.scoreB);
        return row;
      });
    }

    if (Array.isArray(source.gameHistory)) {
      inflated.gameHistory = source.gameHistory.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const row = { ...entry };
        if (!row.dateKey && row.date) row.dateKey = row.date;
        if (!row.date && row.dateKey) row.date = row.dateKey;
        if (row.opponentId == null) row.opponentId = '';
        return row;
      });
    }

    if (Array.isArray(source.tasks)) {
      inflated.tasks = source.tasks.map((task) => normalizeTask({
        recurrence: { mode: 'none' },
        tags: [],
        skills: [{ skill: '', pts: '' }, { skill: '', pts: '' }],
        skipDates: [],
        hidden: false,
        deletedAt: null,
        deletedFrom: null,
        prevStatus: null,
        completedAtISO: null,
        postponedDays: 0,
        ...(task && typeof task === 'object' ? task : {})
      }));
    }

    return inflated;
  }

  function compactStateForLocalStorage(state, options = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const compacted = stripRedundantFieldsForStorage({ ...source });
    compacted.__storageCompactVersion = 1;
    compacted.schedule = [];
    compacted.opponentDripSchedules = [];
    compacted.storageWarnings = Array.isArray(source.storageWarnings)
      ? source.storageWarnings.slice(-TASKPOINTS_STORAGE_WARNING_MAX)
      : [];
    delete compacted.lastCompletionPruneWarning;
    delete compacted.lastGameHistoryPruneWarning;
    delete compacted.lastMatchupPruneWarning;
    if (options.clearWorkHistory === true) compacted.workHistory = [];
    return compacted;
  }
  
  function storeRollingBackup(storageKey, options = {}) {
    const currentRaw = localStorage.getItem(storageKey);
    if (!currentRaw) return;
    let parsedCurrent = {};
    try {
      parsedCurrent = parseTaskPointsStorageJson(currentRaw, {}) || {};
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
      latest = parseTaskPointsStorageJson(localStorage.getItem(storageKey) || '{}', {});
    } catch (_) {
      latest = null;
    }
    const allowGeneratedCacheClear = Boolean(options.allowGeneratedCacheClear || options.storageEmergencyCompaction);
    const stickyArrayFields = [
      'tasks', 'completions', 'habits', 'players', 'flexActions',
      'gameHistory', 'matchups', 'weightHistory', 'vo2MaxHistory', 'reminders', 'seasonHistory'
    ];
    if (!allowGeneratedCacheClear) {
      stickyArrayFields.push('schedule');
    }
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
    
    if (allowGeneratedCacheClear) {
      next.schedule = Array.isArray(next.schedule) ? next.schedule : [];
      next.opponentDripSchedules = Array.isArray(next.opponentDripSchedules) ? next.opponentDripSchedules : [];
    }
    
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
    const storageKey = options.storageKey || STORAGE_KEY;
    const savePath = options.savePath || options.source || options.reason || options.caller || 'unknown';
    const root = getRuntimeRoot();
    const userInitiatedSave = Boolean(options.userInitiated || options.manualSave || options.immediateWrite);
    const blockedUntil = Number(root?.__tpQuotaSaveBlockedUntil || 0);
    if (!userInitiatedSave && blockedUntil > Date.now()) {
      console.warn(`[TaskPoints] skipped automatic save during quota cooldown. savePath=${savePath}`);
      return {
        state: readStoredStateRaw(storageKey),
        trimmed: false,
        skipped: true,
        blockedByQuotaCircuit: true
      };
    }
    const summarizeStateSizes = (snapshot) => ({
      completions: Array.isArray(snapshot?.completions) ? snapshot.completions.length : 0,
      gameHistory: Array.isArray(snapshot?.gameHistory) ? snapshot.gameHistory.length : 0,
      matchups: Array.isArray(snapshot?.matchups) ? snapshot.matchups.length : 0,
      workHistory: Array.isArray(snapshot?.workHistory) ? snapshot.workHistory.length : 0,
      schedule: Array.isArray(snapshot?.schedule) ? snapshot.schedule.length : 0
    });

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
      const deduped = warnings.filter((entry) => !(entry && entry.type === warning.type && entry.message === warning.message));
      deduped.push(warning);
      return { ...base, storageWarnings: deduped.slice(-TASKPOINTS_STORAGE_WARNING_MAX) };
    };
    const attemptSave = (candidate, trimmed, stage = 'initial', attemptOptions = {}) => {
      const stickyOptions = { ...options, ...attemptOptions };
      const candidateWithSticky = preserveStickyFieldsBeforeSave(candidate, storageKey, stickyOptions);
      const storedBytes = getStorageKeySizeBytes(storageKey);
      const candidateBytes = getJsonSizeBytes(candidateWithSticky);
      if (candidateBytes > TASKPOINTS_LARGE_SAVE_WARN_BYTES || (storedBytes > 0 && candidateBytes > storedBytes + (512 * 1024))) {
        recordQuotaFailureDiagnostics({ savePath, stage, storageKey, storedBytes, candidateBytes, snapshot: candidateWithSticky });
      }
      const storagePlan = buildOptimizedTaskPointsStorageRaw(candidateWithSticky);
      const packedCandidateBytes = storagePlan.packedRawChars * 2;
      const compressedCandidateBytes = storagePlan.compressedRawChars * 2;
      const chosenStorageBytes = storagePlan.chosenChars * 2;
      if (chosenStorageBytes > TASKPOINTS_LARGE_SAVE_WARN_BYTES || (storedBytes > 0 && chosenStorageBytes > storedBytes + (512 * 1024))) {
        recordQuotaFailureDiagnostics({
          savePath,
          stage: `${stage}:${storagePlan.chosenEncoding}`,
          storageKey,
          storedBytes,
          candidateBytes: chosenStorageBytes,
          unpackedCandidateBytes: candidateBytes,
          packedCandidateBytes,
          compressedCandidateBytes,
          packedRawChars: storagePlan.packedRawChars,
          compressedRawChars: storagePlan.compressedRawChars,
          chosenStorageEncoding: storagePlan.chosenEncoding,
          chosenStorageChars: storagePlan.chosenChars,
          chosenStorageBytes,
          snapshot: storagePlan.packedState
        });
      }
      try {
        safeReplaceTaskPointsStorage(storageKey, storagePlan.chosenRaw);
      } catch (err) {
        recordQuotaFailureDiagnostics({ savePath, stage, storageKey, storedBytes, candidateBytes: chosenStorageBytes, packedCandidateBytes, compressedCandidateBytes, unpackedCandidateBytes: candidateBytes, packedRawChars: storagePlan.packedRawChars, compressedRawChars: storagePlan.compressedRawChars, chosenStorageEncoding: storagePlan.chosenEncoding, chosenStorageChars: storagePlan.chosenChars, chosenStorageBytes, snapshot: candidateWithSticky });
        throw err;
      }
      const savedRaw = localStorage.getItem(storageKey);
      const saved = savedRaw ? (parseTaskPointsStorageJson(savedRaw, {}) || {}) : {};
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
      const returnedState = inflateRedundantFieldsFromStorage(candidateWithSticky);
      setQuotaTrimMarker(stage, summarizeStateSizes(returnedState), trimmed);
      return { state: returnedState, trimmed };
    };

    if (debugEnabled) {
      console.log(`[TP saveStateSnapshot] start savePath=${savePath} storageKey=${storageKey} completionsBeforeFirstSave=${beforeSummary.completions}${callsite ? ` callsite=${callsite}` : ''}`);
    }

const hasOpponentDripScheduleLimit = Number.isFinite(options?.limits?.maxOpponentDripSchedules);

const saveDedupeDateKey = String(options.dedupeDateKey || options.todayDateKey || '').slice(0, 10);
const dedupedSaveState = saveDedupeDateKey
  ? dedupeSameDayGeneratedSlateState(state, saveDedupeDateKey).state
  : state;
const cleanedInitialCandidate = cleanupOpponentDripSchedules(dedupedSaveState, {
  todayOnly: options?.limits?.opponentDripSchedulesTodayOnly !== false,
  ...(hasOpponentDripScheduleLimit
    ? { maxEntries: options.limits.maxOpponentDripSchedules }
    : {})
});
    const initialStoredBytes = getStorageKeySizeBytes(storageKey);
    const initialCandidateBytes = getJsonSizeBytes(cleanedInitialCandidate);
    const shouldPrecompactGenerated = initialCandidateBytes > TASKPOINTS_LARGE_SAVE_WARN_BYTES
      || (initialStoredBytes > 0 && initialCandidateBytes > initialStoredBytes + (512 * 1024) && initialCandidateBytes > 3.5 * 1024 * 1024);
    const initialCandidate = shouldPrecompactGenerated
      ? compactStateForLocalStorage(cleanedInitialCandidate)
      : cleanedInitialCandidate;
    try {
      return attemptSave(initialCandidate, shouldPrecompactGenerated, shouldPrecompactGenerated ? 'initial-generated-compacted' : 'initial', {
        allowGeneratedCacheClear: shouldPrecompactGenerated
      });
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
      if (debugEnabled) {
        console.log(`[TP saveStateSnapshot] firstSaveQuotaError=true savePath=${savePath} storageKey=${storageKey}`);
      }
    }

    const generatedCompacted = compactStateForLocalStorage(initialCandidate);
    logStage('generated-compacted', generatedCompacted);
    try {
      return attemptSave(generatedCompacted, true, 'generated-compacted', { allowGeneratedCacheClear: true });
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      lastQuotaError = err;
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

    const emergency = compactStateForLocalStorage(aggressive, { clearWorkHistory: true });
    logStage('emergency', emergency);
    try {
      return attemptSave(emergency, true, 'emergency', {
        allowGeneratedCacheClear: true,
        storageEmergencyCompaction: true
      });
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
    const warningState = appendStorageWarning(compactStateForLocalStorage(state), quotaWarning);
    if (root) root.__tpQuotaSaveBlockedUntil = Date.now() + TASKPOINTS_SAVE_BLOCK_COOLDOWN_MS;
    try {
      safeReplaceTaskPointsStorage(storageKey, JSON.stringify(packTaskPointsStorageState(preserveStickyFieldsBeforeSave(warningState, storageKey, {
        ...options,
        allowGeneratedCacheClear: true,
        storageEmergencyCompaction: true
      }))));
    } catch (warningErr) {
      console.warn('TaskPointsCore: unable to persist storage warning after quota failure.', warningErr);
    }
    console.error('TaskPointsCore: save failed due to browser storage quota. Critical historical data was preserved and not pruned.', lastQuotaError || new Error('Quota exceeded'));
    if (typeof alert === 'function' && shouldShowQuotaAlertNow()) {
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
        parsed = raw ? (parseTaskPointsStorageJson(raw, null) || null) : null;
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
      parsed = raw ? (parseTaskPointsStorageJson(raw, null) || null) : null;
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

    const bonusEnabled =
      entry.calLogBonusEnabled !== false
      && entry.calLogBonusDisabled !== true
      && entry.skipCalLogBonus !== true;

    if (!bonusEnabled) return false;

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
    const tournamentPlayerIds = new Set();
    matchupPairsRaw.forEach((matchup) => {
      if (!isTournamentOrSeasonMatchup(matchup)) return;
      if (matchup.playerAId) tournamentPlayerIds.add(String(matchup.playerAId));
      if (matchup.playerBId) tournamentPlayerIds.add(String(matchup.playerBId));
    });
    const tournamentExhibitionOverlaps = matchupPairsRaw
      .filter((matchup) => isExhibitionMatchup(matchup) && (tournamentPlayerIds.has(String(matchup.playerAId || '')) || tournamentPlayerIds.has(String(matchup.playerBId || ''))))
      .map((matchup) => ({ playerAId: matchup.playerAId, playerBId: matchup.playerBId, matchupId: matchup.id || matchup.matchupId || '' }));
    const countsMatch = schedulePairs.length === matchupPairs.length;

    return {
      ok: countsMatch
        && !missingInSchedule.length
        && !missingInMatchups.length
        && !duplicateSchedulePairs.length
        && !duplicateMatchupPairs.length
        && !tournamentExhibitionOverlaps.length,
      todayKey: today,
      schedulePairs,
      matchupPairs,
      missingInSchedule,
      missingInMatchups,
      duplicateSchedulePairs,
      duplicateMatchupPairs,
      tournamentExhibitionOverlaps
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

  // Stable seeded RNG:
  // Same date + player + final score = same drip schedule every reload.
  function hashStringToSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeSeededRandom(seed) {
    let t = seed >>> 0;
    return function seededRandom() {
      t += 0x6D2B79F5;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const seed = hashStringToSeed([
    'opponent-drip-v2',
    String(dateKey || ''),
    String(playerId || ''),
    totalRounded.toFixed(1)
  ].join('|'));

  const rng = makeSeededRandom(seed);

  const startHour = 6;
  const endHour = 23;
  const count = Math.max(12, Math.min(40, Math.round(rng() * 20) + 15));

  const baseDate = new Date(`${dateKey}T00:00:00`);

  const hourBuckets = [];
  for (let h = startHour; h <= endHour; h++) {
    let weight = 1;

    if (h >= 6 && h <= 11) weight += 0.7;
    if (h >= 12 && h <= 15) weight += 0.45;
    if (h >= 16 && h <= 17) weight += 0.25;
    if (h >= 18 && h <= 23) weight += 0.15;

    if (rng() < 0.15) weight *= 0.4;

    hourBuckets.push({ hour: h, weight: Math.max(0.2, weight) });
  }

  const totalHourWeight = hourBuckets.reduce((s, h) => s + h.weight, 0) || 1;

  function pickTime() {
    let r = rng() * totalHourWeight;
    let chosenHour = startHour;

    for (const h of hourBuckets) {
      if (r <= h.weight) {
        chosenHour = h.hour;
        break;
      }
      r -= h.weight;
    }

    const m = Math.floor(rng() * 60);
    const s = Math.floor(rng() * 60);
    const d = new Date(baseDate.getTime());
    d.setHours(chosenHour, m, s, 0);
    return d;
  }

  const weights = [];
  for (let i = 0; i < count; i++) {
    const base = Math.pow(rng(), 1.4);
    const burst = rng() < 0.35 ? rng() * 1.2 : 0;
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

  const sizedUnits = pointUnits.slice();

  // Deterministic shuffle, not Math.random().
  for (let i = sizedUnits.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sizedUnits[i], sizedUnits[j]] = [sizedUnits[j], sizedUnits[i]];
  }

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
// The absolute ceiling approaches 87 without making every big game exactly 87.
const SOFT_CAP_START = 70;
const SOFT_CAP_MAX = 87;

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
    extractImportStateRoot,
    normalizeImportedFullBackupState,
    normalizeSeasonState,
    normalizeSeasonHistory,
    normalizeCurrentSeason,
    getSeasonRoundDefs,
    getSeasonRoundForDate,
    daysBetweenDateKeys,
    isSeasonRoundFullyReady,
    getRoundScheduledGameNumberForDate,
    inferSeasonRoundActualStartDateKey,
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
    repairPlayInSeriesFromProtectedRoundOf32Slots,
    repairPlayInSeriesFromProtectedRoundOf32SlotsForCurrentSeason,
    backfillLateBoundSeasonSeriesResults,
    repairCurrentRoundSeriesGameAlignment,
    repairSeasonDateRange,
    getActiveSeasonSeriesForDate,
    prepareSeasonForDailySlate,
    prepareSeasonStateForScheduling,
    repairSeasonControlledScheduleFromSyncedSeason,
    removeInvalidExhibitionsForTournamentParticipants,
    getSeasonScheduleSignature,
    isSeasonSeriesCurrentForMatchupDate,
    resolveHomeSeasonSeriesForMatchup,
    sanitizeSeasonMatchupMetadataForDate,
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
    repairSeasonSeriesResultWinnerIds,
    getSeasonResultWinnerForSeries,
    getCanonicalSeasonScorePair,
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
    materializeSeasonSlateMatchupsForDate,
    dedupeSameDayGeneratedSlateState,
    dedupeSameDayMatchups,
    dedupeSameDayGameHistory,
    compactScheduleMatchupRow,
    chooseUserMatchupForDate,
    getPairingKey,
    getRecordedSeriesId,
    inferSeasonSeriesIdFromRecord,
    withInferredSeasonMatchupMetadata,
    getJunePairingHistory,
    hasJunePairingOccurred,
    generateRandomNonRepeatPairs,
    syncSeasonResultsFromDailyMatchups,
    syncCurrentSeasonSeriesFromRecordedResults,
    getSeasonSeriesRecordedResultSummary,
    cleanupOpponentDripSchedules,
    getOpponentDripScheduleCleanupSummary,
    loadAppState,
    pruneStateForStorage,
    compactStateForLocalStorage,
    packObjectArray,
    unpackObjectArray,
    packTaskPointsStorageState,
    getTaskPointsPackDiagnostics,
    unpackTaskPointsStorageState,
    compressStorageString,
    decompressStorageString,
    encodeTaskPointsStorageJson,
    decodeTaskPointsStorageJson,
    makeCompressedStorageWrapper,
    buildOptimizedTaskPointsStorageRaw,
    getTaskPointsStorageEncodingInfo,
    parseTaskPointsStorageJson,
    safeReplaceTaskPointsStorage,
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
