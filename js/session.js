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
import { makeRecord, getDeviceId } from './storage.js';
// The one countOf. This file had a private copy with the same name, the same comment, and a
// different last resort: zero where the shared one says one. A hold writes no reps, so replaying
// a 45 second hold recorded it as a set of zero reps, nextSteppers read that as a number the
// client had chosen this session and carried it into the next lift, and three sets went to disk
// carrying reps of zero. set_logs_reps_check refuses those forever, the queue stops at the first
// refusal, and a client sat on 82 unsynced changes for two days over a fallback that differed by
// one character from the one twelve lines of comment in js/plan.js explain.
import { countOf } from './plan.js';

/**
 * The sessions that still happened.
 *
 * A discarded session is not a session with nothing in it, and the difference is the reason
 * `discarded_at` exists rather than the app inferring emptiness from the set rows. Two places
 * cannot tell them apart from the rows alone: `pickDay` advances the rotation from the last
 * session, and the consistency grid draws a filled cell for one. Both would go on treating a
 * thrown away workout as a workout that happened.
 *
 * Every read of `sessions` outside the history list goes through here or through `loadSessions`.
 * A new call site that does neither is a bug, and it will present as a discarded session quietly
 * counting again somewhere.
 */
export function live(sessions) {
  return (sessions ?? []).filter((session) => !session.discarded_at);
}

/**
 * Every session that still happened, for one client, oldest first.
 *
 * Oldest first because `pickDay` reads the last one, and ordering that in the caller is exactly
 * the kind of thing that gets it right on three screens and wrong on the fourth.
 */
