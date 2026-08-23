// The trainer view. Read only for now: a client list and per client progression, using the
// same charts the client sees rather than a parallel implementation of them.
//
// The one thing a trainer can write here is a deload marking, which exists because no policy
// and no inference can supply it. See suggestDeloadWeeks in js/progression.js for why the
// suggestion is shown here and nowhere else.

import { makeRecord } from './js/storage.js';
import { boot, gate } from './js/boot.js';
import { mountShell } from './js/nav.js';
import { buildProgression, suggestDeloadWeeks } from './js/progression.js';
import { renderE1rmChart, renderVolumeChart, renderRepsAtLoadChart } from './js/charts.js';
import { loadSessions } from './js/session.js';
import { currentAssignment } from './js/snapshot.js';
import { renderLiftPicker, groupLifts, liftSummaries } from './js/lift-picker.js';
import { unit, toDisplay, weightLabel, loadUnit, mountUnitSetting, onUnitChange } from './js/units.js';

const el = (id) => document.getElementById(id);
const state = {
  storage: null, trainer: null, clients: [], exercises: new Map(), client: null, data: null,
  // The client row the form is editing, or null when it is adding one.
  editing: null,
  // Which client is currently being asked about before deletion. Held here rather than in the
  // DOM, the way the program list holds the same question, so a re-render does not lose it.
  confirmDelete: null,
  // Display names for every trainer this account can see, which for staff is all of them. A row
  // that is somebody else's client says whose it is, because staff can now edit it.
  trainers: new Map(),
  // The lift picker, the same control the progress screen carries and from the same module. A
  // coach reading a client with forty lifts of history had the worst version of the scrolling row
  // this replaced, since they arrive knowing which lift they came to look at.
  lifts: [],
  liftSnapshot: null,
  pickerOpen: false,
  pickerQuery: '',
};

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
    // Archived last, whatever they were doing before they left. Everything above this line is
    // about who is training now, and somebody who has been put away is not.
    const archived = (c) => (c.status === 'archived' ? 1 : 0);
    if (archived(a) !== archived(b)) return archived(a) - archived(b);
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

      // Whose client this is, but only when it is not yours. On a trainer's own list every row
      // would carry their own name, which is a column of the same word.
      const owner = c.trainer_id === state.trainer?.id ? null : state.trainers.get(c.trainer_id);
      const standing = [
        c.status === 'archived' ? 'Archived' : null,
        // 'invited' is the one signal saying this person has not opened the app yet, which 0010
        // exists to protect. It belongs on the row rather than only in the database.
        c.status === 'invited' ? 'Not signed in yet' : null,
        owner ? `${owner}'s client` : null,
      ]
        .filter(Boolean)
        .join('. ');

      return (
        `<li class="clientlist__row"><button type="button" class="clientlist__button" data-client="${c.id}">` +
        // Everything inside a wrapper, because a button is not sized by its own flex or grid
        // children: they sit in an anonymous box the button's height ignores. See .row-card in
        // styles.css for where that was measured.
        `<span class="clientlist__inner">` +
        `<span class="clientlist__name">${esc(c.display_name)}</span>` +
        (standing ? `<span class="clientlist__facts num">${esc(standing)}</span>` : '') +
        `<span class="clientlist__facts num">${esc(last)}</span>` +
        `<span class="clientlist__facts num">${c.sessionCount} session${c.sessionCount === 1 ? '' : 's'}, ` +
        `${c.recentCount} in the last 4 weeks</span>` +
        `<span class="clientlist__facts num">${c.blockCount} block${c.blockCount === 1 ? '' : 's'}</span>` +
        `</span>` +
        // The shape that says a row opens something, same as the workout panel's.
        `<svg class="clientlist__go" viewBox="0 0 20 20" aria-hidden="true" fill="none" ` +
        `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M7.5 4l6 6-6 6" /></svg>` +
        `</button>` +
        `<div class="archived__actions">` +
        `<button type="button" class="button-secondary" data-edit="${c.id}">Edit</button>` +
        `</div></li>`
      );
    })
    .join('');
}

