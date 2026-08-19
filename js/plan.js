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

/**
 * The smallest load change a lift can make: the live answer where there is one, the frozen answer
 * where there is not.
 *
 * Live first, and that part is deliberate. The increment describes the equipment in the room
 * rather than the program, so a gym that swaps a stack should reach an assignment written months
 * ago. What was missing is the other half: a client who cannot read the exercise row got no
 * increment at all and every stepper on the screen fell back to 2.5 kg.
 *
 * That is not a hypothetical reader. `exercises_select` hands a client the global rows, their own
 * trainer's rows, and nothing else, so the moment a program is built out of a second trainer's
 * exercises, the person doing the program cannot see a single one of them. Same for anybody whose
 * coach changes. The snapshot has carried increment_kg since it was first written, precisely so a
 * phone is never dependent on reaching the library, and this was the one place still reaching.
 *
 * Both callers go through here rather than each writing the fallback, because this file is full of
 * comments about expressions that existed in several places with different endings, and the load
 * on the bar and the size of the tap that changes it must never be two different answers.
 */
export function incrementOf(item, live) {
  return live ?? item?.exercise?.increment_kg ?? null;
}

/** The second number on a set_logs row, whichever of the three columns is carrying it. */
export function countOf(row) {
  return row?.reps ?? row?.rounds ?? row?.hold_seconds ?? 1;
}

/**
 * What the steppers read after a set is logged.
 *
 * The plan prefills each set from last session, which is right for the first set of a lift and
 * wrong for every set after it once the client has changed something. Taking the next entry's
 * number unconditionally meant a deliberate adjustment survived exactly one tap: set one logged at
 * 40 lb, set two back at the opening weight, and the client re-doing the same correction three
 * more times. Measured on a real workout, a first ever lift logged 40, 5.5, 5.5, 5.5 pounds,
 * because with no history every set opens at the deliberately too light fallback and only the
 * first one got fixed.
 *
 * So a number the client moved this session beats a number from last session, and a number they
 * left alone does not. That second half is what keeps a ramp intact: last session's 60, 65, 70
 * still steps 60, 65, 70 when it is being repeated, because nothing was moved. Comparing against
 * what the plan asked for, rather than tracking whether the stepper was touched, means changing a
 * number and changing it back is the same as never touching it, which is what it looks like.
 *
 * Weight and reps are decided separately. Dropping the reps on a set says nothing about the load.
 *
 * The carry stops at the lift, and at the boundary between warmups and working sets. Carrying a
 * warmup's load into the first working set would be the app talking somebody down off their
 * working weight, which is the one direction the prefill rules are careful never to err in.
 *
 * The lift is the item, not the exercise. Those are the same thing right up until a trainer
 * programs one exercise twice in a day, which is how every superset in this app's real programs is
 * written: 1A a 45 second back extension hold, 1B back extension for 12 to 15, one exercise and
 * two rows. Comparing exercise ids called those one lift, so the hold's numbers carried into the
 * reps, and a hold has no rep count to carry. Every other place that asks "same lift" already asks
 * it by item identity, liftRuns and runOf both, so this was the one left comparing something else.
 */
export function nextSteppers(logged, from, next) {
  if (!next) return null;

  const continues =
    Boolean(from) &&
    next.item === from.item &&
    next.isWarmup === from.isWarmup;

  return {
    weightKg: continues && logged.weightKg !== from.weightKg ? logged.weightKg : next.weightKg,
    reps: continues && logged.reps !== from.reps ? logged.reps : next.reps,
  };
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
