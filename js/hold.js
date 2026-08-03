// Hold to repeat timing for the steppers.
//
// Split out of the screen so the acceleration curve is a value that can be asserted, not a
// feel that has to be trusted. The runtime and the tests use the same decay rule, so a change
// to the numbers cannot pass the tests while breaking the thumb.
//
// The shape: the first step lands on press, so a nudge is one tap. Repeating starts after a
// beat, so resting a thumb on the button does not run away. Then it accelerates to a floor,
// so crossing forty kilos is one hold rather than sixteen taps.

export const HOLD_DELAY_MS = 400;
export const HOLD_START_MS = 300;
export const HOLD_FLOOR_MS = 55;
export const HOLD_DECAY = 0.82;

/** The one decay rule. Used by the running stepper and modelled by holdTicks. */
export function nextHoldInterval(current) {
  return Math.max(HOLD_FLOOR_MS, current * HOLD_DECAY);
}

/**
 * Offsets in milliseconds from press at which a step fires, for a hold of a given length.
 * The zero is the immediate first step.
 */
export function holdTicks(durationMs) {
  const ticks = [0];
  let at = HOLD_DELAY_MS;
  let interval = HOLD_START_MS;
  while (at <= durationMs) {
    ticks.push(Math.round(at));
    at += interval;
    interval = nextHoldInterval(interval);
  }
  return ticks;
}
