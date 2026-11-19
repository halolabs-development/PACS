/* D1890: ciphertext storage and authenticated envelopes. Session, queue and fetch policy belong to the worker. */
(function (root) {
  'use strict';
  const encoder = new TextEncoder();
  const frameAAD = (keyId, uid, path, revision, copy) => `kin-preload-frame|${keyId}|${uid}|${path}|${revision}|${copy}`;
  const studyAAD = (keyId, manifestId) => `kin-preload-study|${keyId}|${manifestId}`;
  async function importKey(raw) {
    try { return await root.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
    finally { raw.fill(0); }
  }
  async function seal(key, data, aad) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, data);
    return { iv, ct };
  }
  function open(key, record, aad) {
    return root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(aad) }, key, record.ct);
  }
  /**
   * B39: the units disk space is given back by, each with the expiry it really has - a study record together with the
   * frames it lists (their expiry is the record's), and each frame no record lists (its own). sweep() below removes the
   * same units when they expire; the worker reclaims another key's units in this order (earliest real expiry first).
   */
  function holdings({ frames, studies }) {
    const units = [], owner = new Map();
    for (const record of studies) {
      const unit = { keyId: record.keyId, expiresAt: record.expiresAt, studies: [record.manifestId], frames: [] };
      units.push(unit);
      for (const id of Array.isArray(record.frameIds) ? record.frameIds : []) owner.set(id, unit);
    }
    for (const frame of frames) {
      const unit = owner.get(frame.entryId);
      if (unit) unit.frames.push(frame.entryId);
      else units.push({ keyId: frame.keyId, expiresAt: frame.expiresAt, studies: [], frames: [frame.entryId] });
    }
    return units;
  }
  function create() {
    let connection, catalog = null;
    const summary = (name, record) => name === 'studies' ? record :
      { entryId: record.entryId, keyId: record.keyId, expiresAt: record.expiresAt, bytes: record.bytes };
    function db() {
      if (!connection) connection = new Promise((resolve, reject) => {
        const request = root.indexedDB.open('kin-preload', 1);
        request.onupgradeneeded = () => {
          for (const [name, keyPath] of [['frames', 'entryId'], ['studies', 'manifestId']]) {
            const store = request.result.createObjectStore(name, { keyPath });
            store.createIndex('byKey', 'keyId');
            store.createIndex('byExpiry', 'expiresAt');
          }
        };
        request.onerror = () => { connection = null; reject(request.error); };
        request.onblocked = () => { connection = null; reject(new Error('IndexedDB blocked')); };
        request.onsuccess = () => {
          const value = request.result;
          value.onversionchange = () => { value.close(); connection = null; catalog = null; };
          resolve(value);
        };
      });
      return connection;
    }
    async function transaction(names, mode, run) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(names, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB aborted'));
        tx.onerror = () => {}; // onabort owns the failed transaction result.
        try { run(tx, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
      });
    }
    return {
      async list(refresh = false) {
        if (catalog && !refresh) return catalog;
        const result = await transaction(['frames', 'studies'], 'readonly', (tx, done) => {
          const result = { frames: [], studies: [] };
          tx.objectStore('studies').getAll().onsuccess = e => { result.studies = e.target.result; };
          const cursor = tx.objectStore('frames').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const { entryId, keyId, expiresAt, bytes } = row.value;
            result.frames.push({ entryId, keyId, expiresAt, bytes });
            row.continue();
          };
          done(result);
        });
        catalog = result;
        return result;
      },
      get(entryId) {
        return transaction(['frames'], 'readonly', (tx, done) => {
          tx.objectStore('frames').get(entryId).onsuccess = e => done(e.target.result || null);
        });
      },
      async write(puts = {}, deletes = {}) {
        await transaction(['frames', 'studies'], 'readwrite', tx => {
          for (const name of ['frames', 'studies']) {
            for (const id of deletes[name] || []) tx.objectStore(name).delete(id);
            for (const record of puts[name] || []) tx.objectStore(name).put(record);
          }
        });
        if (catalog) for (const name of ['frames', 'studies']) {
          const id = name === 'frames' ? 'entryId' : 'manifestId';
          const replaced = new Set([...(deletes[name] || []), ...(puts[name] || []).map(r => r[id])]);
          catalog[name] = catalog[name].filter(r => !replaced.has(r[id])).concat((puts[name] || []).map(r => summary(name, r)));
        }
      },
      /**
       * Expiry without any key (B39; the units of holdings() above). A study record's expiry is its copy's; its `frameIds` (random IDs, no patient data)
       * name its frames, so a used copy's frames live as long as its record - no frame is read or written again when a use
       * moves the expiry. A frame's own expiry (its copy's at the time it was stored) still removes a frame no live record
       * names: an orphan, a record written before frame lists, another account's whose record is gone.
       */
      async sweep(now) {
        const result = { removed: 0, live: new Set(), gone: new Set() };
        await transaction(['frames', 'studies'], 'readwrite', (tx, done) => {
          done(result);
          const studies = tx.objectStore('studies'), frames = tx.objectStore('frames');
          studies.getAll().onsuccess = e => {
            for (const record of e.target.result) {
              const listed = Array.isArray(record.frameIds) ? record.frameIds : [];
              if (record.expiresAt > now) { for (const id of listed) result.live.add(id); continue; }
              studies.delete(record.manifestId); result.removed++;
              for (const id of listed) result.gone.add(id);
            }
            for (const id of result.gone) if (!result.live.has(id)) { frames.delete(id); result.removed++; }
            const request = frames.index('byExpiry').openCursor(root.IDBKeyRange.upperBound(now));
            request.onsuccess = () => {
              const cursor = request.result; if (!cursor) return;
              if (!result.live.has(cursor.primaryKey)) { cursor.delete(); result.removed++; }
              cursor.continue();
            };
          };
        });
        const { live, gone } = result;
        if (catalog) {
          catalog.studies = catalog.studies.filter(r => r.expiresAt > now);
          catalog.frames = catalog.frames.filter(r => live.has(r.entryId) || (r.expiresAt > now && !gone.has(r.entryId)));
        }
        return result.removed;
      },
      async estimate() { return root.navigator?.storage?.estimate ? root.navigator.storage.estimate() : {}; },
    };
  }
  const api = Object.freeze({ create, holdings, seal, open, importKey, frameAAD, studyAAD });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinPreloadDisk = api;
})(globalThis);
