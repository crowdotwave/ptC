// IndexedDB driver. Knows about object stores and cursors, knows nothing about the domain.
//
// The adapter in storage.js is the only thing that should import this file. UI code never
// touches it, and never touches IndexedDB directly.

import { TABLE_NAMES, TABLES, OUTBOX_STORE, META_STORE } from './schema.js';

export const DB_NAME = 'ptc';

// Bump this whenever MIGRATIONS grows. The two must move together or the new migration never
// runs on a device that already has data.
export const DB_VERSION = 8;

/**
 * Creates any object store or index in schema.js that is missing. Safe to call repeatedly.
 * This covers additive changes only: a new table, or a new index on an existing table.
 */
function ensureStoresFromSchema(db, tx) {
  for (const table of TABLE_NAMES) {
    const store = db.objectStoreNames.contains(table)
      ? tx.objectStore(table)
      : db.createObjectStore(table, { keyPath: 'id' });

    for (const field of TABLES[table].indexes || []) {
      if (!store.indexNames.contains(field)) store.createIndex(field, field);
    }
  }

  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    const outbox = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
    outbox.createIndex('created_at', 'created_at');
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: 'key' });
  }
}

/**
 * Walks every row in a store and rewrites it. The tool a non-additive migration needs:
 * renaming a column, backfilling a new not-null column, changing a stored unit. Runs inside
 * the versionchange transaction, so it either lands completely or not at all.
 */
export function rewriteRows(tx, table, transform) {
  return new Promise((resolve, reject) => {
    const request = tx.objectStore(table).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const next = transform(cursor.value);
      if (next === undefined) cursor.delete();
      else cursor.update(next);
      cursor.continue();
    };
  });
}

/**
 * The migration ladder. Every schema change appends an entry and bumps DB_VERSION. A device
 * opening at version 1 with the app at version 4 runs 2, 3, and 4 in order, inside one
 * versionchange transaction.
 *
 * Additive change: `up: (db, tx) => ensureStoresFromSchema(db, tx)`.
 * Anything else: use rewriteRows to transform the existing rows in the same step. Never
 * rely on schema.js alone for a non-additive change, because the rows already on the device
 * were written under the old shape and nothing re-validates them on read.
 */
const MIGRATIONS = [
  {
    version: 1,
    describe: 'create one object store per table, plus the outbox and meta stores',
    up: (db, tx) => ensureStoresFromSchema(db, tx),
  },
  {
    version: 2,
    describe: 'add set_logs.is_void and backfill it on rows written before undo existed',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // The first non-additive migration. Rows already on the device were written without
      // is_void, and nothing re-validates them on read, so they get the column here or they
      // stay broken forever.
      rewriteRows(tx, 'set_logs', (row) => (row.is_void === undefined ? { ...row, is_void: false } : row));
    },
  },
  {
    version: 3,
    describe: 'add exercises.increment_kg and backfill it from the equipment already on the row',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // The row already knows what it is, so the backfill does not need to guess. A trainer
      // can correct any of these afterwards, which is the point of storing it per exercise.
      const byEquipment = { barbell: 2.5, dumbbell: 2.5, cable: 5, machine: 5 };
      rewriteRows(tx, 'exercises', (row) =>
        row.increment_kg === undefined
          ? { ...row, increment_kg: byEquipment[row.equipment] ?? 2.5 }
          : row,
      );
    },
  },
  {
    version: 4,
    describe: 'add template_items.starting_weight_kg and set_logs.is_extra',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Null, not a number. The trainer has not said, and inventing one here would be exactly
      // the guess the whole starting weight design exists to avoid.
      rewriteRows(tx, 'template_items', (row) =>
        row.starting_weight_kg === undefined ? { ...row, starting_weight_kg: null } : row,
      );
      // Every set logged before add a set existed was prescribed by definition.
      rewriteRows(tx, 'set_logs', (row) =>
        row.is_extra === undefined ? { ...row, is_extra: false } : row,
      );
    },
  },
  {
    version: 5,
    describe: 'add assignments.deload_weeks so a planned back off week has a data source',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Empty, not guessed. Nothing in existing rows says which weeks were planned, and
      // inferring it would label bad weeks as intentional.
      rewriteRows(tx, 'assignments', (row) =>
        row.deload_weeks === undefined ? { ...row, deload_weeks: [] } : row,
      );
    },
  },
  {
    version: 6,
    describe: 'replace clients.invite_code with clients.email, the Supabase auth binding key',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // A dropped column has to actually leave the row, not just stop being read. The
      // validator rejects unknown columns, so a leftover invite_code would fail the next
      // write of any row that still carried it.
      rewriteRows(tx, 'clients', (row) => {
        if (row.email !== undefined && row.invite_code === undefined) return row;
        const { invite_code: _dropped, ...rest } = row;
        return {
          ...rest,
          // No invite code maps to an address, so an unmigrated row gets a placeholder that is
          // obviously not deliverable rather than a guess that might reach a real person.
          email: row.email ?? `unmigrated+${row.id}@invalid`,
        };
      });
    },
  },
  {
    version: 7,
    describe: 'carry what a real trainer actually writes: day labels, warm ups, effort targets',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);

      rewriteRows(tx, 'template_days', (row) =>
        row.warmup === undefined
          ? {
              ...row,
              day_type: row.day_type ?? null,
              split: row.split ?? null,
              warmup: row.warmup ?? { mobility: [], general: [], specific: [] },
              comments: row.comments ?? '',
            }
          : row,
      );

      // Existing seeded rows were all plain sets and reps, so they migrate to the normal
      // logging mode and keep the numbers they already had.
      rewriteRows(tx, 'template_items', (row) => {
        if (row.log_mode !== undefined) return row;
        const low = row.target_reps_low ?? null;
        const high = row.target_reps_high ?? null;
        return {
          ...row,
          group_label: row.group_label ?? null,
          variation: row.variation ?? null,
          target_reps_text:
            row.target_reps_text ?? (low === null ? null : high && high !== low ? `${low}-${high}` : `${low}`),
          target_load: row.target_load ?? (row.target_rpe === null ? null : `RPE ${row.target_rpe}`),
          is_logged: row.is_logged ?? true,
          log_mode: row.log_mode ?? 'weight_reps',
        };
      });

      // reps becomes nullable and rounds appears. Nothing already on disk has either state,
      // so this only widens what a future row may hold.
      rewriteRows(tx, 'set_logs', (row) => (row.rounds === undefined ? { ...row, rounds: null } : row));
    },
  },
  {
    version: 8,
    describe: 'add set_logs.hold_seconds for timed holds',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Null, not zero. Nothing already on disk was a hold, and a zero would read as a hold
      // that lasted no time rather than as an exercise that is not measured in seconds.
      rewriteRows(tx, 'set_logs', (row) =>
        row.hold_seconds === undefined ? { ...row, hold_seconds: null } : row,
      );
    },
  },
];

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function openDatabase(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable. Serve the app over http, not file://'));
      return;
    }
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const from = event.oldVersion;

      // Run only the steps this device has not seen, oldest first.
      for (const migration of MIGRATIONS.filter((m) => m.version > from).sort(
        (a, b) => a.version - b.version,
      )) {
        migration.up(db, tx);
      }

      // A migration that returns a promise cannot be awaited here: the versionchange
      // transaction commits when the handler yields. rewriteRows queues its cursor work
      // synchronously inside tx, which is why it is safe without an await.
      tx.onabort = () => reject(tx.error || new Error(`Migration from version ${from} aborted`));
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab opening a newer version must not hang on this one holding the old.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Another tab has this database open at an older version. Close it and reload.'));
  });
}

