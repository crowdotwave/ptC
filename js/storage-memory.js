// The same adapter, over nothing that survives the tab.
//
// `createStorage(driver)` has always taken its driver as an argument, and until now there was
// exactly one: IndexedDB. This is the second, and it exists so a trainer can walk through a
// client's program without a single row landing anywhere. Not a mode inside the adapter, not a
// flag every write has to remember to check, and not a copy of the logging screen with the writes
// commented out. The screen writes exactly what it always writes, through exactly the same
// interface, and the far end of it is a Map that is thrown away when the tab closes.
//
// That is what makes "it saves nothing" a fact about the shape of the thing rather than a promise
// somebody has to keep. There is no path from here to IndexedDB and none to Supabase: this module
// imports neither, and a rehearsal never has a remote attached, so `push()` and `sync()` drain into
// the same nothing.
//
// It is deliberately not a performance story. Everything is an array scan, because the whole
// database here is one program and whatever a trainer taps out in the next five minutes.

import { TABLE_NAMES, OUTBOX_STORE, META_STORE } from './schema.js';

/**
 * A driver holding every store in memory.
 *
 * Mirrors js/storage-indexeddb.js `createIndexedDbDriver` method for method. Where that one hands
 * back rows from an object store, this one hands back rows from a Map, and both of them return
 * copies rather than the stored object so a caller mutating what it read cannot reach back into
 * the database. IndexedDB gives that for free by serialising; here it has to be done on purpose.
 */
export function createMemoryDriver(seedRows = {}) {
  const stores = new Map();
  for (const name of [...TABLE_NAMES, OUTBOX_STORE]) {
    const rows = new Map();
    for (const row of seedRows[name] ?? []) rows.set(row.id, { ...row });
    stores.set(name, rows);
  }
  const meta = new Map();

  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };

  return {
    // No `db`. The IndexedDB driver exposes one and nothing in the app reads it, so a rehearsal
    // that carried a null there would only make it look like there is a database to reach.

    async get(name, id) {
      const row = store(name).get(id);
      return row ? { ...row } : null;
    },

    /**
     * The index arguments are a FILTER here, not an optimisation, and getting that wrong is silent.
     *
     * `storage.query` picks an indexed field out of the filters, hands it down, and then skips that
     * field when it filters the result in memory, because it has already asked the driver for the
     * matching rows only. So a driver that accepted the index and scanned anyway would answer
     * `query('set_logs', { session_id: x })` with every set log in the database, and every caller
     * would believe it. The IndexedDB driver walks a real index and gets this for free; here it has
     * to be done by hand, and the scan is what makes it free instead.
     */
    async getAll(name, indexField = null, indexValue = undefined) {
      const rows = [...store(name).values()].map((row) => ({ ...row }));
      if (indexField === null || indexValue === undefined) return rows;
      return rows.filter((row) => row[indexField] === indexValue);
    },

    async put(name, record) {
      store(name).set(record.id, { ...record });
      return record;
    },

    async putWithOutbox(name, record, outboxEntry) {
      store(name).set(record.id, { ...record });
      if (outboxEntry) store(OUTBOX_STORE).set(outboxEntry.id, { ...outboxEntry });
      return record;
    },

    async deleteWithOutbox(name, id, outboxEntry) {
      store(name).delete(id);
      if (outboxEntry) store(OUTBOX_STORE).set(outboxEntry.id, { ...outboxEntry });
    },

    async count(name) {
      return store(name).size;
    },

    async bulkPut(name, records) {
      for (const record of records) store(name).set(record.id, { ...record });
      return records.length;
    },

    async deleteRows(name, ids) {
      for (const id of ids) store(name).delete(id);
      return ids.length;
    },

    async clearAll() {
      for (const rows of stores.values()) rows.clear();
      meta.clear();
    },

    async getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },

    async setMeta(key, value) {
      meta.set(key, value);
    },

    close() {},
  };
}
