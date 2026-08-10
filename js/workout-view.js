// The whole workout, read mid session, and the way to any lift in it.
//
// The gap this closes is a room problem rather than a screen problem. A rack or a machine is
// taken, so the lift that comes next is not the lift that can be done next, and until now the
// only answers were to skip it or to leave the screen entirely. The order in a program is the
// trainer's intent, not a queue somebody has to stand in.
//
// So this is two things at once and both are the point: what the session is, and where in it to
// go. Reading it required a trip to the Programs tab, which is a different page, loses the day
// the client is actually on, and cannot say what has been logged so far.
//
// Pure, like js/program-view.js and js/session-view.js: it takes plan entries and returns a
// string, so test.js can check the markup with no DOM. Everything it knows about a session comes
// from `status` on the entries, which the logging screen owns.
//
// It deliberately does NOT reuse renderProgram. That renderer reads a frozen snapshot and knows
// nothing about what has been logged, which is most of what this one has to say, and the two
// answer different questions: one is the program, this is today.

import { targetLine } from './program.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * A set still to be done.
 *
 * Three states, and the absence of one is the default: an entry nobody has touched has no status
 * at all. That keeps js/plan.js free of session state, which is not its job, and it means a plan
 * built fresh is pending by construction rather than by a loop that has to remember to run.
 */
export const isPending = (entry) =>
  Boolean(entry) && entry.status !== 'logged' && entry.status !== 'skipped';

/**
 * The plan grouped back into lifts.
 *
 * Contiguous runs of the same item, by identity rather than by exercise id. A day that programs
 * the same lift twice, which happens on a sheet that opens and closes with the same carry, is two
 * lifts on this list and not one row claiming eight sets.
 */
export function liftRuns(plan) {
  const runs = [];
  plan.forEach((entry, index) => {
    const last = runs[runs.length - 1];
    if (last && last.item === entry.item) {
      last.entries.push(entry);
      last.to = index;
      return;
    }
    runs.push({ item: entry.item, entries: [entry], from: index, to: index });
  });
  return runs;
}

/**
 * One row per lift, carrying everything the list needs and nothing the DOM needs.
 *
 * `at` is the plan index a tap should land on, and null means there is nowhere left to land: every
 * set of that lift is logged. Those rows are not buttons. Going back to a finished lift can only
 * mean doing another set of it, and Add set is already that, on the lift the client is on, one tap,
 * prefilled. A row that quietly appended a set because a thumb brushed it would be the one control
 * in this app that writes something nobody asked for.
 *
 * A lift that was skipped is reachable, and that is a change of mind rather than an oversight. Skip
 * moves somebody on now, and it used to be permanent for the length of the session only because a
 * cursor could not go backwards. Leaving it permanent once the cursor can would be inventing a dead
 * end and putting no undo on it, which is worse than the thing it replaced. The caller puts those
 * sets back to pending when the tap lands.
 */
export function overviewRows(plan, cursor = -1) {
  const current = plan[cursor] ?? null;

  return liftRuns(plan).map((run) => {
    const pending = run.entries.filter(isPending);
    const reachable = pending.length
      ? pending
      : run.entries.filter((entry) => entry.status === 'skipped');
    const isCurrent = Boolean(current) && current.item === run.item;

    return {
      name: run.item.exercise?.name ?? 'Unnamed lift',
      variation: run.item.variation ?? null,
      group: run.item.group_label ?? null,
      target: targetLine(run.item),
      notes: run.item.notes ?? null,
      at: reachable.length ? plan.indexOf(reachable[0]) : null,
      isCurrent,
      logged: run.entries.filter((entry) => entry.status === 'logged').length,
      planned: run.entries.length,
      position: isCurrent ? run.entries.indexOf(current) + 1 : null,
    };
  });
}

/**
 * What one lift has had done to it, in words.
 *
 * A lift nobody has started and a lift that was passed over read identically, and that is the
 * decision rather than an oversight. CLAUDE.md says a skip is not a failure state: no warning
 * colour, no badge, no running count of what was missed. Since the row stays on the list and stays
 * one tap away, the difference between the two has also stopped being a difference: both are a
 * lift with sets left and a way to go and do them.
 */
export function stateLine(row) {
  if (row.isCurrent) return `Now, set ${row.position} of ${row.planned}`;
  if (row.logged) return `${row.logged} of ${row.planned} sets logged`;
  return 'Not logged yet';
}

/**
 * Where in the day the client is, for the header chip and the panel head.
 *
 * Position, never progress. "Lift 3 of 7" is true whatever has been skipped, whereas any count of
 * lifts done has to decide what a passed over lift is, and every answer to that is either a lie or
 * a scoreboard.
 */
export function positionLine(rows) {
  if (!rows.length) return 'No lifts in this day';
  const at = rows.findIndex((row) => row.isCurrent) + 1;
  return at ? `Lift ${at} of ${rows.length}` : `${rows.length} lift${rows.length === 1 ? '' : 's'}`;
}

function renderRow(row) {
  const inner =
    `<span class="worknav__num num">${esc(row.group ?? '')}</span>` +
    `<span class="worknav__body">` +
    `<span class="worknav__name">${esc(row.name)}` +
    (row.variation ? ` <span class="worknav__variation">${esc(row.variation)}</span>` : '') +
    `</span>` +
    (row.target ? `<span class="worknav__target">${esc(row.target)}</span>` : '') +
    `<span class="worknav__state num">${esc(stateLine(row))}</span>` +
    (row.notes ? `<span class="worknav__note">${esc(row.notes)}</span>` : '') +
    `</span>`;

  // Lit means pressable, flat means not, which is the same rule the steppers and the chooser chips
  // follow. A finished lift is a plain slab with a border and no fall of light on it, so the thing
  // that says "you cannot go here" is the same thing that says "this is not a control".
  if (row.at === null) return `<li class="worknav__row is-full">${inner}</li>`;

  return (
    `<li><button type="button" class="worknav__row${row.isCurrent ? ' is-now' : ''}" ` +
    `data-jump="${row.at}"${row.isCurrent ? ' aria-current="true"' : ''}>${inner}</button></li>`
  );
}

/** The list. The panel around it lives in index.html, because its head and foot never change. */
export function renderOverview(rows) {
  if (!rows.length) return `<p class="worknav__empty">No lifts in this day.</p>`;
  return `<ul class="worknav__list">${rows.map(renderRow).join('')}</ul>`;
}
