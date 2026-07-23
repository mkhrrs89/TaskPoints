(function installTaskPointsPhase3SessionCodec(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase3SessionCodecInstalled) return;

  const SESSION_CACHE_KEY = 'taskpoints_phase3_verified_session_cache_v1';
  const CODEC_ID = 'lz-string-utf16-v1';
  const ENVELOPE_VERSION = 2;
  const storage = global.sessionStorage;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return;

  // UTF-16 LZ codec adapted from lz-string 1.4.x (MIT License,
  // Pieroxy / pieroxy.net). Kept self-contained so restore remains synchronous.
  function compressToUTF16(input) {
    if (input == null) return '';
    return compress(String(input), 15, (value) => String.fromCharCode(value + 32)) + ' ';
  }

  function decompressFromUTF16(compressed) {
    if (compressed == null) return '';
    if (compressed === '') return null;
    return decompress(compressed.length, 16384, (index) => compressed.charCodeAt(index) - 32);
  }

  function compress(uncompressed, bitsPerChar, getCharFromInt) {
    if (uncompressed == null) return '';
    const dictionary = Object.create(null);
    const dictionaryToCreate = Object.create(null);
    let c = '';
    let wc = '';
    let w = '';
    let enlargeIn = 2;
    let dictSize = 3;
    let numBits = 2;
    const data = [];
    let dataVal = 0;
    let dataPosition = 0;

    function writeBit(bit) {
      dataVal = (dataVal << 1) | bit;
      if (dataPosition === bitsPerChar - 1) {
        dataPosition = 0;
        data.push(getCharFromInt(dataVal));
        dataVal = 0;
      } else {
        dataPosition += 1;
      }
    }

    function writeBits(count, value) {
      for (let index = 0; index < count; index += 1) {
        writeBit(value & 1);
        value >>= 1;
      }
    }

    for (let ii = 0; ii < uncompressed.length; ii += 1) {
      c = uncompressed.charAt(ii);
      if (!Object.prototype.hasOwnProperty.call(dictionary, c)) {
        dictionary[c] = dictSize++;
        dictionaryToCreate[c] = true;
      }
      wc = w + c;
      if (Object.prototype.hasOwnProperty.call(dictionary, wc)) {
        w = wc;
      } else {
        if (Object.prototype.hasOwnProperty.call(dictionaryToCreate, w)) {
          if (w.charCodeAt(0) < 256) {
            writeBits(numBits, 0);
            writeBits(8, w.charCodeAt(0));
          } else {
            writeBits(numBits, 1);
            writeBits(16, w.charCodeAt(0));
          }
          enlargeIn -= 1;
          if (enlargeIn === 0) {
            enlargeIn = 1 << numBits;
            numBits += 1;
          }
          delete dictionaryToCreate[w];
        } else {
          writeBits(numBits, dictionary[w]);
        }
        enlargeIn -= 1;
        if (enlargeIn === 0) {
          enlargeIn = 1 << numBits;
          numBits += 1;
        }
        dictionary[wc] = dictSize++;
        w = String(c);
      }
    }

    if (w !== '') {
      if (Object.prototype.hasOwnProperty.call(dictionaryToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          writeBits(numBits, 0);
          writeBits(8, w.charCodeAt(0));
        } else {
          writeBits(numBits, 1);
          writeBits(16, w.charCodeAt(0));
        }
        enlargeIn -= 1;
        if (enlargeIn === 0) {
          enlargeIn = 1 << numBits;
          numBits += 1;
        }
        delete dictionaryToCreate[w];
      } else {
        writeBits(numBits, dictionary[w]);
      }
      enlargeIn -= 1;
      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits += 1;
      }
    }

    writeBits(numBits, 2);
    while (true) {
      dataVal <<= 1;
      if (dataPosition === bitsPerChar - 1) {
        data.push(getCharFromInt(dataVal));
        break;
      }
      dataPosition += 1;
    }
    return data.join('');
  }

  function decompress(length, resetValue, getNextValue) {
    const dictionary = [];
    const data = { val: getNextValue(0), position: resetValue, index: 1 };
    let enlargeIn = 4;
    let dictSize = 4;
    let numBits = 3;
    let entry = '';
    const result = [];
    let w;

    function readBits(count) {
      let bits = 0;
      let power = 1;
      const maxPower = 1 << count;
      while (power !== maxPower) {
        const resb = data.val & data.position;
        data.position >>= 1;
        if (data.position === 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        if (resb > 0) bits |= power;
        power <<= 1;
      }
      return bits;
    }

    for (let i = 0; i < 3; i += 1) dictionary[i] = i;
    const next = readBits(2);
    let c;
    if (next === 0) c = String.fromCharCode(readBits(8));
    else if (next === 1) c = String.fromCharCode(readBits(16));
    else return '';
    dictionary[3] = c;
    w = c;
    result.push(c);

    while (true) {
      if (data.index > length) return '';
      let code = readBits(numBits);
      if (code === 0) {
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        code = dictSize - 1;
        enlargeIn -= 1;
      } else if (code === 1) {
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        code = dictSize - 1;
        enlargeIn -= 1;
      } else if (code === 2) {
        return result.join('');
      }

      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits += 1;
      }
      if (dictionary[code] != null) entry = dictionary[code];
      else if (code === dictSize) entry = w + w.charAt(0);
      else return null;
      result.push(entry);
      dictionary[dictSize++] = w + entry.charAt(0);
      enlargeIn -= 1;
      w = entry;
      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits += 1;
      }
    }
  }

  const status = {
    present: false,
    codec: null,
    originalChars: null,
    storedChars: null,
    persistFailure: null
  };
  let lastEnvelope = null;
  let lastDecoded = null;

  const StorageCtor = global.Storage;
  const prototype = StorageCtor?.prototype;
  const rawGet = prototype?.getItem
    ? (target, key) => prototype.__taskPointsPhase3CodecOriginalGetItem.call(target, key)
    : (target, key) => target.__taskPointsPhase3CodecOriginalGetItem.call(target, key);
  const rawSet = prototype?.setItem
    ? (target, key, value) => prototype.__taskPointsPhase3CodecOriginalSetItem.call(target, key, value)
    : (target, key, value) => target.__taskPointsPhase3CodecOriginalSetItem.call(target, key, value);
  const rawRemove = prototype?.removeItem
    ? (target, key) => prototype.__taskPointsPhase3CodecOriginalRemoveItem.call(target, key)
    : (target, key) => target.__taskPointsPhase3CodecOriginalRemoveItem.call(target, key);

  function updateStatus(patch) {
    Object.assign(status, patch);
  }

  function invalidate(failure) {
    lastEnvelope = null;
    lastDecoded = null;
    try { rawRemove(storage, SESSION_CACHE_KEY); } catch (_) {}
    updateStatus({
      present: false,
      codec: null,
      originalChars: null,
      storedChars: null,
      persistFailure: failure || null
    });
  }

  function encodeRecord(rawValue) {
    const original = String(rawValue);
    let record;
    try { record = JSON.parse(original); } catch (_) { throw new Error('source_json_invalid'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('source_record_invalid');
    const payload = compressToUTF16(original);
    if (!payload || (original && !payload)) throw new Error('compression_failed');
    const envelope = JSON.stringify({
      schemaVersion: ENVELOPE_VERSION,
      codec: CODEC_ID,
      originalChars: original.length,
      compressedChars: payload.length,
      sourceHash: record.sourceHash ?? null,
      destinationHash: record.destinationHash ?? null,
      sourceCounts: record.sourceCounts ?? null,
      destinationCounts: record.destinationCounts ?? null,
      verifiedAt: record.verifiedAt ?? null,
      payload
    });
    return { envelope, original, payloadChars: payload.length };
  }

  function decodeEnvelope(envelope) {
    if (envelope === lastEnvelope && lastDecoded !== null) return lastDecoded;
    let parsed;
    try { parsed = JSON.parse(envelope); } catch (_) { throw new Error('malformed_envelope'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('malformed_envelope');
    if (parsed.schemaVersion !== ENVELOPE_VERSION) throw new Error('unsupported_version');
    if (parsed.codec !== CODEC_ID) throw new Error('unsupported_codec');
    if (!Number.isInteger(parsed.originalChars) || parsed.originalChars < 0) throw new Error('invalid_original_length');
    if (!Number.isInteger(parsed.compressedChars) || parsed.compressedChars < 1) throw new Error('invalid_compressed_length');
    if (typeof parsed.payload !== 'string' || parsed.payload.length !== parsed.compressedChars) throw new Error('truncated_payload');
    let decoded;
    try { decoded = decompressFromUTF16(parsed.payload); } catch (_) { throw new Error('decompression_failed'); }
    if (typeof decoded !== 'string') throw new Error('decompression_failed');
    if (decoded.length !== parsed.originalChars) throw new Error('original_length_mismatch');
    let record;
    try { record = JSON.parse(decoded); } catch (_) { throw new Error('decoded_json_invalid'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('decoded_record_invalid');
    if (parsed.sourceHash !== (record.sourceHash ?? null)
      || parsed.destinationHash !== (record.destinationHash ?? null)
      || JSON.stringify(parsed.sourceCounts) !== JSON.stringify(record.sourceCounts ?? null)
      || JSON.stringify(parsed.destinationCounts) !== JSON.stringify(record.destinationCounts ?? null)
      || parsed.verifiedAt !== (record.verifiedAt ?? null)) {
      throw new Error('envelope_metadata_mismatch');
    }
    lastEnvelope = envelope;
    lastDecoded = decoded;
    updateStatus({
      present: true,
      codec: CODEC_ID,
      originalChars: parsed.originalChars,
      storedChars: envelope.length,
      persistFailure: null
    });
    return decoded;
  }

  function interceptedGet(target, key) {
    if (target !== storage || String(key) !== SESSION_CACHE_KEY) return rawGet(target, key);
    const envelope = rawGet(target, key);
    if (envelope === null) {
      updateStatus({ present: false, codec: null, originalChars: null, storedChars: null });
      return null;
    }
    try {
      return decodeEnvelope(String(envelope));
    } catch (error) {
      invalidate(error?.message || 'decode_failed');
      return null;
    }
  }

  function interceptedSet(target, key, value) {
    if (target !== storage || String(key) !== SESSION_CACHE_KEY) return rawSet(target, key, value);
    let encoded;
    try {
      encoded = encodeRecord(value);
    } catch (error) {
      invalidate(error?.message || 'compression_failed');
      throw error;
    }
    try {
      rawSet(target, key, encoded.envelope);
      lastEnvelope = encoded.envelope;
      lastDecoded = encoded.original;
      updateStatus({
        present: true,
        codec: CODEC_ID,
        originalChars: encoded.original.length,
        storedChars: encoded.envelope.length,
        persistFailure: null
      });
    } catch (error) {
      invalidate(error?.name === 'QuotaExceededError' ? 'quota_exceeded' : 'storage_write_failed');
      throw error;
    }
  }

  function interceptedRemove(target, key) {
    const result = rawRemove(target, key);
    if (target === storage && String(key) === SESSION_CACHE_KEY) {
      lastEnvelope = null;
      lastDecoded = null;
      updateStatus({ present: false, codec: null, originalChars: null, storedChars: null, persistFailure: null });
    }
    return result;
  }

  function installHooks() {
    if (prototype?.getItem && prototype?.setItem && prototype?.removeItem) {
      try {
        if (!prototype.__taskPointsPhase3CodecOriginalGetItem) {
          Object.defineProperties(prototype, {
            __taskPointsPhase3CodecOriginalGetItem: { value: prototype.getItem, configurable: true },
            __taskPointsPhase3CodecOriginalSetItem: { value: prototype.setItem, configurable: true },
            __taskPointsPhase3CodecOriginalRemoveItem: { value: prototype.removeItem, configurable: true }
          });
          prototype.getItem = function taskPointsPhase3CodecGetItem(key) { return interceptedGet(this, key); };
          prototype.setItem = function taskPointsPhase3CodecSetItem(key, value) { return interceptedSet(this, key, value); };
          prototype.removeItem = function taskPointsPhase3CodecRemoveItem(key) { return interceptedRemove(this, key); };
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    if (storage.__taskPointsPhase3CodecOriginalGetItem) return true;
    try {
      Object.defineProperties(storage, {
        __taskPointsPhase3CodecOriginalGetItem: { value: storage.getItem.bind(storage), configurable: true },
        __taskPointsPhase3CodecOriginalSetItem: { value: storage.setItem.bind(storage), configurable: true },
        __taskPointsPhase3CodecOriginalRemoveItem: { value: storage.removeItem.bind(storage), configurable: true }
      });
      storage.getItem = function taskPointsPhase3CodecGetItem(key) { return interceptedGet(storage, key); };
      storage.setItem = function taskPointsPhase3CodecSetItem(key, value) { return interceptedSet(storage, key, value); };
      storage.removeItem = function taskPointsPhase3CodecRemoveItem(key) { return interceptedRemove(storage, key); };
      return true;
    } catch (_) {
      return false;
    }
  }

  if (!installHooks()) return;
  core.__phase3SessionCodecInstalled = true;
  core.PHASE3_SESSION_CACHE_CODEC = CODEC_ID;
  core.getPhase3SessionCodecStatus = () => ({ ...status });

  const originalGetStatus = typeof core.getPhase3ReadStatus === 'function' ? core.getPhase3ReadStatus : null;
  if (originalGetStatus) {
    core.getPhase3ReadStatus = function phase3CodecStatus(...args) {
      const decorate = (value) => ({
        ...(value && typeof value === 'object' ? value : {}),
        sessionCacheCodec: status.codec,
        sessionCacheOriginalChars: status.originalChars,
        sessionCacheStoredChars: status.storedChars,
        sessionCachePersistFailure: status.persistFailure
      });
      const result = originalGetStatus.apply(core, args);
      return result && typeof result.then === 'function' ? result.then(decorate) : decorate(result);
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
