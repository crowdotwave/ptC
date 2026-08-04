// Reading what a trainer typed in a spreadsheet cell.
//
// Every rule here came from counting the real thing: 61 exercise rows across 10 day blocks in
// one trainer's workbook. The counts are quoted where they decided something, because the next
// person to widen a rule should know what it currently covers.
//
// The governing fact: that trainer prescribes effort, never load. Zero of 61 rows named a
// weight. The Load column said RIR on 37, BW or MODERATE or a duration on the rest. So the
// weight a client actually used is not in the program at all, and supplying it is the entire
// job of the logging screen.

/** '8' -> 8/8, '6-8' -> 6/8, '50 FT' -> null. Text is always kept as typed. */
export function parseReps(raw) {
  const text = (raw ?? '').toString().trim();
  // NA is the trainer saying there is nothing here, not a value to show. Passing it through
  // would put a literal 'N/A' on the client's screen where the target goes.
  if (!text || /^(na|n\/a)$/i.test(text)) return { low: null, high: null, text: null };

  const range = text.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return { low: Number(range[1]), high: Number(range[2]), text };

  const single = text.match(/^(\d+)$/);
  if (single) return { low: Number(single[1]), high: Number(single[1]), text };

  // A distance or a duration: 50 FT, 500M, 10 MINS. No rep count exists, so none is invented.
  return { low: null, high: null, text };
}

/** '90 SEC' -> 90, '2 MIN' -> 120, 'NA' -> null. */
export function parseRest(raw) {
  const text = (raw ?? '').toString().trim();
  if (!text || /^(na|n\/a)$/i.test(text)) return null;

  const m = text.match(/^(\d+)\s*(sec|s|min|mins|minute|minutes)?\b/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] || 'sec').toLowerCase();
  return unit.startsWith('min') ? value * 60 : value;
}

/**
 * RIR is reps in reserve, so RPE is ten minus it. A range takes the harder end, because
 * '1-2 RIR' means stop with one or two left and the target is the top of that effort.
 *
 * Everything else, BW and MODERATE and 5-7 SPEED, has no RPE and gets null rather than a guess.
 */
export function parseLoad(raw) {
  const text = (raw ?? '').toString().trim();
  if (!text || /^(na|n\/a)$/i.test(text)) return { text: text || null, rpe: null };

  const range = text.match(/^(\d+)\s*-\s*(\d+)\s*RIR$/i);
  if (range) return { text, rpe: 10 - Number(range[1]) };

  const single = text.match(/^(\d+)\s*RIR$/i);
  if (single) return { text, rpe: 10 - Number(single[1]) };

  return { text, rpe: null };
}

/** 'NA' or blank -> null, otherwise the count. 14 of 61 rows had no set count. */
export function parseSets(raw) {
  const text = (raw ?? '').toString().trim();
  const m = text.match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** '1A' -> group '1', '2' -> group '2'. Rows sharing a group are a superset or a circuit. */
export function parseGroup(raw) {
  const text = (raw ?? '').toString().trim().toUpperCase();
  const m = text.match(/^(\d+)([A-Z])?$/);
  if (!m) return { label: text || null, group: null, isGrouped: false };
  return { label: text, group: m[1], isGrouped: Boolean(m[2]) };
}

/**
 * How a row should be logged, from what the trainer wrote.
 *
 * A rep count means the normal weight and reps. A distance or a duration with a real load
 * prescription means the weight is the point and there are no reps, so weight only. Anything
 * with no load prescription at all is instruction, not a set, and is not logged.
 *
 * The trainer overrides any of this in the builder. This is only the opening guess.
 */
export function inferLogging({ repsText, loadText, sets }) {
  const reps = parseReps(repsText);
  const load = (loadText ?? '').toString().trim();
  const hasLoad = Boolean(load) && !/^(na|n\/a)$/i.test(load);

  // A pure interval: no reps, no sets, and the Load cell is a duration. Nothing to measure.
  if (reps.low === null && sets === null && /^\d+\s*(min|mins|minute|minutes|sec)/i.test(load)) {
    return { isLogged: false, logMode: 'weight_reps' };
  }

  if (reps.low !== null) return { isLogged: true, logMode: 'weight_reps' };
  if (reps.text && hasLoad) return { isLogged: true, logMode: 'weight_only' };
  if (reps.text) return { isLogged: true, logMode: 'weight_only' };
  return { isLogged: false, logMode: 'weight_reps' };
}

/** One spreadsheet row to the fields template_items wants. */
export function rowToItem({ number, exercise, adjust, sets, reps, load, rest }) {
  const parsedReps = parseReps(reps);
  const parsedLoad = parseLoad(load);
  const parsedSets = parseSets(sets);
  const group = parseGroup(number);
  const logging = inferLogging({ repsText: reps, loadText: load, sets: parsedSets });

  return {
    group_label: group.label,
    variation: (adjust ?? '').toString().trim() || null,
    target_sets: parsedSets,
    target_reps_low: parsedReps.low,
    target_reps_high: parsedReps.high,
    target_reps_text: parsedReps.text,
    target_load: parsedLoad.text,
    target_rpe: parsedLoad.rpe,
    rest_seconds: parseRest(rest),
    is_logged: logging.isLogged,
    log_mode: logging.logMode,
    exerciseName: (exercise ?? '').toString().trim(),
  };
}

/** What the client sees under the lift name, built from whatever the trainer actually gave. */
export function targetLine(item) {
  const bits = [];
  if (item.target_sets) bits.push(`${item.target_sets} sets`);
  if (item.target_reps_text) bits.push(item.target_reps_text);
  if (item.target_load) bits.push(item.target_load);
  if (item.rest_seconds) bits.push(`${item.rest_seconds}s rest`);
  return bits.join(', ');
}
