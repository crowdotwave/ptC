// The Supabase side of the storage adapter.
//
// storage.js owns local writes and the outbox. This owns exactly two verbs, push and pull, and
// is handed to it with setRemote(). No UI module imports this file, and nothing here is on the
// path between a client tapping Log set and that set being on disk.
//
// The shape of everything below is decided by the grants and policies in
// supabase/migrations/0002_rls.sql and 0005_sync.sql, not by convenience. Where a rule looks
// arbitrary it is the database talking.

import { TABLES, TABLE_NAMES } from './schema.js';

// auth_user_id is the binding between a person and their training. 0002 withholds it from every
// role that writes, so sending it turns a legitimate write into a permission error rather than
// a silently dropped field. Stripping it here is the note that migration left for step 4.
const OMIT_ON_WRITE = {
  trainers: ['auth_user_id'],
  clients: ['auth_user_id'],
};

// trainers has a column level select grant, which means `select *` is a hard error rather than a
// filtered result: Postgres expands the star before it checks privileges. Every read below sends
// an explicit column list for that reason, which also guarantees a pulled row has exactly the
// shape schema.js validates.
const OMIT_ON_READ = {
  trainers: ['auth_user_id'],
};

// PostgREST answers at most a page at a time, so every read walks until a short page comes back.
const PAGE = 1000;

function columnsOf(table, omit = []) {
  const def = TABLES[table];
  const names = ['id', 'created_at', ...(def.appendOnly ? [] : ['updated_at']), ...Object.keys(def.fields)];
  return names.filter((name) => !omit.includes(name));
}

/** The payload a write sends: the row, minus whatever this table is not allowed to write. */
export function toWire(table, record) {
  const omit = OMIT_ON_WRITE[table] || [];
  const out = {};
  for (const key of columnsOf(table, omit)) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/**
 * A row off the wire, in the shape schema.js expects.
 *
 * Two jobs. Columns this role cannot read come back absent and are restored as null, which is
 * true rather than convenient: they are all nullable. And numerics arrive as numbers today but
 * PostgREST is entitled to send a numeric as a string, so anything the schema calls a number is
 * coerced rather than trusted.
 */
export function fromWire(table, row) {
  const def = TABLES[table];
  const out = { id: row.id, created_at: row.created_at };
  if (!def.appendOnly) out.updated_at = row.updated_at;

  for (const [name, spec] of Object.entries(def.fields)) {
    const value = row[name];
    if (value === undefined || value === null) {
      out[name] = null;
      continue;
    }
    if ((spec.type === 'numeric' || spec.type === 'int') && typeof value === 'string') {
      out[name] = spec.type === 'int' ? parseInt(value, 10) : Number(value);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Splits the queue into the longest runs that can go in one request: same op, same table. */
export function batchQueue(queue) {
  const batches = [];
  for (const entry of queue) {
    const last = batches[batches.length - 1];
    if (last && last.op === entry.op && last.table === entry.table) last.entries.push(entry);
    else batches.push({ op: entry.op, table: entry.table, entries: [entry] });
  }
  return batches;
}

export function createRemote({ client, storage }) {
  /**
   * Who the signed in user is, answered by the database rather than inferred from what a query
   * happened to return. See the comment on public.whoami() in 0005_sync.sql.
   */
  async function whoami() {
    const { data, error } = await client.rpc('whoami');
    if (error) throw new Error(`whoami failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { role: 'none', trainerId: null, clientId: null, isStaff: false };
    return {
      role: row.actor_role,
      trainerId: row.trainer_id,
      clientId: row.client_id,
      isStaff: row.is_staff === true,
    };
  }

  /**
   * Drains the outbox in order and stops at the first failure.
   *
   * Stopping matters. The queue is causally ordered, so a session insert sits ahead of the set
   * logs that reference it. Skipping a failed entry and carrying on would push children whose
   * parent is not there yet, and every one of those would fail on a foreign key for a reason
   * that has nothing to do with what is actually wrong. One clear error beats fifty derived
   * ones, and the entry stays in the queue carrying the message.
   */
  async function push(queue) {
    let pushed = 0;

    for (const batch of batchQueue(queue)) {
      try {
        if (batch.op === 'delete') {
          const ids = batch.entries.map((entry) => entry.record_id);
          const { error } = await client.from(batch.table).delete().in('id', ids);
          if (error) throw new Error(error.message);
        } else {
          const rows = batch.entries.map((entry) => toWire(batch.table, entry.payload));
          // An append only table takes on conflict do nothing, so a replayed insert is a no-op
          // and the write needs no update privilege anywhere. That is what keeps this path
          // unable to rewrite history even if something upstream tried to.
          const options = TABLES[batch.table].appendOnly
            ? { onConflict: 'id', ignoreDuplicates: true }
            : { onConflict: 'id' };
          const { error } = await client.from(batch.table).upsert(rows, options);
          if (error) throw new Error(error.message);
        }
      } catch (error) {
        await storage._outboxFail(batch.entries[0], error.message);
        return { pushed, blocked: { table: batch.table, op: batch.op, message: error.message } };
      }

      await storage._outboxDone(batch.entries.map((entry) => entry.id));
      pushed += batch.entries.length;
    }

    return { pushed, blocked: null };
  }

  async function fetchAll(table) {
    const select = columnsOf(table, OMIT_ON_READ[table] || []).join(',');
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from(table)
        .select(select)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  /**
   * Replaces the local mirror with what the server says this user can see.
   *
   * A full fetch rather than an incremental one keyed on updated_at. Incremental needs a
   * watermark per table and a tombstone for every delete, because a row that goes away on the
   * server is invisible to a query asking for changes since a timestamp, and would sit in the
   * local mirror forever. At one trainer and a handful of clients the whole dataset is a few
   * hundred kilobytes, so paying for it removes that entire class of bug. Revisit when set_logs
   * passes roughly fifty thousand rows, which is one client training daily for about a decade.
   *
   * Rows still waiting in the outbox are never deleted by reconciliation. They are local truth
   * that the server has not been told about yet, and the sync order is push before pull
   * precisely so that this is rare rather than routine.
   */
  async function pull() {
    const keep = new Set((await storage.pending()).map((entry) => entry.record_id));
    let pulled = 0;

    for (const table of TABLE_NAMES) {
      const serverRows = await fetchAll(table);
      const mapped = serverRows.map((row) => fromWire(table, row));
      await storage._bulkPut(table, mapped);
      pulled += mapped.length;

      const onServer = new Set(mapped.map((row) => row.id));
      const local = await storage.query(table, {});
      const stale = local
        .filter((row) => !onServer.has(row.id) && !keep.has(row.id))
        .map((row) => row.id);
      // Straight to the driver on purpose. This is mirror maintenance, not a domain delete: it
      // must not write an outbox entry telling the server to delete rows the server never had,
      // and it has to work on set_logs, where a domain delete is correctly refused.
      if (stale.length) await storage._mirrorDelete(table, stale);
    }

    return pulled;
  }

  return { whoami, push, pull };
}
