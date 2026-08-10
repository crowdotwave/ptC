// The session history list, as HTML. Takes what js/session.js summarised and nothing else.
//
// A string rather than a container write, matching js/consistency-view.js and js/program-view.js,
// which is what lets test.js check the markup with no DOM.
//
// This list is the plainest screen in the app on purpose. The consistency grid above it is the
// thing that is meant to feel good to look at: cells accumulating, records ringed, a month of
// work visible at a glance. This is the maintenance view underneath it, where somebody goes to
// fix a mis-tap, and a maintenance view that competes with the centrepiece for attention is a
// maintenance view in the wrong place. No colour, no glyphs, no slot faces.
//
// Discard is deliberately two taps and deliberately not a dialog:
//
//   the logging screen has no confirmation dialogs anywhere, and that rule is about not
//   interrupting somebody mid set. It is not a licence to make a destructive action on a
//   different screen one tap, so this arms first and commits second.
//
//   the confirmation is the button itself rather than a modal. A modal here would be the only
//   one in the app, it would need its own focus trap and escape handling, and it would say the
//   same eight words this button can say on its own.
//
// Nothing here says a discarded session was a failure, and there is no count of discarded
// sessions anywhere. Throwing away a mis-tap is housekeeping, not a lapse.

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Undated';
};

const clock = (iso) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';
};

/**
 * What one session did, in one line.
 *
 * Working sets lead because that is the session. Warmups are named separately rather than folded
 * in, since folding them in is the one way this line could overstate a workout.
 */
export function summaryLine(entry) {
  if (!entry.sets && !entry.warmups) return 'Nothing logged';
  const parts = [];
  if (entry.sets) parts.push(`${entry.sets} ${entry.sets === 1 ? 'set' : 'sets'}`);
  if (entry.warmups) parts.push(`${entry.warmups} ${entry.warmups === 1 ? 'warmup' : 'warmups'}`);
  return parts.join(', ');
}

function renderRow(entry, armedId) {
  const armed = entry.id === armedId;
  const time = clock(entry.startedAt);

  return (
    `<li class="history__row${armed ? ' is-armed' : ''}" data-session="${esc(entry.id)}">` +
    `<div class="history__what">` +
    `<span class="history__day">${esc(entry.label)}</span>` +
    `<span class="history__when num">${esc(stamp(entry.startedAt))}${time ? `, ${esc(time)}` : ''}</span>` +
    `<span class="history__sets num">${esc(summaryLine(entry))}` +
    // Said in words, never in a colour, same as every other state in this app.
    `${entry.isOpen ? ', still open' : ''}</span>` +
    `</div>` +
    (armed
      ? `<div class="history__confirm">` +
        `<button type="button" class="button-secondary history__keep" data-act="keep">Keep</button>` +
        `<button type="button" class="button-secondary history__go" data-act="discard">Discard</button>` +
        `</div>`
      : `<button type="button" class="button-secondary history__arm" data-act="arm" ` +
        `aria-label="Discard ${esc(entry.label)}, ${esc(stamp(entry.startedAt))}">Discard</button>`) +
    `</li>`
  );
}

/**
 * The whole list.
 *
 * `armedId` is the session whose Discard has been tapped once. It lives in the caller rather than
 * in here so that this stays a function of its arguments, which is also what makes a redraw after
 * a discard trivial.
 *
 * The empty state is an invitation rather than an apology, per the copy rules, and it is the
 * state a new client sees.
 */
export function renderHistory(entries, { armedId = null, limit = 30 } = {}) {
  if (!entries.length) {
    return '<p class="history__empty">Sessions appear here once you log one.</p>';
  }

  const shown = entries.slice(0, limit);
  const rest = entries.length - shown.length;

  return (
    `<ul class="history__list">${shown.map((entry) => renderRow(entry, armedId)).join('')}</ul>` +
    // A count rather than a pager. Somebody scrolling to the bottom of thirty sessions is looking
    // for a specific one, and the honest thing to tell them is how much further back it goes.
    (rest > 0
      ? `<p class="history__more">${rest} older ${rest === 1 ? 'session' : 'sessions'} not shown.</p>`
      : '')
  );
}

/** What to say after a discard. Names what was given up, because that is what was at stake. */
export function discardedMessage(entry, setsTaken) {
  const what = setsTaken
    ? `${setsTaken} ${setsTaken === 1 ? 'set' : 'sets'} taken back`
    : 'nothing was logged in it';
  return `Discarded ${entry.label}, ${stamp(entry.startedAt)}. ${what}.`;
}
