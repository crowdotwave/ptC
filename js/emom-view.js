// The EMOM screen: what a clock-led day looks like at arm's length.
//
// Rendered from js/emom.js and nothing else, and mounted by two callers: the logging screen in
// app.js, and the rehearsal harness in emom-test.html which runs the same view at speed so a half
// hour block can be watched in seconds. Two callers is the point. A rehearsal that drew its own
// approximation of this screen would be a rehearsal of the wrong thing, and this is the one screen
// in the app that cannot be checked by tapping through it: the failure modes are all about time
// passing.
//
// What the screen owes the client, in the order they need it mid effort:
//
//   the clock       largest thing on screen, because the whole day is a race against it
//   the work now    the lift and the rep count, read at a glance while moving
//   what is next    so the last ten seconds are spent getting into position, not reading
//   where they are  round and minute, smallest, because it is reassurance rather than instruction
//
// One control, and it adds a minute to the window now running. It replaced a "Missed it" flag,
// which was the wrong shape twice over: it asked the client to file a report about failing, on the
// one screen in this app most tempted to grade somebody, and it did nothing to help them. Adding a
// minute is the same situation answered usefully. Somebody who is behind takes the extra window,
// catches up, and rejoins the block on the next minute, which is what they would do with a clock on
// the wall.
//
// The lighting rules from CLAUDE.md apply unchanged. No green anywhere: `--done` marks a finished
// session in the three places it is fenced to, and a fifth meaning of "you are on time" is exactly
// the overload that fence exists to prevent. What says a window is nearly out is the numeral falling
// and the track emptying, which is size and position rather than hue.

import { emomClock, emomLength } from './emom.js';

/**
 * The markup, once. Everything that changes per frame is addressed below rather than rebuilt,
 * because this redraws four times a second for half an hour and rebuilding the subtree would drop
 * the client's own press on the catch up control somewhere in the middle of it.
 */
export function mountEmomView(host) {
  host.innerHTML = `
    <div class="emom" data-state="ready">
      <p class="emom__where num" data-emom-where></p>

      <p class="emom__lift" data-emom-lift></p>
      <p class="emom__reps num" data-emom-reps></p>

      <div class="emom__clock">
        <span class="emom__time num" data-emom-time role="timer" aria-live="off">0:00</span>
        <span class="emom__track" aria-hidden="true"><span class="emom__fill" data-emom-fill></span></span>
      </div>

      <p class="emom__next" data-emom-next></p>

      <!-- The one control while the block runs. Not a stepper and not a question: mid EMOM there is
           no time to dial a number or answer anything, and the only useful thing the app can offer
           somebody who has fallen behind is more time. -->
      <button type="button" class="emom__more" data-emom-more>
        <span data-emom-more-label>Add a minute</span>
      </button>

      <!-- Nothing starts on arrival, and that is not a nicety. A clock that began the moment the
           screen loaded would spend the client's first window on walking to the rack and picking up
           dumbbells, and there is no pausing an EMOM once it is going: the whole block would be a
           minute out for the next half hour. So the clock waits for a deliberate press, and the
           press is the biggest target on the screen because it is made with a thumb, standing over
           the equipment, about to start moving. -->
      <button type="button" class="emom__start" data-emom-start>
        <span data-emom-start-label>Start the clock</span>
        <span class="emom__startsub num" data-emom-start-sub></span>
      </button>
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
    more: node('more'),
    moreLabel: node('more-label'),
    start: node('start'),
    startLabel: node('start-label'),
    startSub: node('start-sub'),
  };
}

/**
 * The screen before the clock is running: what the block is, and the one press that begins it.
 *
 * Says the whole block rather than the first station, because the decision being made here is
 * whether to start half an hour of work, and the first lift is not that decision. The first station
 * gets named underneath so the client knows what to be standing over.
 */
export function readyEmom(ui, block, resumable) {
  ui.root.dataset.state = 'ready';
  ui.where.textContent = emomLength(block);
  ui.lift.textContent = block.stations[0].name;
  ui.reps.textContent = block.stations[0].reps ? `${block.stations[0].reps} reps` : '';
  ui.time.textContent = emomClock(block.windowMs);
  ui.fill.style.width = '100%';
  ui.next.textContent = block.stations.length > 1 ? `Next: ${block.stations[1].name}` : '';
  ui.more.hidden = true;
  ui.start.hidden = false;
  ui.startLabel.textContent = resumable ? 'Pick the clock back up' : 'Start the clock';
  ui.startSub.textContent = resumable ? 'It kept running' : `${block.minutes} windows`;
}

/**
 * One frame. Takes the answer emomWhere already worked out rather than working it out again, so the
 * screen and the rows can never be drawn from two different readings of the clock.
 */
export function drawEmom(ui, block, at) {
  ui.root.dataset.state = at.done ? 'done' : 'running';
  ui.where.textContent = at.done
    ? `${block.minutes} of ${block.minutes} done`
    : `Round ${at.round + 1} of ${block.rounds}  ·  Minute ${at.index + 1} of ${block.minutes}`;

  ui.lift.textContent = at.station.name;
  ui.reps.textContent = at.station.reps ? `${at.station.reps} reps` : '';

  ui.time.textContent = at.done ? 'Done' : emomClock(at.remainingMs);
  // Empties as the window runs out, so the track is shortest when the pressure is highest. Measured
  // against this window's own length, so a window with a minute added drains across the whole of
  // its longer self rather than filling past the end of the track.
  ui.fill.style.width = at.done ? '0%' : `${(at.remainingMs / at.windowMs) * 100}%`;

  // The next station, so the last seconds of a window are spent moving rather than reading. The
  // block's last window says so instead: "Next" pointing back at the top of a block that is about
  // to end would send somebody to a station they are not doing.
  //
  // A window with a minute added says THAT instead, and it outranks the next lift. A clock reading
  // 1:47 on a block whose windows are a minute long is otherwise the app looking broken, and the
  // client needs to know the extra time is real before they decide how to spend it.
  if (at.done) {
    ui.next.textContent = '';
  } else if (at.stretched) {
    ui.next.textContent = 'Extra minute on this one';
  } else if (at.index + 1 >= block.minutes) {
    ui.next.textContent = 'Last one';
  } else {
    ui.next.textContent = `Next: ${block.stations[(at.index + 1) % block.stations.length].name}`;
  }

  ui.more.hidden = !at.running;
  ui.start.hidden = true;
}

/**
 * What the block did, once the clock has run out.
 *
 * Counts windows rather than reps, because that is what an EMOM is scored on: the question is how
 * many minutes the client kept up with, and a rep total across six different exercises is a number
 * that means nothing. No grade, no percentage and no shortfall, per the no-guilt rule. Every window
 * of a block that ran to the end is a window the client stood through.
 */
export function emomSummary(block) {
  const rounds = `${block.rounds} round${block.rounds === 1 ? '' : 's'}`;
  return `${rounds}, ${block.minutes} window${block.minutes === 1 ? '' : 's'}`;
}
