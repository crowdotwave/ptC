// The client progress view. Reads through the adapter, computes in js/progression.js, draws in
// js/charts.js. Nothing here decides what counts.
//
// The order of the two top charts is not fixed. With one block there is no cross block story,
// so volume leads. With two or more the six month question exists and estimated 1RM leads,
// because volume misreports strength in both directions and estimated 1RM is the only series
// here designed to cross a change of rep scheme.

import { boot, gate } from './js/boot.js';
import { mountShell } from './js/nav.js';
import { buildProgression } from './js/progression.js';
import { buildConsistency } from './js/consistency.js';
import { renderConsistency, renderMonthNav, longDay, sessionLabel } from './js/consistency-view.js';
import { renderSessionReadout } from './js/session-readout.js';
import { renderLiftPicker, groupLifts, liftSummaries } from './js/lift-picker.js';
import { activeSetLogs } from './js/history.js';
import { openSession, loadSessions, summarise, discardSession } from './js/session.js';
import { renderHistory, discardedMessage } from './js/session-view.js';
import { isoDate, localDayOf } from './js/dates.js';
import { currentAssignment } from './js/snapshot.js';
import {
  unit,
  toDisplay,
  weightLabel,
  loadUnit,
  mountUnitSetting,
  onUnitChange,
  viewerName,
} from './js/units.js';
import {
  renderE1rmChart,
  renderVolumeChart,
  renderRepsAtLoadChart,
  renderRepsChart,
  renderHoldChart,
  renderSessionVolumeChart,
} from './js/charts.js';
import { buildSessionVolume } from './js/session-volume.js';

const el = (id) => document.getElementById(id);
const state = {
  storage: null,
  client: null,
  data: null,
  exerciseId: null,
  exercises: new Map(),
  // The consistency grid's own state. Held apart from the lift scoped fields above because it is
  // built once and never rebuilt by render(), which runs on every unit toggle and every resize.
  // Which month is showing is deliberately NOT here: the scroll position is that answer.
  consistency: null,
  // Work per session, client wide. Built once alongside the grid, for the same reason the grid is:
  // it is not scoped to a lift, so picking another one cannot change it. It is REDRAWN on a unit
  // toggle and on a resize, because it carries weights and it measures its container.
  work: null,
  assignments: new Map(),
  sessionsByDay: new Map(),
  logsBySession: new Map(),
  // The lift picker. `liftList` is every lift this client has done and `liftSnapshot` is the
  // program they are on now, which is what the list is grouped by. The two below are the control's
  // own state, whether the list is open and what has been typed into it, held here rather than
  // read back off the DOM so a redraw cannot lose either one.
  liftList: [],
  liftSnapshot: null,
  pickerOpen: false,
  pickerQuery: '',
  // The day tapped on the consistency grid, and the sessions it holds. Null means no day is
  // focused, which is the state this screen opens in and the state tapping the same day again
  // returns it to. Everything focus does is additive: the charts still draw the whole history,
  // because a session with nothing around it is a dot rather than a comparison.
  focusDay: null,
  focusSessionIds: null,
  // The session history list. `armed` is the session whose Discard has been tapped once, held
  // here rather than in the markup so a redraw cannot lose or invent it.
  history: [],
  armed: null,
  // Whether the person reading is the person who trained. Decides the Discard control and nothing
  // else on this screen, and it defaults to false so a bug that forgets to set it withholds a
  // control rather than offering one that cannot work.
  isSelf: false,
};

