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
 * A stored timestamp as an instant, in either of the two spellings that reach this app.
 *
 * A row written on this device carries `new Date().toISOString()`, '2026-08-25T18:01:00.048Z'. The
 * same row pulled back from the server carries what Postgres renders, '2026-08-25 18:01:00.048006+00',
 * because js/remote.js `fromWire` passes timestamps through untouched. Both spell the same instant
 * and neither sorts against the other as text: a space is 0x20 and a T is 0x54, so comparing them
 * raw puts every synced row before every local one whatever the clock says.
 *
 * The normalising is measured rather than assumed, and it is not the obvious version. `Date.parse`
 * accepts the raw Postgres string through a lenient path and REJECTS it once the space becomes a T,
 * because six fractional digits and a bare '+00' offset are both outside the ISO grammar the strict
 * path uses. So the fraction is cut to three and the offset given its minutes, and the raw string
 * stays as the fallback for anything this does not recognise.
 *
 * Returns null rather than NaN for anything unparseable, so a caller cannot accidentally arrive at
 * the epoch and treat a junk row as the oldest thing in the database.
 *
 * This lived privately inside js/snapshot.js, found the second caller it was always going to find,
 * and a second copy of a parser this fiddly is a bug waiting for whichever copy gets fixed first.
 */
export function instantOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const iso = text
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');

  const at = Date.parse(iso);
  if (!Number.isNaN(at)) return at;
  const raw = Date.parse(text);
  return Number.isNaN(raw) ? null : raw;
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
