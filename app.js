// The client logging screen. Step 2 of the build order, against seeded data.
//
// The rules this screen exists to satisfy, from CLAUDE.md:
//   the next set is always the largest target on screen
//   last session's weight and reps for that exact exercise and set index are pre-filled
//   an identical set is one tap, with no confirmation anywhere
//   steppers, not a keyboard, and the keyboard only after an explicit tap
//   the rest timer starts on its own and never needs scrolling to
//   writes are optimistic and the UI never waits on the adapter
//   undo the last set is available for the whole session
//
// The adapter is the only persistence surface here. This file never touches IndexedDB.

import { openStorage, makeRecord, getDeviceId } from './js/storage.js';
import { seed, isSeeded, getDefaultClientId } from './js/seed.js';
import { activeSetLogs, lastPerformance, bestEstimated1rm, epley1rm } from './js/history.js';
import { HOLD_DELAY_MS, HOLD_START_MS, nextHoldInterval } from './js/hold.js';

const KG_PER_LB = 0.45359237;
const EMPTY_BAR_KG = 20;

const el = (id) => document.getElementById(id);
const ui = {
  clientName: el('client-name'),
  dayName: el('day-name'),
  exerciseName: el('exercise-name'),
  setPosition: el('set-position'),
  target: el('target'),
  lastTime: el('last-time'),
  prChip: el('pr-chip'),
  notice: el('notice'),
  controls: el('controls'),
  done: el('done'),
  doneTitle: el('done-title'),
  doneStat: el('done-stat'),
  rest: el('rest'),
  restFill: el('rest-fill'),
  restLabel: el('rest-label'),
  restTime: el('rest-time'),
  undo: el('undo'),
  typeToggle: el('type-toggle'),
  skip: el('skip'),
  end: el('end'),
  stepperWeight: el('stepper-weight'),
  stepperReps: el('stepper-reps'),
  weightValue: el('weight-value'),
  weightUnit: el('weight-unit'),
  weightInput: el('weight-input'),
  weightUp: el('weight-up'),
  weightDown: el('weight-down'),
  repsValue: el('reps-value'),
  repsInput: el('reps-input'),
  repsUp: el('reps-up'),
  repsDown: el('reps-down'),
  log: el('log'),
  logLabel: el('log-label'),
  logSub: el('log-sub'),
};

const state = {
  storage: null,
  client: null,
  assignment: null,
  day: null,
  plan: [],
  cursor: 0,
  sessionRecord: null,
  sessionWritten: false,
  sessionClosed: false,
  logged: [],
  best: new Map(),
  increments: new Map(),
  weightKg: EMPTY_BAR_KG,
  reps: 5,
  restEndsAt: 0,
  restTotal: 0,
  restHandle: null,
  typing: false,
};

// ------------------------------------------------------------------ units

const unit = () => (state.client ? state.client.weight_unit : 'kg');

/**
 * The smallest load change this lift can make, expressed in whatever unit the client reads.
 *
 * Stored as increment_kg on the exercise, because a barbell, a dumbbell rack, and a machine
 * stack all move differently and a single global step offers weights the gym cannot make.
 * A client reading pounds wants round pounds, so the kilogram increment is converted and then
 * snapped to the nearest 2.5lb, which is what a plate tree actually holds.
 */
function stepSize(entry = currentEntry()) {
  const kg = (entry && state.increments.get(entry.item.exercise_id)) || 2.5;
  if (unit() !== 'lb') return kg;
  return Math.max(2.5, Math.round(kg / KG_PER_LB / 2.5) * 2.5);
}
const toDisplay = (kg) => (unit() === 'lb' ? kg / KG_PER_LB : kg);
const fromDisplay = (value) => Math.round((unit() === 'lb' ? value * KG_PER_LB : value) * 1000) / 1000;

function formatWeight(kg) {
  const shown = toDisplay(kg);
  return unit() === 'lb' ? String(Math.round(shown)) : String(Math.round(shown * 10) / 10);
}

// ------------------------------------------------------------------ optimistic writes

// Serial so a set_log never reaches the adapter before the session row it points at. Nothing
// in the UI awaits this queue: a tap updates the screen and the write catches up.
let writeQueue = Promise.resolve();

function write(task) {
  writeQueue = writeQueue.then(task).catch((error) => {
    showNotice(`Saved on this device only. ${error.message}`, 'attention');
  });
}

function showNotice(text, tone = 'neutral') {
  ui.notice.textContent = text;
  ui.notice.dataset.tone = tone;
  ui.notice.hidden = false;
}

