// The frozen program: how one is built, and how one is read.
//
// `assignments.snapshot` is a copy of a whole program taken at assign time. It exists so that
// editing a template never rewrites what a client was already told to do, which makes it the
// shape the logging screen reads, the shape a client reading their own program reads, and the
// shape a trainer previewing their own work has to be shown.
//
// Three callers, and until now the only code that knew how to build one lived inside the seed
// generator, whose output deliberately never ships. Anything real that needed a snapshot would
// have had to reinvent the shape from the schema comments and get it subtly different.
//
// The shape:
//
//   {
//     template: { id, name, notes },
//     days: [{
//       id, day_index, name, day_type, split, warmup, comments,
//       items: [{ ...template_items row, exercise: { id, name, slug, equipment, increment_kg } }]
//     }]
//   }
//
// Every item carries its exercise inline rather than by id alone, and that is not convenience.
// A client can read their own assignment and almost nothing else: 0002_rls.sql gives them no
// reach into `program_templates` and no reach into a trainer's `exercises` rows, so a lift whose
// name is not inside the snapshot is a lift that phone can never name.

/**
 * The exercise fields a snapshot carries, and only these.
 *
 * A whitelist rather than a spread, because this object is copied into every assignment ever
 * written. Spreading the row would mean each new column on `exercises` silently widened every
 * future snapshot, and snapshots are the one thing in the schema nobody can migrate: they are
 * frozen history by definition.
 */
const EXERCISE_FIELDS = ['id', 'name', 'slug', 'equipment', 'increment_kg'];

function frozenExercise(exercise) {
  const frozen = {};
  for (const field of EXERCISE_FIELDS) frozen[field] = exercise[field] ?? null;
  return frozen;
}

/**
 * Freezes a live template into the snapshot an assignment stores.
 *
 * Takes rows exactly as the adapter hands them back: one `program_templates` row, its
 * `template_days`, its `template_items`, and enough of the exercise library to resolve every
 * item. Order is imposed here rather than trusted from the caller, so a snapshot is always in
 * `day_index` and `order_index` order however the rows arrived.
 *
 * Throws when an item names an exercise that is not in `exercises`. A trainer at a desk seeing
 * an error and fixing the row is a good afternoon. A client mid gym reading a blank lift name is
 * the failure this is preventing, and a snapshot is frozen, so it would stay wrong forever.
 */
export function buildSnapshot({ template, days, items, exercises }) {
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));

  return {
    template: { id: template.id, name: template.name, notes: template.notes },
    days: [...days]
      .sort((a, b) => a.day_index - b.day_index)
      .map((day) => ({
        id: day.id,
        day_index: day.day_index,
        name: day.name,
        day_type: day.day_type,
        split: day.split,
        warmup: day.warmup,
        comments: day.comments,
        items: items
          .filter((item) => item.day_id === day.id)
          .sort((a, b) => a.order_index - b.order_index)
          .map((item) => {
            const exercise = byId.get(item.exercise_id);
            if (!exercise) {
              // Named by where it is on the sheet, not by the id it holds. The person reading
              // this has the table open and needs to find one row in it, and a uuid is the one
              // piece of this they cannot search for.
              const where = dayTitle(day);
              const which = item.group_label || `row ${item.order_index + 1}`;
              throw new Error(
                `${where}, ${which} names an exercise that is no longer in the library. ` +
                  'Retype that exercise before assigning this program.',
              );
            }
            return { ...item, exercise: frozenExercise(exercise) };
          }),
      })),
  };
}

/**
 * Whether two snapshots say the same thing, so a screen can tell a stale assignment from a
 * current one.
 *
 * The builder needs this because "is this client on this program" and "is this client on the
 * version of it I am looking at" are different questions, and only the first was ever asked.
 * A trainer who fixed a rest time and assigned again was told "Already on this program" both
 * before and after, which is the same sentence for the two states the trainer came to tell apart.
 *
 * Key order is sorted rather than trusted, and that is the whole reason this is not a
 * JSON.stringify comparison. `assignments.snapshot` is jsonb, and jsonb does not store the text it
 * was given: it parses to a value and re-renders keys in its own order. So a snapshot that has
 * been to the server and back is byte for byte different from the identical object built locally,
 * and a naive compare would mark every synced client stale forever, which is worse than the bug it
 * replaced. `undefined` normalises to null for the same reason: it is what a round trip does to it.
 *
 * `created_at` and `updated_at` are skipped wherever they appear, and that is measured rather than
 * tidy. buildSnapshot spreads a whole `template_items` row into each item, so both columns ride
 * along inside every snapshot, and both move for reasons that are not edits to anybody's training:
 *
 *   - `updated_at` bumps on any write to the row, a save that changed nothing included. Checked
 *     against the live database, one program's assignment differed from its template in this
 *     column and in nothing else, on two items, which would have read as a changed prescription
 *     on a program nobody had touched.
 *   - Both cross the wire in two spellings that are the same instant and different text. A row
 *     written on this device carries toISOString, '2026-08-23T20:25:30.059Z'; the same row pulled
 *     back carries what Postgres renders, '2026-08-23T20:25:30.059974+00:00', because fromWire
 *     passes these two through untouched. So a cache refresh alone could flip every client to
 *     stale, with no edit anywhere.
 *
 * Neither is part of what a client was told to do. A rest time is; when the row was last saved is
 * not, and a screen that says "on an older version" has to mean the prescription.
 */
