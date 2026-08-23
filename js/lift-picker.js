// Which lift the charts below are about. One control, shared by the progress screen and the
// trainer's client view.
//
// WHY THIS IS NOT THE CHOOSER CHIP ROW ANY MORE, which is a rule in CLAUDE.md and so worth the
// paragraph. That rule unified the day picker and this one so they could not drift apart, and it
// is right about everything except how many options a row can hold. A day picker holds a rotation:
// two to five chips, all of them on screen, and the half visible one at the edge is a useful
// affordance because there is almost nothing behind it. This holds every lift a client has ever
// logged. Measured on the seeded client, eight lifts is 1,344px of row against 390px of phone, so
// 71 percent of the options are off screen with nothing but a sliced chip to say so, and a real
// client on a seven day calisthenics split has three or four times that. A chooser that hides most
// of its options is the failure the chip rule exists to prevent, arrived at from the other side:
// there the selected chip was invisible, here the unselected ones are.
//
// So the row becomes what every training app converges on for this, because it is the only shape
// that survives forty options on a phone: one control naming what you are looking at, and a list
// you can search behind it. The chip rule still governs the rows inside the list, which is where
// the selection actually is: the current lift FILLS with the raised gradient and its rim, steps to
// 700 weight and --text-primary, and carries the word "Showing". Fill against no fill is still the
// signal doing the real work.
//
// It is a state of the screen rather than a layer over it, exactly as the workout panel on the
// logging screen is: in flow, no focus trap, no z-index, no outside click handler. Escape closes
// it, which is a keyboard affordance rather than a modal one.
//
// Pure, like js/consistency-view.js and js/workout-view.js: everything here takes data and returns
// a string or an array, so test.js can check it with no DOM. The pages own the open flag, the
// search text, and the listeners.

import { sortedDays, sortedItems, dayTitle } from './snapshot.js';
import { activeSetLogs } from './history.js';
import { localDayOf } from './dates.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * How many lifts it takes before the list gets a search field.
 *
 * Eight rows is about a phone screen, so up to that the list IS the search: everything is visible
 * and a keyboard is pure friction. Past it somebody is scrolling to find a name they already know,
 * which is the exact thing typing is faster at.
 */
export const SEARCH_AT = 8;

const shortDay = (iso) => {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';
};

/**
 * Every lift this client has actually done, with enough about each to choose between them.
 *
 * Only lifts with live working sets behind them. A picker entry for a lift with nothing under it
 * is a dead end, and a picker entry for a lift whose only rows were superseded or retracted is
 * a dead end that also lies about what happened.
 *
 * Both callers computed a version of this and they disagreed: the progress screen counted raw
 * rows, so a lift corrected three times read as three sessions of work, and the trainer's view
 * counted through activeSetLogs and kept no counts at all. One answer, computed once.
 *
 * `sessions` is expected to come from js/session.js loadSessions, which is what drops the
 * discarded ones. Rows for other clients are filtered against it.
 */
