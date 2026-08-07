// The program builder. It is a table, because the trainer's actual tool is a table.
//
// The columns are theirs, in their order, with their vocabulary:
//   #   Exercise   Adjust   Sets   Reps   Load   Rest
//
// Nothing here reformats what they type. '50 FT' stays '50 FT', '1-2 RIR' stays '1-2 RIR'.
// js/program.js parses alongside the text to fill the numeric columns where it can, and leaves
// them null where it cannot, which is 16 rows out of 61 in their real workbook.
//
// Writes go through the adapter like everything else. They are awaited here rather than fired
// optimistically: this is somebody at a desk, not a thumb between sets, and knowing it saved is
// worth the wait.

import { makeRecord, newId } from './js/storage.js';
import { boot, gate } from './js/boot.js';
import { mountShell } from './js/nav.js';
import { parseReps, parseRest, parseLoad, parseSets, inferLogging, targetLine } from './js/program.js';
import { buildSnapshot, currentAssignment, pickDay, sortedDays, sortedItems } from './js/snapshot.js';
import { mountProgramView, repaintProgramView, WARMUP_KINDS, NO_PROGRAM_YET } from './js/program-view.js';
import { topSet } from './js/history.js';
import { weekIndexOf } from './js/progression.js';
import { loadUnit, mountUnitSwitch, onUnitChange, viewerName, canSetUnit } from './js/units.js';
import { readFile, renderDraft, setMode, createProgram } from './js/import-ui.js';

const el = (id) => document.getElementById(id);
const state = {
  storage: null, trainer: null, template: null, days: [], items: new Map(), exercises: [],
  // The parsed spreadsheet, held in memory only while the review screen is up. Nothing reaches
  // the database until Create is pressed.
  draft: null,
  // Which archived program is currently asking whether it should really go. Held here rather
  // than in the DOM so the list can re-render without losing the question.
  confirmDelete: null,
  // True when this person holds a clients row, so the page carries their own program above
  // whatever they build. Both halves are capabilities, never a role name.
  hasMine: false,
  // The frozen program the assign screen is handing out, and the clients it is offering it to,
  // each carrying whatever they are on right now.
  assignSnapshot: null,
  assignClients: [],
  // Which half of the screen is on: 'mine' or 'build'. Only ever a real choice for somebody who
  // holds both. Held here so that coming back from a program returns to the half you left.
  section: 'mine',
};

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ the two halves

const SECTIONS = [
  ['mine', 'Your program'],
  ['build', 'Programs you build'],
];

/** True only when this person holds both, which is the only time there is a choice to make. */
const hasBothSections = () => state.hasMine && Boolean(state.trainer);

/**
 * Shows one half and hides the other.
 *
 * These were stacked, with a heading on each. That put somebody's own training, a day chooser, a
 * whole day of exercises, and then a builder list on one scroll, which is the clutter this
 * splits up. A chooser is the same answer the logging screen already gives for days and the
 * progress screen gives for lifts, so it is a pattern that is already on this app rather than a
 * new one.
 *
 * The unit switch follows the choice, because it labels the weights under each lift and there
 * are no weights on the builder list. A control that changes nothing on the screen it is on is
 * exactly the clutter being removed.
 */
function renderSections() {
  const both = hasBothSections();
  const on = both ? state.section : state.hasMine ? 'mine' : 'build';

  el('mine-view').hidden = on !== 'mine';
  el('list-view').hidden = on !== 'build';

  const picker = el('section-picker');
  picker.hidden = !both;
  if (both) {
    picker.innerHTML = SECTIONS.map(
      ([key, label]) =>
        `<button type="button" class="button-secondary sections__item${key === on ? ' is-on' : ''}" ` +
        `data-section="${key}"${key === on ? ' aria-current="true"' : ''}>${label}</button>`,
    ).join('');
  }

  el('unit-switch').hidden = !(on === 'mine' && canSetUnit());
  return on;
}

// ------------------------------------------------------------------ program list

/**
 * A short date, from either a timestamp or a date column.
 *
 * The T00:00:00 is not decoration. A date column is 'YYYY-MM-DD', which Date parses as UTC
 * midnight, so a block starting on the 6th renders as the 5th everywhere west of Greenwich.
 * assignments.starts_on is a date and program_templates.archived_at is a timestamp, and this
 * prints both.
 */