const BOOKKEEPING = new Set(['created_at', 'updated_at']);

export function sameSnapshot(a, b) {
  return canonical(a) === canonical(b);
}

function canonical(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => !BOOKKEEPING.has(key))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

/**
 * The assignment a client is on right now.
 *
 * Takes the adapter as an argument rather than importing it, so this module stays a description
 * of a shape and nothing that opens a database.
 *
 * Latest `starts_on` wins, which is the same rule the logging screen has always used. It is here
 * so that it stays the same rule: the Programs tab showing one program while the Log tab steps
 * through another would be the app disagreeing with itself about what somebody is meant to do
 * today.
 *
 * Ties on `starts_on` go to whichever was written last. That case is not exotic, it is what a
 * trainer produces the moment they correct a program they have already handed out: assign, spot
 * something in the editor, fix it, assign again, all inside one afternoon and all carrying today's
 * date. Before this the two rows were separated by nothing, so a single column sort with a limit
 * of one returned whichever the storage happened to hand back first, and the client could go on
 * training from the snapshot that had just been superseded.
 */
export async function currentAssignment(storage, clientId) {
  const rows = await storage.query('assignments', { client_id: clientId });
  if (!rows.length) return null;

  // Ordered here rather than by the adapter, which sorts on one column and cannot express the
  // tie break below. The row count is a client's blocks over months, so reading them all is
  // cheaper than the bug was.
  return rows.reduce((best, row) => {
    if (row.starts_on !== best.starts_on) return row.starts_on > best.starts_on ? row : best;
    return assignedAt(row) > assignedAt(best) ? row : best;
  });
}

/**
 * When an assignment was handed out, as an instant.
 *
 * created_at rather than updated_at, and that is the whole reason this is a function. An
 * assignment row is updated long after it is handed out, every time a trainer marks a back off
 * week from the client's chart, so ordering on updated_at would let marking a deload on an old
 * block promote it over the block the client is actually doing.
 *
 * Parsing is careful because created_at reaches this module in two different formats that do not
 * sort against each other. A row written on this device carries new Date().toISOString(),
 * '2026-08-05T06:11:58.048Z'. A row that has come back from the server carries what Postgres
 * renders, '2026-08-05 06:11:58.048006+00', which fromWire passes through untouched. A space is
 * 0x20 and a T is 0x54, so comparing them as text puts every synced row before every local one
 * whatever the clock says, which is the exact failure this tie break exists to fix.
 *
 * The normalising is measured rather than assumed, and it is not the obvious version: Date.parse
 * accepts the raw Postgres string through a lenient path, and REJECTS it once the space becomes a
 * T, because six fractional digits and a bare '+00' offset are both outside the ISO grammar the
 * strict path uses. So the fraction is cut to three and the offset given its minutes, and the raw
 * string stays as the fallback for anything this does not recognise.
 */
function assignedAt(assignment) {
  const text = String(assignment?.created_at ?? '').trim();
  if (!text) return 0;
  const iso = text
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const at = Date.parse(iso);
  if (!Number.isNaN(at)) return at;
  const raw = Date.parse(text);
  return Number.isNaN(raw) ? 0 : raw;
}

/**
 * The days of a snapshot in the order the trainer put them in.
 *
 * Tolerant of a snapshot with nothing in it, for the reason app.js gives where it reaches into
 * one with optional chaining: a snapshot is frozen JSON that the seed, the builder, an importer,
 * or a hand edit can all have written, and one missing field must not take a screen down.
 */
export function sortedDays(snapshot) {
  return [...(snapshot?.days ?? [])].sort((a, b) => a.day_index - b.day_index);
}

/** The exercises of one day, in the order the trainer put them in. */
export function sortedItems(day) {
  return [...(day?.items ?? [])].sort((a, b) => a.order_index - b.order_index);
}

/**
 * What to call a day, in the trainer's own words where they gave any.
 *
 * The split first, because that is what the trainer scans for and what the day picker on the
 * logging screen shows. The name second, since the builder writes 'Day 3' into it by default and
 * an importer writes it for a table with no header above it. The position last, because
 * `template_days.name` is nullable and every other fallback can be empty.
 *
 * Pulled into one place because this expression existed four times with three different endings:
 * the snapshot error path stopped at `Day N`, the program view said 'Untitled day', and the two
 * day pickers had no fallback at all and would render a chip with nothing written on it. A chooser
 * where one option is blank is the same failure the chooser chips were unified to prevent.
 */
export function dayTitle(day) {
  return day?.split || day?.name || `Day ${(day?.day_index ?? 0) + 1}`;
}

/**
 * Which day comes next, from the frozen snapshot and this client's sessions.
 *
 * The snapshot decides and never the live template, so editing a program does not change what
 * somebody was already told to do. `sessions` is expected oldest first, which is how the adapter
 * returns it ordered by `started_at`, and the last one is what the rotation advances from.
 *
 * A last session on a day the snapshot no longer contains starts the rotation again at the first
 * day, which is the honest answer: the program it belonged to is not this one.
 *
 * Returns null for a program with no days. Only a caller can decide what to show for that, and
 * the two that will need to (the logging screen and the program view) say different things.
 */
export function pickDay(snapshot, sessions) {
  const days = sortedDays(snapshot);
  if (!days.length) return null;
  if (!sessions.length) return days[0];

  const last = sessions[sessions.length - 1];
  const position = days.findIndex((day) => day.day_index === last.day_index);
  return days[(position + 1) % days.length];
}
