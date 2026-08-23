// What one day's training actually was, set by set.
//
// This is what a tapped cell on the consistency grid opens. The grid says a session happened and
// the charts say how it compared; neither of them can say what was in it, and "what did I do on
// the sixteenth" is the question somebody taps a calendar square to ask.
//
// It replaced a single line that named the lifts and counted the sets. That line was right about
// one thing and it is kept: it deliberately carried no weights, so that flipping kg to lb did not
// have to redraw the calendar. Carrying weights gives that up on purpose, and the cost is paid
// where it belongs rather than hidden: nothing here formats a weight itself, the caller passes the
// one formatter in js/units.js, and the progress screen redraws this on a unit toggle alongside
// the charts. A readout of a workout that cannot say what was on the bar is not a readout of a
// workout.
//
// Pure, like js/consistency-view.js and js/workout-view.js: data in, a string out, so test.js can
// check it with no DOM.
//
// WHAT IS NOT HERE. No total, no score, no comparison against the session before it, and no
// judgement of any kind. The charts above already carry the comparison, with the session ringed in
// them, and a grade printed under a list of sets is the guilt messaging CLAUDE.md rules out
// arriving through the back door. Warmups are marked rather than dropped, because this is the
// record of what happened rather than a number carrying a claim, and a set added beyond the plan
// is marked for the same reason: the trainer needs prescribed and actual separable on sight.

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * One set, in the fewest words that are still true.
 *
 * Four shapes, because four things get logged against a set row and only one of them is the
 * barbell case: a load and reps, reps with nothing on them, a hold in seconds, and rounds of an
 * AMRAP. A row is whichever of those it carries, and a row carrying a load AND a hold says both.
 *
 * Bodyweight is said as the word rather than as "0 kg", which is the same fix the rest of the app
 * made: zero on the bar is not zero load, it is a pullup.
 */
export function setLine(row, weight) {
  const parts = [];
  const loaded = Number.isFinite(row.weight_kg) && row.weight_kg > 0;

  if (Number.isFinite(row.hold_seconds) && row.hold_seconds > 0) {
    parts.push(`${round1(row.hold_seconds)}s`);
    if (loaded) parts.push(`with ${weight(row.weight_kg)}`);
  } else if (Number.isFinite(row.rounds) && row.rounds > 0) {
    parts.push(`${row.rounds} round${row.rounds === 1 ? '' : 's'}`);
    if (loaded) parts.push(`with ${weight(row.weight_kg)}`);
  } else if (Number.isFinite(row.reps) && row.reps > 0) {
    // The multiplication sign, not the letter x. It is the one character on this line that is
    // read a hundred times a session.
    parts.push(loaded ? `${weight(row.weight_kg)} × ${row.reps}` : `Bodyweight × ${row.reps}`);
  } else if (loaded) {
    // A carry or a sled: the load is the whole of what happened and there is nothing to count.
    parts.push(weight(row.weight_kg));
  } else {
    return 'Logged';
  }

  if (Number.isFinite(row.rpe) && row.rpe > 0) parts.push(`RPE ${round1(row.rpe)}`);
  return parts.join(' ');
}

/** The word for what a row is, where it is anything other than a prescribed working set. */
function tagOf(row) {
  if (row.is_warmup) return 'Warmup';
  if (row.is_extra) return 'Added';
  return '';
}

function renderSet(row, index, weight) {
  const tag = tagOf(row);
  return (
    `<li class="readout__set">` +
    `<span class="readout__setno num">${index + 1}</span>` +
    `<span class="readout__setval num">${esc(setLine(row, weight))}</span>` +
    (tag ? `<span class="readout__tag">${esc(tag)}</span>` : '') +
    `</li>`
  );
}

function renderLift(lift, weight) {
  return (
    `<div class="readout__lift">` +
    `<p class="readout__liftname">${esc(lift.name)}</p>` +
    `<ol class="readout__sets">${lift.sets.map((row, i) => renderSet(row, i, weight)).join('')}</ol>` +
    `</div>`
  );
}

function renderSession(session, weight) {
  return (
    `<article class="readout__session">` +
    `<p class="readout__head">` +
    `<span class="readout__label">${esc(session.label)}</span>` +
    (session.time ? `<span class="readout__time num">${esc(session.time)}</span>` : '') +
    // Said in a word, never in a colour, same as every other state in this app.
    (session.isOpen ? `<span class="readout__open">Still open</span>` : '') +
    `</p>` +
    // How it felt, in the client's own words. It is the half of a workout no chart above can draw,
    // which is most of why this readout is worth opening at all.
    (session.note ? `<p class="readout__note">${esc(session.note)}</p>` : '') +
    (session.lifts.length
      ? session.lifts.map((lift) => renderLift(lift, weight)).join('')
      : `<p class="readout__none">No sets logged in this one.</p>`) +
    `</article>`
  );
}

/**
 * The whole day.
 *
 * `weight` is the formatter from js/units.js, passed in rather than imported so this stays a
 * function of its arguments and so nothing here can format a weight its own way. CLAUDE.md gives
 * that job to one module and this is not it.
 *
 * More than one session on a day is drawn as more than one session, in the order they were
 * started. That is the same thing the grid does with the cell it puts two sessions in, and it is
 * the honest shape: a client who restarted on the right day did two sessions, and merging them
 * would invent a workout nobody did.
 */
export function renderSessionReadout({ day, dayLabel, sessions = [] } = {}, { weight } = {}) {
  if (!sessions.length) return '';
  const format = typeof weight === 'function' ? weight : (v) => String(v);

  return (
    `<div class="readout" data-day="${esc(day)}">` +
    `<p class="readout__day">${esc(dayLabel)}</p>` +
    sessions.map((session) => renderSession(session, format)).join('') +
    `</div>`
  );
}
