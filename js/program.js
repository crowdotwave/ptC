// Reading what a trainer typed in a spreadsheet cell.
//
// Every rule here came from counting the real thing: 306 exercise rows across 56 day blocks in
// eight real client workbooks. The counts are quoted where they decided something, because the
// next person to widen a rule should know what it currently covers.
//
// All eight use one identical seventeen column layout, which is what makes importing them
// possible at all. What is not identical is the wording: one workbook writes 'Day' and another
// 'DAY 1', one heads the second column 'Exercise' and another 'WORKING SETS'. Anchor on
// structure, never on a literal string.
//
// A correction to what an earlier version of this file claimed. Reading one workbook it said
// "that trainer prescribes effort, never load. Zero of 61 rows named a weight." True of that
// workbook, and false in general: across all eight, four rows do name one, as pound ranges like
// '25 - 45 LBS'. The weaker claim survives and is the one that matters, since 293 of 306 rows
// still prescribe effort or nothing, so supplying the actual weight is still the logging
// screen's job almost every time.

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

  // '8 PER SIDE'. A unilateral count, which is still a count: whatever follows is a note about
  // which limb, not a second number. 1 row.
  const perSide = text.match(/^(\d+)\s*(?:per|each)\b/i);
  if (perSide) return { low: Number(perSide[1]), high: Number(perSide[1]), text };

  // A distance or a duration: 50 FT, 500M, 10 MINS, 30 SEC, AMRAP. No rep count exists, so none
  // is invented. 23 of 306 rows land here.
  return { low: null, high: null, text };
}

/**
 * '90 SEC' -> 90, '2 MIN' -> 120, 'NA' -> null.
 *
 * The Rest column is not always rest. Sixteen rows across the eight workbooks hold a rep count
 * instead: '5 PER SIDE', '3 PER SIDE'. Read as a duration those became "5s rest" on the client's
 * screen, which is not a missing value but a wrong one, and a wrong rest is worse than none
 * because nobody thinks to doubt it. Anything naming a side is not a duration.
 */
export function parseRest(raw) {
  const text = (raw ?? '').toString().trim();
  if (!text || /^(na|n\/a)$/i.test(text)) return null;
  if (/\b(per|each)\b/i.test(text)) return null;

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

  // RIR is reps in reserve, so RPE is ten minus it, and a range takes the low end because fewer
  // reps left is the harder end of the effort. 174 of 306 rows. Searched rather than anchored so
  // '1- 2 RIR' and '3 - 5 RIR' both land.
  const rirRange = text.match(/(\d+)\s*-\s*(\d+)\s*RIR/i);
  if (rirRange) return { text, rpe: 10 - Number(rirRange[1]) };

  const rir = text.match(/(\d+)\s*RIR/i);
  if (rir) return { text, rpe: 10 - Number(rir[1]) };

  // RPE written directly, which the previous version ignored entirely: 29 rows across the eight
  // workbooks, every one of them silently losing its effort target.
  //
  // Written in both orders ('RPE 9' and '8 RPE'), as ranges ('RPE 8 - 9', '8-9 RPE'), and buried
  // inside a longer cell ('5 MINS RPE 3-4', 'RPE 7-8 - 10 MINS'). So this searches rather than
  // anchors, and the literal letters RPE are what make that safe.
  //
  // A range takes the high end, which is the harder end for RPE exactly as the low end is for
  // RIR. The two rules point the same way: whichever number means more effort.
  const rpeRange = text.match(/RPE\s*(\d+)\s*-\s*(\d+)|(\d+)\s*-\s*(\d+)\s*RPE/i);
  if (rpeRange) {
    const high = rpeRange[2] ?? rpeRange[4];
    return { text, rpe: Number(high) };
  }

  const rpe = text.match(/RPE\s*(\d+)|(\d+)\s*RPE/i);
  if (rpe) return { text, rpe: Number(rpe[1] ?? rpe[2]) };

  // Everything else, BW and MODERATE and '25 - 45 LBS' and 5-7 SPEED, has no effort target and
  // gets null rather than a guess.
  return { text, rpe: null };
}

/** True when the Load cell says the load is the body: BW, BODY WEIGHT, ASSISTED BW. 9 rows. */
export function isBodyweightLoad(raw) {
  return /\b(bw|body\s*weight)\b/i.test((raw ?? '').toString());
}

// A real quantity of weight, as opposed to a number that happens to be in the cell. '5-7 SPEED'
// is the reason this needs units rather than digits.
const LOAD_QUANTITY = /\d+(\.\d+)?\s*(kg|kgs|kilo|kilos|lb|lbs|pound|pounds|plate|plates)\b/i;

// Things you hold, named in the Adjust column. A band, a box or a height is not one of these.
const IMPLEMENT = /\b(dumbell|dumbbell|db|barbell|bb|kettlebell|kb|plate|plates|med\s*ball|medicine\s*ball|weight|weighted)\b/i;

