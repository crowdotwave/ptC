// Which colour a program day gets, and why.
//
// This replaced four fixed slots. The old model had `SPLIT_SLOTS = 4` and assigned
// `Math.min(position, 3) + 1`, so days one to three took a hue each and EVERY day from the fourth
// on took the same colourless fourth. That was written for a six day program, where the overflow
// catches a tail of three and the glyph separates them. Measured against a real client running two
// blocks of five, the overflow caught seven days out of ten: most of the calendar was one grey, the
// lit bar on the top edge keys on the same number so it did not separate them either, and the
// legend (which keyed on the slot) printed ONE row for that grey and labelled it with whichever day
// happened to be seen first. The screen said a grey cell meant A5 UNILATERAL while B5 and B2 were
// drawing the same grey and appearing nowhere in the key.
//
// The fix is to stop asking hue to identify a DAY and let it identify a BLOCK.
//
// A ten day program has no ten distinguishable hues available, and CLAUDE.md's arithmetic for why
// is sound: these are surface faces, capped at the 7:1 boundary for --text-primary, and at that
// luminance the palette affords about three usable hue windows. But a ten day program does not have
// ten unrelated days in it. It has two blocks of five, and the trainer already says so in the day
// names. Block is the fact hue can carry honestly, and it is also the comparison the client
// actually makes: this block against the last one.
//
// So: hue says which block, a shift within that hue's window says which day of it, the glyph says
// exactly which day, and the legend now has a row per day rather than per colour. Four channels
// again, with the strong one carrying the fact it can actually hold.

/**
 * The block a day belongs to, read off the name the trainer typed.
 *
 * Blocks are not in the schema. `template_days` has `day_index` and `name` and nothing else, so
 * there is no structural field to read and the naming convention is the only signal there is.
 * "A2 LOWER" and "B2 PUSH/PULL" say the thing plainly; a leading letter followed by a digit is the
 * shape that means it, and it is narrow on purpose. "UPPER A" does NOT match, which is correct:
 * the A there is a variant marker on a single rotation, not a block, and treating it as one would
 * split the commonest four day program down the middle for no reason.
 *
 * Returns null when the name carries no such prefix, and the caller then treats the whole program
 * as one block. That is the honest reading of a program that never said it had blocks.
 */
export function blockOf(label) {
  const match = /^([A-Za-z])\d/.exec(String(label ?? '').trim());
  return match ? match[1].toUpperCase() : null;
}

/**
 * The hue window each block gets, in oklch degrees.
 *
 * The first two are the pair CLAUDE.md already picked for slots 1 and 2 and for the same reason:
 * they are the widest apart the surface ceiling allows, 175 degrees, so the commonest case (an A
 * block and a B block) gets the largest separation this palette has. Indigo is third. A fourth
 * block gets no hue, which is the same honest answer the old slot 4 gave, only now it is reached
 * by a program with four blocks rather than by a program with four days.
 *
 * `spread` is how far a day may move from its block's centre. It is deliberately small: the reader
 * has to be able to tell an A day from a B day instantly and two A days apart only on inspection,
 * because that is the order those two questions get asked in.
 */
const BLOCK_HUES = [
  { hue: 322, chroma: 0.085, spread: 20 }, // rose
  { hue: 147, chroma: 0.085, spread: 20 }, // emerald, --done's hue. See the note in CLAUDE.md
  { hue: 262, chroma: 0.075, spread: 18 }, // indigo
  { hue: 285, chroma: 0.012, spread: 0 }, // no hue left, and saying so
];

/**
 * The band a day falls in when this palette has run out of honest answers: no hue, and saying so.
 * Reached by a program with four blocks, and by a session logged with no program behind it at all.
 */
export const NEUTRAL_BLOCK = BLOCK_HUES.length - 1;

/**
 * The face lightness window, in oklch L.
 *
 * This is the one number that is not free. CLAUDE.md fixes the ceiling at the exact 7:1 boundary
 * for --text-primary on a cell face, because the glyph and the date sit on it, with a soft floor
 * near a fifth of that. In oklch those land at about L 0.40 and L 0.28, and the range is checked by
 * measurement rather than by trusting this comment: test.js walks every generated face and asserts
 * the ratio on it.
 *
 * Days inside a block are spread across it from the top down, so the first day of a block is its
 * brightest. That gives the within block ordering a direction rather than a scatter.
 *
 * Set by measurement, and the measurement had to be fixed first. An earlier pass read the ratio off
 * getComputedStyle, which hands an oklch() colour straight back, so three numbers were parsed as RGB
 * with the HUE landing in the blue channel: it reported a confident 5.54 for every face on the grid
 * and the correction made from it was worthless. The check paints a pixel now.
 *
 * Measured properly the band runs Y 0.031 to 0.070, against that 0.0801 ceiling and a soft floor
 * near 0.030 below which a cell stops reading as filled at all. The TOP is set by the brightest hue
 * rather than by an average: green carries most of the luminance in sRGB, so at one oklch L the
 * emerald block measures about a sixth brighter than the rose one, and pinning the top to the rose
 * would put every B day over the line.
 */
