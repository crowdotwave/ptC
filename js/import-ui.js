// The review step between a spreadsheet and a program.
//
// The importer never writes. It hands back a draft and this shows the whole of it, every day and
// every row, before anything is created. That ordering is the point: an importer that writes
// straight through is one whose mistakes are found by a client mid set, and the person who can
// spot them is looking at the screen right now.
//
// What is shown is everything, not a summary. A count of rows imported tells a trainer nothing
// they can act on. The rows themselves, with the parsed values beside the words they typed, are
// the only version they can actually check.

import { readWorkbook, canReadWorkbooks } from './xlsx.js';
import { readWorkbookProgram, summarise } from './import-program.js';
import { targetLine } from './program.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const MODES = [
  ['weight_reps', 'Weight and reps'],
  ['bodyweight_reps', 'Bodyweight reps'],
  ['time_hold', 'Hold, seconds'],
  ['weight_only', 'Weight only'],
  ['rounds', 'Rounds'],
  ['none', 'Not logged'],
];

/** Reads the file and returns the draft, or throws something a person can act on. */
export async function readFile(file) {
  if (!canReadWorkbooks()) {
    throw new Error('This browser cannot open a spreadsheet. Chrome, Edge, or Safari 16.4 and up can.');
  }
  const buffer = await file.arrayBuffer();
  const sheets = await readWorkbook(buffer);
  if (!sheets.length) throw new Error('No sheets in that file.');

  const draft = readWorkbookProgram(sheets);
  if (!draft.days.length) {
    throw new Error(
      'No day blocks found. This reads the layout with a row starting "Day" and a row whose ' +
        'first cell is "#". Sheets read: ' + sheets.map((s) => s.name).join(', ') + '.',
    );
  }
  return { ...draft, sheets: sheets.map((s) => s.name), fileName: file.name };
}

function modeSelect(dayIndex, itemIndex, item) {
  const current = item.isLogged ? item.logMode : 'none';
  const options = MODES.map(
    ([value, label]) =>
      `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`,
  ).join('');
  return (
    `<select class="cell import__mode" data-day="${dayIndex}" data-item="${itemIndex}" ` +
    `aria-label="How ${esc(item.exerciseName)} is logged">${options}</select>`
  );
}

/**
 * The whole draft, as tables that look like the spreadsheet it came from.
 *
 * Two columns carry what the app decided rather than what the trainer typed: Target, which is
 * the sentence the client will read, and Log, which is how the set is recorded. Both are the
 * places an import goes wrong, so both are next to the original words rather than a screen away.
 */