/**
 * True when the Load cell names an external load rather than a pace or nothing at all.
 *
 * Three different things appear in that column and only two of them are a load: an effort target
 * ('1-2 RIR', 'RPE 8'), a real quantity ('2 PLATES', '25 - 45 LBS'), or a word about pace
 * ('MODERATE', '5-7 SPEED') which is not one. That third case is the whole reason this exists,
 * because it is what tells a loaded carry apart from a row erg, and on the sheet both of those
 * are a distance in the Reps column with no rep count anywhere.
 *
 * Bodyweight is deliberately false. The body is a load and it is not one anybody selects, and
 * isBodyweightLoad already routes those rows to a mode of their own.
 */
export function prescribesLoad(raw) {
  const text = (raw ?? '').toString().trim();
  if (!text || /^(na|n\/a)$/i.test(text)) return false;
  if (isBodyweightLoad(text)) return false;
  if (parseLoad(text).rpe !== null) return true;
  return LOAD_QUANTITY.test(text);
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
 * That last sentence was the documented rule for a long time and was not the implemented one: the
 * distance branch returned weight only whatever the Load cell said, so a 500m row erg and a 400m
 * ski erg and three 100m runs all came through asking a client to enter a weight for a machine
 * that has none. Measured on one real workbook, eight rows out of sixty one. prescribesLoad is
 * what makes the code say what the comment always said.
 *
 * Returns `certain` alongside, which is a claim about this function rather than about the row: it
 * is true when the two cells decided the answer between them and false when something had to be
 * assumed. The review screen flags on it. Flagging every row that is not weight and reps, which
 * is what it did before, marks a 30 second hold and a plain bodyweight push up as though they
 * needed a decision, and marking everything is the same as marking nothing.
 *
 * The trainer overrides any of this in the builder. This is only the opening guess.
 */
export function inferLogging({ repsText, loadText, adjustText, sets }) {
  const reps = parseReps(repsText);
  const load = (loadText ?? '').toString().trim();
  // The Adjust column names what the client changes between sets, so an implement in it is
  // evidence of a load in its own right. 'BW' beside 'DUMBELL' is a weighted jump squat, and
  // reading the Load cell alone there hides the dumbbell and asks a client to jump empty handed.
  const implement = IMPLEMENT.test((adjustText ?? '').toString());
  const loaded = prescribesLoad(load) || implement;
  const bodyweight = isBodyweightLoad(load) && !implement;
  const text = reps.text ?? '';

  // Seconds in the Reps column is a hold, not a distance: '30 SEC'. 6 rows. Minutes are
  // deliberately not included, because a Reps cell reading '10 MINS' is a cardio block rather
  // than something anybody holds.
  if (/^\d+\s*(sec|secs|second|seconds)\b/i.test(text)) {
    return { isLogged: true, logMode: 'time_hold', certain: true };
  }

  // AMRAP in the Reps column means as many reps as possible of this exercise, so it is a rep
  // count the client discovers rather than one the trainer set. Both rows carrying it are
  // bodyweight, which is why it is not the 'rounds' mode: rounds is a circuit, and this is one
  // exercise taken to failure.
  // Never certain: AMRAP names the reps and says nothing about what is in the hands.
  if (/^amrap$/i.test(text)) {
    return { isLogged: true, logMode: bodyweight ? 'bodyweight_reps' : 'weight_reps', certain: false };
  }

  // A pure interval: no reps, no sets, and the Load cell is a duration. Nothing to measure.
  if (reps.low === null && sets === null && /^\d+\s*(min|mins|minute|minutes|sec)/i.test(load)) {
    return { isLogged: false, logMode: 'weight_reps', certain: true };
  }

  if (reps.low !== null) {
    if (bodyweight) return { isLogged: true, logMode: 'bodyweight_reps', certain: true };
    // A rep count with an empty or unreadable Load cell cannot tell a loaded lift from a
    // bodyweight one, and both are ordinary. That is the guess worth showing somebody.
    return { isLogged: true, logMode: 'weight_reps', certain: loaded };
  }

  // A distance or a duration, so there are no reps to count. Whether it is a set at all is the
  // Load cell's answer: a carry or a sled has a weight on it and is the point of the row, an erg
  // or a run does not and is an instruction.
  if (reps.text) {
    if (loaded) return { isLogged: true, logMode: 'weight_only', certain: true };
    if (bodyweight) return { isLogged: true, logMode: 'bodyweight_reps', certain: false };
    return { isLogged: false, logMode: 'weight_reps', certain: true };
  }

  // Both cells empty. On a real sheet this is a note somebody typed in the exercise column, like
  // the '^REPEAT X10^' under a set of running intervals, and it is worth a human's eye because
  // what it needs is deleting rather than a log mode.
  return { isLogged: false, logMode: 'weight_reps', certain: false };
}

/** One spreadsheet row to the fields template_items wants. */
export function rowToItem({ number, exercise, adjust, sets, reps, load, rest }) {
  const parsedReps = parseReps(reps);
  const parsedLoad = parseLoad(load);
  const parsedSets = parseSets(sets);
  const group = parseGroup(number);
  const logging = inferLogging({ repsText: reps, loadText: load, adjustText: adjust, sets: parsedSets });

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
