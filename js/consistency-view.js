// The consistency grid, as HTML. Takes what js/consistency.js built and nothing else.
//
// Returns a string rather than writing into a container, matching js/program-view.js. The charts
// in js/charts.js write into theirs because they have to measure its width first; a calendar has
// no such need, and a string is what lets test.js check the markup without a DOM.
//
// Markup decisions that are not decoration:
//
//   a real table    with a caption and column headers, because a screen reader announcing 42
//                   unrelated buttons is not a calendar. The weekday row is <th scope="col">.
//   only trained    days are buttons. An untrained day is a <td> with a number in it. Making the
//                   whole month focusable would be 42 tab stops to reach one fact.
//   no missed state there is no class, no attribute and no word here for a day nobody trained.
//                   The cell is a number on black. See CLAUDE.md on streak pressure.
//   the deload      is dashed AND says so in words, per the encoding rules, and the words go in
//                   the month caption because a 40px cell has no room for them.

import { dayTitle } from './snapshot.js';

// Local, matching the four private copies already in charts.js, program-view.js, import-ui.js and
// app.js. Split labels are free text a trainer typed, so nothing here may skip it.
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Monday first, matching every other week boundary in the app. Two letters, because one letter
// gives T and S twice and the column header is the only place the ambiguity is not resolvable
// from context.
const WEEKDAYS = [
  ['Mo', 'Monday'],
  ['Tu', 'Tuesday'],
  ['We', 'Wednesday'],
  ['Th', 'Thursday'],
  ['Fr', 'Friday'],
  ['Sa', 'Saturday'],
  ['Su', 'Sunday'],
];

const longDay = (day) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

/**
 * One day.
 *
 * A trained day is a button carrying a slot class, a glyph, and its date. An untrained day is a
 * plain cell with the date in it and nothing else, which is the whole of the no-guilt rule as it
 * lands in markup: there is no branch below that adds anything to a day nobody trained.
 *
 * Today is marked by the weight of its own numeral rather than by a ring. A second ring beside the
 * record ring, differing only in colour, would be exactly the hue-only encoding the rules forbid.
 */
function renderCell(cell) {
  if (!cell.inMonth) return '<td class="cal__cell cal__cell--outside"></td>';

  const today = cell.isToday ? ' is-today' : '';
  const num = `<span class="cal__date num">${cell.dayOfMonth}</span>`;

  if (!cell.sessionIds.length) {
    return (
      `<td class="cal__cell${today}"${cell.isToday ? ' aria-current="date"' : ''}>` +
      `<span class="cal__empty">${num}</span></td>`
    );
  }

  const more = cell.sessionIds.length > 1 ? `, ${cell.sessionIds.length} sessions` : '';
  // The record is said in words as well as drawn, same as everywhere else this token is used. It
  // is the only thing on this grid that is a claim rather than a record of attendance.
  const label =
    `${longDay(cell.day)}, ${cell.label}${more}` +
    `${cell.isRecord ? ', personal record' : ''}${cell.isToday ? ', today' : ''}`;

  return (
    `<td class="cal__cell${today}"${cell.isToday ? ' aria-current="date"' : ''}>` +
    `<button type="button" class="cal__day is-slot-${cell.slot}` +
    `${cell.isDeload ? ' is-deload' : ''}${cell.isRecord ? ' is-record' : ''}" ` +
    `data-day="${esc(cell.day)}" aria-label="${esc(label)}">` +
    num +
    `<span class="cal__glyph" aria-hidden="true">${esc(cell.glyph)}</span>` +
    (cell.sessionIds.length > 1 ? '<span class="cal__twice" aria-hidden="true"></span>' : '') +
    `</button></td>`
  );
}

function renderWeek(week) {
  // The bracket is the shape and the caption is the words. Same treatment the volume chart gives
  // a deload bar, for the same reason: a back off week is planned, so it must not read as a dip.
  return (
    `<tr class="cal__week${week.isDeload ? ' is-deload' : ''}">` +
    week.days.map(renderCell).join('') +
    '</tr>'
  );
}