const dayLabel = (value) => {
  const text = String(value);
  const iso = text.includes('T') ? text : `${text}T00:00:00`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const assignedLine = (n) => `${n} client${n === 1 ? '' : 's'} assigned`;

function nameButton(template, facts) {
  return (
    `<button type="button" class="clientlist__button" data-template="${template.id}">` +
    `<span class="clientlist__name">${esc(template.name)}</span>` +
    `<span class="clientlist__facts num">${esc(facts)}</span></button>`
  );
}

/**
 * An archived program, with the two things that can still happen to it.
 *
 * Restore always. Delete only when nothing points at it: assignments.template_id is on delete
 * restrict, so the database refuses to remove a program a client's history depends on, and a
 * button that produces an error is worse than no button. The row says why instead.
 *
 * Nothing here is recoloured. These rows already sit under a heading that says what they are,
 * which is a word and a position, and that is the encoding rule satisfied without spending a
 * hue on a state that is not urgent.
 */
function archivedRow(template, assigned) {
  const kept = assigned > 0;
  const facts = `Archived ${dayLabel(template.archived_at)}` + (kept ? `. ${assignedLine(assigned)}, so it stays.` : '.');

  // Asking sits in the row, replacing the controls it is asking about. A dialog for this would
  // be the third overlay this app has removed.
  const actions =
    state.confirmDelete === template.id
      ? `<span class="clientlist__facts">Delete this program for good?</span>` +
        `<button type="button" class="button-secondary" data-delete-yes="${template.id}">Delete</button>` +
        `<button type="button" class="button-secondary" data-delete-no="${template.id}">Cancel</button>`
      : `<button type="button" class="button-secondary" data-restore="${template.id}">Restore</button>` +
        (kept ? '' : `<button type="button" class="button-secondary" data-delete="${template.id}">Delete</button>`);

  return `<li class="clientlist__row">${nameButton(template, facts)}<div class="archived__actions">${actions}</div></li>`;
}

/**
 * Everything that is not the list gets out of the way.
 *
 * Editing a program is a whole screen task, so a trainer who is also a client does not keep their
 * own training on screen underneath the table they are typing into.
 */
function hideList() {
  el('list-view').hidden = true;
  el('mine-view').hidden = true;
  el('section-picker').hidden = true;
  el('unit-switch').hidden = true;
}

async function showList() {
  el('edit-view').hidden = true;
  el('import-view').hidden = true;
  el('preview-view').hidden = true;
  el('assign-view').hidden = true;
  el('view-title').textContent = 'Programs';

  const on = renderSections();

  // A client who does not also coach has nothing to build, so there is no list to fill.
  if (!state.trainer) {
    el('view-note').textContent = '';
    return;
  }

  const templates = await state.storage.query('program_templates', { trainer_id: state.trainer.id });

  const counts = new Map();
  for (const t of templates) {
    const assignments = await state.storage.query('assignments', { template_id: t.id });
    counts.set(t.id, assignments.length);
  }

  const recent = (a, b) => (b.updated_at || '').localeCompare(a.updated_at || '');
  const live = templates.filter((t) => !t.archived_at).sort(recent);
  const archived = templates.filter((t) => t.archived_at).sort(recent);

  // Blank rather than "0 programs", which reads like the app failed to load rather than like
  // there is nothing here yet. The empty row below is what speaks in that case.
  //
  // The note belongs to whichever half is showing. On the other half it would be counting
  // something nobody is looking at.
  el('view-note').textContent =
    on === 'build' && live.length ? `${live.length} program${live.length === 1 ? '' : 's'}.` : '';

  el('program-list').innerHTML = live.length
    ? live.map((t) => nameButton(t, assignedLine(counts.get(t.id) ?? 0))).map((b) => `<li class="clientlist__row">${b}</li>`).join('')
    : '<li class="clientlist__empty">No programs yet. Build one, or import a spreadsheet you already use.</li>';

  // The details element itself is never replaced, only its contents, so opening the drawer
  // survives archiving, restoring and deleting from inside it.
  el('archived').hidden = !archived.length;
  el('archived-count').textContent = `${archived.length} archived program${archived.length === 1 ? '' : 's'}`;
  el('archived-list').innerHTML = archived.map((t) => archivedRow(t, counts.get(t.id) ?? 0)).join('');
}

/** Archive and restore are one write in two directions, so they are one function. */
async function setArchived(templateId, archivedAt) {
  const template = await state.storage.get('program_templates', templateId);
  if (!template) return;
  await state.storage.put('program_templates', {
    ...template,
    archived_at: archivedAt,
    updated_at: new Date().toISOString(),
  });
  state.confirmDelete = null;
  await showList();
}

/**
 * Removes a program and everything under it.
 *
 * Postgres cascades template_days and template_items. The local mirror does not, so this walks
 * the tree itself: deleting only the template would leave days and items in IndexedDB that no
 * query can reach and nothing will ever clean up. Children first, which is also the order the
 * outbox has to replay them in for the server's own foreign keys to accept the batch.
 */
async function deleteTemplate(templateId) {
  // Read again rather than trusted from the render. If an assignment appeared in between, the
  // database would refuse this, so the answer is to stop and redraw: the row comes back saying
  // how many clients are on it, with no delete control, which explains itself.
  const assignments = await state.storage.query('assignments', { template_id: templateId });
  if (!assignments.length) {
    const days = await state.storage.query('template_days', { template_id: templateId });
    for (const day of days) {
      for (const item of await state.storage.query('template_items', { day_id: day.id })) {
        await state.storage.delete('template_items', item.id);
      }
      await state.storage.delete('template_days', day.id);
    }
    await state.storage.delete('program_templates', templateId);
  }

  state.confirmDelete = null;
  await showList();
}

// ------------------------------------------------------------------ your own program

/**
 * The top set last time, per lift on this program.
 *
 * Only the exercises the snapshot actually names, so this is a handful of queries and not a scan
 * of everything the client has ever done. Rows are filtered to this client's own sessions before
 * anything reads them, which is the same guard the logging screen uses: a set_logs query is by
 * exercise, and an exercise is not private.
 */
async function loadHistory(storage, sessions, snapshot) {
  const startById = new Map(sessions.map((s) => [s.id, s.started_at]));

  const exerciseIds = new Set();
  for (const day of sortedDays(snapshot)) {
    for (const item of sortedItems(day)) exerciseIds.add(item.exercise_id);
  }

  const history = new Map();
  for (const exerciseId of exerciseIds) {
    const rows = await storage.query('set_logs', { exercise_id: exerciseId });
    const last = topSet(rows.filter((row) => startById.has(row.session_id)), startById);
    if (last) history.set(exerciseId, last);
  }
  return history;
}

/** Facts about the block, in the order somebody asks them: what, since when, how far in. */
function assignmentNote(assignment) {
  const week = weekIndexOf(new Date().toISOString(), assignment.starts_on);
  const name = assignment.snapshot?.template?.name;
  const bits = [];
  if (name) bits.push(name);
  // Week 0 is the week it started, so this counts from one the way anybody says it out loud.
  // Negative means it has not begun, which a trainer can set deliberately.
  if (week !== null && week >= 0) bits.push(`week ${week + 1}`);
  return bits.join(', ');
}

async function showMine(storage, clientId) {
  const assignment = await currentAssignment(storage, clientId);

  if (!assignment) {
    el('mine-note').textContent = NO_PROGRAM_YET;
    el('mine-body').innerHTML = '';
    return;
  }

  // Ordered oldest first, the way pickDay expects and the way the logging screen asks for them.
  const sessions = await storage.query('sessions', { client_id: clientId }, { orderBy: 'started_at' });

  el('mine-note').textContent = assignmentNote(assignment);
  const history = await loadHistory(storage, sessions, assignment.snapshot);

  // Opens on the day this person is actually next on, from the same function and the same
  // sessions the logging screen uses. Left to default it would open on the first day of the
  // program every time, so a five day rotation would have the Programs tab naming one day as
  // next while the Log tab stepped through another.
  const next = pickDay(assignment.snapshot, sessions);
  mountProgramView(el('mine-body'), {
    snapshot: assignment.snapshot,
    dayIndex: next ? next.day_index : null,
    history,
  });
}

// ------------------------------------------------------------------ preview

/**
 * The program as the client reads it.
 *
 * Frozen through buildSnapshot on the way in rather than handed to the view as loose rows. That
 * is the whole point of the control: a preview built from the editor's own state would confirm
 * that the editor renders its own state, which nobody doubted. Freezing it first means what is
 * on screen is the snapshot an assignment would carry, so anything the freeze drops or refuses
 * is visible here instead of on somebody's phone.
 */
/**
 * Freezes whatever is currently in the editor.
 *
 * Shared by the preview and by assigning, which is the point: the preview is only worth anything
 * if it is the same object an assignment would carry, and a program that cannot be frozen must
 * fail in the place a trainer can fix it rather than at the moment somebody is put on it.
 */
function freezeCurrent() {
  return buildSnapshot({
    template: state.template,
    days: state.days,
    items: [...state.items.values()].flat(),
    exercises: state.exercises,
  });
}

function showPreview() {
  const error = el('preview-error');
  let snapshot;
  try {
    snapshot = freezeCurrent();
  } catch (failure) {
    // A program that cannot be frozen cannot be assigned either, so this is the one place the
    // trainer can find that out while they are still holding the thing that broke it.
    error.hidden = false;
    error.textContent = failure.message;
    el('preview-body').innerHTML = '';
    el('edit-view').hidden = true;
    el('preview-view').hidden = false;
    el('view-title').textContent = state.template.name;
    el('view-note').textContent = 'This program cannot be shown to a client yet.';
    return;
  }

  error.hidden = true;
  el('edit-view').hidden = true;
  el('preview-view').hidden = false;
  el('view-title').textContent = state.template.name;
  el('view-note').textContent = 'What the client reads.';
  mountProgramView(el('preview-body'), { snapshot });
}

// ------------------------------------------------------------------ assigning

const isoDate = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** What this client is on right now, said the way a trainer would say it out loud. */
function standingLine(assignment, templateId) {
  if (!assignment) return 'No program yet';
  const since = `since ${dayLabel(assignment.starts_on)}`;
  if (assignment.template_id === templateId) return `Already on this program, ${since}`;
  return `On ${assignment.snapshot?.template?.name ?? 'another program'}, ${since}`;
}

function renderAssignList() {
  if (!state.assignClients.length) {
    el('assign-list').innerHTML = '<li class="clientlist__empty">No clients yet.</li>';
    return;
  }

  el('assign-list').innerHTML = state.assignClients
    .map(
      (client) =>
        `<li class="assignrow"><div class="assignrow__who">` +
        `<span class="clientlist__name">${esc(client.display_name)}</span>` +
        `<span class="clientlist__facts num">${esc(standingLine(client.standing, state.template.id))}</span>` +
        `</div>` +
        `<button type="button" class="button-secondary" data-assign="${client.id}">Assign</button></li>`,
    )
    .join('');
}

async function loadAssignClients(storage) {
  // This trainer's own clients, always, with no staff widening. trainer.html shows everybody to
  // the two accounts building the app, which is fine for reading. Writing is different: an
  // assignment for somebody else's client is refused by assignments_trainer_all, so offering the
  // button would be offering a failure.
  const clients = await storage.query('clients', { trainer_id: state.trainer.id }, { orderBy: 'display_name' });
  const live = clients.filter((c) => c.status !== 'archived');
  return Promise.all(
    live.map(async (client) => ({ ...client, standing: await currentAssignment(storage, client.id) })),
  );
}

async function showAssign() {
  const error = el('assign-error');
  try {
    // Frozen once, when the view opens, and reused for everybody assigned in this sitting. The
    // editor is not reachable while this is on screen, so it cannot go stale, and a program that
    // will not freeze says so before a list of clients implies it is ready to go out.
    state.assignSnapshot = freezeCurrent();
    error.hidden = true;
  } catch (failure) {
    state.assignSnapshot = null;
    error.hidden = false;
    error.textContent = failure.message;
  }

  el('edit-view').hidden = true;
  el('assign-view').hidden = false;
  el('view-title').textContent = state.template.name;
  el('view-note').textContent = state.assignSnapshot ? 'Who is doing this?' : 'This program cannot be assigned yet.';
  el('assign-start').value = isoDate(new Date());
  el('assign-list').innerHTML = '';

  if (!state.assignSnapshot) return;
  state.assignClients = await loadAssignClients(state.storage);
  renderAssignList();
}

/**
 * One row in assignments, carrying its own frozen copy of the program.
 *
 * No confirmation. This is reversible by assigning something else, the way archiving is
 * reversible by restoring, and the row rewrites itself to say what the client is now on, which is
 * the feedback a dialog would have been standing in for.
 */
async function assignTo(clientId, button) {
  if (!state.assignSnapshot) return;
  const startsOn = el('assign-start').value || isoDate(new Date());

  button.disabled = true;
  await state.storage.put(
    'assignments',
    makeRecord('assignments', {
      client_id: clientId,
      template_id: state.template.id,
      snapshot: state.assignSnapshot,
      starts_on: startsOn,
      ends_on: null,
      // Never set at assign time. A back off week is marked from the client's chart, months
      // later if that is when the trainer notices. See suggestDeloadWeeks.
      deload_weeks: [],
    }),
  );

  state.assignClients = await loadAssignClients(state.storage);
  renderAssignList();
}

function showEdit() {
  el('assign-view').hidden = true;
  el('preview-view').hidden = true;
  el('edit-view').hidden = false;
  el('view-title').textContent = state.template.name;
  el('view-note').textContent = '';
  renderArchiveControl();
}

/**
 * One control, both directions, and a line saying what it does to the people on the program.
 *
 * That line is the whole question somebody hesitating over Archive is asking. Archiving does not
 * reach a client: they hold a frozen snapshot, so their next session is the one they were already
 * told to do whatever happens to the template it came from.
 */
function renderArchiveControl() {
  const archived = Boolean(state.template.archived_at);
  el('archive').textContent = archived ? 'Restore program' : 'Archive program';
  // Nobody gets put on a program that has been put away. Restoring it is the way back, and it is
  // one tap on the control right beside this one.
  el('assign').hidden = archived;
  el('archive-note').textContent = archived
    ? 'This program is archived. Restoring puts it back in the list above.'
    : 'Archiving moves this program into the archived drawer. Anybody already on it keeps it, ' +
      'because what a client trains from is a snapshot taken when they were assigned.';
}

// ------------------------------------------------------------------ importing

function showImportError(message) {
  const node = el('import-error');
  node.hidden = !message;
  node.textContent = message ?? '';
}

async function startImport(file) {
  showImportError('');
  try {
    state.draft = await readFile(file);
  } catch (error) {
    showImportError(error.message);
    return;
  }
  hideList();
  el('edit-view').hidden = true;
  el('preview-view').hidden = true;
  el('assign-view').hidden = true;
  el('import-view').hidden = false;
  el('view-title').textContent = 'Review before creating';
  el('view-note').textContent = state.draft.fileName;
  el('import-progress').textContent = '';
  el('import-draft').innerHTML = renderDraft(state.draft);
}

async function commitImport() {
  if (!state.draft) return;
  const create = el('import-create');
  create.disabled = true;
  const progress = el('import-progress');

  try {
    const template = await createProgram(state.draft, {
      storage: state.storage,
      trainerId: state.trainer.id,
      resolveExercise,
      makeRecord,
      onProgress: (done, total) => {
        progress.textContent = `${done} of ${total}`;
      },
    });
    state.draft = null;
    await openTemplate(template.id);
  } catch (error) {
    showImportError(error.message);
    el('import-view').hidden = true;
    await showList();
  } finally {
    create.disabled = false;
  }
}

async function openTemplate(templateId) {
  // A half asked question does not follow you out of the list.
  state.confirmDelete = null;
  state.template = await state.storage.get('program_templates', templateId);
  state.days = (await state.storage.query('template_days', { template_id: templateId })).sort(
    (a, b) => a.day_index - b.day_index,
  );

  state.items = new Map();
  for (const day of state.days) {
    const items = (await state.storage.query('template_items', { day_id: day.id })).sort(
      (a, b) => a.order_index - b.order_index,
    );
    state.items.set(day.id, items);
  }

  const assignments = await state.storage.query('assignments', { template_id: templateId });
  hideList();
  el('import-view').hidden = true;
  showEdit();
  el('program-name').value = state.template.name;

  // The snapshot rule, made visible. A trainer who does not know this will edit a program
  // expecting a client's next session to change, and be wrong.
  const warn = el('live-warning');
  if (assignments.length) {
    warn.hidden = false;
    warn.innerHTML =
      `<span>${assignments.length} client${assignments.length === 1 ? ' is' : 's are'} on this program. ` +
      `Editing here changes new assignments only, never what somebody was already told to do.</span>`;
  } else {
    warn.hidden = true;
  }

  renderDays();
}

function renderDays() {
  el('days').innerHTML = state.days.map(renderDay).join('');
}

function renderDay(day) {
  const items = state.items.get(day.id) ?? [];
  const warmup = day.warmup || { mobility: [], general: [], specific: [] };

  return `
  <section class="day" data-day="${day.id}">
    <div class="day__head">
      <input class="field__input day__type" data-field="day_type" value="${esc(day.day_type)}"
             placeholder="STRENGTH" aria-label="Day type" />
      <input class="field__input day__split" data-field="split" value="${esc(day.split)}"
             placeholder="POSTERIOR LEGS" aria-label="Split" />
      <button type="button" class="button-secondary" data-act="day-up">Up</button>
      <button type="button" class="button-secondary" data-act="day-down">Down</button>
      <button type="button" class="button-secondary" data-act="day-delete">Delete day</button>
    </div>

    <div class="warmup">
      <!-- Labelled from the same list the client's view reads them under, so a column cannot be
           called one thing where it is typed and another where it is read. -->
      ${WARMUP_KINDS.map(
        ([kind, label]) => `
        <label class="warmup__col">
          <span class="warmup__label">${label}</span>
          <textarea class="field__input warmup__box" data-warmup="${kind}" rows="3"
                    placeholder="One per line">${esc((warmup[kind] || []).join('\n'))}</textarea>
        </label>`,
      ).join('')}
    </div>

    <div class="tablewrap">
      <table class="ptable">
        <colgroup>
          <col class="col--num" /><col class="col--exercise" /><col class="col--adjust" />
          <col class="col--sets" /><col class="col--reps" /><col class="col--load" />
          <col class="col--rest" /><col class="col--log" /><col class="col--actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Exercise</th>
            <th scope="col">Adjust</th>
            <th scope="col">Sets</th>
            <th scope="col">Reps</th>
            <th scope="col">Load</th>
            <th scope="col">Rest</th>
            <th scope="col">Log</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => renderRow(item)).join('')}
        </tbody>
      </table>
    </div>

    <label class="field">
      <span class="field__label">Comments</span>
      <textarea class="field__input" data-field="comments" rows="3"
                placeholder="One coaching cue per line">${esc(day.comments)}</textarea>
    </label>

    <div class="secondary">
      <button type="button" class="button-secondary" data-act="add-row">Add exercise</button>
    </div>
  </section>`;
}

// Short enough to read inside the column rather than being cut off by it. The two added here
// were missing entirely, so a bodyweight lift or a timed hold could be imported but never built.
const LOG_MODES = [
  ['weight_reps', 'Weight + reps'],
  ['bodyweight_reps', 'Bodyweight'],
  ['time_hold', 'Hold, seconds'],
  ['weight_only', 'Weight only'],
  ['rounds', 'Rounds'],
];

/** The sentence this row puts on the client's phone. Empty when the row is not logged. */
function clientLine(item) {
  if (item.is_logged === false) return 'Shown, never logged';
  return targetLine({
    target_sets: item.target_sets,
    target_reps_text: item.target_reps_text,
    target_load: item.target_load,
    rest_seconds: item.rest_seconds,
  });
}

function renderRow(item) {
  const name = state.exercises.find((e) => e.id === item.exercise_id)?.name ?? '';
  const modes = LOG_MODES;
  return `
  <tr data-item="${item.id}">
    <td><input class="cell cell--narrow" data-col="group_label" value="${esc(item.group_label)}" placeholder="1" aria-label="Set number" /></td>
    <td>
      <input class="cell" data-col="exercise" list="exercise-options" value="${esc(name)}" placeholder="Exercise" aria-label="Exercise" />
      <!-- What the client actually reads, in the data colour it is shown in on their phone.
           Derived from the four cells to the right, so it updates as they are typed. -->
      <p class="ptable__target" data-target="${item.id}">${esc(clientLine(item))}</p>
    </td>
    <td><input class="cell" data-col="variation" value="${esc(item.variation)}" placeholder="BARBELL" aria-label="Adjust" /></td>
    <td><input class="cell cell--narrow" data-col="sets" value="${esc(item.target_sets ?? '')}" placeholder="3" aria-label="Sets" /></td>
    <td><input class="cell cell--narrow" data-col="reps" value="${esc(item.target_reps_text)}" placeholder="6-8" aria-label="Reps" /></td>
    <td><input class="cell" data-col="load" value="${esc(item.target_load)}" placeholder="1-2 RIR" aria-label="Load" /></td>
    <td><input class="cell cell--narrow" data-col="rest" value="${esc(item.rest_seconds === null ? '' : `${item.rest_seconds} SEC`)}" placeholder="60 SEC" aria-label="Rest" /></td>
    <td>
      <select class="cell" data-col="log_mode" aria-label="How this is logged">
        <option value="off"${item.is_logged ? '' : ' selected'}>Not logged</option>
        ${modes
          .map(
            ([v, label]) =>
              `<option value="${v}"${item.is_logged && item.log_mode === v ? ' selected' : ''}>${label}</option>`,
          )
          .join('')}
      </select>
    </td>
    <td class="ptable__actions">
      <button type="button" class="iconbtn" data-act="row-up" title="Move up" aria-label="Move up">&uarr;</button>
      <button type="button" class="iconbtn" data-act="row-down" title="Move down" aria-label="Move down">&darr;</button>
      <button type="button" class="iconbtn" data-act="row-delete" title="Delete row" aria-label="Delete row">&times;</button>
    </td>
  </tr>`;
}

// ------------------------------------------------------------------ writes

async function saveDay(dayId, patch) {
  const day = state.days.find((d) => d.id === dayId);
  if (!day) return;
  const next = { ...day, ...patch, updated_at: new Date().toISOString() };
  await state.storage.put('template_days', next);
  Object.assign(day, next);
}

/**
 * Finds an exercise by name, or creates one owned by this trainer.
 *
 * The library will never have everything, and a trainer who has to leave the builder to add a
 * lift loses the program they were mid way through. So an unknown name becomes a new exercise
 * rather than an error.
 */
async function resolveExercise(name) {
  const wanted = name.trim();
  if (!wanted) return null;

  const found = state.exercises.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found;

  const created = makeRecord('exercises', {
    trainer_id: state.trainer.id,
    name: wanted,
    slug: wanted.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    primary_muscle: 'unspecified',
    equipment: 'unspecified',
    media_url: null,
    is_global: false,
    // Nothing here can know the real increment, and 2.5 is the commonest. The trainer corrects
    // it if the gym disagrees.
    increment_kg: 2.5,
  });
  await state.storage.put('exercises', created);
  state.exercises.push(created);
  refreshExerciseOptions();
  return created;
}

async function saveRow(dayId, itemId, col, value) {
  const items = state.items.get(dayId) ?? [];
  const item = items.find((i) => i.id === itemId);
  if (!item) return;

  const patch = {};

  if (col === 'group_label') patch.group_label = value.trim() || null;
  else if (col === 'variation') patch.variation = value.trim() || null;
  else if (col === 'sets') patch.target_sets = parseSets(value);
  else if (col === 'rest') patch.rest_seconds = parseRest(value);
  else if (col === 'reps') {
    const parsed = parseReps(value);
    patch.target_reps_low = parsed.low;
    patch.target_reps_high = parsed.high;
    patch.target_reps_text = parsed.text;
  } else if (col === 'load') {
    const parsed = parseLoad(value);
    patch.target_load = parsed.text;
    patch.target_rpe = parsed.rpe;
  } else if (col === 'log_mode') {
    patch.is_logged = value !== 'off';
    patch.log_mode = value === 'off' ? item.log_mode : value;
  } else if (col === 'exercise') {
    const exercise = await resolveExercise(value);
    if (!exercise) return;
    patch.exercise_id = exercise.id;
  }

  // Reps or Load changing re-guesses how the row is logged, but only while the trainer has
  // not made that choice themselves.
  if ((col === 'reps' || col === 'load') && !item.log_mode_touched) {
    const guess = inferLogging({
      repsText: patch.target_reps_text ?? item.target_reps_text,
      loadText: patch.target_load ?? item.target_load,
      sets: patch.target_sets ?? item.target_sets,
    });
    patch.is_logged = guess.isLogged;
    patch.log_mode = guess.logMode;
  }
  if (col === 'log_mode') item.log_mode_touched = true;

  const next = { ...item, ...patch, updated_at: new Date().toISOString() };
  delete next.log_mode_touched;
  await state.storage.put('template_items', next);
  Object.assign(item, next);

  // Deliberately not renderDays(). Rebuilding every table on each keystroke threw away the
  // caret, so editing Reps meant retyping it. Only the two derived things are refreshed, in
  // place, and the input the trainer is inside is never replaced.
  refreshDerived(dayId, item);
}

/** Updates the client sentence and the Log column without touching the inputs around them. */
function refreshDerived(dayId, item) {
  const line = document.querySelector(`[data-target="${item.id}"]`);
  if (line) line.textContent = clientLine(item);

  const row = document.querySelector(`tr[data-item="${item.id}"]`);
  const select = row?.querySelector('[data-col="log_mode"]');
  if (select && document.activeElement !== select) {
    select.value = item.is_logged ? item.log_mode : 'off';
  }
}

async function addRow(dayId) {
  const items = state.items.get(dayId) ?? [];
  const fallback = state.exercises[0];
  if (!fallback) return;

  const item = makeRecord('template_items', {
    day_id: dayId,
    exercise_id: fallback.id,
    order_index: items.length,
    group_label: String(items.length + 1),
    variation: null,
    target_sets: 3,
    target_reps_low: null,
    target_reps_high: null,
    target_reps_text: null,
    target_load: null,
    target_rpe: null,
    rest_seconds: null,
    notes: '',
    starting_weight_kg: null,
    is_logged: true,
    log_mode: 'weight_reps',
  });
  await state.storage.put('template_items', item);
  items.push(item);
  state.items.set(dayId, items);
  renderDays();
}

async function moveRow(dayId, itemId, delta) {
  const items = state.items.get(dayId) ?? [];
  const at = items.findIndex((i) => i.id === itemId);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= items.length) return;
  items.splice(to, 0, items.splice(at, 1)[0]);
  // Renumbered densely on every move, so order_index never develops gaps.
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].order_index !== i) {
      const next = { ...items[i], order_index: i, updated_at: new Date().toISOString() };
      await state.storage.put('template_items', next);
      Object.assign(items[i], next);
    }
  }
  renderDays();
}