function clearNotice() {
  ui.notice.hidden = true;
}

// ------------------------------------------------------------------ loading

async function loadClientData(storage, clientId) {
  const client = await storage.get('clients', clientId);
  const assignments = await storage.query(
    'assignments',
    { client_id: clientId },
    { orderBy: 'starts_on', direction: 'desc', limit: 1 },
  );
  const assignment = assignments[0];
  const sessions = await storage.query('sessions', { client_id: clientId }, { orderBy: 'started_at' });
  return { client, assignment, sessions };
}

/**
 * Which day comes next. The frozen snapshot decides, never the live template, so editing the
 * program does not rewrite what this client was told to do.
 */
function pickDay(snapshot, sessions) {
  const days = [...snapshot.days].sort((a, b) => a.day_index - b.day_index);
  if (!sessions.length) return days[0];
  const last = sessions[sessions.length - 1];
  const position = days.findIndex((day) => day.day_index === last.day_index);
  return days[(position + 1) % days.length];
}

/**
 * The planned sets, in order, each already carrying the prefill it needs.
 *
 * Where there is history, the plan is exactly what the client did last time for that exercise,
 * set index for set index. That is both the prescription a logging screen actually wants and
 * the only way "last session's weight and reps for that exact exercise and set index" can be
 * true by construction rather than by lookup.
 */
async function buildPlan(storage, day, sessions) {
  const sessionStartById = new Map(sessions.map((s) => [s.id, s.started_at]));
  const plan = [];

  for (const item of [...day.items].sort((a, b) => a.order_index - b.order_index)) {
    const rows = await storage.query('set_logs', { exercise_id: item.exercise_id });
    const mine = rows.filter((row) => sessionStartById.has(row.session_id));
    const previous = lastPerformance(mine, sessionStartById);

    state.best.set(item.exercise_id, bestEstimated1rm(mine, sessionStartById));

    if (previous && previous.bySetIndex.size) {
      for (const [setIndex, row] of [...previous.bySetIndex.entries()].sort((a, b) => a[0] - b[0])) {
        plan.push({
          item,
          setIndex,
          isWarmup: row.is_warmup,
          weightKg: row.weight_kg,
          reps: row.reps,
          lastWeightKg: row.weight_kg,
          lastReps: row.reps,
          lastOn: previous.startedAt,
        });
      }
      continue;
    }

    // No history for this lift. Start at the empty bar and the bottom of the rep range, which
    // is an invitation to log rather than an apology for having nothing. Snapped to the lift's
    // own increment so the opening number is one the equipment can hold.
    //
    // Known weak spot: 20kg is right for a barbell and a guess for everything else. The honest
    // fix is a starting load per exercise, which is a schema column and not this pass.
    const increment = state.increments.get(item.exercise_id) || 2.5;
    const opening = Math.max(increment, Math.round(EMPTY_BAR_KG / increment) * increment);
    for (let setIndex = 0; setIndex < item.target_sets; setIndex += 1) {
      plan.push({
        item,
        setIndex,
        isWarmup: false,
        weightKg: opening,
        reps: item.target_reps_low,
        lastWeightKg: null,
        lastReps: null,
        lastOn: null,
      });
    }
  }

  return plan;
}

// ------------------------------------------------------------------ rendering

function currentEntry() {
  return state.plan[state.cursor] ?? null;
}

function setsForExercise(exerciseId) {
  return state.plan.filter((entry) => entry.item.exercise_id === exerciseId);
}

function render() {
  const entry = currentEntry();

  if (!entry) {
    renderDone();
    return;
  }

  ui.done.hidden = true;
  ui.stepperWeight.hidden = false;
  ui.stepperReps.hidden = false;
  ui.log.hidden = false;
  ui.skip.disabled = false;
  ui.end.disabled = false;
  ui.typeToggle.disabled = false;

  const exercise = entry.item.exercise;
  const siblings = setsForExercise(exercise.id);
  const position = siblings.indexOf(entry) + 1;

  ui.exerciseName.textContent = exercise.name;
  ui.setPosition.textContent = entry.isWarmup
    ? `Warmup set, ${position} of ${siblings.length}`
    : `Set ${position} of ${siblings.length}`;

  const high = entry.item.target_reps_high;
  const repRange = high && high !== entry.item.target_reps_low
    ? `${entry.item.target_reps_low} to ${high} reps`
    : `${entry.item.target_reps_low} reps`;
  ui.target.textContent = entry.isWarmup
    ? 'Warmup. Move well, save it for the working sets.'
    : `Target ${repRange}${entry.item.target_rpe ? `, RPE ${entry.item.target_rpe}` : ''}`;

  ui.lastTime.textContent =
    entry.lastWeightKg === null
      ? 'First time on this lift.'
      : `Last time ${formatWeight(entry.lastWeightKg)} ${unit()} for ${entry.lastReps}, ${shortDate(entry.lastOn)}`;

  renderValues();
  renderUndo();
}

