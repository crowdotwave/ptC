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

/**
 * The newest queued write per row, for one batch.
 *
 * Two puts of the same row inside one batch is ordinary rather than exotic: the builder saves a
 * row as it is edited, so renaming 'Day 1' twice queues it twice. Postgres refuses an
 * INSERT ... ON CONFLICT whose values name the same key more than once, with 'ON CONFLICT DO
 * UPDATE command cannot affect row a second time', and it refuses the whole statement rather
 * than the duplicate. So a second edit of one row used to jam every write behind it.
 *
 * Dropping the older payload is not a loss. Conflict resolution everywhere in this app is last
 * write wins on updated_at, so the newest queued copy is the row. Both outbox entries still
 * clear together, because push clears the batch rather than the rows it sent.
 *
 * Append only tables never reach this: set_logs is written once and never rewritten, so a
 * duplicate there would be a replay of an identical row, which its ignoreDuplicates upsert
 * already handles.
 */
export function collapseDuplicates(entries) {
  const newest = new Map();
  for (const entry of entries) newest.set(entry.record_id, entry);
  return [...newest.values()];
}

/**
 * Tables that must be updated before they are inserted.
 *
 * Both are written by two different people under two different policies: the trainer who owns
 * the row, and the person the row is about changing their own name or unit. An upsert is an
 * INSERT ... ON CONFLICT, and Postgres checks the insert policy's with check before it ever
 * reaches the update path, so the second of those two writers is refused on a row that plainly
 * already exists. A person who is both a trainer and a client of somebody else could never save
 * a preference: their clients row belongs to their coach, so clients_trainer_all rejects it,
 * and clients_self_update never gets consulted.
 *
 * trainers is worse. 0002 requires auth_user_id = auth.uid() to insert one, and OMIT_ON_WRITE
 * strips that column from every write, so the check reads a null the adapter is forbidden to
 * send. A trainer changing their own unit could never sync at all.
 *
 * Every other table has one writer and one policy, and keeps its single round trip.
 */
const UPDATE_FIRST = new Set(['clients', 'trainers']);

/**
 * A refusal the server will repeat forever, however many times it is asked.
 *
 * These are Postgres error codes for a row whose data is wrong: it fails a check constraint, it
 * is missing a not null column, it cannot be parsed into its column's type. Nothing about waiting,
 * reconnecting or pushing the rest of the queue first changes the answer.
 *
 * Everything else is treated as temporary and still stops the queue, which is the right call for
 * the two cases that look similar and are not. A foreign key violation is usually ordering: the
 * parent is further up the same queue, so retrying after it lands succeeds. A permission error is
 * usually an actor that has not resolved yet. Both deserve another go; a check violation never
 * does.
 *
 * Why this distinction has to exist at all: push stops at the first failure to keep the queue
 * causally ordered, so one row the server will never take parks every write behind it forever. A
 * real client sat at 82 unsynced changes for two days behind a single set_logs row carrying reps
 * of zero, and lost nothing only because nobody tapped sign out.
 */
const PERMANENT_REFUSALS = new Set([
  '23514', // check_violation
  '23502', // not_null_violation
  '22P02', // invalid_text_representation
  '22003', // numeric_value_out_of_range
]);

const isPermanent = (error) => PERMANENT_REFUSALS.has(error?.code);

/**
 * A PostgREST error as something that can be thrown without losing why it happened.
 *
 * The code is the whole point. It used to be dropped on the floor here, so every failure arrived
 * at the caller as an indistinguishable message string and the only possible response was to stop.
 */
