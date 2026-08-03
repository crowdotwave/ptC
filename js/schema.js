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
    indexes: ['trainer_id', 'auth_user_id', 'invite_code', 'status'],
    fields: {
      trainer_id: { type: UUID, ref: 'trainers' },
      auth_user_id: { type: UUID, nullable: true },
      display_name: { type: TEXT },
      invite_code: { type: TEXT },
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
    },
  },

  template_items: {
    appendOnly: false,
    indexes: ['day_id', 'exercise_id'],
    fields: {
      day_id: { type: UUID, ref: 'template_days' },
      exercise_id: { type: UUID, ref: 'exercises' },
      order_index: { type: INT },
      target_sets: { type: INT },
      target_reps_low: { type: INT },
      target_reps_high: { type: INT, nullable: true },
      target_rpe: { type: NUMERIC, nullable: true },
      rest_seconds: { type: INT },
      notes: { type: TEXT },
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
      reps: { type: INT },
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