function renderValues() {
  ui.weightValue.textContent = formatWeight(state.weightKg);
  ui.weightUnit.textContent = unit();
  ui.repsValue.textContent = String(state.reps);
  ui.weightInput.value = formatWeight(state.weightKg);
  ui.repsInput.value = String(state.reps);

  const entry = currentEntry();
  const unchanged =
    entry && entry.lastWeightKg !== null && entry.lastWeightKg === state.weightKg && entry.lastReps === state.reps;

  ui.logLabel.textContent = 'Log set';
  ui.logSub.textContent = `${formatWeight(state.weightKg)} ${unit()} for ${state.reps}${
    unchanged ? ', same as last time' : ''
  }`;
}

function renderUndo() {
  ui.undo.disabled = state.logged.length === 0;
}

function renderDone() {
  ui.done.hidden = false;
  ui.stepperWeight.hidden = true;
  ui.stepperReps.hidden = true;
  ui.log.hidden = true;
  ui.skip.disabled = true;
  ui.end.disabled = true;
  ui.typeToggle.disabled = true;

  ui.exerciseName.textContent = state.day.name;
  ui.setPosition.textContent = '';
  ui.target.textContent = '';
  ui.lastTime.textContent = '';

  const sets = state.logged.filter((row) => !row.isWarmup).length;
  const volume = state.logged
    .filter((row) => !row.isWarmup)
    .reduce((total, row) => total + row.weightKg * row.reps, 0);

  ui.doneTitle.textContent = sets ? 'Session logged.' : 'Nothing logged yet.';
  ui.doneStat.textContent = sets
    ? `${sets} working ${sets === 1 ? 'set' : 'sets'}, ${Math.round(volume).toLocaleString()} kg moved.`
    : 'Open a set and log it when you are ready.';

  // Undo stays live for the whole session, including after the last set, which is why the
  // secondary row is never hidden.
  renderUndo();
}

function shortDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------ rest timer

function startRest(seconds) {
  state.restTotal = seconds;
  state.restEndsAt = Date.now() + seconds * 1000;
  if (state.restHandle) clearInterval(state.restHandle);
  state.restHandle = setInterval(tickRest, 250);
  tickRest();
}

function stopRest() {
  if (state.restHandle) clearInterval(state.restHandle);
  state.restHandle = null;
  state.restEndsAt = 0;
  state.restTotal = 0;
  ui.rest.dataset.state = 'idle';
  ui.restLabel.textContent = 'Rest';
  ui.restTime.textContent = '0:00';
  ui.restFill.style.width = '0%';
}