const FACE_L_TOP = 0.405;
const FACE_L_BOTTOM = 0.325;

/** Distributes n items across a span centred on zero. One item sits at the centre. */
function spreadAt(index, count, span) {
  if (count <= 1 || span === 0) return 0;
  return -span / 2 + (span * index) / (count - 1);
}

function lightnessAt(index, count) {
  if (count <= 1) return FACE_L_TOP;
  return FACE_L_TOP - ((FACE_L_TOP - FACE_L_BOTTOM) * index) / (count - 1);
}

/**
 * The four values a day is drawn with: the lit face, the shaded face below it, the rim, and the
 * stroke its line takes on the work per session chart.
 *
 * Face, shade and rim are the lit slab treatment CLAUDE.md defines, unchanged, and they stay under
 * the surface ceiling. The LINE is not a surface and never touches one, so it is free to be bright,
 * and it has to be: it is a 2px stroke on the black base rather than a 44px filled square.
 *
 * Returned as oklch strings rather than hex because the whole point here is controlling perceptual
 * lightness across a generated set, which is the thing hex makes you solve by hand. The rest of the
 * palette stays hex: those are fixed values that were measured once, and this is a function.
 */
export function dayColours({ blockIndex = 0, indexInBlock = 0, daysInBlock = 1 } = {}) {
  const band = BLOCK_HUES[Math.min(blockIndex, BLOCK_HUES.length - 1)];
  const hue = band.hue + spreadAt(indexInBlock, daysInBlock, band.spread);
  const l = lightnessAt(indexInBlock, daysInBlock);
  const c = band.chroma;

  return {
    face: `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${hue.toFixed(1)})`,
    shade: `oklch(${(l - 0.035).toFixed(3)} ${c.toFixed(3)} ${hue.toFixed(1)})`,
    rim: `oklch(${(l + 0.10).toFixed(3)} ${(c * 1.25).toFixed(3)} ${hue.toFixed(1)})`,
    // Never on a surface, so the ceiling does not apply. Measured against --surface-base in
    // test.js the same way the faces are.
    line: `oklch(${(l + 0.36).toFixed(3)} ${(c * 1.7).toFixed(3)} ${hue.toFixed(1)})`,
  };
}

/**
 * The inline style a cell, a legend mark or a chart line carries.
 *
 * One string, built once per day, so a cell and the line for that same day cannot be handed
 * different colours by two different call sites. That was already the rule when this was a class
 * name; it survives the move to generated values.
 */
export function dayStyle(colours) {
  return (
    `--cal-face:${colours.face};--cal-shade:${colours.shade};` +
    `--cal-rim:${colours.rim};--cal-line:${colours.line}`
  );
}

/**
 * Assigns every day of a program its block and its place inside that block.
 *
 * Keyed on the order the trainer put the days in, not on the label and not on order of first
 * appearance, for the reason the old slot assignment gave and which has not changed: a renamed day
 * must not change colour, and logging a new day must not repaint the months already on screen.
 */
export function assignBlocks(labels) {
  const blocks = labels.map(blockOf);
  const distinct = [...new Set(blocks.filter(Boolean))].sort();

  // One block, or none named, means the program never claimed to have blocks. Everything goes in
  // the first band and separates by lightness and the glyph.
  const useBlocks = distinct.length > 1;
  const order = useBlocks ? distinct : [null];

  const counts = new Map();
  for (const b of blocks) {
    const key = useBlocks ? b : null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const seen = new Map();
  return labels.map((label, i) => {
    const key = useBlocks ? blocks[i] : null;
    // A day with no prefix in a program that otherwise has blocks is its own thing, not a member of
    // the first one. It takes the colourless band, which is the same answer this palette gives
    // anywhere else it has run out of honest options.
    const found = order.indexOf(key);
    const blockIndex = found >= 0 ? found : BLOCK_HUES.length - 1;
    const indexInBlock = seen.get(key) ?? 0;
    seen.set(key, indexInBlock + 1);
    return {
      block: key,
      blockIndex,
      indexInBlock,
      daysInBlock: counts.get(key) ?? 1,
    };
  });
}
