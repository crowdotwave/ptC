// Reading set_logs correctly. Shared by the logging screen, the seed, and the dev harness,
// because getting "which rows still count" wrong in one place and right in another is how a
// number on a chart stops matching the number on the screen.

/** Epley. State the formula anywhere this number is shown. */
export function epley1rm(weightKg, reps) {
  return Math.round(weightKg * (1 + reps / 30) * 100) / 100;
}

/**
 * set_logs is append only, so a row is never edited or removed. Two later rows can cancel it:
 *
 *   a correction  writes a new row with supersedes_id pointing at the original
 *   a retraction  does the same and sets is_void, which is what undo writes
 *
 * A row still counts when nothing supersedes it and it is not itself a retraction.
 */
export function activeSetLogs(rows) {
  const superseded = new Set(rows.map((row) => row.supersedes_id).filter(Boolean));
  return rows.filter((row) => !superseded.has(row.id) && !row.is_void);
}

/**
 * The most recent session in which this exercise was actually performed, as a map of
 * set_index to the row logged at that index. This is what the logging screen prefills from,
 * so it has to mean exactly "that exact exercise and set index, last time".
 */
export function lastPerformance(rows, sessionStartById) {
  const live = activeSetLogs(rows);
  if (!live.length) return null;

  let bestSessionId = null;
  let bestStart = null;
  for (const row of live) {
    const start = sessionStartById.get(row.session_id);
    if (start === undefined) continue; // another client's session, not ours to read
    if (bestStart === null || start > bestStart) {
      bestStart = start;
      bestSessionId = row.session_id;
    }
  }
  if (!bestSessionId) return null;

  const bySetIndex = new Map();
  for (const row of live) {
    if (row.session_id === bestSessionId) bySetIndex.set(row.set_index, row);
  }
  return { sessionId: bestSessionId, startedAt: bestStart, bySetIndex };
}

/** Best estimated 1RM ever recorded on this exercise, ignoring warmups. Null when none. */
export function bestEstimated1rm(rows, sessionStartById) {
  let best = null;
  for (const row of activeSetLogs(rows)) {
    if (row.is_warmup) continue;
    if (sessionStartById && !sessionStartById.has(row.session_id)) continue;
    const value = epley1rm(row.weight_kg, row.reps);
    if (best === null || value > best) best = value;
  }
  return best;
}
