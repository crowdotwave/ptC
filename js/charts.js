// SVG for the three progression views. No library, no build step, same as everything else.
//
// The encoding rules from CLAUDE.md are enforced here, not left to whoever calls this:
//
//   no hue only        every series carries a stroke width, a dash pattern, or a marker shape
//                      in addition to its colour, and a text label where there is room
//   no intensity only  the cyan ladder is close in luminance by measurement, so weight and
//                      shape do the separating and colour only tints
//   deloads            dashed, labelled in words, and never counted toward a trend
//   glow               on strokes and fills, through drop-shadow, never on or behind text
//
// Axis honesty. Bars start at zero, always, because bar length encodes magnitude and a
// truncated bar lies about the ratio between two bars. Reps start at zero too, since the range
// is a handful of integers and zero costs nothing. The strength line does not start at zero,
// because a line encodes change rather than magnitude and a zero based axis would flatten six
// months of real work into the top tenth of the box. Its floor is drawn and labelled instead,
// so the baseline is stated rather than implied.
//
// Axis LEGIBILITY is a separate matter, and it was the one thing here that was actually wrong.
// Every chart carried two numbers, the top of the box and the bottom, with nothing between them.
// That is enough to see a direction and not enough to read a value: an estimated 1RM two thirds of
// the way up a box running 96 to 118 has to be worked out rather than read, and reading it is the
// entire reason somebody opened this screen. So every y axis now carries countable rules on round
// numbers, chosen in the unit on screen rather than in kilograms, and the latest point prints the
// number it landed on. See niceStep and axisTicks.

const NS = 'http://www.w3.org/2000/svg';

import { weightLabel, toDisplay } from './units.js';

/**
 * Axis ticks are bare numbers, so they convert without gaining a unit: the headline above the
 * chart already says which one.
 *
 * Every y axis in this file works in DISPLAY units rather than in kilograms, and that is the one
 * subtlety worth stating. Round kilograms are not round pounds: a tidy 5 kg step reads 11, 22, 33
 * on a pound axis, which is a grid of numbers nobody would ever say out loud. So the series is
 * converted once, up front, the axis is chosen against those numbers, and kilograms never appear
 * below this line. `scale` is what does the converting, and it is the identity for reps and
 * seconds, which are not weights and never convert.
 */
const axisNum = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString();

const esc = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function linear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * A step a person would count in: 1, 2, 2.5 or 5 times a power of ten.
 *
 * These charts shipped with two axis labels, one at the top of the box and one at the bottom, and
 * nothing between them. That is enough to say which way a line went and not enough to say what any
 * point on it is worth, which is the question somebody actually has when they open this screen: an
 * estimated 1RM sitting two thirds of the way up a box labelled 96 and 118 has to be arithmetic
 * rather than read. Rules the eye can count against fix that, and a rule is only countable if it
 * lands on a number worth saying.
 */
function niceStep(span, target, integer = false) {
  const raw = span / Math.max(1, target);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // 2.5 is dropped on a counting axis rather than rounded off afterwards. Rounding it gives a
  // step of 3, so a rep axis reads 0, 3, 6, 9, and nobody thinks about reps in threes.
  const step = integer
    ? norm > 5
      ? 10
      : norm > 2
        ? 5
        : norm > 1
          ? 2
          : 1
    : norm > 5
      ? 10
      : norm > 2.5
        ? 5
        : norm > 2
          ? 2.5
          : norm > 1
            ? 2
            : 1;
  return step * mag;
}

/**
 * A domain widened out to whole steps, and the rules inside it.
 *
 * Widening rather than labelling the raw extremes is what puts the top and bottom rules on the
 * edges of the box, so the plot area is bounded by two numbers instead of floating between them.
 *
 * `integer` is for the axes that count things. Reps and sessions have no half, and a rule at 3.5
 * reps is a rule measuring nothing.
 */
