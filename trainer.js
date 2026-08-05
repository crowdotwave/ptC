// The trainer view. Read only for now: a client list and per client progression, using the
// same charts the client sees rather than a parallel implementation of them.
//
// The one thing a trainer can write here is a deload marking, which exists because no policy
// and no inference can supply it. See suggestDeloadWeeks in js/progression.js for why the
// suggestion is shown here and nowhere else.

import { boot, gate } from './js/boot.js';
import { mountShell } from './js/nav.js';
import { buildProgression, suggestDeloadWeeks } from './js/progression.js';
import { renderE1rmChart, renderVolumeChart, renderRepsAtLoadChart } from './js/charts.js';
import { activeSetLogs } from './js/history.js';

const el = (id) => document.getElementById(id);
const state = { storage: null, trainer: null, clients: [], exercises: new Map(), client: null, data: null };

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function daysSince(iso) {
  return Math.floor((Date.now() - Date.parse(iso)) / 86400000);
}

/**
 * Facts only, and sorted by most recent activity.
 *
 * Not sorted by anything that looks like need. Days since a last session does not tell
 * struggling apart from travelling apart from a planned week off, and putting that guess in
 * the sort order makes a judgement that belongs to the trainer. The row carries the numbers.
 */
function renderList() {
  const rows = [...state.clients].sort((a, b) => {
    if (!a.lastSession) return 1;
    if (!b.lastSession) return -1;
    return b.lastSession.localeCompare(a.lastSession);
  });

  // A new coach's first screen. An empty list with a heading that says "0 clients" reads like
  // the app failed to load rather than like there is nobody here yet.
  if (!rows.length) {
    el('client-list').innerHTML =
      '<li class="clientlist__empty">Nobody here yet. Clients appear once they are added, ' +
      'and their training appears once they log a set.</li>';
    return;
  }

  el('client-list').innerHTML = rows
    .map((c) => {
      const last = c.lastSession
        ? `${dayLabel(c.lastSession)}, ${daysSince(c.lastSession)} day${daysSince(c.lastSession) === 1 ? '' : 's'} ago`
        : 'No sessions yet';
      return (
        `<li class="clientlist__row"><button type="button" class="clientlist__button" data-client="${c.id}">` +
        `<span class="clientlist__name">${esc(c.display_name)}</span>` +
        `<span class="clientlist__facts num">${esc(last)}</span>` +
        `<span class="clientlist__facts num">${c.sessionCount} session${c.sessionCount === 1 ? '' : 's'}, ` +
        `${c.recentCount} in the last 4 weeks</span>` +
        `<span class="clientlist__facts num">${c.blockCount} block${c.blockCount === 1 ? '' : 's'}</span>` +
        `</button></li>`
      );
    })
    .join('');
}

function renderDetail() {
  const data = state.data;
  const leadIsStrength = data.leadView === 'e1rm';

  el('lead-title').textContent = leadIsStrength ? 'Estimated 1RM' : 'Volume per session';
  el('second-title').textContent = leadIsStrength ? 'Volume per session' : 'Estimated 1RM';

  const leadChange = leadIsStrength ? data.e1rm.change : data.volume.change;
  const secondChange = leadIsStrength ? data.volume.change : data.e1rm.change;
  el('lead-value').textContent = leadChange ? `${Math.round(leadChange.last * 10) / 10} kg` : '';
  el('second-value').textContent = secondChange ? `${Math.round(secondChange.last * 10) / 10} kg` : '';

  if (leadIsStrength) {
    renderE1rmChart(el('lead-plot'), data);
    renderVolumeChart(el('second-plot'), data);
  } else {
    renderVolumeChart(el('lead-plot'), data);
    renderE1rmChart(el('second-plot'), data);
  }
  renderRepsAtLoadChart(el('reps-plot'), data);

  const extra = data.points.reduce((t, p) => t + p.extra, 0);
  const prescribed = data.points.reduce((t, p) => t + p.prescribed, 0);
  el('lead-caption').textContent = `${data.totalSessions} session${data.totalSessions === 1 ? '' : 's'} on this lift.`;
  el('second-caption').textContent =
    `${Math.round(prescribed).toLocaleString()} kg prescribed` +
    (extra > 0 ? `, ${Math.round(extra).toLocaleString()} kg added beyond the plan.` : '. Nothing added beyond the plan.');
  const lines = data.repsAtLoad.lines;
  el('reps-value').textContent = lines.length ? `${lines[lines.length - 1].loadKg} kg` : '';
  el('reps-caption').textContent = lines.length
    ? `Current block, ${lines.length} load${lines.length === 1 ? '' : 's'}.`
    : 'Nothing logged in this block yet.';

  renderDeloadSuggestion();
}

/**
 * Shown to the trainer only, and only ever as a question. The client never sees this and never
 * sees a label the trainer did not set.
 */
