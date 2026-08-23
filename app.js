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
import { lastPerformance, bestEstimated1rm, epley1rm } from './js/history.js';
import { HOLD_DELAY_MS, HOLD_START_MS, nextHoldInterval } from './js/hold.js';
import { openingWeight, openingCopy } from './js/prefill.js';
import { planForItem, nextSteppers, incrementOf } from './js/plan.js';
import { targetLine } from './js/program.js';
import { pickDay, sortedDays, sortedItems, currentAssignment, dayTitle } from './js/snapshot.js';
import { openSession, replaySession, loadSessions } from './js/session.js';
import { FEELINGS, composeNote, parseNote } from './js/feel.js';
import { NO_PROGRAM_YET } from './js/program-view.js';
import { publishSync } from './js/sync-status.js';
import { isPending, overviewRows, renderOverview, positionLine } from './js/workout-view.js';
import {
  unit,
  toDisplay,
  fromDisplay,
  formatWeight,
  loadLabel,
  loadValue,
  stepSize as snapStep,
  loadUnit,
  mountUnitSetting,
  onUnitChange,
} from './js/units.js';

const el = (id) => document.getElementById(id);
const ui = {
  screen: document.querySelector('.screen'),
  dayJump: el('day-jump'),
  dayJumpLabel: el('day-jump-label'),
  dayJumpPos: el('day-jump-pos'),
  overview: el('overview'),
  overviewTitle: el('overview-title'),
  overviewPos: el('overview-pos'),
  overviewBody: el('overview-body'),
  returnBar: el('return-bar'),
  returnTo: el('return-to'),
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
  feel: el('feel'),
  feelAsk: el('feel-ask'),
  feelChips: el('feel-chips'),
  feelMore: el('feel-more'),
  feelNote: el('feel-note'),
  feelText: el('feel-text'),
  feelDone: el('feel-done'),
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
  // How the session felt, and anything the client wanted to say about it. Held apart from
  // sessions.client_note, which is the two of them composed into one line, so that a redraw does
  // not have to take the stored note back apart every time. Both are null and empty until asked.
  feel: null,
  feelText: '',
  // Whether what the client said has been submitted. How it felt and the note are held in
  // memory until Done, so the card has a submit moment and an answer to it. Logged sets are
  // never held this way: see the note on the Done button in index.html.
  feelSaved: false,
  // Whether the note field has been opened. A tap, never a default: this screen does not raise a
  // keyboard on its own anywhere else either.
  feelTyping: false,
  // The overview panel, open or not. A state of this screen, not a layer over it.
  overview: false,
  // What the notice band is saying, or null. Held here rather than written straight to the DOM
  // because the way back shares that band and one of them has to yield.
  notice: null,
  // A lift stepped away from that still owes sets, or null. Held as the entry rather than an
  // index for the same reason the undo stack is: adding a set moves indexes and moves nothing
  // else.
  returnTo: null,
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
  return snapStep(entry && incrementOf(entry.item, state.increments.get(entry.item.exercise_id)));
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

/**
 * How long a flush waits for the tap after it. Comfortably inside a rest period, so a set is on
 * the server before the next one is done, and long enough that undo, adjust, log again is one
 * push rather than three.
 */
const FLUSH_DELAY_MS = 2000;
let flushTimer = null;

/**
 * Get what has been logged off this phone, soon, without the screen waiting for it.
 *
 * The gap this closes: the outbox used to be flushed by boot.js and by nothing else, so a set
 * reached the server when a page next loaded and at no other moment. Somebody could log an entire
 * session, lock the phone and walk out, and their trainer would see nothing until they happened to
 * open the app again. It worked as well as it did only because the tab bar is real links, so
 * changing tabs is a page load.
 *
 * Behind the write queue, not beside it. The row this is called for is written by a task already
 * on that queue, and a flush that read the outbox first would push everything except the set that
 * prompted it, then report a clean queue.
 *
 * push() rather than sync(): a pull would rewrite the program, the day and the session while this
 * screen holds all three in memory. See js/storage.js.
 *
 * Failure is silent here, and that is deliberate. The queue keeps whatever did not land, boot.js
 * and the connectivity listeners will try again, and the one thing this screen owes somebody mid
 * set is that nothing interrupts them over a network that is coming back on its own. A write the
 * server actively refused is a different matter and still reaches the shell through publishSync,
 * which nav.js surfaces quietly and without moving anything.
 */
function flushSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeQueue = writeQueue
      .then(() => state.storage.push())
      .then(publishSync, () => {});
  }, FLUSH_DELAY_MS);
}

/**
 * Changes the session row, and keeps the copy this file is holding in step with it.
 *
 * The copy used to drift, and it was a trap with the pin already pulled. Closing a session wrote
 * `completed_at` into a spread of `state.sessionRecord` and left the original reading null, which
 * is why undo has to ask `state.sessionClosed` rather than believe the row in its hand. That was
 * survivable while closing was the only thing anybody wrote. The moment a second writer spread
 * that same stale record, saving a note would have quietly reopened a finished session, and the
 * session would have gone on offering itself up for resume for six hours.
 *
 * So there is one writer now and it updates both. Nothing awaits it, per the optimistic rule.
 */
function stampSession(patch) {
  const next = { ...state.sessionRecord, ...patch, updated_at: new Date().toISOString() };
  state.sessionRecord = next;
  write(() => state.storage.put('sessions', next));
  return next;
}

function showNotice(text, tone = 'neutral') {
  state.notice = { text, tone };
  paintNotice();
}

function clearNotice() {
  state.notice = null;
  paintNotice();
}

