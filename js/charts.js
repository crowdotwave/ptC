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
  { height = 180, series, value, title, scale = (v) => v, integer = false },
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

// ------------------------------------------------------------------ volume

/**
 * Bars per session, stacked prescribed under extra, grouped by block with a gap between.
 *
 * Bars rather than a line because volume is a per session quantity, because a single session
 * has to be legible, and because stacking is what stops an added set from inflating the number
 * that carries the claim.
 */
export function renderVolumeChart(container, progression, { height = 164 } = {}) {
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
export function renderRepsAtLoadChart(container, progression, { height = 156 } = {}) {
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

  lines.forEach((line, index) => {
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
    const last = line.points[line.points.length - 1];
    out += `<text class="chart__loadlabel ${cls}" x="${(x(Date.parse(last.date)) + 6).toFixed(1)}" y="${(y(last.reps) + 4).toFixed(1)}">${weightLabel(line.loadKg)}</text>`;
  });

  if (progression.repsAtLoad.hiddenCount > 0) {
    out += `<text class="chart__note" x="${pad.left}" y="${height - 8}">${progression.repsAtLoad.hiddenCount} earlier load(s) not shown</text>`;
  }
  out += '</svg>';
  container.innerHTML = out;
}
