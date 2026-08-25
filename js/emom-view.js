// The EMOM screen: what a clock-led day looks like at arm's length.
//
// Rendered from js/emom.js and nothing else, and mounted by two callers: the logging screen in
// app.js, and the rehearsal harness in emom-test.html which runs the same view at sixty times
// speed so a half hour block can be watched in thirty seconds. Two callers is the point. A
// rehearsal that drew its own approximation of this screen would be a rehearsal of the wrong
// thing, and this is the one screen in the app that cannot be checked by tapping through it: the
// failure modes are all about time passing.
//
// What the screen owes the client, in the order they need it mid effort:
//
//   the clock       largest thing on screen, because the whole day is a race against it
//   the work now    the lift and the rep count, read at a glance while moving
//   what is next    so the last ten seconds are spent getting into position, not reading
//   where they are  round and minute, smallest, because it is reassurance rather than instruction
//
// The lighting rules from CLAUDE.md apply unchanged. The clock is a mid-set control and is lit;
// the round and station lines are chrome and are flat. No green anywhere: `--done` marks a
// finished session in the three places it is fenced to, and a fifth meaning of "you are on time"
// is exactly the overload that fence exists to prevent. What says the window is nearly out is the
// numeral and the track emptying, which is size and position rather than hue.

import { emomAt, emomClock } from './emom.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The markup, once. Everything that changes per frame is addressed by id below rather than
 * rebuilt, because this redraws four times a second for half an hour and rebuilding the subtree
 * would drop the client's own tap on Missed it somewhere in the middle of it.
 */
export function mountEmomView(host) {
  host.innerHTML = `
    <div class="emom" data-state="running">
      <p class="emom__where num" data-emom-where></p>

      <p class="emom__lift" data-emom-lift></p>
      <p class="emom__reps num" data-emom-reps></p>

      <div class="emom__clock">
        <span class="emom__time num" data-emom-time role="timer" aria-live="off">0:00</span>
        <span class="emom__track" aria-hidden="true"><span class="emom__fill" data-emom-fill></span></span>
      </div>

      <p class="emom__next" data-emom-next></p>

      <!-- The only control on the screen while the block runs, and it is deliberately not a
           stepper. Mid EMOM there is no time to dial a number: the honest thing a client can say
           in the two seconds they have is "not that one", and the exact count is a correction they
           make afterwards from the summary, when they are breathing again. -->
      <button type="button" class="emom__missed" data-emom-missed>Missed it</button>
    </div>`;

  const node = (name) => host.querySelector(`[data-emom-${name}]`);
  return {
    root: host.querySelector('.emom'),
    where: node('where'),
    lift: node('lift'),
    reps: node('reps'),
    time: node('time'),
    fill: node('fill'),
    next: node('next'),
    missed: node('missed'),
  };
}

/**
 * One frame.
 *
 * Takes elapsed rather than reading a clock itself, which is what lets the rehearsal harness scale
 * time and what lets the tests below check the wording at exact moments. `missed` is the set of
 * window indices the client has flagged, so a flagged window keeps saying so for as long as it is
 * on screen rather than flickering back.
 */
export function drawEmom(ui, block, elapsedMs, missed) {
  const at = emomAt(block, elapsedMs);
  const stationCount = block.stations.length;

  ui.root.dataset.state = at.done ? 'done' : 'running';
  ui.where.textContent = at.done
    ? `${block.minutes} of ${block.minutes} done`
    : `Round ${at.round + 1} of ${block.rounds}  ·  Minute ${at.index + 1} of ${block.minutes}`;

  ui.lift.textContent = at.station.name;
  ui.reps.textContent = at.station.reps ? `${at.station.reps} reps` : '';

  ui.time.textContent = at.done ? 'Done' : emomClock(at.remainingMs);
  // Empties as the window runs out, so the track is shortest when the pressure is highest. Same
  // direction as the rest timer, so the two never read as opposites of each other.
  ui.fill.style.width = at.done ? '0%' : `${(at.remainingMs / block.windowMs) * 100}%`;

  // The next station, so the last seconds of a window are spent moving rather than reading. The
  // block's last window says so instead: "Next" pointing back at the top of a block that is about
  // to end would send somebody to a station they are not doing.
  if (at.done) {
    ui.next.textContent = '';
  } else if (at.index + 1 >= block.minutes) {
    ui.next.textContent = 'Last one';
  } else {
    ui.next.textContent = `Next: ${block.stations[(at.index + 1) % stationCount].name}`;
  }

  const flagged = missed?.has(at.index);
  ui.missed.textContent = flagged ? 'Marked short' : 'Missed it';
  ui.missed.dataset.flagged = flagged ? 'true' : 'false';
  ui.missed.hidden = at.done;

  return at;
}

/**
 * What the block did, once the clock has run out.
 *
 * Counts windows rather than reps, because that is what an EMOM is scored on: the question is how
 * many minutes the client kept up with, and a rep total across six different exercises is a number
 * that means nothing. No grade, no percentage and no colour on the shortfall, per the no-guilt
 * rule: a client who held twenty six of thirty windows did twenty six windows of work.
 */
export function emomSummary(block, missedCount) {
  const kept = block.minutes - missedCount;
  const rounds = `${block.rounds} round${block.rounds === 1 ? '' : 's'}`;
  if (!missedCount) return `${rounds}, all ${block.minutes} windows`;
  return `${rounds}, ${kept} of ${block.minutes} windows`;
}

/** The line under a lift name on the program view, so a client reading ahead knows it is a clock. */
export function emomTargetLine(block, station) {
  const reps = station?.reps ? `${station.reps} reps` : 'work';
  return `${reps} inside ${block.windowSeconds}s, ${block.rounds} times`;
}

export { esc as escapeForEmom };
