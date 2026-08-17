// Turning a trainer's spreadsheet into days and items.
//
// Measured against eight real client workbooks: 56 day blocks, 306 exercise rows. Every one uses
// the same visual layout, and none of them agrees on the words. One writes 'Day', another
// 'DAY 1'. One heads the exercise column 'Exercise', another 'WORKING SETS'. One writes
// 'Stretch/Mobility', another 'MOBILITY'.
//
// So nothing here matches a literal string in a fixed cell. Two structural anchors carry the
// whole format:
//
//   a row whose first cell starts with the word Day     starts a day block
//   a row whose first cell is exactly #                 is the column header for that day
//
// Column positions are then read off that header row rather than hardcoded, which is what makes
// a renamed or shifted column a non event instead of silent data loss.
//
// This never writes anything. It returns a draft plus a list of what it could not read, and a
// human approves it in the builder. An importer that writes straight to the database is an
// importer whose mistakes are discovered by a client mid set.

import { parseReps, parseRest, parseLoad, parseSets, parseGroup, inferLogging } from './program.js';

const DAY_RE = /^day\b/i;
const norm = (v) => (v ?? '').toString().trim();
const squash = (v) => norm(v).replace(/\s+/g, ' ');

// What each column header can be called. Matched case insensitively against the # header row.
const HEADERS = {
  exercise: /^(exercise|working sets|movement)$/i,
  adjust: /^(adjust|adjustment)$/i,
  sets: /^sets?$/i,
  reps: /^reps?$/i,
  load: /^(load|intensity)$/i,
  rest: /^rest$/i,
};

// Where the day header row keeps its two labels, and where the warm up columns sit. These are
// positional because they carry no header of their own to key off.
const DAY_TYPE_COL = 2;
const SPLIT_COL = 9;
const WARMUP_COLS = { mobility: 0, general: 6, specific: 12 };
const WARMUP_LABEL = /^(stretch\/mobility|mobility|general warm up|specific prep)$/i;

const cell = (row, index) => (index >= 0 && index < row.length ? norm(row[index]) : '');

/**
 * What the client sees in the day picker.
 *
 * Both halves, because the split alone is not distinguishing. One workbook runs three days that
 * are all 'FULL BODY', separated only by being STRENGTH, ENDURANCE and ACCESSORIES, and three
 * identical entries in a picker is a picker nobody can use. Joined only when they differ, so a
 * day that is 'CARDIO' and 'CARDIO' does not read as 'CARDIO, CARDIO'.
 */
export function dayName(dayType, split, fallback) {
  const parts = [dayType, split].filter(Boolean);
  const unique = [...new Set(parts.map((p) => p.toUpperCase()))];
  if (unique.length === 2) return `${dayType}, ${split}`;
  return parts[0] || fallback || 'Day';
}

/** Column name to index, read off the row whose first cell is '#'. */
export function mapColumns(headerRow) {
  const columns = { number: 0, exercise: -1, adjust: -1, sets: -1, reps: -1, load: -1, rest: -1 };
  for (let i = 0; i < headerRow.length; i += 1) {
    const value = squash(headerRow[i]);
    if (!value) continue;
    for (const [key, pattern] of Object.entries(HEADERS)) {
      if (columns[key] === -1 && pattern.test(value)) columns[key] = i;
    }
  }
  // The exercise column is the only one that must be found. Without it there is no row to make.
  // Falling back to the cell after # is safe because every workbook seen puts it there.
  if (columns.exercise === -1) columns.exercise = 1;
  return columns;
}

/**
 * One sheet to day blocks.
 *
 * Returns { days, warnings }. A warning names a sheet, a row number and what could not be read,
 * so the review screen can show the trainer exactly which line to look at rather than a count.
 */
