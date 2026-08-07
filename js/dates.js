// Local calendar days, and nothing else.
//
// The app stores two different kinds of date and they do not parse the same way, which is the
// bug this module exists to stop being rediscovered:
//
//   timestamptz   sessions.started_at, set_logs.logged_at. A full ISO instant. Date parses it
//                 correctly, but reading a calendar day off it means asking which day that
//                 instant fell on WHERE THE PERSON WAS STANDING, not in UTC.
//   date          assignments.starts_on, payments.paid_on. Arrives as 'YYYY-MM-DD'. Date parses
//                 a bare date string as UTC midnight, which renders as the day before everywhere
//                 west of Greenwich, and this app is written in Canada.
//
// So a session logged at 19:30 in Toronto carries an ISO string whose first ten characters say
// tomorrow. Anything that slices a timestamp to get a day is wrong for a third of the evening,
// every evening, which is exactly when people train. localDayOf is the only correct way to ask.
//
// This is the authority for the consistency grid. js/progression.js still slices, deliberately
// left alone: its point.day feeds chart axis labels rather than a calendar, and changing it would
// move the startsOn fallback at progression.js:73 that weekIndexOf then reparses as local
// midnight. The two can disagree by a day at the edges. Where they do, this one is right.

/** A Date, as the local calendar day it falls on. */
export function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The local calendar day an ISO instant fell on, as 'YYYY-MM-DD'.
 *
 * Not `iso.slice(0, 10)`. That is the UTC day, and the two differ for every session logged after
 * early evening in the Americas.
 */
export function localDayOf(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : isoDate(at);
}

/**
 * The month a local day belongs to, as 'YYYY-MM'.
 *
 * Takes the day string rather than a Date, because by the time anything asks this question the
 * day has already been resolved and re-entering Date only reintroduces the parsing problem above.
 */
export function monthKey(day) {
  return typeof day === 'string' && day.length >= 7 ? day.slice(0, 7) : null;
}

/**
 * A local date column ('YYYY-MM-DD') as a Date at local midnight.
 *
 * The T00:00:00 is the whole point: without it Date reads the string as UTC. weekIndexOf in
 * js/progression.js does the same thing inline and predates this module.
 */
export function localMidnight(day) {
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}