/**
 * The notice band, which the way back also sits in.
 *
 * Two rows there is one row too many. This screen fits a 640px tall phone with about five pixels
 * to spare, so a message stacked on top of the return control is what finally pushes it into
 * scrolling, and it must never scroll. They do not both need to be there: the header already names
 * the lift and the set, which is what a neutral message is confirming, while the return control is
 * the only thing on screen that knows a lift was left behind.
 *
 * An attention notice is a refused write and outranks both. That one is not confirmation of
 * something the client just did, it is the only place the app says a set is on this device alone.
 */
function paintNotice() {
  // The panel is a full answer to where the client is and what is left, so nothing sits above it.
  const crowded = state.overview || !ui.returnBar.hidden;

  // A neutral message that cannot be shown is dropped rather than queued. It is a momentary
  // acknowledgement of a tap that has already happened, so holding it would mean "Extra set added"
  // surfacing minutes later when a lift finishes and frees the band. A refused write is kept,
  // because that one is still true whenever it gets to be said.
  if (state.notice && crowded && state.notice.tone !== 'attention') state.notice = null;

  // What survives is either a neutral message with room for it or a refused write, and the second
  // waits for the panel to close rather than being dropped, because it is still true then.
  const notice = state.notice;
  const shown = Boolean(notice) && !state.overview;

  ui.notice.hidden = !shown;
  if (!shown) return;
  ui.notice.textContent = notice.text;
  ui.notice.dataset.tone = notice.tone;
}

// ------------------------------------------------------------------ loading

async function loadClientData(storage, clientId) {
  const client = await storage.get('clients', clientId);
  // Shared with the Programs tab, so the two screens cannot disagree about which program this
  // person is on.
  const assignment = await currentAssignment(storage, clientId);
  const sessions = await loadSessions(storage, clientId);
  return { client, assignment, sessions };
}

/**
 * The planned sets, in order, each already carrying the prefill it needs.
 *
 * The decisions live in js/plan.js so they can be tested without a DOM. What is left here is the
 * part that genuinely needs the adapter: reading this client's history for each lift, and reading
 * the live exercises table for equipment and increments.
 *
 * `exclude` is the session currently being resumed. Its rows must not reach the prefill, because
 * the prefill reads the most recent session and a session still in progress is the most recent
 * one, which would rebuild the plan as a copy of the sets already logged.
 */
async function buildPlan(storage, day, sessions, { exclude = null } = {}) {
  const sessionStartById = new Map(
    sessions.filter((session) => session.id !== exclude).map((s) => [s.id, s.started_at]),
  );
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

    // The trainer's starting_weight_kg is the real answer for a lift with no history. When it is
    // blank, prefill.js falls back to a fact about the equipment rather than a guess about the
    // person, deliberately light.
    //
    // Optional chaining on the snapshot, deliberately. A snapshot is frozen JSON that can be
    // written by the seed, by the builder, by an importer, or by hand, and one missing nested
    // field must not take the whole logging screen down to a blank page mid gym. The live
    // exercises table is the fallback, which is also where increment_kg is read from anyway.
    const opening = openingWeight({
      startingWeightKg: item.starting_weight_kg ?? null,
      equipment: item.exercise?.equipment ?? state.equipment.get(item.exercise_id) ?? null,
      incrementKg: incrementOf(item, state.increments.get(item.exercise_id)),
    });

    plan.push(...planForItem(item, previous, opening));
  }

  return plan;
}

// ------------------------------------------------------------------ rendering

function currentEntry() {
  return state.plan[state.cursor] ?? null;
}

/**
 * The planned sets of one lift: the run of entries around this one that share its item.
 *
 * By item identity rather than by exercise id, which is what a day that programs the same carry
 * at the top and the bottom needs. Filtering the whole plan by exercise id made those two into
 * one lift of eight sets, so the counter read "set 1 of 8" on the first of four.
 */
function runOf(entry) {
  const at = state.plan.indexOf(entry);
  if (at < 0) return [];
  let from = at;
  let to = at;
  while (from > 0 && state.plan[from - 1].item === entry.item) from -= 1;
  while (to < state.plan.length - 1 && state.plan[to + 1].item === entry.item) to += 1;
  return state.plan.slice(from, to + 1);
}

/**
 * The next set to open, walking from `index` and wrapping once.
 *
 * The wrap is what makes moving around safe. Logging the last set in the plan used to mean the
 * session was over, which was true only while the lifts could only be done in order: now the last
 * set on the list can be the first one somebody does, and closing the session on it would file a
 * workout that had barely started. Returns -1 when nothing is left anywhere, which is the only
 * thing that ends a session besides the client saying so.
 */
function nextPending(index) {
  for (let i = index; i < state.plan.length; i += 1) if (isPending(state.plan[i])) return i;
  for (let i = 0; i < index; i += 1) if (isPending(state.plan[i])) return i;
  return -1;
}

function render() {
  const entry = currentEntry();
  renderHeader();
  renderReturn();
  // After the return control, never before: which of the two gets the band depends on whether the
  // other one is in it.
  paintNotice();

  if (state.overview) {
    renderOverviewPanel();
    return;
  }

  if (!entry) {
    renderDone();
    return;
  }

  ui.done.hidden = true;
  ui.overview.hidden = true;
  ui.screen.classList.remove('is-overview');
  ui.controls.hidden = false;
  ui.rest.hidden = false;
  ui.stepperWeight.hidden = false;
  ui.stepperReps.hidden = false;
  ui.log.hidden = false;
  ui.skip.disabled = false;
  ui.end.disabled = false;
  ui.typeToggle.disabled = false;
  ui.addSet.disabled = false;

  const exercise = entry.item.exercise;
  const siblings = runOf(entry);
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

  // Three different things this line can truthfully say, and they are not interchangeable. A set
  // the client has a row for at this exact index gets the date. A set made up to the trainer's
  // count gets the number it was prefilled from and says where it came from, because there is no
  // row at this index and claiming one would be the screen inventing history. Only a lift with no
  // history at all gets the first time copy.
  //
  // Both of the first two name a load through loadLabel, so a set done with nothing on it reads
  // 'Last time bodyweight for 8' rather than 'Last time 0 lb for 8'. That is the same set either
  // way: the row carries zero and always did.
  ui.lastTime.textContent =
    entry.lastWeightKg !== null
      ? `Last time ${loadLabel(entry.lastWeightKg)} for ${entry.lastReps}, ${shortDate(entry.lastOn)}`
      : entry.carriedFrom
        ? `Carried from your last set, ${loadLabel(entry.carriedFrom.weightKg)} for ${entry.carriedFrom.reps}.`
        : openingCopy(entry.openingSource);

  ui.target.hidden = false;
  ui.lastTime.hidden = false;

  renderValues();
  renderUndo();
}

