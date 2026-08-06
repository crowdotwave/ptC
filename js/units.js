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

const state = { unit: 'kg', storage: null, table: null, id: null, name: '' };
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
 * Falls back to kilograms and a read only switch when there is no viewer row to write to, which
 * happens on an unbound session. Offering a control that silently fails to save is worse than
 * not offering it.
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
  state.unit = found.row.weight_unit === 'lb' ? 'lb' : 'kg';
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

const OPTIONS = [
  ['kg', 'KG'],
  ['lb', 'LB'],
];

/**
 * The switch itself, rendered into whatever node is handed over.
 *
 * Segmented rather than a single button that flips. A lone pill reading KG cannot say whether it
 * means "you are reading kilograms" or "tap for kilograms", and that ambiguity sits on top of
 * every number on the screen. Both options visible, one of them filled, resolves it: it is the
 * chooser chip rule from CLAUDE.md applied to the smallest possible chooser.
 */
export function mountUnitSwitch(node) {
  if (!node) return;
  if (!canSetUnit()) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', 'Weight unit');

  const paint = () => {
    node.innerHTML = OPTIONS.map(([value, label]) => {
      const on = state.unit === value;
      return (
        `<button type="button" class="unitswitch__opt${on ? ' is-on' : ''}" data-unit="${value}" ` +
        `aria-pressed="${on}">${label}</button>`
      );
    }).join('');
  };

  node.addEventListener('click', (event) => {
    const button = event.target.closest('[data-unit]');
    if (button) setUnit(button.dataset.unit);
  });

  onUnitChange(paint);
  paint();
}
