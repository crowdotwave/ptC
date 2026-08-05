// Single source of truth for the table shapes described in CLAUDE.md.
//
// The storage adapter, the IndexedDB driver, and the seed module all read this file so that
// a schema change lands in exactly one place. Field types here are coarse on purpose: this
// is a prototype guard against typos and stray columns, not a database.
//
// Every table implicitly carries:
//   id          uuid, primary key, generated client side with crypto.randomUUID()
//   created_at  timestamptz, when the row was written
//   updated_at  timestamptz, only on mutable tables, used for last write wins

export const TYPES = {
  UUID: 'uuid',
  TEXT: 'text',
  INT: 'int',
  NUMERIC: 'numeric',
  BOOL: 'bool',
  TS: 'timestamptz',
  DATE: 'date',
  JSON: 'json',
};

const { UUID, TEXT, INT, NUMERIC, BOOL, TS, DATE, JSON: JSONB } = TYPES;

// nullable: true means the column accepts null. Absent means not null.
export const TABLES = {
  trainers: {
    appendOnly: false,
    indexes: ['auth_user_id'],
    fields: {
      auth_user_id: { type: UUID, nullable: true },
      display_name: { type: TEXT },
      brand_color: { type: TEXT },
      logo_url: { type: TEXT, nullable: true },
      weight_unit: { type: TEXT, enum: ['kg', 'lb'] },
    },
  },

  clients: {
    appendOnly: false,
    indexes: ['trainer_id', 'auth_user_id', 'email', 'status'],
    fields: {
      trainer_id: { type: UUID, ref: 'trainers' },
      // Null until the person accepts. Set only by the database, on an email match with a new
      // auth user, and never writable by the app. That is what stops a bound row from being
      // reopened and rebound to somebody else.
      auth_user_id: { type: UUID, nullable: true },
      display_name: { type: TEXT },
      // The binding key. Supabase sends the invite here and the trigger matches on it, so a
      // client row can exist, be programmed, and be assigned long before anyone signs up.
      email: { type: TEXT },
      status: { type: TEXT, enum: ['invited', 'active', 'archived'] },
      weight_unit: { type: TEXT, enum: ['kg', 'lb'] },
    },
  },

  exercises: {
    appendOnly: false,
    indexes: ['trainer_id', 'slug', 'is_global'],
    fields: {
      trainer_id: { type: UUID, nullable: true, ref: 'trainers' },
      name: { type: TEXT },
      slug: { type: TEXT },
      primary_muscle: { type: TEXT },
      equipment: { type: TEXT },
      media_url: { type: TEXT, nullable: true },
      is_global: { type: BOOL },
      // Smallest load change this lift can actually make, in kilograms. A barbell moves in
      // 2.5 with the smallest pair of plates, a stack moves a whole plate at a time, and a
      // dumbbell rack jumps in whatever the rack was bought in. The stepper reads this, so a
      // global constant would offer the client weights the gym cannot make.
      increment_kg: { type: NUMERIC },
    },
  },

  program_templates: {
    appendOnly: false,
    indexes: ['trainer_id'],
    fields: {
      trainer_id: { type: UUID, ref: 'trainers' },
      name: { type: TEXT },
      notes: { type: TEXT },
      archived_at: { type: TS, nullable: true },
    },
  },

  template_days: {
    appendOnly: false,
    indexes: ['template_id'],
    fields: {
      template_id: { type: UUID, ref: 'program_templates' },
      day_index: { type: INT },
      name: { type: TEXT },
      // The two labels on the trainer's own sheet: STRENGTH, CARDIO, ENDURANCE, ATHLETIC,
      // HIGH VOLUME, and the split beside it. Kept as free text because it is the trainer's
      // vocabulary, not ours, and a fixed enum would start rejecting their words.
      day_type: { type: TEXT, nullable: true },
      split: { type: TEXT, nullable: true },
      // The three warm up columns, shown and never logged. Nobody is ticking off a tibia
      // raise, so this is instruction rather than data.
      // { mobility: [], general: [], specific: [] }
      warmup: { type: JSONB },
      // The Comments block under each day. Coaching cues, one line each.
      comments: { type: TEXT },
    },
  },

  template_items: {
    appendOnly: false,
    indexes: ['day_id', 'exercise_id'],
    fields: {
      day_id: { type: UUID, ref: 'template_days' },
      exercise_id: { type: UUID, ref: 'exercises' },
      order_index: { type: INT },
      // The trainer's own set number. '1', '2', but also '1A', '1B', '2C' where a superset or
      // a circuit groups rows together. Rows sharing a leading number are one group.
      group_label: { type: TEXT, nullable: true },
      // The Adjust column: BARBELL, CABLE, MED GRIP, SIT/STAND, TREAD, SPEED, HEIGHT. A
      // modifier on the exercise for this program, not a property of the exercise itself.
      variation: { type: TEXT, nullable: true },
      // Nullable because the sheet says NA on 14 rows of 61: the stair master, the cardio
      // intervals, and every row of a six minute AMRAP.
      target_sets: { type: INT, nullable: true },
      // Nullable for the same reason, plus the 16 rows whose Reps cell is a distance or a
      // duration rather than a count. target_reps_text always carries what the trainer typed.
      target_reps_low: { type: INT, nullable: true },
      target_reps_high: { type: INT, nullable: true },
      target_reps_text: { type: TEXT, nullable: true },
      // What the trainer actually prescribes. Across 61 real rows this was RIR on 37 of them
      // and never once a weight, so the numeric target_rpe is derived where it can be and the
      // text is what gets shown.
      target_load: { type: TEXT, nullable: true },
      target_rpe: { type: NUMERIC, nullable: true },
      rest_seconds: { type: INT, nullable: true },
      notes: { type: TEXT },
      // Whether the client logs this row at all. False for cardio intervals and anything else
      // where a number would be invented rather than measured.
      is_logged: { type: BOOL },
      // How it is logged when it is.
      //   weight_reps      the normal case, a weight and a rep count
      //   weight_only      a carry or a sled, where the load matters and reps do not apply
      //   rounds           an AMRAP, where the client records rounds completed and the load used
      //   bodyweight_reps  a pushup or a pullup. Reps only, and deliberately no weight.
      //   time_hold        an L sit or a hollow body. Seconds only, and no reps at all.
      //
      // bodyweight_reps exists rather than weight_reps with a zero weight because a zero would
      // be arithmetic rather than a fact: volume would come out zero and Epley would report an
      // estimated 1RM of zero, so a client getting visibly stronger would watch a flat line at
      // the bottom of the chart. The honest series for these is the rep count itself.
      //
      // Recording bodyweight instead was considered and rejected. CLAUDE.md makes body weight
      // opt in and off by default, so multiplying every pushup by it would make the one number
      // this product refuses to lead with a required input for logging a set.
      log_mode: {
        type: TEXT,
        enum: ['weight_reps', 'weight_only', 'rounds', 'bodyweight_reps', 'time_hold'],
      },
      // What to put on the bar the first time this client does this lift, set by the trainer
      // when building the program. Used only when the client has no history for the exercise,
      // and never again after that. Null means the trainer did not say, which is a real answer
      // for a client nobody has seen lift yet. See js/prefill.js for what happens then.
      starting_weight_kg: { type: NUMERIC, nullable: true },
    },
  },

  assignments: {
    appendOnly: false,
    indexes: ['client_id', 'template_id'],
    fields: {
      client_id: { type: UUID, ref: 'clients' },
      template_id: { type: UUID, ref: 'program_templates' },
      // Frozen copy of the whole program at assign time. Editing the template must never
      // rewrite what a client was already told to do.
      snapshot: { type: JSONB },
      starts_on: { type: DATE },
      ends_on: { type: DATE, nullable: true },
      // Week indices, counted from starts_on, that the trainer has marked as planned back off
      // weeks. Empty by default and never required at assign time: the trainer marks a week
      // whenever they notice, including months later, from the client's chart.
      //
      // Trainer marked rather than inferred. A drop cannot be told apart from a bad week until
      // the client comes back and lifts heavy again, so an inferred label arrives a week late,
      // which is a week after the client needed to read the dip as intentional.
      deload_weeks: { type: JSONB },
    },
  },

  sessions: {
    appendOnly: false,
    indexes: ['client_id', 'assignment_id', 'started_at'],
    fields: {
      client_id: { type: UUID, ref: 'clients' },
      assignment_id: { type: UUID, nullable: true, ref: 'assignments' },
      day_index: { type: INT },
      started_at: { type: TS },
      completed_at: { type: TS, nullable: true },
      client_note: { type: TEXT, nullable: true },
    },
  },

  // APPEND ONLY. A correction writes a new row with supersedes_id pointing at the old one.
  // The adapter rejects updates and deletes against this table.
  set_logs: {
    appendOnly: true,
    indexes: ['session_id', 'exercise_id', 'logged_at', 'supersedes_id'],
    fields: {
      session_id: { type: UUID, ref: 'sessions' },
      exercise_id: { type: UUID, ref: 'exercises' },
      set_index: { type: INT },
      // Always kilograms. Pounds are a display conversion only.
      weight_kg: { type: NUMERIC },
      // Null on a carry or a sled, where the load is the whole point and there are no reps to
      // count. Anything that computes volume or an estimated 1RM skips these rows rather than
      // inventing a number for them.
      //
      // Numeric, not an integer, because a half rep is a real thing people write down: the rep
      // that got most of the way up. Rounding it away throws out the difference between a
      // session that improved and one that did not, and rounding it up invents a rep nobody
      // completed. Epley and volume are both indifferent to it.
      reps: { type: NUMERIC, nullable: true },
      // Rounds completed in an AMRAP block. Null everywhere else.
      rounds: { type: INT, nullable: true },
      // How long a hold lasted, in seconds. An L sit and a hollow body have no reps and no
      // load, so this is the whole of what happened. Null everywhere else.
      hold_seconds: { type: NUMERIC, nullable: true },
      rpe: { type: NUMERIC, nullable: true },
      is_warmup: { type: BOOL },
      logged_at: { type: TS },
      supersedes_id: { type: UUID, nullable: true, ref: 'set_logs' },
      // Undo cannot delete a row here, so a retraction is a new row that supersedes the one
      // being taken back and marks itself void. The set stays in the audit trail, it just
      // stops counting. A correction, which keeps the set but fixes its numbers, is the same
      // shape with is_void false.
      is_void: { type: BOOL },
      // True when the client added this set beyond what the program asked for. Recorded here
      // rather than inferred from assignments.snapshot, because the chart has to separate
      // prescribed volume from extra volume on every row it reads, and because whether a set
      // was part of the plan is a fact about the moment it was logged.
      is_extra: { type: BOOL },
      device_id: { type: TEXT },
    },
  },

  payments: {
    appendOnly: false,
    indexes: ['trainer_id', 'client_id', 'paid_on'],
    fields: {
      trainer_id: { type: UUID, ref: 'trainers' },
      client_id: { type: UUID, nullable: true, ref: 'clients' },
      // Denormalized on purpose. Tax records outlive a deleted client.
      client_name_text: { type: TEXT },
      paid_on: { type: DATE },
      amount_cents: { type: INT },
      currency: { type: TEXT },
      method: { type: TEXT, enum: ['e-transfer', 'cash', 'cheque', 'other'] },
      note: { type: TEXT, nullable: true },
    },
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

// Internal stores. Not part of the domain schema and never synced as rows.
export const OUTBOX_STORE = '_outbox';
export const META_STORE = '_meta';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function typeOk(type, value) {
  switch (type) {
    case TYPES.UUID:
      return typeof value === 'string' && UUID_RE.test(value);
    case TYPES.TEXT:
      return typeof value === 'string';
    case TYPES.INT:
      return Number.isInteger(value);
    case TYPES.NUMERIC:
      return typeof value === 'number' && Number.isFinite(value);
    case TYPES.BOOL:
      return typeof value === 'boolean';
    case TYPES.TS:
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case TYPES.DATE:
      return typeof value === 'string' && DATE_RE.test(value);
    case TYPES.JSON:
      return value !== undefined;
    default:
      return false;
  }
}

/**
 * Throws on anything that would quietly corrupt the schema: unknown columns, missing
 * columns, wrong coarse type, null in a not-null column, value outside an enum.
 * Returns a normalized copy with the column order defined above.
 */
export function validate(table, record) {
  const def = TABLES[table];
  if (!def) throw new Error(`Unknown table: ${table}`);
  if (!record || typeof record !== 'object') {
    throw new Error(`${table}: record must be an object`);
  }

  const known = new Set(['id', 'created_at', 'updated_at', ...Object.keys(def.fields)]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`${table}: unknown column "${key}"`);
  }

  if (!typeOk(TYPES.UUID, record.id)) {
    throw new Error(`${table}: id must be a client generated uuid, got ${record.id}`);
  }
  if (!typeOk(TYPES.TS, record.created_at)) {
    throw new Error(`${table}: created_at must be an ISO timestamp`);
  }
  if (!def.appendOnly && !typeOk(TYPES.TS, record.updated_at)) {
    throw new Error(`${table}: updated_at must be an ISO timestamp`);
  }

  const out = { id: record.id, created_at: record.created_at };
  if (!def.appendOnly) out.updated_at = record.updated_at;

  for (const [name, spec] of Object.entries(def.fields)) {
    const value = record[name];
    if (value === undefined) throw new Error(`${table}: missing column "${name}"`);
    if (value === null) {
      if (!spec.nullable) throw new Error(`${table}.${name} is not nullable`);
      out[name] = null;
      continue;
    }
    if (!typeOk(spec.type, value)) {
      throw new Error(`${table}.${name} expected ${spec.type}, got ${JSON.stringify(value)}`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${table}.${name} must be one of ${spec.enum.join(', ')}`);
    }
    out[name] = value;
  }

  return out;
}
