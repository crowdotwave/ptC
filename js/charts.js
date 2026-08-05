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

const NS = 'http://www.w3.org/2000/svg';

const esc = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function linear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
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
    title: 'Top set reps',
  });
}

/** And for a hold, where seconds are the whole of what happened. */
export function renderHoldChart(container, progression, options = {}) {
  return renderSeriesChart(container, progression, {
    ...options,
    series: progression.hold.series,
    value: (point) => point.topHold,
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
function renderSeriesChart(container, progression, { height = 168, series, value, title }) {
  container.innerHTML = '';
  if (!series.length) return;

  const width = widthOf(container);
  const pad = { top: 18, right: 12, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const values = series.map(value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const margin = Math.max((hi - lo) * 0.2, 2);
  const yDomain = [Math.floor(lo - margin), Math.ceil(hi + margin)];

  const x = linear(timeDomain(series), [pad.left, pad.left + plotW]);
  const y = linear(yDomain, [pad.top + plotH, pad.top]);
  const px = (p) => x(Date.parse(p.date));

  let out = svgOpen(width, height, `${title}, ${series.length} sessions`);

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
      `M${px(from).toFixed(1)} ${y(value(from)).toFixed(1)} ` +
      `L${px(to).toFixed(1)} ${y(value(to)).toFixed(1)}`;
    out += `<path class="chart__line ${deload ? 'is-deload' : 'is-current'}" d="${d}" />`;
  }

  // Points. Deloads are hollow squares, records are ringed dots, ordinary sessions are dots.
  for (const p of series) {
    const cx = px(p).toFixed(1);
    const cy = y(value(p)).toFixed(1);
    if (p.isDeload) {
      out += `<rect class="chart__mark is-deload" x="${(px(p) - 3.5).toFixed(1)}" y="${(y(value(p)) - 3.5).toFixed(1)}" width="7" height="7" />`;
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
    out += `<text class="chart__note" x="${px(firstDeload).toFixed(1)}" y="${(y(value(firstDeload)) + 16).toFixed(1)}" text-anchor="middle">Planned deload</text>`;
  }

  out += `<text class="chart__axis" x="4" y="${pad.top + 4}">${yDomain[1]}</text>`;
  out += `<text class="chart__axis" x="4" y="${pad.top + plotH}">${yDomain[0]}</text>`;
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
export function renderVolumeChart(container, progression, { height = 152 } = {}) {
  container.innerHTML = '';
  const segments = progression.volume.segments.filter((s) => s.points.length);
  if (!segments.length) return;

  const width = widthOf(container);
  const pad = { top: 14, right: 8, bottom: 24, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const all = segments.flatMap((s) => s.points);
  const max = Math.max(...all.map((p) => p.prescribed + p.extra), 1);
  const y = linear([0, max], [pad.top + plotH, pad.top]); // zero based, always

  const gap = segments.length > 1 ? 10 : 0;
  const slot = (plotW - gap * (segments.length - 1)) / all.length;
  const barW = Math.max(3, Math.min(22, slot * 0.68));

  let out = svgOpen(width, height, `Volume per session, ${all.length} sessions`);
  out += `<line class="chart__baseline" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" />`;

  let i = 0;
  segments.forEach((segment, si) => {
    const segStart = pad.left + i * slot + si * gap;
    segment.points.forEach((p, pi) => {
      const cx = segStart + pi * slot + slot / 2;
      const left = (cx - barW / 2).toFixed(1);
      const base = pad.top + plotH;

      const hPre = base - y(p.prescribed);
      out += `<rect class="chart__bar ${p.isDeload ? 'is-deload' : 'is-prescribed'}" x="${left}" y="${y(p.prescribed).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, hPre).toFixed(1)}" rx="2" />`;

      if (p.extra > 0) {
        const top = y(p.prescribed + p.extra);
        out += `<rect class="chart__bar is-extra" x="${left}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, y(p.prescribed) - top).toFixed(1)}" rx="2" />`;
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

  out += `<text class="chart__axis" x="4" y="${pad.top + 4}">${Math.round(max).toLocaleString()}</text>`;
  out += `<text class="chart__axis" x="4" y="${pad.top + plotH}">0</text>`;
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
export function renderRepsAtLoadChart(container, progression, { height = 148 } = {}) {
  container.innerHTML = '';
  const lines = progression.repsAtLoad.lines.filter((l) => l.points.length);
  if (!lines.length) return;

  const width = widthOf(container);
  const pad = { top: 14, right: 52, bottom: 24, left: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const every = lines.flatMap((l) => l.points);
  const maxReps = Math.max(...every.map((p) => p.reps), 1);
  const x = linear(timeDomain(every), [pad.left, pad.left + plotW]);
  const y = linear([0, maxReps + 1], [pad.top + plotH, pad.top]); // zero based

  let out = svgOpen(width, height, `Reps at each working load, ${lines.length} loads`);
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
    out += `<text class="chart__loadlabel ${cls}" x="${(x(Date.parse(last.date)) + 6).toFixed(1)}" y="${(y(last.reps) + 4).toFixed(1)}">${line.loadKg} kg</text>`;
  });

  out += `<text class="chart__axis" x="4" y="${pad.top + 4}">${maxReps + 1}</text>`;
  out += `<text class="chart__axis" x="4" y="${pad.top + plotH}">0</text>`;
  if (progression.repsAtLoad.hiddenCount > 0) {
    out += `<text class="chart__note" x="${pad.left}" y="${height - 8}">${progression.repsAtLoad.hiddenCount} earlier load(s) not shown</text>`;
  }
  out += '</svg>';
  container.innerHTML = out;
}
