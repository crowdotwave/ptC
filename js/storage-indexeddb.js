// IndexedDB driver. Knows about object stores and cursors, knows nothing about the domain.
//
// The adapter in storage.js is the only thing that should import this file. UI code never
// touches it, and never touches IndexedDB directly.

import { TABLE_NAMES, TABLES, OUTBOX_STORE, META_STORE } from './schema.js';

export const DB_NAME = 'ptc';

// Bump this whenever MIGRATIONS grows. The two must move together or the new migration never
// runs on a device that already has data.
export const DB_VERSION = 11;

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
  {
    version: 9,
    describe: 'drop half reps back to whole ones on any device that recorded them',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Floor, not round to nearest. 10.5 means ten completed reps and a partial, so rounding it
      // up would write down an eleventh rep nobody finished. Erring low is the same bet the
      // opening weight makes, and it is the only direction that cannot overstate a session.
      //
      // Reads do not re-validate, so a stray half left here would keep charting as 10.5 forever
      // while the schema said integers.
      rewriteRows(tx, 'set_logs', (row) =>
        Number.isFinite(row.reps) && !Number.isInteger(row.reps)
          ? { ...row, reps: Math.max(1, Math.floor(row.reps)) }
          : row,
      );
    },
  },
  {
    version: 10,
    describe: 'add sessions.discarded_at so a session can be thrown away without a delete',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Null means live, and everything already on disk is live. The backfill is still required
      // rather than cosmetic: the validator throws on a missing column, so the next write of an
      // old session row, which is what completing or reopening one is, would fail without it.
      rewriteRows(tx, 'sessions', (row) =>
        row.discarded_at === undefined ? { ...row, discarded_at: null } : row,
      );
    },
  },
  {
    version: 11,
    describe: 'add template_days.emom so a day can be run against a clock',
    up: (db, tx) => {
      ensureStoresFromSchema(db, tx);
      // Null is not an EMOM, and every day already on disk is an ordinary one. Backfilled rather
      // than left absent for the same reason discarded_at was: the validator throws on a missing
      // column, so the next write of an old day row, which is what any builder edit is, would fail.
      rewriteRows(tx, 'template_days', (row) => (row.emom === undefined ? { ...row, emom: null } : row));
    },
  },
];

// How long one read or one write may take before it is treated as stuck rather than slow.
//
// Every operation here finishes in milliseconds on a working device, including a pull's bulk write
// of every set somebody has ever logged. What this exists for is the other case, seen on a
// trainer's iPad running the Home Screen app: after the system file picker had been open, the next
// write never completed and never failed. IndexedDB offers no timeout of its own, so a stuck
// transaction is a promise that never settles, and everything waiting on it waits for good. The
// Create button on the import screen did nothing, the next page stalled on its first read with an
// empty list and a dead Add button, and only closing the app cleared it. The server logs are the
// evidence: that page confirmed who was signed in and then never reached its sync.
export const STALL_MS = 8000;

// Opening gets longer, because an open can carry a migration over every row on the device.
const OPEN_STALL_MS = 20000;

export const STALLED_MESSAGE =
  'Storage on this device stopped responding. Close the app completely and open it again.';

/**
 * A read or write that neither finished nor failed in time. Carries `stalled` so code that cannot
 * import this file, which is all UI code, can still tell it apart from a refusal: a refused write
 * is on the device and waiting for the server, a stalled one is not on the device at all.
 */
export class StorageStalledError extends Error {
  constructor(message = STALLED_MESSAGE) {
    super(message);
    this.name = 'StorageStalledError';
    this.stalled = true;
  }
}

/** Settles with `promise`, or rejects stalled after `ms`, calling `onStall` first. */
function deadline(promise, ms, onStall = null) {
  let timer = null;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onStall) onStall();
      reject(new StorageStalledError());
    }, ms);
  });
  return Promise.race([promise, stalled]).finally(() => clearTimeout(timer));
}

/**
 * Aborted on a stall rather than abandoned, because an abandoned readwrite transaction keeps its
 * stores locked, and a retry on a fresh connection would queue behind the very thing it is trying
 * to get past. Throws if the transaction already finished, which is fine: then there is nothing
 * to free.
 */
function abandon(tx) {
  try {
    tx.abort();
  } catch {
    // Already finished or already aborted.
  }
}

function promisify(request, tx, ms) {
  return deadline(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    ms,
    () => abandon(tx),
  );
}

function txDone(tx, ms) {
  return deadline(
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    }),
    ms,
    () => abandon(tx),
  );
}

/**
 * Worth one fresh connection and one more try. A stall, and the two ways WebKit reports a
 * connection it has lost: InvalidStateError from transaction() on a connection that is closing,
 * and UnknownError ("Connection to Indexed Database server lost"). Anything else is a real answer
 * about the data and goes straight to the caller.
 */
function isLostConnection(error) {
  return (
    error instanceof StorageStalledError ||
    error?.name === 'InvalidStateError' ||
    error?.name === 'UnknownError'
  );
}

export function openDatabase(name = DB_NAME, version = DB_VERSION, { stallMs = OPEN_STALL_MS } = {}) {
  let late = false;
  const opening = new Promise((resolve, reject) => {
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
      // Given up on already, and the caller has moved on. A connection nobody holds would keep the
      // version pinned and block the next open, so it is closed rather than left lying about.
      if (late) {
        db.close();
        return;
      }
      // Another tab opening a newer version must not hang on this one holding the old.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Another tab has this database open at an older version. Close it and reload.'));
  });
  return deadline(opening, stallMs, () => {
    late = true;
  });
}

