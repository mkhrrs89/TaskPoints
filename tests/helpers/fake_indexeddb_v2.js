'use strict';

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function cloneMap(source) {
  return new Map(Array.from(source.entries(), ([key, value]) => [key, clone(value)]));
}

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }

  getItem(key) {
    const normalized = String(key);
    return this.rows.has(normalized) ? this.rows.get(normalized) : null;
  }

  setItem(key, value) {
    this.rows.set(String(key), String(value));
  }

  removeItem(key) {
    this.rows.delete(String(key));
  }
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.storeNames = [...storeNames];
    this.mode = mode || 'readonly';
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this._pending = 0;
    this._finished = false;
    this._aborted = false;
    this._finishVersion = 0;
    this._working = new Map();

    if (this.mode === 'readwrite' || this.mode === 'versionchange') {
      for (const name of this.storeNames) {
        this._working.set(name, cloneMap(this.db._stores.get(name)));
      }
    }
  }

  objectStore(name) {
    const normalized = String(name);
    if (!this.storeNames.includes(normalized)) throw new Error(`fake_idb_store_not_in_transaction:${normalized}`);
    return new FakeObjectStore(this, normalized);
  }

  abort(error = null) {
    if (this._finished) return;
    this._aborted = true;
    this._finished = true;
    this.error = error || this.error || new Error('fake_idb_transaction_aborted');
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  _mapFor(storeName) {
    if (this.mode === 'readwrite' || this.mode === 'versionchange') return this._working.get(storeName);
    return this.db._stores.get(storeName);
  }

  _beginRequest() {
    if (this._finished) throw new Error('fake_idb_transaction_finished');
    this._pending += 1;
    this._finishVersion += 1;
  }

  _completeRequest() {
    if (this._finished) return;
    this._pending -= 1;
    this._scheduleCompletion();
  }

  _scheduleCompletion() {
    if (this._finished || this._pending !== 0) return;
    const version = ++this._finishVersion;
    queueMicrotask(() => {
      if (this._finished || this._pending !== 0 || version !== this._finishVersion) return;
      this._commit();
    });
  }

  _commit() {
    if (this._finished || this._aborted) return;
    if (this.mode === 'readwrite' || this.mode === 'versionchange') {
      for (const name of this.storeNames) {
        this.db._stores.set(name, cloneMap(this._working.get(name)));
      }
    }
    this._finished = true;
    queueMicrotask(() => this.oncomplete?.({ target: this }));
  }

  _failRequest(request, error) {
    if (this._finished) return;
    request.error = error;
    try {
      request.onerror?.({ target: request });
      this.onerror?.({ target: this });
    } finally {
      this.abort(error);
    }
  }
}

class FakeObjectStore {
  constructor(tx, name) {
    this.tx = tx;
    this.name = name;
  }

  _request(operation, action) {
    const request = new FakeRequest();
    this.tx._beginRequest();
    queueMicrotask(() => {
      if (this.tx._finished) return;
      const forcedError = this.tx.db._owner._consumeFailure(this.name, operation);
      if (forcedError) {
        this.tx._failRequest(request, forcedError);
        return;
      }

      try {
        request.result = clone(action(this.tx._mapFor(this.name)));
        request.onsuccess?.({ target: request });
        this.tx._completeRequest();
      } catch (error) {
        this.tx._failRequest(request, error);
      }
    });
    return request;
  }

  get(key) {
    const normalized = String(key);
    return this._request('get', (map) => map.get(normalized));
  }

  getAll() {
    return this._request('getAll', (map) => Array.from(map.values()));
  }

