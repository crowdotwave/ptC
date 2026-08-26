// The EMOM rehearsal. A clock this page controls, driving the real screen.
//
// Why this page exists rather than a checklist: every failure mode of a clock-led day is about
// time passing. A window that never closes, a station that repeats, a round counter that sticks,
// a row written twice, a block that restarts on reload. None of those can be found by looking at
// a screenshot, and finding them at 1x means standing over a phone for half an hour per attempt.
// At 240x, Emma's block runs in seven and a half seconds.
//
// It opens at 10x rather than 60x, because the page has a control now and a window at 60x lasts one
// real second, which is not long enough to press anything and see what it did.
//
// It mounts js/emom-view.js and drives it from js/emom.js, which is the whole point. A rehearsal
// that drew its own version of the screen would be a rehearsal of something the client never
// sees. The only thing this page owns is the clock, and it owns that so it can lie about it.
//
// Nothing is written. `emomAdvance` is asked the same question the logging screen asks it, and the
// answers are listed rather than turned into rows, so what appears in that column is exactly what
// would have been appended to set_logs, in the order it would have landed.

import {
  emomBlock, emomLength, emomStart, emomAdvance, emomWhere, emomAddMinute,
} from './js/emom.js';
import { mountEmomView, drawEmom, emomSummary } from './js/emom-view.js';

// Emma's actual day, so the rehearsal is of the thing that prompted this rather than of a
// convenient toy. Six stations, the rep counts off her program.
const STATIONS = [
  ['DB THRUSTERS', 12],
  ['ALT DB SNATCH', 12],
  ['STANDING TOE TAPS', 40],
  ['MOUNTAIN CLIMBERS', 40],
  ['BICYCLE CRUNCHES', 30],
  ['JUMPING SQUATS', 15],
];

const el = (id) => document.getElementById(id);

const state = {
  // Ten, not sixty. A window at 60x lasts one real second, which is not long enough to press the
  // one control on this page and see what it did. At 10x a window is six seconds and a thirty
  // minute block still runs in three minutes. 60x and 240x are a button away for watching the
  // clock itself, which is what they are for.
  speed: 10,
  running: true,
  // The page's own clock, in BLOCK milliseconds rather than wall milliseconds. Advanced by the wall
  // delta times the speed, so changing speed mid run changes the rate from here on rather than
  // teleporting the block. js/emom.js is handed this as if it were Date.now(), which is the whole
  // trick: the module never learns it is being lied to.
  clock: 0,
  last: performance.now(),
  block: null,
  cursor: null,
  ui: null,
};

function rebuild() {
  const rounds = Math.max(1, Math.round(Number(el('rounds').value) || 1));
  const window = Math.max(5, Math.round(Number(el('window').value) || 60));
  const count = Math.min(STATIONS.length, Math.max(1, Math.round(Number(el('stations').value) || 1)));

  state.block = emomBlock(
    { emom: { rounds, window_seconds: window } },
    STATIONS.slice(0, count).map(([name, reps]) => ({
      exercise_id: `e-${name}`,
      exercise: { name },
      reps,
    })),
    (item) => item.reps,
  );

  el('block-state').textContent = emomLength(state.block);
  restart();
}

function restart() {
  state.clock = 0;
  state.last = performance.now();
  state.cursor = emomStart(state.block, 0);
  el('written').innerHTML = '';
  paint();
}

function setSpeed(speed) {
  state.speed = speed;
  el('speed-state').textContent = `${speed}x`;
}

/**
 * One frame. The same two steps the logging screen takes, in the same order.
 *
 * Advance the clock and record what closed on the way, then draw where it ended up. Advance before
 * draw is the order app.js uses and the reason js/emom.js splits the two: a draw that could write
 * rows would make every redraw a thing with consequences.
 */
function paint() {
  const moved = emomAdvance(state.block, state.cursor, state.clock);
  state.cursor = moved.cursor;

  for (const minute of moved.due) {
    const row = document.createElement('li');
    row.className = 'rehearse__row';
    row.textContent =
      `min ${String(minute.index + 1).padStart(2, ' ')}  ` +
      `r${minute.round + 1}  ${minute.station.name}  ${minute.station.reps} reps`;
    el('written').append(row);
    el('written').scrollTop = el('written').scrollHeight;
  }

  const at = emomWhere(state.block, state.cursor, state.clock);
  drawEmom(state.ui, state.block, at);

  const done = state.cursor.windowsDone;
  el('written-count').textContent = at.done
    ? `${done} of ${state.block.minutes}. ${emomSummary(state.block)}`
    : `${done} of ${state.block.minutes}${at.stretched ? ', extra minute running' : ''}`;
}

function frame(now) {
  const delta = now - state.last;
  state.last = now;

  if (state.running) {
    // Not clamped to the block's nominal duration any more: adding a minute makes the block longer
    // than emomDurationMs says, and clamping to that number would freeze the clock before the last
    // window closed. The cursor decides when it is over.
    state.clock += delta * state.speed;
    paint();
  }

  requestAnimationFrame(frame);
}

function start() {
  state.ui = mountEmomView(el('screen'));

  state.ui.more.addEventListener('click', () => {
    state.cursor = emomAddMinute(state.block, state.cursor, state.clock);
    paint();
  });

  state.ui.start.addEventListener('click', () => {
    state.cursor = emomStart(state.block, state.clock);
    paint();
  });

  for (const button of document.querySelectorAll('[data-speed]')) {
    button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)));
  }

  el('play').addEventListener('click', () => {
    state.running = !state.running;
    el('play').textContent = state.running ? 'Pause' : 'Play';
  });

  el('restart').addEventListener('click', restart);
  for (const id of ['rounds', 'window', 'stations']) el(id).addEventListener('change', rebuild);

  setSpeed(state.speed);
  rebuild();
  requestAnimationFrame(frame);
}

start();

// Read by the browser tooling, the same way test.js exposes its results, so a rehearsal can be
// driven and asserted on from a script rather than only watched by a person.
window.__emom = {
  state,
  jumpTo: (ms) => {
    state.clock = ms;
    paint();
  },
  addMinute: () => {
    state.cursor = emomAddMinute(state.block, state.cursor, state.clock);
    paint();
  },
  where: () => emomWhere(state.block, state.cursor, state.clock),
  rows: () => [...document.querySelectorAll('#written .rehearse__row')].map((r) => r.textContent),
};
