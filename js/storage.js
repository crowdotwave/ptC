// The storage adapter. This is the only persistence surface the rest of the app is allowed
// to touch. UI code never imports storage-indexeddb.js and never imports supabase-js.
//
//   storage.get(table, id)
//   storage.query(table, filters, options)
//   storage.put(table, record)        upsert, idempotent by id
//   storage.delete(table, id)
//   storage.sync()                    flush local queue to remote, pull remote changes
//
// Local first: every write lands in IndexedDB and in an outbox queue inside one transaction,
// then returns. Nothing in this file awaits the network. There is no remote backend wired up
// yet, so sync() reports the queue depth and does nothing else. When Supabase arrives it gets
// attached with setRemote() and no caller changes.

import { TABLES, TABLE_NAMES, OUTBOX_STORE, validate } from './schema.js';
import { openDatabase, createIndexedDbDriver } from './storage-indexeddb.js';

const DEVICE_ID_KEY = 'ptc.device_id';

/** Stable per browser identifier, stamped onto every set log for the audit trail. */
export function getDeviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {
    // Private mode with storage denied. A per session id still keeps set logs attributable.
    id = id || crypto.randomUUID();
  }
  return id;
}

export function newId() {
  return crypto.randomUUID();
}

// Outbox replay order has to be stable, so never hand out a timestamp that is not strictly
// after the previous one, even when the clock stands still between two fast writes.
let lastStamp = 0;
export function now() {
  const t = Math.max(Date.now(), lastStamp + 1);
  lastStamp = t;
  return new Date(t).toISOString();
}

/**
 * Builds a schema valid record: client side uuid, created_at, and updated_at on mutable
 * tables. Pass an explicit id to make a seed or an import reproducible.
 */
export function makeRecord(table, fields, { id = newId(), created_at = now() } = {}) {
  const def = TABLES[table];
  if (!def) throw new Error(`Unknown table: ${table}`);
  const record = { id, created_at, ...fields };
  if (!def.appendOnly) record.updated_at = fields.updated_at ?? created_at;
  return validate(table, record);
}