  put(value) {
    return this._request('put', (map) => {
      if (!value || value.id == null) throw new Error(`fake_idb_missing_key:${this.name}`);
      const key = String(value.id);
      map.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    const normalized = String(key);
    return this._request('delete', (map) => {
      map.delete(normalized);
      return undefined;
    });
  }

  clear() {
    return this._request('clear', (map) => {
      map.clear();
      return undefined;
    });
  }

  get indexNames() {
    const names = this.tx.db._indexes.get(this.name) || new Map();
    return { contains: name => names.has(String(name)), get length() { return names.size; } };
  }

  createIndex(name, keyPath, options = {}) {
    if (this.tx.mode !== 'versionchange') throw Error('fake_index_requires_upgrade');
    const definitions = this.tx.db._indexes.get(this.name);
    const normalized = String(name);
    if (definitions.has(normalized)) throw Error('fake_index_duplicate');
    definitions.set(normalized, { keyPath: String(keyPath), multiEntry: options.multiEntry === true });
    return this.index(normalized);
  }

  index(name) {
    const definition = this.tx.db._indexes.get(this.name)?.get(String(name));
    if (!definition) throw Error('fake_index_missing:' + name);
    return {
      getAll: key => this._request('indexGetAll', map => [...map.values()].filter(row => {
        const value = row?.[definition.keyPath];
        return definition.multiEntry ? Array.isArray(value) && value.includes(key) : value === key;
      }).sort((a,b) => String(a.id).localeCompare(String(b.id))))
    };
  }
}

class FakeDatabase {
  constructor(name, version, owner) {
    this.name = name;
    this.version = version;
    this._owner = owner;
    this._stores = new Map();
    this._indexes = new Map();
    this._upgradeTx = null;
  }

  get objectStoreNames() {
    const names = Array.from(this._stores.keys());
    return {
      contains: (name) => this._stores.has(String(name)),
      item: (index) => names[index] ?? null,
      get length() { return names.length; },
      [Symbol.iterator]: function* iterator() { yield* names; }
    };
  }

  createObjectStore(name) {
    const normalized = String(name);
    if (!this._stores.has(normalized)) this._stores.set(normalized, new Map());
    if (!this._indexes.has(normalized)) this._indexes.set(normalized, new Map());
    if (this._upgradeTx && !this._upgradeTx.storeNames.includes(normalized)) {
      this._upgradeTx.storeNames.push(normalized);
      this._upgradeTx._working.set(normalized, new Map());
    }
    return this._upgradeTx ? new FakeObjectStore(this._upgradeTx, normalized) : { name: normalized };
  }

  transaction(storeNames, mode = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames.map(String) : [String(storeNames)];
    for (const name of names) {
      if (!this._stores.has(name)) throw new Error(`fake_idb_unknown_store:${name}`);
    }
    return new FakeTransaction(this, names, mode);
  }

  dump() {
    const out = {};
    for (const [name, rows] of this._stores.entries()) {
      out[name] = Array.from(rows.values())
        .map(clone)
        .sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
    }
    return out;
  }
}

class FakeIndexedDB {
  constructor() {
    this._databases = new Map();
    this._nextFailure = null;
    this.openCalls = [];
  }

  open(name, version = 1) {
    const normalized = String(name);
    const request = new FakeRequest();
    this.openCalls.push({ name: normalized, version: Number(version || 1) });

    queueMicrotask(() => {
      let db = this._databases.get(normalized);
      const isNew = !db;
      const needsUpgrade = isNew || Number(version || 1) > Number(db.version || 0);
      if (!db) {
        db = new FakeDatabase(normalized, Number(version || 1), this);
        this._databases.set(normalized, db);
      }
      request.result = db;
      if (!needsUpgrade) {
        queueMicrotask(() => request.onsuccess?.({ target: request }));
        return;
      }
      const priorVersion = db.version;
      const priorStores = new Map([...db._stores].map(([k,v])=>[k, cloneMap(v)]));
      const priorIndexes = new Map([...db._indexes].map(([k,v])=>[k,
        new Map([...v].map(([i,definition])=>[i,{...definition}]))]));
      const tx = new FakeTransaction(db, [...db._stores.keys()], 'versionchange');
      db._upgradeTx = tx;
      request.transaction = tx;
      db.version = Number(version || 1);
      const rollback = error => {
        db._stores = priorStores;
        db._indexes = priorIndexes;
        db.version = priorVersion;
        db._upgradeTx = null;
        if (isNew) this._databases.delete(normalized);
        request.error = error || tx.error || Error('fake_indexeddb_upgrade_aborted');
        request.onerror?.({target:request});
      };
      tx.onabort = () => rollback(tx.error);
      tx.oncomplete = () => {
        db._upgradeTx = null;
        queueMicrotask(() => request.onsuccess?.({ target: request }));
      };
      try {
        request.onupgradeneeded?.({ target: request });
        if (!tx._aborted) tx._scheduleCompletion();
      } catch (error) {
        tx.abort(error);
      }
    });

    return request;
  }

  failNext({ store, operation = 'put', error = new Error('fake_idb_forced_failure') }) {
    this._nextFailure = {
      store: String(store),
      operation: String(operation),
      error
    };
  }

  _consumeFailure(store, operation) {
    const next = this._nextFailure;
    if (!next) return null;
    if (next.store !== String(store) || next.operation !== String(operation)) return null;
    this._nextFailure = null;
    return next.error;
  }

  databaseNames() {
    return Array.from(this._databases.keys()).sort();
  }

  storeNames(databaseName) {
    const db = this._databases.get(String(databaseName));
    return db ? Array.from(db._stores.keys()).sort() : [];
  }

  dump(databaseName) {
    const db = this._databases.get(String(databaseName));
    return db ? db.dump() : null;
  }
}

module.exports = {
  FakeIndexedDB,
  FakeStorage,
  clone
};
