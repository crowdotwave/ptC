// Which lift a typed name means, now that there are two kinds of lift to mean.
//
// A trainer's own lifts carry their clients' history and the increments that trainer set. The
// shared library (supabase/migrations/0019_exercise_library.sql) is hundreds of rows every account
// can read and nobody can edit. The two share names all the time, and a trainer who has been
// programming their own "Face Pull" for months must get that row when they type "Face Pull", not
// the library's: the library's row would quietly start every client's face pull history again
// from nothing, and a chart split across two ids is a chart that stops showing progress.

/**
 * Every lift this trainer can pick, their own first and then everything else, each half in the
 * order it came. `trainerId` null means nothing is anybody's own, which is a staff account, and
 * comparing against null would otherwise rank the library first, since its trainer_id is null too.
 */
export function libraryOrder(exercises, trainerId) {
  if (trainerId === null || trainerId === undefined) return [...exercises];
  const mine = (e) => Number(e.trainer_id === trainerId);
  return [...exercises].sort((a, b) => mine(b) - mine(a));
}

/** The lift a typed name resolves to, ignoring case and surrounding space, or null. */
export function findByName(exercises, trainerId, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return libraryOrder(exercises, trainerId).find((e) => e.name.toLowerCase() === wanted) ?? null;
}

/**
 * The names to suggest, one per name and alphabetical. A trainer's lift and the library's often
 * share a name, and both resolve to the trainer's row anyway, so listing it twice would offer a
 * choice that does not exist. Where they differ only in case, the trainer's spelling is the one
 * shown.
 */
export function suggestionNames(exercises, trainerId) {
  const names = new Map();
  for (const e of libraryOrder(exercises, trainerId)) {
    const key = e.name.toLowerCase();
    if (!names.has(key)) names.set(key, e.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}
