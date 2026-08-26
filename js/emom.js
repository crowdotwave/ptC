// Every minute on the minute: the clock drives, and the client keeps up.
//
// This is the one place in the app where the app sets the pace instead of following it. Everywhere
// else a set exists because somebody tapped to say so, the rest timer counts down and waits, and
// nothing happens until a thumb moves. An EMOM inverts that. The minute ends whether or not the
// work got done, the next one starts on top of it, and the whole training effect is the client
// racing a clock that does not care. So the screen cannot ask, and this module cannot be a queue
// with a cursor in it.
//
// The shape, and the vocabulary the rest of the code uses:
//
//   station   one exercise, at a fixed rep count, owning one window
//   window    how long a station gets. Sixty seconds, hence the name, but set per block
//   round     one pass through every station
//   minute    one window somewhere in the block. index 0 to stations x rounds - 1
//
// Emma's day is six stations of one minute each, five rounds, so thirty windows: twelve thrusters
// in minute one, twelve snatches in minute two, and back to thrusters in minute seven. Whatever is
// left of a window after the reps are done is the rest, which is why a station with a rep count a
// client cannot finish inside the window is a programming error rather than a thing this module
// should handle: it will simply never leave them any rest.
//
// NO FUNCTION HERE MAY CARE HOW OFTEN IT IS CALLED. That is not tidiness, it is the only version
// that survives the phone this runs on: a backgrounded tab is throttled to something like one
// callback a second and then not called at all when the screen locks, so anything that added a
// minute per firing would drift and then stop, and a drifting EMOM silently changes the workout.
//
// The model is a CURSOR, and it replaced one that derived everything from a single elapsed time.
// That earlier version was simpler and could not express the thing the coach asked for first: a
// button that adds a minute, so somebody who has fallen behind can catch up. With one offset into
// one uniform grid the station and the clock move together, so buying sixty seconds slid the block
// back to the previous lift. A window has to be able to be longer than its neighbours, and that
// means the schedule is a walk rather than a division.
//
// So a running block is three numbers:
//
//   windowsDone      how many windows have closed. Always equal to the rows written
//   windowStartedAt  wall clock ms when the window now running began
//   windowMs         how long the window now running gets: the block's window, plus any minute
//                    added to this one
//
// Catching up is a loop rather than a subtraction, and it is still exact. emomAdvance walks forward
// while the current window has ended, and every step moves windowStartedAt by a length this module
// chose rather than by a delta it measured. Called once after four silent minutes it emits four
// windows and lands exactly where four hundred calls would have. Nothing accumulates error because
// nothing is accumulated from the clock.
//
// It also makes the resume exact and nearly free: windowStartedAt is the last row's logged_at and
// windowsDone is the row count, so a reload reads the block's position straight off the append only
// log instead of reconstructing it. See emomResume.
//
// The consequence worth stating out loud: locking the phone does not pause the block, and must
// not. The clock in the room did not stop. A client who pockets their phone for ninety seconds
// comes back two stations further on, which is exactly what happened to them in the gym. Adding a
// minute is the only thing that moves the clock, and it takes a deliberate press.

import { instantOf } from './dates.js';

/** The default window. Sixty seconds is what the E, M and O in the name are about. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * A day's EMOM settings, or null for every other day in the app.
 *
 * Stored on `template_days.emom` as `{ rounds, window_seconds }`, beside `warmup`, which is the
 * other jsonb on that table holding something a day has rather than something a set has. Null,
 * absent, or a rounds count below one all mean the same thing and all answer null: this is an
 * ordinary day and the logging screen it already had is the right one.
 *
 * Tolerant of a malformed object for the reason sortedDays gives: a snapshot is frozen JSON that
 * the seed, the builder, an importer or a hand edit can all have written, and one bad field must
 * not take the logging screen down.
 */
export function emomSettings(day) {
  const raw = day?.emom;
  if (!raw || typeof raw !== 'object') return null;

  const rounds = Number(raw.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) return null;

  const window = Number(raw.window_seconds);
  const windowSeconds =
    Number.isFinite(window) && window > 0 ? Math.round(window) : DEFAULT_WINDOW_SECONDS;

  return { rounds, windowSeconds };
}