export function createIndexedDbDriver(db) {
  function read(stores) {
    return db.transaction(stores, 'readonly');
  }
  function write(stores) {
    return db.transaction(stores, 'readwrite');
  }

  return {
    db,

    async get(store, id) {
      const tx = read([store]);
      const row = await promisify(tx.objectStore(store).get(id));
      return row ?? null;
    },

    /**
     * Reads rows from a store. When indexField is supplied and the store has that index,
     * the read walks the index instead of scanning. Everything else is filtered in memory,
     * which is fine at prototype scale and keeps the query surface small.
     */
    async getAll(store, indexField = null, indexValue = undefined) {
      const tx = read([store]);
      const objectStore = tx.objectStore(store);
      if (indexField && objectStore.indexNames.contains(indexField) && indexValue !== undefined) {
        return promisify(objectStore.index(indexField).getAll(indexValue));
      }
      return promisify(objectStore.getAll());
    },

    async put(store, record) {
      const tx = write([store]);
      tx.objectStore(store).put(record);
      await txDone(tx);
      return record;
    },

    /** Writes a domain row and its outbox entry in one transaction so they cannot diverge. */
    async putWithOutbox(store, record, outboxEntry) {
      const tx = write([store, OUTBOX_STORE]);
      tx.objectStore(store).put(record);
      if (outboxEntry) tx.objectStore(OUTBOX_STORE).put(outboxEntry);
      await txDone(tx);
      return record;
    },

    async deleteWithOutbox(store, id, outboxEntry) {
      const tx = write([store, OUTBOX_STORE]);
      tx.objectStore(store).delete(id);
      if (outboxEntry) tx.objectStore(OUTBOX_STORE).put(outboxEntry);
      await txDone(tx);
    },

    async count(store) {
      const tx = read([store]);
      return promisify(tx.objectStore(store).count());
    },

    async bulkPut(store, records) {
      if (!records.length) return 0;
      const tx = write([store]);
      const objectStore = tx.objectStore(store);
      for (const record of records) objectStore.put(record);
      await txDone(tx);
      return records.length;
    },

    /** Deletes rows by id with no outbox entry. Used by sync to maintain the mirror. */
    async deleteRows(store, ids) {
      if (!ids.length) return 0;
      const tx = write([store]);
      const objectStore = tx.objectStore(store);
      for (const id of ids) objectStore.delete(id);
      await txDone(tx);
      return ids.length;
    },

    async clearAll() {
      const stores = [...TABLE_NAMES, OUTBOX_STORE, META_STORE];
      const tx = write(stores);
      for (const store of stores) tx.objectStore(store).clear();
      await txDone(tx);
    },

    async getMeta(key) {
      const tx = read([META_STORE]);
      const row = await promisify(tx.objectStore(META_STORE).get(key));
      return row ? row.value : null;
    },

    async setMeta(key, value) {
      const tx = write([META_STORE]);
      tx.objectStore(META_STORE).put({ key, value });
      await txDone(tx);
    },

    close() {
      db.close();
    },
  };
}
