// One line per program day: how much work each session held, across the whole history.
//
// Every other chart on the progress screen is scoped to one lift. This is the second thing on that
// screen that is not, after the consistency grid, and it answers the question the grid cannot: the
// grid says you turned up on the eleventh, and says nothing at all about whether that session was
// the hardest one you have done or the lightest. Volume is what says which.
//
// WHY THIS IS NOT ONE LINE. Total tonnage per session across every lift looks like the obvious
// summary and is a sawtooth: on the seeded two day split a lower day is roughly twice an upper day,
// because a leg press moves more kilograms than an overhead press by biomechanics rather than by
// effort. A single line alternating 3,700 and 8,000 encodes the day of the week, and a trend
// drawn through it measures nothing. Split by program day, each line compares like with like: this
// upper day against every other upper day.
//
// WHY IT IS NOT ONE LINE PER LIFT EITHER, which is the other obvious reading. Bench against leg
// press is not a comparison anybody has a use for, the magnitudes differ by an order of magnitude
// so the small lifts flatten onto the axis, and the per lift answer already exists one card down
// where the lift picker puts it. Eight lines would also need eight identity colours, and the
// palette affords three.
//
// WHAT COUNTS. Everything performed, warmups aside: prescribed sets and sets the client added
// beyond the plan, in one number. That is a deliberate departure from the rule in CLAUDE.md that
// extra volume is never folded into a number carrying a claim, and it is narrow. That rule protects
// the per lift volume chart, whose claim is "the prescription is being met", and an added set there
// inflates the evidence for a claim about the plan. The claim HERE is "this is how much work that
// session held", and a set somebody chose to add is work they did. The per lift card below still
// separates the two, so nothing is hidden by this, it is only totalled differently.
//
// A row with no reps, which is how a carry or a hold is logged, contributes nothing rather than
// contributing a guess. A session that comes out at zero, which is what a bodyweight-only day is,
// is left off the line entirely: plotting it at zero would draw a session nobody did.
//
// TWO THINGS ARE NOT A POINT ON THIS CHART, and both were found by a tail that fell off a cliff.
//
// A SESSION STILL RUNNING. Its volume is not low, it is not known yet. Including it means the line
// dips every time somebody opens Progress between their first set and their last, which is the one
// moment they are most likely to look, and the dip deepens the earlier in the workout they check.
// It appears the moment they end the session. This is the only chart that needs the rule, because
// it is the only one where a point is a whole session rather than one lift's part of one.
//
// SEVERAL SESSIONS OF THE SAME PROGRAM DAY ON THE SAME DAY. That is one visit, not several. A
// client starts a session, realises it is the wrong day, ends it, starts another; a phone dies and
// the workout is picked back up. The rows are real and every one of them counts, but drawn as
// separate points they are four dots inside one pixel of an eight week axis, which renders as a
// vertical wall rather than as the day's work. They sum, exactly as the consistency grid puts two
// sessions in one cell. Two sessions of DIFFERENT program days on one day stay separate: they are
// different lines, and summing across them is the sawtooth this module exists to avoid.
//
// What neither rule does is hide a short session. A finished session holding one set is a point at
// the height of one set, and the line drops to meet it. That is not a defect to be smoothed away:
// it is the week somebody did almost nothing, and a chart that flattered it would be worth less
// than no chart. No guilt is a rule about words and colour, not about moving the data.

import { activeSetLogs } from './history.js';
import { identifySessions } from './consistency.js';
import { evidenceLevel, changeBetween } from './progression.js';
import { localDayOf } from './dates.js';

/**
 * How many lines this chart will draw before it starts folding days into a note.
 *
 * It used to be the palette's slot count, on the argument that a fifth line would be a colour
 * already in use. That reason is gone: every day now generates its own colour, so this is a cap on
 * LEGIBILITY alone and nothing else, and it is stated as its own number rather than borrowed from
 * a constant that no longer means what it did.
 *
 * Still four, deliberately, and it is the number to argue with rather than change quietly. A ten
 * day program folds six days into the note under the chart, which is a lot to hide; but ten lines
 * through one phone width chart is not a chart, and the honest fix for a client with that many days
 * is probably not more lines.
 */
export const MAX_DAY_LINES = 4;

/** Volume is weight times reps. A row with no reps has no volume, and no invented one either. */
const counted = (row) =>
  Number.isFinite(row.reps) && row.reps > 0 && Number.isFinite(row.weight_kg) && row.weight_kg > 0;

/**
 * Work per session, grouped by program day.
 *
 * Rows arriving here may include another client's, superseded ones, and retracted ones. They are
 * filtered against the session map and through activeSetLogs, so nothing that stopped counting
 * reaches the chart. `sessions` is expected to come from js/session.js loadSessions, which is what
 * drops the discarded ones.
 */