// ------------------------------------------------------------------ adding and fixing a client

/**
 * The one screen that writes a clients row.
 *
 * Until this existed every row in that table was inserted by hand, which is a thing to remember
 * before adding a field here: a trainer who cannot use this screen has no other way in. The email
 * is why it matters most. It is the key ptc.handle_new_auth_user matches a new sign in against,
 * so a client with the wrong one cannot get into the app at all, and correcting it was until now
 * a database job.
 */
function showClientForm(client) {
  state.editing = client ?? null;
  state.confirmDelete = null;

  el('list-view').hidden = true;
  el('detail-view').hidden = true;
  el('client-form-view').hidden = false;
  el('client-form-error').hidden = true;

  el('view-title').textContent = client ? client.display_name : 'Add a client';
  el('view-note').textContent = client ? 'Editing this client.' : 'Somebody new.';
  el('client-name').value = client?.display_name ?? '';
  el('client-email').value = client?.email ?? '';

  // No invitation is sent from here, by this app or by anything else, so the copy must not imply
  // one. What creating this row does is let a sign in match, and the person still has to go to
  // the app and ask for a code themselves.
  el('client-form-legend').textContent =
    'Nothing is emailed from here. This row is what a sign in matches against, so the address has ' +
    'to be the one they will actually use, and they sign in themselves whenever they are ready.';

  renderDangerZone();
}

/**
 * Archive always, delete only when nothing points at the row.
 *
 * assignments.client_id and sessions.client_id are both on delete cascade, so deleting somebody
 * who has trained takes their assignments and sessions with them without saying so, and would be
 * refused outright the moment a set is involved because set_logs.session_id is on delete
 * restrict. A button that produces a foreign key error is worse than no button, which is the same
 * conclusion the program list reached about deleting a template somebody is on. The row says why
 * instead, and archive is the operation that always works.
 */
function renderDangerZone() {
  const client = state.editing;
  const zone = el('client-danger');
  const note = el('client-danger-note');

  if (!client) {
    zone.hidden = true;
    note.textContent = '';
    return;
  }

  zone.hidden = false;
  const archived = client.status === 'archived';
  const hasHistory = client.sessionCount > 0 || client.blockCount > 0;

  if (state.confirmDelete === client.id) {
    zone.innerHTML =
      `<span class="clientlist__facts">Delete ${esc(client.display_name)} for good?</span>` +
      `<button type="button" class="button-secondary" id="client-delete-yes">Delete</button>` +
      `<button type="button" class="button-secondary" id="client-delete-no">Cancel</button>`;
    note.textContent = 'This cannot be undone. Nothing of theirs is kept.';
    return;
  }

  zone.innerHTML =
    `<button type="button" class="button-secondary" id="client-archive">` +
    `${archived ? 'Restore client' : 'Archive client'}</button>` +
    (hasHistory ? '' : `<button type="button" class="button-secondary" id="client-delete">Delete</button>`);

  note.textContent = archived
    ? 'Archived. They keep everything they logged, and restoring puts them back in the list.'
    : hasHistory
      ? `Archiving keeps everything they logged and takes them off the list. There is no delete ` +
        `because they have ${client.sessionCount} session${client.sessionCount === 1 ? '' : 's'} ` +
        `and ${client.blockCount} block${client.blockCount === 1 ? '' : 's'} on record.`
      : 'Nothing is on record for them yet, so this one can be deleted outright.';
}

function formError(message) {
  const node = el('client-form-error');
  node.hidden = !message;
  node.textContent = message ?? '';
  return !message;
}

/**
 * Checked here rather than left to the database, because a write lands locally first and syncs
 * later. A duplicate address is refused by the unique index on lower(email) minutes after the
 * person who typed it has moved on, and the failure would surface as a stalled outbox rather than
 * as an answer about the form they were filling in.
 *
 * The check can only see rows this account can read, which for a trainer is their own clients. A
 * collision with another trainer's client still fails at the database. That is the narrower case
 * and it is the one nobody can do anything about from here anyway.
 */
