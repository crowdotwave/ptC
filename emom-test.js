// The EMOM rehearsal. A clock this page controls, driving the real screen.
//
// Why this page exists rather than a checklist: every failure mode of a clock-led day is about
// time passing. A window that never closes, a station that repeats, a round counter that sticks,
// a row written twice, a block that restarts on reload. None of those can be found by looking at
// a screenshot, and finding them at 1x means standing over a phone for half an hour per attempt.
// At 240x, Emma's block runs in seven and a half seconds.
//
// It mounts js/emom-view.js and drives it from js/emom.js, which is the whole point. A rehearsal
// that drew its own version of the screen would be a rehearsal of something the client never
// sees. The only thing this page owns is the clock, and it owns that so it can lie about it.
//
// Nothing is written. `emomDue` is asked the same question the logging screen asks it, and the
// answers are listed rather than turned into rows, so what appears in that column is exactly what
// would have been appended to set_logs, in the order it would have landed.

import { emomBlock, emomDue, emomLength, emomDurationMs } from './js/emom.js';
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
  speed: 60,
  running: true,
  // Elapsed in BLOCK time, not wall time. Advanced by the wall clock delta times the speed, so
  // changing speed mid run does not teleport the block: it changes the rate from here on.
  elapsed: 0,
  last: performance.now(),
  written: 0,
  missed: new Set(),
  block: null,
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
  state.elapsed = 0;
  state.last = performance.now();
  state.written = 0;
  state.missed = new Set();
  el('written').innerHTML = '';
  paint();
}

function setSpeed(speed) {
  state.speed = speed;
  el('speed-state').textContent = `${speed}x`;
}

/**
 * One frame.
 *
 * The two things the logging screen does every tick, in the same order: ask where the block is and
 * draw it, then ask what has fallen due and record it. Asking in that order matters, because the
 * window a client is standing in is drawn before the one that just closed is written, which is
 * what keeps the screen ahead of the log rather than a frame behind it.
 */
function paint() {
  const at = drawEmom(state.ui, state.block, state.elapsed, state.missed);

  for (const minute of emomDue(state.block, state.elapsed, state.written)) {
    state.written += 1;
    const short = state.missed.has(minute.index);
    const row = document.createElement('li');
    row.className = short ? 'rehearse__row rehearse__row--short' : 'rehearse__row';
    row.textContent =
      `min ${String(minute.index + 1).padStart(2, ' ')}  ` +
      `r${minute.round + 1}  ${minute.station.name}  ` +
      `${short ? 'short' : `${minute.station.reps} reps`}`;
    el('written').append(row);
    el('written').scrollTop = el('written').scrollHeight;
  }

  el('written-count').textContent = at.done
    ? `${state.written} of ${state.block.minutes}. ${emomSummary(state.block, state.missed.size)}`
    : `${state.written} of ${state.block.minutes}`;
}

function frame(now) {
  const delta = now - state.last;
  state.last = now;

  if (state.running) {
    const end = emomDurationMs(state.block);
    // Clamped at the end rather than left to run on, so the page does not sit there counting up
    // through a block that finished, and so `done` is reached exactly once.
    state.elapsed = Math.min(end, state.elapsed + delta * state.speed);
    paint();
  }

  requestAnimationFrame(frame);
}

function start() {
  state.ui = mountEmomView(el('screen'));

  state.ui.missed.addEventListener('click', () => {
    // The index of the window currently on screen, asked of the same function that drew it.
    const at = drawEmom(state.ui, state.block, state.elapsed, state.missed);
    if (at.done) return;
    if (state.missed.has(at.index)) state.missed.delete(at.index);
    else state.missed.add(at.index);
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
    state.elapsed = ms;
    paint();
  },
  markMissed: (index) => {
    state.missed.add(index);
    paint();
  },
  rows: () => [...document.querySelectorAll('#written .rehearse__row')].map((r) => r.textContent),
};