export function buildSessionVolume({ sessions = [], setLogs = [], assignments = [] } = {}) {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const identity = identifySessions({ sessions, assignments });

  const volumeBySession = new Map();
  for (const row of activeSetLogs(setLogs)) {
    if (row.is_warmup || !sessionById.has(row.session_id) || !counted(row)) continue;
    volumeBySession.set(
      row.session_id,
      (volumeBySession.get(row.session_id) ?? 0) + row.weight_kg * row.reps,
    );
  }

  // Grouped by the day's LABEL rather than by its slot, because slot 4 is the overflow and two
  // genuinely different days land in it on a five day program. Grouping on the slot would draw
  // those as one line and call the sum a progression.
  //
  // Then by the local day inside that, which is the merge described at the top. localDayOf rather
  // than a slice of the timestamp, for the same reason the grid uses it: the day a session belongs
  // to is the day where the person was standing, and a 9pm workout is the previous date in UTC.
  const byLabel = new Map();
  let sessionCount = 0;
  for (const session of [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const volumeKg = volumeBySession.get(session.id);
    if (!(volumeKg > 0)) continue;
    // Not over yet, so its total is not known. See the note at the top.
    if (!session.completed_at) continue;

    const who = identity.get(session.id);
    const day = localDayOf(session.started_at);
    if (!byLabel.has(who.label)) {
      byLabel.set(who.label, {
        key: who.label, label: who.label, glyph: who.glyph, block: who.block,
        colours: who.colours, orderInBlock: who.orderInBlock, points: [], byDay: new Map(),
      });
    }
    const line = byLabel.get(who.label);
    sessionCount += 1;

    const already = line.byDay.get(day);
    if (already) {
      already.sessionIds.push(session.id);
      already.volumeKg += volumeKg;
      // One visit, and a deload week is a property of the week rather than of the session, so any
      // part of it landing in a deload makes the whole point one.
      already.isDeload = already.isDeload || who.isDeload;
      continue;
    }
    const point = {
      // The first session of the visit owns the x position. The last would move the point later in
      // the day as the visit went on, which is a shift nothing else on this screen makes.
      sessionIds: [session.id],
      date: session.started_at,
      day,
      volumeKg,
      isDeload: who.isDeload,
    };
    line.byDay.set(day, point);
    line.points.push(point);
  }

  const all = [...byLabel.values()];
  for (const line of all) {
    delete line.byDay;
    for (const point of line.points) point.volumeKg = Math.round(point.volumeKg);
    line.points.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Which lines survive the cap: the ones with the most sessions behind them, ties broken by
  // recency. A day trained twelve times says more than a day trained once, and the day somebody is
  // on now says more than the one they left behind in March.
  const ranked = [...all].sort(
    (a, b) =>
      b.points.length - a.points.length ||
      b.points[b.points.length - 1].date.localeCompare(a.points[a.points.length - 1].date),
  );
  const kept = new Set(ranked.slice(0, MAX_DAY_LINES).map((line) => line.key));

  // Back into block then within-block order for drawing, so the lines read in the rotation's own
  // order and match both the grid's legend and the day picker on the logging screen.
  const lines = all
    .filter((line) => kept.has(line.key))
    .sort(
      (a, b) =>
        String(a.block ?? '~').localeCompare(String(b.block ?? '~')) ||
        a.orderInBlock - b.orderInBlock ||
        a.label.localeCompare(b.label),
    );
  const hidden = all.filter((line) => !kept.has(line.key));

  // Every point on the chart, in time order, whichever line it belongs to. Off `all` rather than
  // `lines`, so the headline still reports the most recent work when the day it was on is one the
  // cap folded away.
  const points = all
    .flatMap((line) => line.points)
    .sort((a, b) => a.date.localeCompare(b.date));

  // The headline compares a day against ITSELF, never against the session before it, for the same
  // reason the lines are split at all: the last two sessions are usually two different days, so
  // "up 4,300 lb since last time" would be reporting that Tuesday is not Thursday. The busiest line
  // is the one the caption speaks for, and it says which day it is speaking about.
  const lead = lines.length
    ? lines.reduce((best, line) => (line.points.length > best.points.length ? line : best))
    : null;
  const working = lead ? lead.points.filter((p) => !p.isDeload) : [];

  return {
    lines,
    hiddenCount: hidden.length,
    hiddenLabels: hidden.map((line) => line.label),
    // Sessions and points are no longer the same number, so both are here under their own names. A
    // caption saying "12 sessions" must not be counting visits, and a chart drawing 12 dots must
    // not be claiming 12 sessions.
    totalSessions: sessionCount,
    totalPoints: points.length,
    latest: points.length ? points[points.length - 1] : null,
    lead: lead ? { label: lead.label, glyph: lead.glyph, colours: lead.colours } : null,
    evidence: evidenceLevel(working.length),
    change: changeBetween(working.map((p) => p.volumeKg)),
    hasDeload: points.length > 0 && lines.some((line) => line.points.some((p) => p.isDeload)),
  };
}
