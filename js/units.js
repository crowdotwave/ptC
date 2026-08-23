// The unit a person reads weights in.
//
// Weight is stored in kilograms everywhere and always, per CLAUDE.md, so this is a display layer
// and nothing more. Flipping it converts no data, rewrites no set_log, and is safe in the middle
// of a session: the steppers hold kilograms and simply re-render, so 37.5 kg becomes 83 lb with
// the load on the bar unchanged. The step size changes with it, which is correct, because a plate
// tree in a pound gym does not offer 2.5 kg.
//
// THE PREFERENCE BELONGS TO THE VIEWER, NEVER TO THE PERSON BEING LOOKED AT.
//
// A trainer reading a client's progress reads it in the trainer's own unit and cannot reach the
// unit that client's phone shows. That is the whole reason this resolves a record from the actor
// rather than from whatever client row the screen happens to be rendering: progress.html renders
// somebody else's data when a trainer opens it with ?client=, and writing the unit there would
// have silently changed an app on a phone in another building.
//
// Somebody who coaches and is also coached holds a clients row and a trainers row. They get one
// preference, taken from the clients row, rather than two that disagree depending on which screen
// they are on.

export const KG_PER_LB = 0.45359237;

// Pounds by default, everywhere, including before a viewer row has been read. Kilograms is what
// the database stores and it is not what anybody here reads: every client and trainer this is
// being built for is in a pound gym, so kg as the default meant a first run that showed the
// wrong numbers until somebody found the switch. Storage is unaffected, weight_kg is still the
// only thing written, and this is still nothing but a display preference.
const state = { unit: 'lb', storage: null, table: null, id: null, name: '' };
const listeners = new Set();

export const unit = () => state.unit;

/**
 * The display name on the viewer's own record.
 *
 * Exported from here because resolving that record is exactly what this module already does, and
 * the alternative was a second copy of the same actor walk in nav.js that could disagree with
 * this one about who the viewer is.
 */
export const viewerName = () => state.name;

export const toDisplay = (kg) => (state.unit === 'lb' ? kg / KG_PER_LB : kg);

export const fromDisplay = (value) =>
  Math.round((state.unit === 'lb' ? value * KG_PER_LB : value) * 1000) / 1000;

/** Pounds to the whole number, kilograms to a tenth. Nobody loads a quarter pound. */
export function formatWeight(kg) {
  const shown = toDisplay(kg);
  return state.unit === 'lb' ? String(Math.round(shown)) : String(Math.round(shown * 10) / 10);
}

/** A weight and its unit, for the many places that print both. */
export const weightLabel = (kg) => `${formatWeight(kg)} ${state.unit}`;

/**
 * What is on the bar, or the word for there being nothing on it.
 *
 * A lift logged as weight_reps can legitimately be performed with no external load, and that is
 * not the same thing as the whole lift being bodyweight_reps. A GHD crunch, a dip, a pullup and a
 * back extension are all done cold and then done holding a plate, often inside one session: the
 * first real client to hit this logged one set with nothing and two with fifteen pounds. Reaching
 * for the bodyweight MODE would take the weight stepper off the screen and make those last two
 * sets unrecordable, so the mode stays and zero becomes a value the screen can say out loud.
 *
 * Zero is already reachable on the stepper and already correct in the data: weight_kg is zero, and
 * js/progression.js drops zero load rows from the strength series rather than charting an Epley of
 * nothing. The gap was only ever the reading. '0 lb for 8' asks somebody mid set to check a number
 * that means the absence of a number, which is the same noise the bodyweight mode was given its
 * own copy to avoid.
 *
 * 'BW' rather than 'Bodyweight' where it stands in for the value on a stepper, because that is the
 * word this app already uses: js/program.js isBodyweightLoad reads BW out of a trainer's Load cell,
 * so the abbreviation arrives from the spreadsheets rather than from here. Lower case in a
 * sentence, and callers that open a line with it upper case the first character, which a digit is
 * immune to.
 */
export const loadLabel = (kg) => (kg > 0 ? weightLabel(kg) : 'bodyweight');

/** The same, at the size the stepper reads it, where there is no room for a sentence. */
export const loadValue = (kg) => (kg > 0 ? formatWeight(kg) : 'BW');

