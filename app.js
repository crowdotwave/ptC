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

import { makeRecord, getDeviceId } from './js/storage.js';
import { boot, gate } from './js/boot.js';
import { wireNav } from './js/nav.js';
import { activeSetLogs, lastPerformance, bestEstimated1rm, epley1rm } from './js/history.js';
import { HOLD_DELAY_MS, HOLD_START_MS, nextHoldInterval } from './js/hold.js';
import { openingWeight, openingCopy } from './js/prefill.js';
import { targetLine } from './js/program.js';

const KG_PER_LB = 0.45359237;

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
  dayPicker: el('day-picker'),
  repsUnit: el('reps-unit'),
  addSet: el('add-set'),
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
  // Placeholder only. Every real value comes from history or from js/prefill.js before the
  // first render, so nothing this file invents ever reaches a stepper.
  weightKg: 0,
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
    // Cardio intervals and anything else the trainer marked as not logged are shown on the
    // day, never stepped through. Recording a number nobody measured is worse than recording
    // nothing.
    if (item.is_logged === false) continue;

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
          isExtra: false,
          logMode: item.log_mode ?? 'weight_reps',
          weightKg: row.weight_kg,
          reps: row.reps,
          lastWeightKg: row.weight_kg,
          lastReps: row.reps,
          lastOn: previous.startedAt,
        });
      }
      continue;
    }

    // No history for this lift, so this runs exactly once per client per exercise. The
    // trainer's starting_weight_kg is the real answer. When it is blank, prefill.js falls back
    // to a fact about the equipment rather than a guess about the person, deliberately light.
    const opening = openingWeight({
      startingWeightKg: item.starting_weight_kg ?? null,
      equipment: item.exercise.equipment,
      incrementKg: state.increments.get(item.exercise_id),
    });
    for (let setIndex = 0; setIndex < item.target_sets; setIndex += 1) {
      plan.push({
        item,
        setIndex,
        isWarmup: false,
        isExtra: false,
        logMode: item.log_mode ?? 'weight_reps',
        weightKg: opening.kg,
        reps: item.target_reps_low,
        lastWeightKg: null,
        lastReps: null,
        lastOn: null,
        openingSource: opening.source,
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
  ui.addSet.disabled = false;

  const exercise = entry.item.exercise;
  const siblings = setsForExercise(exercise.id);
  const position = siblings.indexOf(entry) + 1;

  ui.exerciseName.textContent = exercise.name;
  ui.setPosition.textContent = entry.isWarmup
    ? `Warmup set, ${position} of ${siblings.length}`
    : entry.isExtra
      ? `Extra set, ${position} of ${siblings.length}`
      : `Set ${position} of ${siblings.length}`;

  // Built from the trainer's own cells rather than reassembled from numbers, so a target of
  // '50 FT' or '1-2 RIR' reaches the client as written.
  const written = targetLine(entry.item);
  ui.target.textContent = entry.isWarmup
    ? 'Warmup. Move well, save it for the working sets.'
    : written || 'No target set.';

  ui.lastTime.textContent =
    entry.lastWeightKg === null
      ? openingCopy(entry.openingSource)
      : `Last time ${formatWeight(entry.lastWeightKg)} ${unit()} for ${entry.lastReps}, ${shortDate(entry.lastOn)}`;

  renderValues();
  renderUndo();
}

function renderValues() {
  const mode = currentEntry()?.logMode ?? 'weight_reps';

  // A carry has a load and no reps. An AMRAP has a load and rounds. The stepper changes what
  // it counts rather than pretending everything is sets and reps.
  ui.stepperReps.hidden = mode === 'weight_only';
  ui.repsUnit.textContent = mode === 'rounds' ? 'rounds' : 'reps';

  ui.weightValue.textContent = formatWeight(state.weightKg);
  ui.weightUnit.textContent = unit();
  ui.repsValue.textContent = String(state.reps);
  ui.weightInput.value = formatWeight(state.weightKg);
  ui.repsInput.value = String(state.reps);

  const entry = currentEntry();
  const unchanged =
    entry && entry.lastWeightKg !== null && entry.lastWeightKg === state.weightKg && entry.lastReps === state.reps;

  ui.logLabel.textContent = 'Log set';
  const suffix = unchanged ? ', same as last time' : '';
  ui.logSub.textContent =
    mode === 'weight_only'
      ? `${formatWeight(state.weightKg)} ${unit()}${suffix}`
      : mode === 'rounds'
        ? `${formatWeight(state.weightKg)} ${unit()}, ${state.reps} rounds${suffix}`
        : `${formatWeight(state.weightKg)} ${unit()} for ${state.reps}${suffix}`;
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
  ui.addSet.disabled = true;

  ui.exerciseName.textContent = state.day.name;
  ui.setPosition.textContent = '';
  ui.target.textContent = '';
  ui.lastTime.textContent = '';

  const working = state.logged.filter((row) => !row.isWarmup);
  const sets = working.length;
  const extra = working.filter((row) => row.isExtra).length;
  const volume = working
    .filter((row) => row.logMode === 'weight_reps')
    .reduce((total, row) => total + row.weightKg * row.reps, 0);

  ui.doneTitle.textContent = sets ? 'Session logged.' : 'Nothing logged yet.';
  ui.doneStat.textContent = sets
    ? `${sets} working ${sets === 1 ? 'set' : 'sets'}${extra ? `, ${extra} added` : ''}, ` +
      `${Math.round(volume).toLocaleString()} kg moved.`
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
    // A carry records a load and no reps. An AMRAP records rounds instead. Nothing invents a
    // rep count, and everything downstream skips a row that has none.
    reps: entry.logMode === 'weight_reps' ? state.reps : entry.logMode === 'rounds' ? null : null,
    rounds: entry.logMode === 'rounds' ? state.reps : null,
    rpe: null,
    is_warmup: entry.isWarmup,
    logged_at: new Date().toISOString(),
    supersedes_id: null,
    is_void: false,
    // Recorded at log time, not inferred later from the snapshot. Whether a set was asked for
    // is a fact about the moment it happened.
    is_extra: entry.isExtra === true,
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
    logMode: entry.logMode,
    isWarmup: entry.isWarmup,
    isExtra: entry.isExtra === true,
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
    reps: last.logMode === 'weight_reps' ? last.reps : null,
    rounds: last.logMode === 'rounds' ? last.reps : null,
    rpe: null,
    is_warmup: last.isWarmup,
    logged_at: new Date().toISOString(),
    supersedes_id: last.id,
    is_void: true,
    is_extra: last.isExtra === true,
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

/**
 * Appends one more set to the lift the client is on, prefilled from where the steppers already
 * sit, and marks it extra.
 *
 * The insert lands at or after the cursor, never before it, which is what keeps the planIndex
 * stored on every already logged set pointing at the same entry. Undo depends on that.
 */
function addSet() {
  const entry = currentEntry();
  if (!entry) return;

  const exerciseId = entry.item.exercise_id;
  let insertAt = state.cursor;
  while (insertAt < state.plan.length && state.plan[insertAt].item.exercise_id === exerciseId) {
    insertAt += 1;
  }

  const siblings = setsForExercise(exerciseId);
  const highestIndex = siblings.reduce((max, s) => Math.max(max, s.setIndex), -1);

  state.plan.splice(insertAt, 0, {
    item: entry.item,
    setIndex: highestIndex + 1,
    isWarmup: false,
    isExtra: true,
    weightKg: state.weightKg,
    reps: state.reps,
    lastWeightKg: null,
    lastReps: null,
    lastOn: null,
    openingSource: null,
  });

  render();
  showNotice(`Extra set added to ${entry.item.exercise.name}.`);
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

/**
 * Reps move in halves, rounds move in whole numbers.
 *
 * A half rep is the one that got most of the way up, and a real log kept by hand is full of
 * them: roughly a quarter of the sets in the first one this app was pointed at. There is no way
 * to reach that with a thumb unless the step is a half.
 *
 * The cost is honest and worth stating: any change now takes twice the taps it used to. That is
 * bounded by the prefill, which starts the stepper on last session's number, so the common case
 * is still zero taps and the next most common is one or two. Hold to repeat covers the rest.
 *
 * Half a round is not a thing anybody has written down, so a circuit still steps by one.
 */
function adjustReps(direction) {
  const step = currentEntry()?.logMode === 'rounds' ? 1 : 0.5;
  // Rounded because repeated addition of 0.5 in binary floating point drifts, and a readout
  // saying 10.499999999999998 mid set would be the end of anybody trusting the numbers.
  state.reps = Math.max(step, Math.round((state.reps + direction * step) * 10) / 10);
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
  const reps = Number.parseFloat(ui.repsInput.value);
  if (Number.isFinite(weight) && weight >= 0) state.weightKg = fromDisplay(weight);
  if (Number.isFinite(reps) && reps > 0) state.reps = Math.round(reps * 10) / 10;
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

/**
 * Every day in the program, with the suggested one preselected.
 *
 * A five day rotation does not get done in order. Somebody skips legs on a Monday and does it
 * Thursday, and guessing from the last session with no way to override it makes the app wrong
 * in a way the client cannot fix.
 */
function renderDayPicker(snapshot, sessions) {
  const days = [...snapshot.days].sort((a, b) => a.day_index - b.day_index);
  ui.dayPicker.innerHTML = days
    .map((day) => {
      const on = day.day_index === state.day.day_index;
      const label = day.split || day.name;
      const type = day.day_type ? `<span class="daypicker__type">${escapeText(day.day_type)}</span>` : '';
      return (
        `<button type="button" class="button-secondary daypicker__item${on ? ' is-on' : ''}" ` +
        `data-day="${day.day_index}"${on ? ' aria-current="true"' : ''}>${type}${escapeText(label)}</button>`
      );
    })
    .join('');
}

const escapeText = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Switching days mid session would orphan what is already logged, so it is only offered
 *  before the first set. */
async function chooseDay(dayIndex) {
  if (state.logged.length) {
    showNotice('You have already logged a set. Finish or end this session first.');
    return;
  }
  const days = [...state.assignment.snapshot.days].sort((a, b) => a.day_index - b.day_index);
  const picked = days.find((d) => d.day_index === Number(dayIndex));
  if (!picked || picked.day_index === state.day.day_index) return;

  state.day = picked;
  const sessions = await state.storage.query(
    'sessions',
    { client_id: state.client.id },
    { orderBy: 'started_at' },
  );
  state.plan = await buildPlan(state.storage, picked, sessions);
  state.cursor = 0;
  const first = state.plan[0];
  if (first) {
    state.weightKg = first.weightKg;
    state.reps = first.reps;
  }
  ui.dayName.textContent = `· ${picked.name}`;
  renderDayPicker(state.assignment.snapshot, sessions);
  clearNotice();
  stopRest();
  render();
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
  ui.addSet.addEventListener('click', addSet);
  ui.dayPicker.addEventListener('click', (event) => {
    const button = event.target.closest('[data-day]');
    if (button) chooseDay(button.dataset.day);
  });

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
  let booted;
  try {
    booted = await boot({ role: 'client' });
  } catch (error) {
    ui.exerciseName.textContent = 'Cannot open storage';
    showNotice(`${error.message} Serve this folder over http, not file://`);
    return;
  }
  if (!gate(booted)) return;

  const { storage, actor, mode } = booted;
  state.storage = storage;
  wireNav(booted);

  if (mode === 'unbound') {
    ui.clientName.textContent = 'Not set up yet';
    ui.exerciseName.textContent = 'Nothing assigned';
    ui.controls.hidden = true;
    showNotice('You are signed in, but no trainer has added this email as a client yet.');
    return;
  }
  if (booted.error) showNotice(booted.error);

  if (!actor || !actor.clientId) {
    ui.clientName.textContent = 'No client';
    ui.exerciseName.textContent = 'No client selected';
    ui.controls.hidden = true;
    showNotice('Switch to a client with the dev role control.');
    return;
  }
  const { client, assignment, sessions } = await loadClientData(storage, actor.clientId);
  state.client = client;
  state.assignment = assignment;

  // The state every client is in for the minutes or days between being added and being given a
  // program. It used to throw on assignment.snapshot and leave the word "Loading" on screen
  // forever, which is the first thing a new person would ever have seen of this app.
  //
  // Not phrased as an apology, and not offering an action, because there is genuinely nothing
  // for them to do here: only their trainer can assign a program. Naming who it is waiting on
  // is the honest version.
  if (!assignment) {
    ui.clientName.textContent = client?.display_name ?? 'You';
    ui.exerciseName.textContent = 'No program yet';
    // The steppers and Log set have to go with it. Leaving a live primary action on a screen
    // with no plan behind it invites a tap that writes a set against nothing.
    ui.controls.hidden = true;
    showNotice('Your trainer has not assigned a program yet. It will be here when they do.');
    return;
  }

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
  renderDayPicker(snapshot, sessions);
  ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';

  wire();
  stopRest();
  render();
}

main();