/** The chip top left: which day this is, and where in it the client is standing. */
function renderHeader() {
  if (!state.day) return;
  const position = positionLine(overviewRows(state.plan, state.cursor, state.day));
  ui.dayJump.hidden = false;
  ui.dayJumpLabel.textContent = dayTitle(state.day);
  ui.dayJumpPos.textContent = position;
  ui.dayJump.setAttribute('aria-expanded', String(state.overview));
  // The words say where you are and the label says what happens if you press it, because "Lower A,
  // lift 1 of 4" is a statement and this is a control. Open and closed is carried by aria-expanded
  // rather than by rewriting the name, so it does not change out from under anybody mid press.
  ui.dayJump.setAttribute('aria-label', `${dayTitle(state.day)}, ${position}. Show the whole workout.`);
}

/**
 * The whole day, as a list, in the space the controls were in.
 *
 * The header keeps the chip and the lift name and loses the target and the last time, which
 * describe one set and are the two lines this panel is a longer answer to.
 */
function renderOverviewPanel() {
  ui.done.hidden = true;
  ui.controls.hidden = true;
  ui.rest.hidden = state.restTotal === 0;
  ui.overview.hidden = false;
  ui.screen.classList.add('is-overview');
  ui.target.hidden = true;
  ui.lastTime.hidden = true;
  ui.prChip.hidden = true;

  // The day as well as the plan, so the rows the trainer marked as not logged are on the list. They
  // own no sets, so js/plan.js never built them, and until now that meant the panel showed a day
  // with exercises missing out of the middle of it.
  const rows = overviewRows(state.plan, state.cursor, state.day);
  ui.overviewTitle.textContent = dayTitle(state.day);
  ui.overviewPos.textContent = positionLine(rows);
  ui.overviewBody.innerHTML = renderOverview(rows);

  // Always offered. It used to leave once a set was logged, because it could only have answered
  // with a refusal at that point, and a control that argues is worse than one that is not there.
  // Now that it works mid session, the moment it used to disappear is the moment it is most
  // wanted: one or two sets into the wrong day is when somebody notices.
  ui.dayPicker.hidden = false;
}

/**
 * The way back to a lift the client stepped away from.
 *
 * Set when they jump, cleared when they arrive or when that lift runs out of sets to owe. It
 * outlives any one message, which is why it is a control and not a notice: the machine frees up
 * several minutes after the app had anything to say.
 */
function renderReturn() {
  const back = state.returnTo;
  const here = currentEntry();
  // The lift, not the set. Undo can leave the cursor on a different set of the same lift the offer
  // points at, and "Back to Leg Press" while standing at the leg press is the app talking to
  // itself.
  const usable =
    back &&
    isPending(back) &&
    here &&
    back.item !== here.item &&
    !state.overview;

  if (!usable) {
    ui.returnBar.hidden = true;
    return;
  }

  const left = runOf(back).filter(isPending).length;
  ui.returnBar.hidden = false;
  ui.returnTo.textContent =
    `Back to ${back.item.exercise.name}, ${left} ${left === 1 ? 'set' : 'sets'} left`;
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

  // Zero on the weight stepper is a real position on the number line and also a state: this lift,
  // this set, nothing held. So the readout says BW and drops the unit beneath it, because a unit
  // is what tells you which scale a number is on and there is no number here to put on one. The
  // typing fallback keeps the digit, since that field is an actual number input and 0 is how you
  // type your way back to no load.
  const bare = state.weightKg === 0;
  ui.weightValue.textContent = loadValue(state.weightKg);
  ui.weightUnit.textContent = bare ? '' : unit();
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
  //
  // The same rule reaches a weighted lift performed with nothing on it, which reads 'Bodyweight
  // for 8'. This line opens a sentence, so the first character is upper cased, and that only ever
  // lands on the word: a digit has no case and '15 lb for 8' comes through untouched.
  const load = loadLabel(state.weightKg);
  const opens = load.charAt(0).toUpperCase() + load.slice(1);
  ui.logSub.textContent =
    {
      weight_only: `${opens}${suffix}`,
      rounds: `${opens}, ${state.reps} rounds${suffix}`,
      bodyweight_reps: `${state.reps} rep${state.reps === 1 ? '' : 's'}${suffix}`,
      time_hold: `${state.reps} second${state.reps === 1 ? '' : 's'}${suffix}`,
    }[mode] ?? `${opens} for ${state.reps}${suffix}`;
}

function renderUndo() {
  ui.undo.disabled = state.logged.length === 0;
}