async function deleteRow(dayId, itemId) {
  await state.storage.delete('template_items', itemId);
  const items = (state.items.get(dayId) ?? []).filter((i) => i.id !== itemId);
  state.items.set(dayId, items);
  await moveRow(dayId, items[0]?.id, 0);
  renderDays();
}

async function addDay() {
  const day = makeRecord('template_days', {
    template_id: state.template.id,
    day_index: state.days.length,
    name: `Day ${state.days.length + 1}`,
    day_type: null,
    split: null,
    warmup: { mobility: [], general: [], specific: [] },
    comments: '',
  });
  await state.storage.put('template_days', day);
  state.days.push(day);
  state.items.set(day.id, []);
  renderDays();
}

async function moveDay(dayId, delta) {
  const at = state.days.findIndex((d) => d.id === dayId);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= state.days.length) return;
  state.days.splice(to, 0, state.days.splice(at, 1)[0]);
  for (let i = 0; i < state.days.length; i += 1) {
    if (state.days[i].day_index !== i) {
      const next = { ...state.days[i], day_index: i, updated_at: new Date().toISOString() };
      await state.storage.put('template_days', next);
      Object.assign(state.days[i], next);
    }
  }
  renderDays();
}

async function deleteDay(dayId) {
  for (const item of state.items.get(dayId) ?? []) {
    await state.storage.delete('template_items', item.id);
  }
  await state.storage.delete('template_days', dayId);
  state.days = state.days.filter((d) => d.id !== dayId);
  state.items.delete(dayId);
  await moveDay(state.days[0]?.id, 0);
  renderDays();
}

