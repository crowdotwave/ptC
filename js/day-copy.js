// Adding a day a trainer has already written, rather than a blank one.
//
// The whole reason this exists: a second cardio workout is the first cardio workout with one thing
// changed. Typing a day of eight rows again to change one of them is the reason it does not get
// done, and a trainer who will not do it in the app goes back to the spreadsheet, which is the one
// outcome this product cannot survive.
//
// Pure, and it writes nothing. It hands back the fields for one new day and its rows, and the
// caller passes each through makeRecord and the adapter like every other write. Nothing here
// touches the day it copied from: a copy is new rows with new ids, so no program anybody is
// already on can be changed by making one.

/**
 * The fields of a `template_items` row that belong to the copy.
 *
 * Everything except the row's own identity and its parent, taken by exclusion rather than by
 * listing what to keep. The list would go stale the next time a column is added to the table, and
 * the failure would be silent: a copied day quietly missing its starting weights. makeRecord
 * validates the result, so a column this does not know about is a loud error rather than a lost
 * one.
 */
function itemFields(item, dayId) {
  const { id, created_at, updated_at, day_id, ...rest } = item;
  return { ...rest, day_id: dayId };
}

/**
 * A name that is not already in the program, in the trainer's own words for it.
 *
 * Two days of one program may not read the same. The day picker is a row of chips carrying these
 * labels, and two chips saying CARDIO is a chooser that cannot be chosen from; the consistency
 * grid's glyphs come from the same labels and fall back to a positional digit when they collide,
 * which is the one outcome the glyph rule says must not ship.
 *
 * So a copy is named for what it is: the second option for that day. Counting up rather than
 * always saying OPTION 2, because the third cardio workout is as ordinary as the second. Case
 * follows the label it is extending, since this trainer's sheet is shouted and the app never
 * reformats what they type.
 */
export function optionLabel(base, taken) {
  const used = new Set(taken.map((label) => String(label).trim().toUpperCase()));
  const root = String(base ?? '').trim();
  const word = root && root === root.toUpperCase() ? 'OPTION' : 'Option';
  if (!root) return null;
  // A day copied from another program usually lands in one that has never heard of it, and there
  // the trainer's own name for it is the right name. Only a collision needs a number.
  if (!used.has(root.toUpperCase())) return root;

  for (let n = 2; n < 50; n += 1) {
    const candidate = `${root} ${word} ${n}`;
    if (!used.has(candidate.toUpperCase())) return candidate;
  }
  return root;
}

/**
 * One day and its exercises, ready to be written into a program.
 *
 * `dayIndex` is handed in rather than derived, and the caller appends: renumbering the days already
 * in a program is what changes the meaning of `sessions.day_index`, which is the number every
 * logged session carries. Appending leaves every existing day where it is.
 *
 * `alternateOf` is the day this one is an option instead of, or null for a further day of the
 * rotation. Copying a day of the same program defaults to the first, because that is what copying a
 * day of a program you are already on means, and it is the answer that leaves the rotation alone.
 */
export function copyDay({ day, items = [], templateId, dayIndex, alternateOf = null, takenLabels = [], newId }) {
  const { id, created_at, updated_at, template_id, day_index, alternate_of, ...rest } = day;
  const dayId = newId();

  // The split is what a chip shows and what the grid reads, so it is the one renamed. Programs
  // imported from a sheet with no header above the table have no split, and there the name is what
  // is read instead.
  const label = optionLabel(rest.split ?? rest.name, takenLabels);
  const named = rest.split ? { ...rest, split: label } : { ...rest, name: label ?? rest.name };

  return {
    // Beside the fields rather than inside them, because makeRecord takes an id as an option and a
    // fields object carrying one only works by the order of a spread.
    id: dayId,
    day: {
      ...named,
      // Structured cloning rather than sharing the object. The warm up is jsonb and the builder
      // edits it in place, so a shared reference would have typing into the copy's mobility box
      // rewrite the day it was copied from.
      warmup: JSON.parse(JSON.stringify(rest.warmup ?? { mobility: [], general: [], specific: [] })),
      template_id: templateId,
      day_index: dayIndex,
      alternate_of: alternateOf,
    },
    items: [...items]
      .sort((a, b) => a.order_index - b.order_index)
      .map((item, order) => ({ ...itemFields(item, dayId), order_index: order })),
  };
}

/** The next free day_index in a program. Max plus one, never the count, so a gap cannot collide. */
export function nextDayIndex(days) {
  return days.reduce((highest, day) => Math.max(highest, (day.day_index ?? -1) + 1), 0);
}