/**
 * The whole block: which stations, in what order, how many times round, how long a window.
 *
 * `items` is the day's items already sorted, which every caller has, since sortedItems is what
 * builds a day everywhere else in this app.
 *
 * `repsOf` is passed in rather than read here. What a station asks for is a program question and
 * js/program.js already owns the parsing of a Reps cell; duplicating a smaller version of it here
 * is how "12" and "40" end up meaning one thing on the logging screen and another in the builder.
 *
 * Returns null where the day is not an EMOM or has no stations. A block of nothing is not a block,
 * and the caller has to fall back to the ordinary screen rather than render an empty clock.
 */
export function emomBlock(day, items, repsOf) {
  const settings = emomSettings(day);
  if (!settings) return null;

  const stations = (items ?? []).map((item, order) => ({
    order,
    item,
    exerciseId: item.exercise_id,
    name: item.exercise?.name ?? 'Lift',
    reps: repsOf(item),
  }));
  if (!stations.length) return null;

  return {
    stations,
    rounds: settings.rounds,
    windowSeconds: settings.windowSeconds,
    windowMs: settings.windowSeconds * 1000,
    minutes: stations.length * settings.rounds,
  };
}


/** How long the block runs if nobody adds a minute to it, in milliseconds. */
export function emomDurationMs(block) {
  return block ? block.minutes * block.windowMs : 0;
}

/** Which station and which round a window index lands on. The block's whole geometry, in one place. */
export function emomMinuteAt(block, index) {
  const count = block.stations.length;
  return {
    index,
    round: Math.floor(index / count),
    stationIndex: index % count,
    station: block.stations[index % count],
  };
}

/**
 * A block that has not started. The press of the start control is what turns this into a clock.
 *
 * `windowStartedAt` is null rather than zero, so "not begun" cannot be confused with "begun at the
 * epoch". Everything below refuses a cursor in that state rather than dividing by it.
 */
export function emomCursor() {
  return { windowsDone: 0, windowStartedAt: null, windowMs: 0 };
}

/** Starts the clock now. Separate from emomCursor so the ready screen holds a real object. */
export function emomStart(block, now) {
  return { windowsDone: 0, windowStartedAt: now, windowMs: block.windowMs };
}

/**
 * Picks a running block back up from the rows it has already written.
 *
 * Exact, and exact for free, which is the part worth keeping. A row is written the instant a window
 * closes, so the newest row's `logged_at` IS the moment the window now running began, and the row
 * count IS how many windows have closed. There is nothing to reconstruct and nothing to infer: a
 * reload reads the block's position straight off the append only log, which is the only thing on
 * the device a reload cannot destroy. Same principle as replaySession on the ordinary screen.
 *
 * The one thing the rows cannot say is whether a minute had been added to the window that was
 * running when the phone died. That window comes back at its ordinary length, which errs toward
 * the clock the trainer prescribed rather than toward a bonus nobody can evidence.
 *
 * Returns null where nothing has been written, which is a block that has not finished its first
 * window. There is nothing to resume there: the caller starts it fresh.
 */
export function emomResume(block, rows) {
  let latest = null;
  let count = 0;

  for (const row of rows ?? []) {
    // Through instantOf, because logged_at reaches this module in two spellings and the Postgres
    // one is rejected outright by the strict ISO path. js/dates.js has the measurement.
    const at = instantOf(row?.logged_at);
    if (at === null) continue;
    count += 1;
    if (latest === null || at > latest) latest = at;
  }

  if (latest === null) return null;
  return { windowsDone: Math.min(count, block.minutes), windowStartedAt: latest, windowMs: block.windowMs };
}

/**
 * Gives the window now running one more window's worth of time.
 *
 * The whole of the catch up control. It lengthens the window somebody is standing in rather than
 * inserting a new one, so the station does not change, the round does not change, the block still
 * holds the same number of windows, and exactly one row is still written for this one. All that
 * moves is when this window ends, and therefore when every window after it does.
 *
 * That is why the cursor carries a length instead of the schedule being a division: a uniform grid
 * cannot hold one window that is longer than its neighbours, and every version of this that tried
 * to fake it by shifting a global offset moved the client back to the previous lift.
 *
 * Refused once the block is over and refused before it starts, both because there is no window
 * running to lengthen. Also refused when the window has already closed but nobody has drawn a frame
 * since: the row for it is about to be written, and stretching a window whose row is already owed
 * would hand the client a minute the log has no way to describe.
 */
