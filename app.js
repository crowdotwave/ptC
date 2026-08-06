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
import { mountShell } from './js/nav.js';
import { activeSetLogs, lastPerformance, bestEstimated1rm, epley1rm } from './js/history.js';
import { HOLD_DELAY_MS, HOLD_START_MS, nextHoldInterval } from './js/hold.js';
import { openingWeight, openingCopy } from './js/prefill.js';
import { targetLine } from './js/program.js';
import { pickDay, sortedDays, sortedItems, currentAssignment } from './js/snapshot.js';
import { NO_PROGRAM_YET } from './js/program-view.js';
import {
  unit,
  toDisplay,
  fromDisplay,
  formatWeight,
  stepSize as snapStep,
  loadUnit,
  mountUnitSwitch,
  onUnitChange,
} from './js/units.js';

const el = (id) => document.getElementById(id);
const ui = {
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
  equipment: new Map(),
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
//
// The conversion itself lives in js/units.js, because the progress and trainer screens print
// weights too and used to hardcode kilograms while this screen quietly respected the setting.
// What stays here is the one part that is about this screen: which increment applies to the lift
// currently on the steppers.

/** The smallest load change this lift can make, in whatever unit is being read. */
function stepSize(entry = currentEntry()) {
  return snapStep(entry && state.increments.get(entry.item.exercise_id));
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
  // Shared with the Programs tab, so the two screens cannot disagree about which program this
  // person is on.
  const assignment = await currentAssignment(storage, clientId);
  const sessions = await storage.query('sessions', { client_id: clientId }, { orderBy: 'started_at' });
  return { client, assignment, sessions };
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

  for (const item of sortedItems(day)) {
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
    // Optional chaining on the snapshot, deliberately. A snapshot is frozen JSON that can be
    // written by the seed, by the builder, by an importer, or by hand, and one missing nested
    // field must not take the whole logging screen down to a blank page mid gym. The live
    // exercises table is the fallback, which is also where increment_kg is read from anyway.
    const opening = openingWeight({
      startingWeightKg: item.starting_weight_kg ?? null,
      equipment: item.exercise?.equipment ?? state.equipment.get(item.exercise_id) ?? null,
      incrementKg: state.increments.get(item.exercise_id),
    });

    // A hold has no rep target at all, and a carry may not have one either, so the second
    // stepper needs an opening value that is not null. Ten seconds and one rep are both
    // obviously too little on purpose, the same bet the opening weight makes: erring low costs
    // a few taps, erring high costs a failed set.
    const openingCount =
      item.target_reps_low ?? (item.log_mode === 'time_hold' ? 10 : 1);

    // A hold prescribes sets but no load, and target_sets can be null on a row a trainer left
    // blank, so the plan needs at least one set to step through or the lift silently vanishes.
    const setCount = Number.isInteger(item.target_sets) && item.target_sets > 0 ? item.target_sets : 1;

    for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
      plan.push({
        item,
        setIndex,
        isWarmup: false,
        isExtra: false,
        logMode: item.log_mode ?? 'weight_reps',
        // A lift with no external load opens at zero, which is the truth rather than a fallback.
        weightKg:
          item.log_mode === 'bodyweight_reps' || item.log_mode === 'time_hold' ? 0 : opening.kg,
        reps: openingCount,
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

  // Each mode shows only the numbers that exist for it, rather than pretending everything is
  // sets and reps. A carry has a load and no reps. An AMRAP has a load and rounds. A pushup has
  // reps and genuinely no load, and a hold has neither: it has seconds.
  //
  // The second stepper is the one that changes meaning, and the unit label under it is what
  // says so, because a bare number mid set is not self explanatory.
  ui.stepperReps.hidden = mode === 'weight_only';
  ui.stepperWeight.hidden = mode === 'bodyweight_reps' || mode === 'time_hold';
  ui.repsUnit.textContent =
    mode === 'rounds' ? 'rounds' : mode === 'time_hold' ? 'sec' : 'reps';

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

  // What is about to be written, in the words of the thing being done. A pushup reading
  // "0 kg for 9" is not wrong so much as noise: there is no weight, so naming one asks the
  // reader to check a number that will always be zero.
  const load = `${formatWeight(state.weightKg)} ${unit()}`;
  ui.logSub.textContent =
    {
      weight_only: `${load}${suffix}`,
      rounds: `${load}, ${state.reps} rounds${suffix}`,
      bodyweight_reps: `${state.reps} rep${state.reps === 1 ? '' : 's'}${suffix}`,
      time_hold: `${state.reps} second${state.reps === 1 ? '' : 's'}${suffix}`,
    }[mode] ?? `${load} for ${state.reps}${suffix}`;
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

  // Only a session with something in it is a success, and only a success gets the green. An
  // empty card is an invitation to start, so it keeps the neutral edge every other card has.
  ui.done.dataset.tone = sets ? 'done' : 'empty';
  ui.doneTitle.textContent = sets ? 'Session logged.' : 'Nothing logged yet.';
  ui.doneStat.textContent = sets
    ? `${sets} working ${sets === 1 ? 'set' : 'sets'}${extra ? `, ${extra} added` : ''}, ` +
      `${Math.round(toDisplay(volume)).toLocaleString()} ${unit()} moved.`
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
    // Exactly one of these three carries the second number, and the other two are null. Null
    // rather than zero, because zero is a measurement and null is the absence of one: a hold
    // has no rep count, and writing 0 there would make it a set of no reps.
    reps:
      entry.logMode === 'weight_reps' || entry.logMode === 'bodyweight_reps' ? state.reps : null,
    rounds: entry.logMode === 'rounds' ? state.reps : null,
    hold_seconds: entry.logMode === 'time_hold' ? state.reps : null,
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
    // A retraction mirrors the row it takes back. Neither counts once is_void is set, so these
    // values change no number anywhere, but the audit trail is the reason this table is append
    // only and a retraction that forgot what it was retracting would be a worse record than none.
    reps: last.logMode === 'weight_reps' || last.logMode === 'bodyweight_reps' ? last.reps : null,
    rounds: last.logMode === 'rounds' ? last.reps : null,
    hold_seconds: last.logMode === 'time_hold' ? last.reps : null,
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
 * Reps and rounds move in whole numbers. Seconds move in fives.
 *
 * Half reps were built and then removed after real use. The case for them was that a half is
 * genuine information, common in a hand kept log, and unreachable by thumb unless the step is a
 * half. The case that won is that it doubles the taps on the control used most under fatigue,
 * every session, for everybody, to record something that belongs in a note. Kept here because
 * the reasoning is easy to rediscover and the answer is not.
 *
 * Seconds move in fives because a hold is timed by feel to about that resolution, and stepping
 * to 45 one second at a time is nine taps for a precision nobody actually measured.
 */
function adjustReps(direction) {
  const step = currentEntry()?.logMode === 'time_hold' ? 5 : 1;
  state.reps = Math.max(step, state.reps + direction * step);
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
  if (Number.isInteger(reps) && reps > 0) state.reps = reps;
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
  ui.dayPicker.innerHTML = sortedDays(snapshot)
    .map((day) => {
      const on = day.day_index === state.day.day_index;
      // The split only. The day type above it said STRENGTH on almost every chip, which is a
      // word that distinguishes nothing when it is on all of them, and it doubled the height of
      // the one control on this screen that has to be scanned rather than read.
      const label = day.split || day.name;
      return (
        `<button type="button" class="button-secondary daypicker__item${on ? ' is-on' : ''}" ` +
        `data-day="${day.day_index}"${on ? ' aria-current="true"' : ''}>${escapeText(label)}</button>`
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
  const picked = sortedDays(state.assignment.snapshot).find((d) => d.day_index === Number(dayIndex));
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
  mountShell(booted, 'log');

  // Before anything prints a weight. The viewer on this screen is always the client whose sets
  // these are, so their own row is both what is read and what a tap would write.
  await loadUnit(storage, actor);

  if (mode === 'unbound') {
    ui.exerciseName.textContent = 'Nothing assigned';
    ui.controls.hidden = true;
    // The only screen this person can reach, so it has to carry the way off it.
    el('account').hidden = false;
    showNotice('You are signed in, but no trainer has added this email as a client yet.');
    return;
  }
  if (booted.error) showNotice(booted.error);

  if (!actor || !actor.clientId) {
    ui.exerciseName.textContent = 'No client selected';
    ui.controls.hidden = true;
    el('account').hidden = false;
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
    ui.exerciseName.textContent = 'No program yet';
    // The steppers and Log set have to go with it. Leaving a live primary action on a screen
    // with no plan behind it invites a tap that writes a set against nothing.
    ui.controls.hidden = true;
    showNotice(NO_PROGRAM_YET);
    return;
  }

  // Read live rather than from the frozen snapshot: the increment describes the equipment in
  // the room, not the program, so a rack that changes should reach an old assignment too.
  const exercises = await storage.query('exercises', {});
  state.increments = new Map(exercises.map((row) => [row.id, row.increment_kg]));
  state.equipment = new Map(exercises.map((row) => [row.id, row.equipment]));

  const snapshot = assignment.snapshot;
  state.day = pickDay(snapshot, sessions);

  // A program with no days in it. Reachable today, because deleting the last day of a template
  // in the builder is allowed. From this side of the app it is the same situation as no program
  // at all, so it gets the same screen rather than a blank one, and it names the same person.
  if (!state.day) {
    ui.exerciseName.textContent = 'No program yet';
    ui.controls.hidden = true;
    showNotice(NO_PROGRAM_YET);
    return;
  }

  state.plan = await buildPlan(storage, state.day, sessions);

  const first = state.plan[0];
  if (first) {
    state.weightKg = first.weightKg;
    state.reps = first.reps;
  }

  renderDayPicker(snapshot, sessions);
  ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';

  // Flipping mid session is safe: state.weightKg is kilograms and stays put, so the number on the
  // stepper changes and the load on the bar does not. The step changes with it, which is the
  // point, because 2.5 kg is not a thing a pound gym can add.
  mountUnitSwitch(el('unit-switch'));
  onUnitChange(() => {
    ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';
    render();
  });

  wire();
  stopRest();
  render();
}

main();