function refreshExerciseOptions() {
  el('exercise-options').innerHTML = state.exercises
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `<option value="${esc(e.name)}"></option>`)
    .join('');
}

// ------------------------------------------------------------------ wiring

function wire() {
  el('program-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-template]');
    if (button) openTemplate(button.dataset.template);
  });

  el('back-to-list').addEventListener('click', (event) => {
    event.preventDefault();
    showList();
  });

  el('preview').addEventListener('click', showPreview);

  el('section-picker').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-section]');
    if (chip) {
      state.section = chip.dataset.section;
      showList();
    }
  });

  el('preview-back').addEventListener('click', (event) => {
    event.preventDefault();
    showEdit();
  });

  el('assign').addEventListener('click', showAssign);

  el('assign-back').addEventListener('click', (event) => {
    event.preventDefault();
    showEdit();
  });

  el('assign-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-assign]');
    if (button) assignTo(button.dataset.assign, button);
  });

  el('new-program').addEventListener('click', async () => {
    const template = makeRecord('program_templates', {
      trainer_id: state.trainer.id,
      name: 'New program',
      notes: '',
      archived_at: null,
    });
    await state.storage.put('program_templates', template);
    await openTemplate(template.id);
    await addDay();
  });

  el('program-name').addEventListener('change', async (event) => {
    const next = { ...state.template, name: event.target.value.trim() || 'Untitled', updated_at: new Date().toISOString() };
    await state.storage.put('program_templates', next);
    state.template = next;
    el('view-title').textContent = next.name;
  });

  el('import-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    // Cleared so choosing the same file twice in a row still fires a change event.
    event.target.value = '';
    if (file) await startImport(file);
  });

  el('import-cancel').addEventListener('click', async () => {
    state.draft = null;
    await showList();
  });

  el('import-create').addEventListener('click', commitImport);

  // The Log column is the one thing on the review screen that edits the draft.
  el('import-draft').addEventListener('change', (event) => {
    const select = event.target.closest('.import__mode');
    if (!select || !state.draft) return;
    setMode(state.draft, Number(select.dataset.day), Number(select.dataset.item), select.value);
    select.closest('tr')?.classList.remove('import__row--review');
  });

  el('add-day').addEventListener('click', addDay);

  el('archive').addEventListener('click', async () => {
    // Archive rather than delete: assignments.template_id is on delete restrict, so the
    // database refuses to remove a program somebody is on. Offer the operation that works, and
    // offer the way back from it, which for a long time this did not.
    const wasArchived = Boolean(state.template.archived_at);
    await setArchived(state.template.id, wasArchived ? null : new Date().toISOString());
    // Open the drawer the program just went into. Archiving something and watching it vanish
    // with no sign of where it went is the confusion this whole section exists to end.
    if (!wasArchived) el('archived').open = true;
  });

  el('archived-list').addEventListener('click', async (event) => {
    const restore = event.target.closest('[data-restore]');
    if (restore) return setArchived(restore.dataset.restore, null);

    const ask = event.target.closest('[data-delete]');
    if (ask) {
      state.confirmDelete = ask.dataset.delete;
      return showList();
    }

    const cancel = event.target.closest('[data-delete-no]');
    if (cancel) {
      state.confirmDelete = null;
      return showList();
    }

    const confirmed = event.target.closest('[data-delete-yes]');
    if (confirmed) return deleteTemplate(confirmed.dataset.deleteYes);

    // Last, so the action buttons above it win. An archived program still opens: reading one is
    // most of why anybody goes looking in here.
    const open = event.target.closest('[data-template]');
    if (open) return openTemplate(open.dataset.template);

    return undefined;
  });

  const days = el('days');

  days.addEventListener('change', async (event) => {
    const dayEl = event.target.closest('[data-day]');
    if (!dayEl) return;
    const dayId = dayEl.dataset.day;

    const col = event.target.dataset.col;
    const row = event.target.closest('[data-item]');
    if (col && row) return saveRow(dayId, row.dataset.item, col, event.target.value);

    const field = event.target.dataset.field;
    if (field) return saveDay(dayId, { [field]: event.target.value.trim() || (field === 'comments' ? '' : null) });

    const kind = event.target.dataset.warmup;
    if (kind) {
      const day = state.days.find((d) => d.id === dayId);
      const warmup = { ...(day.warmup || {}) };
      warmup[kind] = event.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
      return saveDay(dayId, { warmup });
    }
  });

  days.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const dayEl = button.closest('[data-day]');
    const dayId = dayEl.dataset.day;
    const row = button.closest('[data-item]');

    switch (button.dataset.act) {
      case 'add-row': return addRow(dayId);
      case 'row-up': return moveRow(dayId, row.dataset.item, -1);
      case 'row-down': return moveRow(dayId, row.dataset.item, 1);
      case 'row-delete': return deleteRow(dayId, row.dataset.item);
      case 'day-up': return moveDay(dayId, -1);
      case 'day-down': return moveDay(dayId, 1);
      case 'day-delete': return deleteDay(dayId);
      default: return undefined;
    }
  });
}

