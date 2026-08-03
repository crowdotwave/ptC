// What goes on the bar the very first time a client does a lift.
//
// This runs exactly once per client per exercise. After one logged session, prefill comes from
// history and this file is never consulted again for that lift.
//
// The rule: never invent a number that pretends to know how strong someone is.
//
// The trainer's starting_weight_kg is the real answer, and the program builder should ask for
// it. When it is blank, and it will be blank for a client nobody has watched lift yet, the app
// does not guess. It falls back to a fact about the equipment rather than a guess about the
// person: the empty bar weighs what it weighs, and the lightest thing a stack or a rack can
// hold is one increment.
//
// Both fallbacks are deliberately, obviously too light. That direction is safe and self
// correcting: a client who starts under their working weight taps the stepper a few times and
// is done inside one set. A client who starts over it fails a rep, or gets hurt, and learns
// that the app's numbers cannot be trusted. Erring light costs thirty seconds. Erring heavy
// costs the relationship.
//
// The number is also honest on screen, which is the point. Nobody mistakes an empty bar for a
// prescription, so the screen is not making a claim it cannot support.

/** A standard Olympic barbell. Not an estimate, a fact about the object. */
export const EMPTY_BARBELL_KG = 20;

/**
 * Returns { kg, source }, where source explains the number so the screen can say where it
 * came from rather than presenting a guess as a prescription.
 *
 *   'trainer'  the trainer set it when building the program
 *   'bar'      nobody set it, this lift uses a barbell, so start with the empty bar
 *   'lightest' nobody set it, so start with the least this equipment can hold
 */
export function openingWeight({ startingWeightKg = null, equipment = null, incrementKg = 2.5 } = {}) {
  if (typeof startingWeightKg === 'number' && Number.isFinite(startingWeightKg) && startingWeightKg > 0) {
    return { kg: startingWeightKg, source: 'trainer' };
  }

  const step = Number.isFinite(incrementKg) && incrementKg > 0 ? incrementKg : 2.5;

  if (equipment === 'barbell') {
    return { kg: EMPTY_BARBELL_KG, source: 'bar' };
  }

  return { kg: step, source: 'lightest' };
}

/** The line under the lift name on a first ever set. An invitation, never an apology. */
export function openingCopy(source) {
  switch (source) {
    case 'trainer':
      return 'First time on this lift. Your trainer set this starting weight.';
    case 'bar':
      return 'First time on this lift. Empty bar to start, work up from here.';
    default:
      return 'First time on this lift. Starting light, work up from here.';
  }
}