export function emomAddMinute(block, cursor, now) {
  if (cursor.windowStartedAt === null) return cursor;
  if (cursor.windowsDone >= block.minutes) return cursor;
  if (now >= cursor.windowStartedAt + cursor.windowMs) return cursor;
  return { ...cursor, windowMs: cursor.windowMs + block.windowMs };
}

/**
 * Walks the cursor forward to now, and says which windows closed on the way.
 *
 * The catch up, and the only function that moves a cursor with time. A loop rather than a division
 * because windows are not all the same length once a minute has been added to one, and a loop
 * because this may be the first call in four minutes: the screen locked, the tab stopped being
 * called, and now everything has to be true again. Four windows closed while nobody was watching,
 * so four come back, in order, each carrying its station and round so the caller writes rows and
 * does no arithmetic of its own.
 *
 * Never drifts, however ragged the calls. Each step advances `windowStartedAt` by the length that
 * window actually had, so positions come from lengths this module chose rather than from deltas it
 * measured off the clock.
 *
 * Returns a NEW cursor. The caller holds one object and replaces it, so a half advanced cursor
 * cannot be left behind by a throw in the middle of the loop.
 */
export function emomAdvance(block, cursor, now) {
  if (cursor.windowStartedAt === null) return { cursor, due: [], done: false };

  let { windowsDone, windowStartedAt, windowMs } = cursor;
  const due = [];

  while (windowsDone < block.minutes && now >= windowStartedAt + windowMs) {
    due.push(emomMinuteAt(block, windowsDone));
    windowStartedAt += windowMs;
    windowsDone += 1;
    // Any minute added applied to the window it was added to, and to no other.
    windowMs = block.windowMs;
  }

  return {
    cursor: { windowsDone, windowStartedAt, windowMs },
    due,
    done: windowsDone >= block.minutes,
  };
}

/**
 * Where the block is, for drawing. Reads the cursor and never moves it.
 *
 * Split from emomAdvance on purpose. Drawing happens far more often than the schedule moves, and a
 * draw that could silently write rows would make every redraw a thing with consequences. The screen
 * advances first and then draws what it advanced to.
 *
 * `stretched` is whether a minute has been added to the window now running, which the screen says
 * out loud: a clock reading 1:47 on a block whose windows are a minute long is otherwise the app
 * looking broken.
 */
export function emomWhere(block, cursor, now) {
  const done = cursor.windowsDone >= block.minutes;
  // Past the end, the last window is what stays on screen. Clamping rather than running off means a
  // summary drawn a frame late names the lift that was actually last instead of sending the reader
  // back to the top of the block.
  const index = done ? block.minutes - 1 : cursor.windowsDone;
  const minute = emomMinuteAt(block, index);

  const started = cursor.windowStartedAt !== null;
  const remainingMs =
    done || !started ? 0 : Math.max(0, cursor.windowStartedAt + cursor.windowMs - now);

  return {
    ...minute,
    remainingMs,
    windowMs: started ? cursor.windowMs : block.windowMs,
    stretched: started && !done && cursor.windowMs > block.windowMs,
    running: started && !done,
    done,
  };
}

/**
 * What the clock reads, as m:ss.
 *
 * Rounded up, so a window shows 1:00 the moment it opens and never flashes a 0:59 that would make a
 * minute look short. The same reason tickRest ceils.
 */
export function emomClock(remainingMs) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * How long the block takes, said the way somebody reads it back in the builder.
 *
 * The number a trainer is actually checking when they set the rounds: six stations at five rounds is
 * half an hour, and that is the fact that tells them whether they meant five.
 */
export function emomLength(block) {
  if (!block) return '';
  const total = Math.round(emomDurationMs(block) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  // "0 min 32 sec" is not how anybody says half a minute. Only reachable with a short window, which
  // is exactly what somebody rehearsing a block sets, so it is the reading most likely to be seen
  // by whoever is checking this works.
  const clock = !minutes ? `${seconds} sec` : seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
  const stations = `${block.stations.length} station${block.stations.length === 1 ? '' : 's'}`;
  return `${block.rounds} round${block.rounds === 1 ? '' : 's'}, ${stations}, ${clock}`;
}