function renderDeloadSuggestion() {
  const node = el('deload-suggest');
  const suggestions = suggestDeloadWeeks(state.data);
  if (!suggestions.length) {
    node.hidden = true;
    return;
  }

  const first = suggestions[0];
  node.hidden = false;
  node.innerHTML =
    `<span>Week ${first.week + 1} of block ${first.blockIndex + 1} dropped ${first.dropPercent} percent ` +
    `on ${esc(dayLabel(first.day))}. Was that a planned deload?</span>` +
    `<button type="button" class="button-secondary" id="mark-deload" data-block="${esc(first.blockKey)}" ` +
    `data-week="${first.week}">Mark as planned deload</button>`;

  el('mark-deload').addEventListener('click', async () => {
    const assignment = await state.storage.get('assignments', first.blockKey);
    if (!assignment) return;
    const weeks = Array.isArray(assignment.deload_weeks) ? assignment.deload_weeks : [];
    if (!weeks.includes(first.week)) {
      await state.storage.put('assignments', {
        ...assignment,
        deload_weeks: [...weeks, first.week].sort((a, b) => a - b),
        updated_at: new Date().toISOString(),
      });
    }
    await selectExercise(state.exerciseId);
  });
}

async function selectExercise(exerciseId) {
  state.exerciseId = exerciseId;
  const sessions = await state.storage.query('sessions', { client_id: state.client.id }, { orderBy: 'started_at' });
  const assignments = await state.storage.query('assignments', { client_id: state.client.id });
  const setLogs = await state.storage.query('set_logs', { exercise_id: exerciseId });
  state.data = buildProgression({ setLogs, sessions, assignments, exerciseId });

  el('lift-picker').innerHTML = state.lifts
    .map(
      (ex) =>
        `<button type="button" class="button-secondary lifts__item${
          ex.id === exerciseId ? ' is-on' : ''
        }" data-exercise="${ex.id}">${esc(ex.name)}</button>`,
    )
    .join('');

  renderDetail();
}

async function openClient(clientId) {
  state.client = state.clients.find((c) => c.id === clientId);
  if (!state.client) return;

  el('view-title').textContent = state.client.display_name;
  el('view-note').textContent = 'Read only. Program editing is not built yet.';
  el('list-view').hidden = true;
  el('detail-view').hidden = false;

  const sessions = await state.storage.query('sessions', { client_id: clientId });
  const sessionIds = new Set(sessions.map((s) => s.id));
  const logs = await state.storage.query('set_logs', {});
  const done = new Set();
  for (const row of activeSetLogs(logs)) {
    if (sessionIds.has(row.session_id) && !row.is_warmup) done.add(row.exercise_id);
  }
  state.lifts = [...done]
    .map((id) => state.exercises.get(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!state.lifts.length) {
    el('detail-view').hidden = true;
    el('view-note').textContent = 'Nothing logged yet.';
    return;
  }
  await selectExercise(state.lifts[0].id);
}

function showList() {
  el('list-view').hidden = false;
  el('detail-view').hidden = true;
  el('view-title').textContent = 'Clients';
  el('view-note').textContent =
    `${state.clients.length} client${state.clients.length === 1 ? '' : 's'}, most recently active first.` +
    (state.everyone ? ' Everybody on the app, because this account is building it.' : '');
}

async function main() {
  const booted = await boot({ role: 'trainer' });
  if (!gate(booted)) return;

  const { storage, actor } = booted;
  state.storage = storage;
  mountShell(booted, 'clients');

  if (booted.mode === 'unbound') {
    el('trainer-name').textContent = 'Not set up yet';
    el('view-title').textContent = 'Nothing here yet';
    el('view-note').textContent = 'You are signed in, but this account is neither a trainer nor a client.';
    return;
  }

  const trainerId = actor?.trainerId ?? null;
  state.trainer = trainerId ? await storage.get('trainers', trainerId) : null;

  if (!state.trainer) {
    el('trainer-name').textContent = 'No trainer';
    el('view-note').textContent =
      booted.error || 'Switch to a trainer with the dev role control to see this view.';
    return;
  }
  el('trainer-name').textContent = state.trainer.display_name;

  const exercises = await storage.query('exercises', {});
  for (const ex of exercises) state.exercises.set(ex.id, ex);

  // This trainer's clients, or everybody for the two accounts building the app. Either way this
  // is a client side filter over rows the database already decided to hand over, which is a shape
  // to look at rather than a guarantee. supabase/tests/rls_isolation.sql is what makes it true:
  // a staff read is an extra select policy, so a non staff trainer's query returns their own rows
  // whatever this line asks for.
  state.everyone = Boolean(actor?.isStaff);
  const clients = actor?.isStaff
    ? await storage.query('clients', {}, { orderBy: 'display_name' })
    : await storage.query('clients', { trainer_id: state.trainer.id }, { orderBy: 'display_name' });
  const fourWeeksAgo = Date.now() - 28 * 86400000;

  state.clients = await Promise.all(
    clients.map(async (client) => {
      const sessions = await storage.query('sessions', { client_id: client.id }, { orderBy: 'started_at' });
      const assignments = await storage.query('assignments', { client_id: client.id });
      const last = sessions.length ? sessions[sessions.length - 1].started_at : null;
      return {
        ...client,
        lastSession: last,
        sessionCount: sessions.length,
        recentCount: sessions.filter((s) => Date.parse(s.started_at) >= fourWeeksAgo).length,
        blockCount: assignments.length,
      };
    }),
  );

  showList();
  renderList();

  el('client-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-client]');
    if (button) openClient(button.dataset.client);
  });
  el('lift-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-exercise]');
    if (button) selectExercise(button.dataset.exercise);
  });
  el('back-to-list').addEventListener('click', (event) => {
    event.preventDefault();
    showList();
  });
}

main();