function renderLegend(month) {
  if (!month.legend.length) return '';
  return (
    `<ul class="cal__legend">` +
    month.legend
      .map(
        (entry) =>
          `<li class="cal__key"><span class="cal__keymark is-slot-${entry.slot}" aria-hidden="true">` +
          `${esc(entry.glyph)}</span>${esc(entry.label)}</li>`,
      )
      .join('') +
    '</ul>'
  );
}

/** One month panel. */
export function renderMonth(month) {
  const count = month.sessions === 1 ? '1 session' : `${month.sessions} sessions`;

  return (
    `<section class="cal__month" data-month="${esc(month.key)}" aria-label="${esc(month.label)}">` +
    `<table class="cal__grid">` +
    `<caption class="cal__caption"><span class="cal__monthname">${esc(month.label)}</span>` +
    `<span class="cal__count num">${count}</span></caption>` +
    `<thead><tr>` +
    WEEKDAYS.map(
      ([short, full]) =>
        `<th scope="col" class="cal__weekday"><abbr title="${full}">${short}</abbr></th>`,
    ).join('') +
    `</tr></thead>` +
    `<tbody>${month.weeks.map(renderWeek).join('')}</tbody>` +
    `</table>` +
    renderLegend(month) +
    (month.hasRecord ? '<p class="cal__note">A ringed day is one you set a record on.</p>' : '') +
    (month.hasDeload ? '<p class="cal__note">The bracketed week is a planned deload.</p>' : '') +
    '</section>'
  );
}

/**
 * The whole grid: a scroller of month panels, the controls that move it, and the detail line.
 *
 * The empty state is an invitation and not an apology, per the copy rules. It is also the state a
 * brand new client lands on, which is the single most common first view of this screen.
 */
export function renderConsistency(built) {
  if (!built.months.length) {
    return '<p class="cal__empty-state">Log a session and this fills in.</p>';
  }

  const controls =
    built.months.length > 1
      ? `<div class="cal__nav">` +
        `<button type="button" class="button-secondary cal__step" data-step="-1" aria-label="Previous month">&lsaquo;</button>` +
        `<button type="button" class="button-secondary cal__step" data-step="1" aria-label="Next month">&rsaquo;</button>` +
        `</div>`
      : '';

  return (
    controls +
    `<div class="cal__scroller" id="cal-scroller">${built.months.map(renderMonth).join('')}</div>` +
    // Height is reserved in CSS so tapping a day does not shift the grid out from under the
    // finger that just tapped it.
    `<p class="cal__detail" id="cal-detail" aria-live="polite"></p>`
  );
}

/**
 * The line under the grid, for one tapped day.
 *
 * Named lifts and a set count, no weights. That keeps this out of the unit switch's business: a
 * kg/lb toggle redraws the charts and must not have to redraw the calendar to stay honest. If a
 * weight ever belongs here it goes through units.js weightLabel and nothing else formats it.
 */
export function renderDetail({ day, sessions }) {
  if (!sessions.length) return '';

  const parts = sessions.map((session) => {
    const lifts = session.lifts.length ? session.lifts.join(', ') : 'no lifts logged';
    const sets = session.setCount === 1 ? '1 set' : `${session.setCount} sets`;
    return `${esc(session.label)}: ${esc(lifts)}. ${sets}.`;
  });

  // parts are already escaped piece by piece above. Escaping the joined string again would print
  // the entities rather than the apostrophes a trainer typed.
  return `<b class="cal__detailday">${esc(longDay(day))}</b> ${parts.join(' ')}`;
}

/** The name a session's day had, for the detail line. Exported so progress.js does not guess. */
export function sessionLabel(assignment, dayIndex) {
  const day = (assignment?.snapshot?.days ?? []).find((d) => d.day_index === dayIndex);
  return day ? dayTitle(day) : 'Unprogrammed';
}