/**
 * The Programs tab, assembled from capability rather than from a role name.
 *
 * No role gate on boot, deliberately. This screen answers a different question for each half of
 * what somebody holds, and both halves are real: a client reads the program they are on, a
 * trainer reads the ones they build, and a person who coaches and is also coached reads their own
 * first and then theirs. Gating on 'trainer' here is what used to bounce a client straight back
 * to the logging screen.
 */
async function main() {
  const booted = await boot();
  if (!gate(booted)) return;

  const { storage, actor } = booted;
  state.storage = storage;
  mountShell(booted, 'programs');

  if (booted.mode === 'unbound') {
    el('viewer-name').textContent = 'Not set up yet';
    el('view-title').textContent = 'Nothing here yet';
    el('view-note').textContent = 'You are signed in, but this account is neither a trainer nor a client.';
    return;
  }

  // The viewer's own preference, read from and written to the viewer's own row. Loaded before
  // anything prints a weight, which on this page is the top set line under each lift.
  await loadUnit(storage, actor);
  mountUnitSwitch(el('unit-switch'));
  onUnitChange(() => repaintProgramView(el('mine-body')));
  el('viewer-name').textContent = viewerName();

  state.hasMine = Boolean(actor?.clientId);
  state.trainer = actor?.trainerId ? await storage.get('trainers', actor.trainerId) : null;

  if (state.trainer) {
    state.exercises = await storage.query('exercises', {});
    refreshExerciseOptions();
    wire();
  }

  await showList();
  if (state.hasMine) await showMine(storage, actor.clientId);
}

main();
