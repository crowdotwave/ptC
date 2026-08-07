// A program, read rather than edited.
//
// One renderer, because the thing a client needs to see and the thing a trainer needs to check
// are the same thing seen by two people. A trainer previewing their own work through a second
// implementation would be previewing the second implementation.
//
// It takes the frozen snapshot shape from js/snapshot.js and nothing else. The trainer's caller
// freezes a live template on the way in, so the preview is reading exactly what an assignment
// would carry rather than a convenient approximation of it.
//
// Nothing here reformats what the trainer typed. '1-2 RIR' stays '1-2 RIR' and 'MED GRIP' stays
// 'MED GRIP', for the same reason the builder does not: the words are theirs. The one sentence
// this file composes is the target line, and it is composed by targetLine() in js/program.js,
// which is already the single source of that sentence for the logging screen and the builder.

import { sortedDays, sortedItems, pickDay, dayTitle } from './snapshot.js';
import { parseGroup, targetLine } from './program.js';
import { weightLabel } from './units.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * The state a client is in between being added and being given a program.
 *
 * Exported because the logging screen says this too, and two screens describing the same state in
 * two different sentences is how somebody starts wondering which one is right. It names who it is
 * waiting on, offers no action, and does not apologise: only their trainer can change this.
 */
export const NO_PROGRAM_YET = 'Your trainer has not assigned a program yet. It will be here when they do.';

/**
 * The three warm up columns, named once.
 *
 * Exported because the builder writes these three boxes and this view reads them, and a column
 * labelled one thing where it is typed and another where it is read is the same drift the
 * chooser chips were pulled into one rule to prevent.
 */
export const WARMUP_KINDS = [
  ['mobility', 'Stretch and mobility'],
  ['general', 'General warm up'],
  ['specific', 'Specific prep'],
];

/**
 * What a day actually asks of somebody.
 *
 * Counts only what is countable. A row the trainer marked as not logged is not a lift with zero
 * sets, it is instruction, so it is counted separately rather than folded into a total that
 * would then be quietly wrong. A logged row with no set count adds nothing to `sets`, which is
 * the honest answer for a cardio block or an AMRAP: nobody knows how many sets that is.
 */
export function dayLoad(day) {
  const items = sortedItems(day);
  const logged = items.filter((item) => item.is_logged !== false);
  return {
    lifts: logged.length,
    sets: logged.reduce((total, item) => total + (item.target_sets ?? 0), 0),
    shown: items.length - logged.length,
  };
}

/** The one line answering "what am I in for", from counts and never from an estimate. */
export function loadLine(day) {
  const { lifts, sets, shown } = dayLoad(day);
  if (!lifts && !shown) return 'Nothing in this day yet.';

  const bits = [];
  if (lifts) {
    bits.push(`${lifts} lift${lifts === 1 ? '' : 's'}`);
    if (sets) bits.push(`${sets} set${sets === 1 ? '' : 's'}`);
  }
  if (shown) bits.push(`${shown} not logged`);
  return bits.join(', ');
}

/**
 * Consecutive rows the trainer numbered 1A, 1B into one run.
 *
 * A shared leading number is how their sheet says superset, and splitting those rows into a flat
 * list loses the only place that instruction was written down. A lone '1' is not a group: it
 * takes a letter to mean anything, which is what parseGroup's isGrouped reports.
 */
export function groupItems(day) {
  const runs = [];
  for (const item of sortedItems(day)) {
    const { group, isGrouped } = parseGroup(item.group_label);
    const last = runs[runs.length - 1];
    if (isGrouped && last && last.group === group) {
      last.items.push(item);
      continue;
    }
    runs.push({ group: isGrouped ? group : null, items: [item] });
  }
  return runs;
}

function renderLines(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return `<ul class="plan__lines">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`;
}

function renderWarmup(day) {
  const warmup = day.warmup || {};
  const columns = WARMUP_KINDS.filter(([kind]) => (warmup[kind] || []).length);
  if (!columns.length) return '';

  return (
    `<section class="plan__warmup"><h3 class="plan__section">Warm up</h3><div class="plan__cols">` +
    columns
      .map(
        ([kind, label]) =>
          `<div class="plan__col"><p class="plan__collabel">${esc(label)}</p>` +
          `${renderLines((warmup[kind] || []).join('\n'))}</div>`,
      )
      .join('') +
    `</div></section>`
  );
}

/**
 * What this person did on this lift last time, when there is a history to read.
 *
 * The one thing that turns a list of prescriptions into something actionable: a client reading
 * "3 sets, 5-8, 1-2 RIR" knows the shape of the session but not what to load, and the answer is
 * always what they lifted last week. Absent for a trainer previewing a template, because no
 * client is chosen and inventing one would be a lie about somebody's training.
 */
function lastLine(item, history) {
  const last = history?.get(item.exercise_id);
  if (!last) return '';
  return (
    `<p class="plan__last num">Top set last time ${esc(weightLabel(last.weightKg))} ` +
    `for ${last.reps}, ${esc(shortDate(last.on))}</p>`
  );
}

