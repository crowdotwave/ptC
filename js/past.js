// Logging a workout after the fact, and going back into one already logged.
//
// The logging screen was written for the set happening now, so every time it stamps is the wall
// clock. That is wrong the day somebody trains with a partner, forgets the phone, and wants the
// work on their record a week later: the sets would land on today, the grid would fill today's
// cell, and the day they actually trained would stay empty.
//
// So the screen runs on a shifted clock instead. It is the real clock moved back to the day in
// question, and it still ticks, so sets logged one after another keep the order they were logged
// in. Nothing else about the screen changes: the same steppers, the same plan, the same undo, and
// the same append only rows. A backdated set is not a new kind of row, it is a row whose
// `logged_at` says when the set happened, which is what that column has always meant.
//
// What this module decides, so it can be tested without a DOM:
//
//   which days are allowed     the last PAST_DAYS days, never today and never the future. Today
//                              is the ordinary screen, and a future date is a session nobody did.
//   what time a new one gets   local noon on that day. A real time is not known, and noon is the
//                              one time that cannot fall on the neighbouring day in any timezone
//                              this app is used in.
//   where an edit continues    one minute after the last thing already in the session, so a set
//                              added on Thursday to Tuesday's workout sorts after Tuesday's sets
//                              rather than before them.
//   which history counts       sessions that started before the one being logged. The prefill
//                              reads "last time", and last time for a Tuesday is not the Friday
//                              that came after it.

import { isoDate, localMidnight, instantOf } from './dates.js';

/** How far back a forgotten workout can be logged. Two weeks covers "this week and last week". */
export const PAST_DAYS = 14;

/**
 * The day in a `?on=` parameter, if it is one this screen will log against. Null otherwise.
 *
 * Null rather than an error for anything outside the window, because the only way to arrive with a
 * bad one is an old link or a hand edited URL, and the ordinary screen is the right answer to both.
 */
export function pastDayFrom(param, now = new Date()) {
  if (typeof param !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(param)) return null;
  const day = localMidnight(param);
  if (!day || isoDate(day) !== param) return null;
  const { earliest, latest } = pastWindow(now);
  return param >= earliest && param <= latest ? param : null;
}

/** The first and last day a past workout can be logged on, as 'YYYY-MM-DD'. */
export function pastWindow(now = new Date()) {
  const at = (back) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    return isoDate(day);
  };
  return { earliest: at(PAST_DAYS), latest: at(1) };
}

/** Local noon on a 'YYYY-MM-DD' day, as an ISO instant. */
export function noonOn(day) {
  const at = localMidnight(day);
  if (!at) return null;
  at.setHours(12);
  return at.toISOString();
}

/**
 * Where the clock should stand when an existing session is opened again.
 *
 * One minute after the latest of its start and every row already in it, so whatever is added next
 * sorts last. Rows arrive in both timestamp spellings, so they go through instantOf.
 */
export function resumeAnchor(session, rows = []) {
  const times = [session.started_at, ...rows.map((row) => row.logged_at)]
    .map(instantOf)
    .filter((t) => t !== null);
  return new Date(Math.max(...times) + 60 * 1000).toISOString();
}

/**
 * A clock that reads `anchor` now and moves forward in real time from here.
 *
 * `realNow` is injectable so the tests can move it.
 */
export function shiftedClock(anchor, realNow = () => Date.now()) {
  const offset = instantOf(anchor) - realNow();
  return () => new Date(realNow() + offset).toISOString();
}

/** Sessions that started before `instant`, which is the history a past workout is planned from. */
export function sessionsBefore(sessions, instant) {
  const cut = instantOf(instant);
  return sessions.filter((session) => {
    const at = instantOf(session.started_at);
    return at !== null && at < cut;
  });
}

/**
 * The assignment somebody was on, on a given day.
 *
 * The latest `starts_on` on or before that day. A trainer who sent an update this morning has
 * written a new row starting today, and last Tuesday's workout belongs to the program as it stood
 * last Tuesday. When nothing had started yet, which is a workout logged before the first program
 * began, the earliest one is the nearest truth there is.
 *
 * `pickLatest` is the tie break js/snapshot.js owns, passed in so it is not written twice.
 */
export function assignmentOn(rows, day, pickLatest) {
  if (!rows.length) return null;
  const started = rows.filter((row) => row.starts_on <= day);
  if (started.length) return pickLatest(started);
  return rows.reduce((first, row) => (row.starts_on < first.starts_on ? row : first));
}
