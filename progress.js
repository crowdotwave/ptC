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
import { renderConsistency, renderDetail, sessionLabel } from './js/consistency-view.js';
import { activeSetLogs } from './js/history.js';
import { openSession } from './js/session.js';
import { isoDate, localDayOf } from './js/dates.js';
import {
  unit,
  toDisplay,
  weightLabel,
  loadUnit,
  mountUnitSwitch,
  onUnitChange,
  viewerName,
} from './js/units.js';
import {
  renderE1rmChart,
  renderVolumeChart,
  renderRepsAtLoadChart,
  renderRepsChart,
  renderHoldChart,
} from './js/charts.js';

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
  assignments: new Map(),
  sessionsByDay: new Map(),
  logsBySession: new Map(),
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

function renderLiftPicker(items) {
  el('lift-picker').innerHTML = items
    .map(
      (ex) =>
        `<button type="button" class="button-secondary lifts__item${
          ex.id === state.exerciseId ? ' is-on' : ''
        }" data-exercise="${ex.id}"${ex.id === state.exerciseId ? ' aria-current="true"' : ''}>${ex.name}</button>`,
    )
    .join('');
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
  lead.render(el('lead-plot'), data);
  const extraTotal = data.points.reduce((t, p) => t + p.extra, 0);
  setCopy(
    'lead-caption',
    captionFor(lead.key ?? data.leadView, data) +
      (loaded && extraTotal > 0 ? ` Plus ${volumeLabel(extraTotal)} you added beyond the plan.` : ''),
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
  renderE1rmChart(el('second-plot'), data);
  setCopy('second-caption', captionFor('e1rm', data));

  // Reps at load. Always visible for a loaded lift, because for an intermediate this is the only
  // place a block of real progress shows up at all. Hidden without load, where every value would
  // be one line labelled 0 kg repeating what the lead chart already said.
  renderRepsAtLoadChart(el('reps-plot'), data);
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

/** What one day held, composed when it is tapped rather than for all 42 cells up front. */
function detailFor(day) {
  const sessions = (state.sessionsByDay.get(day) ?? []).map((session) => {
    const rows = state.logsBySession.get(session.id) ?? [];
    const names = [];
    for (const row of rows) {
      const name = state.exercises.get(row.exercise_id)?.name;
      if (name && !names.includes(name)) names.push(name);
    }
    return {
      label: sessionLabel(state.assignments.get(session.assignment_id), session.day_index),
      lifts: names,
      setCount: rows.length,
    };
  });
  return renderDetail({ day, sessions });
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

  const scroller = el('cal-scroller');
  if (!scroller) return;

  openOn(scroller, state.consistency.openAt);

  el('consistency-body').addEventListener('click', (event) => {
    const step = event.target.closest('[data-step]');
    if (step) {
      showMonth(scroller, monthInView(scroller) + Number(step.dataset.step));
      return;
    }
    const cell = event.target.closest('[data-day]');
    if (cell) {
      const chosen = cell.getAttribute('aria-pressed') === 'true';
      for (const other of scroller.querySelectorAll('[aria-pressed]')) other.removeAttribute('aria-pressed');
      // Tapping the open day closes it, so the line is never stuck open on a day you left.
      if (chosen) {
        el('cal-detail').innerHTML = '';
        return;
      }
      cell.setAttribute('aria-pressed', 'true');
      el('cal-detail').innerHTML = detailFor(cell.dataset.day);
    }
  });

}

async function selectExercise(exerciseId) {
  state.exerciseId = exerciseId;
  const sessions = await state.storage.query('sessions', { client_id: state.client.id }, { orderBy: 'started_at' });
  const assignments = await state.storage.query('assignments', { client_id: state.client.id });
  const setLogs = await state.storage.query('set_logs', { exercise_id: exerciseId });
  state.data = buildProgression({ setLogs, sessions, assignments, exerciseId });
  renderLiftPicker(state.liftList);
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
      ? openSession(await storage.query('sessions', { client_id: state.client.id }))
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

  mountUnitSwitch(el('unit-switch'));
  onUnitChange(() => {
    if (state.data) render();
  });

  const exercises = await storage.query('exercises', {});
  for (const ex of exercises) state.exercises.set(ex.id, ex);

  // Only lifts this client has actually done. An empty picker entry is a dead end.
  const sessions = await storage.query('sessions', { client_id: state.client.id });
  const sessionIds = new Set(sessions.map((s) => s.id));
  const logs = await storage.query('set_logs', {});
  const done = new Map();
  for (const row of logs) {
    if (!sessionIds.has(row.session_id) || row.is_warmup) continue;
    done.set(row.exercise_id, (done.get(row.exercise_id) ?? 0) + 1);
  }

  // Before the lift picker's early return, deliberately. A brand new client and a client whose
  // only rows are warmups both fall out below, and they are exactly who this grid is for: it is
  // the only thing on this screen that can say anything at all before there are two sessions of
  // one lift to compare.
  const assignments = await storage.query('assignments', { client_id: state.client.id });
  state.assignments = new Map(assignments.map((a) => [a.id, a]));
  mountConsistency(sessions, logs);

  state.liftList = [...done.keys()]
    .map((id) => state.exercises.get(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  el('lift-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-exercise]');
    if (button) selectExercise(button.dataset.exercise);
  });

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
    resizeTimer = setTimeout(render, 150);
  });
}

main();