export function liftSummaries({ exercises = new Map(), sessions = [], setLogs = [] } = {}) {
  const startedAt = new Map(sessions.map((s) => [s.id, s.started_at]));
  const seen = new Map();

  for (const row of activeSetLogs(setLogs)) {
    if (row.is_warmup || !startedAt.has(row.session_id)) continue;
    if (!seen.has(row.exercise_id)) seen.set(row.exercise_id, { sessions: new Set(), last: '' });
    const entry = seen.get(row.exercise_id);
    entry.sessions.add(row.session_id);
    const when = startedAt.get(row.session_id);
    if (when > entry.last) entry.last = when;
  }

  return [...seen.entries()]
    .map(([id, entry]) => {
      const exercise = exercises.get(id);
      if (!exercise) return null;
      return {
        id,
        name: exercise.name,
        sessions: entry.sessions.size,
        lastDay: entry.last ? localDayOf(entry.last) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The lifts grouped the way the client thinks about them: by the day of the program they are on.
 *
 * Alphabetical across forty lifts is a phone book. A client looking for their front lever hold
 * knows it is on pull day long before they know it starts with F, and the day names are already
 * on screen twice, in the calendar legend above and on the day picker they log against.
 *
 * The grouping comes from ONE snapshot, the current assignment's, and never from the union of
 * every assignment a client has ever had. Old blocks name days that no longer exist, and a list
 * with "Pull A" from March above "Pull A" from August is two headings for one thing.
 *
 * Inside a day the order is the trainer's, matching the workout panel and the program view. A
 * lift the current program does not ask for is still a lift with history worth reading, so it
 * falls to the end under its own heading rather than out of the list.
 *
 * A lift programmed on two days is listed under the first of them and not both. Two rows that
 * select the same charts is a chooser with a duplicate in it.
 */
export function groupLifts(lifts, snapshot) {
  const byId = new Map(lifts.map((lift) => [lift.id, lift]));
  const groups = [];
  const placed = new Set();

  for (const day of sortedDays(snapshot)) {
    const rows = [];
    for (const item of sortedItems(day)) {
      const id = item.exercise?.id ?? item.exercise_id;
      if (!byId.has(id) || placed.has(id)) continue;
      placed.add(id);
      rows.push(byId.get(id));
    }
    if (rows.length) groups.push({ label: dayTitle(day), lifts: rows });
  }

  const rest = lifts.filter((lift) => !placed.has(lift.id));
  // Named rather than left as an unlabelled tail. A heading that says what a group is beats a
  // gap, and "Other lifts" is the honest name for "not in the program you are on now".
  if (rest.length) groups.push({ label: groups.length ? 'Other lifts' : 'Every lift', lifts: rest });
  return groups;
}

/**
 * The lifts matching what somebody typed.
 *
 * Every word has to appear somewhere in the name, in any order, so "press bench" finds Barbell
 * Bench Press. Substring rather than prefix, because half the names in a real library start with
 * the equipment: prefix matching on "Barbell" is not a search, it is a way to type nineteen
 * characters and narrow nothing.
 */
export function matchLifts(lifts, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return lifts;
  return lifts.filter((lift) => {
    const name = lift.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/** What one row says about a lift, under its name. */
function metaOf(lift) {
  const count = `${lift.sessions} session${lift.sessions === 1 ? '' : 's'}`;
  return lift.lastDay ? `${count}, last ${shortDay(lift.lastDay)}` : count;
}

function renderRow(lift, selectedId) {
  const on = lift.id === selectedId;
  return (
    `<button type="button" class="liftpick__row${on ? ' is-on' : ''}" data-exercise="${esc(lift.id)}"` +
    `${on ? ' aria-current="true"' : ''}>` +
    `<span class="liftpick__name">${esc(lift.name)}</span>` +
    `<span class="liftpick__meta num">${esc(metaOf(lift))}</span>` +
    // The state is said in a word as well as drawn in a fill, per the encoding rules. It is the
    // only thing in the row that is not a fact about the lift.
    (on ? `<span class="liftpick__showing">Showing</span>` : '') +
    `</button>`
  );
}

/**
 * The whole control: the button that opens it, and the list behind it.
 *
 * `scope` is set when the calendar above has a day focused, and it is what makes this list a
 * different list rather than the same list with something hidden. It carries the day's own label
 * so the narrowing is stated rather than merely happening, and a row to leave it, because a
 * chooser that has silently dropped most of its options is the failure this whole module exists
 * to fix and it would be perverse to reintroduce it here.
 */
export function renderLiftPicker({
  lifts = [],
  groups = null,
  selectedId = null,
  open = false,
  query = '',
  scope = null,
} = {}) {
  const shown = matchLifts(lifts, query);
  const shownIds = new Set(shown.map((lift) => lift.id));
  const inScope = scope ? `${lifts.length} in this session` : `${lifts.length} lift${lifts.length === 1 ? '' : 's'}`;

  const body = (groups ?? [{ label: '', lifts }])
    .map((group) => {
      const rows = group.lifts.filter((lift) => shownIds.has(lift.id));
      if (!rows.length) return '';
      return (
        (group.label ? `<p class="liftpick__group">${esc(group.label)}</p>` : '') +
        rows.map((lift) => renderRow(lift, selectedId)).join('')
      );
    })
    .join('');

  return (
    `<button type="button" class="liftpick__open" id="liftpick-open" aria-expanded="${open}" ` +
    `aria-controls="liftpick-panel">` +
    // It says what it does rather than what is selected, and that is deliberate on a screen where
    // the lift's name is the heading directly above it at 32px. A control that repeats the line
    // above it is noise, and the selection is stated three more times regardless: in that heading,
    // in the sessions line under it, and by the filled row inside the list saying "Showing".
    `<span class="liftpick__lead">Choose a lift</span>` +
    `<span class="liftpick__count num">${esc(inScope)}</span>` +
    // The same chevron the day chip carries, turned by CSS when the panel opens, which makes the
    // button its own close control rather than needing a second one inside the list.
    `<svg class="liftpick__glyph" viewBox="0 0 20 20" aria-hidden="true" fill="none" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M5 8l5 5 5-5" /></svg>` +
    `</button>` +
    `<div class="liftpick__panel" id="liftpick-panel"${open ? '' : ' hidden'}>` +
    (scope
      ? `<div class="liftpick__scope">` +
        `<span class="liftpick__scopeday">${esc(scope)}</span>` +
        `<button type="button" class="button-secondary liftpick__all" data-clear-scope>Show every lift</button>` +
        `</div>`
      : '') +
    (lifts.length > SEARCH_AT
      ? `<input type="search" class="liftpick__search" id="liftpick-search" ` +
        `placeholder="Search lifts" aria-label="Search lifts" value="${esc(query)}" ` +
        `autocomplete="off" autocorrect="off" spellcheck="false" />`
      : '') +
    `<div class="liftpick__scroll">` +
    // An invitation rather than an apology, per the copy rules, and it names what was typed so
    // the empty list reads as an answer to a question rather than as a broken screen.
    (body || `<p class="liftpick__none">No lift here matches ${esc(query)}. Try fewer letters.</p>`) +
    `</div>` +
    `</div>`
  );
}