export function renderDraft(draft) {
  const summary = summarise(draft);
  const review = draft.days.reduce(
    (total, day) => total + day.items.filter((i) => i.needsReview).length,
    0,
  );

  const head =
    `<p class="import__summary">` +
    `<b>${summary.days}</b> days, <b>${summary.items}</b> exercises, ` +
    `<b>${summary.distinctExercises}</b> distinct movements, from ${esc(draft.fileName)}. ` +
    (review
      ? `<b>${review}</b> rows are marked below: anything not logged, anything measured in ` +
        `something other than weight and reps, or anything with no set count. Check those, ` +
        `change the Log column where it is wrong, then create the program.`
      : 'Nothing needed a judgement call.') +
    `</p>` +
    (draft.warnings.length
      ? `<ul class="import__warnings">` +
        draft.warnings.map((w) => `<li>Sheet ${esc(w.sheet)}, row ${w.row}: ${esc(w.message)}</li>`).join('') +
        `</ul>`
      : '');

  const days = draft.days
    .map((day, dayIndex) => {
      const warm = ['mobility', 'general', 'specific']
        .map((key) => (day.warmup[key] || []).join(', '))
        .filter(Boolean);

      const rows = day.items
        .map((item, itemIndex) => {
          const target = targetLine({
            target_sets: item.targetSets,
            target_reps_text: item.targetRepsText,
            target_load: item.targetLoad,
            rest_seconds: item.restSeconds,
          });
          return (
            `<tr${item.needsReview ? ' class="import__row--review"' : ''}>` +
            `<td>${esc(item.groupLabel ?? '')}</td>` +
            `<td>${esc(item.exerciseName)}</td>` +
            `<td>${esc(item.variation ?? '')}</td>` +
            `<td class="num">${esc(item.targetSets ?? '')}</td>` +
            `<td>${esc(item.targetRepsText ?? '')}</td>` +
            `<td>${esc(item.targetLoad ?? '')}</td>` +
            `<td class="num">${item.restSeconds === null ? '' : `${item.restSeconds}s`}</td>` +
            `<td class="import__target">${esc(target) || '<span class="import__none">nothing to show</span>'}</td>` +
            `<td>${modeSelect(dayIndex, itemIndex, item)}</td>` +
            `</tr>`
          );
        })
        .join('');

      return `
      <section class="day">
        <div class="day__head">
          <b>${esc(day.name)}</b>
          <span class="import__meta">${esc(day.dayType ?? '')}${day.sheet ? ` · ${esc(day.sheet)}` : ''} · ${day.items.length} exercises</span>
        </div>
        ${warm.length ? `<p class="import__warm">Warm up: ${esc(warm.join(' | '))}</p>` : ''}
        <div class="tablewrap">
          <table class="ptable">
            <thead><tr>
              <th scope="col">#</th><th scope="col">Exercise</th><th scope="col">Adjust</th>
              <th scope="col">Sets</th><th scope="col">Reps</th><th scope="col">Load</th>
              <th scope="col">Rest</th><th scope="col">What the client reads</th><th scope="col">Log</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${day.comments.length ? `<p class="import__comments">${esc(day.comments.join(' '))}</p>` : ''}
      </section>`;
    })
    .join('');

  return head + days;
}

/** Applies a Log column change back onto the draft, so creating uses what is on screen. */
export function setMode(draft, dayIndex, itemIndex, value) {
  const item = draft.days[dayIndex]?.items[itemIndex];
  if (!item) return;
  if (value === 'none') {
    item.isLogged = false;
  } else {
    item.isLogged = true;
    item.logMode = value;
  }
  item.needsReview = false;
}

/**
 * Writes the draft as a real program. Awaited row by row rather than fired in parallel, because
 * this is somebody at a desk watching a progress line, and an exercise has to exist before an
 * item can point at it.
 */
export async function createProgram(draft, { storage, trainerId, resolveExercise, makeRecord, onProgress }) {
  const template = makeRecord('program_templates', {
    trainer_id: trainerId,
    name: draft.fileName.replace(/\.xlsx$/i, ''),
    notes: '',
    archived_at: null,
  });
  await storage.put('program_templates', template);

  let done = 0;
  const total = draft.days.reduce((t, d) => t + d.items.length, 0);

  for (const [dayIndex, day] of draft.days.entries()) {
    const dayRecord = makeRecord('template_days', {
      template_id: template.id,
      day_index: dayIndex,
      name: day.name,
      day_type: day.dayType,
      split: day.split,
      warmup: day.warmup,
      comments: day.comments.join('\n'),
    });
    await storage.put('template_days', dayRecord);

    for (const [order, item] of day.items.entries()) {
      const exercise = await resolveExercise(item.exerciseName);
      if (!exercise) continue;
      await storage.put(
        'template_items',
        makeRecord('template_items', {
          day_id: dayRecord.id,
          exercise_id: exercise.id,
          order_index: order,
          group_label: item.groupLabel,
          variation: item.variation,
          target_sets: item.targetSets,
          target_reps_low: item.targetRepsLow,
          target_reps_high: item.targetRepsHigh,
          target_reps_text: item.targetRepsText,
          target_load: item.targetLoad,
          target_rpe: item.targetRpe,
          rest_seconds: item.restSeconds,
          notes: '',
          is_logged: item.isLogged,
          log_mode: item.logMode,
          starting_weight_kg: null,
        }),
      );
      done += 1;
      if (onProgress) onProgress(done, total);
    }
  }

  return template;
}
