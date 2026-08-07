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
 * The assignment a client is on right now.
 *
 * Takes the adapter as an argument rather than importing it, so this module stays a description
 * of a shape and nothing that opens a database.
 *
 * Latest `starts_on` wins, which is the same rule the logging screen has always used. It is here
 * so that it stays the same rule: the Programs tab showing one program while the Log tab steps
 * through another would be the app disagreeing with itself about what somebody is meant to do
 * today.
 */
export async function currentAssignment(storage, clientId) {
  const rows = await storage.query(
    'assignments',
    { client_id: clientId },
    { orderBy: 'starts_on', direction: 'desc', limit: 1 },
  );
  return rows[0] ?? null;
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