function renderDone() {
  ui.done.hidden = false;
  ui.overview.hidden = true;
  ui.screen.classList.remove('is-overview');
  ui.controls.hidden = false;
  // The session is over, so there is nothing left to rest for. A countdown next to the words
  // "Session logged" is the screen telling somebody to get ready for a set that does not exist,
  // and it was also the only place the one green shared a screen with the data cyan. Undo brings
  // the timer back with the set, which is the only state where it means anything again.
  stopRest();
  ui.rest.hidden = true;
  ui.stepperWeight.hidden = true;
  ui.stepperReps.hidden = true;
  ui.log.hidden = true;
  ui.skip.disabled = true;
  // The session is already closed, so there is nothing left for this to end. It stays on screen
  // rather than vanishing, because the panel it sits in is still readable and a control that
  // moves between visits is harder to find than one that is plainly spent.
  ui.end.disabled = true;
  ui.typeToggle.disabled = true;
  ui.addSet.disabled = true;

  ui.exerciseName.textContent = state.day.name;
  ui.setPosition.textContent = '';
  ui.target.hidden = false;
  ui.lastTime.hidden = false;
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

  // Only a session with something in it gets asked how it felt. "How did that feel?" under
  // "Nothing logged yet" is the app asking about a workout that did not happen.
  ui.feel.hidden = !sets;
  if (sets) renderFeel();

  // Undo stays live for the whole session, including after the last set, which is why the
  // secondary row is never hidden.
  renderUndo();
}

/**
 * The feelings row, the note, and the acknowledgement.
 *
 * Redrawn rather than mutated, the same way the day picker is, so the selected chip after a
 * reload and the selected chip after a tap cannot be built by two different pieces of code.
 */
function renderFeel() {
  ui.feelChips.innerHTML = FEELINGS.map((word) => {
    const on = state.feel === word;
    return (
      `<button type="button" class="button-secondary feel__item${on ? ' is-on' : ''}" ` +
      `data-feel="${escapeText(word)}" aria-pressed="${on}">${escapeText(word)}</button>`
    );
  }).join('');

  const said = Boolean(state.feel) || Boolean(state.feelText);
  // "Log set" produces "Logged." per the copy rules, so a question produces an answer rather than
  // staying a question with something ticked underneath it. This line is also the second place the
  // green lands, on the card's own background where it measures about 10.5:1.
  //
  // Three states now rather than two, because there is a submit in between. Asking, answered but
  // not sent, and saved. The middle one is the state the Done button exists for: something has been
  // said and the app has not been told to keep it yet.
  ui.feelAsk.textContent = state.feelSaved ? 'Saved.' : said ? 'Noted.' : 'How did that feel?';
  ui.feelAsk.dataset.state = state.feelSaved ? 'saved' : said ? 'said' : 'asking';

  // Done is live until it has been pressed, and comes back the moment anything changes. It is
  // offered on a session with nothing said as well, because "I am finished here" is a legitimate
  // thing to tell the app whether or not there is a note attached to it.
  ui.feelDone.textContent = state.feelSaved ? 'Saved' : 'Done';
  ui.feelDone.disabled = state.feelSaved;

  // The button is the way in. Once the field is open it stays open for the rest of the session,
  // because closing it would throw away a sentence somebody is halfway through typing.
  ui.feelMore.hidden = state.feelTyping;
  ui.feelNote.hidden = !state.feelTyping;
  ui.feelMore.textContent = state.feelText ? 'Edit the note' : 'Add a note';
  // Never while it has focus. Rewriting the value under a cursor moves the cursor to the end,
  // which on a phone is how a note ends up saying "shoulder tightt".
  if (document.activeElement !== ui.feelText) ui.feelText.value = state.feelText;
}

/**
 * Records how it felt, or takes the answer back.
 *
 * Tapping the chip that is already on clears it, which is the whole of undo for this control. A
 * separate clear button would be a fifth target on a four target row, and the thing being taken
 * back is one tap old.
 */
function setFeel(word) {
  state.feel = state.feel === word ? null : word;
  // Held, not written. Done is what writes.
  state.feelSaved = false;
  keepDraft();
  renderFeel();
}

/**
 * Writes what the client said onto the session row, on the Done button and nowhere else.
 *
 * IT USED TO WRITE ON EVERY TAP, and the argument for that is still in the repository history and
 * still half right: everything else on this screen writes on the action itself, so a note that
 * needed confirming was the one thing here that could be lost by walking away. What that reasoning
 * missed is that a screen with no submit has no moment of completion either, so finishing a session
 * was something that quietly happened rather than something the app ever confirmed.
 *
 * So there is a submit now, and the loss it reintroduces is answered directly rather than by
 * writing early: keepDraft holds the unsent answer in sessionStorage, so a reload during the
 * summary comes back with it rather than losing it.
 *
 * WHAT IS NOT HELD IS THE SETS. Those are written the instant they are logged and always have been.
 * A phone that dies between the last set and this button costs an unsent note, never a workout, and
 * that ordering is not negotiable: set_logs is append only precisely so a session is on disk before
 * anybody thinks about confirming anything.
 */
function saveNote() {
  if (!state.sessionRecord) return;
  const note = composeNote(state.feel, state.feelText);
  state.feelSaved = true;
  dropDraft();
  if (note !== (state.sessionRecord.client_note ?? null)) stampSession({ client_note: note });
  // Said once, at the end, on a screen somebody is about to close. For a calisthenics block this
  // is most of what the coach needs, and it is the last thing written before the phone goes away.
  flushSoon();
  renderFeel();
}

/**
 * The unsent answer, kept where a reload can find it.
 *
 * sessionStorage rather than the session row, because the whole point is that this has not been
 * recorded yet. Keyed by the session, so a draft cannot leak onto a different workout. Wrapped
 * because private mode can refuse storage entirely, and a summary card that throws is worse than
 * one that forgets a sentence.
 */
const DRAFT_KEY = 'ptc.feel.draft';