function validate(name, email) {
  if (!name) return formError('A name, so you can tell them apart on the list.');
  if (!email) return formError('An email. It is what their sign in matches against.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return formError(`"${email}" is not an email address.`);

  const clash = state.clients.find(
    (c) => c.id !== state.editing?.id && c.email.toLowerCase() === email.toLowerCase(),
  );
  if (clash) return formError(`${clash.display_name} already has that address, and it can only bind one person.`);
  return formError('');
}

async function saveClient() {
  const name = el('client-name').value.trim();
  const email = el('client-email').value.trim();
  if (!validate(name, email)) return;

  const button = el('client-save');
  button.disabled = true;
  try {
    if (state.editing) {
      // Spread from the stored row, never from the list copy, which carries the session and block
      // counts this screen computed and which are not columns.
      const stored = await state.storage.get('clients', state.editing.id);
      if (!stored) throw new Error('That client is no longer here.');
      await state.storage.put('clients', {
        ...stored,
        display_name: name,
        email,
        updated_at: new Date().toISOString(),
      });
    } else {
      await state.storage.put(
        'clients',
        makeRecord('clients', {
          trainer_id: state.trainer.id,
          // Never set here. The database owns it, on an email match with a new auth user, which
          // is what stops a row being bound to somebody by hand.
          auth_user_id: null,
          display_name: name,
          email,
          // Not 'active'. That word means somebody has actually arrived, per 0010, and typing
          // their address is not arriving.
          status: 'invited',
          // Whatever the person filling this form is reading, because a coach working in pounds
          // coaches people in pounds, in a gym whose plates are in pounds. Hardcoding kg meant
          // every client a trainer ever adds opens in the wrong unit and has to find the toggle
          // before their first set, or logs in one unit while reading another.
          //
          // unit() rather than state.trainer.weight_unit, and the difference is not academic. A
          // trainer who is also a client, which is the shape this whole app is built around, has
          // their preference on their clients row: js/units.js resolves that row first and writes
          // only there, so the trainers row keeps whatever it was created with forever. Reading
          // it here would have inherited a default nobody has ever seen instead of the unit on
          // screen. Measured on this project: the one real trainer reads pounds and his trainers
          // row still says kg.
          //
          // A starting value, not a resolution, which is what keeps this clear of the rule that
          // weight_unit belongs to the viewer. Nothing here renders somebody else's number in
          // somebody else's unit. It seeds a new row with the likeliest answer, and that row is
          // the client's own the moment they open the app.
          weight_unit: unit() === 'lb' ? 'lb' : 'kg',
        }),
      );
    }
    await backToList();
  } catch (error) {
    formError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function setArchived(archived) {
  const stored = await state.storage.get('clients', state.editing.id);
  if (!stored) return;
  // Restoring puts back what the status meant before, and 0010 decides what that is: 'active'
  // means somebody has actually arrived, which is exactly what a bound auth_user_id records.
  // Restoring everybody to 'invited' would tell a trainer that a client who has been training
  // for months has never opened the app.
  const restored = stored.auth_user_id ? 'active' : 'invited';
  await state.storage.put('clients', {
    ...stored,
    status: archived ? 'archived' : restored,
    updated_at: new Date().toISOString(),
  });
  await backToList();
}

async function deleteClient() {
  try {
    await state.storage.delete('clients', state.editing.id);
    await backToList();
  } catch (error) {
    formError(error.message);
  }
}

async function backToList() {
  state.editing = null;
  state.confirmDelete = null;
  el('client-form-view').hidden = true;
  await loadClients();
  showList();
  renderList();
}

function renderDetail() {
  const data = state.data;
  const leadIsStrength = data.leadView === 'e1rm';

  const exercise = state.exercises.get(state.exerciseId);
  el('exercise-name').textContent = exercise ? exercise.name : '';

  el('lead-title').textContent = leadIsStrength ? 'Estimated 1RM' : 'Volume per session';
  el('second-title').textContent = leadIsStrength ? 'Volume per session' : 'Estimated 1RM';

  const leadChange = leadIsStrength ? data.e1rm.change : data.volume.change;
  const secondChange = leadIsStrength ? data.volume.change : data.e1rm.change;
  // The trainer's own unit, not this client's. A coach who thinks in kilograms reads every client
  // in kilograms, and none of them can tell.
  el('lead-value').textContent = leadChange ? weightLabel(leadChange.last) : '';
  el('second-value').textContent = secondChange ? weightLabel(secondChange.last) : '';

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
  // Volume is sets by reps by weight, so it carries the unit and scales with it.
  const volume = (v) => `${Math.round(toDisplay(v)).toLocaleString()} ${unit()}`;

  // The captions follow their chart rather than their slot, which is the whole of the fix here.
  // The two charts swap slots on `leadView`, and these two lines did not: the prescribed and added
  // split, which is the only thing on this screen that explains the two tone volume bar, was
  // printed under whichever chart was second. With volume leading, and it leads for every client
  // inside their first block, that put the legend for the volume bar under the estimated 1RM line
  // and left the volume card saying "1 session on this lift". The bar chart has no legend of its
  // own, so there was nothing on screen at all to say what the pale band on top of it meant.
  const countCaption = `${data.totalSessions} session${data.totalSessions === 1 ? '' : 's'} on this lift.`;
  const volumeCaption =
    `${volume(prescribed)} prescribed` +
    (extra > 0
      ? `, ${volume(extra)} added beyond the plan. The pale band on each bar is the added work.`
      : '. Nothing added beyond the plan.');
  el('lead-caption').textContent = leadIsStrength ? countCaption : volumeCaption;
  el('second-caption').textContent = leadIsStrength ? volumeCaption : countCaption;
  const lines = data.repsAtLoad.lines;
  el('reps-value').textContent = lines.length ? weightLabel(lines[lines.length - 1].loadKg) : '';
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

/**
 * The lift picker, redrawn whole. Same control and same module as the progress screen, so the two
 * cannot drift apart the way the chip rows they replaced once did.
 */
function drawPicker() {
  if (!state.lifts.length) {
    el('lift-picker').innerHTML = '';
    return;
  }
  el('lift-picker').innerHTML = renderLiftPicker({
    lifts: state.lifts,
    groups: groupLifts(state.lifts, state.liftSnapshot),
    selectedId: state.exerciseId,
    open: state.pickerOpen,
    query: state.pickerQuery,
  });
}

function setPickerOpen(open) {
  state.pickerOpen = open;
  if (!open) state.pickerQuery = '';
  drawPicker();
  if (!open) return;
  const search = el('liftpick-search');
  if (search) search.focus();
}

async function selectExercise(exerciseId) {
  state.exerciseId = exerciseId;
  const sessions = await loadSessions(state.storage, state.client.id);
  const assignments = await state.storage.query('assignments', { client_id: state.client.id });
  const setLogs = await state.storage.query('set_logs', { exercise_id: exerciseId });
  state.data = buildProgression({ setLogs, sessions, assignments, exerciseId });

  drawPicker();
  renderDetail();
}

async function openClient(clientId) {
  state.client = state.clients.find((c) => c.id === clientId);
  if (!state.client) return;

  el('view-title').textContent = state.client.display_name;
  el('view-note').textContent = 'Read only. Program editing is not built yet.';
  el('list-view').hidden = true;
  el('client-form-view').hidden = true;
  el('detail-view').hidden = false;
  // The session list, and with it anything the client said about how a session felt. Charts cannot
  // draw that half, and it is the half a coach reads before changing next week.
  el('see-sessions').href = `progress.html?client=${encodeURIComponent(state.client.id)}`;

  const sessions = await loadSessions(state.storage, clientId);
  const logs = await state.storage.query('set_logs', {});
  // One answer, shared with the progress screen, so the session counts under each name are the
  // same numbers on both.
  state.lifts = liftSummaries({ exercises: state.exercises, sessions, setLogs: logs });
  // Grouped by the day of the program this client is on now, which is how their coach thinks
  // about their lifts and what the day names on every other screen already say.
  state.liftSnapshot = (await currentAssignment(state.storage, clientId))?.snapshot ?? null;
  state.pickerOpen = false;
  state.pickerQuery = '';

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
  el('client-form-view').hidden = true;
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

  // The trainer's own preference, read from their own row, which is also the only row a tap here
  // will ever write. Nothing a trainer does on this screen reaches a client's phone.
  await loadUnit(storage, actor);
  mountUnitSetting(el('unit-setting'));
  onUnitChange(() => {
    if (state.data) renderDetail();
  });

  const exercises = await storage.query('exercises', {});
  for (const ex of exercises) state.exercises.set(ex.id, ex);

  // This trainer's clients, or everybody for the two accounts building the app. Either way this
  // is a client side filter over rows the database already decided to hand over, which is a shape
  // to look at rather than a guarantee. supabase/tests/rls_isolation.sql is what makes it true:
  // a staff read is an extra select policy, so a non staff trainer's query returns their own rows
  // whatever this line asks for.
  state.everyone = Boolean(actor?.isStaff);

  await loadClients();
  showList();
  renderList();
  wire();
}

/**
 * The client list, and the counts each row reports.
 *
 * Re-read after every write rather than patched in place, because the counts are derived from
 * two other tables and a patched row would drift from them the first time anything else changed.
 */
async function loadClients() {
  const storage = state.storage;

  // Trainers first, so a row belonging to somebody else can say whose it is. Staff read them all
  // through trainers_staff_select; anybody else gets their own and the map is never consulted.
  state.trainers = new Map(
    (await storage.query('trainers', {})).map((t) => [t.id, t.display_name]),
  );

  const clients = state.everyone
    ? await storage.query('clients', {}, { orderBy: 'display_name' })
    : await storage.query('clients', { trainer_id: state.trainer.id }, { orderBy: 'display_name' });
  const fourWeeksAgo = Date.now() - 28 * 86400000;

  state.clients = await Promise.all(
    clients.map(async (client) => {
      const sessions = await loadSessions(storage, client.id);
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
}

function wire() {
  el('client-list').addEventListener('click', (event) => {
    // Edit before open, because the edit control sits inside the row that opens the client.
    const edit = event.target.closest('[data-edit]');
    if (edit) return showClientForm(state.clients.find((c) => c.id === edit.dataset.edit));

    const open = event.target.closest('[data-client]');
    if (open) return openClient(open.dataset.client);
    return undefined;
  });
  // One listener on the container, because the control redraws itself whole and a listener bound
  // to a button inside it would go with the button.
  const picker = el('lift-picker');
  picker.addEventListener('click', (event) => {
    const row = event.target.closest('[data-exercise]');
    if (row) {
      state.pickerOpen = false;
      state.pickerQuery = '';
      selectExercise(row.dataset.exercise);
      return;
    }
    if (event.target.closest('#liftpick-open')) setPickerOpen(!state.pickerOpen);
  });

  picker.addEventListener('input', (event) => {
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
      // Some browsers refuse a selection range on type=search. The caret lands at the end, which
      // is where somebody typing forwards wants it anyway.
    }
  });

  picker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.pickerOpen) return;
    setPickerOpen(false);
    const open = el('liftpick-open');
    if (open) open.focus();
  });
  el('back-to-list').addEventListener('click', (event) => {
    event.preventDefault();
    showList();
  });

  el('new-client').addEventListener('click', () => showClientForm(null));
  el('client-form-back').addEventListener('click', (event) => {
    event.preventDefault();
    state.editing = null;
    showList();
  });
  el('client-save').addEventListener('click', saveClient);

  // One listener for the whole danger row, because its contents are replaced whenever the
  // question changes and a listener bound to a button inside it would go with the button.
  el('client-danger').addEventListener('click', (event) => {
    if (event.target.closest('#client-archive')) {
      return setArchived(state.editing.status !== 'archived');
    }
    if (event.target.closest('#client-delete')) {
      state.confirmDelete = state.editing.id;
      return renderDangerZone();
    }
    if (event.target.closest('#client-delete-no')) {
      state.confirmDelete = null;
      return renderDangerZone();
    }
    if (event.target.closest('#client-delete-yes')) return deleteClient();
    return undefined;
  });
}

main();
