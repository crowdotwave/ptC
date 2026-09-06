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
//
// The second control changes the BLOCK rather than the cursor, and that split is why both are
// cheap. How long this window gets lives on the cursor; how many windows there are lives on the
// block. So a round added or taken off mid effort moves neither the station nor the clock: the
// client is standing exactly where they were and the block now ends somewhere else. It is not
// written back to the program, because the number of rounds is the trainer's and a decision made on
// the floor is not an edit to what was asked for. What it does leave behind is rows, and a window
// in a round beyond the prescribed count is written `is_extra`, which is the same claim the Add set
// control makes on every other day: this is what was done, and it is not what was programmed.

import { instantOf } from './dates.js';

/** The default window. Sixty seconds is what the E, M and O in the name are about. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * As many rounds as the dial will go to.
 *
 * Not a judgement about how much anybody should train. It is the reach of a mis-tap: the round
 * control is two keys a client presses mid effort with a wet thumb, and without a ceiling a
 * fumbled press can put a three digit number into a line that reads "Round 3 of 214". Two digits
 * is more rounds than any block in this app will ever hold, and the key stops rather than
 * wrapping, so nothing has to be given back.
 */
export const EMOM_MAX_ROUNDS = 99;

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
    // What the trainer asked for, kept apart from what the block is currently set to, because the
    // client can move `rounds` mid block and this is the line that decides which windows were
    // beyond the prescription. See emomMinuteAt.
    prescribedRounds: settings.rounds,
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
  const round = Math.floor(index / count);
  return {
    index,
    round,
    stationIndex: index % count,
    station: block.stations[index % count],
    // A window in a round the client added is work beyond the prescription, and the row written for
    // it says so. Same claim `is_extra` carries on the ordinary screen: this is what was done, and
    // it is not what the program asked for. Decided here rather than by the caller, so the screen
    // and the row cannot disagree about which round is which.
    extra: round >= block.prescribedRounds,
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
 * The same block, run a different number of times.
 *
 * Changes the BLOCK and never the cursor, which is the whole difference between this and adding a
 * minute. A minute moves when the window now running ends. A round moves how many windows there
 * are, so the client stays exactly where they are standing and the block ends somewhere else.
 *
 * It writes nothing to the program and it cannot: `template_days.emom` belongs to the trainer, and
 * a client deciding on the floor to go round once more is not an edit to what they were asked to
 * do. It lasts for this block and no longer, which is what "on the fly" means. What survives it is
 * the rows, and the rows say which windows were beyond the prescription.
 */
export function emomWithRounds(block, rounds) {
  const held = Math.max(1, Math.min(EMOM_MAX_ROUNDS, Math.round(rounds)));
  return { ...block, rounds: held, minutes: block.stations.length * held };
}

/**
 * The fewest rounds this block can now be set to: the round the client is standing in.
 *
 * A round already begun cannot be given back. Half of it has been done, its windows have written
 * their rows, and there is no honest block that holds fewer windows than the log already describes.
 * Before the clock starts that is round one, so the same expression answers both screens.
 */
export function emomRoundFloor(block, cursor) {
  const index = Math.min(cursor.windowsDone, block.minutes - 1);
  return Math.floor(index / block.stations.length) + 1;
}

/**
 * One round more, or one fewer. The whole of the round control.
 *
 * Refuses rather than clamps, so a key that would do nothing can be drawn as disabled and a press
 * on it changes nothing at all: the caller compares the block it got back against the one it sent.
 *
 * Two refusals. Below the floor above, because the round now running has already happened. And on a
 * block that is over, which has no clock left to change and, on the logging screen, a session that
 * has already closed itself.
 *
 * A legal decrease can never end the block on the spot. The floor is the round now running, so the
 * smallest block this can produce still holds every window of that round, and the client always
 * finishes the round they are in. That is the property that keeps this from being a stop button
 * wearing a minus sign: ending early is a different control, on the workout panel, where it has
 * always been.
 */
export function emomChangeRounds(block, cursor, delta) {
  if (cursor.windowsDone >= block.minutes) return block;
  const wanted = block.rounds + delta;
  if (wanted < emomRoundFloor(block, cursor) || wanted > EMOM_MAX_ROUNDS) return block;
  return emomWithRounds(block, wanted);
}

/**
 * The block a session's rows need in order to hold them all.
 *
 * The resume half of the round control, and the same principle emomResume is built on: the rows are
 * the only thing on the device a reload cannot destroy, so the block is read back off them rather
 * than remembered. Thirty two rows against six stations is a client who added a sixth round, and
 * without this the block comes back at the prescribed thirty windows, emomResume clamps the cursor
 * to the end of it, and the screen declares a block done that the client is still standing in the
 * middle of.
 *
 * It only ever grows. A round the client took OFF leaves no trace in the rows, exactly as an added
 * minute leaves none, and both come back at the length the trainer prescribed. That errs toward the
 * program rather than toward a change nobody can evidence.
 */
export function emomBlockFor(block, rows) {
  let windows = 0;
  for (const row of rows ?? []) if (instantOf(row?.logged_at) !== null) windows += 1;

  const rounds = Math.ceil(windows / block.stations.length);
  return rounds > block.rounds ? emomWithRounds(block, rounds) : block;
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
    // Carried so the screen can grey the minus key off the same number emomChangeRounds refuses on,
    // rather than off a second copy of the rule that could disagree with it.
    roundFloor: emomRoundFloor(block, cursor),
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
  return `${block.rounds} round${block.rounds === 1 ? '' : 's'}, ${emomShape(block)}`;
}

/**
 * The same fact with the round count left off: "6 stations, 30 min".
 *
 * For the one screen where the rounds are already on display directly above this line, in a control
 * that changes them. "4 rounds" on a dial with "4 rounds, 4 stations, 16 min" underneath it is the
 * app saying the same number twice in two inches and inviting somebody to wonder whether they are
 * two different numbers.
 *
 * Split out rather than switched on a flag, so both readings are named things and emomLength is
 * still the whole sentence for the builder, which is setting the rounds and therefore has to say
 * what they came to.
 */
export function emomShape(block) {
  if (!block) return '';
  const total = Math.round(emomDurationMs(block) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  // "0 min 32 sec" is not how anybody says half a minute. Only reachable with a short window, which
  // is exactly what somebody rehearsing a block sets, so it is the reading most likely to be seen
  // by whoever is checking this works.
  const clock = !minutes ? `${seconds} sec` : seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
  const stations = `${block.stations.length} station${block.stations.length === 1 ? '' : 's'}`;
  return `${stations}, ${clock}`;
}