/**
 * The smallest load change, in whatever unit is being read.
 *
 * Stored as increment_kg on the exercise, because a barbell, a dumbbell rack and a machine stack
 * all move differently and one global step offers weights the gym cannot make. A client reading
 * pounds wants round pounds, so the kilogram increment is converted and then snapped to 2.5lb,
 * which is what a plate tree actually holds.
 */
export function stepSize(incrementKg) {
  const kg = incrementKg || 2.5;
  if (state.unit !== 'lb') return kg;
  return Math.max(2.5, Math.round(kg / KG_PER_LB / 2.5) * 2.5);
}

/** Re-render hook. Every screen that prints a weight registers one of these. */
export function onUnitChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The viewer's own row, which is the only row this module will ever write. */
async function viewerRecord(storage, actor) {
  if (!actor) return null;
  if (actor.clientId) {
    const row = await storage.get('clients', actor.clientId);
    if (row) return { table: 'clients', row };
  }
  if (actor.trainerId) {
    const row = await storage.get('trainers', actor.trainerId);
    if (row) return { table: 'trainers', row };
  }
  return null;
}

/**
 * Reads the viewer's stored preference. Call once per page, before anything renders a weight.
 *
 * Falls back to pounds and no setting at all when there is no viewer row to write to, which
 * happens on an unbound session. Offering a control that silently fails to save is worse than not
 * offering it.
 */
export async function loadUnit(storage, actor) {
  const found = await viewerRecord(storage, actor);
  if (!found) {
    state.storage = null;
    return state.unit;
  }
  state.storage = storage;
  state.table = found.table;
  state.id = found.row.id;
  state.name = found.row.display_name ?? '';
  state.unit = found.row.weight_unit === 'kg' ? 'kg' : 'lb';
  return state.unit;
}

/** True when there is somewhere to persist a change, so the switch knows whether to render. */
export const canSetUnit = () => Boolean(state.storage && state.table && state.id);

/**
 * Optimistic, like every other write in this app. The screen turns over on the tap and the
 * adapter catches up, because a unit that lags a tap behind reads as a broken control.
 */
export async function setUnit(next) {
  if (next !== 'kg' && next !== 'lb') return;
  if (next === state.unit) return;
  state.unit = next;
  for (const fn of listeners) fn(next);
  if (!canSetUnit()) return;
  const row = await state.storage.get(state.table, state.id);
  if (!row) return;
  await state.storage.put(state.table, {
    ...row,
    weight_unit: next,
    updated_at: new Date().toISOString(),
  });
}

const WORDS = { kg: 'kilograms', lb: 'pounds' };

/**
 * The unit setting, in the page footer.
 *
 * IT USED TO BE A SEGMENTED SWITCH IN EVERY HEADER, and the argument for that shape was sound and
 * the argument for its PLACE was not. Sound: a lone pill reading KG cannot say whether it means
 * "you are reading kilograms" or "tap for kilograms", so both options showed and one filled, which
 * is the chooser chip rule at the smallest possible size. Not sound: that is 90px of the top right
 * corner of every screen in the app, permanently, for a preference somebody sets once and never
 * touches again. It had already been moved twice looking for a row it did not crowd, and the
 * measurement that pushed it off the lift name's line is in the header corner block in styles.css.
 * A control that has to be relocated twice to stop colliding with things is usually a control in
 * the wrong band of the screen.
 *
 * So it moves to the footer, with sign out, in the quietest type on the page, and the ambiguity
 * the segmented shape existed to solve is solved by a sentence instead: the state is a statement
 * and the action is a button, which cannot be read as each other. That is cheaper than two chips
 * and it says more.
 *
 * The logging screen's footer is hidden while that screen is doing its job, so this is unreachable
 * mid session, which is correct. It is a setting, not a control.
 */
export function mountUnitSetting(node) {
  if (!node) return;
  if (!canSetUnit()) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  const paint = () => {
    const other = state.unit === 'lb' ? 'kg' : 'lb';
    node.innerHTML =
      `<span class="unitset__now">Weights in ${WORDS[state.unit]}.</span>` +
      `<button type="button" class="unitset__swap" data-unit="${other}">` +
      `Switch to ${WORDS[other]}</button>`;
  };

  node.addEventListener('click', (event) => {
    const button = event.target.closest('[data-unit]');
    if (button) setUnit(button.dataset.unit);
  });

  onUnitChange(paint);
  paint();
}