function axisTicks(lo, hi, { target = 4, integer = false } = {}) {
  const span = hi - lo || Math.abs(hi) || 1;
  let step = Math.max(integer ? 1 : 0, niceStep(span, target, integer));
  if (!(step > 0) || !Number.isFinite(step)) return { domain: [lo, lo + 1], ticks: [lo] };

  let from = Math.floor(lo / step) * step;
  let count = Math.max(1, Math.round((Math.ceil(hi / step) * step - from) / step));

  // Too many rules is answered by a wider step, never by dropping rules off the top. Capping the
  // count and keeping the step would leave the domain short of the data, and a point above the
  // domain does not vanish: the SVG does not clip, so it draws outside its own box, above an axis
  // that says it cannot be there. Bounded so a pathological input cannot spin here.
  for (let guard = 0; count > 12 && guard < 24; guard += 1) {
    step *= 2;
    from = Math.floor(lo / step) * step;
    count = Math.max(1, Math.round((Math.ceil(hi / step) * step - from) / step));
  }

  const ticks = [];
  for (let i = 0; i <= count; i += 1) ticks.push(Math.round((from + i * step) * 1e6) / 1e6);
  return { domain: [from, from + count * step], ticks };
}

/**
 * The horizontal rules and their labels, as one block.
 *
 * Labels are right aligned against the plot's left edge rather than jammed against x=0, so a
 * three digit volume and a single digit rep count end on the same pixel and the axis reads as a
 * column instead of as ragged text.
 */
function gridBlock(ticks, y, { left, right, format = axisNum }) {
  let out = '';
  for (const tick of ticks) {
    const gy = y(tick);
    out +=
      `<line class="chart__grid" x1="${left}" y1="${gy.toFixed(1)}" ` +
      `x2="${right}" y2="${gy.toFixed(1)}" />`;
    out +=
      `<text class="chart__axis" x="${left - 8}" y="${(gy + 4).toFixed(1)}" ` +
      `text-anchor="end">${esc(format(tick))}</text>`;
  }
  return out;
}

function timeDomain(points) {
  const times = points.map((p) => Date.parse(p.date));
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  // A single point, or several on one day, would give a zero width domain.
  return hi === lo ? [lo - 86400000, hi + 86400000] : [lo, hi];
}

function shortDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function svgOpen(width, height, title) {
  return (
    `<svg class="chart__svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${esc(title)}">`
  );
}

function widthOf(container, fallback = 328) {
  const w = Math.floor(container.getBoundingClientRect().width);
  return w > 40 ? w : fallback;
}

/**
 * The reader's own selection, drawn on top of a series.
 *
 * A day tapped on the consistency grid focuses the session it holds, on every chart at once. That
 * is not a filter: the charts keep drawing the whole history, because a single session on its own
 * is one dot with nothing to compare it against, and comparing is the entire reason somebody
 * tapped a day.
 *
 * WHY THIS IS WHITE AND NOT A COLOUR. Every hue in this file encodes something about the training:
 * cyan is the series, --pr is a record, --deload is a planned back off week, the slot faces are
 * which program day. A selection is not a fact about the training at all, it is a fact about what
 * the person holding the phone is looking at, so it gets the ink the numbers are written in rather
 * than a fifth meaning added to a palette CLAUDE.md says to measure before extending.
 *
 * It also has to be told apart from the record ring, which is the one other ring on these charts.
 * Three things separate them and none of them is hue alone: this ring is larger (9 against 6.5),
 * it is empty where the record has a filled dot inside it, and it drops a hairline to the baseline
 * that nothing else in this file draws. The dropline is what makes it survive a glance: a ring at
 * the top of a chart is small, and a full height rule at one x position is not.
 */
function focusMark(cx, cy, base, { radius = 9 } = {}) {
  return (
    `<line class="chart__focusdrop" x1="${cx.toFixed(1)}" y1="${(cy + radius).toFixed(1)}" ` +
    `x2="${cx.toFixed(1)}" y2="${base.toFixed(1)}" />` +
    `<circle class="chart__focus" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius}" />`
  );
}

/** Whether a point belongs to the focused day. Tolerant of no focus, which is the usual case. */
const focused = (ids, sessionId) => Boolean(ids && sessionId && ids.has(sessionId));

// ------------------------------------------------------------------ strength

