// Swapping a lift: machine press instead of bench press, today, because the bench is taken.
//
// The problem this exists for was reported from a real session. The only way to record a swap was
// the note, so the sets went in under bench press, and a heavier machine press then fired a bench
// press record, drew itself onto the bench press chart, and prefilled next week's bench from a
// weight nobody has ever benched. The data was wrong three ways and every one of them looked right.
//
// So a swap changes which lift is being logged, not what the slot is. The program slot stays the
// trainer's: its sets, its reps, its rest, its place in the day. The lift in it becomes the one the
// client chose, and everything that reads a lift reads that one: the prefill comes from machine
// press's own last session, the record is measured against machine press's own best, and the rows
// carry machine press's id. What still says it was done in bench's place is the row's
// template_item_id, which is the slot and not the lift.
//
// Nothing here writes. Choosing a lift is not a set, and a swap nobody logs anything under leaves
// no trace, the same way a skipped lift leaves none.

import { planForItem } from './plan.js';
import { activeSetLogs } from './history.js';

// Kept in step with EXERCISE_FIELDS in js/snapshot.js: the same few facts a snapshot freezes.
const FROZEN = ['id', 'name', 'slug', 'equipment', 'increment_kg'];

/** The slot's lift as the program wrote it, however many times it has been swapped since. */
export const programmed = (item) => item.origin ?? item;

/**
 * The slot, holding a different lift.
 *
 * Same id, because the slot is the same slot and every row logged in it says so. Same targets,
 * because the trainer's sets, reps and rest are what was asked for whichever machine it is done on.
 * No starting weight, because the trainer's starting weight was a number for the other lift, and
 * carrying 100 kg of bench press onto a leg press stack or a cable is exactly the wrong number this
 * whole feature exists to stop. Swapping back to the programmed lift returns the programmed item
 * itself, so a lift swapped and swapped back is indistinguishable from one never swapped.
 */
export function swappedItem(item, exercise) {
  const origin = programmed(item);
  if (exercise.id === origin.exercise_id) return origin;
  const frozen = {};
  for (const field of FROZEN) frozen[field] = exercise[field] ?? null;
  return { ...origin, exercise_id: exercise.id, exercise: frozen, starting_weight_kg: null, origin };
}

/**
 * The plan with one slot's remaining sets rebuilt for a different lift.
 *
 * `run` is the slot's entries as they stand, and `keep` says which of them stay: sets already
 * logged, which were done as the lift they were done as and are not rewritten by a later change of
 * mind. `built` is planForItem's answer for the new lift, from that lift's own history, and it is
 * cut to the number of working sets the slot still owes, so a swap after two of four sets leaves
 * two, and the program's count survives the swap.
 *
 * Warmups come with the new lift only if the slot had not been started. Somebody who has already
 * done two working sets of bench is warm, and a warmup of machine press would be a set nobody
 * asked for sitting in front of the ones that were.
 *
 * Returns the new plan and the index of the first set of the new lift, which is where the screen
 * goes. Pure, so it can be tested with plain objects, and so the resume path can run it on a plan
 * before any row has been matched.
 */
export function applySwap(plan, run, newItem, built, keep = (entry) => entry.status === 'logged') {
  const kept = run.filter(keep);
  const owed = run.filter((entry) => !keep(entry) && !entry.isWarmup).length;
  const started = kept.length > 0;

  const fresh = [];
  let working = 0;
  for (const entry of built) {
    if (entry.isWarmup) {
      if (!started) fresh.push({ ...entry, item: newItem });
      continue;
    }
    if (working >= owed) continue;
    working += 1;
    fresh.push({ ...entry, item: newItem });
  }

  // Set indexes after anything kept, so a swapped set can never collide with a logged one when an
  // interrupted session matches rows back to seats.
  const floor = kept.reduce((max, entry) => Math.max(max, entry.setIndex), -1);
  if (floor >= 0) {
    const lowest = fresh.reduce((min, entry) => Math.min(min, entry.setIndex), Infinity);
    const shift = lowest <= floor ? floor + 1 - lowest : 0;
    for (const entry of fresh) entry.setIndex += shift;
  }

  const dropped = new Set(run.filter((entry) => !keep(entry)));
  const lastKept = kept.length ? plan.indexOf(kept[kept.length - 1]) : -1;
  const firstOfRun = plan.indexOf(run[0]);
  const next = [];
  let at = -1;
  plan.forEach((entry, index) => {
    if (!dropped.has(entry)) next.push(entry);
    const insertHere = kept.length ? index === lastKept : index === firstOfRun;
    if (insertHere) {
      at = next.length;
      next.push(...fresh);
    }
  });
  // A run that was nothing but dropped entries and sat at index 0 is handled above; this covers a
  // plan that did not contain the run at all, which only a caller mistake produces.
  if (at === -1) {
    at = next.length;
    next.push(...fresh);
  }

  return { plan: next, cursor: fresh.length ? at : Math.min(at, next.length - 1) };
}

const loggedAlready = (entry) => entry.status === 'logged';

/** planForItem, then applySwap. The one call the screen and the resume path both make. */
export function swapSlot(plan, run, newItem, previous, opening, keep = loggedAlready) {
  const owed = run.filter((entry) => !keep(entry) && !entry.isWarmup).length;
  // Built for the count still owed, never fewer than one, so planForItem has a set to prefill.
  const built = planForItem({ ...newItem, target_sets: Math.max(owed, 1) }, previous, opening);
  return applySwap(plan, run, newItem, built, keep);
}