export function readSheet(rows, sheetName = '') {
  const days = [];
  const warnings = [];
  let day = null;
  let columns = null;
  let mode = 'idle'; // idle, warmup, table, comments

  const warn = (rowIndex, message) =>
    warnings.push({ sheet: sheetName, row: rowIndex + 1, message });

  rows.forEach((row, rowIndex) => {
    const first = squash(row[0]);

    if (DAY_RE.test(first)) {
      day = {
        name: dayName(squash(row[DAY_TYPE_COL]), squash(row[SPLIT_COL]), first),
        dayType: squash(row[DAY_TYPE_COL]) || null,
        split: squash(row[SPLIT_COL]) || null,
        warmup: { mobility: [], general: [], specific: [] },
        comments: [],
        items: [],
        sourceRow: rowIndex + 1,
      };
      days.push(day);
      columns = null;
      mode = 'warmup';
      return;
    }

    if (first === '#') {
      if (!day) {
        // A table with no day header above it. Real: one workbook starts straight into a table.
        day = {
          name: `Day ${days.length + 1}`, dayType: null, split: null,
          warmup: { mobility: [], general: [], specific: [] },
          comments: [], items: [], sourceRow: rowIndex + 1,
        };
        days.push(day);
      }
      columns = mapColumns(row);
      mode = 'table';
      return;
    }

    if (!day) return;

    if (mode === 'warmup') {
      // The label row is skipped rather than collected, since it is the same three words in
      // every workbook and not part of anybody's warm up.
      for (const [key, index] of Object.entries(WARMUP_COLS)) {
        const value = squash(row[index]);
        if (value && !WARMUP_LABEL.test(value)) day.warmup[key].push(value);
      }
      return;
    }

    if (mode === 'table') {
      const name = cell(row, columns.exercise);

      // A comments block ends the table. It is a header in the exercise column, so it has to be
      // checked before the empty test below or it reads as an ordinary row.
      if (/^comments?$/i.test(name)) {
        mode = 'comments';
        return;
      }
      if (!name) {
        mode = 'idle';
        return;
      }

      const number = cell(row, columns.number);
      const repsText = cell(row, columns.reps);
      const loadText = cell(row, columns.load);
      const restText = cell(row, columns.rest);
      const setsText = cell(row, columns.sets);
      const adjustText = cell(row, columns.adjust);

      const reps = parseReps(repsText);
      const load = parseLoad(loadText);
      const sets = parseSets(setsText);
      const group = parseGroup(number);
      let logging = inferLogging({ repsText, loadText, adjustText, sets });

      // A day block with no Load column at all prescribes no load, so a rep count in it is a
      // bodyweight rep count. Structural rather than a guess about wording, and it is a real
      // layout: one workbook's mobility days are two columns, an exercise and a rep count, and
      // without this every one of them would ask a client to put a weight on a stretch.
      if (columns.load === -1 && logging.isLogged && reps.low !== null) {
        // Certain, and structurally so: there is no Load column on this day for anything to be
        // ambiguous about.
        logging = { isLogged: true, logMode: 'bodyweight_reps', certain: true };
      }

      // A warning means data was dropped, and nothing else, so that a warning is always worth
      // reading. An inferred log mode is not a warning: it is shown on every row of the review
      // table and changed there, which is a better place for it than a list.
      if (restText && parseRest(restText) === null && !/^(na|n\/a)$/i.test(restText)) {
        warn(rowIndex, `${name}: rest reads "${restText}", which is not a duration. Left blank.`);
      }

      day.items.push({
        exerciseName: name,
        groupLabel: group.label,
        variation: cell(row, columns.adjust) || null,
        targetSets: sets,
        targetRepsLow: reps.low,
        targetRepsHigh: reps.high,
        targetRepsText: reps.text,
        targetLoad: load.text,
        targetRpe: load.rpe,
        restSeconds: parseRest(restText),
        isLogged: logging.isLogged,
        logMode: logging.logMode,
        // The rows worth a trainer's eye before this becomes somebody's program: the ones where
        // the two cells did not decide the answer between them, and the ones that will be logged
        // without a set count.
        //
        // This used to read `logMode !== 'weight_reps'`, which marked every hold and every
        // bodyweight row as needing a decision that had already been made correctly. On one real
        // workbook that was 21 rows out of 61, and a flag on a third of the table is one nobody
        // reads. An unlogged row's missing set count is not mentioned either, because a set count
        // changes nothing about a row that prescribes no sets.
        needsReview: !logging.certain || (logging.isLogged && sets === null),
        sourceRow: rowIndex + 1,
      });
      return;
    }

    if (mode === 'comments') {
      const line = squash(row[columns ? columns.exercise : 1]);
      if (line) day.comments.push(line);
    }
  });

  return { days: days.filter((d) => d.items.length), warnings };
}

/** Every sheet in a workbook, in order, with the sheet name carried onto each day. */
export function readWorkbookProgram(sheets) {
  const days = [];
  const warnings = [];
  for (const sheet of sheets) {
    const result = readSheet(sheet.rows, sheet.name);
    for (const day of result.days) days.push({ ...day, sheet: sheet.name });
    warnings.push(...result.warnings);
  }
  return { days, warnings };
}

/** A one line summary of what an import would create, for the review screen. */
export function summarise({ days, warnings }) {
  const items = days.reduce((total, day) => total + day.items.length, 0);
  const modes = {};
  let notLogged = 0;
  for (const day of days) {
    for (const item of day.items) {
      if (!item.isLogged) notLogged += 1;
      else modes[item.logMode] = (modes[item.logMode] ?? 0) + 1;
    }
  }
  const names = new Set(days.flatMap((d) => d.items.map((i) => i.exerciseName.toLowerCase())));
  return { days: days.length, items, distinctExercises: names.size, modes, notLogged, warnings: warnings.length };
}