export async function loadSessions(storage, clientId) {
  const rows = await storage.query('sessions', { client_id: clientId }, { orderBy: 'started_at' });
  return live(rows);
}

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
  for (const session of live(sessions)) {
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
 *
 * THE WALK IS NOT FORWARD ONLY, and it used to be. Each row was matched against the plan from the
 * cursor onward, which quietly encoded an assumption the logging screen no longer makes: that the
 * lifts get done in the order they are written. Now that a client can move to any lift and back,
 * bench before squat and then a locked phone would have found no seat for the squat rows ahead of
 * the cursor, filed them as sets added by hand, and handed back a plan carrying two copies of
 * every squat set with the real ones still showing as never done. Rows claim their own seat
 * wherever it sits, and a seat is claimed once.
 */
export function replaySession(plan, rows, best = new Map()) {
  const next = [...plan];
  const logged = [];
  const claimed = new Set();
  let last = null;

  // logged_at rather than created_at: it records when the set actually happened, which is the
  // order the client did them in and therefore where they were when the lights went out.
  const ordered = [...activeSetLogs(rows)].sort((a, b) =>
    String(a.logged_at).localeCompare(String(b.logged_at)),
  );

  for (const row of ordered) {
    let entry = next.find(
      (candidate) =>
        !claimed.has(candidate) &&
        candidate.item.exercise_id === row.exercise_id &&
        candidate.setIndex === row.set_index,
    );

    if (!entry) {
      // Not in the plan, so it was added with Add set. Put it back where addSet would have put
      // it, after the last set of its own lift, so the plan reads the way it did at the time.
      const template = next.find((candidate) => candidate.item.exercise_id === row.exercise_id);
      // A lift that is not in this day at all. Only reachable if the program changed underneath
      // an open session, and there is nowhere honest to put the row, so it is left out of the
      // walk rather than guessed at. The row itself is untouched and still counts everywhere.
      if (!template) continue;

      const insertAt = next.reduce(
        (at, candidate, index) => (candidate.item.exercise_id === row.exercise_id ? index + 1 : at),
        0,
      );

      entry = {
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
      };
      next.splice(insertAt, 0, entry);
    }

    claimed.add(entry);
    last = entry;
    const previousBest = best.get(row.exercise_id) ?? null;

    logged.push({
      id: row.id,
      // The entry itself rather than its index. Indexes move: an extra set added to a lift the
      // client came back to shifts every entry after it, and an undo stack holding stale numbers
      // would take back the wrong set. Identity cannot go stale.
      entry,
      exerciseId: row.exercise_id,
      setIndex: row.set_index,
      weightKg: row.weight_kg,
      reps: countOf(row),
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
  }

  return { plan: next, logged, cursor: resumeAt(next, claimed, last), best };
}

/**
 * The set to open on after a reload: the one after whatever was logged last.
 *
 * Not the first unlogged set in the day. A lift the client stepped past is unlogged and stays
 * unlogged, and dropping them back on it would undo the decision they made before the phone
 * locked. Where they were is what they were doing.
 *
 * Wrapping to the top is the last resort, for a client who was working through the day backwards.
 * Nothing left anywhere means the day is done, and the plan length is what the screen reads as
 * that.
 */
function resumeAt(plan, claimed, last) {
  const from = last ? plan.indexOf(last) + 1 : 0;
  for (let i = from; i < plan.length; i += 1) if (!claimed.has(plan[i])) return i;
  for (let i = 0; i < from; i += 1) if (!claimed.has(plan[i])) return i;
  return plan.length;
}

/**
 * The row that takes a set back.
 *
 * A new row pointing at the one it cancels, marked void. Not an edit and not a delete: set_logs
 * has no update or delete path anywhere, from the adapter down to the grant.
 *
 * It mirrors the values it is retracting rather than zeroing them. Neither row counts once
 * `is_void` is set, so those numbers change nothing anywhere, and a retraction that had forgotten
 * what it was retracting would be a worse record than no retraction at all. Keeping them is the
 * reason this table is append only in the first place.
 */
export function retractionOf(row) {
  return makeRecord('set_logs', {
    session_id: row.session_id,
    exercise_id: row.exercise_id,
    set_index: row.set_index,
    weight_kg: row.weight_kg,
    reps: row.reps ?? null,
    rounds: row.rounds ?? null,
    hold_seconds: row.hold_seconds ?? null,
    rpe: row.rpe ?? null,
    is_warmup: row.is_warmup === true,
    logged_at: new Date().toISOString(),
    supersedes_id: row.id,
    is_void: true,
    is_extra: row.is_extra === true,
    device_id: getDeviceId(),
  });
}

/**
 * Throws a session away.
 *
 * Undo, applied to a whole session. Every set that still counts gets a retraction, and then the
 * session is marked so that the two things which read session rows rather than set rows, the day
 * rotation and the consistency grid, stop counting it too.
 *
 * The order is retractions first and the marker last, and it matters for the same reason the
 * outbox is causally ordered: a device that dies halfway leaves a live session with some sets
 * retracted, which is a state the app already handles, rather than a discarded session still
 * holding sets that count, which is a workout that has vanished from every screen while still
 * feeding every chart.
 *
 * Returns the number of sets taken back, because the acknowledgement should say what was actually
 * given up rather than only that something was.
 */
export async function discardSession(storage, session) {
  const rows = await storage.query('set_logs', { session_id: session.id });
  const stillCount = activeSetLogs(rows);

  for (const row of stillCount) {
    await storage.put('set_logs', retractionOf(row));
  }

  await storage.put('sessions', {
    ...session,
    discarded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return stillCount.length;
}

/**
 * One line per session, newest first, for the history list.
 *
 * Counts working sets and warmups separately, because they are separate everywhere else in this
 * app and a session summary that reported nine sets where three were warmups would be the only
 * screen that disagreed.
 *
 * `label` is the trainer's own name for that day, resolved from the assignment the session was
 * logged against rather than from the current one. A client who changed programs last month still
 * reads last month's sessions under the names they had at the time, which is the same rule the
 * consistency grid follows and the same reason `assignments.snapshot` is frozen.
 */
export function summarise(sessions, setLogs, labelFor) {
  const bySession = new Map();
  for (const row of activeSetLogs(setLogs)) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }

  return live(sessions)
    .slice()
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    .map((session) => {
      const rows = bySession.get(session.id) ?? [];
      const working = rows.filter((row) => !row.is_warmup);
      return {
        id: session.id,
        startedAt: session.started_at,
        label: labelFor ? labelFor(session) : `Day ${session.day_index + 1}`,
        sets: working.length,
        warmups: rows.length - working.length,
        // Passed through as written rather than parsed apart. The word and the sentence were one
        // line when somebody said them, and this list is the place they get read back.
        note: session.client_note ?? null,
        // An open session is not an unfinished one to apologise for, it is one somebody may still
        // be in. The list says so rather than leaving a session that looks half written.
        isOpen: !session.completed_at,
      };
    });
}