/**
 * One continuous line across the whole history. Block boundaries are rules, deliberately not
 * breaks: crossing them is the reason this metric exists, since Epley is what makes 3x10 at
 * 60kg and 5x3 at 90kg the same kind of number.
 */
export function renderE1rmChart(container, progression, options = {}) {
  return renderSeriesChart(container, progression, {
    ...options,
    series: progression.e1rm.series,
    value: (point) => point.e1rm,
    scale: toDisplay,
    title: 'Estimated one rep max',
  });
}

/**
 * The same line, for a lift with no external load. A pushup has no estimated 1RM and no volume,
 * so the rep count is not a fallback here, it is the measurement.
 */
export function renderRepsChart(container, progression, options = {}) {
  return renderSeriesChart(container, progression, {
    ...options,
    series: progression.reps.series,
    value: (point) => point.topReps,
    integer: true,
    title: 'Top set reps',
  });
}

/** And for a hold, where seconds are the whole of what happened. */
export function renderHoldChart(container, progression, options = {}) {
  return renderSeriesChart(container, progression, {
    ...options,
    series: progression.hold.series,
    value: (point) => point.topHold,
    integer: true,
    title: 'Longest hold, seconds',
  });
}

/**
 * One value per session, drawn as one continuous line across the whole history.
 *
 * Parametrised rather than copied three times because every rule below is about how to draw a
 * progression honestly, not about which quantity it is: block boundaries are rules and never
 * breaks, a segment touching a deload dashes on both sides, and a record carries a ring and a
 * word rather than only a colour. Duplicating that would mean three places for those rules to
 * drift apart.
 */
