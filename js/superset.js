// Which set comes next, once a superset is in the day.
//
// A trainer writes a superset by lettering rows: 1A, 1B, and the rows sharing a leading number are
// done together (parseGroup in js/program.js). Done together means alternating. Triceps, straight
// into biceps, rest, round two. The logging screen used to walk the plan in order, so a superset
// asked for every triceps set before the first biceps set, which is not the workout anybody wrote
// and not the one Clay does: he logged it out of order by hand, through the workout panel, twice a
// round.
//
// What this changes is the walk and nothing else. The plan stays in program order, one lift's sets
// together, because everything that counts sets, adds a set, swaps a lift or rebuilds a session
// after a locked phone reads the plan that way and is right to. Only the question "where does the
// cursor go after this set" learns about groups.
//
// The rule, for a set just finished on a lift inside a group:
//
//   1. A later lift in the group with a set still owed. That is the rest of this round, and it has
//      no rest before it: the point of a superset is going straight to the next lift.
//   2. Otherwise the round is over, so back to the first lift in the group with a set still owed,
//      and the rest timer runs. That is the next round.
//   3. Otherwise the group is finished, and the walk carries on after it exactly as for any lift.
//
// A warmup is the exception to rule 1: it is followed by the same lift's next set, since it is not
// half of a round. Uneven groups need no special case: a lift with fewer sets drops out of the
// rounds when it runs out, and the longer one carries on alone. A plain number is not a group. A trainer who wants two
// lifts done one after the other writes 2 and 3, not 2A and 2B, which is the convention 0026 wrote
// down before this file existed.
//
// Pure, and it takes a predicate rather than reading `status`, because the screen and the resume
// path ask "still owed" two different ways: the screen marks entries, and replaySession counts
// which entries a row has claimed.

import { parseGroup } from './program.js';

/**
 * The plan's lifts, in order, with the superset each one belongs to.
 *
 * A lift is a contiguous run of entries sharing an item, by identity, which is the same grouping
 * js/workout-view.js liftRuns makes. A superset is consecutive lifts whose set numbers share a
 * leading number and carry a letter. One lettered lift on its own is not a superset: there is
 * nothing to alternate with.
 */
export function supersetRuns(plan) {
  const lifts = [];
  plan.forEach((entry, index) => {
    const last = lifts[lifts.length - 1];
    if (last && last.item === entry.item) {
      last.entries.push(entry);
      last.to = index;
      return;
    }
    lifts.push({ item: entry.item, entries: [entry], from: index, to: index, group: null });
  });

  let run = [];
  const close = () => {
    if (run.length > 1) for (const lift of run) lift.group = run;
    run = [];
  };
  for (const lift of lifts) {
    const { group, isGrouped } = parseGroup(lift.item?.group_label);
    const previous = run[run.length - 1];
    const joins = isGrouped && previous && parseGroup(previous.item?.group_label).group === group;
    if (!joins) close();
    if (isGrouped) run.push(lift);
  }
  close();

  return lifts;
}

/** The lifts of the superset this entry's lift belongs to, in program order, or null. */
export function supersetOf(plan, entry) {
  const lift = supersetRuns(plan).find((candidate) => candidate.entries.includes(entry));
  return lift?.group ?? null;
}

/**
 * Where the cursor goes after the entry at `from`.
 *
 * `isOpen` says whether an entry is still owed. Returns `index`, -1 when nothing is owed anywhere,
 * and two facts the screen needs about the move:
 *
 *   rest      false only inside a round, so the screen does not count down between the two halves
 *             of a superset
 *   wrapped   true when the plain walk ran off the end of the day and came round to an earlier
 *             lift, which the screen says out loud. Going back to the top of a superset for the next
 *             round is not a wrap: it is the workout.
 */
export function nextAfter(plan, from, isOpen) {
  const lifts = supersetRuns(plan);
  const entry = plan[from];
  const lift = entry ? lifts.find((candidate) => candidate.entries.includes(entry)) : null;
  let after = from;

  // A warmup is not half of a round. It gets somebody ready for this lift's working sets, so the
  // next set is this lift's own, and the alternating starts with the first working set. Without
  // this an overhead press warmup went straight to the pulldown, before a single working set of
  // either.
  if (lift?.group && entry.isWarmup) {
    const own = lift.entries.find(isOpen);
    if (own) return { index: plan.indexOf(own), rest: true, wrapped: false };
  }

  if (lift?.group) {
    const members = lift.group;
    const at = members.indexOf(lift);
    const firstOpen = (member) => member.entries.find(isOpen) ?? null;

    for (let k = at + 1; k < members.length; k += 1) {
      const next = firstOpen(members[k]);
      if (next) return { index: plan.indexOf(next), rest: false, wrapped: false };
    }
    for (let k = 0; k <= at; k += 1) {
      const next = firstOpen(members[k]);
      if (next) return { index: plan.indexOf(next), rest: true, wrapped: false };
    }
    after = members[members.length - 1].to;
  }

  for (let i = after + 1; i < plan.length; i += 1) {
    if (isOpen(plan[i])) return { index: i, rest: true, wrapped: false };
  }
  for (let i = 0; i <= after && i < plan.length; i += 1) {
    if (isOpen(plan[i])) return { index: i, rest: true, wrapped: true };
  }
  return { index: -1, rest: false, wrapped: false };
}