function renderItem(item, history) {
  const name = item.exercise?.name ?? 'Unnamed lift';
  const target = targetLine(item);
  // Marked rather than hidden. A client who cannot see the cardio block on their own program is
  // reading a different program from the one their trainer wrote. The word is what carries it:
  // the row is not dimmed and not shrunk, because nothing here is a lesser exercise.
  const shown = item.is_logged === false;

  return (
    `<li class="plan__item${shown ? ' plan__item--shown' : ''}">` +
    `<span class="plan__num num">${esc(item.group_label ?? '')}</span>` +
    `<div class="plan__body">` +
    `<p class="plan__name">${esc(name)}` +
    (item.variation ? ` <span class="plan__variation">${esc(item.variation)}</span>` : '') +
    `</p>` +
    (target ? `<p class="plan__target">${esc(target)}</p>` : '') +
    lastLine(item, history) +
    (shown ? `<p class="plan__tag">Not logged</p>` : '') +
    (item.notes ? `<p class="plan__note">${esc(item.notes)}</p>` : '') +
    `</div></li>`
  );
}

function renderRun(run, history) {
  const items = run.items.map((item) => renderItem(item, history)).join('');
  if (!run.group || run.items.length < 2) return items;
  // Bracketed and named. The bracket is the shape and "Superset" is the word, so this survives
  // the encoding rule without spending a hue on it.
  return (
    `<li class="plan__group"><p class="plan__grouplabel">Superset</p>` +
    `<ul class="plan__items plan__items--nested">${items}</ul></li>`
  );
}

function renderDay(day, history) {
  const runs = groupItems(day);
  const heading = dayTitle(day);

  return (
    `<article class="plan__day">` +
    `<header class="plan__head">` +
    (day.day_type ? `<p class="plan__type">${esc(day.day_type)}</p>` : '') +
    `<h2 class="plan__split">${esc(heading)}</h2>` +
    `<p class="plan__load num">${esc(loadLine(day))}</p>` +
    `</header>` +
    renderWarmup(day) +
    (runs.length ? `<ul class="plan__items">${runs.map((run) => renderRun(run, history)).join('')}</ul>` : '') +
    (String(day.comments ?? '').trim()
      ? `<section class="plan__comments"><h3 class="plan__section">Notes for this day</h3>` +
        `${renderLines(day.comments)}</section>`
      : '') +
    `</article>`
  );
}

function renderChooser(snapshot, dayIndex) {
  const days = sortedDays(snapshot);
  // One day is not a chooser, it is a label for the only day there is.
  if (days.length < 2) return '';

  return (
    `<nav class="daypicker" aria-label="Choose a day">` +
    days
      .map((day) => {
        const on = day.day_index === dayIndex;
        return (
          `<button type="button" class="button-secondary daypicker__item${on ? ' is-on' : ''}" ` +
          `data-plan-day="${day.day_index}"${on ? ' aria-current="true"' : ''}>` +
          `${esc(dayTitle(day))}</button>`
        );
      })
      .join('') +
    `</nav>`
  );
}

/**
 * The whole view for one snapshot, as HTML. Pure, so it can be tested without a DOM.
 *
 * `dayIndex` names which day is open. Null opens the day pickDay would, which is what keeps a
 * preview and the logging screen from disagreeing about where a program starts.
 *
 * `history` is a Map of exercise_id to the top set last time, or null where there is nobody whose
 * history it would be.
 */
export function renderProgram(snapshot, dayIndex = null, history = null) {
  const days = sortedDays(snapshot);
  if (!days.length) {
    // An invitation, not an apology. The only person who reads this in the builder is the one
    // who can fix it in a tap.
    return `<p class="plan__empty">No days in this program yet. Add one and it will show up here.</p>`;
  }

  const open = days.find((day) => day.day_index === dayIndex) ?? pickDay(snapshot, []);
  return `<div class="plan">${renderChooser(snapshot, open.day_index)}${renderDay(open, history)}</div>`;
}

// Per node, so a second mount on the same container replaces what the first one was showing
// instead of stacking a listener that still holds the first snapshot.
const views = new WeakMap();

/**
 * Renders into `node` and wires the day chooser. Calling it again with a different snapshot
 * re-renders the same node rather than adding a second view to it.
 */
export function mountProgramView(node, { snapshot, dayIndex = null, history = null }) {
  const isFirst = !views.has(node);
  views.set(node, { snapshot, dayIndex, history });

  if (isFirst) {
    node.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-plan-day]');
      if (!chip) return;
      const view = views.get(node);
      view.dayIndex = Number(chip.dataset.planDay);
      node.innerHTML = renderProgram(view.snapshot, view.dayIndex, view.history);
    });
  }

  node.innerHTML = renderProgram(snapshot, dayIndex, history);
}

/** Re-renders whatever a node is already showing, for a unit switch that has just flipped. */
export function repaintProgramView(node) {
  const view = views.get(node);
  if (!view) return;
  node.innerHTML = renderProgram(view.snapshot, view.dayIndex, view.history);
}
