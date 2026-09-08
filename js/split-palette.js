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
 * The hue window each block gets, and how far a day may move inside it.
 *
 * The first two are the pair CLAUDE.md already picked for slots 1 and 2 and for the same reason:
 * they are the widest apart the surface ceiling allows, so the commonest case (an A block and a B
 * block) gets the largest separation this palette has. Indigo is third. A fourth block gets no
 * hue, which is the same honest answer the old slot 4 gave, only now it is reached by a program
 * with four blocks rather than by a program with four days.
 *
 * `spread` is how far a day may move from its block's centre, and it is wider than it was. The
 * old comment here called it "deliberately small" so that two A days told apart only on
 * inspection, and that was the right ordering of the two questions reached by the wrong amount:
 * measured on a real five day block, twenty degrees across five days is five degrees a step, and
 * five degrees at this chroma is not a difference at all. A block of five is still obviously one
 * block at 32 degrees, because what says "these are all A days" is the hue FAMILY, and rose from
 * 306 to 338 is rose the whole way.
 *
 * The green block moved from 147 to 140, which shifts the ladder to 130..150 rather than 137..157.
 * That is the one thing here a wider spread would otherwise have broken. CLAUDE.md buys --done's
 * green its separation from --accent-data at 190 with 43 degrees and notes that --split-2-rim at
 * 150 is already down to 40, saved by a luminance factor of 3.4. Spreading around 147 would have
 * run the deep end of the block out to 157, which is 33, and eroding an argued thin margin by
 * accident is how a palette stops being defensible. Centred at 140 the whole ladder stays at 40
 * or better, and --done's own 147 is still inside it, so a filled cell and a finished session go
 * on being the same claim.
 *
 * `chromaLo` and `chromaHi` are the new channel. See dayColours. Both are well clear of the
 * colourless band's chroma, because the palest day of a block still has to read as a colour.
 */
const BLOCK_HUES = [
  { hue: 322, spread: 32, chromaLo: 0.068, chromaHi: 0.13 }, // rose
  { hue: 140, spread: 20, chromaLo: 0.056, chromaHi: 0.094 }, // green, and see above on 140
  { hue: 258, spread: 20, chromaLo: 0.062, chromaHi: 0.12 }, // indigo
  { hue: 285, spread: 0, chromaLo: 0.014, chromaHi: 0.014 }, // no hue left, and saying so
];

/**
 * The band a day falls in when this palette has run out of honest answers: no hue, and saying so.
 * Reached by a program with four blocks, and by a session logged with no program behind it at all.
 */
export const NEUTRAL_BLOCK = BLOCK_HUES.length - 1;

/**
 * The luminance window a cell face lives in, as relative luminance against the black base.
 *
 * The ceiling is CLAUDE.md's and is not negotiable: the glyph and the date sit ON this face, so
 * --text-primary has to clear 7:1 on it, and 0.0801 is where that boundary is. The floor is where
 * a cell stops reading as filled at all.
 *
 * The ceiling used here is a shade under that boundary rather than on it, and the margin is not
 * timidity. sRGB is eight bits a channel, so the colour the browser actually paints is the rounded
 * neighbour of the one this file asks for, and a face solved to land exactly on 0.0801 measured
 * 6.99 in test.js: the brightest day of the rose block failed the rule by one hundredth on a
 * rounding step. Ask for 0.0785 and every generated face clears 7 with the arithmetic and the
 * screen agreeing.
 *
 * The band is anchored to those two numbers now rather than to a pair of oklch lightness
 * constants, and that is where most of the ladder's missing range came from. One fixed lightness
 * band has to be set by the BRIGHTEST hue it will ever be used at, because green carries 72
 * percent of the luminance sum in sRGB against blue's 7 and so measures about a sixth brighter
 * than rose at the same lightness. The old pair, 0.405 down to 0.325, was set exactly that way:
 * safe for green, and it left rose running 0.062 to 0.031 when it could legally have run 0.080 to
 * 0.030. A five day block was spending two thirds of the room it had.
 *
 * So the endpoints are solved per day, at that day's own hue and chroma, and the ceiling holds by
 * construction rather than by a constant somebody has to keep true. test.js still measures it by
 * painting a pixel, because this file cannot be trusted about sRGB on its own evidence.
 */
const FACE_Y_TOP = 0.0785;
const FACE_Y_BOTTOM = 0.03;

/**
 * The rim and the chart stroke are NOT under that ceiling, and this is where the rest of the
 * separation came from.
 *
 * Nothing sits on a rim. It is a hairline plus the inset highlight along the top edge, so the 7:1
 * argument that caps the face says nothing about it, and it was being wasted: the rim used to be
 * the face plus a fixed 0.10, which carried exactly the face's own ladder and not a step more. On
 * a 46px tile lit along its top edge that hairline is a large share of what the eye actually gets.
 * Given its own wider ramp it separates two days of one block about forty percent harder than the
 * face does, for free, without going near a contrast floor.
 *
 * The line is the stroke on the work per session chart, drawn on the black base, and is free for
 * the same reason.
 */