function keepDraft() {
  if (!state.sessionRecord) return;
  try {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ id: state.sessionRecord.id, feel: state.feel, text: state.feelText }),
    );
  } catch {
    // Storage denied. The answer is still on screen and Done still writes it.
  }
}

function dropDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clean up that we are allowed to touch.
  }
}

/** Puts an unsent answer back after a reload, for this session and no other. */
function restoreDraft(sessionId) {
  try {
    const held = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (!held || held.id !== sessionId) return false;
    state.feel = held.feel ?? null;
    state.feelText = held.text ?? '';
    state.feelTyping = Boolean(held.text);
    return true;
  } catch {
    return false;
  }
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
  // A fresh session has said nothing yet, so the summary must not open on a "Saved." left behind
  // by the one before it. The draft goes too: it is keyed by session id and would never match
  // this one, but leaving a stale key around is how a draft eventually lands on the wrong workout.
  state.feel = null;
  state.feelText = '';
  state.feelTyping = false;
  state.feelSaved = false;
  dropDraft();
  state.sessionRecord = makeRecord('sessions', {
    client_id: state.client.id,
    assignment_id: state.assignment ? state.assignment.id : null,
    day_index: state.day.day_index,
    started_at: new Date().toISOString(),
    completed_at: null,
    client_note: null,
    discarded_at: null,
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
    // The entry, not its index. A set added to a lift the client came back to shifts every index
    // after it, and an undo stack holding numbers would then take back somebody else's set.
    entry,
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

  // What was actually on the bar, before the cursor moves off the set it belongs to.
  const justLogged = { weightKg: state.weightKg, reps: state.reps };

  entry.status = 'logged';
  const from = state.cursor;
  const at = nextPending(from + 1);
  const wrapped = at !== -1 && at < from;
  state.cursor = at === -1 ? state.plan.length : at;

  const next = currentEntry();
  const steppers = nextSteppers(justLogged, entry, next);
  if (steppers) {
    state.weightKg = steppers.weightKg;
    state.reps = steppers.reps;
  }

  // Only when there is something to rest for. The last set of the day is followed by the summary,
  // not by another set.
  if (next) startRest(entry.item.rest_seconds);
  else stopRest();
  exitTypingMode();
  clearNotice();
  // Logging on the lift the offer points at means the client took it. It is spent.
  if (state.returnTo && state.returnTo.item === entry.item) state.returnTo = null;
  render();
  showPr(isPr, entry.item.exercise.name);

  // Finishing here can hand the client to a lift that sits earlier in the day, because everything
  // after this one is already done. The header says where they are and this says how they got
  // there, since a lift changing on its own is otherwise indistinguishable from a mis-tap.
  if (wrapped) showNotice(`Back to ${next.item.exercise.name}, which still has sets.`);

  // A session ends when nothing is left, rather than when the cursor runs off the end of the
  // plan. Those were the same thing while the lifts could only be done in order. They stopped
  // being the same thing the moment somebody could log the last set on the list first.
  const shouldComplete = !state.plan.some(isPending);
  write(async () => {
    if (!state.sessionWritten) {
      await state.storage.put('sessions', session);
      state.sessionWritten = true;
    }
    await state.storage.put('set_logs', record);
  });

  // Queued after the pair above rather than inside them, which the serial queue guarantees, so the
  // row that closes the session still cannot overtake the set that closed it.
  if (shouldComplete) {
    state.sessionClosed = true;
    stampSession({ completed_at: new Date().toISOString() });
  }

  // Per set rather than per session, because a session that is abandoned rather than ended is the
  // normal way one finishes: the sets are real and the phone simply goes in a pocket. Waiting for
  // a close that may never come would leave every one of them here.
  flushSoon();
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
  last.entry.status = 'pending';
  state.cursor = state.plan.indexOf(last.entry);
  state.weightKg = last.weightKg;
  state.reps = last.reps;
  stopRest();
  ui.prChip.hidden = true;
  exitTypingMode();
  clearNotice();
  // Taking a set back is the client saying they are on this lift after all, so an offer to go
  // back to it is answering a question nobody is asking any more.
  if (state.returnTo && state.returnTo.item === last.entry.item) state.returnTo = null;
  closeOverview({ render: false });
  render();

  const wasClosed = state.sessionRecord.completed_at !== null || state.sessionClosed;
  write(() => state.storage.put('set_logs', retraction));

  // Taking back the final set reopens the session, otherwise it stays closed with a set in it that
  // no longer counts. What the client said about it stays: they said it about the sets they did,
  // and taking one back does not unsay it.
  if (wasClosed) {
    state.sessionClosed = false;
    stampSession({ completed_at: null });
  }

  // A retraction is a row like any other and is owed to the server like any other. Leaving it here
  // while the set it takes back has already gone means the trainer reads a set that was undone.
  flushSoon();
}

/**
 * Moves past every remaining set of the current lift. Nothing is written, because nothing was
 * performed and absence is the truthful record. No warning colour, no badge, no count of what
 * was missed: the acknowledgement names the lift the client is now on.
 *
 * A skipped set is marked rather than merely walked past, which is what a cursor could imply back
 * when the cursor could only move one way. It is still not a failure state and the overview does
 * not label it as one: a skipped lift and a lift nobody has reached read identically there, and
 * both are one tap away for the rest of the session.
 */
function skipExercise() {
  const entry = currentEntry();
  if (!entry) return;

  for (const sibling of runOf(entry)) {
    if (isPending(sibling)) sibling.status = 'skipped';
  }

  const at = nextPending(state.cursor);
  state.cursor = at === -1 ? state.plan.length : at;

  const next = currentEntry();
  if (next) {
    state.weightKg = next.weightKg;
    state.reps = next.reps;
  }

  // The lift being left was chosen against rather than postponed, so the offer to go back to it
  // goes with it.
  if (state.returnTo && state.returnTo.item === entry.item) state.returnTo = null;

  stopRest();
  exitTypingMode();
  ui.prChip.hidden = true;
  closeOverview({ render: false });
  render();
  showNotice(next ? `On to ${next.item.exercise.name}.` : 'That was the last lift.');
}

// ------------------------------------------------------------------ moving around the day
//
// A rack is taken, or a machine has somebody sitting on it, and the lift that comes next is not
// the lift that can be done next. The order in a program is the trainer's intent rather than a
// queue, so this screen lets the client take it in whatever order the room allows, and remembers
// what they stepped away from.

function openOverview() {
  state.overview = true;
  exitTypingMode();
  render();
  // Keyboard and screen reader users land inside what they just opened. There is no focus trap,
  // because this is a state of the screen and not a layer over it: tabbing past the end reaches
  // the tab bar, which is exactly where tabbing should go.
  const first = ui.overviewBody.querySelector('[data-jump]') ?? ui.overview.querySelector('button');
  if (first) first.focus();
}

function closeOverview({ render: repaint = true, focus = false } = {}) {
  if (!state.overview) return;
  state.overview = false;
  if (repaint) render();
  if (focus) ui.dayJump.focus();
}

/**
 * Opens the set at `index` and remembers the lift being left, while it still owes sets.
 *
 * The rest timer keeps running. It is counting the client's recovery, not the app's position in a
 * list, and a jump between lifts is the one moment where somebody is most likely to be watching it
 * to decide whether to wait for the rack or move on.
 */
function jumpTo(index) {
  const entry = state.plan[index];
  if (!entry) return;

  const leaving = currentEntry();
  state.returnTo =
    leaving && leaving.item !== entry.item && runOf(leaving).some(isPending) ? leaving : null;

  // Going to a lift that was skipped is a change of mind, so the sets come back. Skip means "move
  // me on now" rather than "never", and it only meant never while the cursor could not turn round.
  for (const sibling of runOf(entry)) {
    if (sibling.status === 'skipped') sibling.status = 'pending';
  }

  state.cursor = index;

  // Through the same rule a tap on Log set goes through, and for the same reason the resume path
  // does: an adjustment the client made on this lift has to survive leaving it and coming back.
  // Reading the entry's own prefill would put them back on the number the plan opened with, which
  // is the deliberately light fallback on a lift with no history, and they would correct it twice.
  const previous = [...state.logged].reverse().find((row) => row.entry.item === entry.item);
  const steppers = previous
    ? nextSteppers(previous, previous.entry, entry)
    : { weightKg: entry.weightKg, reps: entry.reps };
  state.weightKg = steppers.weightKg;
  state.reps = steppers.reps;
  exitTypingMode();
  ui.prChip.hidden = true;
  clearNotice();
  closeOverview({ render: false });
  render();
}

/**
 * Appends one more set to the lift the client is on, prefilled from where the steppers already
 * sit, and marks it extra.
 *
 * The insert lands at the end of that lift's own run, which can now be behind sets already logged
 * on a later lift. That used to matter: the undo stack held plan indexes, and everything after the
 * insert shifted by one. It holds the entries themselves now, so an insert anywhere is free.
 */
function addSet() {
  const entry = currentEntry();
  if (!entry) return;

  const siblings = runOf(entry);
  const insertAt = state.plan.indexOf(siblings[siblings.length - 1]) + 1;
  const highestIndex = siblings.reduce((max, s) => Math.max(max, s.setIndex), -1);

  state.plan.splice(insertAt, 0, {
    item: entry.item,
    setIndex: highestIndex + 1,
    isWarmup: false,
    isExtra: true,
    logMode: entry.logMode,
    weightKg: state.weightKg,
    reps: state.reps,
    lastWeightKg: null,
    lastReps: null,
    lastOn: null,
    carriedFrom: null,
    openingSource: null,
  });

  render();
  showNotice(`Extra set added to ${entry.item.exercise.name}.`);
}

/** Closes the session with whatever is in it. A session with two lifts in it is a session. */
function endSession() {
  state.cursor = state.plan.length;
  state.returnTo = null;
  stopRest();
  exitTypingMode();
  clearNotice();
  closeOverview({ render: false });
  render();

  // Nothing was ever logged, so there is no session row to close.
  //
  // The test is the record rather than `state.sessionWritten`, which is set inside the write queue
  // and is therefore still false for the moment between logging a set and that set reaching the
  // adapter. Ending a session inside that window used to close it and now would not. A record
  // exists only if a set was logged, and the insert is already ahead of this one in a serial
  // queue, so asking here is both synchronous and correct.
  if (!state.sessionRecord) return;
  state.sessionClosed = true;
  stampSession({ completed_at: new Date().toISOString() });
  // The one moment somebody has said they are finished. Everything logged in this session is on
  // the queue behind this, and the phone is about to go away.
  flushSoon();
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
      const label = dayTitle(day);
      return (
        `<button type="button" class="button-secondary daypicker__item${on ? ' is-on' : ''}" ` +
        `data-day="${day.day_index}"${on ? ' aria-current="true"' : ''}>${escapeText(label)}</button>`
      );
    })
    .join('');
}

