// How many sets, and what numbers are on them.
//
// Two questions that look like one and are not, which is the whole reason this file exists apart
// from the screen that renders it.
//
//   how many sets   the trainer's target_sets, and nothing else
//   what is on them what this client did last time, set index for set index
//
// History used to answer both, by building the plan out of whatever rows last session happened to
// contain. That reads fine until a session is cut short. One set logged, the phone locks, and the
// next visit reads "Set 1 of 1" against a program that says four: the plan closed itself after a
// single log because a single log was the whole plan, and the shortened count then fed the visit
// after that. A prescription that shrinks every time somebody is interrupted is not one.
//
// So the count comes from the program and the numbers come from history, and where history is
// short of the count the shortfall is carried from the last set of that lift. Carried is not the
// same as remembered, and the entry says which it is, because "Last time 60 kg for 12" about a set
// that was never performed is the screen inventing a history it does not have.

/** The second number on a set_logs row, whichever of the three columns is carrying it. */
export function countOf(row) {
  return row?.reps ?? row?.rounds ?? row?.hold_seconds ?? 1;
}

/**
 * How many sets this item prescribes.
 *
 * `target_sets` is nullable: an importer writes null for a workbook cell reading NA, and the
 * builder allows a trainer to leave it blank. One is the floor rather than zero, because a lift
 * with no steppable set is a lift that silently vanishes from the day.
 */
export function setCountOf(item) {
  return Number.isInteger(item?.target_sets) && item.target_sets > 0 ? item.target_sets : 1;
}

/**
 * The planned sets for one exercise.
 *
 * `previous` is what js/history.js `lastPerformance` returned for this exercise, or null. `opening`
 * is what js/prefill.js decided for a lift with no history at all.
 *
 * Warmups are counted separately from the prescription. A trainer asking for four sets is asking
 * for four working sets, so a client who warms up twice gets six entries rather than four, and a
 * warmup logged last time keeps its place at the front.
 */
export function planForItem(item, previous, opening) {
  const logMode = item.log_mode ?? 'weight_reps';
  const setCount = setCountOf(item);

  if (previous && previous.bySetIndex.size) {
    const entries = [...previous.bySetIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([setIndex, row]) => ({
        item,
        setIndex,
        isWarmup: row.is_warmup === true,
        isExtra: false,
        logMode,
        weightKg: row.weight_kg,
        // Exactly one of the three columns carries the second number. Reading reps alone put a
        // literal null on the stepper for every carry, round and hold that had been done once.
        reps: countOf(row),
        lastWeightKg: row.weight_kg,
        lastReps: countOf(row),
        lastOn: previous.startedAt,
        carriedFrom: null,
        openingSource: null,
      }));

    const working = entries.filter((entry) => !entry.isWarmup);
    const from = working[working.length - 1] ?? entries[entries.length - 1];
    let setIndex = entries.reduce((max, entry) => Math.max(max, entry.setIndex), -1);

    for (let n = working.length; n < setCount; n += 1) {
      setIndex += 1;
      entries.push({
        ...from,
        setIndex,
        isWarmup: false,
        isExtra: false,
        lastWeightKg: null,
        lastReps: null,
        lastOn: null,
        carriedFrom: { weightKg: from.weightKg, reps: from.reps },
      });
    }

    return entries;
  }

  // No history for this lift, so this runs exactly once per client per exercise.
  //
  // A hold has no rep target at all, and a carry may not have one either, so the second stepper
  // needs an opening value that is not null. Ten seconds and one rep are both obviously too little
  // on purpose, the same bet the opening weight makes: erring low costs a few taps, erring high
  // costs a failed set.
  const openingCount = item.target_reps_low ?? (logMode === 'time_hold' ? 10 : 1);
  const entries = [];

  for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
    entries.push({
      item,
      setIndex,
      isWarmup: false,
      isExtra: false,
      logMode,
      // A lift with no external load opens at zero, which is the truth rather than a fallback.
      weightKg: logMode === 'bodyweight_reps' || logMode === 'time_hold' ? 0 : opening.kg,
      reps: openingCount,
      lastWeightKg: null,
      lastReps: null,
      lastOn: null,
      carriedFrom: null,
      openingSource: opening.source,
    });
  }

  return entries;
}
