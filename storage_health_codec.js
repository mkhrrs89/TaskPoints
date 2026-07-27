(function installTaskPointsStorageHealthCodec(global) {
  'use strict';
  const COUNT_KEYS = ['tasks','completions','habits','players','flexActions','gameHistory','matchups','schedule','seasonHistory','reminders','weightHistory','vo2MaxHistory'];
  const MAJOR_KEYS = ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'];
  function safeJson(raw, fallback = null) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function decompressUtf16(compressed) {
    if (compressed == null) return '';
    if (compressed === '') return null;
    const f = String.fromCharCode;
    const length = compressed.length;
    const resetValue = 16384;
    const getNextValue = (index) => compressed.charCodeAt(index) - 32;
    const dictionary = [];
    let enlargeIn = 4;
    let dictSize = 4;
    let numBits = 3;
    let entry = '';
    const result = [];
    let i;
    let w;
    let bits;
    let resb;
    let maxpower;
    let power;
    let c;
    const data = { val: getNextValue(0), position: resetValue, index: 1 };
    for (i = 0; i < 3; i += 1) dictionary[i] = i;
    bits = 0; maxpower = Math.pow(2, 2); power = 1;
    while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
    switch (bits) {
      case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } c = f(bits); break;
      case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } c = f(bits); break;
      case 2: return '';
      default: c = '';
    }
    dictionary[3] = c; w = c; result.push(c);
    while (true) {
      if (data.index > length) return '';
      bits = 0; maxpower = Math.pow(2, numBits); power = 1;
      while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
      c = bits;
      switch (c) {
        case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn -= 1; break;
        case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1; while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; } dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn -= 1; break;
        case 2: return result.join('');
      }
      if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits += 1; }
      if (dictionary[c]) entry = dictionary[c]; else if (c === dictSize) entry = w + w.charAt(0); else return null;
      result.push(entry); dictionary[dictSize++] = w + entry.charAt(0); enlargeIn -= 1; w = entry;
      if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits += 1; }
    }
  }

  function unpackObjectArray(packed) {
    if (!packed || !Array.isArray(packed.rows)) return Array.isArray(packed) ? packed : [];
    if (packed.mode === 'shortKeys' && packed.aliases && typeof packed.aliases === 'object' && !Array.isArray(packed.aliases)) {
      return packed.rows.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const value = {};
        Object.entries(row).forEach(([key, item]) => { if (item !== undefined) value[packed.aliases[key] || key] = item; });
        return value;
      });
    }
    if (!Array.isArray(packed.fields)) return [];
    return packed.rows.map((row) => {
      if (!Array.isArray(row)) return row;
      const value = {};
      packed.fields.forEach((field, index) => { const item = row[index]; if (item !== null && item !== undefined) value[field] = item; });
      return value;
    });
  }

  function unpackState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const packedArrays = state.__packedArrays;
    if (!packedArrays || typeof packedArrays !== 'object' || Array.isArray(packedArrays)) return state;
    const unpacked = { ...state };
    Object.keys(packedArrays).forEach((key) => { unpacked[key] = unpackObjectArray(packedArrays[key]); });
    delete unpacked.__packedArrays;
    delete unpacked.__packedStorageVersion;
    return unpacked;
  }

  function parseStoredRaw(raw) {
    if (!raw) throw new Error('Current TaskPoints mirror is missing.');
    const wrapper = JSON.parse(raw);
    if (wrapper && wrapper.__taskpointsStorageEncoding === 'lz16-packed-v1') {
      if (typeof wrapper.data !== 'string') throw new Error('Compressed mirror wrapper is missing data.');
      const decoded = decompressUtf16(wrapper.data);
      if (typeof decoded !== 'string' || !decoded) throw new Error('Compressed mirror could not be decoded.');
      return { state: unpackState(JSON.parse(decoded)), encoding: 'compressed packed JSON' };
    }
    const packed = Boolean(wrapper?.__packedArrays);
    return { state: unpackState(wrapper), encoding: packed ? 'packed JSON' : 'plain JSON' };
  }

  function countsFor(state) {
    const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, Array.isArray(source[key]) ? source[key].length : 0]));
    counts.total = COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);
    counts.majorTotal = MAJOR_KEYS.reduce((sum, key) => sum + counts[key], 0);
    return counts;
  }

  function rawHash(raw) {
    const text = String(raw || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return `${(hash >>> 0).toString(16).padStart(8,'0')}:${text.length}`;
  }

  global.TaskPointsStorageHealth = {
    ...(global.TaskPointsStorageHealth || {}), COUNT_KEYS, MAJOR_KEYS,
    safeJson, parseStoredRaw, countsFor, rawHash
  };
})(typeof window !== 'undefined' ? window : globalThis);