function setCopy(id, text) {
  el(id).textContent = text;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Volume is sets by reps by weight, so it carries the weight unit and scales with it exactly as a
 * single load does. Rounded whole in both units, because a tenth of a kilogram is noise on a
 * four figure number.
 */
const volumeLabel = (v) => `${Math.round(toDisplay(v)).toLocaleString()} ${unit()}`;

/** Seconds and rep counts are not weights and never convert. */
const plainLabel = (suffix) => (v) => `${round1(v)}${suffix}`;

/** Claims escalate with evidence: a fact, then a difference, then a direction. */
function captionFor(kind, progression) {
  // Each view carries its own formatter, because the precision is not the same for all four. A
  // load wants a tenth of a kilogram and a whole pound; a volume in the thousands wants neither,
  // and printing "Up 612.9 lb" next to a headline of "3,468 lb" is the kind of mismatch that
  // makes a number look computed rather than measured. Reps and seconds are not weights at all
  // and never convert.
  const views = {
    e1rm: [progression.e1rm, 'Estimated 1RM', weightLabel],
    volume: [progression.volume, 'Prescribed volume', volumeLabel],
    reps: [progression.reps, 'Top set', (v) => `${round1(v)} reps`],
    hold: [progression.hold, 'Longest hold', (v) => `${round1(v)} seconds`],
  };
  const [view, label, amount] = views[kind] || views.volume;
  const change = view.change;

  switch (view.evidence) {
    case 'none':
      return 'Nothing logged for this lift yet.';
    case 'single':
      return 'First session logged. Log one more and the comparison starts.';
    case 'compare':
      if (!change) return 'Two sessions logged.';
      return `${label} ${change.absolute >= 0 ? 'up' : 'down'} ${amount(
        Math.abs(change.absolute),
      )} since the session before. Two points, not a trend.`;
    default: {
      if (!change) return '';
      // The percentage is a ratio, so it is the same number in either unit and never converts.
      const move = `${change.absolute >= 0 ? 'Up' : 'Down'} ${amount(Math.abs(change.absolute))}${
        change.percent === null ? '' : `, ${change.percent > 0 ? '+' : ''}${change.percent} percent`
      }`;
      // Estimated 1RM spans everything and says which formula it is, per CLAUDE.md. Volume is
      // only ever compared inside one block, so it says which block rather than how many.
      if (kind === 'e1rm') {
        const n = progression.blocks.length;
        return `${move} across ${n} block${n === 1 ? '' : 's'}. Epley, weight times one plus reps over thirty.`;
      }
      if (kind === 'volume') {
        return `${move} inside this block. Volume is not comparable across a change of rep range.`;
      }
      // No load, so there is no formula to name and no rep range change to warn about. The
      // number is simply the thing that happened.
      return `${move} across ${progression.totalSessions} sessions.`;
    }
  }
}

/**
 * Which lifts the picker is offering right now.
 *
 * The whole list, unless a day is focused on the grid, in which case it is the lifts that day
 * held. That narrowing is the point of tapping a day: somebody looking at the sixteenth wants the
 * charts for what they did on the sixteenth, and scrolling past thirty lifts they did not touch to
 * reach one they did is the work the tap was meant to save.
 *
 * Never empty when a day is focused, because the grid only makes a day tappable when it holds live
 * sets, and those sets are what this reads.
 */
function pickerLifts() {
  if (!state.focusSessionIds) return state.liftList;
  const inDay = new Set();
  for (const id of state.focusSessionIds) {
    for (const row of state.logsBySession.get(id) ?? []) {
      if (!row.is_warmup) inDay.add(row.exercise_id);
    }
  }
  const narrowed = state.liftList.filter((lift) => inDay.has(lift.id));
  return narrowed.length ? narrowed : state.liftList;
}

/**
 * The lift picker, redrawn whole.
 *
 * innerHTML rather than patching, because the control is small and the alternative is a second
 * copy of what it looks like that has to be kept in step with the first. The one thing a redraw
 * must not throw away is the caret in the search field, so the caller is expected to say when it
 * is a keystroke driving this: see the input listener.
 */
function drawPicker() {
  // Nothing logged, so there is nothing to choose between. An empty control is worse than none:
  // it says a choice exists and then offers no options.
  if (!state.liftList.length) {
    el('lift-picker').innerHTML = '';
    return;
  }
  const lifts = pickerLifts();
  el('lift-picker').innerHTML = renderLiftPicker({
    lifts,
    groups: groupLifts(lifts, state.liftSnapshot),
    selectedId: state.exerciseId,
    open: state.pickerOpen,
    query: state.pickerQuery,
    scope: state.focusDay ? longDay(state.focusDay) : null,
  });
}

/** Open or close the list, and put the caret in the search field when there is one. */
function setPickerOpen(open) {
  state.pickerOpen = open;
  // Typing survives a close and reopen only for as long as the panel is a single visit. Coming
  // back to a list still filtered by something typed a minute ago is a chooser hiding most of its
  // options with no visible reason, which is the failure this control was built to end.
  if (!open) state.pickerQuery = '';
  drawPicker();
  if (!open) return;
  const search = el('liftpick-search');
  if (search) search.focus();
}

/**
 * What the lead chart is, for this exercise.
 *
 * A pushup has no estimated 1RM and no volume, so offering either would be drawing a zero and
 * calling it a measurement. progression.kind is read off what was actually logged, so this
 * follows the history rather than the program.
 */
function leadFor(data) {
  switch (data.leadView) {
    case 'hold':
      return { title: 'Longest hold', render: renderHoldChart, view: data.hold, format: plainLabel('s') };
    case 'reps':
      return { title: 'Top set reps', render: renderRepsChart, view: data.reps, format: plainLabel('') };
    case 'e1rm':
      return { title: 'Estimated 1RM', render: renderE1rmChart, view: data.e1rm, format: weightLabel };
    default:
      return { title: 'Volume per session', render: renderVolumeChart, view: data.volume, format: volumeLabel };
  }
}

function render() {
  const data = state.data;
  const exercise = state.exercises.get(state.exerciseId);
  el('exercise-name').textContent = exercise ? exercise.name : '';

  // The session a tapped day holds, marked on every chart below rather than filtered to. See
  // focusMark in js/charts.js for why marking and not filtering.
  const focus = state.focusSessionIds;

  const last = data.points[data.points.length - 1];
  el('headline').textContent = last
    ? `${data.totalSessions} session${data.totalSessions === 1 ? '' : 's'}, last on ${new Date(
        last.date,
      ).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : 'No sessions on this lift yet.';

  const loaded = data.kind === 'load';

  // First slot: what this lift is actually measured by. Volume for a loaded lift, the rep count
  // for a bodyweight one, seconds for a hold.
  const lead = loaded
    ? { title: 'Volume per session', render: renderVolumeChart, view: data.volume, format: volumeLabel, key: 'volume' }
    : leadFor(data);
  setCopy('lead-title', lead.title);
  setCopy('lead-value', lead.view.change ? lead.format(lead.view.change.last) : '');
  lead.render(el('lead-plot'), data, { focus });
  const extraTotal = data.points.reduce((t, p) => t + p.extra, 0);
  setCopy(
    'lead-caption',
    captionFor(lead.key ?? data.leadView, data) +
      // Naming the band as well as the number. The bar is stacked, prescribed under added, and
      // the pale top segment is the only thing on this card with no label of its own.
      (loaded && extraTotal > 0
        ? ` Plus ${volumeLabel(extraTotal)} you added beyond the plan, drawn as the pale band on each bar.`
        : ''),
  );

  // Reps at load and estimated 1RM are both load only. Without load, volume computes to a row
  // of zeroes and an estimated 1RM does not exist, so the slots go away rather than showing a
  // measurement that is really an absence.
  el('reps-chart').hidden = !loaded;
  el('second-chart').hidden = !loaded;

  if (!loaded) return;

  // Last. The slowest moving number, and the only one designed to cross a change of rep scheme,
  // so it answers a question about months rather than about today.
  setCopy('second-title', 'Estimated 1RM');
  setCopy('second-value', data.e1rm.change ? weightLabel(data.e1rm.change.last) : '');
  renderE1rmChart(el('second-plot'), data, { focus });
  setCopy('second-caption', captionFor('e1rm', data));

  // Reps at load. Always visible for a loaded lift, because for an intermediate this is the only
  // place a block of real progress shows up at all. Hidden without load, where every value would
  // be one line labelled 0 kg repeating what the lead chart already said.
  renderRepsAtLoadChart(el('reps-plot'), data, { focus });
  const lines = data.repsAtLoad.lines;
  setCopy('reps-value', lines.length ? weightLabel(lines[lines.length - 1].loadKg) : '');
  setCopy(
    'reps-caption',
    lines.length === 0
      ? 'Nothing logged in this block yet.'
      : data.repsAtLoad.evidence === 'single'
        ? 'One session at this load. The comparison starts next time.'
        : `Current block, ${lines.length} load${lines.length === 1 ? '' : 's'}. The bar holding still while reps climb is progress.`,
  );
}

// ------------------------------------------------------------------ work per session
//
// The client wide chart, between the grid and the lift picker. js/session-volume.js decides what
// counts and why it is split by program day rather than totalled; this only says it in words.

/**
 * What the lines add up to, in a sentence.
 *
 * It speaks about ONE line, named, and never about the last two sessions. The last two sessions are
 * usually two different program days, so "up 4,300 lb since last time" would be reporting that
 * Thursday is not Tuesday. The line with the most sessions behind it is the one with something to
 * say, and js/session-volume.js picks it.
 */
function workCaption(built) {
  const day = built.lead ? built.lead.label : 'this program';
  const extra =
    built.hiddenCount > 0
      ? ` ${built.hiddenCount} other day${built.hiddenCount === 1 ? '' : 's'} not shown.`
      : '';

  switch (built.evidence) {
    case 'none':
      return 'Nothing with a weight on it logged yet.';
    case 'single':
      return `One session on ${day}. Log it again and the comparison starts.${extra}`;
    case 'compare':
      return `Two sessions on ${day}. A comparison, not a trend.${extra}`;
    default: {
      const change = built.change;
      if (!change) return `Every session you have logged, by program day.${extra}`;
      const move = `${change.absolute >= 0 ? 'Up' : 'Down'} ${volumeLabel(Math.abs(change.absolute))}${
        change.percent === null ? '' : `, ${change.percent > 0 ? '+' : ''}${change.percent} percent`
      }`;
      // Same warning the per lift volume chart carries, and for the same reason: sets by reps by
      // weight is only comparable while the rep range holds still.
      return `${move} on ${day} since the first one. Volume is not comparable across a change of rep range.${extra}`;
    }
  }
}

function drawWork() {
  const built = state.work;
  const card = el('work-chart');
  if (!built || !built.lines.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  setCopy('work-value', built.latest ? volumeLabel(built.latest.volumeKg) : '');
  renderSessionVolumeChart(el('work-plot'), built, { focus: state.focusSessionIds });
  setCopy('work-caption', workCaption(built));
}

/**
 * Every chart on the screen that carries a weight or measures its container.
 *
 * Both of those are true of the client wide chart as well as the per lift ones, so a unit toggle
 * and a resize have to reach both. The consistency grid is deliberately not in here: it holds a
 * scroll position, and redrawing it would throw away which month you had scrolled back to.
 */
function redraw() {
  drawWork();
  // The readout under the grid carries weights now, so it is in the unit switch's business in a
  // way the line it replaced deliberately was not. That is the cost of saying what was on the bar,
  // and it is paid here rather than by leaving a card reading kilograms under a screen set to
  // pounds. The grid itself is still not redrawn: it holds a scroll position and carries no
  // weights, so a unit toggle has nothing to say to it.
  drawReadout();
  if (state.data) render();
}

// ------------------------------------------------------------------ consistency
//
// Mounted once and never redrawn by render(). Everything below the grid is scoped to one lift and
// changes when you pick another one or flip the unit; the grid is client wide and changes when you
// train. Rebuilding it on a unit toggle would throw away which month you had scrolled back to.

/**
 * How far one month panel is from the next, in scroll units.
 *
 * A panel is `flex: 0 0 100%` with no gap between panels, so one step is exactly the scroller's
 * own content width. Nothing about a panel is measured here, and that is the point.
 *
 * Two earlier versions of this got it wrong in the same way, so it is worth naming the trap.
 * Panels carry `content-visibility: auto`, so the ones off screen have not laid out when the grid
 * first mounts: `getBoundingClientRect` on one returns a box that has not settled, and
 * `scrollWidth` across all of them has not settled either. Either reading leaves the remembered
 * month one panel ahead of the visible one, so the first tap of an arrow scrolls back to where it
 * already was and the carousel looks broken. The scroller's own box is laid out immediately and
 * cannot drift.
 */
function panelStep(scroller) {
  const style = getComputedStyle(scroller);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return Math.max(1, scroller.clientWidth - pad);
}

/**
 * Which month is in view right now, read off the scroller rather than remembered.
 *
 * There is deliberately no state field for this. Holding one meant two answers to the same
 * question, and they came apart the first time the remembered one was written before layout had
 * settled: the arrows then stepped from a month nobody was looking at, so the first tap scrolled
 * to where the view already was and did nothing visible. A swipe does not tell us anything either,
 * so there is nothing to keep in sync. The scroll position is the answer.
 */
function monthInView(scroller) {
  const count = scroller.querySelectorAll('.cal__month').length;
  const seen = Math.round(scroller.scrollLeft / panelStep(scroller));
  return Math.max(0, Math.min(count - 1, seen));
}

function showMonth(scroller, index) {
  const count = scroller.querySelectorAll('.cal__month').length;
  const clamped = Math.max(0, Math.min(count - 1, index));

  // scrollTo rather than scrollIntoView, which also scrolls the page vertically and would drag the
  // charts up under the grid.
  //
  // The jump is instant, and that is a decision rather than a shortcut. A smooth behavior here is
  // silently a no-op wherever the platform has smooth scrolling turned off, and the arrow then
  // does nothing at all, which is a far worse failure than arriving without a glide. It also means
  // there is no motion to suppress under prefers-reduced-motion. The tactile part of this control
  // is the swipe, which keeps native momentum and snapping either way.
  scroller.scrollTo({ left: clamped * panelStep(scroller), behavior: 'auto' });
}

/**
 * Every session in which some lift beat everything before it.
 *
 * Runs buildProgression once per lift rather than deciding here what a record is, because
 * js/progression.js already decides that for the charts, and a day ringed on the grid that is not
 * ringed on the line two screens down is the app disagreeing with itself about the one moment this
 * product exists to deliver.
 *
 * The rows are partitioned by exercise first and each lift is handed only its own. Passing the
 * whole array to every call would be quadratic in a quiet way: activeSetLogs builds a Set over
 * everything it is given, so ten lifts would mean ten passes over every set the client has logged.
 */
function recordSessions(sessions, logs) {
  const byExercise = new Map();
  for (const row of logs) {
    if (!byExercise.has(row.exercise_id)) byExercise.set(row.exercise_id, []);
    byExercise.get(row.exercise_id).push(row);
  }

  const assignments = [...state.assignments.values()];
  const records = new Set();
  for (const [exerciseId, rows] of byExercise) {
    const progression = buildProgression({ setLogs: rows, sessions, assignments, exerciseId });
    for (const point of progression.points) {
      if (point.isRecord) records.add(point.sessionId);
    }
  }
  return records;
}

/**
 * Put the grid on its opening month, without animating there.
 *
 * Retries across frames rather than setting scrollLeft once, because the panels carry
 * content-visibility and the scroller is not yet scrollable in the task that filled it: assigning
 * scrollLeft before scrollWidth exceeds clientWidth silently clamps to zero, and the client opens
 * on the wrong month with no error anywhere. Bounded, and it stops the moment the assignment
 * sticks, so a client with one month never spins.
 */
function openOn(scroller, index) {
  let tries = 0;
  const place = () => {
    scroller.scrollLeft = index * panelStep(scroller);
    if (monthInView(scroller) !== index && tries < 10) {
      tries += 1;
      requestAnimationFrame(place);
    }
  };
  place();
}

/**
 * What one day held, set by set, composed when it is tapped rather than for all 42 cells up front.
 *
 * The rows come from `logsBySession`, which is already filtered through activeSetLogs, so a
 * correction shows the corrected numbers and a retracted set is not here at all. They are grouped
 * into lifts by walking them in log order rather than by bucketing on exercise id: a client who
 * came back to a lift later in the session did that lift twice, and one block claiming eight sets
 * would be the same lie the workout panel's liftRuns exists to avoid.
 */
function readoutFor(day) {
  const sessions = (state.sessionsByDay.get(day) ?? [])
    .slice()
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    .map((session) => {
      const rows = (state.logsBySession.get(session.id) ?? [])
        .slice()
        .sort((a, b) => String(a.logged_at).localeCompare(String(b.logged_at)));

      const lifts = [];
      for (const row of rows) {
        const name = state.exercises.get(row.exercise_id)?.name;
        if (!name) continue;
        const open = lifts[lifts.length - 1];
        if (open && open.exerciseId === row.exercise_id) open.sets.push(row);
        else lifts.push({ exerciseId: row.exercise_id, name, sets: [row] });
      }

      return {
        label: sessionLabel(state.assignments.get(session.assignment_id), session.day_index),
        time: session.started_at
          ? new Date(session.started_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
          : '',
        note: session.client_note ?? '',
        isOpen: !session.completed_at,
        lifts,
      };
    });

  return renderSessionReadout(
    { day, dayLabel: longDay(day), sessions },
    // The one formatter, per CLAUDE.md. Nothing in the readout module knows what a kilogram is.
    { weight: weightLabel },
  );
}

/**
 * The readout under the grid, for whichever day is focused.
 *
 * Nothing when no day is focused, which is what leaves the reserved well empty rather than sunken
 * and waiting. Redrawn on a unit toggle, because it carries weights.
 */
function drawReadout() {
  const node = el('cal-detail');
  if (!node) return;
  node.innerHTML = state.focusDay ? readoutFor(state.focusDay) : '';
}

/**
 * Focus a day, or clear it.
 *
 * One call site for the whole thing, because focusing a day touches four separate parts of this
 * screen and doing it in the click handler meant four chances to forget one. It marks the sessions
 * on every chart, narrows the lift picker to the lifts that day held, opens the readout, and moves
 * the selection when the lift currently on screen is not one of them: leaving somebody on a squat
 * chart after they tapped a pull day is answering a question they did not ask.
 */
async function showDay(day) {
  const sessions = day ? (state.sessionsByDay.get(day) ?? []) : [];
  state.focusDay = sessions.length ? day : null;
  state.focusSessionIds = sessions.length ? new Set(sessions.map((session) => session.id)) : null;
  // A narrowed list is a different list, so anything typed against the old one is stale.
  state.pickerQuery = '';

  drawReadout();

  const offered = pickerLifts();
  if (offered.length && !offered.some((lift) => lift.id === state.exerciseId)) {
    // selectExercise redraws the picker and the charts, so there is nothing to do after it.
    await selectExercise(offered[0].id);
    return;
  }
  drawPicker();
  if (state.data) render();
}

function mountConsistency(sessions, logs) {
  // Warmups count here, unlike everywhere in progression.js. The question this grid answers is
  // whether somebody trained, and a session that was all warmup and one working set is still a
  // session they drove to. What does not count is a session holding no live rows at all.
  const live = activeSetLogs(logs);
  const sessionIds = new Set(sessions.map((s) => s.id));
  const withWork = new Set();
  state.logsBySession = new Map();
  for (const row of live) {
    if (!sessionIds.has(row.session_id)) continue;
    withWork.add(row.session_id);
    if (!state.logsBySession.has(row.session_id)) state.logsBySession.set(row.session_id, []);
    state.logsBySession.get(row.session_id).push(row);
  }

  for (const session of sessions) {
    if (!withWork.has(session.id)) continue;
    const day = localDayOf(session.started_at);
    if (!state.sessionsByDay.has(day)) state.sessionsByDay.set(day, []);
    state.sessionsByDay.get(day).push(session);
  }

  state.consistency = buildConsistency({
    sessions,
    assignments: [...state.assignments.values()],
    sessionIdsWithWork: withWork,
    recordSessionIds: recordSessions(sessions, logs),
    today: isoDate(new Date()),
  });

  const total = state.consistency.totalSessions;
  el('consistency-total').textContent = total ? `${total} session${total === 1 ? '' : 's'}` : '';
  el('consistency-body').innerHTML = renderConsistency(state.consistency);
  el('cal-nav').innerHTML = renderMonthNav(state.consistency);

  const scroller = el('cal-scroller');
  if (!scroller) return;

  openOn(scroller, state.consistency.openAt);

  // The arrows sit in the card's header now, so they are outside the body this listener covers.
  el('cal-nav').addEventListener('click', (event) => {
    const step = event.target.closest('[data-step]');
    if (step) showMonth(scroller, monthInView(scroller) + Number(step.dataset.step));
  });

  el('consistency-body').addEventListener('click', (event) => {
    const cell = event.target.closest('[data-day]');
    if (!cell) return;
    const chosen = cell.getAttribute('aria-pressed') === 'true';
    for (const other of scroller.querySelectorAll('[aria-pressed]')) other.removeAttribute('aria-pressed');
    // Tapping the open day closes it, so the screen is never stuck focused on a day you left.
    if (chosen) {
      showDay(null);
      return;
    }
    cell.setAttribute('aria-pressed', 'true');
    showDay(cell.dataset.day);
  });
}

// ------------------------------------------------------------------ the lift picker
//
// One listener on the container, because the control redraws itself whole and a listener bound to
// a button inside it would go with the button.

function mountLiftPicker() {
  const host = el('lift-picker');

  host.addEventListener('click', (event) => {
    if (event.target.closest('[data-clear-scope]')) {
      // The way out of a narrowed list. It clears the day on the grid as well, since a ringed
      // session on the charts and a full list under it would be two answers to one question.
      for (const cell of document.querySelectorAll('.cal__day[aria-pressed]')) {
        cell.removeAttribute('aria-pressed');
      }
      showDay(null);
      return;
    }
    const row = event.target.closest('[data-exercise]');
    if (row) {
      // Closed on choosing. A list that stays open after a pick is a list you have to dismiss to
      // see what you picked.
      state.pickerOpen = false;
      state.pickerQuery = '';
      selectExercise(row.dataset.exercise);
      return;
    }
    if (event.target.closest('#liftpick-open')) setPickerOpen(!state.pickerOpen);
  });

  // The rows are rebuilt on every keystroke, so the caret has to be put back where it was. Reading
  // it off the field and restoring it beats re-rendering only the list, which would be a second
  // copy of what the control looks like living here rather than in js/lift-picker.js.
  host.addEventListener('input', (event) => {
    const field = event.target.closest('#liftpick-search');
    if (!field) return;
    const at = field.selectionStart;
    state.pickerQuery = field.value;
    drawPicker();
    const redrawn = el('liftpick-search');
    if (!redrawn) return;
    redrawn.focus();
    try {
      redrawn.setSelectionRange(at, at);
    } catch {
      // Some browsers refuse a selection range on type=search. The text is right either way, and
      // the caret lands at the end, which is where somebody typing forwards wants it anyway.
    }
  });

  // Escape closes it. A keyboard affordance rather than a modal one: there is no focus trap here
  // and nothing to escape FROM, but a panel that has taken the caret needs a way back out that is
  // not a mouse.
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.pickerOpen) return;
    setPickerOpen(false);
    const open = el('liftpick-open');
    if (open) open.focus();
  });
}

// ------------------------------------------------------------------ session history
//
// The LIST is shown to whoever can already see the charts above it. The CONTROL in it is shown to
// the client alone: 0011 gives the update policy to them, so a Discard button on a trainer's
// screen would be a button that could only ever fail. The one person who can throw away the record
// of a workout is the person who did it.
//
// The list used to be client-only as well, on the reasoning that it existed to house that control.
// That stopped being true the moment a session could carry a note: how a set felt is the half of a
// workout a chart cannot draw, and a coach who cannot read it is being handed the numbers and told
// the client said something about them. Nothing here is new to a trainer, who already reads every
// session on this page as a cell, a point and a line.

const SAID_KEY = 'ptc.history.said';

function drawHistory() {
  el('history-body').innerHTML = renderHistory(state.history, {
    armedId: state.armed,
    discard: state.isSelf,
  });
}

/**
 * Throws a session away, then reloads the screen.
 *
 * A reload rather than a redraw, deliberately, and it is the one place in this app that reaches
 * for one. Discarding a session can empty a lift out of the picker entirely, change which month
 * the calendar should open on, move a personal record, and change every chart on the page. This
 * screen derives all of that once on load, into four maps that render() does not rebuild, so a
 * partial redraw here would be a second, quieter copy of main() that has to be kept in step with
 * it forever. The action is rare and deliberate and the person has already tapped twice.
 *
 * The acknowledgement has to outlive the reload, so it goes through sessionStorage. Saying
 * nothing would be worse than the reload itself: a page that blinks and comes back with one row
 * missing does not tell somebody their sets were retracted rather than deleted.
 */
async function discard(entry) {
  const session = state.sessionsById.get(entry.id);
  if (!session) return;

  let setsTaken;
  try {
    setsTaken = await discardSession(state.storage, session);
  } catch (error) {
    // Said, and the row put back the way it was. A button left reading "Discarding" forever is
    // the worst outcome available here: the session is still there, so the person will try again,
    // and they have no way to know whether the first attempt half happened. Retractions are
    // written one at a time and each is idempotent by id, so trying again is safe.
    state.armed = null;
    drawHistory();
    el('history-said').textContent = `That session is still here. ${error.message}`;
    return;
  }

  try {
    sessionStorage.setItem(SAID_KEY, discardedMessage(entry, setsTaken));
  } catch {
    // Private mode with storage denied. The discard still happened, which is the part that
    // matters, and the row being gone is its own acknowledgement.
  }
  location.reload();
}

function mountHistory(sessions, logs) {
  state.sessionsById = new Map(sessions.map((session) => [session.id, session]));
  state.history = summarise(sessions, logs, (session) =>
    sessionLabel(state.assignments.get(session.assignment_id), session.day_index),
  );

  el('history').hidden = false;
  drawHistory();

  try {
    const said = sessionStorage.getItem(SAID_KEY);
    if (said) {
      el('history-said').textContent = said;
      sessionStorage.removeItem(SAID_KEY);
    }
  } catch {
    // Nothing to say, which is the same as having nothing to say.
  }

  el('history-body').addEventListener('click', (event) => {
    // Belt and braces. Nothing carrying data-act is drawn for a trainer, so this is unreachable
    // today, and it is one line of insurance against a future redraw that forgets to pass the flag.
    if (!state.isSelf) return;
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const row = button.closest('[data-session]');
    if (!row) return;
    const entry = state.history.find((item) => item.id === row.dataset.session);
    if (!entry) return;

    if (button.dataset.act === 'arm') {
      // One at a time. Two armed rows is two ways to tap the wrong one.
      state.armed = entry.id;
      drawHistory();
      return;
    }
    if (button.dataset.act === 'keep') {
      state.armed = null;
      drawHistory();
      return;
    }
    button.disabled = true;
    button.textContent = 'Discarding';
    discard(entry);
  });
}

async function selectExercise(exerciseId) {
  state.exerciseId = exerciseId;
  const sessions = await loadSessions(state.storage, state.client.id);
  const assignments = await state.storage.query('assignments', { client_id: state.client.id });
  const setLogs = await state.storage.query('set_logs', { exercise_id: exerciseId });
  state.data = buildProgression({ setLogs, sessions, assignments, exerciseId });
  drawPicker();
  render();
}

async function main() {
  // No role here on purpose. A client reads their own progress and a trainer opens the same
  // page with ?client=, so this is the one screen both roles legitimately land on.
  const booted = await boot();
  if (!gate(booted)) return;

  const { storage, actor } = booted;
  state.storage = storage;
  mountShell(booted, 'progress');

  // The VIEWER's unit, not the viewed client's. This screen renders somebody else's data whenever
  // a trainer opens it with ?client=, and reading that client's preference here would have let a
  // trainer's tap change the app on a phone in another building.
  await loadUnit(storage, actor);
  el('account-name').textContent = viewerName();

  // A trainer opens this with ?client=. A client only ever gets their own, and asking for
  // somebody else's id returns nothing, because the local mirror only holds what RLS let
  // through in the first place.
  const clientId = new URLSearchParams(location.search).get('client') || actor?.clientId;
  state.client = clientId ? await storage.get('clients', clientId) : null;
  state.isSelf = Boolean(state.client) && state.client.id === actor?.clientId;
  if (!state.client) {
    el('exercise-name').textContent = 'No client selected';
    el('headline').textContent =
      booted.error || 'Switch to a client with the dev role control.';
    return;
  }

  // An open session means the client walked away from a set. Offer the way back.
  //
  // Through js/session.js rather than a query of its own, because the logging screen picks a
  // session back up using the same rule. Offering to resume something that screen would decline
  // to resume is the app disagreeing with itself, and it is worse than not offering: the link
  // would land somebody on the next day of the split with no explanation.
  //
  // A trainer reading a client with ?client= never sees it. The link goes to their own logging
  // screen, so it would be an invitation to walk into somebody else's set.
  const open =
    state.client.id === actor?.clientId
      ? openSession(await loadSessions(storage, state.client.id))
      : null;
  if (open) {
    const resume = el('resume');
    resume.hidden = false;
    resume.textContent = 'Back to your set';
  }
  // Only when somebody else is reading. A client does not need their own name on their own
  // screen, but a trainer three clients deep very much needs to know whose numbers these are.
  if (state.client.id !== actor?.clientId) {
    const who = el('client-name');
    who.textContent = state.client.display_name;
    who.hidden = false;
  }

  mountUnitSetting(el('unit-setting'));
  onUnitChange(redraw);

  const exercises = await storage.query('exercises', {});
  for (const ex of exercises) state.exercises.set(ex.id, ex);

  // Only lifts this client has actually done. An empty picker entry is a dead end.
  const sessions = await loadSessions(storage, state.client.id);
  const logs = await storage.query('set_logs', {});

  // Before the lift picker's early return, deliberately. A brand new client and a client whose
  // only rows are warmups both fall out below, and they are exactly who this grid is for: it is
  // the only thing on this screen that can say anything at all before there are two sessions of
  // one lift to compare.
  const assignments = await storage.query('assignments', { client_id: state.client.id });
  state.assignments = new Map(assignments.map((a) => [a.id, a]));
  mountConsistency(sessions, logs);

  // Same rows, same place in the load, for the same reason as the grid: a client whose only lift so
  // far is one they have done twice has nothing for the picker below and something for this.
  state.work = buildSessionVolume({ sessions, setLogs: logs, assignments });
  drawWork();

  // After the assignments map, which the labels are resolved from, and before the lift picker's
  // early return: a client whose only rows are warmups still has sessions worth listing, and is
  // exactly the person most likely to want to throw one away.
  mountHistory(sessions, logs);

  // Through liftSummaries rather than counted here, so the count under each name is sessions of
  // live work rather than rows: a lift corrected three times in one session used to read as three.
  state.liftList = liftSummaries({ exercises: state.exercises, sessions, setLogs: logs });
  // Grouped by the day of the program the client is on now. The current assignment and never the
  // union of every one they have had: an old block names days that no longer exist.
  state.liftSnapshot = (await currentAssignment(storage, state.client.id))?.snapshot ?? null;

  mountLiftPicker();

  if (!state.liftList.length) {
    el('exercise-name').textContent = 'Nothing logged yet';
    el('headline').textContent = 'Log a session and this fills in.';
    return;
  }

  await selectExercise(state.liftList[0].id);

  // Charts measure their container, so a resize needs a redraw rather than a stretch.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 150);
  });
}

main();
