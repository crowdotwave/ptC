// Being in the middle of a session, and picking one back up.
//
// A phone locks. A tab is discarded to reclaim memory. Somebody opens Progress between sets and
// comes back. All three end the same way: the logging screen's state lives in one object in one
// tab, and that object is gone. Everything that was actually logged is safely on disk, so the
// only thing missing is the app's memory of where it was.
//
// This module is that memory, rebuilt from the rows. It is deliberately not part of the logging
// screen: the Progress screen offers the way back to a set, so both screens have to agree about
// whether there is a set to go back to, and agreeing means one function rather than two similar
// queries.
//
// The append only rule is what makes this possible at all. Nothing was ever updated in place, so
// the session's own set_logs are a complete and ordered record of what happened before the lights
// went out.

import { activeSetLogs, epley1rm } from './history.js';

/**
 * How long an unfinished session stays resumable.
 *
 * A session with no completed_at is not automatically a session somebody is in. It is also what
 * an abandoned session looks like, forever, because nothing closes a session that was simply
 * walked away from. Without a bound, a workout abandoned in March would still be offering itself
 * up in June, and the day picker would sit on that day and never advance.
 *
 * Six hours, which is longer than any session and shorter than the gap to the next one. Erring
 * long is the cheap direction: resuming a session that is genuinely over costs one tap on End
 * session, while failing to resume one that is not over is the failure this module exists to fix.
 */
export const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The session this client is in the middle of, or null.
 *
 * Takes the rows rather than the adapter, so this stays testable and so a caller that already
 * holds a client's sessions does not query for them twice.
 */
export function openSession(sessions, { now = Date.now(), within = RESUME_WINDOW_MS } = {}) {
  let best = null;
  for (const session of sessions ?? []) {
    if (session.completed_at) continue;
    const started = Date.parse(session.started_at);
    // An unparseable timestamp is not a session anybody is in. Treating it as open would pin the
    // day picker to it permanently, which is the exact failure the window above prevents.
    if (!Number.isFinite(started)) continue;
    if (now - started > within) continue;
    if (!best || session.started_at > best.started_at) best = session;
  }
  return best;
}

/**
 * Where in the plan an interrupted session had got to.
 *
 * `plan` is the plan as built for a fresh run of this day, which means it was built with this
 * session's own rows excluded from the history. That exclusion is not an optimisation, it is
 * required: the prefill reads the most recent session for each lift, and a session that is still
 * being logged is the most recent one, so including it would rebuild the plan as a copy of the
 * sets already done and the remaining sets would vanish.
 *
 * `rows` is every set_log written against this session, unfiltered. What still counts is decided
 * here by the same function that decides it everywhere else.
 *
 * `best` is the best estimated 1RM per exercise from real history, and it is read and written, so
 * that a record set earlier in the interrupted session is still a record after the reload and
 * undo can still give it back.
 *
 * Returns a plan rather than mutating the one passed in, because extra sets logged before the
 * interruption have to be put back into it.
 */
export function replaySession(plan, rows, best = new Map()) {
  const next = [...plan];
  const logged = [];
  let cursor = 0;

  // logged_at rather than created_at: it records when the set actually happened, which is the
  // order the client did them in and therefore the order the cursor walked the plan.
  const ordered = [...activeSetLogs(rows)].sort((a, b) =>
    String(a.logged_at).localeCompare(String(b.logged_at)),
  );

  for (const row of ordered) {
    let at = next.findIndex(
      (entry, index) =>
        index >= cursor &&
        entry.item.exercise_id === row.exercise_id &&
        entry.setIndex === row.set_index,
    );

    if (at === -1) {
      // Not in the plan, so it was added with Add set. Put it back where addSet would have put
      // it, after the last set of its own lift, so the plan reads the way it did at the time.
      const template = next.find((entry) => entry.item.exercise_id === row.exercise_id);
      // A lift that is not in this day at all. Only reachable if the program changed underneath
      // an open session, and there is nowhere honest to put the row, so it is left out of the
      // walk rather than guessed at. The row itself is untouched and still counts everywhere.
      if (!template) continue;

      let insertAt = next.reduce(
        (last, entry, index) => (entry.item.exercise_id === row.exercise_id ? index + 1 : last),
        cursor,
      );
      if (insertAt < cursor) insertAt = cursor;

      next.splice(insertAt, 0, {
        item: template.item,
        setIndex: row.set_index,
        isWarmup: row.is_warmup === true,
        isExtra: true,
        logMode: template.logMode,
        weightKg: row.weight_kg,
        reps: countOf(row),
        lastWeightKg: null,
        lastReps: null,
        lastOn: null,
        openingSource: null,
      });
      at = insertAt;
    }

    const entry = next[at];
    const reps = countOf(row);
    const previousBest = best.get(row.exercise_id) ?? null;

    logged.push({
      id: row.id,
      planIndex: at,
      exerciseId: row.exercise_id,
      setIndex: row.set_index,
      weightKg: row.weight_kg,
      reps,
      logMode: entry.logMode,
      isWarmup: row.is_warmup === true,
      isExtra: row.is_extra === true,
      previousBest,
    });

    // The same test logSet runs, so a record earned before the interruption survives it and undo
    // still hands the old number back.
    if (!row.is_warmup && row.weight_kg !== null && row.reps !== null) {
      const achieved = epley1rm(row.weight_kg, row.reps);
      if (previousBest !== null && achieved > previousBest) best.set(row.exercise_id, achieved);
    }

    cursor = at + 1;
  }

  return { plan: next, logged, cursor, best };
}

/** The second number on a row, whichever of the three columns is carrying it. */
function countOf(row) {
  return row.reps ?? row.rounds ?? row.hold_seconds ?? 0;
}
