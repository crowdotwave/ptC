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
import { wireNav } from './js/nav.js';
import { parseReps, parseRest, parseLoad, parseSets, inferLogging } from './js/program.js';

const el = (id) => document.getElementById(id);
const state = { storage: null, trainer: null, template: null, days: [], items: new Map(), exercises: [] };

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ program list

async function showList() {
  el('list-view').hidden = false;
  el('edit-view').hidden = true;
  el('view-title').textContent = 'Programs';

  const templates = await state.storage.query('program_templates', { trainer_id: state.trainer.id });
  const live = templates.filter((t) => !t.archived_at);
  el('view-note').textContent = `${live.length} program${live.length === 1 ? '' : 's'}.`;

  const counts = new Map();
  for (const t of templates) {
    const assignments = await state.storage.query('assignments', { template_id: t.id });
    counts.set(t.id, assignments.length);
  }

  el('program-list').innerHTML = templates
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .map((t) => {
      const n = counts.get(t.id) ?? 0;
      return (
        `<li class="clientlist__row"><button type="button" class="clientlist__button" data-template="${t.id}">` +
        `<span class="clientlist__name">${esc(t.name)}${t.archived_at ? ' (archived)' : ''}</span>` +
        `<span class="clientlist__facts num">${n} client${n === 1 ? '' : 's'} assigned</span>` +
        `</button></li>`
      );
    })
    .join('');
}

// ------------------------------------------------------------------ editor

async function openTemplate(templateId) {
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
  el('list-view').hidden = true;
  el('edit-view').hidden = false;
  el('view-title').textContent = state.template.name;
  el('view-note').textContent = '';
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
      ${['mobility', 'general', 'specific']
        .map(
          (kind) => `
        <label class="warmup__col">
          <span class="warmup__label">${
            { mobility: 'Stretch/Mobility', general: 'General Warm Up', specific: 'Specific Prep' }[kind]
          }</span>
          <textarea class="field__input warmup__box" data-warmup="${kind}" rows="3"
                    placeholder="One per line">${esc((warmup[kind] || []).join('\n'))}</textarea>
        </label>`,
        )
        .join('')}
    </div>

    <div class="tablewrap">
      <table class="ptable">
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

function renderRow(item) {
  const name = state.exercises.find((e) => e.id === item.exercise_id)?.name ?? '';
  const modes = [
    ['weight_reps', 'Weight and reps'],
    ['weight_only', 'Weight only'],
    ['rounds', 'Rounds'],
  ];
  return `
  <tr data-item="${item.id}">
    <td><input class="cell cell--narrow" data-col="group_label" value="${esc(item.group_label)}" placeholder="1" aria-label="Set number" /></td>
    <td><input class="cell" data-col="exercise" list="exercise-options" value="${esc(name)}" placeholder="Exercise" aria-label="Exercise" /></td>
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
      <button type="button" class="button-secondary" data-act="row-up">Up</button>
      <button type="button" class="button-secondary" data-act="row-down">Down</button>
      <button type="button" class="button-secondary" data-act="row-delete">Delete</button>
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

  if (col === 'reps' || col === 'load' || col === 'log_mode') renderDays();
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

  el('add-day').addEventListener('click', addDay);

  el('archive').addEventListener('click', async () => {
    // Archive rather than delete: assignments.template_id is on delete restrict, so the
    // database refuses to remove a program somebody is on. Offer the operation that works.
    const next = { ...state.template, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await state.storage.put('program_templates', next);
    state.template = next;
    await showList();
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

async function main() {
  const booted = await boot({ role: 'trainer' });
  if (!gate(booted)) return;

  const { storage, actor } = booted;
  state.storage = storage;
  wireNav(booted);
  state.trainer = actor?.trainerId ? await storage.get('trainers', actor.trainerId) : null;

  if (!state.trainer) {
    el('trainer-name').textContent = 'No trainer';
    el('view-note').textContent =
      booted.error || 'Switch to a trainer with the dev role control to build a program.';
    return;
  }
  el('trainer-name').textContent = state.trainer.display_name;

  state.exercises = await storage.query('exercises', {});
  refreshExerciseOptions();

  wire();
  await showList();
}

main();