/**
 * The driver over one connection, and the only place that connection is replaced.
 *
 * `reopen` is how a stuck connection is got past: every operation that stalls, or that finds its
 * connection lost, closes it, opens a fresh one, and tries once more. Once, because a second stall
 * says the storage underneath is stuck rather than this connection, and waiting longer would only
 * put off the one message that helps. Every operation here is safe to run twice: a put writes by
 * id, the outbox entry carries its own id made before the first try, and a delete of a row already
 * gone is a no op. Without `reopen` a stall goes straight to the caller.
 */
export function createIndexedDbDriver(db, { reopen = null, stallMs = STALL_MS } = {}) {
  let conn = db;
  let reopening = null;

  // Several operations stall together when a connection sticks. The first replaces it and the rest
  // wait for that one replacement rather than opening a connection each.
  function reconnect(stale) {
    if (conn !== stale) return Promise.resolve(conn);
    if (!reopening) {
      reopening = (async () => {
        try {
          stale.close();
        } catch {
          // Already closed, which is how some of these arrive.
        }
        conn = await reopen();
        return conn;
      })().finally(() => {
        reopening = null;
      });
    }
    return reopening;
  }

  async function run(op) {
    const current = conn;
    try {
      return await op(current);
    } catch (error) {
      if (!reopen || !isLostConnection(error)) throw error;
      return op(await reconnect(current));
    }
  }

  const read = (on, stores) => on.transaction(stores, 'readonly');
  const write = (on, stores) => on.transaction(stores, 'readwrite');

  return {
    get db() {
      return conn;
    },

    get(store, id) {
      return run(async (on) => {
        const tx = read(on, [store]);
        const row = await promisify(tx.objectStore(store).get(id), tx, stallMs);
        return row ?? null;
      });
    },

    /**
     * Reads rows from a store. When indexField is supplied and the store has that index,
     * the read walks the index instead of scanning. Everything else is filtered in memory,
     * which is fine at prototype scale and keeps the query surface small.
     */
    getAll(store, indexField = null, indexValue = undefined) {
      return run((on) => {
        const tx = read(on, [store]);
        const objectStore = tx.objectStore(store);
        if (indexField && objectStore.indexNames.contains(indexField) && indexValue !== undefined) {
          return promisify(objectStore.index(indexField).getAll(indexValue), tx, stallMs);
        }
        return promisify(objectStore.getAll(), tx, stallMs);
      });
    },

    put(store, record) {
      return run(async (on) => {
        const tx = write(on, [store]);
        tx.objectStore(store).put(record);
        await txDone(tx, stallMs);
        return record;
      });
    },

    /** Writes a domain row and its outbox entry in one transaction so they cannot diverge. */
    putWithOutbox(store, record, outboxEntry) {
      return run(async (on) => {
        const tx = write(on, [store, OUTBOX_STORE]);
        tx.objectStore(store).put(record);
        if (outboxEntry) tx.objectStore(OUTBOX_STORE).put(outboxEntry);
        await txDone(tx, stallMs);
        return record;
      });
    },

    deleteWithOutbox(store, id, outboxEntry) {
      return run(async (on) => {
        const tx = write(on, [store, OUTBOX_STORE]);
        tx.objectStore(store).delete(id);
        if (outboxEntry) tx.objectStore(OUTBOX_STORE).put(outboxEntry);
        await txDone(tx, stallMs);
      });
    },

    count(store) {
      return run((on) => {
        const tx = read(on, [store]);
        return promisify(tx.objectStore(store).count(), tx, stallMs);
      });
    },

    bulkPut(store, records) {
      if (!records.length) return Promise.resolve(0);
      return run(async (on) => {
        const tx = write(on, [store]);
        const objectStore = tx.objectStore(store);
        for (const record of records) objectStore.put(record);
        await txDone(tx, stallMs);
        return records.length;
      });
    },

    /** Deletes rows by id with no outbox entry. Used by sync to maintain the mirror. */
    deleteRows(store, ids) {
      if (!ids.length) return Promise.resolve(0);
      return run(async (on) => {
        const tx = write(on, [store]);
        const objectStore = tx.objectStore(store);
        for (const id of ids) objectStore.delete(id);
        await txDone(tx, stallMs);
        return ids.length;
      });
    },

    clearAll() {
      return run(async (on) => {
        const stores = [...TABLE_NAMES, OUTBOX_STORE, META_STORE];
        const tx = write(on, stores);
        for (const store of stores) tx.objectStore(store).clear();
        await txDone(tx, stallMs);
      });
    },

    getMeta(key) {
      return run(async (on) => {
        const tx = read(on, [META_STORE]);
        const row = await promisify(tx.objectStore(META_STORE).get(key), tx, stallMs);
        return row ? row.value : null;
      });
    },

    setMeta(key, value) {
      return run(async (on) => {
        const tx = write(on, [META_STORE]);
        tx.objectStore(META_STORE).put({ key, value });
        await txDone(tx, stallMs);
      });
    },

    close() {
      conn.close();
    },
  };
}