const escapeText = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Moves this session onto another day, at any point in it.
 *
 * It used to refuse once a set was logged, on the grounds that switching would orphan what was
 * already there. The refusal was the worse end of that trade. Starting the wrong day is an
 * ordinary mistake, it is usually noticed one or two sets in, and the app's answer was a sentence
 * telling somebody to finish or end a session they had just said they did not mean to start.
 *
 * What that produced, on a real workout: the client undid every set one at a time to get the
 * picker to open, trained the day he actually wanted, and the session still read as the wrong one
 * afterwards. Three walls in one workout, and he knows this app better than anybody. Somebody
 * newer does not improvise around it, they stop logging.
 *
 * So the day moves and the sets come with it, because they happened. Anything whose lift is in the
 * new day gets its seat back. Anything whose lift is not stays in the session and stays in
 * history, and undo takes it back one tap at a time exactly as it always did. Nothing is deleted
 * here on somebody's behalf: this screen has no destructive action that runs without being asked
 * for, and "I picked the wrong day" is not consent to throw away a set.
 */
async function chooseDay(dayIndex) {
  const picked = sortedDays(state.assignment.snapshot).find((d) => d.day_index === Number(dayIndex));
  if (!picked || picked.day_index === state.day.day_index) return;

  const carried = state.logged.length;
  state.day = picked;

  // The session follows the picker, or it files itself under the day the client changed their mind
  // about. This is the row the next set is written against and the row every chart reads the day
  // from, so it has to move whether it has sets in it or not.
  if (state.sessionRecord) {
    const moved = {
      ...state.sessionRecord,
      day_index: picked.day_index,
      updated_at: new Date().toISOString(),
    };
    state.sessionRecord = moved;
    if (state.sessionWritten) write(() => state.storage.put('sessions', moved));
  }

  const sessions = await loadSessions(state.storage, state.client.id);
  await openDayOn(picked, sessions, state.sessionRecord);

  state.returnTo = null;
  renderDayPicker(state.assignment.snapshot, sessions);
  stopRest();
  clearNotice();

  // Closed, like tapping a lift closes it. The panel is where a choice is made and the choice has
  // been made, so the screen goes back to the set that is now next. It also has to close for the
  // line below to be readable at all: paintNotice drops a neutral message while the panel is up,
  // deliberately, because the panel is already a full answer to where somebody is.
  closeOverview({ render: false });

  // Named, and counted. Moving a day changes what every other number on this screen means, and the
  // sets that came along are not on the new day's list when their lift is not in it, so silence
  // would leave somebody who tapped a chip by accident unable to tell whether their work survived.
  if (carried) {
    showNotice(`Moved to ${dayTitle(picked)}. ${carried} logged ${carried === 1 ? 'set' : 'sets'} came too.`);
  }
  render();
}