// Reads the wall clock rather than counting ticks, so a backgrounded tab comes back correct.
function tickRest() {
  const remaining = Math.max(0, state.restEndsAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  ui.restTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  ui.restFill.style.width = state.restTotal ? `${(remaining / (state.restTotal * 1000)) * 100}%` : '0%';

  if (remaining <= 0) {
    clearInterval(state.restHandle);
    state.restHandle = null;
    ui.rest.dataset.state = 'ready';
    ui.restLabel.textContent = 'Ready';
    ui.restTime.textContent = 'Go';
  } else {
    ui.rest.dataset.state = 'running';
    ui.restLabel.textContent = 'Rest';
  }
}

// ------------------------------------------------------------------ actions

function ensureSessionRecord() {
  if (state.sessionRecord) return state.sessionRecord;
  state.sessionRecord = makeRecord('sessions', {
    client_id: state.client.id,
    assignment_id: state.assignment ? state.assignment.id : null,
    day_index: state.day.day_index,
    started_at: new Date().toISOString(),
    completed_at: null,
    client_note: null,
  });
  return state.sessionRecord;
}

function logSet() {
  const entry = currentEntry();
  if (!entry) return;

  const session = ensureSessionRecord();
  const record = makeRecord('set_logs', {
    session_id: session.id,
    exercise_id: entry.item.exercise_id,
    set_index: entry.setIndex,
    weight_kg: state.weightKg,
    reps: state.reps,
    rpe: null,
    is_warmup: entry.isWarmup,
    logged_at: new Date().toISOString(),
    supersedes_id: null,
    is_void: false,
    device_id: getDeviceId(),
  });

  // Personal record fires before the write, because the screen never waits on the adapter.
  const previousBest = state.best.get(entry.item.exercise_id);

  state.logged.push({
    id: record.id,
    planIndex: state.cursor,
    exerciseId: entry.item.exercise_id,
    setIndex: entry.setIndex,
    weightKg: state.weightKg,
    reps: state.reps,
    isWarmup: entry.isWarmup,
    // Undo has to put this back. A record that was taken back must stop being a record, or
    // the next real one never fires.
    previousBest,
  });

  const achieved = epley1rm(state.weightKg, state.reps);
  const isPr = !entry.isWarmup && previousBest !== null && achieved > previousBest;
  if (isPr) state.best.set(entry.item.exercise_id, achieved);

  state.cursor += 1;
  const next = currentEntry();
  if (next) {
    state.weightKg = next.weightKg;
    state.reps = next.reps;
  }

  startRest(entry.item.rest_seconds);
  exitTypingMode();
  clearNotice();
  render();
  showPr(isPr, entry.item.exercise.name);

  const shouldComplete = state.cursor >= state.plan.length;
  write(async () => {
    if (!state.sessionWritten) {
      await state.storage.put('sessions', session);
      state.sessionWritten = true;
    }
    await state.storage.put('set_logs', record);
    if (shouldComplete) {
      state.sessionClosed = true;
      await state.storage.put('sessions', {
        ...session,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  });
}

/**
 * set_logs is append only, so undo cannot remove the row. It writes a retraction: a new row
 * that supersedes the one being taken back and marks itself void. The set stays visible in the
 * audit trail and stops counting everywhere else. The values come back into the steppers, so
 * the common case of logging the wrong number is undo, adjust, log again.
 */
function undoLast() {
  const last = state.logged.pop();
  if (!last) return;

  const retraction = makeRecord('set_logs', {
    session_id: state.sessionRecord.id,
    exercise_id: last.exerciseId,
    set_index: last.setIndex,
    weight_kg: last.weightKg,
    reps: last.reps,
    rpe: null,
    is_warmup: last.isWarmup,
    logged_at: new Date().toISOString(),
    supersedes_id: last.id,
    is_void: true,
    device_id: getDeviceId(),
  });

  state.best.set(last.exerciseId, last.previousBest);
  state.cursor = last.planIndex;
  state.weightKg = last.weightKg;
  state.reps = last.reps;
  stopRest();
  ui.prChip.hidden = true;
  exitTypingMode();
  clearNotice();
  render();

  const session = state.sessionRecord;
  write(async () => {
    await state.storage.put('set_logs', retraction);
    // Taking back the final set reopens the session, otherwise it stays closed with a set
    // in it that no longer counts.
    if (session.completed_at !== null || state.sessionClosed) {
      state.sessionClosed = false;
      await state.storage.put('sessions', {
        ...session,
        completed_at: null,
        updated_at: new Date().toISOString(),
      });
    }
  });
}

/**
 * Moves past every remaining set of the current lift. Nothing is written, because nothing was
 * performed and absence is the truthful record. No warning colour, no badge, no count of what
 * was missed: the acknowledgement names the lift the client is now on.
 */
function skipExercise() {
  const entry = currentEntry();
  if (!entry) return;

  const exerciseId = entry.item.exercise_id;
  while (state.cursor < state.plan.length && state.plan[state.cursor].item.exercise_id === exerciseId) {
    state.cursor += 1;
  }

  const next = currentEntry();
  if (next) {
    state.weightKg = next.weightKg;
    state.reps = next.reps;
  }

  stopRest();
  exitTypingMode();
  ui.prChip.hidden = true;
  render();
  showNotice(next ? `On to ${next.item.exercise.name}.` : 'That was the last lift.');
}

/** Closes the session with whatever is in it. A session with two lifts in it is a session. */
function endSession() {
  state.cursor = state.plan.length;
  stopRest();
  exitTypingMode();
  clearNotice();
  render();

  const session = state.sessionRecord;
  if (!session) return;
  write(async () => {
    if (!state.sessionWritten) return;
    state.sessionClosed = true;
    await state.storage.put('sessions', {
      ...session,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });
}

function showPr(isPr, exerciseName) {
  ui.prChip.hidden = !isPr;
  if (isPr) ui.prChip.textContent = `Personal record on ${exerciseName}`;
}

function adjustWeight(direction) {
  const shown = toDisplay(state.weightKg);
  const step = stepSize();
  const next = Math.max(0, Math.round((shown + direction * step) / step) * step);
  state.weightKg = fromDisplay(next);
  renderValues();
}

function adjustReps(direction) {
  state.reps = Math.max(1, state.reps + direction);
  renderValues();
}

function enterTypingMode() {
  state.typing = true;
  ui.weightValue.hidden = true;
  ui.weightUnit.hidden = true;
  ui.repsValue.hidden = true;
  ui.weightInput.hidden = false;
  ui.repsInput.hidden = false;
  ui.typeToggle.textContent = 'Steppers';
  ui.weightInput.focus();
  ui.weightInput.select();
}

function exitTypingMode() {
  state.typing = false;
  ui.weightValue.hidden = false;
  ui.weightUnit.hidden = false;
  ui.repsValue.hidden = false;
  ui.weightInput.hidden = true;
  ui.repsInput.hidden = true;
  ui.typeToggle.textContent = 'Type';
}

function commitTyped() {
  const weight = Number.parseFloat(ui.weightInput.value);
  const reps = Number.parseInt(ui.repsInput.value, 10);
  if (Number.isFinite(weight) && weight >= 0) state.weightKg = fromDisplay(weight);
  if (Number.isInteger(reps) && reps >= 1) state.reps = reps;
  renderValues();
}

// ------------------------------------------------------------------ wiring

/**
 * Hold to repeat. Timing lives in js/hold.js so the curve can be tested. Keyboard activation
 * arrives as a click with no pointerdown in front of it, which is how Enter and Space stay
 * supported without double stepping a real tap.
 */
function bindHold(button, apply) {
  let timer = null;
  let interval = HOLD_START_MS;
  let lastPointerStep = 0;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    interval = HOLD_START_MS;
  };

  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || event.button !== 0) return;
    lastPointerStep = Date.now();
    apply();
    const repeat = () => {
      apply();
      interval = nextHoldInterval(interval);
      timer = setTimeout(repeat, interval);
    };
    timer = setTimeout(repeat, HOLD_DELAY_MS);
  });

  // A thumb sliding off the button ends the hold, same as lifting it.
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(type, stop);
  }
  window.addEventListener('blur', stop);

  button.addEventListener('click', () => {
    if (Date.now() - lastPointerStep < 700) return;
    apply();
  });
}

function wire() {
  bindHold(ui.weightUp, () => adjustWeight(1));
  bindHold(ui.weightDown, () => adjustWeight(-1));
  bindHold(ui.repsUp, () => adjustReps(1));
  bindHold(ui.repsDown, () => adjustReps(-1));
  ui.log.addEventListener('click', logSet);
  ui.undo.addEventListener('click', undoLast);
  ui.skip.addEventListener('click', skipExercise);
  ui.end.addEventListener('click', endSession);

  ui.typeToggle.addEventListener('click', () => {
    if (state.typing) {
      commitTyped();
      exitTypingMode();
    } else {
      enterTypingMode();
    }
  });

  for (const input of [ui.weightInput, ui.repsInput]) {
    input.addEventListener('change', commitTyped);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commitTyped();
        exitTypingMode();
      }
    });
  }
}

async function main() {
  let storage;
  try {
    storage = await openStorage();
  } catch (error) {
    ui.exerciseName.textContent = 'Cannot open storage';
    showNotice(`${error.message} Serve this folder over http, not file://`);
    return;
  }
  state.storage = storage;

  if (!(await isSeeded(storage))) await seed(storage);

  const clientId = await getDefaultClientId(storage);
  const { client, assignment, sessions } = await loadClientData(storage, clientId);
  state.client = client;
  state.assignment = assignment;

  // Read live rather than from the frozen snapshot: the increment describes the equipment in
  // the room, not the program, so a rack that changes should reach an old assignment too.
  const exercises = await storage.query('exercises', {});
  state.increments = new Map(exercises.map((row) => [row.id, row.increment_kg]));

  const snapshot = assignment.snapshot;
  state.day = pickDay(snapshot, sessions);
  state.plan = await buildPlan(storage, state.day, sessions);

  const first = state.plan[0];
  if (first) {
    state.weightKg = first.weightKg;
    state.reps = first.reps;
  }

  ui.clientName.textContent = client.display_name;
  ui.dayName.textContent = `· ${state.day.name}`;
  ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';

  wire();
  stopRest();
  render();
}

main();
