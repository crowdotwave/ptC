// The hold timer. What the clock reads during an isometric set, as a value rather than a feel.
//
// A time_hold lift had a seconds stepper and nothing else, so a client holding a glute bridge
// for "30 to 45 seconds" was counting in their head or running a stopwatch in another app and
// typing the answer back in. The app already knew the target, already knew last time, and was
// the one thing in the room not watching the clock.
//
// The shape, which is deliberately the rest timer's and not the EMOM's:
//
//   idle      the steppers, and one large Start hold. The seconds stepper is the goal for this
//             hold, prefilled from last time exactly as a rep count would be
//   lead in   three seconds to get into position, because the thumb that pressed Start is the
//             hand that has to go flat on the floor. A tap here is a change of mind and cancels
//   holding   counts UP from zero, never down. A hold is done when the body says so, and a
//             countdown that reached zero while somebody was still holding would be the app
//             telling them to stop early. The goal and the top of the trainer's range are marks
//             the clock passes, not ends it reaches
//
// Stopping is logging. One tap ends the hold and writes the seconds actually held, and the rest
// timer starts behind it the way it does after any other set. A hold that should not count is
// undo, the same as any other set, so there is no cancel control and no confirmation.
//
// Every function here reads the wall clock it is handed and nothing else, so a backgrounded tab
// that is called once after twenty silent seconds reads exactly what one called every frame
// would. Same rule as js/emom.js, for the same reason: a throttled timer that counted its own
// ticks would drift, and a drifting hold is a wrong number written to somebody's history.

/** How long the count in lasts. Long enough to put a phone down and lie back, short enough not to wait on. */
export const ISO_LEAD_MS = 3000;

/**
 * The goal and the ceiling for one hold, in whole seconds.
 *
 * `goal` is what the stepper says, which is last time's hold or the bottom of the trainer's range.
 * `top` is the trainer's `target_reps_high`, and only when it is above the goal: a ceiling at or
 * below where somebody is already aiming is not a mark anybody can pass on the way to it.
 */
export function isoMarks(item, goal) {
  const aim = Number.isFinite(goal) && goal > 0 ? Math.round(goal) : null;
  const high = Number.isFinite(item?.target_reps_high) ? item.target_reps_high : null;
  return { goal: aim, top: high !== null && (aim === null || high > aim) ? high : null };
}

/**
 * Where a hold is, at `now`.
 *
 *   phase     'lead' while counting in, 'holding' after
 *   leadLeft  whole seconds of count in remaining, 3 2 1, and 0 once holding
 *   heldMs    milliseconds held, never negative
 *   seconds   whole seconds held, which is what the clock shows and what gets written
 *   passed    'none', 'goal' or 'top': the furthest mark the hold has reached
 *   fill      0 to 100, how far along the track is. Measured against the top of the range when
 *             there is one and the goal when there is not, and it stops at full rather than
 *             wrapping, since past the last mark there is nothing left to measure against
 */
export function isoReading({ startedAt, now, leadMs = ISO_LEAD_MS, goal = null, top = null }) {
  const holdFrom = startedAt + leadMs;
  if (now < holdFrom) {
    return {
      phase: 'lead',
      leadLeft: Math.ceil((holdFrom - now) / 1000),
      heldMs: 0,
      seconds: 0,
      passed: 'none',
      fill: 0,
    };
  }

  const heldMs = now - holdFrom;
  const seconds = Math.floor(heldMs / 1000);
  const passed =
    top !== null && seconds >= top ? 'top' : goal !== null && seconds >= goal ? 'goal' : 'none';
  const scale = top ?? goal;
  const fill = scale ? Math.min(100, (heldMs / (scale * 1000)) * 100) : 0;

  return { phase: 'holding', leadLeft: 0, heldMs, seconds, passed, fill };
}

/**
 * The seconds a stopped hold writes.
 *
 * Whole seconds, rounded down, because the clock showed whole seconds and the number written has
 * to be the number the client was looking at when they let go. Never zero: hold_seconds is checked
 * greater than zero at the database, and a hold stopped inside its first second is a hold of one
 * second rather than no hold, since undo is the way to say it did not happen.
 */
export function isoSeconds(heldMs) {
  return Math.max(1, Math.floor(Math.max(0, heldMs) / 1000));
}

/** The clock face. 0:07, 0:45, 1:12. */
export function isoClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The line under the clock. Says what the next mark is, and once it is passed, says so in words,
 * because a track filling is not a signal anybody reads with their hips in the air.
 *
 * Nothing here says a hold was short. Letting go before the goal is a hold of that many seconds,
 * and the log line under the button already says how many.
 */
export function isoLine(reading, { goal = null, top = null } = {}) {
  if (reading.phase === 'lead') return 'Get set';
  if (reading.passed === 'top') return 'Top of the range. Stop when you are done.';
  if (reading.passed === 'goal') return top !== null ? `Goal reached. Range tops out at ${top}s.` : 'Goal reached.';
  return goal !== null ? `Hold to ${goal}s` : 'Hold';
}