/**
 * Opens a day: builds its plan and puts whatever this session already has back on it.
 *
 * One function because two callers do this and they used to do it differently. Arriving on a day
 * after a locked phone replayed the rows onto the plan; arriving on a day by tapping the picker did
 * not, because the picker refused to work once a set had been logged and therefore never had rows
 * to put back. Removing that refusal made the difference matter, and a second copy of the replay is
 * how the two would drift.
 *
 * A row whose lift is not in this day at all keeps its seat nowhere and its place in history
 * everywhere: replaySession leaves it out of the walk and the row itself is untouched. That is the
 * honest handling of somebody who logged two sets of the wrong day's opener before noticing. The
 * sets happened. They are simply not part of the day now on screen, and undo still takes them back
 * one tap at a time for as long as the session is open.
 */
async function openDayOn(day, sessions, session) {
  state.plan = await buildPlan(state.storage, day, sessions, {
    exclude: session ? session.id : null,
  });

  const rows = session ? await state.storage.query('set_logs', { session_id: session.id }) : [];
  if (rows.length) {
    const replayed = replaySession(state.plan, rows, state.best);
    state.plan = replayed.plan;
    state.logged = replayed.logged;
    state.cursor = replayed.cursor;
    for (const done of replayed.logged) done.entry.status = 'logged';
  } else {
    state.logged = [];
    state.cursor = 0;
  }

  // What the steppers read on arrival, through the same rule a tap on Log set goes through, so a
  // locked phone does not undo an adjustment the way logging a set used to. After a day move the
  // carry stops on its own: nextSteppers compares the lift, and the lift on the new day is a
  // different item, so the numbers come from the new day's plan rather than the old day's last set.
  const first = state.plan[state.cursor];
  if (!first) return;

  const last = state.logged[state.logged.length - 1];
  const steppers = last
    ? nextSteppers(last, last.entry, first)
    : { weightKg: first.weightKg, reps: first.reps };
  state.weightKg = steppers.weightKg;
  state.reps = steppers.reps;
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

  // The chip is its own close control, which is why the panel carries no second one. The day
  // stays named and the glyph turns over, so the thing that opened it is where the eye already is.
  ui.dayJump.addEventListener('click', () => {
    if (state.overview) closeOverview();
    else openOverview();
  });

  ui.overviewBody.addEventListener('click', (event) => {
    const row = event.target.closest('[data-jump]');
    if (row) jumpTo(Number(row.dataset.jump));
  });

  ui.returnTo.addEventListener('click', () => {
    const back = state.returnTo;
    if (back) jumpTo(state.plan.indexOf(back));
  });

  // Escape closes the panel, because a mode that can be entered by mistake has to be leavable
  // without hunting. Nothing else on this screen listens for a key, so there is nothing to fight.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.overview) closeOverview({ focus: true });
  });

  ui.dayPicker.addEventListener('click', (event) => {
    const button = event.target.closest('[data-day]');
    if (button) chooseDay(button.dataset.day);
  });

  ui.feelChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feel]');
    if (button) setFeel(button.dataset.feel);
  });

  ui.feelMore.addEventListener('click', () => {
    state.feelTyping = true;
    renderFeel();
    ui.feelText.focus();
  });

  // Takes the typing into memory on Enter and on blur. It no longer writes: Done does that. Both
  // handlers stay, because a phone that locks with the keyboard up never fires `change`, and the
  // draft has to be held before the screen goes away either way.
  const takeTyping = () => {
    const typed = ui.feelText.value.trim();
    if (state.feelText === typed) return;
    state.feelText = typed;
    state.feelSaved = false;
    keepDraft();
    renderFeel();
  };
  ui.feelText.addEventListener('change', takeTyping);
  ui.feelText.addEventListener('blur', takeTyping);

  // The submit. Everything the client said goes down here, in one write, and the card says so.
  ui.feelDone.addEventListener('click', () => {
    takeTyping();
    saveNote();
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

/**
 * The dead ends: signed in but bound to nobody, no client, no program, no days in it.
 *
 * Everything that could log a set goes, including the rest timer and the way into the day. A
 * countdown on a screen with no session behind it is the app pretending, and the chip would open
 * a panel listing nothing.
 */
function nothingToLog(name) {
  ui.exerciseName.textContent = name;
  ui.controls.hidden = true;
  ui.rest.hidden = true;
  ui.dayJump.hidden = true;
}

async function main() {
  let booted;
  try {
    booted = await boot({ role: 'client' });
  } catch (error) {
    nothingToLog('Cannot open storage');
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
    nothingToLog('Nothing assigned');
    // The only screen this person can reach, so it has to carry the way off it.
    el('account').hidden = false;
    showNotice('You are signed in, but no trainer has added this email as a client yet.');
    return;
  }
  if (booted.error) showNotice(booted.error);

  if (!actor || !actor.clientId) {
    nothingToLog('No client selected');
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
    // The steppers and Log set have to go with it. Leaving a live primary action on a screen
    // with no plan behind it invites a tap that writes a set against nothing.
    nothingToLog('No program yet');
    showNotice(NO_PROGRAM_YET);
    return;
  }

  // Read live rather than from the frozen snapshot: the increment describes the equipment in
  // the room, not the program, so a rack that changes should reach an old assignment too. Where
  // this query returns nothing for a lift, incrementOf falls back to the snapshot, because a
  // client can only read their own trainer's exercises and a program built from somebody else's
  // is a program whose whole library is invisible to the person doing it.
  const exercises = await storage.query('exercises', {});
  state.increments = new Map(exercises.map((row) => [row.id, row.increment_kg]));
  state.equipment = new Map(exercises.map((row) => [row.id, row.equipment]));

  const snapshot = assignment.snapshot;

  // A session already in progress, if there is one.
  //
  // This screen's whole state is one object in one tab, and a phone that locks for long enough
  // loses that tab. Everything logged is on disk, so what is actually missing after a reload is
  // only the app's memory of where it had got to, and the rows are enough to rebuild it.
  //
  // Without this the reload was worse than starting over. pickDay advances from the last session,
  // and a session exists the moment the first set is logged, so coming back mid workout landed on
  // the next day of the split rather than the one being trained: back and chest turned into
  // shoulders. Choosing the right day again then rebuilt the plan from history that now included
  // the half finished session, so the day shrank to the sets already done and closed itself on
  // the next tap.
  const open = openSession(sessions);
  const openDay = open ? sortedDays(snapshot).find((day) => day.day_index === open.day_index) : null;
  state.day = openDay ?? pickDay(snapshot, sessions);

  // A program with no days in it. Reachable today, because deleting the last day of a template
  // in the builder is allowed. From this side of the app it is the same situation as no program
  // at all, so it gets the same screen rather than a blank one, and it names the same person.
  if (!state.day) {
    nothingToLog('No program yet');
    showNotice(NO_PROGRAM_YET);
    return;
  }

  // The same function the day picker goes through. A set on disk is a set that was done, wherever
  // in the day it sits, and both ways of arriving on a day have to put those sets back the same
  // way or they are two answers to one question.
  await openDayOn(state.day, sessions, openDay ? open : null);

  if (openDay) {
    state.sessionRecord = open;
    // Already on disk, so the next write must not try to insert it again.
    state.sessionWritten = true;
    state.sessionClosed = false;
    // Anything said about this session before the interruption comes back with it, chip and all.
    // A client who answered, locked the phone, and came back to log one more set would otherwise
    // find the row blank and either answer twice or assume the first answer was lost.
    // The row first, then anything unsent on top of it: a draft only exists because Done was not
    // pressed, so it is newer than whatever the row is carrying.
    const already = parseNote(open.client_note);
    state.feel = already.feel;
    state.feelText = already.text;
    state.feelTyping = Boolean(already.text);
    // Whatever is on the row got there through Done, so it counts as saved until something moves.
    state.feelSaved = Boolean(open.client_note);
    // And an unsent draft goes on top, because it only exists because Done was not pressed.
    if (restoreDraft(open.id)) state.feelSaved = false;
  }

  renderDayPicker(snapshot, sessions);
  ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';

  // Flipping mid session is safe: state.weightKg is kilograms and stays put, so the number on the
  // stepper changes and the load on the bar does not. The step changes with it, which is the
  // point, because 2.5 kg is not a thing a pound gym can add.
  mountUnitSetting(el('unit-setting'));
  onUnitChange(() => {
    ui.weightInput.step = unit() === 'lb' ? '5' : '2.5';
    render();
  });

  wire();
  stopRest();
  render();

  // Said out loud, because the failure this fixes was not only landing on the wrong day, it was
  // having no way to tell whether the session was still going. The count is what makes it
  // checkable against the room: somebody who has done four sets and reads four knows the app
  // kept up. Neutral tone, since nothing went wrong and being interrupted is not a failure.
  if (openDay && state.logged.length) {
    const sets = state.logged.length;
    showNotice(`Back in ${dayTitle(state.day)}, ${sets} ${sets === 1 ? 'set' : 'sets'} in.`);
  }
}

main();