function renderSeriesChart(
  container,
  progression,
  { height = 180, series, value, title, scale = (v) => v, integer = false, focus = null },
) {
  container.innerHTML = '';
  if (!series.length) return;

  const width = widthOf(container);
  const pad = { top: 22, right: 14, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Display units from here down. Nothing below this line is in kilograms.
  const at = (point) => scale(value(point));
  const values = series.map(at);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const margin = Math.max((hi - lo) * 0.2, integer ? 1 : 2);
  const { domain: yDomain, ticks } = axisTicks(lo - margin, hi + margin, { target: 4, integer });

  const x = linear(timeDomain(series), [pad.left, pad.left + plotW]);
  const y = linear(yDomain, [pad.top + plotH, pad.top]);
  const px = (p) => x(Date.parse(p.date));

  let out = svgOpen(width, height, `${title}, ${series.length} sessions`);

  // The rules first, so every stroke and every mark sits on top of them rather than under.
  out += gridBlock(ticks, y, { left: pad.left, right: width - pad.right });

  // Block boundaries. A rule and a label, never a gap in the line.
  for (const block of progression.blocks.slice(1)) {
    const first = series.find((p) => p.blockIndex === block.index);
    if (!first) continue;
    const bx = Math.round(px(first)) - 6;
    out += `<line class="chart__rule" x1="${bx}" y1="${pad.top}" x2="${bx}" y2="${pad.top + plotH}" />`;
    out += `<text class="chart__blocklabel" x="${bx + 4}" y="${pad.top + 9}">${esc(block.label)}</text>`;
  }

  // One path per segment, classified by its endpoints. A segment touching a deload is dashed,
  // so the drop into one and the climb out of one look the same. Splitting into runs instead
  // dashes only one side, which leaves the drop reading as an unexplained collapse, and the
  // drop is the half that actually needs explaining.
  for (let i = 1; i < series.length; i += 1) {
    const from = series[i - 1];
    const to = series[i];
    const deload = from.isDeload || to.isDeload;
    const d =
      `M${px(from).toFixed(1)} ${y(at(from)).toFixed(1)} ` +
      `L${px(to).toFixed(1)} ${y(at(to)).toFixed(1)}`;
    out += `<path class="chart__line ${deload ? 'is-deload' : 'is-current'}" d="${d}" />`;
  }

  // Points. Deloads are hollow squares, records are ringed dots, ordinary sessions are dots.
  for (const p of series) {
    const cx = px(p).toFixed(1);
    const cy = y(at(p)).toFixed(1);
    if (p.isDeload) {
      out += `<rect class="chart__mark is-deload" x="${(px(p) - 3.5).toFixed(1)}" y="${(y(at(p)) - 3.5).toFixed(1)}" width="7" height="7" />`;
    } else if (p.isRecord) {
      out += `<circle class="chart__mark is-record-ring" cx="${cx}" cy="${cy}" r="6.5" />`;
      out += `<circle class="chart__mark is-record" cx="${cx}" cy="${cy}" r="3.5" />`;
    } else {
      out += `<circle class="chart__mark is-current" cx="${cx}" cy="${cy}" r="2.5" />`;
    }
  }

  // The focused session last of the points, so its ring is never half under the next mark drawn.
  for (const p of series) {
    if (focused(focus, p.sessionId)) out += focusMark(px(p), y(at(p)), pad.top + plotH);
  }

  // Deloads say so in words, so the dash is never the only signal.
  const firstDeload = series.find((p) => p.isDeload);
  if (firstDeload) {
    out += `<text class="chart__note" x="${px(firstDeload).toFixed(1)}" y="${(y(at(firstDeload)) + 16).toFixed(1)}" text-anchor="middle">Planned deload</text>`;
  }

  // Where the line ended up, printed at the point rather than only in the card's header. The
  // header says what the number is; this says which rule it is sitting on, which is the part a
  // reader was otherwise estimating. Skipped on a deload, where the note above owns that spot.
  const last = series[series.length - 1];
  if (!last.isDeload) {
    const ly = y(at(last));
    const above = ly - 11 > pad.top + 2;
    out +=
      `<text class="chart__now" x="${(px(last) + 1).toFixed(1)}" ` +
      `y="${(above ? ly - 11 : ly + 18).toFixed(1)}" text-anchor="end">${esc(axisNum(at(last)))}</text>`;
  }

  out += `<text class="chart__axis" x="${pad.left}" y="${height - 8}">${esc(shortDay(series[0].date))}</text>`;
  out += `<text class="chart__axis" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${esc(shortDay(series[series.length - 1].date))}</text>`;
  out += '</svg>';
  container.innerHTML = out;
}

// ------------------------------------------------------------------ work per session

/**
 * A curve through points, guaranteed not to overshoot them.
 *
 * Monotone cubic, Fritsch-Carlson tangents, rather than the usual Catmull-Rom or a cardinal
 * spline. The difference is not cosmetic. A plain spline through 3,200 then 3,300 then 3,100
 * bulges above 3,300 on its way between them, which draws a session at a volume nobody logged, and
 * the bulge is largest exactly where the data is most uneven. Clamping the tangent to zero at every
 * local extreme means the curve turns at the point rather than past it: every peak on this chart is
 * a session, and the highest ink on the line is the highest number in the data.
 *
 * Smoothing at all is a decision, and it is this chart's alone. The per lift charts are straight
 * segments because a segment there carries a classification, deload or not, and a curve cannot be
 * half dashed. Here a line is a program day's workload over months, and the shape is the point.
 *
 * Exported for test.js alone. It is the only piece of drawing in this file that can be wrong about
 * the data rather than about the pixels, so it is the only piece worth a unit test.
 */
export function smoothPath(points) {
  const n = points.length;
  if (!n) return '';
  const at = (p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  if (n === 1) return `M${at(points[0])}`;

  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
  }

  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    // A sign change is a turning point, and a tangent of zero is what makes the curve turn ON the
    // point. Otherwise the weighted harmonic mean, which cannot exceed either neighbouring slope.
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let d = `M${at(points[0])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const run = dx[i] / 3;
    const c1 = { x: points[i].x + run, y: points[i].y + m[i] * run };
    const c2 = { x: points[i + 1].x - run, y: points[i + 1].y - m[i + 1] * run };
    d += ` C${at(c1)} ${at(c2)} ${at(points[i + 1])}`;
  }
  return d;
}

/**
 * Labels that would sit on top of each other, pushed apart.
 *
 * Two program days ending a month apart at similar volumes put their glyphs in the same twelve
 * pixels, and two glyphs overprinted is worse than either being slightly off its own line. Walks
 * top down and pushes each label down to clear the one above, which is stable: the order never
 * changes, so a label cannot swap sides of its neighbour between redraws.
 */
function spread(entries, gap, floor, ceiling) {
  const sorted = [...entries].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const entry of sorted) {
    entry.labelY = Math.max(entry.y, last + gap, floor);
    last = entry.labelY;
  }
  // Anything pushed off the bottom comes back up, which can only happen when there are more labels
  // than the box is tall, and is still better than one printed outside the card.
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].labelY > ceiling) sorted[i].labelY = ceiling - (sorted.length - 1 - i) * gap;
  }
  return entries;
}

/** Ids have to be unique across every chart on the page, and there are four of them on Progress. */
let gradientSeq = 0;

/**
 * Work per session, one line per program day, in the consistency grid's own slot colours.
 *
 * The colours are the point rather than decoration. This card sits directly under the grid, whose
 * legend has just told the reader that rose is UPPER A and emerald is LOWER A, and it answers the
 * question the grid cannot: the grid says a session happened on the eleventh, this says how much
 * work was in it. Painting the lines in a second palette would make the reader learn the same
 * split twice.
 *
 * Hue is still the fourth signal and not the first, per the encoding rules. A line carries its own
 * position in the box, a marker at every session, a glyph at its end, and a legend row naming it in
 * words. What colour adds is the tie back to the grid.
 *
 * Zero based, unlike the estimated 1RM line, because this one is filled. A wash under a line reads
 * as quantity whether or not it was meant to, so a floor above zero would draw a session at half
 * the ink of one that was twice the work. The fill is what makes four overlapping series legible,
 * so the axis pays for it rather than the other way round.
 */
export function renderSessionVolumeChart(container, built, { height = 208, scale = toDisplay, focus = null } = {}) {
  container.innerHTML = '';
  const lines = built.lines.filter((line) => line.points.length);
  if (!lines.length) return;

  const width = widthOf(container);
  const pad = { top: 16, right: 26, bottom: 26, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Display units from here down. Nothing below this line is in kilograms.
  const every = lines.flatMap((line) => line.points);
  const at = (point) => scale(point.volumeKg);
  const max = Math.max(...every.map(at), 1);
  // Five rules rather than the four the other charts ask for. Session volume runs to five figures,
  // so a four rule axis lands on a step of ten thousand and spends the top third of the box on
  // headroom above a series that never gets there.
  const { domain, ticks } = axisTicks(0, max, { target: 5 });

  const x = linear(timeDomain(every), [pad.left, pad.left + plotW]);
  const y = linear(domain, [pad.top + plotH, pad.top]);
  const base = pad.top + plotH;
  const uid = `sv${(gradientSeq += 1)}`;

  let out = svgOpen(width, height, `Work per session, ${lines.length} program days`);

  // One wash per slot. The gradient carries the slot class itself, because --cal-face is set by
  // that class and a gradient in <defs> inherits from <defs> rather than from whatever references
  // it, so the class has to be where the variable is read.
  // Keyed by position rather than by the day's name, which is free text a trainer typed: "UPPER A"
  // carries a space, and a space in an id is a url(#) that resolves to nothing and a wash that
  // silently does not paint.
  const washId = (index) => `${uid}-${index}`;
  out += '<defs>';
  lines.forEach((line, index) => {
    out +=
      `<linearGradient id="${washId(index)}" class="is-slot-${line.slot}" x1="0" y1="0" x2="0" y2="1">` +
      '<stop class="chart__wash-top" offset="0" /><stop class="chart__wash-base" offset="1" />' +
      '</linearGradient>';
  });
  out += '</defs>';

  out += gridBlock(ticks, y, { left: pad.left, right: width - pad.right });
  out += `<line class="chart__baseline" x1="${pad.left}" y1="${base}" x2="${width - pad.right}" y2="${base}" />`;

  const ends = lines.map((line) => {
    const last = line.points[line.points.length - 1];
    return { line, y: y(at(last)), labelY: y(at(last)) };
  });
  spread(ends, 13, pad.top + 4, base);

  // Every wash first, then every stroke, rather than each line complete before the next one starts.
  // A day that dips low draws a fill across the whole width under it, and painting that after the
  // line it crosses buries the line: on the seeded two day split the upper day's whole curve
  // disappeared under the lower day's wash. Washes are the background, so they go in the
  // background. Within each pass, slot order, so a redraw cannot shuffle the stacking.
  const plottedByLine = lines.map((line) =>
    line.points.map((p) => ({ x: x(Date.parse(p.date)), y: y(at(p)) })),
  );

  plottedByLine.forEach((plotted, index) => {
    if (plotted.length < 2) return;
    const wash =
      `${smoothPath(plotted)} L${plotted[plotted.length - 1].x.toFixed(1)} ${base} ` +
      `L${plotted[0].x.toFixed(1)} ${base} Z`;
    out += `<path class="chart__wash" d="${wash}" fill="url(#${washId(index)})" />`;
  });

  lines.forEach((line, index) => {
    const plotted = plottedByLine[index];
    if (plotted.length > 1) {
      out += `<path class="chart__curve is-slot-${line.slot}" d="${smoothPath(plotted)}" />`;
    }

    for (const point of line.points) {
      const cx = x(Date.parse(point.date));
      const cy = y(at(point));
      if (point.isDeload) {
        // Planned, so it takes the shape the deload has everywhere else rather than a dip in a
        // line nobody explained. The words are under the chart.
        out +=
          `<rect class="chart__mark is-deload" x="${(cx - 3.5).toFixed(1)}" y="${(cy - 3.5).toFixed(1)}" ` +
          `width="7" height="7" />`;
      } else {
        out += `<circle class="chart__node is-slot-${line.slot}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" />`;
      }
    }
  });

  // A point here can be several sessions of one program day summed into one visit, so any of its
  // ids matching is a hit. After every line, for the same reason as everywhere else.
  for (const line of lines) {
    for (const point of line.points) {
      if ((point.sessionIds ?? []).some((id) => focused(focus, id))) {
        out += focusMark(x(Date.parse(point.date)), y(at(point)), base);
      }
    }
  }

  // The glyph at the end of each line, which is the same two letters the grid puts in the cell.
  // In --text-primary rather than in the slot's own rim: a rim is a lit edge at about 3.5 against
  // black, which is a fine stroke and an illegal colour for 12px text.
  for (const end of ends) {
    const cx = x(Date.parse(end.line.points[end.line.points.length - 1].date));
    out +=
      `<text class="chart__glyph" x="${(cx + 7).toFixed(1)}" y="${(end.labelY + 4).toFixed(1)}">` +
      `${esc(end.line.glyph)}</text>`;
  }

  const firstDeload = every.find((p) => p.isDeload);
  if (firstDeload) {
    out += `<text class="chart__note" x="${pad.left}" y="${height - 8}">Squares are planned deloads</text>`;
  } else {
    out += `<text class="chart__axis" x="${pad.left}" y="${height - 8}">${esc(shortDay(every[0].date))}</text>`;
  }
  out += `<text class="chart__axis" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${esc(
    shortDay(every[every.length - 1].date),
  )}</text>`;
  out += '</svg>';

  // The legend is markup rather than more SVG, and it carries the numbers the lines end on. Four
  // values printed inside the box would need fifty pixels of the right margin on a 328px chart,
  // and they would be the only numbers on the screen not sitting in a row anybody can scan. It is
  // built the same way the grid's legend is, for the same reason: a key that is not made out of
  // the thing it explains stops matching the first time either one is retuned.
  out +=
    '<ul class="chart__keys">' +
    lines
      .map((line) => {
        const last = line.points[line.points.length - 1];
        return (
          `<li class="chart__key"><span class="chart__keymark is-slot-${line.slot}" aria-hidden="true">` +
          `${esc(line.glyph)}</span>${esc(line.label)} ` +
          `<b class="num">${esc(axisNum(at(last)))}</b></li>`
        );
      })
      .join('') +
    '</ul>';

  container.innerHTML = out;
}

// ------------------------------------------------------------------ volume

/**
 * Bars per session, stacked prescribed under extra, grouped by block with a gap between.
 *
 * Bars rather than a line because volume is a per session quantity, because a single session
 * has to be legible, and because stacking is what stops an added set from inflating the number
 * that carries the claim.
 */
export function renderVolumeChart(container, progression, { height = 164, focus = null } = {}) {
  container.innerHTML = '';
  const segments = progression.volume.segments.filter((s) => s.points.length);
  if (!segments.length) return;

  const width = widthOf(container);
  const pad = { top: 14, right: 10, bottom: 24, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Volume is sets by reps by weight, so it carries the weight unit and the axis converts with it.
  const all = segments.flatMap((s) => s.points);
  const total = (p) => toDisplay(p.prescribed + p.extra);
  const max = Math.max(...all.map(total), 1);
  // Zero based, always. Bar length encodes magnitude and a truncated bar lies about the ratio
  // between two bars, so only the ceiling is allowed to move out to a whole step.
  const { domain, ticks } = axisTicks(0, max, { target: 4 });
  const y = linear(domain, [pad.top + plotH, pad.top]);

  const gap = segments.length > 1 ? 10 : 0;
  const slot = (plotW - gap * (segments.length - 1)) / all.length;
  const barW = Math.max(3, Math.min(22, slot * 0.68));

  let out = svgOpen(width, height, `Volume per session, ${all.length} sessions`);
  out += gridBlock(ticks, y, { left: pad.left, right: width - pad.right });
  out += `<line class="chart__baseline" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" />`;

  let i = 0;
  segments.forEach((segment, si) => {
    const segStart = pad.left + i * slot + si * gap;
    segment.points.forEach((p, pi) => {
      const cx = segStart + pi * slot + slot / 2;
      const left = (cx - barW / 2).toFixed(1);
      const base = pad.top + plotH;
      const prescribed = toDisplay(p.prescribed);

      const hPre = base - y(prescribed);
      out += `<rect class="chart__bar ${p.isDeload ? 'is-deload' : 'is-prescribed'}" x="${left}" y="${y(prescribed).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, hPre).toFixed(1)}" rx="3" />`;

      if (p.extra > 0) {
        const top = y(total(p));
        out += `<rect class="chart__bar is-extra" x="${left}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, y(prescribed) - top).toFixed(1)}" rx="3" />`;
      }

      // A ring makes no sense on a bar, so the focus is the bar's own outline, held off the fill
      // so it reads as something drawn around the bar rather than as a border on it. No dropline
      // either: the bar already reaches the baseline, which is what the dropline exists to do.
      if (focused(focus, p.sessionId)) {
        const top = y(total(p));
        out +=
          `<rect class="chart__focusbar" x="${(cx - barW / 2 - 3).toFixed(1)}" y="${(top - 3).toFixed(1)}" ` +
          `width="${(barW + 6).toFixed(1)}" height="${Math.max(6, base - top + 6).toFixed(1)}" rx="5" />`;
      }
    });
    i += segment.points.length;

    if (si > 0) {
      const rx = segStart - gap / 2;
      out += `<line class="chart__rule" x1="${rx.toFixed(1)}" y1="${pad.top}" x2="${rx.toFixed(1)}" y2="${pad.top + plotH}" />`;
      out += `<text class="chart__blocklabel" x="${(rx + 3).toFixed(1)}" y="${pad.top + 8}">${esc(segment.label)}</text>`;
    }
  });

  const deload = all.find((p) => p.isDeload);
  if (deload) out += `<text class="chart__note" x="${pad.left}" y="${height - 8}">Dashed bar is a planned deload</text>`;
  else out += `<text class="chart__axis" x="${pad.left}" y="${height - 8}">${esc(shortDay(all[0].day))}</text>`;

  out += '</svg>';
  container.innerHTML = out;
}

// ------------------------------------------------------------------ reps at load

/**
 * Up to three lines, one per working load in the current block, each labelled with its load.
 *
 * For an intermediate this is often a single line, and that is the point rather than a
 * degenerate case: the bar did not move for months and the reps went from five to seven, which
 * is not visible anywhere else in the app.
 */
export function renderRepsAtLoadChart(container, progression, { height = 156, focus = null } = {}) {
  container.innerHTML = '';
  const lines = progression.repsAtLoad.lines.filter((l) => l.points.length);
  if (!lines.length) return;

  const width = widthOf(container);
  const pad = { top: 14, right: 56, bottom: 24, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const every = lines.flatMap((l) => l.points);
  const maxReps = Math.max(...every.map((p) => p.reps), 1);
  const x = linear(timeDomain(every), [pad.left, pad.left + plotW]);
  // Zero based, and stepped in whole reps. Half a rep is not a thing that happened.
  const { domain, ticks } = axisTicks(0, maxReps + 1, { target: 4, integer: true });
  const y = linear(domain, [pad.top + plotH, pad.top]);

  let out = svgOpen(width, height, `Reps at each working load, ${lines.length} loads`);
  out += gridBlock(ticks, y, { left: pad.left, right: pad.left + plotW });
  out += `<line class="chart__baseline" x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" />`;

  // Where each load's label wants to sit, before anything is drawn, so they can be moved apart.
  //
  // Two loads whose last session was the same day at the same rep count land on identical
  // coordinates, and two labels overprinted is not a near miss: it is a word neither of them says.
  // That is not the exotic case it sounds like, it is the ordinary shape of ascending sets. Work
  // up to a top set of six twice in one session and both loads end on the same day at six.
  //
  // The same spread() the volume chart has always used, for the same reason and with the same
  // stability: top down, order never changes, so a label cannot swap sides of its neighbour
  // between redraws.
  const ends = lines.map((line, index) => {
    const last = line.points[line.points.length - 1];
    const at = y(last.reps) + 4;
    return { line, index, last, y: at, labelY: at };
  });
  spread(ends, 13, pad.top + 8, pad.top + plotH);

  // BEFORE the lines here, which is the opposite of every other chart in this file, and the
  // exception is measured rather than stylistic. This is the one chart that prints a word at its
  // last point: the load label sits six pixels right of it, which is inside a ring of radius nine.
  // Drawn after, the ring crosses the numerals and "92.5 kg" stops being readable, and the number
  // is the thing somebody came to this chart for. Drawn first, the label paints over the arc it
  // crosses and both survive. One session can hold several loads, so this can mark more than one.
  for (const line of lines) {
    for (const p of line.points) {
      if (focused(focus, p.sessionId)) out += focusMark(x(Date.parse(p.date)), y(p.reps), pad.top + plotH);
    }
  }

  ends.forEach(({ line, index, last, labelY }) => {
    // The most recent load is the heavy solid one. Older loads thin out and dash, so the
    // ordering survives without relying on the cyan steps being told apart.
    const rank = lines.length - 1 - index;
    const cls = rank === 0 ? 'is-current' : rank === 1 ? 'is-previous' : 'is-earlier';
    if (line.points.length > 1) {
      const d = line.points
        .map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.date)).toFixed(1)} ${y(p.reps).toFixed(1)}`)
        .join(' ');
      out += `<path class="chart__line ${cls}" d="${d}" />`;
    }
    for (const p of line.points) {
      out += `<circle class="chart__mark ${cls}" cx="${x(Date.parse(p.date)).toFixed(1)}" cy="${y(p.reps).toFixed(1)}" r="${rank === 0 ? 3.5 : 2.5}" />`;
    }
    out += `<text class="chart__loadlabel ${cls}" x="${(x(Date.parse(last.date)) + 6).toFixed(1)}" y="${labelY.toFixed(1)}">${weightLabel(line.loadKg)}</text>`;
  });

  if (progression.repsAtLoad.hiddenCount > 0) {
    out += `<text class="chart__note" x="${pad.left}" y="${height - 8}">${progression.repsAtLoad.hiddenCount} earlier load(s) not shown</text>`;
  }
  out += '</svg>';
  container.innerHTML = out;
}