function refusal(error) {
  const thrown = new Error(error.message);
  thrown.code = error.code;
  thrown.details = error.details;
  return thrown;
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
  /** One batch, or one entry when a batch is being taken apart to find the row the server hates. */
  async function send(table, op, entries) {
    if (op === 'delete') {
      const ids = [...new Set(entries.map((entry) => entry.record_id))];
      const { error } = await client.from(table).delete().in('id', ids);
      if (error) throw refusal(error);
      return;
    }

    const rows = collapseDuplicates(entries).map((entry) => toWire(table, entry.payload));
    if (UPDATE_FIRST.has(table)) {
      await updateThenInsert(table, rows);
      return;
    }
    // An append only table takes on conflict do nothing, so a replayed insert is a no-op and the
    // write needs no update privilege anywhere. That is what keeps this path unable to rewrite
    // history even if something upstream tried to.
    const options = TABLES[table].appendOnly
      ? { onConflict: 'id', ignoreDuplicates: true }
      : { onConflict: 'id' };
    const { error } = await client.from(table).upsert(rows, options);
    if (error) throw refusal(error);
  }

  /**
   * A batch the server refused for good, sent again one row at a time.
   *
   * PostgREST rejects the whole request, so a batch failing says nothing about which row in it was
   * wrong, and a batch is every consecutive write to one table: one client's session was twenty one
   * sets in a single insert. Parking the batch would have thrown away twenty of somebody's working
   * sets to get rid of one bad one, so the batch is taken apart and each row asked for on its own.
   *
   * Returns what landed and what is never going to.
   */
  async function isolate(table, op, entries) {
    let pushed = 0;
    const parked = [];

    for (const entry of entries) {
      try {
        await send(table, op, [entry]);
        await storage._outboxDone([entry.id]);
        pushed += 1;
      } catch (error) {
        if (!isPermanent(error)) {
          // It went temporary partway through, which means the network went rather than the row
          // being wrong. Stop here and leave the rest owed: they are still perfectly good writes.
          await storage._outboxFail(entry, error.message);
          return { pushed, parked, blocked: { table, op, message: error.message } };
        }
        await storage._outboxPark(entry, error.message);
        parked.push({ table, op, recordId: entry.record_id, message: error.message });
      }
    }

    return { pushed, parked, blocked: null };
  }

  /**
   * Drains the outbox in order, stopping at the first failure that is worth stopping for.
   *
   * Stopping matters. The queue is causally ordered, so a session insert sits ahead of the set
   * logs that reference it. Skipping a failed entry and carrying on would push children whose
   * parent is not there yet, and every one of those would fail on a foreign key for a reason
   * that has nothing to do with what is actually wrong. One clear error beats fifty derived
   * ones, and the entry stays in the queue carrying the message.
   *
   * A row the server will never take is the exception, and it has to be, because that rule above
   * turns one of them into a queue that is stopped for good. See PERMANENT_REFUSALS. Such a row is
   * parked rather than dropped: it stays on the device with the reason attached, because throwing
   * away a set nobody has accepted is the one outcome this whole design exists to prevent. What it
   * stops being is owed, so everything behind it can go.
   */
  async function push(queue) {
    let pushed = 0;
    const parked = [];

    for (const batch of batchQueue(queue)) {
      try {
        await send(batch.table, batch.op, batch.entries);
      } catch (error) {
        if (!isPermanent(error)) {
          await storage._outboxFail(batch.entries[0], error.message);
          return { pushed, parked, blocked: { table: batch.table, op: batch.op, message: error.message } };
        }

        const apart = await isolate(batch.table, batch.op, batch.entries);
        pushed += apart.pushed;
        parked.push(...apart.parked);
        if (apart.blocked) return { pushed, parked, blocked: apart.blocked };
        continue;
      }

      await storage._outboxDone(batch.entries.map((entry) => entry.id));
      pushed += batch.entries.length;
    }

    return { pushed, parked, blocked: null };
  }

  /**
   * An update, and an insert only if there was nothing to update.
   *
   * The order is the whole point: see UPDATE_FIRST above for which policy refuses what. Zero rows
   * back from the update is the honest signal that the row is new, because the update policy and
   * the select policy on both these tables cover the same rows, so a row this person may edit is
   * a row they can see coming back.
   *
   * A row that exists but belongs to somebody else also returns zero and falls through to the
   * insert, which then fails on the insert policy. That is the correct outcome and the error
   * names the real problem, which is that this device is trying to write a row it does not own.
   */
  async function updateThenInsert(table, rows) {
    for (const row of rows) {
      const { data, error } = await client.from(table).update(row).eq('id', row.id).select('id');
      if (error) throw refusal(error);
      if (data && data.length) continue;

      const { error: insertError } = await client.from(table).insert(row);
      if (insertError) throw refusal(insertError);
    }
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
    // Rows this device is still holding something for. Owed, because the server has not seen the
    // local version yet. Parked, because it never will: a parked entry stops being owed, and if
    // that dropped it out of this set the sweep below would delete the only copy of a set somebody
    // performed. Keeping the payload in the outbox and deleting the row it describes would be the
    // worst of both.
    const held = [...(await storage.pending()), ...(await storage.parked())];
    const keep = new Set(held.map((entry) => entry.record_id));
    let pulled = 0;

    for (const table of TABLE_NAMES) {
      const serverRows = await fetchAll(table);
      const mapped = serverRows.map((row) => fromWire(table, row));

      // A held row is not refreshed from the server, and this used to be the gap in the rule
      // above: `keep` guarded against being deleted and not against being overwritten, so a
      // mirror refresh wrote the server's copy straight over local work every time.
      //
      // What that looks like from a phone: a client moved a session onto the right day, finished
      // it, answered how it went, and every one of those writes sat in a blocked queue. Each boot
      // pulled the stale row back over the top, so for two days the app showed the wrong day and
      // an open session while holding the corrected version the whole time, and the app looked
      // like it had lost the change rather than like it had not sent it yet.
      const fresh = mapped.filter((row) => !keep.has(row.id));
      await storage._bulkPut(table, fresh);
      pulled += fresh.length;

      // Built from everything the server sent, not from what was written. A row held back here is
      // still a row the server has, and leaving it out would mark it stale and delete it.
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
