// Turns set_logs into the three approved chart series. Pure: no DOM, no storage, no dates
// beyond the ISO strings already on the rows. Everything the charts draw is decided here, so
// the drawing code never has to make a judgement about what counts.
//
// The three altitudes, and what each is for:
//
//   estimated 1RM   across the whole history, crosses blocks on purpose. Answers "am I
//                   stronger than I was". Leads once there are two or more blocks.
//   volume          per session, within a block, split prescribed from extra. Answers
//                   "did I do the work". Never compared across a block boundary.
//   reps at load    within the current block only, capped. Answers "what changed this block",
//                   which for an intermediate is the only place progress is visible at all.
//
// Volume is wrong in both directions as a strength measure, which is why it never leads alone:
// moving 3x10 at 60kg to 5x3 at 90kg reads as minus 25 percent while estimated 1RM reads plus
// 23.8 percent, and going 5 reps to 7 at an unchanged 92.5kg reads as plus 40 percent while
// estimated 1RM reads plus 5.7 percent.

import { activeSetLogs, epley1rm } from './history.js';

/** Epley drifts high above about twelve reps, so the strength series stops there. */
export const MAX_REPS_FOR_E1RM = 12;

/** Reps at load shows the current load plus the two before it. More becomes stubs. */
export const MAX_LOAD_LINES = 3;

/** Below this many points a line is a shape, not a trend, and we do not claim one. */
export const MIN_POINTS_FOR_TREND = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much a view is allowed to claim, given how much evidence exists.
 *
 *   none     nothing logged
 *   single   one session. A fact, drawn as one bar. No axis implying absent data.
 *   compare  two or three. A stated difference, never a slope.
 *   trend    four or more. A direction may be drawn.
 */
export function evidenceLevel(pointCount) {
  if (pointCount <= 0) return 'none';
  if (pointCount === 1) return 'single';
  if (pointCount < MIN_POINTS_FOR_TREND) return 'compare';
  return 'trend';
}

/** Week index from the start of the block a session belongs to, or null if it has no block. */
export function weekIndexOf(startedAt, startsOn) {
  if (!startedAt || !startsOn) return null;
  const start = Date.parse(`${startsOn}T00:00:00`);
  const at = Date.parse(startedAt);
  if (Number.isNaN(start) || Number.isNaN(at)) return null;
  return Math.floor((at - start) / (7 * DAY_MS));
}

/**
 * A block is an assignment. Because assignments.snapshot freezes target_reps_low and high, a
 * rep range cannot change inside one, so segmenting on assignment is the same thing as
 * segmenting on prescription change, without having to diff two JSON blobs.
 */