function matchesFilter(value, condition) {
  if (condition === null) return value === null;
  if (Array.isArray(condition)) return condition.includes(value);
  if (condition && typeof condition === 'object') {
    for (const [op, operand] of Object.entries(condition)) {
      switch (op) {
        case 'eq': if (value !== operand) return false; break;
        case 'ne': if (value === operand) return false; break;
        case 'gt': if (!(value > operand)) return false; break;
        case 'gte': if (!(value >= operand)) return false; break;
        case 'lt': if (!(value < operand)) return false; break;
        case 'lte': if (!(value <= operand)) return false; break;
        case 'in': if (!operand.includes(value)) return false; break;
        default: throw new Error(`Unknown filter operator: ${op}`);
      }
    }
    return true;
  }
  return value === condition;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

export function createStorage(driver) {
  let remote = null;

  function outboxEntry(op, table, record) {
    return {
      id: newId(),
      op,
      table,
      record_id: typeof record === 'string' ? record : record.id,
      payload: typeof record === 'string' ? null : record,
      created_at: now(),
    };
  }

  const storage = {
    /** Attaches a remote backend later. Deliberately unused while this is IndexedDB only. */
    setRemote(backend) {
      remote = backend;
    },

    hasRemote() {
      return remote !== null;
    },

    async get(table, id) {
      if (!TABLES[table]) throw new Error(`Unknown table: ${table}`);
      return driver.get(table, id);
    },

    /**
     * filters: { trainer_id: uuid }                 equality
     *          { status: ['active', 'invited'] }    in
     *          { logged_at: { gte: iso, lt: iso } } range
     *          { supersedes_id: null }              is null
     * options: { orderBy, direction: 'asc' | 'desc', limit, offset }
     */
    async query(table, filters = {}, options = {}) {
      if (!TABLES[table]) throw new Error(`Unknown table: ${table}`);

      // Use an index when a single equality filter lines up with one, otherwise scan.
      const indexed = (TABLES[table].indexes || []).find(
        (field) =>
          field in filters &&
          filters[field] !== null &&
          typeof filters[field] !== 'object' &&
          !Array.isArray(filters[field]),
      );

      let rows = indexed
        ? await driver.getAll(table, indexed, filters[indexed])
        : await driver.getAll(table);

      rows = rows.filter((row) =>
        Object.entries(filters).every(([field, condition]) =>
          field === indexed ? true : matchesFilter(row[field] ?? null, condition),
        ),
      );

      const { orderBy, direction = 'asc', limit, offset = 0 } = options;
      if (orderBy) {
        const sign = direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => sign * compare(a[orderBy], b[orderBy]));
      }
      if (offset) rows = rows.slice(offset);
      if (limit !== undefined) rows = rows.slice(0, limit);
      return rows;
    },

    /**
     * Upsert, idempotent by id. Writing the same record twice is a no-op, which is what makes
     * an offline replay safe. On append only tables a second write with different values is
     * rejected: corrections write a new row with supersedes_id instead.
     */
    async put(table, record) {
      const def = TABLES[table];
      if (!def) throw new Error(`Unknown table: ${table}`);

      const next = validate(table, record);

      if (def.appendOnly) {
        const existing = await driver.get(table, next.id);
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(next)) return existing;
          throw new Error(
            `${table} is append only. Write a new row with supersedes_id set to ${next.id} instead of updating it.`,
          );
        }
      }

      await driver.putWithOutbox(table, next, outboxEntry('put', table, next));
      return next;
    },

    async delete(table, id) {
      const def = TABLES[table];
      if (!def) throw new Error(`Unknown table: ${table}`);
      if (def.appendOnly) {
        throw new Error(`${table} is append only and cannot be deleted from.`);
      }
      await driver.deleteWithOutbox(table, id, outboxEntry('delete', table, id));
    },

    /** Pending local writes waiting for a remote, oldest first. */
    async pending() {
      const rows = await driver.getAll(OUTBOX_STORE);
      return rows.sort((a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id));
    },

    /**
     * Flush the local queue to the remote, then pull remote changes. With no remote attached
     * this reports what would be pushed and leaves the queue intact, so nothing is lost.
     *
     * Push before pull, because the local device is the only place an unsynced write exists and
     * a pull reconciles deletions. Reversing the order would let a mirror refresh remove a set
     * the client logged thirty seconds ago in a basement with no signal.
     *
     * Never throws. Sync failing is an ordinary state on a gym floor, and a thrown error here
     * would surface as a broken screen during a set. The result says what happened and the
     * queue keeps everything that did not land.
     */
    async sync() {
      const queue = await storage.pending();
      if (!remote) {
        return { remote: false, pushed: 0, pulled: 0, pending: queue.length, error: null };
      }
      try {
        const { pushed, blocked } = await remote.push(queue);
        if (blocked) {
          return {
            remote: true,
            pushed,
            pulled: 0,
            pending: (await storage.pending()).length,
            error: `${blocked.table}: ${blocked.message}`,
          };
        }
        const pulled = await remote.pull();
        return { remote: true, pushed, pulled, pending: (await storage.pending()).length, error: null };
      } catch (error) {
        return {
          remote: true,
          pushed: 0,
          pulled: 0,
          pending: (await storage.pending()).length,
          error: error.message,
        };
      }
    },

    /** Row counts per table. Used by the shell and by the seed to decide if it should run. */
    async counts() {
      const entries = await Promise.all(
        TABLE_NAMES.map(async (table) => [table, await driver.count(table)]),
      );
      return Object.fromEntries(entries);
    },

    // Escape hatches for the seed and the dev shell. Not for UI code.
    _driver: driver,
    async _bulkPut(table, records) {
      const validated = records.map((record) => validate(table, record));
      return driver.bulkPut(table, validated);
    },
    async _clearAll() {
      return driver.clearAll();
    },

    // ---- outbox maintenance, for the remote adapter only ----

    /** Entries that reached the server and are no longer owed to it. */
    async _outboxDone(ids) {
      return driver.deleteRows(OUTBOX_STORE, ids);
    },

    /**
     * An entry that failed. It stays in the queue, because dropping a write nobody has accepted
     * loses a client's set silently, which is the one outcome this whole design exists to avoid.
     * The count and the message are recorded so a queue stuck on a permanent error can say what
     * is wrong instead of only that it is deep.
     */
    async _outboxFail(entry, message) {
      return driver.put(OUTBOX_STORE, {
        ...entry,
        attempts: (entry.attempts ?? 0) + 1,
        last_error: message,
        last_attempt_at: now(),
      });
    },

    /** Removes rows the server no longer has. No outbox entry, and append only does not apply. */
    async _mirrorDelete(table, ids) {
      if (!TABLES[table]) throw new Error(`Unknown table: ${table}`);
      return driver.deleteRows(table, ids);
    },
    getMeta: (key) => driver.getMeta(key),
    setMeta: (key, value) => driver.setMeta(key, value),
  };

  return storage;
}

let instance = null;

/** Opens the database once per page and hands back the shared adapter. */
export async function openStorage() {
  if (!instance) {
    const db = await openDatabase();
    instance = createStorage(createIndexedDbDriver(db));
  }
  return instance;
}