/**
 * Which slots an interrupted session had swapped, read back off its rows.
 *
 * A slot is swapped when its newest counting row names the slot and a different lift. The newest,
 * because somebody can swap, log, and swap again, and what they were doing when the phone locked is
 * the last thing they did. Rows written before template_item_id existed name no slot and can never
 * mark one as swapped, which is right: no swap was possible then.
 */
export function swapsFromRows(items, rows) {
  const newest = new Map();
  for (const row of activeSetLogs(rows)) {
    if (!row.template_item_id) continue;
    const held = newest.get(row.template_item_id);
    if (!held || String(row.logged_at) > String(held.logged_at)) newest.set(row.template_item_id, row);
  }
  const swaps = [];
  for (const item of items) {
    const row = newest.get(item.id);
    if (row && row.exercise_id !== item.exercise_id) swaps.push({ item, exerciseId: row.exercise_id });
  }
  return swaps;
}

/**
 * The lifts this client has swapped into this slot before, newest first.
 *
 * The whole reason the chooser is quick after the first time: whoever swaps bench for machine press
 * once because the bench is always taken on Mondays will want machine press at the top every Monday
 * after. Read off the rows, so it needs no setting and cannot drift from what actually happened.
 */
export function recentSwaps(rows, slotId, programmedId) {
  const latest = new Map();
  for (const row of activeSetLogs(rows)) {
    if (row.template_item_id !== slotId || row.exercise_id === programmedId) continue;
    const at = String(row.logged_at);
    if (!latest.has(row.exercise_id) || at > latest.get(row.exercise_id)) latest.set(row.exercise_id, at);
  }
  return [...latest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([id]) => id);
}

/**
 * What the chooser lists, in groups, narrowed by what was typed.
 *
 * Swapped before, then the lift the program asked for when the slot is holding something else, then
 * every lift. The programmed lift is its own group rather than a row somewhere in the alphabet,
 * because going back to it is the one choice somebody should never have to search for. The lift in
 * the slot now is left out: swapping a lift for itself is not a choice.
 *
 * Every word typed has to appear in the name, in any order, the same rule the lift picker uses, so
 * "press machine" finds Machine Shoulder Press.
 */
export function swapChoices(exercises, { current, recentIds = [], query = '' } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e) => words.every((word) => e.name.toLowerCase().includes(word));
  const origin = programmed(current);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const skip = new Set([current.exercise_id]);
  const groups = [];

  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((e) => e && !skip.has(e.id) && e.id !== origin.exercise_id && matches(e));
  if (recent.length) groups.push({ label: 'Swapped before', lifts: recent });
  for (const e of recent) skip.add(e.id);

  if (current !== origin) {
    const back = byId.get(origin.exercise_id) ?? { id: origin.exercise_id, name: origin.exercise?.name ?? 'The programmed lift' };
    if (matches(back)) groups.push({ label: 'In your program', lifts: [back] });
    skip.add(back.id);
  }

  // Lifts for the same muscle next, because swapping bench press almost always means another chest
  // lift, and 783 names in alphabetical order open on "3/4 Sit-Up". The muscle is read off the
  // programmed lift's row, or off the library lift with the same name when a trainer's own row says
  // "unspecified", which every imported lift does.
  const muscle = muscleOf(exercises, origin);
  const label = muscle ? muscle.charAt(0).toUpperCase() + muscle.slice(1) : null;

  // One row per name. A trainer's own lift and the library's often share one, and a client choosing
  // between two identical names is choosing between two histories without being told so. The
  // trainer's row wins, being the one a trainer would program, and a name already offered above is
  // not offered again.
  const seen = new Set([...skip].map((id) => byId.get(id)?.name.toLowerCase()).filter(Boolean));
  const rest = [...exercises]
    .sort((a, b) => Number(Boolean(b.trainer_id)) - Number(Boolean(a.trainer_id)))
    .filter((e) => {
      const key = e.name.toLowerCase();
      if (skip.has(e.id) || seen.has(key) || !matches(e)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const similar = muscle ? rest.filter((e) => e.primary_muscle === muscle) : [];
  if (similar.length) {
    groups.push({ label, lifts: similar });
    const others = rest.filter((e) => e.primary_muscle !== muscle);
    if (others.length) groups.push({ label: 'Everything else', lifts: others });
  } else if (rest.length) {
    groups.push({ label: 'Every lift', lifts: rest });
  }

  return groups;
}

/**
 * The lift a set stood in for, or null when it was the slot's own lift.
 *
 * Read off the snapshot of the assignment the session was logged under, never the live program: the
 * question is what the client was asked to do that day, and a template edited since would answer a
 * different question. A row written before slots were recorded names no slot and stood in for
 * nothing, and so does a slot the snapshot no longer has, since there is no honest name to give it.
 */
export function standInFor(snapshot, templateItemId, exerciseId) {
  if (!snapshot || !templateItemId) return null;
  for (const day of snapshot.days ?? []) {
    const item = (day.items ?? []).find((candidate) => candidate.id === templateItemId);
    if (!item) continue;
    return item.exercise_id === exerciseId ? null : item.exercise?.name ?? null;
  }
  return null;
}

/** The programmed lift's primary muscle, from its own row or the library row of the same name. */
function muscleOf(exercises, origin) {
  const known = (m) => (m && m !== 'unspecified' ? m : null);
  const own = exercises.find((e) => e.id === origin.exercise_id);
  if (known(own?.primary_muscle)) return own.primary_muscle;
  const name = (own?.name ?? origin.exercise?.name ?? '').toLowerCase();
  const namesake = name ? exercises.find((e) => e.name.toLowerCase() === name && known(e.primary_muscle)) : null;
  return namesake ? namesake.primary_muscle : null;
}