function buildBlocks(sessions, assignments) {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const order = [];
  const seen = new Map();

  for (const session of [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const key = session.assignment_id ?? '__unassigned__';
    if (!seen.has(key)) {
      const assignment = byId.get(session.assignment_id) ?? null;
      const block = {
        key,
        assignmentId: assignment ? assignment.id : null,
        startsOn: assignment ? assignment.starts_on : session.started_at.slice(0, 10),
        deloadWeeks: new Set(Array.isArray(assignment?.deload_weeks) ? assignment.deload_weeks : []),
        index: order.length,
        label: `Block ${order.length + 1}`,
        sessionIds: new Set(),
      };
      seen.set(key, block);
      order.push(block);
    }
    seen.get(key).sessionIds.add(session.id);
  }
  return order;
}

/**
 * The whole progression for one exercise, for one client.
 *
 * Rows arriving here may include another client's, superseded ones, and retracted ones. They
 * are filtered against the session map and through activeSetLogs, so nothing that stopped
 * counting reaches a chart.
 */
export function buildProgression({ setLogs = [], sessions = [], assignments = [], exerciseId } = {}) {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const blocks = buildBlocks(sessions, assignments);
  const blockOfSession = new Map();
  for (const block of blocks) {
    for (const id of block.sessionIds) blockOfSession.set(id, block);
  }

  const live = activeSetLogs(setLogs).filter(
    (row) => row.exercise_id === exerciseId && sessionById.has(row.session_id) && !row.is_warmup,
  );

  // Warmups are already gone above. They are excluded everywhere on purpose: warmup load is
  // chosen by feel, so a client ramping more thoroughly would read as improving.
  const bySession = new Map();
  for (const row of live) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }

  const points = [...bySession.entries()]
    .map(([sessionId, rows]) => {
      const session = sessionById.get(sessionId);
      const block = blockOfSession.get(sessionId) ?? null;
      const week = block ? weekIndexOf(session.started_at, block.startsOn) : null;
      const prescribedRows = rows.filter((r) => !r.is_extra);

      // Extra sets are counted and shown, never folded into the number that carries a claim.
      const prescribed = prescribedRows.reduce((t, r) => t + r.weight_kg * r.reps, 0);
      const extra = rows.filter((r) => r.is_extra).reduce((t, r) => t + r.weight_kg * r.reps, 0);

      // Prescribed working sets only, so a max single cannot be farmed for a better line.
      const forStrength = prescribedRows.filter((r) => r.reps >= 1 && r.reps <= MAX_REPS_FOR_E1RM);
      const best = forStrength.reduce(
        (top, r) => {
          const value = epley1rm(r.weight_kg, r.reps);
          return top === null || value > top.value ? { value, weightKg: r.weight_kg, reps: r.reps } : top;
        },
        null,
      );

      return {
        sessionId,
        date: session.started_at,
        day: session.started_at.slice(0, 10),
        blockIndex: block ? block.index : 0,
        blockKey: block ? block.key : '__unassigned__',
        week,
        isDeload: Boolean(block && week !== null && block.deloadWeeks.has(week)),
        prescribed: Math.round(prescribed),
        extra: Math.round(extra),
        setCount: rows.length,
        extraCount: rows.filter((r) => r.is_extra).length,
        e1rm: best ? best.value : null,
        topSet: best ? { weightKg: best.weightKg, reps: best.reps } : null,
        rows: prescribedRows,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // A record is a point that beat everything before it. Deloads cannot set records.
  let running = null;
  for (const point of points) {
    point.isRecord = false;
    if (point.e1rm === null || point.isDeload) continue;
    if (running === null || point.e1rm > running) {
      point.isRecord = running !== null;
      running = point.e1rm;
    }
  }

  const working = points.filter((p) => !p.isDeload);
  const currentBlock = blocks.length ? blocks[blocks.length - 1] : null;
  const currentBlockPoints = points.filter((p) => currentBlock && p.blockKey === currentBlock.key);

  return {
    exerciseId,
    blocks: blocks.map((b) => ({
      index: b.index,
      key: b.key,
      label: b.label,
      startsOn: b.startsOn,
      deloadWeeks: [...b.deloadWeeks],
    })),
    points,
    // The strength line spans everything and is never broken at a block boundary. Crossing
    // them is the entire reason this metric exists.
    e1rm: {
      series: points.filter((p) => p.e1rm !== null),
      evidence: evidenceLevel(working.filter((p) => p.e1rm !== null).length),
      change: changeBetween(working.filter((p) => p.e1rm !== null).map((p) => p.e1rm)),
    },
    // Volume is only ever compared inside a block.
    volume: {
      segments: blocks.map((b) => ({
        index: b.index,
        label: b.label,
        points: points.filter((p) => p.blockKey === b.key),
      })),
      evidence: evidenceLevel(currentBlockPoints.filter((p) => !p.isDeload).length),
      change: changeBetween(currentBlockPoints.filter((p) => !p.isDeload).map((p) => p.prescribed)),
    },
    repsAtLoad: buildRepsAtLoad(currentBlockPoints),
    // Which altitude leads. One block has no cross block story to tell, so volume leads.
    // Two or more and the six month question exists, so strength leads.
    leadView: blocks.length >= 2 ? 'e1rm' : 'volume',
    totalSessions: points.length,
  };
}

/** A dip this deep is worth asking a human about. Not worth asserting anything about. */
export const DELOAD_SUGGESTION_DROP = 0.1;

/**
 * Weeks that look like a back off week and are not marked as one.
 *
 * This is the only place inference is allowed, and it never produces a label. It produces a
 * question, shown to the trainer and to nobody else. Measured against noisy data the same rule
 * flagged every unplanned dip it was given, so as an assertion to a client it would be a lie
 * roughly as often as it was right. As a prompt to the one person who knows what they
 * prescribed, over asking costs a dismissed suggestion.
 *
 * It also cannot resolve in time to be an assertion: a drop only becomes distinguishable from
 * a decline once the client comes back and lifts heavy again, which is a week after they
 * needed to read it as intentional.
 */
export function suggestDeloadWeeks(progression) {
  const suggestions = [];
  let best = null;

  for (const point of progression.points) {
    if (point.topSet === null) continue;
    const load = point.topSet.weightKg;

    if (best !== null && !point.isDeload && point.week !== null && load <= best * (1 - DELOAD_SUGGESTION_DROP)) {
      suggestions.push({
        blockKey: point.blockKey,
        blockIndex: point.blockIndex,
        week: point.week,
        day: point.day,
        sessionId: point.sessionId,
        dropPercent: Math.round((1 - load / best) * 1000) / 10,
      });
    }
    if (best === null || load > best) best = load;
  }

  // One suggestion per week, since a week can hold more than one session of the same lift.
  const seen = new Set();
  return suggestions.filter((s) => {
    const key = `${s.blockKey}:${s.week}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function changeBetween(values) {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return {
    first,
    last,
    absolute: Math.round((last - first) * 100) / 100,
    percent: first === 0 ? null : Math.round(((last - first) / first) * 1000) / 10,
  };
}

/**
 * One line per working load inside the current block, most recent loads last, capped.
 *
 * The cap exists because this view fails in two opposite directions. Across six months an
 * intermediate uses one or two loads, so there is no staircase to see, and a novice uses
 * thirteen, so it becomes stubs. Scoped to a block and capped at three, both read.
 */
function buildRepsAtLoad(blockPoints) {
  const byLoad = new Map();
  for (const point of blockPoints) {
    if (point.isDeload) continue;
    for (const row of point.rows) {
      if (!byLoad.has(row.weight_kg)) byLoad.set(row.weight_kg, new Map());
      const perSession = byLoad.get(row.weight_kg);
      // The top set of that load in that session, which is what a progression reads.
      const existing = perSession.get(point.sessionId);
      if (!existing || row.reps > existing.reps) {
        perSession.set(point.sessionId, { day: point.day, date: point.date, reps: row.reps });
      }
    }
  }

  const lines = [...byLoad.entries()]
    .map(([loadKg, perSession]) => {
      const points = [...perSession.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { loadKg, points, lastSeen: points[points.length - 1].date };
    })
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));

  const shown = lines.slice(-MAX_LOAD_LINES);
  return {
    lines: shown,
    hiddenCount: lines.length - shown.length,
    evidence: evidenceLevel(Math.max(0, ...shown.map((l) => l.points.length))),
  };
}
