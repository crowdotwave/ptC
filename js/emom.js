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
// EVERYTHING HERE IS DERIVED FROM ELAPSED TIME. Nothing counts ticks, nothing accumulates, and no
// function here is allowed to care how often it is called. That is not tidiness, it is the only
// version that survives the phone this runs on: a backgrounded tab is throttled to something like
// one callback a second and then not called at all when the screen locks, so a counter that adds a
// minute per firing would drift and then stop. The rest timer already reads the wall clock for the
// same reason. Here it matters more, because a drifting EMOM silently changes the workout.
//
// The consequence worth stating out loud: locking the phone does not pause the block, and must
// not. The clock in the room did not stop. A client who pockets their phone for ninety seconds
// comes back two stations further on, which is exactly what happened to them in the gym.

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

/** How long the whole block runs, in milliseconds. */
export function emomDurationMs(block) {
  return block ? block.minutes * block.windowMs : 0;
}

/**
 * Where the block is, given how long it has been running.
 *
 * The single function the screen redraws from, and deliberately the only one that knows the
 * arithmetic. `elapsedMs` is now minus the moment the block started, and a negative value is
 * treated as zero rather than refused: a clock that has been set backwards is not a reason to
 * throw underneath somebody mid workout.
 *
 * `index` counts windows from zero across the whole block, so it keeps rising through the rounds
 * rather than resetting: minute seven of Emma's day is index 6, round 1, station 0.
 *
 * `done` is the block having run out of windows, which is a different question from whether every
 * minute has been logged. The screen asks the first and the logging asks the second, and conflating
 * them is how the last station of the last round gets dropped.
 */
export function emomAt(block, elapsedMs) {
  const total = block.minutes;
  const elapsed = Math.max(0, elapsedMs);
  const raw = Math.floor(elapsed / block.windowMs);

  // Past the end, the last window is what stays on screen. Clamping rather than reporting station
  // zero of round `rounds` means a summary drawn one frame late names the lift that was actually
  // last, instead of sending the reader back to the top of the block.
  const done = raw >= total;
  const index = done ? total - 1 : raw;
  const stationCount = block.stations.length;

  const intoWindow = elapsed - raw * block.windowMs;
  const remainingMs = done ? 0 : block.windowMs - intoWindow;

  return {
    index,
    round: Math.floor(index / stationCount),
    stationIndex: index % stationCount,
    station: block.stations[index % stationCount],
    remainingMs,
    elapsedInWindowMs: done ? block.windowMs : intoWindow,
    done,
    // How many windows have finished. This is what decides what gets written, and it is a count
    // rather than an event: see emomDue.
    completed: Math.min(total, raw),
  };
}

/**
 * The minutes that have finished and have not been written yet.
 *
 * Catch up rather than fire on a tick, and this is the heart of why the module looks like this. A
 * minute boundary is not an event this code can rely on being present for. The tab gets throttled,
 * the screen locks, the browser stops calling back entirely, and then the client picks the phone up
 * and everything has to be true again. Asking "which windows have ended that I have not logged"
 * answers that identically whether it has been called sixty times or once in four minutes, so a
 * locked phone comes back and writes the three stations it missed rather than losing them.
 *
 * `writtenCount` is how many of this block's minutes are already on disk. Rows, not a variable the
 * screen keeps: set_logs is append only and is the thing that survives a reload.
 *
 * Returns the minutes in order, each carrying the station and the round, so the caller writes rows
 * and does no arithmetic of its own.
 */
export function emomDue(block, elapsedMs, writtenCount) {
  const { completed } = emomAt(block, elapsedMs);
  const from = Math.max(0, writtenCount);
  const due = [];
  const stationCount = block.stations.length;

  for (let index = from; index < completed; index += 1) {
    due.push({
      index,
      round: Math.floor(index / stationCount),
      stationIndex: index % stationCount,
      station: block.stations[index % stationCount],
    });
  }
  return due;
}

/**
 * When the block started, worked out from the rows it has already written.
 *
 * A reload mid block must not restart the clock, and it must not trust a number the screen was
 * holding in memory, because that is the thing a reload destroys. Minute zero is written the
 * instant the first window ends, so the first row's `logged_at` is exactly one window after the
 * block began, and every row after it is one window further on. Reading the EARLIEST row and
 * subtracting one window is therefore exact, and it is exact from the append only log rather than
 * from anything mutable.
 *
 * The same trick js/session.js uses on the ordinary screen: the rows are enough to rebuild where
 * the client was, so nothing else needs to be durable.
 *
 * Returns null where nothing has been written yet. The caller holds the start time for that first
 * window and only that one, which is the only stretch of a block a reload can cost.
 */
export function emomStartedAt(block, rows) {
  let earliest = null;
  for (const row of rows ?? []) {
    // Through instantOf rather than Date.parse, because logged_at reaches this module in two
    // spellings and the Postgres one is rejected outright by the strict ISO path. js/dates.js has
    // the measurement. Parsing it here by hand read every synced row as unparseable, which would
    // have restarted a client's block from zero on the first reload after a sync.
    const at = instantOf(row?.logged_at);
    if (at === null) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest === null ? null : earliest - block.windowMs;
}

/**
 * What the clock reads, as m:ss.
 *
 * Rounded up, so a window shows 1:00 the moment it opens and never flashes a 0:59 that would make
 * a minute look short. The same reason tickRest ceils.
 */
export function emomClock(remainingMs) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * How long the block takes, said the way somebody reads it back in the builder.
 *
 * The number a trainer is actually checking when they set the rounds: six stations at five rounds
 * is half an hour, and that is the fact that tells them whether they meant five.
 */
export function emomLength(block) {
  if (!block) return '';
  const total = Math.round(emomDurationMs(block) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const clock = seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
  const stations = `${block.stations.length} station${block.stations.length === 1 ? '' : 's'}`;
  return `${block.rounds} round${block.rounds === 1 ? '' : 's'}, ${stations}, ${clock}`;
}