const RIM_L_TOP = 0.6;
const RIM_L_BOTTOM = 0.44;
const LINE_L_TOP = 0.8;
const LINE_L_BOTTOM = 0.6;

/** Distributes n items across a span centred on zero. One item sits at the centre. */
function spreadAt(index, count, span) {
  if (count <= 1 || span === 0) return 0;
  return -span / 2 + (span * index) / (count - 1);
}

/** Where a day sits along its block's ladder. 0 is the top of it, 1 the bottom. */
function rampAt(index, count) {
  return count <= 1 ? 0 : index / (count - 1);
}

// --------------------------------------------------------------- sRGB, because the ceiling is in it
//
// Oklch is the space to reason in and sRGB is the space the rule is written in: relative
// luminance, and whether a colour exists at all. Both conversions below are the standard ones and
// neither is trusted on its own. test.js paints a pixel and reads it back, which is the only check
// that catches the browser disagreeing with this arithmetic.

const RAD = Math.PI / 180;

/** oklch to linear sRGB. A component outside 0..1 is outside the gamut. */
function toLinearRgb(l, c, h) {
  const a = c * Math.cos(h * RAD);
  const b = c * Math.sin(h * RAD);
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

/** Relative luminance of a colour as the screen will actually paint it, clipped to the gamut. */
function luminance(l, c, h) {
  const [r, g, b] = toLinearRgb(l, c, h).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The largest chroma at or below `c` that this hue and lightness can actually hold.
 *
 * Without it the deep end of the green block falls out of sRGB and the browser clips it, which
 * does not throw and does not look obviously wrong. What it does is quietly flatten the last two
 * days of that ladder into one colour, which is the bug this whole file exists to fix.
 */
function fitChroma(l, c, h) {
  const holds = (x) => toLinearRgb(l, x, h).every((v) => v >= -0.0005 && v <= 1.0005);
  if (holds(c)) return c;
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (holds(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The oklch lightness at which this hue and chroma reach a given luminance. */
function lightnessForLuminance(target, c, h) {
  let lo = 0.05;
  let hi = 0.85;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (luminance(mid, c, h) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The four values a day is drawn with: the lit face, the shaded face below it, the rim, and the
 * stroke its line takes on the work per session chart.
 *
 * Face, shade and rim are the lit slab treatment CLAUDE.md defines, unchanged, and the face stays
 * under the surface ceiling. What changed is how many channels move as a day walks down its
 * block's ladder.
 *
 * It used to be lightness and five degrees of hue, which measures 0.021 apart in oklab per step.
 * That was reported from use as the days of a block being one colour, and they nearly were: on the
 * screenshot that prompted this, A2 and A3 sat two cells apart in the same week and could not be
 * told apart at all. Three channels move now, all in the same direction, so the ladder still reads
 * as a ladder rather than as a scatter:
 *
 *   lightness  the full legal band rather than a fixed slice of it, solved per hue. See
 *              FACE_Y_TOP, which is where the extra range came from.
 *   chroma     pale at the top of the ladder, deep at the bottom. This is the new one, and it is
 *              the channel with the most room left, because nothing in the contrast rules is about
 *              saturation. A pale mauve beside a deep magenta survives a dimmed screen and a
 *              glance from arm's length in a way two adjacent purples never did.
 *   hue        as wide as each block's window allows, which is not much for green and is a fair
 *              amount for rose.
 *
 * That measures about 0.034 an oklab step against the old 0.021, and the rim, freed from the
 * face's ceiling, carries about 0.047 of its own on top.
 *
 * Returned as oklch strings rather than hex because the whole point here is controlling perceptual
 * lightness across a generated set, which is the thing hex makes you solve by hand. The rest of the
 * palette stays hex: those are fixed values that were measured once, and this is a function.
 */
export function dayColours({ blockIndex = 0, indexInBlock = 0, daysInBlock = 1 } = {}) {
  const band = BLOCK_HUES[Math.min(blockIndex, BLOCK_HUES.length - 1)];
  const t = rampAt(indexInBlock, daysInBlock);
  const hue = band.hue + spreadAt(indexInBlock, daysInBlock, band.spread);
  const chroma = band.chromaLo + (band.chromaHi - band.chromaLo) * t;

  const faceTop = lightnessForLuminance(FACE_Y_TOP, chroma, hue);
  const faceBottom = lightnessForLuminance(FACE_Y_BOTTOM, chroma, hue);
  const faceL = faceTop - (faceTop - faceBottom) * t;

  const say = (l, c) =>
    `oklch(${l.toFixed(3)} ${fitChroma(l, c, hue).toFixed(3)} ${hue.toFixed(1)})`;

  return {
    face: say(faceL, chroma),
    shade: say(faceL - 0.033, chroma),
    rim: say(RIM_L_TOP - (RIM_L_TOP - RIM_L_BOTTOM) * t, Math.min(chroma * 1.35, 0.15)),
    // Never on a surface, so the ceiling does not apply. Measured against --surface-base in
    // test.js the same way the faces are.
    line: say(LINE_L_TOP - (LINE_L_TOP - LINE_L_BOTTOM) * t, Math.min(chroma * 1.9, 0.19)),
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
