// Turns sessions into calendar months. Pure: no DOM, no storage, and no clock.
//
// The question this answers is not the one the charts answer. js/progression.js asks whether one
// lift is moving. This asks whether the person is showing up, and at what. It is the first thing
// on the progress screen that is not scoped to a single exercise.
//
// What it deliberately does not compute, per CLAUDE.md: no streak, no adherence ratio, no count
// of missed days, no expected-session-here marker. A day nobody trained produces a cell carrying
// nothing at all, and there is no field on it that a caller could render as a failure. That is
// not an oversight to be helpfully filled in later. "Deliberately absent: no streak pressure, no
// guilt messaging for missed days."
//
// Three rules that are easy to get wrong and are each tested:
//
//   local days      a session carries a timestamptz, and the calendar day it belongs to is the
//                   day where the person was standing. js/dates.js localDayOf, never a slice.
//   real work       a session row with no live set logs is not a trained day. Someone tapped
//                   start and walked out. "A session that ended empty is not a success."
//   frozen program  the split is read from that session's OWN assignment snapshot, not from
//                   whatever the client is on now, so renaming a program does not repaint
//                   history and neither does being moved onto a new one.

import { localDayOf, monthKey, localMidnight, isoDate } from './dates.js';
import { sortedDays, dayTitle } from './snapshot.js';
import { weekIndexOf } from './progression.js';

/**
 * How many identity colours the grid has. Slot 4 is the colourless one and is also the overflow,
 * so a six day program puts days four, five and six all in it and lets the glyph separate them.
 *
 * Matches the --split-N-* token count in styles.css, where the hue arithmetic for why it is four
 * and not six lives.
 */
export const SPLIT_SLOTS = 4;

/** Monday, matching every other week boundary in the app. */
const WEEK_START = 1;

/**
 * A short badge for a day, made unique inside its own program.
 *
 * The naive answer is the first letter, and the naive answer breaks on the single most common
 * four day split there is: Upper A, Lower A, Upper B, Lower B collapses to U, L, U, L, and the
 * glyph is the signal carrying identity when hue runs out. So a colliding group falls back to the
 * first letter plus the first character that actually differs between the colliding labels, which
 * turns that split into UA, LA, UB, LB.
 *
 * Still colliding after that (two days genuinely named the same thing) gets a positional digit,
 * because two identical badges is the one outcome that must not ship.
 */
export function splitGlyphs(labels) {
  const initial = (label) => (String(label).trim()[0] ?? '?').toUpperCase();

  // Where two labels sharing an initial first differ, scanning the significant characters of each.
  const significant = (label) => String(label).toUpperCase().replace(/[^A-Z0-9]/g, '');

  const groups = new Map();
  labels.forEach((label, index) => {
    const key = initial(label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });

  const out = new Array(labels.length);
  for (const [key, members] of groups) {
    if (members.length === 1) {
      out[members[0]] = key;
      continue;
    }
    // Walk the characters until one tells these labels apart, then take it.
    const words = members.map((i) => significant(labels[i]));
    const longest = Math.max(...words.map((w) => w.length));
    let at = -1;
    for (let pos = 1; pos < longest; pos += 1) {
      const seen = new Set(words.map((w) => w[pos] ?? ''));
      if (seen.size === words.length) {
        at = pos;
        break;
      }
    }
    members.forEach((index, n) => {
      const word = words[n];
      out[index] = at >= 0 ? `${key}${word[at]}` : `${key}${n + 1}`;
    });
  }
  return out;
}

/**
 * Every distinct day of one assignment, in the order the trainer put them in, with its slot.
 *
 * The slot keys on day_index and not on the label, which is the difference between a colour that
 * holds still and one that does not. Keying on the label means the first day of a renamed program
 * takes a different colour, and keying on order of first appearance means creating a new
 * assignment repaints every month already on screen. day_index is what the client already reads
 * off the day picker while logging, so this is also the ordering they have seen before.
 */
function daysOfAssignment(assignment) {
  const days = sortedDays(assignment?.snapshot);
  const labels = days.map((day) => dayTitle(day));
  const glyphs = splitGlyphs(labels);

  return days.map((day, position) => ({
    dayIndex: day.day_index,
    label: labels[position],
    glyph: glyphs[position],
    // Position in the rotation rather than the raw day_index, so a program whose days are
    // numbered 0, 3, 7 still fills slots 1, 2, 3 instead of leaving gaps in the palette.
    slot: Math.min(position, SPLIT_SLOTS - 1) + 1,
  }));
}

/**
 * Which program day each session was, and whether it fell in a planned deload.
 *
 * Exported because the grid is no longer the only thing that asks. js/session-volume.js draws one
 * line per program day directly under the grid, in the grid's own slot colours, so a line painted
 * slot 2 above a column of slot 3 cells would be the app disagreeing with itself about what a
 * Tuesday was. One function decides, both callers are handed the answer.
 *
 * The split is read from each session's OWN assignment snapshot, so renaming a program does not
 * repaint history and neither does being moved onto a new one.
 */
export function identifySessions({ sessions = [], assignments = [] } = {}) {
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const daysByAssignment = new Map();
  const dayFor = (assignmentId, dayIndex) => {
    if (!assignmentById.has(assignmentId)) return null;
    if (!daysByAssignment.has(assignmentId)) {
      daysByAssignment.set(assignmentId, daysOfAssignment(assignmentById.get(assignmentId)));
    }
    return daysByAssignment.get(assignmentId).find((d) => d.dayIndex === dayIndex) ?? null;
  };

  const out = new Map();
  for (const session of sessions) {
    const assignment = assignmentById.get(session.assignment_id) ?? null;
    const programDay = dayFor(session.assignment_id, session.day_index);

    // Deload comes from the assignment this session belongs to, never the current one. A client
    // three programs later must not have last spring's week six light up because this spring's
    // program happens to back off in its sixth week.
    const week = assignment ? weekIndexOf(session.started_at, assignment.starts_on) : null;
    const deloadWeeks = Array.isArray(assignment?.deload_weeks) ? assignment.deload_weeks : [];

    out.set(session.id, {
      sessionId: session.id,
      assignmentId: session.assignment_id ?? null,
      dayIndex: session.day_index ?? null,
      // A session logged with no program behind it is still a session. It gets the colourless slot
      // and says so, rather than being dropped for not fitting the model.
      label: programDay ? programDay.label : 'Unprogrammed',
      glyph: programDay ? programDay.glyph : '.',
      slot: programDay ? programDay.slot : SPLIT_SLOTS,
      weekIndex: week,
      isDeload: week !== null && deloadWeeks.includes(week),
    });
  }
  return out;
}

/**
 * The consistency view: one entry per calendar month, each a full Monday-first grid.
 *
 * `today` is passed in rather than read, for the same reason js/progression.js takes its rows
 * rather than fetching them. A module that calls Date.now() has a different answer every day and
 * nothing about it can be tested.
 *
 * `sessionIdsWithWork` is the set of sessions that hold at least one live set log. The caller
 * computes it with activeSetLogs, because this module has no business knowing how set_logs
 * supersede each other, and js/history.js is already the single place that decides.
 */
export function buildConsistency({
  sessions = [],
  assignments = [],
  sessionIdsWithWork = new Set(),
  recordSessionIds = new Set(),
  today,
  from = null,
  to = null,
} = {}) {
  const identity = identifySessions({ sessions, assignments });

  // One entry per session that actually holds work, keyed to the local day it happened on.
  const byDay = new Map();
  let counted = 0;

  for (const session of sessions) {
    if (!sessionIdsWithWork.has(session.id)) continue;
    const day = localDayOf(session.started_at);
    if (!day) continue;

    const entry = {
      ...identity.get(session.id),
      // Whether any lift set a record here. Decided by js/progression.js and handed in, because
      // that module already owns what a record is and two answers to that question is one too
      // many. It follows that a record can never fall on a deload: progression.js skips those
      // when tracking the running best.
      isRecord: recordSessionIds.has(session.id),
    };

    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(entry);
    counted += 1;
  }

  const days = [...byDay.keys()].sort();
  const first = from ?? days[0] ?? today;
  // Never stops before today even for a client who has not trained in months, because a grid that
  // ends in April is a grid that says something about April.
  const last = to ?? today;

  const months = buildMonths(first, last, byDay, today);

  return {
    months,
    totalSessions: counted,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    openAt: openingMonth(months, today),
  };
}

/**
 * Which month to open on.
 *
 * This month, when there is anything in it. Otherwise the most recent month there is anything in.
 *
 * Not simply "this month". Somebody opening their progress on the third, or after a fortnight
 * away, would land on a blank grid, and this is the largest thing on the screen. The fallback is
 * not a nudge about the gap: it scrolls to work that was done rather than to space where work was
 * not, which is the same reason the session summary reports what happened and never what did not.
 * The gap stays visible the moment they scroll forward, unmarked and uncounted.
 */
function openingMonth(months, today) {
  const current = months.findIndex((m) => m.key === monthKey(today));
  if (current >= 0 && months[current].sessions > 0) return current;

  for (let i = months.length - 1; i >= 0; i -= 1) {
    if (months[i].sessions > 0) return i;
  }
  return current >= 0 ? current : Math.max(0, months.length - 1);
}

/** Every month from `first` to `last` inclusive, each a whole grid of weeks. */
function buildMonths(first, last, byDay, today) {
  const start = localMidnight(`${monthKey(first)}-01`);
  const end = localMidnight(`${monthKey(last)}-01`);
  if (!start || !end || start > end) return [];

  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cursor <= end) {
    months.push(buildMonth(cursor.getFullYear(), cursor.getMonth(), byDay, today));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function buildMonth(year, month, byDay, today) {
  // Back up to the Monday on or before the first, then take whole weeks until the cursor has
  // walked past the end of the month. Day zero of the next month is the last day of this one,
  // which is what saves this from having to know how long February is.
  const lead = (new Date(year, month, 1).getDay() - WEEK_START + 7) % 7;
  const cursor = new Date(year, month, 1 - lead);
  const lastOfMonth = new Date(year, month + 1, 0);

  const weeks = [];
  const legendBySlot = new Map();
  let sessions = 0;
  let deloads = 0;
  let records = 0;

  while (cursor <= lastOfMonth) {
    const week = { days: [], isDeload: false };

    for (let i = 0; i < 7; i += 1) {
      const day = isoDate(cursor);
      const inMonth = cursor.getMonth() === month && cursor.getFullYear() === year;
      // A day belonging to the neighbouring month is a spacer, never a cell with data on it.
      const entries = inMonth ? (byDay.get(day) ?? []) : [];
      const first = entries[0] ?? null;

      week.days.push({
        day,
        dayOfMonth: cursor.getDate(),
        inMonth,
        isToday: day === today,
        // Two sessions on one day is rare and real. The cell takes the first one's identity and
        // keeps every id, so the detail line can name them all.
        sessionIds: entries.map((e) => e.sessionId),
        label: first ? first.label : null,
        glyph: first ? first.glyph : null,
        slot: first ? first.slot : null,
        isDeload: entries.some((e) => e.isDeload),
        isRecord: entries.some((e) => e.isRecord),
      });

      sessions += entries.length;
      for (const entry of entries) {
        if (!legendBySlot.has(entry.slot)) {
          legendBySlot.set(entry.slot, { slot: entry.slot, label: entry.label, glyph: entry.glyph });
        }
        if (entry.isDeload) {
          week.isDeload = true;
          deloads += 1;
        }
        if (entry.isRecord) records += 1;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    year,
    month,
    label: new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    weeks,
    sessions,
    hasDeload: deloads > 0,
    hasRecord: records > 0,
    // Slot order rather than first seen order, so the legend reads in the rotation's own order
    // and matches the day picker the client already knows from the logging screen.
    legend: [...legendBySlot.values()].sort((a, b) => a.slot - b.slot),
  };
}
