// Tests for js/history.js.
//
// This module decides every number the app shows: what the steppers prefill to, what counts
// toward a personal record, what a chart would plot. Everything it reads is append only, so
// the truth of a set is never in one row, it is in a chain of rows that supersede each other.
// The cases that matter are the ones where that chain is longer than two.
//
// No build step and no test runner, in line with the rest of the app. Open test.html.

import { activeSetLogs, lastPerformance, bestEstimated1rm, epley1rm, topSet } from './js/history.js';
import { holdTicks, nextHoldInterval, HOLD_DELAY_MS, HOLD_FLOOR_MS, HOLD_START_MS } from './js/hold.js';
import { openingWeight, openingCopy, EMPTY_BARBELL_KG } from './js/prefill.js';
import { buildProgression, evidenceLevel, weekIndexOf, MAX_LOAD_LINES, suggestDeloadWeeks } from './js/progression.js';
import {
  parseReps, parseRest, parseLoad, parseSets, parseGroup, inferLogging, targetLine,
  isBodyweightLoad, prescribesLoad,
} from './js/program.js';
import {
  buildSnapshot, pickDay, sortedDays, sortedItems, dayTitle, currentAssignment, sameSnapshot,
} from './js/snapshot.js';
import { renderProgram, dayLoad, loadLine, groupItems } from './js/program-view.js';
import { toWire, fromWire, batchQueue, collapseDuplicates, createRemote } from './js/remote.js';
import { syncMessage, publishSync } from './js/sync-status.js';
import { mountShell } from './js/nav.js';
import { createStorage } from './js/storage.js';
import { readSheet, mapColumns, dayName, summarise } from './js/import-program.js';
import { can, staysSignedIn } from './js/boot.js';
import {
  describeAuthError, cooldownLeft, verifyCode, CODE_TYPES, RESEND_COOLDOWN_S,
} from './js/auth.js';
import { validate, OUTBOX_STORE } from './js/schema.js';
import { loadLabel, loadValue, unit, setUnit } from './js/units.js';
import { isoDate, localDayOf, monthKey, localMidnight } from './js/dates.js';
import { buildConsistency, splitGlyphs, SPLIT_SLOTS } from './js/consistency.js';
import { buildSessionVolume, MAX_DAY_LINES } from './js/session-volume.js';
import { smoothPath, renderRepsAtLoadChart } from './js/charts.js';
import { planForItem, setCountOf, countOf, nextSteppers, incrementOf } from './js/plan.js';
import {
  openSession,
  replaySession,
  RESUME_WINDOW_MS,
  live,
  // js/import-program.js already exports a summarise, for a workbook rather than a session.
  summarise as summariseSessions,
  retractionOf,
} from './js/session.js';
import { renderHistory, summaryLine, discardedMessage } from './js/session-view.js';
import { renderDraft, setField, setMode } from './js/import-ui.js';
import { FEELINGS, composeNote, parseNote } from './js/feel.js';
import {
  isPending,
  liftRuns,
  overviewRows,
  renderOverview,
  stateLine,
  positionLine,
} from './js/workout-view.js';
import { liftSummaries, groupLifts, matchLifts, renderLiftPicker, SEARCH_AT } from './js/lift-picker.js';
import { setLine, renderSessionReadout } from './js/session-readout.js';
import {
  emomSettings, emomBlock, emomAt, emomDue, emomStartedAt, emomClock, emomLength, emomDurationMs,
} from './js/emom.js';
import { mountEmomView, drawEmom, emomSummary } from './js/emom-view.js';

const results = [];

// Tests that return a promise are waited for before the report is written. Without this the
// harness calls fn(), gets a promise back, drops it, and records a pass: an async assertion that
// fails would report green, which is worse than no test at all. Sync tests still run and record
// in order, so the report reads the same as it always has.
const pending = [];

function test(name, fn) {
  const entry = { name, ok: true };
  results.push(entry);
  const failed = (error) => {
    entry.ok = false;
    entry.error = error?.message ?? String(error);
  };
  try {
    const returned = fn();
    if (returned && typeof returned.then === 'function') {
      pending.push(returned.then(() => {}, failed));
    }
  } catch (error) {
    failed(error);
  }
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
}

function ok(condition, label) {
  if (!condition) throw new Error(label);
}

const ids = (rows) => rows.map((row) => row.id).sort();

// Row factory. History never validates schema, so readable ids beat uuids here.
let counter = 0;
function row(overrides = {}) {
  counter += 1;
  return {
    id: `r${counter}`,
    session_id: 's1',
    exercise_id: 'squat',
    set_index: 0,
    weight_kg: 100,
    reps: 5,
    rpe: null,
    is_warmup: false,
    logged_at: '2026-07-01T18:00:00.000Z',
    supersedes_id: null,
    is_void: false,
    is_extra: false,
    rounds: null,
    hold_seconds: null,
    device_id: 'test',
    ...overrides,
  };
}

const starts = (pairs) => new Map(pairs);

// ------------------------------------------------------------------ epley

test('epley matches the formula the UI states', () => {
  eq(epley1rm(100, 5), 116.67);
  eq(epley1rm(100, 1), 103.33);
  eq(epley1rm(60, 10), 80);
});

// ------------------------------------------------------------------ supersession chains

test('a lone row counts', () => {
  const a = row();
  eq(ids(activeSetLogs([a])), [a.id]);
});

test('a correction replaces the row it supersedes', () => {
  const a = row({ reps: 5 });
  const b = row({ reps: 6, supersedes_id: a.id });
  const live = activeSetLogs([a, b]);
  eq(live.length, 1, 'one row survives');
  eq(live[0].reps, 6, 'the correction is what counts');
});

test('log, correct, correct again leaves only the newest', () => {
  const a = row({ reps: 5 });
  const b = row({ reps: 6, supersedes_id: a.id });
  const c = row({ reps: 7, supersedes_id: b.id });
  const live = activeSetLogs([a, b, c]);
  eq(live.length, 1);
  eq(live[0].reps, 7);
});

test('log, correct, correct again, undo leaves nothing', () => {
  const a = row({ reps: 5 });
  const b = row({ reps: 6, supersedes_id: a.id });
  const c = row({ reps: 7, supersedes_id: b.id });
  const d = row({ reps: 7, supersedes_id: c.id, is_void: true });
  eq(activeSetLogs([a, b, c, d]), [], 'the whole chain is dead');
});

// The one that would quietly corrupt every number in the app if the filter were written as
// "drop rows superseded by a row that still counts" instead of "drop rows superseded at all".
test('voiding the newest row does not resurrect an earlier superseded row', () => {
  const a = row({ reps: 5, weight_kg: 100 });
  const b = row({ reps: 9, weight_kg: 140, supersedes_id: a.id });
  const c = row({ reps: 9, weight_kg: 140, supersedes_id: b.id, is_void: true });

  const live = activeSetLogs([a, b, c]);
  eq(live, [], 'nothing counts');
  ok(!live.some((r) => r.id === a.id), 'the original stays retracted');
  ok(!live.some((r) => r.id === b.id), 'the correction stays retracted');
});

test('a retraction two links deep does not resurrect the original', () => {
  const a = row({ reps: 5 });
  const b = row({ reps: 6, supersedes_id: a.id });
  const c = row({ reps: 6, supersedes_id: b.id, is_void: true });
  const d = row({ reps: 8, set_index: 1 });
  eq(ids(activeSetLogs([a, b, c, d])), [d.id], 'only the untouched set survives');
});

test('every row is still on disk after a chain is retracted', () => {
  const a = row();
  const b = row({ supersedes_id: a.id });
  const c = row({ supersedes_id: b.id, is_void: true });
  const stored = [a, b, c];
  eq(stored.length, 3, 'append only means nothing is ever removed');
  eq(activeSetLogs(stored), []);
});

// ------------------------------------------------------------------ offline replay

test('replaying a row that was later voided keeps it dead', () => {
  const a = row();
  const b = row({ supersedes_id: a.id, is_void: true });
  // The outbox flushes a second time and delivers a again. Storage is keyed by id, so the
  // reader sees the same pair, in whatever order the pull returned them.
  eq(activeSetLogs([a, b]), [], 'first delivery');
  eq(activeSetLogs([b, a]), [], 'replayed out of order');
});

test('a retraction that arrives before its original produces no phantom', () => {
  const a = row();
  const b = row({ supersedes_id: a.id, is_void: true });
  eq(activeSetLogs([b]), [], 'retraction alone counts for nothing');
  eq(activeSetLogs([a, b]), [], 'and the original stays dead once it lands');
});

test('order of rows never changes the answer', () => {
  const a = row({ reps: 5 });
  const b = row({ reps: 6, supersedes_id: a.id });
  const c = row({ reps: 7, set_index: 1 });
  const orders = [
    [a, b, c],
    [c, b, a],
    [b, a, c],
    [c, a, b],
  ];
  const answers = orders.map((rows) => ids(activeSetLogs(rows)));
  for (const answer of answers) eq(answer, answers[0], 'same rows, same result');
});

// ------------------------------------------------------------------ prefill

test('lastPerformance prefills from the corrected value, not the original', () => {
  const a = row({ session_id: 's1', reps: 5, weight_kg: 100 });
  const b = row({ session_id: 's1', reps: 8, weight_kg: 105, supersedes_id: a.id });
  const previous = lastPerformance([a, b], starts([['s1', '2026-07-01T18:00:00.000Z']]));
  eq(previous.bySetIndex.get(0).reps, 8);
  eq(previous.bySetIndex.get(0).weight_kg, 105);
});

test('lastPerformance reads the most recent session', () => {
  const old = row({ session_id: 's1', weight_kg: 100 });
  const recent = row({ session_id: 's2', weight_kg: 110 });
  const previous = lastPerformance(
    [old, recent],
    starts([
      ['s1', '2026-07-01T18:00:00.000Z'],
      ['s2', '2026-07-08T18:00:00.000Z'],
    ]),
  );
  eq(previous.sessionId, 's2');
  eq(previous.bySetIndex.get(0).weight_kg, 110);
});

// If a client undid every set of a session, that session never happened as far as the next
// prefill is concerned, and the steppers must fall back to the session before it.
test('a fully retracted session falls back to the one before it', () => {
  const old = row({ session_id: 's1', weight_kg: 100 });
  const recent = row({ session_id: 's2', weight_kg: 110 });
  const undone = row({ session_id: 's2', weight_kg: 110, supersedes_id: recent.id, is_void: true });
  const previous = lastPerformance(
    [old, recent, undone],
    starts([
      ['s1', '2026-07-01T18:00:00.000Z'],
      ['s2', '2026-07-08T18:00:00.000Z'],
    ]),
  );
  eq(previous.sessionId, 's1', 'prefill comes from the session that actually happened');
  eq(previous.bySetIndex.get(0).weight_kg, 100);
});

test('lastPerformance ignores sessions that are not this client', () => {
  const mine = row({ session_id: 's1', weight_kg: 100 });
  const theirs = row({ session_id: 'other', weight_kg: 200 });
  const previous = lastPerformance([mine, theirs], starts([['s1', '2026-07-01T18:00:00.000Z']]));
  eq(previous.sessionId, 's1');
  eq(previous.bySetIndex.get(0).weight_kg, 100, 'another client never reaches the steppers');
});

test('lastPerformance returns null when nothing survives', () => {
  const a = row();
  const b = row({ supersedes_id: a.id, is_void: true });
  eq(lastPerformance([a, b], starts([['s1', '2026-07-01T18:00:00.000Z']])), null);
});

test('lastPerformance keeps one entry per set index', () => {
  const one = row({ set_index: 0, weight_kg: 100 });
  const two = row({ set_index: 1, weight_kg: 100 });
  const three = row({ set_index: 2, weight_kg: 95 });
  const previous = lastPerformance([one, two, three], starts([['s1', '2026-07-01T18:00:00.000Z']]));
  eq(previous.bySetIndex.size, 3);
  eq(previous.bySetIndex.get(2).weight_kg, 95);
});

// ------------------------------------------------------------------ personal records

test('warmups never set a record', () => {
  const warmup = row({ weight_kg: 200, reps: 10, is_warmup: true });
  const working = row({ weight_kg: 100, reps: 5 });
  eq(bestEstimated1rm([warmup, working], starts([['s1', 'x']])), epley1rm(100, 5));
});

test('the best set in the history is the record', () => {
  const rows = [
    row({ weight_kg: 100, reps: 5 }), // 116.67
    row({ weight_kg: 110, reps: 3 }), // 121.00, the heaviest estimate despite the fewest reps
    row({ weight_kg: 95, reps: 8 }), // 120.33
  ];
  eq(bestEstimated1rm(rows, starts([['s1', 'x']])), epley1rm(110, 3));
});

// The whole product is built on making progress feel earned, so a record that was taken back
// has to stop being a record. Otherwise the next real one never fires.
test('undoing the set that fired a record gives the record back', () => {
  const history = row({ weight_kg: 100, reps: 5 });
  const map = starts([['s1', 'x']]);
  const before = bestEstimated1rm([history], map);

  const pr = row({ weight_kg: 120, reps: 5 });
  const withPr = bestEstimated1rm([history, pr], map);
  ok(withPr > before, 'the record moved when the set landed');

  const undone = row({ weight_kg: 120, reps: 5, supersedes_id: pr.id, is_void: true });
  eq(bestEstimated1rm([history, pr, undone], map), before, 'and moved back when it was undone');
});

test('correcting a record downward lowers the record', () => {
  const map = starts([['s1', 'x']]);
  const pr = row({ weight_kg: 120, reps: 5 });
  const corrected = row({ weight_kg: 120, reps: 3, supersedes_id: pr.id });
  eq(bestEstimated1rm([pr, corrected], map), epley1rm(120, 3));
});

test('no history means no record rather than zero', () => {
  eq(bestEstimated1rm([], starts([])), null);
  const a = row();
  const b = row({ supersedes_id: a.id, is_void: true });
  eq(bestEstimated1rm([a, b], starts([['s1', 'x']])), null);
});

// ------------------------------------------------------------------ stepper hold

// A background tab clamps setTimeout to one second, so the curve cannot be observed by
// holding a button in a headless pane. It is asserted here instead.

test('a tap is exactly one step', () => {
  eq(holdTicks(0), [0], 'nothing repeats before the delay');
  eq(holdTicks(HOLD_DELAY_MS - 1), [0], 'and still nothing just short of it');
});

test('repeating starts after the delay, not before', () => {
  const ticks = holdTicks(HOLD_DELAY_MS);
  eq(ticks.length, 2);
  eq(ticks[1], HOLD_DELAY_MS);
});

test('the gap between steps shrinks every time', () => {
  const ticks = holdTicks(3000);
  const gaps = ticks.slice(2).map((t, i) => t - ticks[i + 1]);
  ok(gaps.length > 5, 'enough steps to see a curve');
  for (let i = 1; i < gaps.length; i += 1) {
    ok(gaps[i] <= gaps[i - 1], `gap ${i} (${gaps[i]}) is not longer than gap ${i - 1} (${gaps[i - 1]})`);
  }
  ok(gaps[gaps.length - 1] < gaps[0], 'and it is meaningfully faster by the end');
});

test('acceleration stops at the floor rather than running away', () => {
  let interval = HOLD_START_MS;
  for (let i = 0; i < 200; i += 1) interval = nextHoldInterval(interval);
  eq(interval, HOLD_FLOOR_MS, 'the interval settles');
  const gaps = holdTicks(8000);
  const last = gaps[gaps.length - 1] - gaps[gaps.length - 2];
  ok(last >= HOLD_FLOOR_MS, 'no step is ever faster than the floor');
});

test('a two second hold covers a working weight change, not a nudge', () => {
  const steps = holdTicks(2000).length;
  ok(steps >= 8, `expected a usable number of steps, got ${steps}`);
  ok(steps <= 20, `expected the load not to run away, got ${steps}`);
});

// ------------------------------------------------------------------ opening weight
//
// Runs once per client per exercise, on a lift nobody has watched them do. The rule is that it
// never invents a number that pretends to know how strong somebody is.

test('the trainer starting weight wins whenever it is set', () => {
  const r = openingWeight({ startingWeightKg: 60, equipment: 'barbell', incrementKg: 2.5 });
  eq(r.kg, 60);
  eq(r.source, 'trainer');
});

test('a blank starting weight on a barbell falls back to the empty bar', () => {
  const r = openingWeight({ startingWeightKg: null, equipment: 'barbell', incrementKg: 2.5 });
  eq(r.kg, EMPTY_BARBELL_KG);
  eq(r.source, 'bar');
});

test('a blank starting weight elsewhere falls back to the lightest the equipment holds', () => {
  eq(openingWeight({ startingWeightKg: null, equipment: 'cable', incrementKg: 5 }).kg, 5);
  eq(openingWeight({ startingWeightKg: null, equipment: 'machine', incrementKg: 10 }).kg, 10);
  eq(openingWeight({ startingWeightKg: null, equipment: 'dumbbell', incrementKg: 2 }).kg, 2);
  eq(openingWeight({ startingWeightKg: null, equipment: 'cable', incrementKg: 5 }).source, 'lightest');
});

// The direction of the error is the whole design. Under costs a few taps on the stepper. Over
// costs a failed rep, or an injury, and a client who stops trusting the numbers.
test('every fallback is lighter than any plausible working weight', () => {
  for (const eq_ of ['barbell', 'dumbbell', 'cable', 'machine']) {
    const r = openingWeight({ startingWeightKg: null, equipment: eq_, incrementKg: 5 });
    ok(r.kg <= EMPTY_BARBELL_KG, `${eq_} opened at ${r.kg}, which is not obviously light`);
  }
});

test('a nonsense starting weight is ignored rather than trusted', () => {
  for (const bad of [0, -20, null, undefined, Number.NaN, 'heavy']) {
    const r = openingWeight({ startingWeightKg: bad, equipment: 'barbell', incrementKg: 2.5 });
    eq(r.kg, EMPTY_BARBELL_KG, `starting weight ${String(bad)} should not have been used`);
    eq(r.source, 'bar');
  }
});

test('a missing increment does not produce a zero or a NaN', () => {
  for (const bad of [0, -1, undefined, Number.NaN]) {
    const r = openingWeight({ startingWeightKg: null, equipment: 'cable', incrementKg: bad });
    ok(Number.isFinite(r.kg) && r.kg > 0, `increment ${String(bad)} produced ${r.kg}`);
  }
});

test('the copy says where the number came from and never apologises', () => {
  for (const source of ['trainer', 'bar', 'lightest']) {
    const copy = openingCopy(source);
    ok(copy.startsWith('First time on this lift.'), `${source} copy does not name the situation`);
    ok(!/no data|not enough|sorry|unfortunately/i.test(copy), `${source} copy apologises`);
  }
});

// ------------------------------------------------------------------ progression
//
// The chart series. Everything a chart is allowed to claim is decided here, so the drawing
// code never has to make a judgement about what counts.

const sess = (id, day, assignment = 'a1') => ({
  id,
  client_id: 'c1',
  assignment_id: assignment,
  day_index: 0,
  started_at: `${day}T18:00:00.000Z`,
  completed_at: null,
  client_note: null,
});

const assign = (id, startsOn, deloadWeeks = []) => ({
  id,
  client_id: 'c1',
  template_id: 't1',
  snapshot: {},
  starts_on: startsOn,
  ends_on: null,
  deload_weeks: deloadWeeks,
});

test('evidence escalates with the number of points', () => {
  eq(evidenceLevel(0), 'none');
  eq(evidenceLevel(1), 'single');
  eq(evidenceLevel(2), 'compare');
  eq(evidenceLevel(3), 'compare');
  eq(evidenceLevel(4), 'trend');
});

test('two points is a comparison and never a trend', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 100, reps: 6 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.e1rm.evidence, 'compare');
  eq(p.volume.evidence, 'compare');
});

test('one session is a fact, with no trend and no comparison', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [row({ session_id: 's1', weight_kg: 100, reps: 5 })];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.e1rm.evidence, 'single');
  eq(p.e1rm.change, null, 'a single point cannot produce a change');
  eq(p.points.length, 1);
});

// The whole reason is_extra became a column: adding sets must not move the number that carries
// a claim, or the easiest way to make the line rise is junk volume.
test('extra sets are counted separately and never inside prescribed volume', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5, is_extra: false }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5, is_extra: true }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].prescribed, 500);
  eq(p.points[0].extra, 500);
});

test('an extra set cannot set a record or move the strength line', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5, is_extra: false }),
    row({ session_id: 's1', set_index: 1, weight_kg: 200, reps: 5, is_extra: true }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].e1rm, epley1rm(100, 5), 'strength read the prescribed set, not the extra one');
});

test('warmups never reach any series', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: 10, is_warmup: true }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].prescribed, 500, 'warmup volume was excluded');
  eq(p.points[0].e1rm, epley1rm(100, 5));
});

test('a retracted set is gone from the charts as well as the steppers', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const original = row({ session_id: 's1', weight_kg: 100, reps: 5 });
  const undone = row({ session_id: 's1', weight_kg: 100, reps: 5, supersedes_id: original.id, is_void: true });
  const p = buildProgression({ setLogs: [original, undone], sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points.length, 0, 'a session whose only set was retracted contributes nothing');
});

test('a week is measured from the start of its own block', () => {
  eq(weekIndexOf('2026-07-01T18:00:00.000Z', '2026-07-01'), 0);
  eq(weekIndexOf('2026-07-08T18:00:00.000Z', '2026-07-01'), 1);
  eq(weekIndexOf('2026-08-12T18:00:00.000Z', '2026-07-01'), 6);
  eq(weekIndexOf('2026-07-01T18:00:00.000Z', null), null);
});

// Trainer marked, never inferred. A dip cannot be told apart from a bad week until the client
// comes back and lifts heavy again, which is a week after they needed to read it as planned.
test('a deload is marked from the assignment and excluded from the change', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08'), sess('s3', '2026-07-15')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 75, reps: 5 }),
    row({ session_id: 's3', weight_kg: 105, reps: 5 }),
  ];
  const p = buildProgression({
    setLogs: logs,
    sessions,
    assignments: [assign('a1', '2026-07-01', [1])],
    exerciseId: 'squat',
  });
  eq(p.points.map((x) => x.isDeload), [false, true, false]);
  eq(p.e1rm.change.first, epley1rm(100, 5), 'the change starts at the first working session');
  eq(p.e1rm.change.last, epley1rm(105, 5), 'and ends at the last one, stepping over the deload');
});

test('an unmarked dip is drawn but never called a deload', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 70, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points.map((x) => x.isDeload), [false, false], 'nothing is labelled without the trainer saying so');
  eq(p.points.length, 2, 'and the dip is still shown');
});

test('a deload cannot set a record', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 200, reps: 5 }),
  ];
  const p = buildProgression({
    setLogs: logs,
    sessions,
    assignments: [assign('a1', '2026-07-01', [1])],
    exerciseId: 'squat',
  });
  eq(p.points[1].isRecord, false);
});

// Volume is never compared across a rep scheme change. A block is an assignment, and since the
// snapshot freezes the rep range, an assignment boundary is a prescription change.
test('volume is segmented by block and strength is not', () => {
  const sessions = [
    sess('s1', '2026-07-01', 'a1'),
    sess('s2', '2026-07-08', 'a1'),
    sess('s3', '2026-08-05', 'a2'),
    sess('s4', '2026-08-12', 'a2'),
  ];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: 10 }),
    row({ session_id: 's2', weight_kg: 60, reps: 10 }),
    row({ session_id: 's3', weight_kg: 90, reps: 3 }),
    row({ session_id: 's4', weight_kg: 90, reps: 3 }),
  ];
  const p = buildProgression({
    setLogs: logs,
    sessions,
    assignments: [assign('a1', '2026-07-01'), assign('a2', '2026-08-05')],
    exerciseId: 'squat',
  });
  eq(p.blocks.length, 2);
  eq(p.volume.segments.map((s) => s.points.length), [2, 2], 'volume is cut at the boundary');
  eq(p.e1rm.series.length, 4, 'strength crosses it, which is the reason it exists');
  eq(p.leadView, 'e1rm', 'two blocks means the six month question exists, so strength leads');
});

test('one block leads with volume, since there is no cross block story yet', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [row({ session_id: 's1' }), row({ session_id: 's2' })];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.leadView, 'volume');
});

// The measured case that decided the second altitude: the same work reads minus 25 percent as
// volume and plus 23.8 percent as estimated 1RM.
test('the rep scheme change that breaks volume is exactly what strength is for', () => {
  const sessions = [sess('s1', '2026-07-01', 'a1'), sess('s2', '2026-08-05', 'a2')];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: 10 }),
    row({ session_id: 's1', set_index: 1, weight_kg: 60, reps: 10 }),
    row({ session_id: 's1', set_index: 2, weight_kg: 60, reps: 10 }),
    row({ session_id: 's2', weight_kg: 90, reps: 3 }),
    row({ session_id: 's2', set_index: 1, weight_kg: 90, reps: 3 }),
    row({ session_id: 's2', set_index: 2, weight_kg: 90, reps: 3 }),
    row({ session_id: 's2', set_index: 3, weight_kg: 90, reps: 3 }),
    row({ session_id: 's2', set_index: 4, weight_kg: 90, reps: 3 }),
  ];
  const p = buildProgression({
    setLogs: logs,
    sessions,
    assignments: [assign('a1', '2026-07-01'), assign('a2', '2026-08-05')],
    exerciseId: 'squat',
  });
  eq(p.points[0].prescribed, 1800);
  eq(p.points[1].prescribed, 1350);
  const volPct = Math.round(((1350 - 1800) / 1800) * 1000) / 10;
  eq(volPct, -25, 'volume reports a quarter lost');
  ok(p.e1rm.change.percent > 23 && p.e1rm.change.percent < 24, `strength reported ${p.e1rm.change.percent} percent`);
});

test('reps at load is capped and keeps the most recent loads', () => {
  const days = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29'];
  const sessions = days.map((d, i) => sess(`s${i}`, d));
  const logs = days.map((d, i) => row({ session_id: `s${i}`, weight_kg: 90 + i * 2.5, reps: 5 }));
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.repsAtLoad.lines.length, MAX_LOAD_LINES, 'capped so six months does not become stubs');
  eq(p.repsAtLoad.hiddenCount, days.length - MAX_LOAD_LINES);
  eq(p.repsAtLoad.lines[p.repsAtLoad.lines.length - 1].loadKg, 100, 'the newest load is last');
});

// The intermediate case, which is the profile the whole design targets. One load, reps
// climbing. Not a degenerate chart, the only place this progress is visible.
test('one unchanged load across a block is a single line, not an empty chart', () => {
  const days = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'];
  const sessions = days.map((d, i) => sess(`s${i}`, d));
  const logs = days.map((d, i) => row({ session_id: `s${i}`, weight_kg: 92.5, reps: 5 + i }));
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.repsAtLoad.lines.length, 1);
  eq(p.repsAtLoad.lines[0].points.map((x) => x.reps), [5, 6, 7, 8]);
  eq(p.repsAtLoad.evidence, 'trend');
});

test('reps at load reads the top set of that load in a session', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 8 }),
    row({ session_id: 's1', set_index: 2, weight_kg: 100, reps: 4 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.repsAtLoad.lines[0].points[0].reps, 8);
});

test('another client rows and other exercises never reach the series', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 'not-mine', weight_kg: 500, reps: 5 }),
    row({ session_id: 's1', exercise_id: 'bench', weight_kg: 400, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points.length, 1);
  eq(p.points[0].prescribed, 500);
});

test('no history produces empty series rather than an exception', () => {
  const p = buildProgression({ setLogs: [], sessions: [], assignments: [], exerciseId: 'squat' });
  eq(p.points, []);
  eq(p.e1rm.evidence, 'none');
  eq(p.volume.evidence, 'none');
  eq(p.blocks, []);
  eq(p.leadView, 'volume');
});

// ------------------------------------------------------------------ deload suggestion
//
// The only inference in the product, and it never produces a label. It produces a question,
// put to the trainer, because measured against noisy data this rule flagged every unplanned
// dip it was given.

test('a dip suggests a question, and marking it removes the question', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08'), sess('s3', '2026-07-15')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 75, reps: 5 }),
    row({ session_id: 's3', weight_kg: 100, reps: 5 }),
  ];
  const unmarked = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  const asked = suggestDeloadWeeks(unmarked);
  eq(asked.length, 1);
  eq(asked[0].week, 1);
  eq(asked[0].dropPercent, 25);

  const marked = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01', [1])], exerciseId: 'squat' });
  eq(suggestDeloadWeeks(marked), [], 'an answered question stops being asked');
});

test('a small dip is not worth asking about', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 97.5, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(suggestDeloadWeeks(p), []);
});

test('a steadily climbing block asks nothing', () => {
  const days = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'];
  const sessions = days.map((d, i) => sess(`s${i}`, d));
  const logs = days.map((d, i) => row({ session_id: `s${i}`, weight_kg: 90 + i * 2.5, reps: 5 }));
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(suggestDeloadWeeks(p), []);
});

test('one question per week, not one per session', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08'), sess('s3', '2026-07-09')];
  const logs = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's2', weight_kg: 70, reps: 5 }),
    row({ session_id: 's3', weight_kg: 70, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(suggestDeloadWeeks(p).length, 1);
});

// ------------------------------------------------------------------ reading a trainer's sheet
//
// Fixtures are real cells from a real workbook: 61 exercise rows across 10 day blocks. The
// counts quoted are what those rules currently cover.

test('a plain rep count and a rep range both parse', () => {
  eq(parseReps('8'), { low: 8, high: 8, text: '8' });
  eq(parseReps('6-8'), { low: 6, high: 8, text: '6-8' });
  eq(parseReps('12-15'), { low: 12, high: 15, text: '12-15' });
});

// 16 of 61 rows. A distance or a duration has no rep count, and none is invented for it.
test('a distance or a duration keeps its text and yields no numbers', () => {
  for (const cell of ['50 FT', '500M', '400M', '200M', '100M', '25M', '10 MINS']) {
    const r = parseReps(cell);
    eq(r.low, null, `${cell} produced a rep count`);
    eq(r.high, null);
    eq(r.text, cell, 'the trainer text survives verbatim');
  }
});

test('NA in the reps cell is nothing at all', () => {
  eq(parseReps('N/A'), { low: null, high: null, text: null });
  eq(parseReps('NA'), { low: null, high: null, text: null });
  eq(parseReps(''), { low: null, high: null, text: null });
});

test('rest parses seconds and minutes, and NA is null', () => {
  eq(parseRest('60 SEC'), 60);
  eq(parseRest('90 SEC'), 90);
  eq(parseRest('45 SEC'), 45);
  eq(parseRest('2 MIN'), 120);
  eq(parseRest('NA'), null);
  eq(parseRest('N/A'), null);
  eq(parseRest(''), null);
});

// RIR is reps in reserve, so RPE is ten minus it. 37 of 61 rows are RIR.
test('RIR converts to RPE and a range takes the harder end', () => {
  eq(parseLoad('1 RIR'), { text: '1 RIR', rpe: 9 });
  eq(parseLoad('2 RIR'), { text: '2 RIR', rpe: 8 });
  eq(parseLoad('3 RIR'), { text: '3 RIR', rpe: 7 });
  eq(parseLoad('1-2 RIR'), { text: '1-2 RIR', rpe: 9 }, 'the top of the effort range');
});

// The whole reason target_load exists. None of these is a number.
test('a load that is not an effort keeps its words and gets no RPE', () => {
  for (const cell of ['BW', 'ASSISTED BW', 'MODERATE', '2 PLATES', '5-7 SPEED', '3 MINS', '1 MINUTE']) {
    const r = parseLoad(cell);
    eq(r.text, cell);
    eq(r.rpe, null, `${cell} was given an RPE it does not have`);
  }
});

test('sets parses a count and NA is null', () => {
  eq(parseSets('3'), 3);
  eq(parseSets('4'), 4);
  eq(parseSets('NA'), null);
  eq(parseSets('N/A'), null);
  eq(parseSets(''), null);
});

test('a lettered set number marks a superset or a circuit', () => {
  eq(parseGroup('1'), { label: '1', group: '1', isGrouped: false });
  eq(parseGroup('1A'), { label: '1A', group: '1', isGrouped: true });
  eq(parseGroup('2B'), { label: '2B', group: '2', isGrouped: true });
  eq(parseGroup('3C'), { label: '3C', group: '3', isGrouped: true });
  ok(parseGroup('1A').group === parseGroup('1B').group, '1A and 1B are one group');
});

test('a rep count means the normal weight and reps', () => {
  eq(inferLogging({ repsText: '6-8', loadText: '1-2 RIR', sets: 4 }),
     { isLogged: true, logMode: 'weight_reps', certain: true });
});

// A carry or a sled: the load is the whole point and there are no reps to count.
//
// The second case used to assert weight_only for a load of 'N/A', under a test named 'with a
// load'. The name was the correct rule and the assertion was the shipped bug: a 400m ski erg
// carries nothing, and asking a client to enter a weight for it is asking for a number that does
// not exist. See prescribesLoad.
test('a distance with a load logs weight only, and without one is not logged', () => {
  eq(inferLogging({ repsText: '50 FT', loadText: '2 PLATES', sets: 3 }),
     { isLogged: true, logMode: 'weight_only', certain: true });
  eq(inferLogging({ repsText: '50 FT', loadText: '1-2 RIR', sets: 3 }),
     { isLogged: true, logMode: 'weight_only', certain: true });
  eq(inferLogging({ repsText: '400M', loadText: 'N/A', sets: 3 }),
     { isLogged: false, logMode: 'weight_reps', certain: true });
  eq(inferLogging({ repsText: '500M', loadText: '', sets: 3 }),
     { isLogged: false, logMode: 'weight_reps', certain: true });
});

// A word about pace is not a load, and it is the case that separates a sled from a run. Both are
// a distance in the Reps column, and only one of them has anything on it.
test('a pace word in the load column is not a load', () => {
  ok(prescribesLoad('1-2 RIR'));
  ok(prescribesLoad('RPE 8'));
  ok(prescribesLoad('2 PLATES'));
  ok(prescribesLoad('25 - 45 LBS'));
  ok(!prescribesLoad('MODERATE'));
  ok(!prescribesLoad('5-7 SPEED'));
  ok(!prescribesLoad('N/A'));
  ok(!prescribesLoad(''));
  ok(!prescribesLoad('BW'), 'the body is a load nobody selects, and has its own mode');

  eq(inferLogging({ repsText: '100M', loadText: 'MODERATE', sets: null }),
     { isLogged: false, logMode: 'weight_reps', certain: true });
});

// A running interval has no sets, no reps, and a duration in the Load cell. There is nothing
// to measure, so nothing is asked for.
test('a cardio interval is not logged at all', () => {
  eq(inferLogging({ repsText: 'N/A', loadText: '3 MINS', sets: null }),
     { isLogged: false, logMode: 'weight_reps', certain: true });
  eq(inferLogging({ repsText: 'N/A', loadText: '1 MINUTE', sets: null }),
     { isLogged: false, logMode: 'weight_reps', certain: true });
});

// Certainty is a claim about the inference, not about the row. It is what the review screen
// flags on, so a rule that decided cleanly must not ask for a second opinion.
test('certainty separates a decided row from a guessed one', () => {
  ok(inferLogging({ repsText: '12', loadText: '1 RIR', sets: 3 }).certain,
     'a rep count beside an effort target is decided');
  ok(inferLogging({ repsText: '12', loadText: 'BW', sets: 3 }).certain,
     'a rep count beside the body is decided');
  ok(!inferLogging({ repsText: '12', loadText: '', sets: 3 }).certain,
     'a rep count with an empty load cell could be either');
  ok(!inferLogging({ repsText: 'AMRAP', loadText: '1 RIR', sets: 1 }).certain,
     'AMRAP says nothing about what is in the hands');
  ok(!inferLogging({ repsText: '', loadText: '', sets: null }).certain,
     'a row with nothing in either cell is a note somebody typed, and wants deleting');
});

test('the target line shows what the trainer wrote, not a reassembly of it', () => {
  eq(targetLine({ target_sets: 4, target_reps_text: '6-8', target_load: '1-2 RIR', rest_seconds: 60 }),
     '4 sets, 6-8, 1-2 RIR, 60s rest');
  eq(targetLine({ target_sets: 3, target_reps_text: '50 FT', target_load: '2 PLATES', rest_seconds: null }),
     '3 sets, 50 FT, 2 PLATES');
  eq(targetLine({ target_sets: null, target_reps_text: '10 MINS', target_load: '5-7 SPEED', rest_seconds: null }),
     '10 MINS, 5-7 SPEED');
});

// ------------------------------------------------------------------ logging what has no reps

test('a weight only set contributes no volume and no estimated 1RM', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: null }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].prescribed, 500, 'only the row with reps counted');
  eq(p.points[0].e1rm, epley1rm(100, 5), 'the repless row cannot set a strength number');
});

test('an AMRAP round count never becomes a rep count', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [row({ session_id: 's1', weight_kg: 24, reps: null, rounds: 5 })];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].prescribed, 0, 'rounds are not reps and do not multiply into volume');
  eq(p.points[0].e1rm, null);
});

test('a repless row does not appear as a load line', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: null }),
    row({ session_id: 's2', weight_kg: 60, reps: null }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.repsAtLoad.lines, [], 'reps at load has nothing to draw without reps');
});

// ------------------------------------------------------------------ freezing a program
//
// A snapshot is the only thing in the schema nobody can migrate: it is frozen history by
// definition, so a field this builder gets wrong is wrong on every assignment ever written from
// it. Three callers read this shape (the logging screen, a client reading their program, a
// trainer previewing one), which is exactly why it stopped living inside the seed generator.

const ex = (id, over = {}) => ({
  id, name: id, slug: id, equipment: 'barbell', increment_kg: 2.5, ...over,
});
const tday = (id, day_index, over = {}) => ({
  id, day_index, name: `Day ${day_index}`, day_type: 'STRENGTH', split: 'FULL',
  warmup: { mobility: [], general: [], specific: [] }, comments: '', ...over,
});
const titem = (id, day_id, order_index, exercise_id, over = {}) => ({
  id, day_id, order_index, exercise_id, target_sets: 3, is_logged: true, ...over,
});

const program = {
  template: { id: 't1', name: 'Foundations', notes: 'Add load before adding sets.' },
  days: [tday('d1', 0), tday('d2', 1)],
  items: [titem('i1', 'd1', 0, 'squat'), titem('i2', 'd1', 1, 'bench'), titem('i3', 'd2', 0, 'squat')],
  exercises: [ex('squat'), ex('bench')],
};

test('a snapshot carries the exercise inline, since a client can never resolve one by id', () => {
  const snap = buildSnapshot(program);
  eq(snap.days[0].items[0].exercise.name, 'squat');
  eq(snap.days[0].items[0].exercise_id, 'squat', 'the original column survives alongside it');
});

test('a snapshot carries the five exercise fields and nothing the library grows later', () => {
  const snap = buildSnapshot({ ...program, exercises: [ex('squat', { secret: 'x' }), ex('bench')] });
  eq(Object.keys(snap.days[0].items[0].exercise), ['id', 'name', 'slug', 'equipment', 'increment_kg']);
});

test('days and items come out ordered however the rows arrived', () => {
  const snap = buildSnapshot({
    ...program,
    days: [tday('d2', 1), tday('d1', 0)],
    items: [titem('i2', 'd1', 1, 'bench'), titem('i3', 'd2', 0, 'squat'), titem('i1', 'd1', 0, 'squat')],
  });
  eq(snap.days.map((d) => d.id), ['d1', 'd2']);
  eq(snap.days[0].items.map((i) => i.id), ['i1', 'i2']);
});

test('items land on their own day and never on the next one', () => {
  const snap = buildSnapshot(program);
  eq(snap.days[0].items.length, 2);
  eq(snap.days[1].items.map((i) => i.id), ['i3']);
});

test('freezing does not reorder the caller rows underneath it', () => {
  const days = [tday('d2', 1), tday('d1', 0)];
  buildSnapshot({ ...program, days });
  eq(days.map((d) => d.id), ['d2', 'd1'], 'the caller still holds what it passed in');
});

test('an exercise the library cannot resolve is refused rather than frozen blank', () => {
  let message = '';
  try {
    buildSnapshot({ ...program, exercises: [ex('squat')] });
  } catch (error) {
    message = error.message;
  }
  ok(/no longer in the library/i.test(message), `expected a refusal, got "${message}"`);
});

test('the refusal names the row on the sheet, since a uuid is the one thing nobody can search', () => {
  let message = '';
  try {
    buildSnapshot({
      ...program,
      days: [tday('d1', 0, { split: 'UPPER A' })],
      items: [titem('i2', 'd1', 1, 'bench', { group_label: '2B' })],
      exercises: [ex('squat')],
    });
  } catch (error) {
    message = error.message;
  }
  ok(message.startsWith('UPPER A, 2B '), message);
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(message), 'and never a uuid');
});

// ------------------------------------------------------------------ which day comes next

const frozen = buildSnapshot(program);
const onDay = (index) => ({ day_index: index });

test('a client with no history opens on the first day', () => {
  eq(pickDay(frozen, []).day_index, 0);
});

test('the rotation advances from the last session and wraps', () => {
  eq(pickDay(frozen, [onDay(0)]).day_index, 1, 'day 0 leads to day 1');
  eq(pickDay(frozen, [onDay(1)]).day_index, 0, 'the end of the rotation wraps to the start');
});

test('only the most recent session decides, whatever came before it', () => {
  eq(pickDay(frozen, [onDay(1), onDay(1), onDay(0)]).day_index, 1);
});

test('a session on a day this program no longer has starts the rotation again', () => {
  eq(pickDay(frozen, [onDay(7)]).day_index, 0);
});

test('a program with no days picks nothing rather than throwing', () => {
  eq(pickDay({ template: program.template, days: [] }, []), null);
  eq(pickDay({}, [onDay(0)]), null, 'a snapshot missing the key entirely is the same answer');
});

test('sorted reads survive a snapshot with a field missing', () => {
  eq(sortedDays(null), []);
  eq(sortedItems(undefined), []);
});

// ------------------------------------------------------------------ the top set last time
//
// One line per lift on a screen that lists a whole day. Which set it reports is the whole
// question: a ramp up and a back off set sit either side of the effort and neither is it.

test('the top set is the heaviest of the most recent session', () => {
  const rows = [
    row({ session_id: 's1', weight_kg: 90, reps: 5 }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5 }),
    row({ session_id: 's1', set_index: 2, weight_kg: 95, reps: 5 }),
  ];
  const best = topSet(rows, starts([['s1', '2026-07-01T18:00:00.000Z']]));
  eq({ weightKg: best.weightKg, reps: best.reps }, { weightKg: 100, reps: 5 });
});

test('at equal load the better set is the one with more reps', () => {
  const rows = [
    row({ session_id: 's1', weight_kg: 100, reps: 5 }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 8 }),
  ];
  eq(topSet(rows, starts([['s1', '2026-07-01']])).reps, 8);
});

test('a heavier warmup never becomes the top set', () => {
  const rows = [
    row({ session_id: 's1', weight_kg: 140, reps: 1, is_warmup: true }),
    row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5 }),
  ];
  eq(topSet(rows, starts([['s1', '2026-07-01']])).weightKg, 100);
});

test('an older heavier session does not outrank the most recent one', () => {
  const rows = [
    row({ session_id: 's1', weight_kg: 120, reps: 5 }),
    row({ session_id: 's2', weight_kg: 100, reps: 5 }),
  ];
  const best = topSet(rows, starts([['s1', '2026-07-01'], ['s2', '2026-07-08']]));
  eq(best.weightKg, 100, 'last time means last time, not best ever');
  eq(best.on, '2026-07-08');
});

test('a correction is what gets reported, never the row it replaced', () => {
  const original = row({ session_id: 's1', weight_kg: 100, reps: 5 });
  const fixed = row({ session_id: 's1', weight_kg: 90, reps: 5, supersedes_id: original.id });
  eq(topSet([original, fixed], starts([['s1', '2026-07-01']])).weightKg, 90);
});

test('a repless row has no weight for reps to state and is skipped', () => {
  const rows = [
    row({ session_id: 's1', weight_kg: 60, reps: null }),
    row({ session_id: 's1', set_index: 1, weight_kg: 40, reps: 10 }),
  ];
  eq(topSet(rows, starts([['s1', '2026-07-01']])).weightKg, 40);
});

test('a session of nothing but repless rows reports nothing rather than a null weight', () => {
  const rows = [row({ session_id: 's1', weight_kg: 60, reps: null })];
  eq(topSet(rows, starts([['s1', '2026-07-01']])), null);
});

test('another client rows never reach the answer', () => {
  const rows = [row({ session_id: 'theirs', weight_kg: 200, reps: 5 })];
  eq(topSet(rows, starts([['s1', '2026-07-01']])), null);
});

// ------------------------------------------------------------------ a program, read
//
// One renderer serves the client reading their program and the trainer checking it, so a rule
// broken here is broken on both screens at once. These pin what the view claims: the counts, the
// supersets, and the rows a client would otherwise never learn about.

const load = (items) => dayLoad({ items });

test('the load line counts lifts and the sets they ask for', () => {
  eq(loadLine({ items: [titem('a', 'd', 0, 'squat', { target_sets: 3 }), titem('b', 'd', 1, 'bench', { target_sets: 4 })] }),
    '2 lifts, 7 sets');
});

test('a lift with no set count adds no sets rather than a zero', () => {
  eq(load([titem('a', 'd', 0, 'squat', { target_sets: 3 }), titem('b', 'd', 1, 'bike', { target_sets: null })]),
    { lifts: 2, sets: 3, shown: 0 });
});

test('a row the trainer does not log is counted apart, never as a lift with no sets', () => {
  const items = [titem('a', 'd', 0, 'squat', { target_sets: 3 }), titem('b', 'd', 1, 'bike', { is_logged: false })];
  eq(load(items), { lifts: 1, sets: 3, shown: 1 });
  eq(loadLine({ items }), '1 lift, 3 sets, 1 not logged');
});

test('a day of nothing but instruction still says what is in it', () => {
  eq(loadLine({ items: [titem('a', 'd', 0, 'bike', { is_logged: false })] }), '1 not logged');
});

test('an empty day is an invitation rather than a zero', () => {
  eq(loadLine({ items: [] }), 'Nothing in this day yet.');
});

test('rows sharing a leading number are one superset', () => {
  const runs = groupItems({ items: [
    titem('a', 'd', 0, 'squat', { group_label: '1A' }),
    titem('b', 'd', 1, 'bench', { group_label: '1B' }),
    titem('c', 'd', 2, 'row', { group_label: '2' }),
  ] });
  eq(runs.map((r) => r.items.length), [2, 1]);
  eq(runs[0].group, '1');
  eq(runs[1].group, null, 'a bare number is not a group of one');
});

test('a letter is what makes a group, so two plain numbers never merge', () => {
  const runs = groupItems({ items: [
    titem('a', 'd', 0, 'squat', { group_label: '1' }),
    titem('b', 'd', 1, 'bench', { group_label: '1' }),
  ] });
  eq(runs.length, 2);
});

test('the same group split by another lift does not reach across it', () => {
  const runs = groupItems({ items: [
    titem('a', 'd', 0, 'squat', { group_label: '1A' }),
    titem('b', 'd', 1, 'bench', { group_label: '2' }),
    titem('c', 'd', 2, 'row', { group_label: '1B' }),
  ] });
  eq(runs.map((r) => r.items.length), [1, 1, 1]);
});

const view = (over = {}) => buildSnapshot({
  ...program,
  items: [
    titem('i1', 'd1', 0, 'squat', { group_label: '1', target_sets: 3, target_reps_text: '5-8', target_load: '1-2 RIR', rest_seconds: 180, notes: 'Full depth.', ...over }),
    titem('i3', 'd2', 0, 'bench', { target_sets: 3 }),
  ],
});

test('the view renders the prescription sentence, not a rebuilt one', () => {
  const html = renderProgram(view(), 0);
  ok(html.includes('3 sets, 5-8, 1-2 RIR, 180s rest'), 'the target line is targetLine output');
  ok(html.includes('Full depth.'), 'the coaching note reaches the client');
});

test('the view opens where pickDay would, so a preview and the logging screen agree', () => {
  const snap = view();
  ok(renderProgram(snap).includes('>squat<'), 'the first day is what opens');
  ok(renderProgram(snap, 1).includes('>bench<'), 'and a named day overrides it');
});

test('a day index the program does not have falls back rather than rendering nothing', () => {
  ok(renderProgram(view(), 42).includes('>squat<'));
});

test('a program with no days says so instead of throwing', () => {
  const html = renderProgram({ template: program.template, days: [] });
  ok(/no days in this program yet/i.test(html), html);
  ok(!/sorry|unfortunately|cannot/i.test(html), 'an empty state invites rather than apologises');
});

test('one day is a label and not a chooser', () => {
  const single = buildSnapshot({ ...program, days: [tday('d1', 0)], items: [titem('i1', 'd1', 0, 'squat')] });
  ok(!renderProgram(single).includes('data-plan-day'), 'nothing to choose between');
  ok(renderProgram(view()).includes('data-plan-day'), 'two days get the chooser');
});

test('a row the client never logs is named on their program rather than hidden from it', () => {
  const html = renderProgram(view({ is_logged: false }), 0);
  ok(html.includes('>squat<'), 'the lift is still on the page');
  ok(html.includes('Not logged'), 'and says why it will not appear while logging');
});

test('a client sees what they lifted last time, under what they were asked to lift', () => {
  // In the unit the viewer reads, which is pounds unless somebody has said otherwise. Named here
  // rather than left to the module default, so this stays a test of the line and not of the
  // default: 100 kg is 220 lb.
  const history = new Map([['squat', { weightKg: 100, reps: 5, on: '2026-07-27T18:00:00.000Z' }]]);
  const html = renderProgram(view(), 0, history);
  ok(/Top set last time 220 lb for 5, Jul 27/.test(html), html);
});

test('a lift with no history says nothing rather than a zero', () => {
  const html = renderProgram(view(), 0, new Map());
  ok(!html.includes('Top set last time'), 'no invented number for a lift nobody has done');
});

test('a trainer previewing a template gets no history, because there is nobody whose it would be', () => {
  ok(!renderProgram(view(), 0).includes('Top set last time'));
});

test('nothing a trainer typed can close a tag', () => {
  const html = renderProgram(buildSnapshot({
    ...program,
    days: [tday('d1', 0, { split: '<img src=x>' })],
    items: [titem('i1', 'd1', 0, 'squat', { variation: '"><script>' })],
  }), 0);
  ok(!html.includes('<img'), 'the split is escaped');
  ok(!html.includes('<script>'), 'so is the variation');
});

// ------------------------------------------------------------------ naming a day
//
// One expression used to live in four places with three different endings, and two of them had no
// ending at all: both day pickers would render a chip with nothing written on it for a day the
// builder created and nobody named. A chooser with a blank option is worse than no chooser.

test('a day is called what the trainer called it, split first', () => {
  eq(dayTitle({ split: 'UPPER A', name: 'Day 1', day_index: 0 }), 'UPPER A');
});

test('a day with no split falls back to its name before its position', () => {
  eq(dayTitle({ split: null, name: 'Push', day_index: 2 }), 'Push');
});

test('a day the builder created and nobody named still has something to call it', () => {
  eq(dayTitle({ split: null, name: null, day_index: 2 }), 'Day 3', 'counted the way a person counts');
  eq(dayTitle({ split: '', name: '', day_index: 0 }), 'Day 1', 'an empty string is not a name');
});

test('naming a day that is not there does not throw', () => {
  eq(dayTitle(undefined), 'Day 1');
  eq(dayTitle(null), 'Day 1');
});

// ------------------------------------------------------------------ which block a client is on
//
// starts_on decides and created_at breaks the tie, and the tie is the ordinary case: a trainer
// who assigns a program, spots something in the editor, fixes it and assigns again has produced
// two rows carrying today's date. A single column sort with a limit of one returned whichever
// came back first, so the client could keep training from the snapshot that was just replaced.

const fakeStore = (rows) => ({ query: async () => rows });
const block = (name, startsOn, createdAt) => ({
  id: `a-${name}`, client_id: 'c1', template_id: `t-${name}`,
  snapshot: { template: { name } }, starts_on: startsOn, created_at: createdAt,
});

test('the latest starts_on is the block a client is on', async () => {
  const current = await currentAssignment(
    fakeStore([
      block('old', '2026-06-01', '2026-06-01T09:00:00.000Z'),
      block('new', '2026-08-01', '2026-08-01T09:00:00.000Z'),
    ]),
    'c1',
  );
  eq(current.snapshot.template.name, 'new');
});

test('two blocks starting the same day go to whichever was assigned last', async () => {
  const current = await currentAssignment(
    fakeStore([
      block('first', '2026-08-17', '2026-08-17T09:00:00.000Z'),
      block('corrected', '2026-08-17', '2026-08-17T14:30:00.000Z'),
    ]),
    'c1',
  );
  eq(current.snapshot.template.name, 'corrected', 'the correction wins, not the row order');

  // and the same the other way round, so this cannot pass on input order alone
  const reversed = await currentAssignment(
    fakeStore([
      block('corrected', '2026-08-17', '2026-08-17T14:30:00.000Z'),
      block('first', '2026-08-17', '2026-08-17T09:00:00.000Z'),
    ]),
    'c1',
  );
  eq(reversed.snapshot.template.name, 'corrected');
});

// created_at arrives in two formats that do not sort against each other. A row written on this
// device carries toISOString, a row that has been through the server carries what Postgres
// renders, and a space sorts before a T, so as text the synced row always looked older.
test('a synced timestamp and a local one are compared as instants, not as text', async () => {
  const current = await currentAssignment(
    fakeStore([
      block('local, and earlier', '2026-08-17', '2026-08-17T09:00:00.000Z'),
      block('synced, and later', '2026-08-17', '2026-08-17 14:30:00.048006+00'),
    ]),
    'c1',
  );
  eq(current.snapshot.template.name, 'synced, and later');

  ok(
    '2026-08-17 14:30:00.048006+00' < '2026-08-17T09:00:00.000Z',
    'as text the later synced row sorts first, which is the trap this avoids',
  );
});

test('a client with no blocks is on nothing, and it does not throw', async () => {
  eq(await currentAssignment(fakeStore([]), 'c1'), null);
});

// ------------------------------------------------------------ stale block or current one
//
// "On this program" and "on the version of this program I am looking at" are different facts, and
// the assign list collapsed them: a trainer who corrected a rest time on a live program read
// "Already on this program" both before the fix reached the client and after. Telling them apart
// is a comparison of two snapshots, and the trap in that comparison is that one of them has been
// to the server. snapshot is jsonb, and jsonb re-renders keys in its own order rather than storing
// the text it was handed, so a byte compare marks every synced client permanently stale.

test('a snapshot that has been through jsonb still matches the one it was built from', () => {
  const built = { template: { id: 't1', name: 'Emma Brown 2', notes: '' }, days: [{ day_index: 0, id: 'd1' }] };
  // The same value with every object's keys in a different order, which is what comes back.
  const returned = { days: [{ id: 'd1', day_index: 0 }], template: { notes: '', name: 'Emma Brown 2', id: 't1' } };

  ok(JSON.stringify(built) !== JSON.stringify(returned), 'as text these differ, which is the trap');
  ok(sameSnapshot(built, returned), 'as values they are the same program');
});

test('an edited rest time makes the assigned snapshot stale', () => {
  const before = { days: [{ items: [{ id: 'i1', rest_seconds: 60 }] }] };
  const after = { days: [{ items: [{ id: 'i1', rest_seconds: 90 }] }] };
  ok(!sameSnapshot(before, after), 'the one edit a trainer makes has to register');
});

test('array order is a real difference and key order is not', () => {
  const a = { days: [{ id: 'd1' }, { id: 'd2' }] };
  ok(!sameSnapshot(a, { days: [{ id: 'd2' }, { id: 'd1' }] }), 'reordering days reorders the program');
});

test('a missing field and an explicit null are the same snapshot', () => {
  // What a round trip does to undefined, so treating them apart would report a phantom edit.
  ok(sameSnapshot({ template: { notes: undefined } }, { template: { notes: null } }));
  ok(sameSnapshot(null, undefined), 'and neither of them being there does not throw');
});

// The deploy that adds a nullable column is the one this protects. Every snapshot frozen before it
// has no such key; every freeze after it carries the key as null. Marking those apart would call
// every client on every program stale over a change that altered nobody's training.
test('a snapshot frozen before a new nullable column is not stale because of it', () => {
  const before = { days: [{ id: 'd1', split: 'EMOM', items: [{ id: 'i1', rest_seconds: 60 }] }] };
  const after = { days: [{ id: 'd1', split: 'EMOM', emom: null, items: [{ id: 'i1', rest_seconds: 60 }] }] };
  ok(sameSnapshot(before, after), 'the column arrived, the prescription did not change');
});

test('a nullable column that is actually set is a real difference', () => {
  const off = { days: [{ id: 'd1', emom: null }] };
  const on = { days: [{ id: 'd1', emom: { rounds: 5, window_seconds: 60 } }] };
  ok(!sameSnapshot(off, on), 'turning a day into an EMOM changes the program');
  ok(!sameSnapshot(on, { days: [{ id: 'd1', emom: { rounds: 8, window_seconds: 60 } }] }), 'and so does the round count');
});

// Both of these are taken from the live database rather than imagined. buildSnapshot spreads a
// whole template_items row into every item, so these two columns ride along inside each snapshot,
// and both move without anybody editing a prescription.
test('a row saved again with nothing changed is not a new version of the program', () => {
  const item = (updatedAt) => ({
    days: [{ items: [{ id: 'i1', rest_seconds: 60, updated_at: updatedAt, created_at: '2026-08-23T20:25:30.059Z' }] }],
  });
  ok(
    sameSnapshot(item('2026-08-23T20:25:30.715549+00:00'), item('2026-08-23T22:12:55.738044+00:00')),
    'updated_at bumps on any write, and a write is not an edit',
  );
});

test('the same instant in the two spellings that cross the wire is the same program', () => {
  // fromWire passes created_at and updated_at through untouched, so a row written here and the
  // same row pulled back carry different text. A cache refresh must not flip a client to stale.
  const local = { days: [{ items: [{ id: 'i1', created_at: '2026-08-23T20:25:30.059Z', rest_seconds: 60 }] }] };
  const synced = { days: [{ items: [{ id: 'i1', created_at: '2026-08-23T20:25:30.059974+00:00', rest_seconds: 60 }] }] };
  ok(sameSnapshot(local, synced));
});

test('ignoring the stamps does not blind the compare to a real edit beside them', () => {
  const a = { days: [{ items: [{ id: 'i1', rest_seconds: 60, updated_at: 'x' }] }] };
  const b = { days: [{ items: [{ id: 'i1', rest_seconds: 0, updated_at: 'x' }] }] };
  ok(!sameSnapshot(a, b), 'the rest time is the whole point');
});

test('a nested edit is not hidden by a matching parent', () => {
  const deep = (rpe) => ({ days: [{ items: [{ exercise: { id: 'e1' }, target_rpe: rpe }] }] });
  ok(!sameSnapshot(deep(8), deep(9)));
  ok(sameSnapshot(deep(8), deep(8)));
});

// ------------------------------------------------------------------ dates that are not times
//
// assignments.starts_on is a date column, so it arrives as 'YYYY-MM-DD'. Date parses that as UTC
// midnight, which renders as the day before everywhere west of Greenwich, and this app is written
// in Canada. Every screen that prints one has to force local midnight, the way weekIndexOf
// already does.

test('a date column is read as local midnight, not as UTC', () => {
  const asDate = new Date('2026-08-06T00:00:00');
  eq(asDate.getDate(), 6, 'the 6th is the 6th in the zone the person is standing in');
  eq(asDate.getMonth(), 7);
});

test('week one is the week the block starts, counting the way anybody says it', () => {
  eq(weekIndexOf('2026-08-06T18:00:00.000Z', '2026-08-03'), 0, 'the first week is index zero');
  eq(weekIndexOf('2026-08-11T18:00:00.000Z', '2026-08-03'), 1);
});

test('a session before the block starts is a negative week, never week one', () => {
  ok(weekIndexOf('2026-07-30T18:00:00.000Z', '2026-08-03') < 0);
});

// The other half of the same problem, from the timestamp side. These assertions are written to
// hold in EVERY zone on purpose: test.html runs in whatever browser happens to be open, so
// "a 23:00 session stays in its own month" would pass in Toronto and fail in Berlin and tell us
// nothing either way. What is true everywhere is that localDayOf agrees with the platform's own
// idea of the local day, and that it disagrees with a naive slice exactly when the offset says so.

test('the day a session happened is the day where the person was standing', () => {
  const iso = '2026-08-06T23:30:00.000Z';
  eq(localDayOf(iso), isoDate(new Date(iso)), 'same answer the platform gives, in any zone');
});

test('an evening session belongs to the evening it happened, not to tomorrow', () => {
  // Built from local parts, which is what makes this hold everywhere: whatever instant half past
  // ten on the 6th is where this runs, the day it belongs to is the 6th. In Toronto the ISO string
  // this produces starts '2026-08-07', so a slice would file a Thursday session under Friday.
  const evening = new Date(2026, 7, 6, 22, 30, 0);
  eq(localDayOf(evening.toISOString()), '2026-08-06');
});

test('a month is read off a day string, never off a fresh Date', () => {
  eq(monthKey('2026-08-06'), '2026-08');
  eq(monthKey('2026-12-31'), '2026-12');
  eq(monthKey(null), null, 'nothing in, nothing out');
});

test('a date column becomes local midnight, so the calendar cannot start a day early', () => {
  const at = localMidnight('2026-08-06');
  eq(at.getDate(), 6);
  eq(at.getMonth(), 7);
  eq(at.getHours(), 0);
});

test('a date that is not a date returns null instead of an Invalid Date', () => {
  eq(localMidnight('not a date'), null);
  eq(localDayOf('not a date'), null);
});

// ------------------------------------------------------------------ showing up
//
// js/consistency.js. The grid answers a different question from the charts: not whether a lift is
// moving, but whether the person is training and at what. Everything below is either a rule
// CLAUDE.md states outright (an empty session is not a success, no streak and no missed count) or
// a case where the obvious implementation is quietly wrong (glyph collisions, the frozen program,
// local days).

const csession = (id, startedAt, over = {}) => ({
  id, client_id: 'c1', assignment_id: 'a1', day_index: 0, started_at: startedAt,
  completed_at: null, client_note: null, ...over,
});

const cassign = (id, startsOn, days, over = {}) => ({
  id, client_id: 'c1', template_id: 't1', starts_on: startsOn, ends_on: null, deload_weeks: [],
  snapshot: { template: { id: 't1', name: 'P', notes: '' }, days }, ...over,
});

const cday = (dayIndex, split) => ({ id: `d${dayIndex}`, day_index: dayIndex, name: null, split, items: [] });

// A local instant, so these hold in any zone. new Date(y, m, d, h) is local by definition.
const at = (y, m, d, h = 18) => new Date(y, m - 1, d, h, 0, 0).toISOString();

const cellFor = (built, day) =>
  built.months.flatMap((m) => m.weeks).flatMap((w) => w.days).find((c) => c.day === day && c.inMonth);

test('a day carries the split the client actually did, read off the frozen program', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3), { day_index: 1 })],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A'), cday(1, 'LOWER A')])],
    sessionIdsWithWork: new Set(['s1']),
    today: '2026-08-07',
  });
  const cell = cellFor(built, '2026-08-03');
  eq(cell.label, 'LOWER A');
  eq(cell.slot, 2, 'second day of the rotation takes the second colour');
});

test('the split comes from that session\'s own assignment, not from the current one', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 6, 2), { assignment_id: 'old' }), csession('s2', at(2026, 8, 3))],
    assignments: [
      cassign('old', '2026-06-01', [cday(0, 'FULL BODY')]),
      cassign('a1', '2026-08-03', [cday(0, 'UPPER A')]),
    ],
    sessionIdsWithWork: new Set(['s1', 's2']),
    today: '2026-08-07',
  });
  eq(cellFor(built, '2026-06-02').label, 'FULL BODY', 'June is still June');
  eq(cellFor(built, '2026-08-03').label, 'UPPER A');
});

test('a colour keys on the position in the rotation, so renaming a day does not repaint history', () => {
  const before = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A'), cday(1, 'LOWER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  const after = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'CHEST AND BACK'), cday(1, 'LOWER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(cellFor(before, '2026-08-03').slot, cellFor(after, '2026-08-03').slot, 'same slot, new words');
});

test('a new assignment does not reshuffle the colours on months already on screen', () => {
  const sessions = [csession('s1', at(2026, 8, 3))];
  const one = buildConsistency({
    sessions, assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-09-07',
  });
  const two = buildConsistency({
    sessions: [...sessions, csession('s2', at(2026, 9, 1), { assignment_id: 'a2' })],
    assignments: [
      cassign('a1', '2026-08-03', [cday(0, 'UPPER A')]),
      cassign('a2', '2026-09-01', [cday(0, 'PUSH'), cday(1, 'PULL')]),
    ],
    sessionIdsWithWork: new Set(['s1', 's2']), today: '2026-09-07',
  });
  eq(cellFor(one, '2026-08-03').slot, cellFor(two, '2026-08-03').slot, 'August did not move');
});

test('a session nobody logged a set in is not a trained day', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3)), csession('s2', at(2026, 8, 4))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']),
    today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').sessionIds, ['s1'], 'the one with work in it');
  eq(cellFor(built, '2026-08-04').sessionIds, [], 'tapping start and walking out is not a session');
  eq(built.totalSessions, 1);
});

test('an untrained day carries nothing a caller could render as a failure', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  const empty = cellFor(built, '2026-08-05');
  eq(empty.sessionIds, []);
  eq(empty.label, null);
  eq(empty.glyph, null);
  eq(empty.slot, null);
  eq(empty.isDeload, false, 'no state at all, not even a quiet one');
  ok(!('expected' in empty) && !('missed' in empty), 'and nothing that says a session was due');
});

test('nothing anywhere counts a missed day or a streak', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  const keys = Object.keys(built).concat(Object.keys(built.months[0]));
  ok(!keys.some((k) => /streak|missed|adherence|rate|target/i.test(k)), keys.join());
});

test('an evening session lands on the evening it happened', () => {
  // 22:30 local. In Toronto the ISO string this produces starts with the next day, so a slice
  // would file a Monday session under Tuesday and the grid would be wrong every evening.
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3, 22.5 | 0))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').sessionIds, ['s1']);
});

test('two sessions on one day are one cell holding both', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3, 9)), csession('s2', at(2026, 8, 3, 18), { day_index: 1 })],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A'), cday(1, 'LOWER A')])],
    sessionIdsWithWork: new Set(['s1', 's2']), today: '2026-08-07',
  });
  const cell = cellFor(built, '2026-08-03');
  eq(cell.sessionIds, ['s1', 's2']);
  eq(cell.label, 'UPPER A', 'the cell takes the first one, the detail line names both');
  eq(built.totalSessions, 2);
});

test('a record is whatever progression.js says it is, and is not decided twice', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3)), csession('s2', at(2026, 8, 5))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1', 's2']),
    recordSessionIds: new Set(['s2']),
    today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').isRecord, false);
  eq(cellFor(built, '2026-08-05').isRecord, true);
  eq(built.months[0].hasRecord, true, 'so the month can say so in words');
});

test('no records handed in means no ring anywhere', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').isRecord, false);
  eq(built.months[0].hasRecord, false);
});

test('a deload week is read from the assignment that prescribed it', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3)), csession('s2', at(2026, 9, 14))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')], { deload_weeks: [6] })],
    sessionIdsWithWork: new Set(['s1', 's2']), today: '2026-09-20',
  });
  eq(cellFor(built, '2026-08-03').isDeload, false, 'week zero is not week six');
  eq(cellFor(built, '2026-09-14').isDeload, true);
});

test('a session pointing at an assignment that is not there is still a session', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3), { assignment_id: 'gone' })],
    assignments: [], sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  const cell = cellFor(built, '2026-08-03');
  eq(cell.sessionIds, ['s1'], 'not dropped for failing to fit the model');
  eq(cell.label, 'Unprogrammed');
  eq(cell.slot, 4, 'the colourless slot');
});

test('a day_index the snapshot does not contain does not blank the cell', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3), { day_index: 9 })],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').label, 'Unprogrammed');
});

test('a client with no history at all still gets this month', () => {
  const built = buildConsistency({ sessions: [], assignments: [], today: '2026-08-07' });
  eq(built.totalSessions, 0);
  eq(built.months.length, 1);
  eq(built.months[0].key, '2026-08');
  eq(built.firstDay, null);
});

test('the grid runs to today even when the last session was months ago', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 5, 12))],
    assignments: [cassign('a1', '2026-05-11', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(built.months.map((m) => m.key), ['2026-05', '2026-06', '2026-07', '2026-08']);
});

test('the grid opens on this month when there is anything in it', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 7, 30)), csession('s2', at(2026, 8, 4))],
    assignments: [cassign('a1', '2026-07-01', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1', 's2']), today: '2026-08-07',
  });
  eq(built.months[built.openAt].key, '2026-08');
});

test('and on the last month that has anything, rather than on a blank one', () => {
  // The third of the month, or a fortnight away, would otherwise land the largest thing on the
  // screen on an empty grid. It scrolls to work that was done, not to space where work was not.
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 7, 30))],
    assignments: [cassign('a1', '2026-07-01', [cday(0, 'UPPER A')])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(built.months[built.openAt].key, '2026-07');
});

test('a client with nothing logged opens on this month rather than nowhere', () => {
  const built = buildConsistency({ sessions: [], assignments: [], today: '2026-08-07' });
  eq(built.months[built.openAt].key, '2026-08');
});

test('every month is whole weeks starting on a Monday', () => {
  const built = buildConsistency({ sessions: [], assignments: [], today: '2026-02-10' });
  const month = built.months[0];
  ok(month.weeks.every((w) => w.days.length === 7), 'no ragged rows');
  eq(new Date(`${month.weeks[0].days[0].day}T00:00:00`).getDay(), 1, 'Monday');
  // February 2026 starts on a Sunday, so the first row is almost all January.
  eq(month.weeks[0].days.filter((d) => d.inMonth).length, 1);
  eq(month.weeks.flatMap((w) => w.days).filter((d) => d.inMonth).length, 28);
});

test('a leap February is 29 days and still whole weeks', () => {
  const built = buildConsistency({ sessions: [], assignments: [], today: '2028-02-10' });
  eq(built.months[0].weeks.flatMap((w) => w.days).filter((d) => d.inMonth).length, 29);
});

test('the legend lists the rotation in its own order, not in the order it was trained', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3), { day_index: 1 }), csession('s2', at(2026, 8, 5))],
    assignments: [cassign('a1', '2026-08-03', [cday(0, 'UPPER A'), cday(1, 'LOWER A')])],
    sessionIdsWithWork: new Set(['s1', 's2']), today: '2026-08-07',
  });
  eq(built.months[0].legend.map((l) => l.label), ['UPPER A', 'LOWER A']);
  eq(built.months[0].sessions, 2);
});

// The glyph is what carries identity once hue runs out, so a collision is not a cosmetic problem.
test('upper and lower A and B do not collapse to U, L, U, L', () => {
  eq(splitGlyphs(['UPPER A', 'LOWER A', 'UPPER B', 'LOWER B']), ['UA', 'LA', 'UB', 'LB']);
});

test('days that already differ on their first letter keep the single letter', () => {
  eq(splitGlyphs(['PUSH', 'LEGS']), ['P', 'L']);
});

test('two days named the same thing still get told apart', () => {
  eq(splitGlyphs(['PUSH', 'PUSH']), ['P1', 'P2'], 'two identical badges is the one thing that must not ship');
});

test('a glyph ignores punctuation and spacing when looking for the difference', () => {
  eq(splitGlyphs(['Push (heavy)', 'Push (light)']), ['PH', 'PL']);
});

test('a day with no name at all still gets a glyph', () => {
  const built = buildConsistency({
    sessions: [csession('s1', at(2026, 8, 3))],
    assignments: [cassign('a1', '2026-08-03', [{ id: 'd0', day_index: 0, name: null, split: null, items: [] }])],
    sessionIdsWithWork: new Set(['s1']), today: '2026-08-07',
  });
  eq(cellFor(built, '2026-08-03').label, 'Day 1');
  eq(cellFor(built, '2026-08-03').glyph, 'D');
});

// ------------------------------------------------------------------ what goes over the wire
//
// These three functions are where the browser and the database's grants meet, and every rule in
// them was put there by a specific line in a migration rather than by taste. A test that pins
// the rule to its reason is what stops the next person deleting it as redundant.

// 0002 withholds auth_user_id from every role that writes, so sending it turns a legitimate
// write into a permission error. This is the note that migration left for step 4.
test('auth_user_id never leaves the browser on a trainer or client write', () => {
  const client = {
    id: 'c1', created_at: 't', updated_at: 't', trainer_id: 'tr1', auth_user_id: 'u1',
    display_name: 'Someone', email: 'a@b.c', status: 'active', weight_unit: 'kg',
  };
  ok(!('auth_user_id' in toWire('clients', client)), 'clients leaked auth_user_id');
  eq(toWire('clients', client).display_name, 'Someone', 'the rest of the row still goes');

  const trainer = {
    id: 'tr1', created_at: 't', updated_at: 't', auth_user_id: 'u1',
    display_name: 'Clay', brand_color: '#ff8a45', logo_url: null, weight_unit: 'kg',
  };
  ok(!('auth_user_id' in toWire('trainers', trainer)), 'trainers leaked auth_user_id');
});

test('a set log goes over the wire whole, since nothing on it is withheld', () => {
  const row = {
    id: 's1', created_at: 't', session_id: 'sess1', exercise_id: 'e1', set_index: 0,
    weight_kg: 100, reps: 5, rounds: null, rpe: null, is_warmup: false,
    logged_at: 't', supersedes_id: null, is_void: false, is_extra: false, device_id: 'd1',
  };
  eq(Object.keys(toWire('set_logs', row)).length, Object.keys(row).length);
  ok(!('updated_at' in toWire('set_logs', row)), 'append only tables have no updated_at');
});

// trainers has a column level select grant, so a pulled row simply has no auth_user_id key.
// Restoring it as null is what lets the row pass the schema validator on the way to disk.
test('a column this role cannot read comes back as null, not as missing', () => {
  const pulled = fromWire('trainers', {
    id: 'tr1', created_at: 't', updated_at: 't', display_name: 'Clay',
    brand_color: '#ff8a45', logo_url: null, weight_unit: 'kg',
  });
  eq(pulled.auth_user_id, null);
  eq(pulled.display_name, 'Clay');
});

// PostgREST is entitled to send a numeric as a string. A weight that arrives as "100.5" and is
// stored unconverted turns every chart on that lift into string concatenation.
test('numerics and ints are coerced rather than trusted', () => {
  const pulled = fromWire('set_logs', {
    id: 's1', created_at: 't', session_id: 'sess1', exercise_id: 'e1', set_index: '2',
    weight_kg: '100.5', reps: '5', rounds: null, rpe: null, is_warmup: false,
    logged_at: 't', supersedes_id: null, is_void: false, is_extra: false, device_id: 'd1',
  });
  eq(pulled.weight_kg, 100.5);
  eq(pulled.reps, 5);
  eq(pulled.set_index, 2);
  eq(pulled.rounds, null, 'a real null stays null rather than becoming zero');
});

// The queue is causally ordered: a session insert sits ahead of the set logs pointing at it.
// Batching may only merge neighbours, because reordering would push a child before its parent.
test('batching preserves order and never merges across a table boundary', () => {
  const entry = (id, table, op = 'put') => ({ id, table, op, record_id: id, payload: { id } });
  const batches = batchQueue([
    entry('1', 'sessions'),
    entry('2', 'set_logs'),
    entry('3', 'set_logs'),
    entry('4', 'sessions'),
    entry('5', 'set_logs'),
  ]);
  eq(batches.map((b) => `${b.table}x${b.entries.length}`), [
    'sessionsx1', 'set_logsx2', 'sessionsx1', 'set_logsx1',
  ]);
});

test('a delete and a put on the same table are never merged into one request', () => {
  const batches = batchQueue([
    { id: '1', table: 'clients', op: 'put', record_id: '1', payload: { id: '1' } },
    { id: '2', table: 'clients', op: 'delete', record_id: '2', payload: null },
  ]);
  eq(batches.length, 2);
  eq(batches.map((b) => b.op), ['put', 'delete']);
});

// Postgres refuses an INSERT ... ON CONFLICT naming the same key twice, and refuses the whole
// statement rather than the duplicate. Editing one row twice is ordinary in the builder, so
// without this a second edit jams every write queued behind it. Measured on a real device: two
// edits of one template day, and nothing synced again for three days.
test('two writes to one row send the newest and never both', () => {
  const entry = (id, record_id, name) => ({ id, table: 'template_days', op: 'put', record_id, payload: { id: record_id, name } });
  const rows = collapseDuplicates([
    entry('q1', 'day-a', 'Day 1'),
    entry('q2', 'day-b', 'Day 2'),
    entry('q3', 'day-a', 'Pull day'),
  ]);
  eq(rows.length, 2);
  eq(rows.map((e) => e.payload.name).includes('Day 1'), false, 'the stale payload is dropped');
  eq(rows.find((e) => e.record_id === 'day-a').payload.name, 'Pull day');
  eq(rows.find((e) => e.record_id === 'day-b').payload.name, 'Day 2');
});

test('rows written once are left exactly as they were queued', () => {
  const entry = (id) => ({ id, table: 'sessions', op: 'put', record_id: id, payload: { id } });
  eq(collapseDuplicates([entry('1'), entry('2'), entry('3')]).map((e) => e.record_id), ['1', '2', '3']);
});

// ------------------------------------------------------------------ getting a set off the phone
//
// storage.push(). The outbox used to be flushed by boot.js and by nothing else, so a set reached
// the server when a page next loaded and at no other moment: log a session, pocket the phone, and
// the trainer sees nothing until the app is opened again. These are about what push() must refuse
// to do as much as what it does, since it runs while somebody is mid set.
//
// A fake driver rather than IndexedDB, because createStorage takes the driver as an argument and
// nothing below reaches past the outbox. The adapter against a real database is dev.html.

function queued(...ids) {
  return ids.map((id) => ({
    id,
    op: 'put',
    table: 'set_logs',
    record_id: id,
    payload: { id },
    created_at: '2026-08-18T00:00:0' + ids.indexOf(id) + '.000Z',
  }));
}

/** Enough of the IndexedDB driver for the outbox to behave like one. */
function memoryDriver(rows = []) {
  let outbox = [...rows];
  return {
    async getAll(store) {
      return store === OUTBOX_STORE ? [...outbox] : [];
    },
    async put(store, row) {
      if (store !== OUTBOX_STORE) return row;
      outbox = [...outbox.filter((r) => r.id !== row.id), row];
      return row;
    },
    async deleteRows(store, ids) {
      if (store !== OUTBOX_STORE) return;
      const gone = new Set(ids);
      outbox = outbox.filter((r) => !gone.has(r.id));
    },
    peek: () => outbox,
  };
}

/** A storage over a fake outbox, plus a remote that records what it was asked to do. */
function harness({ queue = [], push: onPush = null } = {}) {
  let outbox = [...queue];
  const calls = [];
  const storage = createStorage({
    async getAll(store) {
      return store === OUTBOX_STORE ? [...outbox] : [];
    },
    async put(store, row) {
      if (store !== OUTBOX_STORE) return row;
      outbox = [...outbox.filter((r) => r.id !== row.id), row];
      return row;
    },
    async deleteRows(store, ids) {
      if (store !== OUTBOX_STORE) return;
      const gone = new Set(ids);
      outbox = outbox.filter((r) => !gone.has(r.id));
    },
  });
  const remote = {
    async push(entries) {
      calls.push('push');
      if (onPush) return onPush(entries);
      // What the real one does through storage._outboxDone: what landed stops being owed.
      const sent = new Set(entries.map((entry) => entry.id));
      outbox = outbox.filter((entry) => !sent.has(entry.id));
      return { pushed: entries.length, blocked: null };
    },
    async pull() {
      calls.push('pull');
      return 0;
    },
  };
  return { storage, remote, calls, rest: () => outbox };
}

test('a push sends what is queued and empties it', async () => {
  const { storage, remote, rest } = harness({ queue: queued('a', 'b') });
  storage.setRemote(remote);
  const result = await storage.push();
  eq(result.pushed, 2);
  eq(result.pending, 0);
  eq(result.error, null);
  eq(rest().length, 0);
});

test('a push never pulls', async () => {
  // The whole reason this is a second entry point. A pull rewrites local rows from the server and
  // removes ones it no longer has, underneath a screen holding the program, the day and the
  // session in memory.
  const { storage, remote, calls } = harness({ queue: queued('a') });
  storage.setRemote(remote);
  await storage.push();
  eq(calls, ['push']);
  await storage.sync();
  eq(calls, ['push', 'push', 'pull'], 'sync is still both directions');
});

test('a push with nothing owed does not touch the network', async () => {
  // This runs on every set logged and every time the tab is hidden. The common case is an empty
  // queue and the common case must be free.
  const { storage, remote, calls } = harness();
  storage.setRemote(remote);
  const result = await storage.push();
  eq(calls, []);
  eq(result.pushed, 0);
  eq(result.pending, 0);
});

test('a push with no remote reports the depth and keeps the queue', async () => {
  const { storage, rest } = harness({ queue: queued('a', 'b') });
  const result = await storage.push();
  eq(result.remote, false);
  eq(result.pending, 2);
  eq(rest().length, 2, 'nothing is dropped for want of somewhere to send it');
});

test('a push never throws, because a gym floor is an ordinary place to be offline', async () => {
  const { storage, remote } = harness({
    queue: queued('a'),
    push: () => { throw new Error('Failed to fetch'); },
  });
  storage.setRemote(remote);
  const result = await storage.push();
  eq(result.error, 'Failed to fetch');
  eq(result.pending, 1, 'and the set is still owed');
});

test('a refused row is reported rather than swallowed', async () => {
  const { storage, remote } = harness({
    queue: queued('a'),
    push: () => ({ pushed: 0, blocked: { table: 'clients', message: 'row-level security' } }),
  });
  storage.setRemote(remote);
  eq((await storage.push()).error, 'clients: row-level security');
});

test('two flushes at once do not hand the server the same rows twice', async () => {
  // They queue rather than coalesce. A set logged while a flush is in the air is not in the queue
  // that flush read, so returning the in flight promise would call it sent while it is still here.
  let inFlight = 0;
  let overlapped = false;
  const { storage, remote, calls } = harness({
    queue: queued('a'),
    push: async (entries) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight -= 1;
      return { pushed: entries.length, blocked: null };
    },
  });
  storage.setRemote(remote);
  await Promise.all([storage.push(), storage.push(), storage.sync()]);
  eq(overlapped, false);
  eq(calls.filter((c) => c === 'push').length, 3, 'each one still ran, one after another');
});

// A row the server will never take. Modelled on the one that happened: a set_logs insert carrying
// reps of zero, which fails set_logs_reps_check, at the head of 82 changes including a whole
// session. Push stops at the first failure to keep the queue causally ordered, so that one row
// held everything behind it for two days and the logging screen said nothing.

/**
 * The real js/remote.js over a fake PostgREST, because the isolate path is the part that matters
 * and a fake remote.push would be testing the fake.
 */
function realRemote({ queue = [], refuse = () => null } = {}) {
  const driver = memoryDriver(queue);
  const storage = createStorage(driver);
  const requests = [];
  const client = {
    from(table) {
      return {
        async upsert(rows) {
          requests.push(rows.map((row) => row.id));
          return { error: refuse(rows, table) };
        },
        delete: () => ({ async in() { return { error: null }; } }),
        update: () => ({ eq: () => ({ async select() { return { data: [{}], error: null }; } }) }),
      };
    },
  };
  storage.setRemote(createRemote({ client, storage }));
  return { storage, requests, rest: () => driver.peek() };
}

const repsCheck = {
  code: '23514',
  message: 'new row for relation "set_logs" violates check constraint "set_logs_reps_check"',
};

test('parking one row does not throw away the twenty beside it', async () => {
  // Batches are every consecutive write to one table, and one session was 21 sets in a single
  // insert. PostgREST rejects the whole request, so a batch failing says nothing about which row
  // in it was wrong, and the batch has to be taken apart to find out.
  const { storage, requests } = realRemote({
    queue: queued('good-1', 'bad', 'good-2'),
    refuse: (rows) => (rows.some((row) => row.id === 'bad') ? repsCheck : null),
  });
  const result = await storage.push();
  eq(result.parked.map((entry) => entry.record_id), ['bad']);
  eq(result.pushed, 2, 'the two good rows still went');
  eq(requests[0].length, 3, 'asked for the batch first');
  ok(requests.length > 1, 'then took it apart when the batch came back refused');
});

test('taking a batch apart stops if the network goes mid way', async () => {
  // Halfway through isolating, a blip is not a verdict on the rows that have not been tried. They
  // stay owed rather than being parked alongside the one that is genuinely bad.
  let seen = 0;
  const { storage } = realRemote({
    queue: queued('bad', 'b', 'c'),
    refuse: (rows) => {
      if (rows.length > 1) return repsCheck;
      seen += 1;
      if (rows[0].id === 'bad') return repsCheck;
      return { message: 'Failed to fetch' };
    },
  });
  const result = await storage.push();
  eq(result.parked.map((entry) => entry.record_id), ['bad']);
  ok(result.error.includes('Failed to fetch'));
  eq(result.pending, 2, 'b and c are still owed, not written off');
});

test('a row the server will never take stops being owed', async () => {
  const { storage, rest } = realRemote({ queue: queued('a'), refuse: () => repsCheck });
  const result = await storage.push();
  eq(result.pending, 0, 'the queue is no longer stuck behind it');
  eq(result.parked.length, 1);
  eq(rest().length, 1, 'and it is kept, because a set nobody accepted is still a set somebody did');
});

test('a network failure is not a refusal and still stops the queue', async () => {
  // The distinction the whole thing turns on. A blip deserves another go; a check violation never
  // will. Parking on a blip would set aside writes that were perfectly good.
  const { storage, rest } = realRemote({
    queue: queued('a', 'b'),
    refuse: () => ({ message: 'Failed to fetch' }),
  });
  const result = await storage.push();
  eq(result.parked.length, 0);
  eq(result.pending, 2, 'both are still owed');
  eq(rest().length, 2);
});

test('a foreign key failure is ordering, not a bad row', async () => {
  // The parent is further up the same queue. Parking the child would strand a set whose session
  // simply had not landed yet.
  const { storage } = realRemote({
    queue: queued('a'),
    refuse: () => ({ code: '23503', message: 'violates foreign key constraint' }),
  });
  const result = await storage.push();
  eq(result.parked.length, 0);
  eq(result.pending, 1);
});

test('a parked row keeps saying so long after the sync that parked it', async () => {
  // The quieter of the queue's two bad endings: everything else went, the depth is zero, and by
  // every measure the shell had, the sync worked.
  const { storage } = realRemote({ queue: queued('a'), refuse: () => repsCheck });
  await storage.push();

  const later = await storage.push();
  eq(later.pushed, 0);
  eq(later.pending, 0);
  eq(later.parked.length, 1, 'read off the disk, not off what this push happened to do');
  ok(syncMessage(later).includes('set_logs_reps_check'), 'and it names the reason');
  ok(syncMessage(later).includes('kept on this device'));
});

// ------------------------------------------------------------------ what the database will take
//
// js/schema.js says the same thing the check constraints say. The two disagreed, and the
// disagreement ran the expensive way: the local write succeeded, the row sat on disk showing in
// the client's own history, and the server refused it forever. One such row parked 82 changes on
// a phone for two days with nothing on screen saying so.

const setRow = (over = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  created_at: '2026-08-18T00:00:00.000Z',
  session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  exercise_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  set_index: 0,
  weight_kg: 60,
  reps: 8,
  rounds: null,
  hold_seconds: null,
  rpe: null,
  is_warmup: false,
  logged_at: '2026-08-18T00:00:00.000Z',
  supersedes_id: null,
  is_void: false,
  is_extra: false,
  device_id: 'device',
  ...over,
});

const refuses = (record, wanted) => {
  try {
    validate('set_logs', record);
  } catch (error) {
    ok(error.message.includes(wanted), `expected a message about ${wanted}, got ${error.message}`);
    return;
  }
  throw new Error(`accepted a row the server would refuse: ${wanted}`);
};

test('a set of zero reps is refused where it is written, not where it is sent', () => {
  refuses(setRow({ reps: 0 }), 'reps');
  refuses(setRow({ reps: -1 }), 'reps');
});

test('a hold with no rep count is still fine, because that is what null is for', () => {
  eq(validate('set_logs', setRow({ reps: null })).reps, null);
  eq(validate('set_logs', setRow({ reps: 12 })).reps, 12);
});

test('the rest of the set_logs constraints are said here too', () => {
  refuses(setRow({ rounds: 0 }), 'rounds');
  refuses(setRow({ hold_seconds: 0 }), 'hold_seconds');
  refuses(setRow({ weight_kg: -0.5 }), 'weight_kg');
  refuses(setRow({ set_index: -1 }), 'set_index');
});

test('a bodyweight set at zero load is not the same as a set of zero reps', () => {
  // weight_kg is >= 0 and reps is > 0, exactly as the database has it. A pushup weighs nothing
  // and is still a set.
  eq(validate('set_logs', setRow({ weight_kg: 0 })).weight_kg, 0);
  eq(validate('set_logs', setRow({ set_index: 0 })).set_index, 0);
});

test('a program cannot ask for zero sets or zero reps either', () => {
  const item = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    day_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    exercise_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    order_index: 0,
    group_label: '1A',
    variation: null,
    target_sets: 3,
    target_reps_low: 8,
    target_reps_high: null,
    target_reps_text: null,
    target_rpe: null,
    target_load: null,
    rest_seconds: 90,
    starting_weight_kg: null,
    notes: '',
    is_logged: true,
    log_mode: 'weight_reps',
  };
  eq(validate('template_items', item).target_sets, 3, 'a good row still goes through');
  let refused = 0;
  for (const bad of [{ target_sets: 0 }, { target_reps_low: 0 }, { rest_seconds: -1 }, { starting_weight_kg: 0 }]) {
    try {
      validate('template_items', { ...item, ...bad });
    } catch {
      refused += 1;
    }
  }
  eq(refused, 4);
});

// ------------------------------------------------------------------ the hold that became a zero
//
// The whole chain, from a real workout. A2 LOWER opens 1A back extension, 45 second hold, and 1B
// back extension for 12 to 15: one exercise, two rows, which is how every superset in these
// programs is written. A hold is weight_only and writes no reps at all.
//
// Three holds logged over eight minutes, the phone locks somewhere in there, and on resume the
// replay recorded each hold as a set of ZERO reps, because this file had a second countOf whose
// last resort was 0 where the shared one says 1. nextSteppers then read that zero as a number the
// client had chosen this session, and carried it into the next lift, because it decided "same
// lift" by exercise id and 1A and 1B are the same exercise. Three sets went to disk at reps 0,
// set_logs_reps_check refuses those forever, push stops at the first refusal, and 82 changes sat
// on a phone for two days.

const holdOpening = { kg: 2.5, source: 'lightest' };

const holdItem = {
  exercise_id: 'back-ext',
  exercise: { id: 'back-ext', name: 'Back Extension', equipment: 'machine', increment_kg: 2.5 },
  log_mode: 'weight_only',
  target_sets: 3,
  target_reps_low: null,
  target_reps_text: '45 sec hold',
  group_label: '1A',
};

const repsItem = { ...holdItem, log_mode: 'weight_reps', target_reps_low: 12, target_reps_high: 15, group_label: '1B' };

const holdRows = [0, 1, 2].map((i) => ({
  id: 'hold-' + i,
  exercise_id: 'back-ext',
  set_index: i,
  weight_kg: 2.5,
  reps: null,
  rounds: null,
  hold_seconds: null,
  is_warmup: false,
  is_void: false,
  is_extra: false,
  supersedes_id: null,
  logged_at: ['2026-08-17T19:02:13.465Z', '2026-08-17T19:06:27.908Z', '2026-08-17T19:10:48.933Z'][i],
}));

test('a hold has no rep count, and replaying one does not invent a zero', () => {
  // One countOf, in js/plan.js. A second copy with a different last resort is what this was.
  const plan = [...planForItem(holdItem, null, holdOpening), ...planForItem(repsItem, null, holdOpening)];
  const replayed = replaySession(plan, holdRows, new Map());
  eq(replayed.logged.map((entry) => entry.reps), [1, 1, 1], 'not [0, 0, 0]');
});

test('the numbers on a hold do not carry into the reps out of it', () => {
  // Same exercise, two items, which is what a superset is. The carry stops at the lift and the
  // lift is the item.
  const plan = [...planForItem(holdItem, null, holdOpening), ...planForItem(repsItem, null, holdOpening)];
  const lastHold = plan[2];
  const firstReps = plan[3];
  const carried = nextSteppers({ weightKg: 2.5, reps: 1 }, lastHold, firstReps);
  eq(carried.reps, 12, 'the reps the trainer asked for, not whatever the hold was showing');
});

test('a locked phone mid superset comes back on the prescription', () => {
  // The exact sequence, end to end: three holds on disk, resume, and read what the steppers say.
  const plan = [...planForItem(holdItem, null, holdOpening), ...planForItem(repsItem, null, holdOpening)];
  const replayed = replaySession(plan, holdRows, new Map());
  const resumingOn = replayed.plan[replayed.cursor];
  const last = replayed.logged[replayed.logged.length - 1];
  const steppers = nextSteppers(last, last.entry, resumingOn);

  eq(resumingOn.item.group_label, '1B', 'the holds are done, the reps are next');
  eq(steppers.reps, 12, 'and this was 0, which the server refuses and always will');
  ok(steppers.reps > 0, 'anything that fails set_logs_reps_check must not reach a set row');
});

test('a real adjustment still carries within one lift', () => {
  // The rule this must not break: a number the client moved beats a number from last session, or
  // a correction lasts exactly one tap.
  const plan = planForItem(repsItem, null, holdOpening);
  const carried = nextSteppers({ weightKg: 40, reps: 8 }, plan[0], plan[1]);
  eq(carried.reps, 8, 'they chose 8, they keep 8');
  eq(carried.weightKg, 40);
});

// ------------------------------------------------------------------ the increment, live or frozen
//
// The live exercises row is the right answer, because an increment describes the equipment in the
// room rather than the program. The bug was having no other answer: exercises_select hands a
// client the global rows and their own trainer's rows and nothing else, so a program built out of
// a second trainer's exercises is a program whose entire library that person cannot read. Every
// stepper then fell back to 2.5 kg, which is not what anybody set and is silent about it.

const liftWith = (incrementKg) => ({
  exercise_id: 'leg-press',
  exercise: { id: 'leg-press', name: 'Leg Press', increment_kg: incrementKg },
});

test('the live increment wins, because a gym that swaps a stack should reach an old program', () => {
  eq(incrementOf(liftWith(2.5), 5), 5);
});

test('a lift whose exercise row cannot be read falls back to the frozen one', () => {
  // The whole case: undefined is what a Map lookup returns for a row RLS never handed over.
  eq(incrementOf(liftWith(5), undefined), 5, 'and not the 2.5 kg default nobody chose');
  eq(incrementOf(liftWith(20), undefined), 20);
});

test('a lift with neither says so rather than inventing a number', () => {
  // Null, so stepSize applies its own documented default instead of this deciding one quietly.
  eq(incrementOf({ exercise: {} }, undefined), null);
  eq(incrementOf(undefined, undefined), null);
});

// ------------------------------------------------------------------ what a pull may not touch
//
// A mirror refresh overwrote every local row with the server's copy, including rows whose newer
// version was sitting in the outbox. The guard that existed only stopped those rows being deleted.
//
// What it looked like on a phone: a session moved onto the right day, finished, and answered for,
// with all three writes stuck behind a blocked queue. Every boot pulled the stale row back over
// the top, so for two days the app showed the wrong day and an open session while holding the
// corrected version the whole time.

function pullHarness({ queue = [], parked: parkedRow = null, server = {} } = {}) {
  const driver = memoryDriver(queue);
  const storage = createStorage(driver);
  const local = new Map();
  // Only sessions matter here, and reaching past the adapter keeps this about pull() rather than
  // about how many tables the schema happens to have.
  storage._bulkPut = async (table, rows) => {
    for (const row of rows) local.set(row.id, row);
  };
  storage.query = async () => [...local.values()];
  storage._mirrorDelete = async (table, ids) => {
    for (const id of ids) local.delete(id);
  };
  storage.parked = async () => (parkedRow ? [parkedRow] : []);

  const client = {
    from: () => ({
      select: () => ({
        order: () => ({
          range: async () => ({ data: server.rows ?? [], error: null }),
        }),
      }),
    }),
  };
  return { storage, client, local, createRemote };
}

test('a pull does not write over a row whose newer version is still queued', async () => {
  const { storage, client, local } = pullHarness({
    queue: [{ id: 'o1', op: 'put', table: 'sessions', record_id: 's1', payload: { id: 's1', day_index: 4 }, created_at: '2026-08-18T00:00:00.000Z' }],
  });
  local.set('s1', { id: 's1', day_index: 4, completed_at: '2026-08-17T20:25:29.000Z' });

  const remote = createRemote({ client, storage });
  // The server still has the version from before the day was corrected.
  client.from = () => ({ select: () => ({ order: () => ({ range: async () => ({ data: [{ id: 's1', day_index: 1, completed_at: null }], error: null }) }) }) });
  await remote.pull();

  eq(local.get('s1').day_index, 4, 'the local copy is the newer one and stays');
  eq(local.get('s1').completed_at, '2026-08-17T20:25:29.000Z');
});

test('a parked row is not swept away for no longer being owed', async () => {
  // Parking stops a row being owed, and the sweep deletes anything local the server does not have
  // and nothing is holding. Dropping parked rows out of that set would delete the only copy of a
  // set somebody performed while carefully keeping the payload that describes it.
  const parked = { id: 'o2', op: 'put', table: 'set_logs', record_id: 'r9', payload: { id: 'r9' }, parked_at: '2026-08-18T00:00:00.000Z' };
  const { storage, client, local } = pullHarness({ parked });
  local.set('r9', { id: 'r9', reps: 0 });

  const remote = createRemote({ client, storage });
  await remote.pull();

  ok(local.has('r9'), 'the set the server refused is still on the device');
});

// ------------------------------------------------------------------ reading a parked write
//
// A parked row is kept with its whole payload and nothing showed more than the error string, so
// working out what had written a zero meant reasoning backwards from what was missing on the
// server. The answer was on the phone the entire time.

function footerAfterSync({ isStaff, parked }) {
  const footer = document.createElement('footer');
  footer.className = 'account';
  footer.innerHTML = '<button data-signout hidden></button>';
  document.body.appendChild(footer);
  mountShell({ actor: { clientId: 'c1', trainerId: null, isStaff }, storage: null, client: null, session: null }, 'log');
  publishSync({ remote: true, pushed: 76, pulled: 0, pending: 0, parked, error: null });
  const out = { details: footer.querySelector('details'), text: footer.textContent };
  footer.remove();
  return out;
}

const parkedSet = [{
  id: 'o1',
  op: 'put',
  table: 'set_logs',
  record_id: 'row-1',
  last_error: 'violates check constraint "set_logs_reps_check"',
  payload: { id: 'row-1', set_index: 4, weight_kg: 0, reps: 0, is_warmup: false },
}];

test('staff can read what the parked write actually was', () => {
  const { details, text } = footerAfterSync({ isStaff: true, parked: parkedSet });
  ok(details, 'it opens');
  ok(text.includes('set_logs_reps_check'), 'the reason');
  ok(text.includes('reps 0'), 'and the column that caused it, which is the whole point');
  ok(text.includes('row-1'), 'named, so it can be found again');
});

test('a client gets the sentence and not the column list', () => {
  // Not secrecy, audience. A client already has the part that concerns them, which is that
  // something did not save. A column list is for whoever goes and finds the bug.
  const { details, text } = footerAfterSync({ isStaff: false, parked: parkedSet });
  eq(details, null);
  ok(text.includes('kept on this device'), 'they are still told');
  ok(!text.includes('reps 0'));
});

test('nothing parked leaves the footer as it was', () => {
  const { details, text } = footerAfterSync({ isStaff: true, parked: [] });
  eq(details, null);
  eq(text.trim(), '', 'a sync with nothing to say says nothing');
});

// ------------------------------------------------------------------ two labels, one spot
//
// Reps at each load draws a weight beside the last point of every load. Ascending sets routinely
// finish two loads on the same day at the same top set, which put both labels on identical
// coordinates, and two labels overprinted is not a near miss: it is a word neither of them says.

test('two loads ending on the same day at the same reps do not print on top of each other', () => {
  const container = document.createElement('div');
  const sameDay = [{ date: '2026-08-16T12:00:00.000Z', reps: 6 }];
  renderRepsAtLoadChart(container, {
    repsAtLoad: {
      hiddenCount: 0,
      lines: [
        { loadKg: 45.359, points: sameDay },
        { loadKg: 63.503, points: sameDay },
      ],
    },
  });

  const labels = [...container.querySelectorAll('.chart__loadlabel')];
  eq(labels.length, 2, 'both loads are still named');
  const ys = labels.map((node) => Number(node.getAttribute('y')));
  ok(ys.every(Number.isFinite), `label positions are numbers, got ${ys}`);
  ok(Math.abs(ys[0] - ys[1]) >= 12, `labels are apart, got ${ys}`);
});

test('a clean sync says nothing at all', () => {
  eq(syncMessage({ pushed: 3, pending: 0, parked: [], error: null }), null);
  eq(syncMessage(null), null);
});

test('a flush that fails does not poison the ones after it', async () => {
  let first = true;
  const { storage, remote } = harness({
    queue: queued('a'),
    push: () => {
      if (first) { first = false; throw new Error('Failed to fetch'); }
      return { pushed: 1, blocked: null };
    },
  });
  storage.setRemote(remote);
  eq((await storage.push()).error, 'Failed to fetch');
  eq((await storage.push()).error, null, 'the chain survived, so coming back online works');
});

// ------------------------------------------------------------------ who may be where
//
// Capability, not role. A person who coaches and is also coached holds a trainers row and a
// clients row on one auth user, and comparing a single role string would pick one and lock them
// out of the other half of the app.

test('a plain client can reach client screens and no trainer screen', () => {
  const client = { role: 'client', clientId: 'c1', trainerId: null, isStaff: false };
  ok(can(client, 'client'), 'a client cannot reach their own logging screen');
  ok(!can(client, 'trainer'), 'a client was given the coaching side');
});

test('a plain trainer can reach trainer screens and no client screen', () => {
  const trainer = { role: 'trainer', clientId: null, trainerId: 't1', isStaff: false };
  ok(can(trainer, 'trainer'));
  ok(!can(trainer, 'client'), 'a trainer with no client row was given a logging screen');
});

test('somebody who is both reaches both', () => {
  const both = { role: 'both', clientId: 'c1', trainerId: 't1', isStaff: true };
  ok(can(both, 'client'));
  ok(can(both, 'trainer'));
});

// ------------------------------------------------------------------ offline is not signed out
//
// staysSignedIn. getSupabase() answers null when the CDN cannot be fetched, and reading a session
// needs the library, so offline there is no session to find and that looks exactly like signing
// out. The difference has to come off the disk.
//
// What rides on it: the branch below this one aligns the database to 'local', and alignIdentity
// wipes on a change of person. Getting this wrong shows a real client somebody else's seeded
// history and deletes the sets they logged in a basement, which by definition never reached the
// server. It was unreachable until the app could open with no network.

const onDisk = { identity: 'auth:user-1', actor: { role: 'client', clientId: 'c1' } };

test('a signed in device with no library is still signed in', () => {
  ok(staysSignedIn({ client: null, ...onDisk }));
});

test('a library that loaded answers for itself', () => {
  // A real client with a real session gone is a real sign out, and this must not paper over it.
  ok(!staysSignedIn({ client: {}, ...onDisk }), 'the session it read is the answer, not the disk');
});

test('a device that has only ever held seeded data is not signed in', () => {
  ok(!staysSignedIn({ client: null, identity: 'local', actor: onDisk.actor }));
});

test('a device nobody has signed in on is not signed in', () => {
  ok(!staysSignedIn({ client: null, identity: null, actor: null }));
  ok(!staysSignedIn({ client: null, identity: undefined, actor: onDisk.actor }));
});

test('an identity with nobody attached to it is not enough', () => {
  // Signed in once, and whoami never landed. There is no actor to hand a screen, so this falls
  // through to the sign in screen rather than opening on a null.
  ok(!staysSignedIn({ client: null, identity: 'auth:user-1', actor: null }));
});

// The regression this replaced. The dev switch used to hand a client their coach's trainer id,
// which under a capability check would show every client the coaching navigation.
test('a coach id belonging to somebody else is not a capability', () => {
  const client = { role: 'client', clientId: 'c1', trainerId: null, isStaff: false };
  ok(!can(client, 'trainer'), 'trainerId must mean the trainer you are, not the one you train under');
  ok(!can(null, 'client'), 'no actor is no capability');
  ok(!can(undefined, 'trainer'));
});

// ------------------------------------------------------------------ whole reps only
//
// Half reps were built and removed after real use. This is the guard that keeps them out: the
// schema is the only thing standing between a stray fractional rep and a chart drawn from it.

test('a fractional rep is rejected by the schema', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-08-05T00:00:00.000Z',
    session_id: '00000000-0000-4000-8000-000000000002',
    exercise_id: '00000000-0000-4000-8000-000000000003',
    set_index: 3, weight_kg: 0, reps: 10, rounds: null, hold_seconds: null, rpe: null,
    is_warmup: false, logged_at: '2026-08-05T00:00:00.000Z',
    supersedes_id: null, is_void: false, is_extra: false, device_id: 'test',
  };
  eq(validate('set_logs', base).reps, 10, 'a whole rep still stores');

  let rejected = false;
  try {
    validate('set_logs', { ...base, reps: 10.5 });
  } catch {
    rejected = true;
  }
  ok(rejected, 'a half rep reached storage');
});

// A hold is still fractional, and deliberately so. A hold that broke at 12.5 seconds is one
// observation rather than a half of anything, and nothing about it costs a tap.
test('a hold may still be fractional even though reps may not', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [row({ session_id: 's1', weight_kg: 0, reps: null, hold_seconds: 12.5 })];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].topHold, 12.5);
});

// ------------------------------------------------------------------ no external load
//
// Five of the twelve exercises in one real three day program carry no weight: pushups, pullups
// and pike pushups are reps only, an L sit and a hollow body are seconds only. Charting them as
// weighted lifts would draw a flat line at zero while somebody got visibly stronger.

test('a bodyweight lift produces no estimated 1RM rather than an estimated 1RM of zero', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 0, reps: 12 }),
    row({ session_id: 's2', weight_kg: 0, reps: 15 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.kind, 'bodyweight');
  eq(p.e1rm.series, [], 'a zero load must not reach the strength series');
  for (const point of p.points) eq(point.e1rm, null);
});

test('a bodyweight lift leads with the rep count, which is the thing that moved', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 0, reps: 12 }),
    row({ session_id: 's2', weight_kg: 0, reps: 15 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.leadView, 'reps');
  eq(p.reps.series.length, 2);
  eq(p.reps.change.first, 12);
  eq(p.reps.change.last, 15);
  ok(p.points[1].isRecord, 'beating your own rep count is a record');
});

test('the top set carries the rep series, not the last set or an average', () => {
  const sessions = [sess('s1', '2026-07-01')];
  const logs = [
    row({ session_id: 's1', set_index: 0, weight_kg: 0, reps: 14 }),
    row({ session_id: 's1', set_index: 1, weight_kg: 0, reps: 12 }),
    row({ session_id: 's1', set_index: 2, weight_kg: 0, reps: 10 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.points[0].topReps, 14);
});

test('a hold is measured in seconds and never becomes reps or volume', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 0, reps: null, hold_seconds: 20 }),
    row({ session_id: 's2', weight_kg: 0, reps: null, hold_seconds: 35 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.kind, 'hold');
  eq(p.leadView, 'hold');
  eq(p.hold.change.last, 35);
  eq(p.e1rm.series, [], 'a hold has no estimated 1RM');
  for (const point of p.points) {
    eq(point.prescribed, 0, 'seconds must not multiply into volume');
    eq(point.topReps, null, 'a hold has no rep count');
  }
});

// The reason kind is read off the rows and not off template_items.log_mode. A trainer moving a
// lift from weighted to bodyweight must not retroactively unload last month's sets.
test('a weighted lift stays weighted even once a bodyweight session appears', () => {
  const sessions = [sess('s1', '2026-07-01'), sess('s2', '2026-07-08')];
  const logs = [
    row({ session_id: 's1', weight_kg: 60, reps: 8 }),
    row({ session_id: 's2', weight_kg: 0, reps: 15 }),
  ];
  const p = buildProgression({ setLogs: logs, sessions, assignments: [assign('a1', '2026-07-01')], exerciseId: 'squat' });
  eq(p.kind, 'load', 'one unloaded session does not rewrite the history of a loaded lift');
  eq(p.e1rm.series.length, 1, 'only the loaded session has a strength number');
  eq(p.e1rm.series[0].sessionId, 's1');
});

// A weighted lift performed with nothing on it, which is the reading half of the same problem.
// A GHD crunch, a dip and a pullup are all done cold and then done holding a plate, and the first
// real client to hit this logged one set at nothing and two at fifteen pounds inside one session.
// The mode has to stay weight_reps or those last two sets have no stepper to record them on, so
// zero is a value the screen has to be able to say.
test('a set with nothing on it is named, not printed as a weight of zero', () => {
  eq(loadLabel(0), 'bodyweight');
  eq(loadValue(0), 'BW', 'the stepper has no room for a sentence');
});

// Pounds is the default now, everywhere, because nobody using this reads kilograms. Asserted so a
// change of default is a failing test rather than a surprise in a gym.
test('weights read in pounds until somebody says otherwise', () => {
  eq(unit(), 'lb');
});

test('a load that exists still prints as a load', () => {
  eq(loadLabel(15 * 0.45359237), '15 lb');
  eq(loadValue(15 * 0.45359237), '15', 'the stepper carries its unit in the label beneath it');
});

// Synchronous on purpose, and not because awaiting would be untidy. setUnit changes the state and
// notifies its listeners before its first await, and only the persistence after that is async, so
// the flip lands immediately. Awaiting it here would put the restore in a later microtask and let
// every synchronous test after this one read kilograms, which is exactly the failure this comment
// exists to stop somebody reintroducing. There is no storage bound in tests, so nothing is written.
test('the same load in the other unit is the same load', () => {
  setUnit('kg');
  eq(loadLabel(6.8), '6.8 kg');
  eq(loadValue(6.8), '6.8');
  eq(loadLabel(0), 'bodyweight', 'nothing on the bar is still nothing on the bar');
  setUnit('lb');
  eq(unit(), 'lb', 'and put back, so nothing after this reads a unit it did not set');
});

// The line under Log set opens a sentence, so callers upper case the first character. That must
// reach the word and never touch a number, which has no case to change.
test('opening a line with a load leaves a number exactly as it was', () => {
  const opens = (kg) => {
    const load = loadLabel(kg);
    return load.charAt(0).toUpperCase() + load.slice(1);
  };
  eq(opens(0), 'Bodyweight');
  eq(opens(60), '132 lb', 'a number has no case to change, in either unit');
});

// ------------------------------------------------------------------ eight real workbooks
//
// Measured against 306 exercise rows across 56 day blocks in eight real client workbooks, not
// invented. Each count below is how many rows the rule covers, and each one was a row the
// parser previously got wrong or dropped.

// 29 rows. RPE written directly was ignored entirely, so every one of them silently lost its
// effort target. It appears in both orders, as ranges, and buried inside a longer cell.
test('RPE is read in whichever order and shape the trainer wrote it', () => {
  eq(parseLoad('RPE 9').rpe, 9);
  eq(parseLoad('8 RPE').rpe, 8);
  eq(parseLoad('RPE 8').rpe, 8);
  eq(parseLoad('RPE 8 - 9').rpe, 9, 'a range takes the harder end');
  eq(parseLoad('8-9 RPE').rpe, 9);
  eq(parseLoad('RPE 7-8').rpe, 8);
  eq(parseLoad('5 MINS RPE 3-4').rpe, 4, 'buried inside a longer cell');
  eq(parseLoad('RPE 7-8 - 10 MINS').rpe, 8);
});

// RIR and RPE point opposite ways numerically and the same way in meaning: both take the
// harder end. Fewer reps in reserve is harder, a higher RPE is harder.
test('RIR and RPE both resolve to the harder end of a range', () => {
  eq(parseLoad('1-2 RIR').rpe, 9);
  eq(parseLoad('3 - 5 RIR').rpe, 7);
  eq(parseLoad('1- 2 RIR').rpe, 9, 'spacing varies between workbooks');
  eq(parseLoad('RPE 8 - 9').rpe, 9);
});

// Everything genuinely without an effort target still gets null rather than a guess. 55 rows.
test('a load that is not an effort still gets no RPE', () => {
  for (const cell of ['1 MIN EMOM', 'BW', 'MODERATE', '25 - 45 LBS', '2 PLATES',
                      '5-7 SPEED', 'ASSISTED BW', '90 CALS', '450 METERS', '35 MINUTES']) {
    eq(parseLoad(cell).rpe, null, `${cell} was given an RPE it does not have`);
    eq(parseLoad(cell).text, cell, 'the trainer text survives verbatim');
  }
});

// 16 rows. The Rest column sometimes holds a rep count, and reading it as seconds put a wrong
// rest on the client's screen. A wrong number is worse than a missing one.
test('a rep count sitting in the Rest column is not read as a duration', () => {
  eq(parseRest('5 PER SIDE'), null);
  eq(parseRest('3 PER SIDE'), null);
  eq(parseRest('5 PER  SIDE'), null, 'double spacing appears in the real files');
  eq(parseRest('60 SEC'), 60, 'a real rest still parses');
  eq(parseRest('90 SEC'), 90);
});

// 6 rows. Seconds in the Reps column is a hold. Minutes are deliberately excluded, because a
// Reps cell reading '10 MINS' is a cardio block rather than something anybody holds.
test('seconds in the reps column is a hold, minutes are not', () => {
  eq(inferLogging({ repsText: '30 SEC', loadText: '1 RIR', sets: 3 }),
     { isLogged: true, logMode: 'time_hold', certain: true });
  eq(inferLogging({ repsText: '45 SEC', loadText: 'BW', sets: 3 }),
     { isLogged: true, logMode: 'time_hold', certain: true });
  // Ten minutes on a stair master is still not a hold. It is now not logged either, because
  // '5-7 SPEED' is a pace and prescribes no load to enter.
  eq(inferLogging({ repsText: '10 MINS', loadText: '5-7 SPEED', sets: null }),
     { isLogged: false, logMode: 'weight_reps', certain: true }, 'a ten minute block is not a hold');
});

// 9 rows. A Load cell naming the body is a bodyweight lift, which now has its own mode rather
// than being a weighted lift that happens to weigh nothing.
test('a load naming the body makes it a bodyweight lift', () => {
  ok(isBodyweightLoad('BW'));
  ok(isBodyweightLoad('BODY WEIGHT'));
  ok(isBodyweightLoad('ASSISTED BW'));
  ok(!isBodyweightLoad('25 - 45 LBS'));
  ok(!isBodyweightLoad('1 RIR'));

  eq(inferLogging({ repsText: '12', loadText: 'BODY WEIGHT', sets: 3 }),
     { isLogged: true, logMode: 'bodyweight_reps', certain: true });
  eq(inferLogging({ repsText: '12', loadText: '1 RIR', sets: 3 }),
     { isLogged: true, logMode: 'weight_reps', certain: true });
});

// 'BW' in the Load column beside 'DUMBELL' in the Adjust column is a weighted jump squat. Reading
// the Load cell on its own there hides the dumbbell and asks somebody to jump empty handed.
test('the adjust column outranks a bodyweight load when it names an implement', () => {
  eq(inferLogging({ repsText: '5', loadText: 'BW', adjustText: 'DUMBELL', sets: 5 }),
     { isLogged: true, logMode: 'weight_reps', certain: true });
  eq(inferLogging({ repsText: '10', loadText: 'ASSISTED BW', adjustText: 'BAND', sets: 5 }),
     { isLogged: true, logMode: 'bodyweight_reps', certain: true }, 'a band is not an implement');
  eq(inferLogging({ repsText: '10', loadText: 'BW', adjustText: 'BOX', sets: 5 }),
     { isLogged: true, logMode: 'bodyweight_reps', certain: true }, 'nor is a box');
});

// AMRAP in the Reps column is one exercise taken to failure, so it is a rep count the client
// discovers. It is not the rounds mode, which is a circuit.
test('AMRAP is a rep count to discover, not a circuit', () => {
  // Never certain, whichever way it lands: AMRAP names the reps and says nothing about what is
  // in the hands, so this is the one inference that always wants a second opinion.
  eq(inferLogging({ repsText: 'AMRAP', loadText: 'BODY WEIGHT', sets: 1 }),
     { isLogged: true, logMode: 'bodyweight_reps', certain: false });
  eq(inferLogging({ repsText: 'AMRAP', loadText: '1 RIR', sets: 1 }),
     { isLogged: true, logMode: 'weight_reps', certain: false });
});

// 1 row. A unilateral count is still a count.
test('a per side rep count is a rep count', () => {
  eq(parseReps('8 PER SIDE'), { low: 8, high: 8, text: '8 PER SIDE' });
  eq(parseReps('10 EACH SIDE').low, 10);
});

// ------------------------------------------------------------------ importing a workbook
//
// Grids here are the real shapes, trimmed. The point of every one is that no two of the eight
// workbooks agree on wording, so nothing may be matched by literal string in a fixed cell.

// col:      0        1                 2           7        9      10     12     16
const wide = (n, ex, adjust, sets, reps, load, rest, dayType, split) => {
  const row = new Array(17).fill('');
  row[0] = n; row[1] = ex; row[2] = dayType || ''; row[7] = adjust;
  row[9] = split || sets; row[10] = reps; row[12] = load; row[16] = rest;
  return row;
};

function sheet(headerWords, dayWord) {
  const rows = [];
  const day = new Array(17).fill('');
  day[0] = dayWord; day[2] = 'STRENGTH'; day[9] = 'FULL BODY';
  rows.push(day);
  const labels = new Array(17).fill('');
  labels[0] = 'Stretch/Mobility'; labels[6] = 'General Warm Up'; labels[12] = 'Specific Prep';
  rows.push(labels);
  const warm = new Array(17).fill('');
  warm[0] = 'HIP CARS X10'; warm[6] = 'BW SQUAT X10'; warm[12] = 'INCREASE HR';
  rows.push(warm);
  const header = new Array(17).fill('');
  header[0] = '#'; header[1] = headerWords; header[7] = 'Adjust';
  header[9] = 'Sets'; header[10] = 'Reps'; header[12] = 'Load'; header[16] = 'Rest';
  rows.push(header);
  return rows;
}

test('a day block is found whether it says Day or DAY 1', () => {
  for (const word of ['Day', 'DAY 1', 'DAY 4']) {
    const rows = sheet('Exercise', word);
    rows.push(wide('1', 'GOBLET SQUAT', 'ROM', '4', '10', '1 RIR', '60 SEC'));
    const out = readSheet(rows, 'Sheet1');
    eq(out.days.length, 1, `${word} did not start a day`);
    eq(out.days[0].items.length, 1);
  }
});

// The workbook that broke the first version of this: it heads the exercise column WORKING SETS.
test('the exercise column is found by header, not by position', () => {
  const rows = sheet('WORKING SETS', 'DAY 1');
  rows.push(wide('1', 'SLED PUSH', 'WEIGHT', '5', 'N/A', 'RPE 8', '30 SEC'));
  const out = readSheet(rows, 'Sheet1');
  eq(out.days[0].items[0].exerciseName, 'SLED PUSH');
  eq(out.days[0].items[0].targetRpe, 8, 'RPE written directly still reaches the item');
});

test('columns are mapped from the header row in whatever order they appear', () => {
  const header = new Array(8).fill('');
  header[0] = '#'; header[1] = 'REST'; header[2] = 'Exercise'; header[3] = 'LOAD';
  header[4] = 'sets'; header[5] = 'Reps'; header[6] = 'ADJUST';
  const columns = mapColumns(header);
  eq(columns.exercise, 2);
  eq(columns.rest, 1);
  eq(columns.load, 3);
  eq(columns.sets, 4);
  eq(columns.reps, 5);
  eq(columns.adjust, 6);
});

test('a warm up is split across its three columns and the label row is not part of it', () => {
  const rows = sheet('Exercise', 'Day');
  rows.push(wide('1', 'GOBLET SQUAT', 'ROM', '4', '10', '1 RIR', '60 SEC'));
  const day = readSheet(rows, 'Sheet1').days[0];
  eq(day.warmup.mobility, ['HIP CARS X10']);
  eq(day.warmup.general, ['BW SQUAT X10']);
  eq(day.warmup.specific, ['INCREASE HR']);
});

test('a comments block ends the table and is kept as the day comments', () => {
  const rows = sheet('Exercise', 'Day');
  rows.push(wide('1', 'GOBLET SQUAT', 'ROM', '4', '10', '1 RIR', '60 SEC'));
  const c = new Array(17).fill(''); c[1] = 'Comments'; rows.push(c);
  const c1 = new Array(17).fill(''); c1[1] = 'Use a kettlebell if the rack is busy.'; rows.push(c1);
  const day = readSheet(rows, 'Sheet1').days[0];
  eq(day.items.length, 1, 'the comment lines did not become exercises');
  eq(day.comments, ['Use a kettlebell if the rack is busy.']);
});

// A day block with no Load column prescribes no load, so its rep counts are bodyweight. One
// workbook's mobility days are exactly this, and without it every stretch asks for a weight.
test('a table with no load column logs bodyweight reps', () => {
  const rows = [];
  const day = new Array(17).fill(''); day[0] = 'DAY 3'; day[2] = 'MOBILITY'; day[9] = 'HIP FOCUSED';
  rows.push(day);
  const header = new Array(17).fill(''); header[0] = '#'; header[1] = 'WORKING SETS'; header[16] = 'REPS';
  rows.push(header);
  const item = new Array(17).fill(''); item[0] = '1'; item[1] = 'WORLDS GREATEST STRETCH'; item[16] = '3 PER SIDE';
  rows.push(item);

  const out = readSheet(rows, 'Sheet2');
  const first = out.days[0].items[0];
  eq(first.logMode, 'bodyweight_reps');
  eq(first.targetRepsLow, 3, 'a per side count is still a count');
  eq(first.restSeconds, null, 'nothing was read as a rest, because there is no rest column');
  eq(out.warnings, [], 'and nothing was dropped, so nothing is warned about');
});

// Three days that are all FULL BODY, separated only by their type. Three identical entries in
// the client's day picker is a picker nobody can use.
test('a day is named by both halves when they differ', () => {
  eq(dayName('STRENGTH', 'FULL BODY', 'Day'), 'STRENGTH, FULL BODY');
  eq(dayName('ENDURANCE', 'FULL BODY', 'Day'), 'ENDURANCE, FULL BODY');
  eq(dayName('CARDIO', 'CARDIO', 'Day'), 'CARDIO', 'not CARDIO, CARDIO');
  eq(dayName('', 'PUSH/PULL', 'Day'), 'PUSH/PULL');
  eq(dayName('', '', 'DAY 7'), 'DAY 7');
});

test('an empty exercise cell ends the table without ending the sheet', () => {
  const rows = sheet('Exercise', 'Day');
  rows.push(wide('1', 'GOBLET SQUAT', 'ROM', '4', '10', '1 RIR', '60 SEC'));
  rows.push(new Array(17).fill(''));
  rows.push(...sheet('Exercise', 'DAY 2'));
  rows.push(wide('1', 'BENCH ROW', 'WEIGHT', '3', '12', '2 RIR', '45 SEC'));
  const out = readSheet(rows, 'Sheet1');
  eq(out.days.length, 2);
  eq(out.days[0].items.length, 1);
  eq(out.days[1].items.length, 1);
});

test('the summary counts what a trainer is about to create', () => {
  const rows = sheet('Exercise', 'Day');
  rows.push(wide('1', 'GOBLET SQUAT', 'ROM', '4', '10', '1 RIR', '60 SEC'));
  rows.push(wide('2', 'PUSH UPS', 'BW', '3', '12', 'BODY WEIGHT', '60 SEC'));
  const out = readSheet(rows, 'Sheet1');
  const s = summarise(out);
  eq(s.days, 1);
  eq(s.items, 2);
  eq(s.distinctExercises, 2);
  eq(s.modes.bodyweight_reps, 1, 'a body weight load is its own mode');
  eq(s.modes.weight_reps, 1);
});

// ------------------------------------------------------------------ being told no, usefully
//
// Outlook fetches links to scan them, which spends a single use sign in link before the person
// taps it. The resends that follow exhaust a sending quota of two an hour, and the raw Supabase
// message for that states a fact about our project rather than the thing to do, which is to type
// the code from the email they already have.

test('a per address cooldown is read out of the message and carries its own count', () => {
  const d = describeAuthError({ message: 'For security purposes, you can only request this after 51 seconds.' });
  eq(d.kind, 'wait');
  eq(d.waitSeconds, 51);
  eq(/51s/.test(d.message), true, 'the count reaches the person');
});

// The one that matters. Nothing about waiting for another email, because another email is not
// coming for an hour and a live code is already sitting in their inbox.
test('the project sending quota sends people to the code they already have', () => {
  for (const error of [
    { message: 'Email rate limit exceeded', status: 429 },
    { code: 'over_email_send_rate_limit', message: 'anything at all' },
  ]) {
    const d = describeAuthError(error);
    eq(d.kind, 'quota');
    eq(/type its code/i.test(d.message), true);
  }
});

test('a spent link and a spent code read as spent rather than as broken', () => {
  eq(describeAuthError({ code: 'otp_expired', message: 'Token has expired or is invalid' }).kind, 'expired');
  eq(describeAuthError({ message: 'Email link is invalid or has expired' }).kind, 'expired');
});

// A 429 with none of the above wording is still a rate limit and must not fall through to the
// raw message, which is where this started.
test('an unrecognised 429 is still handled as a rate limit', () => {
  eq(describeAuthError({ status: 429, message: 'Too Many Requests' }).kind, 'quota');
});

test('an error nobody anticipated keeps its own message rather than being swallowed', () => {
  eq(describeAuthError({ message: 'Signups not allowed for otp' }).message, 'Signups not allowed for otp');
  eq(describeAuthError({}).message, 'That did not work. Try again.', 'and never an empty string');
});

// Supabase hands out a signup token to somebody signing in for the first time and a magiclink
// token to everybody after that, and rejects the wrong type. A single hardcoded type therefore
// fails for exactly one of those groups, and the group it fails for is every new client.
const codeClient = (accept) => {
  const tried = [];
  return {
    tried,
    auth: {
      async verifyOtp({ type }) {
        tried.push(type);
        return type === accept
          ? { data: { session: { access_token: 'ok' } }, error: null }
          : { data: {}, error: { code: 'otp_expired', message: 'Token has expired or is invalid' } };
      },
    },
  };
};

test('a code is tried against each kind of token until one is accepted', async () => {
  for (const accept of CODE_TYPES) {
    const client = codeClient(accept);
    const session = await verifyCode(client, 'clay@example.com', '123456');
    eq(Boolean(session), true, `${accept} signs in`);
    eq(client.tried[client.tried.length - 1], accept, 'and stops there');
  }
});

test('the first kind accepted costs one request and no more', async () => {
  const client = codeClient('email');
  await verifyCode(client, 'clay@example.com', '123456');
  eq(client.tried, ['email']);
});

// The retry is for a token that did not match, never for being asked too often. Hearing the same
// rate limit three times spends three of an allowance that is the reason this bug was reported.
test('a rate limit stops the retries rather than spending the allowance', async () => {
  const tried = [];
  const client = {
    auth: {
      async verifyOtp({ type }) {
        tried.push(type);
        return { data: {}, error: { status: 429, message: 'Too Many Requests' } };
      },
    },
  };
  let threw = false;
  try {
    await verifyCode(client, 'clay@example.com', '123456');
  } catch {
    threw = true;
  }
  eq(threw, true);
  eq(tried, ['email'], 'one request, not three');
});

test('a code nothing accepts surfaces the real error', async () => {
  const client = codeClient('nothing at all');
  let message = '';
  try {
    await verifyCode(client, 'clay@example.com', '123456');
  } catch (error) {
    message = error.message;
  }
  eq(client.tried, CODE_TYPES);
  eq(message, 'Token has expired or is invalid', 'rather than an undefined from the last loop');
});

test('the address and the code are normalised before they are sent', async () => {
  let sent = null;
  const client = {
    auth: {
      async verifyOtp(args) {
        sent = args;
        return { data: { session: {} }, error: null };
      },
    },
  };
  await verifyCode(client, '  Clay@Example.COM ', '  123456 ');
  eq(sent.email, 'clay@example.com');
  eq(sent.token, '123456');
});

test('the cooldown counts down and then clears', () => {
  const sent = 1_000_000;
  eq(cooldownLeft(sent, sent), RESEND_COOLDOWN_S);
  eq(cooldownLeft(sent, sent + 40_000), 20);
  eq(cooldownLeft(sent, sent + RESEND_COOLDOWN_S * 1000), 0);
  eq(cooldownLeft(sent, sent + 999_000), 0, 'long past');
  eq(cooldownLeft(0, sent), 0, 'never sent');
});

// lastSentAt is written by a browser clock. A device that jumps forward and then back would
// otherwise leave the send button dead for the length of the jump, on the one screen with
// nothing behind it.
test('a clock that jumped does not lock the button', () => {
  eq(cooldownLeft(5_000_000, 1_000_000), 0);
});

// ------------------------------------------------------------------ how many sets there are
//
// js/plan.js. The count comes from the program and the numbers come from history, and these were
// one question until a real workout proved they are two.
//
// What happened: four sets prescribed, one logged, phone locked. The next visit built the plan out
// of last session's rows, found one, and said "Set 1 of 1". Logging that one set took the cursor
// past the end of the plan, which closed the session, which meant the visit after that read one
// set of history too. Every one of these tests is a step in that cascade.

const planItem = (over = {}) => ({
  exercise_id: 'squat',
  log_mode: 'weight_reps',
  target_sets: 4,
  target_reps_low: 9,
  ...over,
});

const opening = { kg: 20, source: 'bar' };

// What lastPerformance hands back, built from set index to row.
const prev = (pairs, startedAt = '2026-08-01T18:00:00.000Z') => ({
  sessionId: 'sPrev',
  startedAt,
  bySetIndex: new Map(pairs),
});

test('a lift with no history gets the set count the trainer prescribed', () => {
  eq(planForItem(planItem(), null, opening).length, 4);
});

test('a session cut short does not shorten the program', () => {
  const entries = planForItem(planItem(), prev([[0, row({ weight_kg: 60, reps: 12 })]]), opening);
  eq(entries.length, 4, 'one set logged last time, four still prescribed');
  eq(entries.map((e) => e.setIndex), [0, 1, 2, 3]);
});

test('the sets history did not reach are carried from the last one that it did', () => {
  const entries = planForItem(planItem(), prev([[0, row({ weight_kg: 60, reps: 12 })]]), opening);
  eq(entries.map((e) => e.weightKg), [60, 60, 60, 60]);
  eq(entries.map((e) => e.reps), [12, 12, 12, 12]);
});

test('a carried set never claims a history it does not have', () => {
  const entries = planForItem(planItem(), prev([[0, row({ weight_kg: 60, reps: 12 })]]), opening);
  eq(entries[0].lastWeightKg, 60, 'set one was performed, so it has a last time');
  eq(entries[0].carriedFrom, null);
  eq(entries[3].lastWeightKg, null, 'set four was not, so it has none');
  eq(entries[3].lastOn, null);
  eq(entries[3].carriedFrom, { weightKg: 60, reps: 12 }, 'and says where its number came from');
});

test('carrying reads the last working set, not the first', () => {
  const entries = planForItem(
    planItem({ target_sets: 3 }),
    prev([[0, row({ weight_kg: 60, reps: 12 })], [1, row({ weight_kg: 70, reps: 10 })]]),
    opening,
  );
  eq(entries[2].weightKg, 70, 'the heavier, more recent set is what would have come next');
  eq(entries[2].reps, 10);
});

test('a fuller session than the program asked for is kept whole', () => {
  const entries = planForItem(
    planItem({ target_sets: 2 }),
    prev([[0, row()], [1, row()], [2, row({ is_extra: true })]]),
    opening,
  );
  eq(entries.length, 3, 'an added set stays in the plan rather than being trimmed back');
});

test('warmups do not count against the prescription', () => {
  const entries = planForItem(
    planItem({ target_sets: 3 }),
    prev([[0, row({ is_warmup: true, weight_kg: 40 })], [1, row({ weight_kg: 80 })]]),
    opening,
  );
  eq(entries.length, 4, 'one warmup plus three working sets');
  eq(entries.filter((e) => !e.isWarmup).length, 3);
  eq(entries[0].isWarmup, true, 'and the warmup keeps its place at the front');
  eq(entries[2].weightKg, 80, 'carrying reads the working set, never the warmup');
});

test('a blank set count still leaves one set to step through', () => {
  eq(setCountOf(planItem({ target_sets: null })), 1, 'an NA cell in a workbook');
  eq(setCountOf(planItem({ target_sets: 0 })), 1);
  eq(setCountOf({}), 1);
  eq(planForItem(planItem({ target_sets: null }), null, opening).length, 1);
});

test('a hold or a carry prefills from its own column rather than from reps', () => {
  eq(countOf(row({ reps: null, hold_seconds: 45 })), 45);
  eq(countOf(row({ reps: null, rounds: 6 })), 6);
  const entries = planForItem(
    planItem({ log_mode: 'time_hold', target_sets: 2, target_reps_low: null }),
    prev([[0, row({ reps: null, hold_seconds: 45, weight_kg: 0 })]]),
    opening,
  );
  eq(entries.map((e) => e.reps), [45, 45], 'a null here put the word null on the stepper');
});

test('the carried numbers are the ones the screen would have to type otherwise', () => {
  // The point of the whole rule: an interrupted four set lift comes back as four identical taps.
  const entries = planForItem(planItem(), prev([[0, row({ weight_kg: 60, reps: 12 })]]), opening);
  ok(entries.every((e) => e.weightKg === 60 && e.reps === 12), 'every set is one tap');
});

// ------------------------------------------------------------------ what the steppers keep
//
// js/plan.js nextSteppers. The plan prefills every set from last session, which is right for the
// first set of a lift and wrong for every set after it once somebody has changed something.
//
// Taking the next entry's number unconditionally meant an adjustment survived exactly one tap.
// Measured on a real workout, on a first ever lift where every set opens at the deliberately too
// light fallback: Horizontal Row logged 40 lb, then 5.5, then 5.5, then 5.5. The client corrected
// set one and the app threw the correction away three times.

// One item object shared by every entry of the lift, which is what a plan actually holds:
// planForItem hands each of its entries the same item, and replaySession reuses template.item for
// a set added by hand. Two lookalike objects would say "same lift" only to a comparison by
// exercise id, and that comparison is exactly what a superset of one exercise breaks.
const squatLift = { exercise_id: 'squat' };

const stepEntry = (over = {}) => ({
  item: squatLift,
  isWarmup: false,
  weightKg: 60,
  reps: 10,
  ...over,
});

test('a weight the client moved carries to the next set of the same lift', () => {
  const from = stepEntry({ weightKg: 2.5 });
  const next = stepEntry({ weightKg: 2.5 });
  eq(nextSteppers({ weightKg: 18.144, reps: 8 }, from, next).weightKg, 18.144);
});

test('the real workout that produced this rule now reads the same weight four times', () => {
  // Four sets of a lift with no history, so every planned entry is the opening fallback.
  const plan = planForItem(
    planItem({ exercise_id: 'row', target_sets: 4, target_reps_low: 8 }),
    null,
    { kg: 2.5, source: 'lightest' },
  );
  let carried = { weightKg: 18.144, reps: 8 };
  const logged = [carried.weightKg];
  for (let i = 0; i + 1 < plan.length; i += 1) {
    carried = nextSteppers(carried, plan[i], plan[i + 1]);
    logged.push(carried.weightKg);
  }
  eq(logged, [18.144, 18.144, 18.144, 18.144], 'and not 40, 5.5, 5.5, 5.5 in pounds');
});

test('a number left alone still steps to what the plan asked for next', () => {
  // A ramp from last session has to survive, or repeating a session stops being one tap a set.
  const from = stepEntry({ weightKg: 60 });
  const next = stepEntry({ weightKg: 65 });
  eq(nextSteppers({ weightKg: 60, reps: 10 }, from, next).weightKg, 65);
});

test('changing a number and changing it back counts as leaving it alone', () => {
  const from = stepEntry({ weightKg: 60 });
  const next = stepEntry({ weightKg: 65 });
  eq(nextSteppers({ weightKg: 60, reps: 10 }, from, next).weightKg, 65, 'because that is what it looks like');
});

test('weight and reps are decided apart', () => {
  const from = stepEntry({ weightKg: 60, reps: 12 });
  const next = stepEntry({ weightKg: 65, reps: 12 });
  const out = nextSteppers({ weightKg: 60, reps: 9 }, from, next);
  eq(out.weightKg, 65, 'the load was not touched, so the plan still decides it');
  eq(out.reps, 9, 'the reps were, so they carry');
});

test('nothing carries into a different lift', () => {
  const from = stepEntry({ item: { exercise_id: 'bench' }, weightKg: 100 });
  const next = stepEntry({ item: { exercise_id: 'lateral-raise' }, weightKg: 7.5 });
  eq(nextSteppers({ weightKg: 120, reps: 5 }, from, next).weightKg, 7.5);
});

test('a warmup never sets the load for the working sets', () => {
  const from = stepEntry({ isWarmup: true, weightKg: 40 });
  const next = stepEntry({ isWarmup: false, weightKg: 100 });
  eq(
    nextSteppers({ weightKg: 45, reps: 5 }, from, next).weightKg,
    100,
    'or the app talks somebody down off their working weight',
  );
});

test('the last set of the day moves no steppers at all', () => {
  eq(nextSteppers({ weightKg: 60, reps: 10 }, stepEntry(), null), null);
});

// ------------------------------------------------------------------ picking a session back up
//
// js/session.js. A phone locks, a tab is discarded, somebody checks Progress between sets. The
// logged rows are safe on disk either way, so the only thing lost is the app's memory of where it
// was, and these rebuild it from the rows.

const openRow = (over = {}) => ({
  id: 's1',
  client_id: 'c1',
  day_index: 0,
  started_at: '2026-08-09T18:00:00.000Z',
  completed_at: null,
  ...over,
});

const AT = Date.parse('2026-08-09T18:40:00.000Z');

test('a session with no completed_at, started minutes ago, is one somebody is in', () => {
  eq(openSession([openRow()], { now: AT }).id, 's1');
});

test('a finished session is not resumable, however recent', () => {
  eq(openSession([openRow({ completed_at: '2026-08-09T18:35:00.000Z' })], { now: AT }), null);
});

test('an abandoned session stops offering itself once the window closes', () => {
  const old = openRow({ started_at: '2026-08-01T18:00:00.000Z' });
  eq(openSession([old], { now: AT }), null, 'or the day picker would sit on it forever');
  eq(openSession([old], { now: Date.parse(old.started_at) + RESUME_WINDOW_MS - 1000 }).id, 's1');
});

test('the most recent open session wins when there is more than one', () => {
  const rows = [
    openRow({ id: 'sA', started_at: '2026-08-09T17:00:00.000Z' }),
    openRow({ id: 'sB', started_at: '2026-08-09T18:20:00.000Z' }),
  ];
  eq(openSession(rows, { now: AT }).id, 'sB');
  eq(openSession([...rows].reverse(), { now: AT }).id, 'sB', 'and order in never changes it');
});

test('nothing at all is not an error', () => {
  eq(openSession([], { now: AT }), null);
  eq(openSession(undefined, { now: AT }), null);
  eq(openSession([openRow({ started_at: 'not a date' })], { now: AT }), null);
});

// The plan a fresh run of the day would build: three sets of squat, then two of bench.
const planOf = () => [
  ...planForItem(planItem({ exercise_id: 'squat', target_sets: 3 }), null, opening),
  ...planForItem(planItem({ exercise_id: 'bench', target_sets: 2 }), null, opening),
];

const done = (over = {}) => row({ session_id: 's1', logged_at: '2026-08-09T18:05:00.000Z', ...over });

test('nothing logged yet leaves the cursor at the top of the plan', () => {
  const back = replaySession(planOf(), []);
  eq(back.cursor, 0);
  eq(back.logged.length, 0);
  eq(back.plan.length, 5);
});

test('two sets in comes back two sets in', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', set_index: 0, logged_at: '2026-08-09T18:05:00.000Z' }),
    done({ id: 'b', set_index: 1, logged_at: '2026-08-09T18:08:00.000Z' }),
  ]);
  eq(back.cursor, 2, 'and the next set on screen is set three');
  eq(back.logged.map((l) => l.id), ['a', 'b']);
  eq(back.plan[back.cursor].setIndex, 2);
});

test('rows replay in the order they were performed, not the order they arrive', () => {
  const back = replaySession(planOf(), [
    done({ id: 'b', set_index: 1, logged_at: '2026-08-09T18:08:00.000Z' }),
    done({ id: 'a', set_index: 0, logged_at: '2026-08-09T18:05:00.000Z' }),
  ]);
  eq(back.logged.map((l) => l.id), ['a', 'b']);
  eq(back.cursor, 2);
});

test('a set that was undone before the interruption stays undone', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', set_index: 0 }),
    done({
      id: 'a-void', set_index: 0, supersedes_id: 'a', is_void: true,
      logged_at: '2026-08-09T18:06:00.000Z',
    }),
  ]);
  eq(back.cursor, 0, 'undo put the cursor back and a reload must not move it forward again');
  eq(back.logged.length, 0);
});

test('a lift that was passed over does not pull the client back to it', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', exercise_id: 'bench', set_index: 0, logged_at: '2026-08-09T18:20:00.000Z' }),
  ]);
  eq(back.cursor, 4, 'where they were, which is the second set of bench');
  eq(back.plan[back.cursor].item.exercise_id, 'bench');
  eq(back.logged.length, 1, 'and squat is simply unlogged, which is what it is');
});

// The whole point of being able to move around: the rack was taken, so bench happened first, and
// then the phone locked. The forward only walk found no seat for the squat rows behind the cursor,
// filed all three as sets added by hand, and handed back a plan with two copies of every squat set
// and the real ones still reading as never done.
test('a session done out of order replays in the order it was done', () => {
  const back = replaySession(planOf(), [
    done({ id: 'b', exercise_id: 'bench', set_index: 0, logged_at: '2026-08-09T18:02:00.000Z' }),
    done({ id: 'a', exercise_id: 'squat', set_index: 0, logged_at: '2026-08-09T18:09:00.000Z' }),
  ]);
  eq(back.plan.length, 5, 'no phantom sets');
  eq(back.logged.map((l) => l.id), ['b', 'a']);
  eq(back.cursor, 1, 'squat was last, so the second set of squat is next');
  eq(back.plan[back.cursor].item.exercise_id, 'squat');
});

test('a row claims its own seat and never a seat already taken', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', set_index: 0, logged_at: '2026-08-09T18:02:00.000Z' }),
    done({ id: 'b', exercise_id: 'bench', set_index: 0, logged_at: '2026-08-09T18:05:00.000Z' }),
    done({ id: 'c', set_index: 1, logged_at: '2026-08-09T18:08:00.000Z' }),
  ]);
  eq(back.plan.length, 5);
  eq(back.logged.map((l) => l.setIndex), [0, 0, 1]);
  eq(new Set(back.logged.map((l) => l.entry)).size, 3, 'three rows, three entries');
});

test('the undo stack holds entries rather than positions', () => {
  const back = replaySession(planOf(), [done({ id: 'a', set_index: 0 })]);
  ok(back.logged[0].entry === back.plan[0], 'which survives a set being inserted before it');
});

test('an added set is put back into the plan where it was added', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', set_index: 0, logged_at: '2026-08-09T18:02:00.000Z' }),
    done({ id: 'b', set_index: 1, logged_at: '2026-08-09T18:05:00.000Z' }),
    done({ id: 'c', set_index: 2, logged_at: '2026-08-09T18:08:00.000Z' }),
    done({ id: 'd', set_index: 3, is_extra: true, logged_at: '2026-08-09T18:11:00.000Z' }),
  ]);
  eq(back.plan.length, 6, 'the plan grew by the one that was added');
  eq(back.logged.length, 4);
  eq(back.logged[3].isExtra, true);
  eq(back.cursor, 4, 'which is the first set of bench');
  eq(back.plan[back.cursor].item.exercise_id, 'bench');
});

test('a record set before the interruption is still a record after it', () => {
  const best = new Map([['squat', 100]]);
  const back = replaySession(planOf(), [done({ id: 'a', set_index: 0, weight_kg: 120, reps: 5 })], best);
  ok(back.best.get('squat') > 100, 'the new best carries across the reload');
  eq(back.logged[0].previousBest, 100, 'and undo can still hand the old one back');
});

test('a warmup logged before the interruption never sets a record', () => {
  const best = new Map([['squat', 100]]);
  replaySession(planOf(), [done({ id: 'a', set_index: 0, weight_kg: 200, reps: 5, is_warmup: true })], best);
  eq(best.get('squat'), 100);
});

test('a lift the program no longer contains is left out rather than guessed at', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', set_index: 0 }),
    done({ id: 'gone', exercise_id: 'deadlift', set_index: 0, logged_at: '2026-08-09T18:09:00.000Z' }),
  ]);
  eq(back.logged.map((l) => l.id), ['a'], 'the row still counts everywhere, it just has no seat here');
  eq(back.cursor, 1);
});

test('replay leaves the plan it was handed alone', () => {
  const plan = planOf();
  replaySession(plan, [done({ id: 'd', set_index: 3, is_extra: true })]);
  eq(plan.length, 5, 'the caller still holds what it passed in');
});

// ------------------------------------------------------------------ the workout, mid session
//
// js/workout-view.js. The list behind the chip top left: every lift in the day, what has been
// logged against each, and where a tap lands.
//
// The gap it closes is a room problem. A rack is taken, so the lift that comes next is not the
// lift that can be done next, and the only answers used to be skip it or leave the screen. These
// tests are mostly about what the list refuses to say: it does not score the session, it does not
// mark a passed over lift as failed, and it does not offer a tap that would write something.

const namedItem = (over = {}) => ({
  exercise_id: 'squat',
  log_mode: 'weight_reps',
  target_sets: 2,
  target_reps_low: 5,
  exercise: { id: 'squat', name: 'Squat' },
  ...over,
});

const benchItem = namedItem({
  exercise_id: 'bench',
  exercise: { id: 'bench', name: 'Bench press' },
});

const dayOf = () => [
  ...planForItem(namedItem(), null, opening),
  ...planForItem(benchItem, null, opening),
];

test('the plan comes back grouped into the lifts it was built from', () => {
  const runs = liftRuns(dayOf());
  eq(runs.length, 2);
  eq(runs.map((run) => run.entries.length), [2, 2]);
  eq(runs.map((run) => run.from), [0, 2]);
});

test('the same lift twice in one day is two lifts and not one of four sets', () => {
  // A sheet that opens and closes with the same carry. Grouping by exercise id made those one row
  // claiming four sets, and the set counter on the logging screen read "set 1 of 4" on the first.
  const runs = liftRuns([
    ...planForItem(namedItem(), null, opening),
    ...planForItem(benchItem, null, opening),
    ...planForItem(namedItem({ target_sets: 1 }), null, opening),
  ]);
  eq(runs.length, 3);
  eq(runs.map((run) => run.entries.length), [2, 2, 1]);
});

test('a tap lands on the first set of that lift nobody has done', () => {
  const plan = dayOf();
  plan[0].status = 'logged';
  eq(overviewRows(plan, 1)[0].at, 1);
});

test('a lift with every set logged is not a control', () => {
  const plan = dayOf();
  plan[0].status = 'logged';
  plan[1].status = 'logged';
  const rows = overviewRows(plan, 2);
  eq(rows[0].at, null, 'because the only thing a tap could mean there is Add set');
  eq(rows[0].logged, 2);
  ok(!renderOverview(rows).includes('data-jump="0"'), 'and the markup carries no way to press it');
});

test('the lift being done is named as such and carries its position', () => {
  const rows = overviewRows(dayOf(), 1);
  eq(rows[1].isCurrent, false);
  eq(stateLine(rows[0]), 'Now, set 2 of 2');
  eq(stateLine(rows[1]), 'Not logged yet');
});

test('a lift that was passed over reads the same as one nobody reached yet', () => {
  const plan = dayOf();
  plan[0].status = 'skipped';
  plan[1].status = 'skipped';
  const rows = overviewRows(plan, 2);
  eq(stateLine(rows[0]), 'Not logged yet', 'no badge, no colour, no count of what was missed');
});

test('a lift that was skipped can still be gone back to', () => {
  // Skip means move me on now. It was permanent for the length of a session only because the
  // cursor could not turn round, and keeping it permanent once the cursor can would be a dead end
  // with no undo on it.
  const plan = dayOf();
  plan[0].status = 'skipped';
  plan[1].status = 'skipped';
  eq(overviewRows(plan, 2)[0].at, 0);
  ok(renderOverview(overviewRows(plan, 2)).includes('data-jump="0"'));
});

test('a lift with sets logged and the rest skipped goes back to what is left', () => {
  const plan = dayOf();
  plan[0].status = 'logged';
  plan[1].status = 'skipped';
  const rows = overviewRows(plan, 2);
  eq(rows[0].at, 1, 'the set that was given up, not the one already done');
  eq(stateLine(rows[0]), '1 of 2 sets logged');
});

test('part of a lift done says how much, without judging it', () => {
  const plan = dayOf();
  plan[0].status = 'logged';
  eq(stateLine(overviewRows(plan, 2)[0]), '1 of 2 sets logged');
});

test('the header line is a position and never a score', () => {
  const plan = dayOf();
  eq(positionLine(overviewRows(plan, 2)), 'Lift 2 of 2');
  plan[2].status = 'skipped';
  plan[3].status = 'skipped';
  eq(positionLine(overviewRows(plan, 0)), 'Lift 1 of 2', 'a skip changes where you are, not a total');
  eq(positionLine(overviewRows(plan, 99)), '2 lifts', 'and off the end of the day it is a count');
  eq(positionLine([]), 'No lifts in this day');
});

test('the lift being done is the one that fills, and it is the only one', () => {
  const markup = renderOverview(overviewRows(dayOf(), 0));
  eq(markup.match(/is-now/g).length, 1);
  ok(markup.includes('aria-current="true"'));
});

test('a lift with sets left is pressable and says where it goes', () => {
  const markup = renderOverview(overviewRows(dayOf(), 0));
  ok(markup.includes('data-jump="0"'));
  ok(markup.includes('data-jump="2"'), 'the lift nobody has started yet');
});

test('what the trainer typed reaches this list as typed', () => {
  const item = namedItem({
    exercise: { id: 'squat', name: 'Squat <heavy>' },
    variation: 'MED GRIP',
    notes: 'Pause at the bottom',
    target_reps_text: '1-2 RIR',
  });
  const rows = overviewRows(planForItem(item, null, opening), 0);
  eq(rows[0].variation, 'MED GRIP');
  eq(rows[0].notes, 'Pause at the bottom');
  const markup = renderOverview(rows);
  ok(markup.includes('Squat &lt;heavy&gt;'), 'and a name with a bracket in it is escaped');
  ok(markup.includes('1-2 RIR'), 'the target line is the trainer own words');
});

test('an entry nobody has touched is pending without being told it is', () => {
  eq(isPending({}), true, 'so a fresh plan needs no loop to mark it');
  eq(isPending({ status: 'logged' }), false);
  eq(isPending({ status: 'skipped' }), false);
  eq(isPending(null), false);
});

test('a day with nothing in it says so rather than rendering an empty list', () => {
  eq(overviewRows([], 0).length, 0);
  ok(renderOverview([]).includes('No lifts in this day'));
});

// ------------------------------------------------------------------ rows that own no sets
//
// A row the trainer marked as not logged. js/plan.js drops it, because it owns no sets and
// stepping through it would mean recording a number nobody measured, and until now that meant it
// was missing from this list too. Three of them are in one real program: a 6 second iso, a pair of
// cardio rows, and a long run day that is nothing else.

const isoItem = namedItem({
  exercise_id: 'iso',
  exercise: { id: 'iso', name: 'Leg Extension Iso Hold' },
  variation: 'SINGLE LEG',
  group_label: '2',
  order_index: 1,
  target_sets: 4,
  target_reps_low: null,
  target_reps_text: '6 sec iso',
  notes: 'Max force into a fixed position.',
  is_logged: false,
});

const dayWithIso = {
  items: [
    namedItem({ order_index: 0 }),
    isoItem,
    namedItem({ ...benchItem, order_index: 2 }),
  ],
};

test('a row the trainer marked as not logged is on the list, not missing from it', () => {
  const rows = overviewRows(dayOf(), 0, dayWithIso);
  eq(rows.map((row) => row.name), ['Squat', 'Leg Extension Iso Hold', 'Bench press']);
  eq(rows[1].shown, true, 'and it is seated where the trainer put it, not appended');
});

test('the day is optional, so a caller holding a plan and no snapshot is unchanged', () => {
  eq(overviewRows(dayOf(), 0).map((row) => row.name), ['Squat', 'Bench press']);
});

test('a row with no sets is not a control and does not offer one', () => {
  const markup = renderOverview(overviewRows(dayOf(), 0, dayWithIso));
  ok(markup.includes('is-shown'));
  eq(markup.match(/data-jump/g).length, 2, 'the two lifts, and nothing on the iso');
});

test('nothing to log and not logged yet are not the same sentence', () => {
  const rows = overviewRows(dayOf(), 0, dayWithIso);
  eq(stateLine(rows[1]), 'Nothing to log', 'there is nothing here to record');
  eq(stateLine(rows[2]), 'Not logged yet', 'you have not done this one');
});

test('what the trainer typed on a not logged row reaches the list too', () => {
  const markup = renderOverview(overviewRows(dayOf(), 0, dayWithIso));
  ok(markup.includes('SINGLE LEG'), 'the variation, which is the whole name of the movement here');
  ok(markup.includes('6 sec iso'), 'and what was asked for');
  ok(markup.includes('Max force into a fixed position.'));
});

test('a row that owns no sets is not a position anybody can be standing in', () => {
  // Counting it would make "Lift 2 of 3" name a seat the cursor can never take.
  eq(positionLine(overviewRows(dayOf(), 0, dayWithIso)), 'Lift 1 of 2');
  eq(positionLine(overviewRows(dayOf(), 2, dayWithIso)), 'Lift 2 of 2');
});

test('a day that is one long run is not a day with nothing in it', () => {
  // The failure this fixes outright: B1 of a real program is a single not logged row, so the panel
  // rendered "No lifts in this day" over an empty list on a day somebody was about to train.
  const run = { items: [namedItem({ exercise: { id: 'run', name: 'Long Run' }, is_logged: false })] };
  const rows = overviewRows([], -1, run);
  eq(rows.length, 1);
  eq(positionLine(rows), '1 not logged');
  ok(renderOverview(rows).includes('Long Run'));
  ok(!renderOverview(rows).includes('No lifts in this day'));
});

// ------------------------------------------------------------------ throwing a session away
//
// js/session.js and js/session-view.js. set_logs cannot be deleted: no delete grant, no delete
// policy, an on delete restrict foreign key, and an adapter that refuses. So a discard retracts
// every set and marks the session, and the marker is the part that carries weight, because two
// things in this app read session rows rather than set rows and would otherwise go on counting a
// workout nobody did.

const hist = (over = {}) => ({
  id: 'h1',
  client_id: 'c1',
  assignment_id: 'a1',
  day_index: 0,
  started_at: '2026-08-09T18:00:00.000Z',
  completed_at: '2026-08-09T19:00:00.000Z',
  discarded_at: null,
  ...over,
});

test('a discarded session is not one of the sessions that happened', () => {
  const rows = [hist({ id: 'a' }), hist({ id: 'b', discarded_at: '2026-08-09T20:00:00.000Z' })];
  eq(live(rows).map((r) => r.id), ['a']);
});

test('live tolerates nothing at all', () => {
  eq(live([]), []);
  eq(live(undefined), []);
  eq(live(null), []);
});

test('a discarded session cannot be resumed, however recent', () => {
  const open = hist({ completed_at: null, discarded_at: '2026-08-09T18:30:00.000Z' });
  eq(openSession([open], { now: AT }), null, 'or discarding one would strand the day picker on it');
});

// retractionOf writes a real row through makeRecord, which validates, so these need actual uuids
// where the readable ids the rest of this file uses would do. That is the point of it: a
// retraction is a row this database has to accept, not a marker in memory.
const uu = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realRow = (n, over = {}) =>
  row({ id: uu(n), session_id: uu(900), exercise_id: uu(901), ...over });

test('a retraction mirrors the row it takes back rather than zeroing it', () => {
  const original = realRow(1, { weight_kg: 90, reps: 7, is_warmup: true, is_extra: true });
  const back = retractionOf(original);
  eq(back.supersedes_id, uu(1));
  eq(back.is_void, true);
  eq(back.weight_kg, 90, 'the audit trail is the reason this table is append only');
  eq(back.reps, 7);
  eq(back.is_warmup, true);
  eq(back.is_extra, true);
  ok(back.id !== uu(1), 'and it is a new row, never an edit of the old one');
});

test('a retraction carries whichever of the three count columns the original had', () => {
  const held = retractionOf(realRow(2, { reps: null, hold_seconds: 40 }));
  eq(held.reps, null);
  eq(held.hold_seconds, 40);
  const circuit = retractionOf(realRow(3, { reps: null, rounds: 5 }));
  eq(circuit.rounds, 5);
  eq(circuit.hold_seconds, null);
});

test('retracting every set of a session leaves nothing that counts and loses no rows', () => {
  const sets = [realRow(4), realRow(5, { set_index: 1 }), realRow(6, { set_index: 2 })];
  const after = [...sets, ...sets.map(retractionOf)];
  eq(activeSetLogs(after).length, 0, 'no chart, record or prefill can see it');
  eq(after.length, 6, 'and every original is still on disk');
});

// ---- the list itself

const summarised = (sessions, logs) => summariseSessions(sessions, logs, (s) => `Day ${s.day_index + 1}`);

test('the history list is newest first', () => {
  const rows = [
    hist({ id: 'old', started_at: '2026-08-01T18:00:00.000Z' }),
    hist({ id: 'new', started_at: '2026-08-09T18:00:00.000Z' }),
  ];
  eq(summarised(rows, []).map((e) => e.id), ['new', 'old']);
});

test('a discarded session is not in the history list either', () => {
  const rows = [hist({ id: 'a' }), hist({ id: 'b', discarded_at: '2026-08-09T20:00:00.000Z' })];
  eq(summarised(rows, []).map((e) => e.id), ['a']);
});

test('working sets and warmups are counted apart, never folded together', () => {
  const logs = [
    row({ id: 'w', session_id: 'h1', is_warmup: true }),
    row({ id: 'a', session_id: 'h1', set_index: 1 }),
    row({ id: 'b', session_id: 'h1', set_index: 2 }),
  ];
  const entry = summarised([hist()], logs)[0];
  eq(entry.sets, 2);
  eq(entry.warmups, 1);
  eq(summaryLine(entry), '2 sets, 1 warmup', 'folding them in is the one way this could overstate');
});

test('a retracted set is not counted in the summary', () => {
  const logged = realRow(7, { session_id: 'h1' });
  const entry = summarised([hist()], [logged, retractionOf({ ...logged, session_id: uu(900) })])[0];
  eq(entry.sets, 0);
  eq(summaryLine(entry), 'Nothing logged');
});

test('a session still being logged says so rather than looking half written', () => {
  const entry = summarised([hist({ completed_at: null })], [])[0];
  eq(entry.isOpen, true);
  ok(renderHistory([entry]).includes('still open'), 'in words, never in a colour');
});

test('the day is named from the assignment the session was logged against', () => {
  const labelled = summariseSessions([hist({ day_index: 2 })], [], (s) => `named ${s.day_index}`);
  eq(labelled[0].label, 'named 2', 'so an old session keeps the name it had at the time');
});

test('an empty history invites rather than apologises', () => {
  const html = renderHistory([]);
  ok(html.includes('Sessions appear here'), html);
  ok(!/sorry|no sessions|nothing yet/i.test(html), 'and does not apologise');
});

test('discard takes two taps, and the second one is not there until the first', () => {
  const entry = summarised([hist()], [])[0];
  const resting = renderHistory([entry]);
  eq((resting.match(/data-act="discard"/g) || []).length, 0, 'nothing commits on one tap');
  ok(resting.includes('data-act="arm"'));

  const armed = renderHistory([entry], { armedId: entry.id });
  ok(armed.includes('data-act="discard"'), 'the second tap exists only once armed');
  ok(armed.includes('data-act="keep"'), 'and so does the way out of it');
});

test('only the armed row offers to commit', () => {
  const entries = summarised([hist({ id: 'a' }), hist({ id: 'b', started_at: '2026-08-08T18:00:00.000Z' })], []);
  const html = renderHistory(entries, { armedId: 'a' });
  eq((html.match(/data-act="discard"/g) || []).length, 1, 'two armed rows is two ways to tap wrong');
});

test('a trainer typed label cannot inject markup into the list', () => {
  const nasty = summariseSessions([hist()], [], () => '<img src=x onerror=alert(1)>')[0];
  const html = renderHistory([nasty], { armedId: nasty.id });
  ok(!html.includes('<img'), html.slice(0, 160));
  ok(html.includes('&lt;img'), 'escaped, not stripped');
});

test('the list says how much further back it goes rather than paging', () => {
  const many = summarised(
    Array.from({ length: 34 }, (_, i) => hist({ id: `s${i}`, started_at: `2026-07-${String(i + 1).padStart(2, '0')}T18:00:00.000Z` })),
    [],
  );
  const html = renderHistory(many, { limit: 30 });
  eq((html.match(/data-session=/g) || []).length, 30);
  ok(html.includes('4 older sessions not shown'), html.slice(-120));
});

test('the acknowledgement names what was given up, not only that something was', () => {
  const entry = summarised([hist()], [])[0];
  ok(discardedMessage(entry, 12).includes('12 sets taken back.'));
  ok(discardedMessage(entry, 1).includes('1 set taken back.'));
  ok(discardedMessage(entry, 0).includes('Nothing was logged in it.'));
  // Both halves are sentences, so the second one starts like one. This shipped reading
  // "Aug 5, 2026. nothing was logged in it." on a real discard.
  ok(!/\. [a-z]/.test(discardedMessage(entry, 0)), discardedMessage(entry, 0));
});

// ------------------------------------------------------------------ how it felt
//
// The subjective half of a session. One text column, so the interesting cases are all about the
// column holding two things at once and coming back apart cleanly afterwards.

test('a feeling on its own is the whole note', () => {
  eq(composeNote('Hard', ''), 'Hard');
  eq(parseNote('Hard'), { feel: 'Hard', text: '' });
});

test('a note on its own is kept whole and claims no feeling', () => {
  eq(composeNote(null, 'Left wrist gave out'), 'Left wrist gave out');
  eq(parseNote('Left wrist gave out'), { feel: null, text: 'Left wrist gave out' });
});

test('a feeling and a note round trip through the one column', () => {
  const note = composeNote('All out', 'Last hold nearly failed');
  eq(note, 'All out. Last hold nearly failed');
  eq(parseNote(note), { feel: 'All out', text: 'Last hold nearly failed' });
});

test('nothing said is null rather than an empty string', () => {
  eq(composeNote(null, ''), null, 'null is what the column has always held');
  eq(composeNote(null, '   '), null, 'and whitespace is not something somebody said');
  eq(composeNote('Solid', '   '), 'Solid');
});

test('a note that merely opens with a feeling does not light up a chip', () => {
  // The failure this prevents is the app putting a word in somebody's mouth: a chip drawn as
  // selected that the client never tapped, on a screen whose whole job is an honest record.
  eq(parseNote('Hard to say what changed'), { feel: null, text: 'Hard to say what changed' });
  eq(parseNote('Easygoing session'), { feel: null, text: 'Easygoing session' });
});

test('every note the app has ever stored survives being read by this', () => {
  // Nothing wrote to client_note before this existed, and the seed writes free sentences.
  eq(parseNote(null), { feel: null, text: '' });
  eq(parseNote(undefined), { feel: null, text: '' });
  eq(parseNote('Short on sleep, kept the load the same.'), {
    feel: null,
    text: 'Short on sleep, kept the load the same.',
  });
});

test('an unknown word is treated as a sentence, not as a feeling', () => {
  eq(parseNote('Brutal. and then some'), { feel: null, text: 'Brutal. and then some' });
});

test('the feelings are an effort ladder and never a verdict', () => {
  // A four point ladder with no failure state on it. If a word like "Failed" or "Bad" ever gets
  // added here, the no-guilt rule in CLAUDE.md is what it has to be argued against.
  eq(FEELINGS.length, 4);
  ok(!/fail|bad|poor|weak|missed/i.test(FEELINGS.join(' ')), FEELINGS.join(' '));
});

test('what the client said reaches the list that reads it back', () => {
  const entry = summarised([hist({ client_note: 'All out. Wrist gave out' })], [])[0];
  eq(entry.note, 'All out. Wrist gave out');
  ok(renderHistory([entry]).includes('All out. Wrist gave out'));
});

test('a session with nothing said carries no empty line', () => {
  const entry = summarised([hist()], [])[0];
  eq(entry.note, null);
  ok(!renderHistory([entry]).includes('history__note'));
});

test('a client typed note cannot inject markup into the list', () => {
  const entry = summarised([hist({ client_note: '<img src=x onerror=alert(1)>' })], [])[0];
  const html = renderHistory([entry]);
  ok(!html.includes('<img'), html.slice(0, 160));
  ok(html.includes('&lt;img'), 'escaped, not stripped');
});

test('a trainer reading the list gets the note and no way to discard', () => {
  // 0011 gives the update policy to the client alone, so the control would be one that could only
  // ever fail. The rows are the same rows: a trainer already reads these sessions as chart points.
  const entry = summarised([hist({ client_note: 'Solid' })], [])[0];
  const html = renderHistory([entry], { discard: false });
  ok(html.includes('Solid'), 'the note is the reason a trainer is reading this at all');
  eq((html.match(/data-act=/g) || []).length, 0, 'and nothing here writes');
});

test('an armed row cannot survive the list being drawn for somebody else', () => {
  const entry = summarised([hist()], [])[0];
  const html = renderHistory([entry], { armedId: entry.id, discard: false });
  eq((html.match(/data-act="discard"/g) || []).length, 0);
  ok(!html.includes('is-armed'), 'a stale armed id must not draw a control for a trainer');
});

// ------------------------------------------------------------------ work per session
//
// js/session-volume.js, the client wide chart under the grid. Two things here are the whole reason
// the module exists rather than being three lines inside progress.js: the split by program day,
// without which the line is a sawtooth measuring the day of the week, and the identity coming from
// the same function the calendar uses, without which a line and a cell can disagree about what a
// Tuesday was.

// Finished by default, unlike the fixtures above, because this is the one builder that cares: a
// session still running has no total yet and is not a point.
const wsession = (id, day, over = {}) => ({
  id, client_id: 'c1', assignment_id: 'a1', day_index: 0, started_at: `${day}T18:00:00.000Z`,
  completed_at: `${day}T19:00:00.000Z`, client_note: null, ...over,
});

const wdays = [cday(0, 'UPPER A'), cday(1, 'LOWER A')];

const work = (sessions, setLogs, assignments = [cassign('a1', '2026-07-01', wdays)]) =>
  buildSessionVolume({ sessions, setLogs, assignments });

const lineFor = (b, label) => b.lines.find((l) => l.label === label);

test('a session is one point on the line for the day it was', () => {
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-03', { day_index: 1 })],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 60, reps: 10 }),
    ],
  );
  eq(b.lines.length, 2);
  eq(lineFor(b, 'UPPER A').points[0].volumeKg, 500, 'weight times reps');
  eq(lineFor(b, 'LOWER A').points[0].volumeKg, 600);
});

test('a day is compared against itself and never against the session before it', () => {
  // The failure this prevents: the last two sessions are two different days, so a change measured
  // across them reports that Thursday is not Tuesday and calls it progress.
  const b = work(
    [
      wsession('s1', '2026-07-01'),
      wsession('s2', '2026-07-03', { day_index: 1 }),
      wsession('s3', '2026-07-08'),
      wsession('s4', '2026-07-10', { day_index: 1 }),
      wsession('s5', '2026-07-15'),
      wsession('s6', '2026-07-22'),
    ],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 50 }),
      row({ session_id: 's3', weight_kg: 100, reps: 6 }),
      row({ session_id: 's4', weight_kg: 100, reps: 50 }),
      row({ session_id: 's5', weight_kg: 100, reps: 7 }),
      row({ session_id: 's6', weight_kg: 100, reps: 8 }),
    ],
  );
  eq(b.lead.label, 'UPPER A', 'the line with the most sessions behind it speaks');
  eq(b.change.first, 500);
  eq(b.change.last, 800, 'the last UPPER A, not the last session of any kind');
});

test('the grid and the chart cannot disagree about which day a session was', () => {
  const sessions = [wsession('s1', '2026-07-03', { day_index: 1 })];
  const logs = [row({ session_id: 's1', weight_kg: 100, reps: 5 })];
  const assignments = [cassign('a1', '2026-07-01', wdays)];
  const b = work(sessions, logs, assignments);
  const grid = buildConsistency({
    sessions, assignments, sessionIdsWithWork: new Set(['s1']), today: '2026-07-05',
  });
  const cell = cellFor(grid, '2026-07-03');
  eq(b.lines[0].slot, cell.slot, 'same slot, so the line is the colour the cell is');
  eq(b.lines[0].glyph, cell.glyph);
  eq(b.lines[0].label, cell.label);
});

test('warmups never reach the line', () => {
  const b = work(
    [wsession('s1', '2026-07-01')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's1', set_index: 1, weight_kg: 40, reps: 10, is_warmup: true }),
    ],
  );
  eq(lineFor(b, 'UPPER A').points[0].volumeKg, 500, 'the warmup is not work done');
});

test('a retracted set is gone from this chart as well as the others', () => {
  const first = row({ session_id: 's1', weight_kg: 100, reps: 5 });
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-08')],
    [
      first,
      row({ session_id: 's1', supersedes_id: first.id, is_void: true }),
      row({ session_id: 's2', weight_kg: 100, reps: 5 }),
    ],
  );
  eq(b.totalSessions, 1, 'the session it emptied is not a point either');
  eq(lineFor(b, 'UPPER A').points.length, 1);
});

test('a session that comes out at zero is left off rather than drawn on the floor', () => {
  // Bodyweight rows and holds both compute to nothing. A point at zero would draw a session
  // nobody did, at the one value on this axis that means "no work".
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-08')],
    [
      row({ session_id: 's1', weight_kg: 0, reps: 20 }),
      row({ session_id: 's1', set_index: 1, weight_kg: 80, reps: null, hold_seconds: 45 }),
      row({ session_id: 's2', weight_kg: 100, reps: 5 }),
    ],
  );
  eq(b.totalSessions, 1);
  eq(lineFor(b, 'UPPER A').points[0].sessionIds, ['s2']);
});

// The dip that is really a session in progress. Opening Progress between the first set and the last
// is the most likely moment anybody looks at this screen, and every one of those looks used to show
// the line falling off a cliff that closed itself when the session ended.
test('a session still running is not a point, because its total is not known yet', () => {
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-08', { completed_at: null })],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 1 }),
    ],
  );
  eq(b.totalSessions, 1);
  eq(lineFor(b, 'UPPER A').points.length, 1, 'and the line does not dive to meet one logged set');
  eq(b.latest.volumeKg, 500);
});

// The four dots inside one pixel. Every row still counts; what changes is that a visit is a point.
test('one program day trained twice in an evening is one visit, not two points', () => {
  const b = work(
    [
      wsession('s1', '2026-07-01'),
      wsession('s2', '2026-07-01', { started_at: '2026-07-01T18:40:00.000Z', completed_at: '2026-07-01T19:10:00.000Z' }),
      wsession('s3', '2026-07-08'),
    ],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 3 }),
      row({ session_id: 's3', weight_kg: 100, reps: 9 }),
    ],
  );
  const points = lineFor(b, 'UPPER A').points;
  eq(points.length, 2, 'two visits');
  eq(points[0].volumeKg, 800, 'the interrupted evening is the work it held, added up');
  eq(points[0].sessionIds.length, 2, 'and it still knows which sessions it came from');
  eq(b.totalSessions, 3, 'the sessions are all still counted');
  eq(b.totalPoints, 2);
});

test('two different program days on one day stay two points', () => {
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-01', { day_index: 1 })],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 9 }),
    ],
  );
  eq(b.lines.length, 2, 'summing across days is the sawtooth this module exists to avoid');
  eq(lineFor(b, 'UPPER A').points[0].volumeKg, 500);
  eq(lineFor(b, 'LOWER A').points[0].volumeKg, 900);
});

// The rule that is deliberately NOT here. A short session is a low point, and the line drops to it.
test('a finished session holding one set is a point at the height of one set', () => {
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-08'), wsession('s3', '2026-07-15')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 10 }),
      row({ session_id: 's2', weight_kg: 100, reps: 10 }),
      row({ session_id: 's3', weight_kg: 100, reps: 1 }),
    ],
  );
  eq(lineFor(b, 'UPPER A').points.map((p) => p.volumeKg), [1000, 1000, 100]);
});

test('a client with nothing loaded gets no lines, so the card can hide itself', () => {
  const b = work([wsession('s1', '2026-07-01')], [row({ session_id: 's1', weight_kg: 0, reps: 20 })]);
  eq(b.lines.length, 0);
  eq(b.evidence, 'none');
});

// The one place this chart departs from the rule in CLAUDE.md that extra volume never joins the
// number carrying a claim. The claim here is how much work a session held, and a set somebody
// chose to add is work they did. The per lift card still separates the two.
test('a set added beyond the plan is work done and counts here', () => {
  const b = work(
    [wsession('s1', '2026-07-01')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's1', set_index: 1, weight_kg: 100, reps: 5, is_extra: true }),
    ],
  );
  eq(lineFor(b, 'UPPER A').points[0].volumeKg, 1000);
});

test('another client\'s rows never reach the chart', () => {
  const b = work(
    [wsession('s1', '2026-07-01')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 'somebody-else', weight_kg: 200, reps: 5 }),
    ],
  );
  eq(b.totalSessions, 1);
  eq(lineFor(b, 'UPPER A').points[0].volumeKg, 500);
});

test('a planned deload is marked on the point and kept out of the change', () => {
  const b = work(
    [wsession('s1', '2026-07-01'), wsession('s2', '2026-07-08'), wsession('s3', '2026-07-15')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 1 }),
      row({ session_id: 's3', weight_kg: 100, reps: 6 }),
    ],
    [cassign('a1', '2026-07-01', wdays, { deload_weeks: [1] })],
  );
  const points = lineFor(b, 'UPPER A').points;
  eq(points.map((p) => p.isDeload), [false, true, false]);
  ok(b.hasDeload, 'and the caller can say so in words');
  eq(b.change.last, 600, 'the back off week is not the end of the trend');
});

test('more program days than the palette has slots folds the quietest one into a note', () => {
  // A five day program has five days and four slots, so two of its lines would come out the same
  // colour with only the glyph telling them apart. The one folded is the one with the least behind
  // it, and DAY E here is both trained once and trained longest ago.
  const days = ['A', 'B', 'C', 'D', 'E'].map((name, index) => cday(index, `DAY ${name}`));
  const sessions = [];
  const logs = [];
  days.forEach((day, index) => {
    const times = index === 4 ? 1 : 2;
    for (let n = 0; n < times; n += 1) {
      const id = `s${index}${n}`;
      const day = index === 4 ? '2026-06-01' : `2026-07-${String(2 * n + 1).padStart(2, '0')}`;
      sessions.push(wsession(id, day, { day_index: index }));
      logs.push(row({ session_id: id, weight_kg: 100, reps: 5 }));
    }
  });
  const b = work(sessions, logs, [cassign('a1', '2026-06-01', days)]);
  eq(b.lines.length, MAX_DAY_LINES);
  eq(b.hiddenLabels, ['DAY E']);
  eq(b.totalSessions, 9, 'and the sessions are still counted even where the line is not drawn');
});

test('a day is a line even when the program it belonged to is long gone', () => {
  const b = work(
    [wsession('s1', '2026-06-02', { assignment_id: 'old' }), wsession('s2', '2026-07-01')],
    [
      row({ session_id: 's1', weight_kg: 100, reps: 5 }),
      row({ session_id: 's2', weight_kg: 100, reps: 5 }),
    ],
    [cassign('old', '2026-06-01', [cday(0, 'FULL BODY')]), cassign('a1', '2026-07-01', wdays)],
  );
  eq(b.lines.map((l) => l.label).sort(), ['FULL BODY', 'UPPER A'], 'history is not repainted');
});

// The curve, which is the one piece of drawing code in this file. A spline that overshoots draws a
// session at a volume nobody logged, and it overshoots most where the data is most uneven.
test('a smoothed curve never rises above the highest point it passes through', () => {
  const points = [
    { x: 0, y: 100 },
    { x: 40, y: 60 },
    { x: 80, y: 62 },
    { x: 120, y: 20 },
    { x: 160, y: 90 },
  ];
  const d = smoothPath(points);
  const numbers = d.match(/-?\d+\.?\d*/g).map(Number);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  const lo = Math.min(...points.map((p) => p.y));
  const hi = Math.max(...points.map((p) => p.y));
  // Every control point inside the data's own range is what bounds the curve to it, since a cubic
  // bezier is contained by the hull of its four points.
  ok(Math.min(...ys) >= lo - 0.01, `dipped to ${Math.min(...ys)} under ${lo}`);
  ok(Math.max(...ys) <= hi + 0.01, `rose to ${Math.max(...ys)} over ${hi}`);
});

test('a curve through one point is not a path anybody can stroke', () => {
  eq(smoothPath([]), '');
  eq(smoothPath([{ x: 5, y: 5 }]), 'M5.0 5.0', 'a moveto draws nothing, which is correct');
});


// ------------------------------------------------------------------ the lift picker
//
// js/lift-picker.js, which replaced the row of chooser chips on the progress screen and the
// trainer's client view. The row could only hold as many lifts as fit across a phone, which on the
// seeded client was under a third of them and on a real seven day split is a good deal less.
//
// What is worth testing here is the data, not the pixels: which lifts are offered, what each row
// claims about them, and how forty of them are arranged so somebody can find one.

const psession = (id, day, over = {}) => ({
  id, client_id: 'c1', assignment_id: 'a1', day_index: 0,
  started_at: `${day}T18:00:00.000Z`, completed_at: `${day}T19:00:00.000Z`, ...over,
});

const pexercises = (...names) =>
  new Map(names.map((name) => [name.toLowerCase(), { id: name.toLowerCase(), name }]));

test('a lift is offered once however many sets are behind it', () => {
  const lifts = liftSummaries({
    exercises: pexercises('Squat', 'Bench'),
    sessions: [psession('s1', '2026-07-01'), psession('s2', '2026-07-03')],
    setLogs: [
      row({ id: 'a', session_id: 's1', exercise_id: 'squat' }),
      row({ id: 'b', session_id: 's1', exercise_id: 'squat' }),
      row({ id: 'c', session_id: 's2', exercise_id: 'squat' }),
      row({ id: 'd', session_id: 's2', exercise_id: 'bench' }),
    ],
  });
  eq(lifts.map((l) => [l.name, l.sessions]), [['Bench', 1], ['Squat', 2]], 'sessions, not rows');
});

// The bug this replaces: the progress screen counted raw rows, so a lift somebody corrected three
// times in one session read as three sessions of work under its own name.
test('a corrected set is one session on that lift and not two', () => {
  const first = row({ id: 'a', session_id: 's1', exercise_id: 'squat', weight_kg: 100 });
  const fixed = row({ id: 'b', session_id: 's1', exercise_id: 'squat', weight_kg: 105, supersedes_id: 'a' });
  const lifts = liftSummaries({
    exercises: pexercises('Squat'),
    sessions: [psession('s1', '2026-07-01')],
    setLogs: [first, fixed],
  });
  eq(lifts.map((l) => l.sessions), [1]);
});

test('a lift whose only rows were retracted is not offered at all', () => {
  const logged = row({ id: 'a', session_id: 's1', exercise_id: 'squat' });
  const taken = row({ id: 'b', session_id: 's1', exercise_id: 'squat', supersedes_id: 'a', is_void: true });
  const lifts = liftSummaries({
    exercises: pexercises('Squat'),
    sessions: [psession('s1', '2026-07-01')],
    setLogs: [logged, taken],
  });
  eq(lifts, [], 'an entry with nothing under it is a dead end');
});

test('a warmup is not a session on a lift', () => {
  const lifts = liftSummaries({
    exercises: pexercises('Squat'),
    sessions: [psession('s1', '2026-07-01')],
    setLogs: [row({ session_id: 's1', exercise_id: 'squat', is_warmup: true })],
  });
  eq(lifts, []);
});

// Rows arriving here can include another client's, since the adapter is asked for set_logs with no
// filter and the local mirror holds whatever RLS let through.
test('a row belonging to a session this client does not have is not offered', () => {
  const lifts = liftSummaries({
    exercises: pexercises('Squat'),
    sessions: [psession('s1', '2026-07-01')],
    setLogs: [row({ session_id: 'somebody-else', exercise_id: 'squat' })],
  });
  eq(lifts, []);
});

const plift = (id, name, sessions = 1) => ({ id, name, sessions, lastDay: '2026-07-01' });
const pday = (dayIndex, split, ids) => ({
  id: `d${dayIndex}`, day_index: dayIndex, name: null, split,
  items: ids.map((id, i) => ({ order_index: i, exercise: { id, name: id } })),
});

test('lifts are grouped by the day of the program they are on, in the trainer order', () => {
  const groups = groupLifts(
    [plift('squat', 'Squat'), plift('bench', 'Bench'), plift('row', 'Row')],
    { days: [pday(1, 'LOWER', ['squat']), pday(0, 'UPPER', ['bench', 'row'])] },
  );
  eq(
    groups.map((g) => [g.label, g.lifts.map((l) => l.id)]),
    [['UPPER', ['bench', 'row']], ['LOWER', ['squat']]],
    'day order from day_index, lift order from order_index',
  );
});

test('a lift on two days is listed under the first one and not both', () => {
  const groups = groupLifts(
    [plift('squat', 'Squat')],
    { days: [pday(0, 'A', ['squat']), pday(1, 'B', ['squat'])] },
  );
  eq(groups.map((g) => [g.label, g.lifts.length]), [['A', 1]], 'a chooser with a duplicate in it picks twice');
});

test('a lift the current program does not ask for keeps its history and its own heading', () => {
  const groups = groupLifts(
    [plift('squat', 'Squat'), plift('curl', 'Curl')],
    { days: [pday(0, 'LOWER', ['squat'])] },
  );
  eq(groups.map((g) => g.label), ['LOWER', 'Other lifts']);
  eq(groups[1].lifts.map((l) => l.id), ['curl']);
});

test('with no program to group by the whole list is still offered', () => {
  const groups = groupLifts([plift('squat', 'Squat')], null);
  eq(groups.map((g) => [g.label, g.lifts.length]), [['Every lift', 1]], 'never an unlabelled tail');
});

test('search matches every word anywhere in the name, in any order', () => {
  const lifts = [plift('a', 'Barbell Bench Press'), plift('b', 'Leg Press'), plift('c', 'Barbell Row')];
  eq(matchLifts(lifts, 'press bench').map((l) => l.id), ['a'], 'order of the words is not the order in the name');
  eq(matchLifts(lifts, 'press').map((l) => l.id), ['a', 'b'], 'substring, not prefix');
  eq(matchLifts(lifts, '   ').map((l) => l.id), ['a', 'b', 'c'], 'nothing typed is not a filter');
});

test('the lift being read is the filled row and says so in a word', () => {
  const html = renderLiftPicker({
    lifts: [plift('squat', 'Squat'), plift('bench', 'Bench')],
    selectedId: 'squat',
    open: true,
  });
  ok(html.includes('data-exercise="squat"'), 'the row is there');
  // Both signals, per the encoding rules: the fill comes from is-on and the word carries it again.
  ok(/is-on[^>]*data-exercise="squat"/.test(html), 'the selected row fills');
  ok(html.includes('Showing'), 'and says which one it is');
  ok(!/is-on[^>]*data-exercise="bench"/.test(html), 'only one');
});

test('the search field appears only once the list is longer than a screen', () => {
  const many = Array.from({ length: SEARCH_AT + 1 }, (_, i) => plift(`e${i}`, `Lift ${i}`));
  ok(!renderLiftPicker({ lifts: many.slice(0, SEARCH_AT), open: true }).includes('liftpick-search'));
  ok(renderLiftPicker({ lifts: many, open: true }).includes('liftpick-search'));
});

test('a narrowed list says what narrowed it and carries the way out', () => {
  const html = renderLiftPicker({
    lifts: [plift('squat', 'Squat')],
    selectedId: 'squat',
    open: true,
    scope: 'Thursday, August 13',
  });
  ok(html.includes('Thursday, August 13'), 'the narrowing is stated');
  ok(html.includes('data-clear-scope'), 'and reversible');
  ok(html.includes('1 lift in this session'), 'the count says which list this is');
});

test('a search that matches nothing is an invitation rather than an empty box', () => {
  const html = renderLiftPicker({ lifts: [plift('squat', 'Squat')], open: true, query: 'zzz' });
  ok(html.includes('No lift here matches'), 'says what happened');
  ok(!html.includes('data-exercise='), 'and offers nothing that is not there');
});

// A trainer types the split names, so they reach this markup as free text.
test('a day name with markup in it is escaped rather than rendered', () => {
  const groups = groupLifts([plift('squat', 'Squat')], { days: [pday(0, '<b>A</b>', ['squat'])] });
  const html = renderLiftPicker({ lifts: [plift('squat', 'Squat')], groups, open: true });
  ok(html.includes('&lt;b&gt;A&lt;/b&gt;'), 'escaped');
  ok(!html.includes('<b>A</b>'), 'not rendered');
});

// ------------------------------------------------------------------ the day's readout
//
// js/session-readout.js, which is what a tapped cell on the consistency grid opens. It replaced a
// line that named the lifts and counted the sets, which answered "did I train" for a second time
// on a screen where the cell above had already answered it.

const kg = (v) => `${v} kg`;

test('a loaded set says the load and the reps', () => {
  eq(setLine({ weight_kg: 100, reps: 5 }, kg), '100 kg × 5');
});

test('nothing on the bar is bodyweight and never zero', () => {
  eq(setLine({ weight_kg: 0, reps: 8 }, kg), 'Bodyweight × 8');
});

test('a hold is seconds and a hold with a belt on says both', () => {
  eq(setLine({ weight_kg: 0, reps: null, hold_seconds: 42 }, kg), '42s');
  eq(setLine({ weight_kg: 10, reps: null, hold_seconds: 30 }, kg), '30s with 10 kg');
});

test('rounds are rounds and never reps', () => {
  eq(setLine({ weight_kg: 0, reps: null, rounds: 6 }, kg), '6 rounds');
});

test('a carry has a load and nothing to count', () => {
  eq(setLine({ weight_kg: 60, reps: null }, kg), '60 kg');
});

test('rpe rides along wherever it was recorded', () => {
  eq(setLine({ weight_kg: 100, reps: 5, rpe: 8.5 }, kg), '100 kg × 5 RPE 8.5');
});

const readout = (over = {}) =>
  renderSessionReadout(
    {
      day: '2026-08-13',
      dayLabel: 'Thursday, August 13',
      sessions: [{
        label: 'LOWER A', time: '6:48 PM', note: '', isOpen: false,
        lifts: [{ name: 'Squat', sets: [row({ weight_kg: 100, reps: 5 })] }],
        ...over,
      }],
    },
    { weight: kg },
  );

test('a warmup and an added set are marked in words and never in a colour', () => {
  const html = readout({
    lifts: [{
      name: 'Squat',
      sets: [
        row({ weight_kg: 50, reps: 8, is_warmup: true }),
        row({ weight_kg: 100, reps: 5 }),
        row({ weight_kg: 100, reps: 5, is_extra: true }),
      ],
    }],
  });
  eq((html.match(/Warmup/g) ?? []).length, 1);
  eq((html.match(/Added/g) ?? []).length, 1);
});

test('what the client said about a session is in the readout, in their words', () => {
  ok(readout({ note: 'Hips felt tight all session' }).includes('Hips felt tight all session'));
});

test('a session still running says so rather than being drawn as a short one', () => {
  ok(readout({ isOpen: true }).includes('Still open'));
});

test('a day with nothing on it is nothing, not an empty card', () => {
  eq(renderSessionReadout({ day: '2026-08-13', dayLabel: 'x', sessions: [] }, { weight: kg }), '');
});

// The readout carries weights, which the line it replaced deliberately did not. Nothing in it may
// format one itself: CLAUDE.md gives that job to js/units.js and to nothing else.
test('nothing in the readout formats a weight its own way', () => {
  const html = readout();
  ok(html.includes('100 kg × 5'), 'the caller formatter is what ran');
  ok(!html.includes('100kg'), 'and no second opinion about how a weight looks');
});


// ------------------------------------------------------------------ the import review screen
//
// js/import-ui.js. The review step used to be read only except for the Log column, so a trainer
// looking straight at a wrong rest time had to create the program anyway and go and find the row
// again in the builder. Every cell is a field now, parsed through the same functions the builder
// uses, and nothing is written until createProgram runs.

const draftItem = (over = {}) => ({
  groupLabel: '1', exerciseName: 'BARBELL BACK SQUAT', variation: 'BARBELL',
  targetSets: 4, targetRepsLow: 8, targetRepsHigh: null, targetRepsText: '8',
  targetLoad: '2 RIR', targetRpe: null, restSeconds: 60,
  isLogged: true, logMode: 'weight_reps', needsReview: false, ...over,
});
const draftOf = (...items) => ({
  fileName: 'Emma.xlsx', warnings: [],
  days: [{ name: 'GLUTE DAY', dayType: 'STRENGTH', split: 'GLUTE DAY', sheet: 'Sheet2',
           warmup: { mobility: [], general: [], specific: [] }, comments: [], items }],
});

test('a rest time can be fixed where it is noticed, in the sheet\'s own words', () => {
  const draft = draftOf(draftItem());
  const out = setField(draft, 0, 0, 'rest', '150 SEC');
  eq(draft.days[0].items[0].restSeconds, 150, 'parsed the same way the builder parses it');
  ok(out.target.includes('150s rest'), out.target);
});

test('a rep range edited on review reaches both ends of the range', () => {
  const draft = draftOf(draftItem());
  setField(draft, 0, 0, 'reps', '6-10');
  const item = draft.days[0].items[0];
  eq([item.targetRepsLow, item.targetRepsHigh, item.targetRepsText], [6, 10, '6-10']);
});

test('the sentence the client will read follows the edit', () => {
  const draft = draftOf(draftItem());
  const before = setField(draft, 0, 0, 'sets', '4').target;
  const after = setField(draft, 0, 0, 'sets', '5').target;
  ok(before.startsWith('4 sets'), before);
  ok(after.startsWith('5 sets'), after);
});

// The same rule the builder follows: a guess may be revised until somebody decides, and never
// after. An EMOM row whose Load says "1 MIN EMOM" is exactly the row a trainer overrides.
test('editing load re-guesses how a row is logged, until the trainer has chosen', () => {
  const draft = draftOf(draftItem({ targetLoad: '1 MIN EMOM' }));
  setField(draft, 0, 0, 'load', 'BW');
  const guessed = draft.days[0].items[0].logMode;
  setMode(draft, 0, 0, 'rounds');
  setField(draft, 0, 0, 'load', '25 lb');
  eq(draft.days[0].items[0].logMode, 'rounds', 'a decision is not guessed over');
  ok(guessed !== undefined, 'and it did guess before the decision');
});

test('choosing not to log a row survives an edit to the row', () => {
  const draft = draftOf(draftItem());
  setMode(draft, 0, 0, 'none');
  setField(draft, 0, 0, 'reps', '12');
  eq(draft.days[0].items[0].isLogged, false);
});

test('an edit to a row that is not there changes nothing and returns nothing', () => {
  const draft = draftOf(draftItem());
  eq(setField(draft, 9, 9, 'rest', '90 SEC'), null);
  eq(setField(draft, 0, 0, 'nonsense', 'x'), null);
  eq(draft.days[0].items[0].restSeconds, 60, 'untouched');
});

test('every cell on the review screen is a field, and each one is addressable', () => {
  const html = renderDraft(draftOf(draftItem(), draftItem({ groupLabel: '2' })));
  for (const col of ['group', 'exercise', 'variation', 'sets', 'reps', 'load', 'rest']) {
    ok(html.includes(`data-col="${col}"`), `${col} is editable`);
  }
  ok(html.includes('data-row="0-0"') && html.includes('data-row="0-1"'), 'rows are addressable');
  ok(html.includes('data-target="0-0"'), 'and so is the sentence that has to follow an edit');
});

// A trainer types the exercise names, and the file is somebody else's spreadsheet.
test('a draft cell carrying markup is escaped rather than rendered', () => {
  const html = renderDraft(draftOf(draftItem({ exerciseName: '<b>SQUAT</b>' })));
  ok(html.includes('&lt;b&gt;SQUAT&lt;/b&gt;'));
  ok(!html.includes('<b>SQUAT</b>'));
});

// ------------------------------------------------------------------ every minute on the minute
//
// The one screen where the app sets the pace. All of it is derived from elapsed time, because the
// phone this runs on throttles a backgrounded tab and then stops calling back entirely, so
// anything that counted ticks would drift and then stop, and a drifting EMOM silently changes the
// workout. These tests call the functions at times, never in sequences, which is the property
// worth pinning: the answer must not depend on how often anybody asked.

const station = (name, reps) => ({ exercise_id: `e-${name}`, exercise: { name }, reps });
const emomDay = (rounds, windowSeconds) => ({ emom: { rounds, window_seconds: windowSeconds } });
// Emma's day: six stations, one minute each, five rounds.
const emmaBlock = () =>
  emomBlock(
    emomDay(5, 60),
    [
      station('DB THRUSTERS', 12), station('ALT DB SNATCH', 12), station('TOE TAPS', 40),
      station('MOUNTAIN CLIMBERS', 40), station('BICYCLE CRUNCHES', 30), station('JUMPING SQUATS', 15),
    ],
    (item) => item.reps,
  );

test('a day with no emom settings is not a block', () => {
  eq(emomSettings({}), null);
  eq(emomSettings({ emom: null }), null);
  eq(emomSettings({ emom: { rounds: 0 } }), null, 'zero rounds is not a block');
  eq(emomSettings({ emom: { rounds: 'five' } }), null, 'a bad field must not take the screen down');
  eq(emomBlock({}, [station('X', 10)], (i) => i.reps), null);
});

test('a block with no stations is not a block', () => {
  eq(emomBlock(emomDay(5, 60), [], (i) => i.reps), null, 'a clock with nothing on it is not a workout');
});

test('the window defaults to sixty seconds and a bad one does not', () => {
  eq(emomSettings({ emom: { rounds: 3 } }).windowSeconds, 60);
  eq(emomSettings({ emom: { rounds: 3, window_seconds: 90 } }).windowSeconds, 90);
  eq(emomSettings({ emom: { rounds: 3, window_seconds: 0 } }).windowSeconds, 60, 'a zero window would divide by nothing');
  eq(emomSettings({ emom: { rounds: 3, window_seconds: -5 } }).windowSeconds, 60);
});

test('Emma’s block is thirty windows and half an hour', () => {
  const block = emmaBlock();
  eq(block.minutes, 30, 'six stations, five rounds');
  eq(emomDurationMs(block), 30 * 60 * 1000);
  eq(emomLength(block), '5 rounds, 6 stations, 30 min');
});

test('the station rotates every window and the round rises with it', () => {
  const b = emmaBlock();
  const at = (min) => emomAt(b, min * 60 * 1000);

  eq(at(0).station.name, 'DB THRUSTERS', 'minute one');
  eq(at(0).round, 0);
  eq(at(1).station.name, 'ALT DB SNATCH', 'minute two, the next lift, not the next set of the same one');
  eq(at(5).station.name, 'JUMPING SQUATS', 'last station of round one');
  // The whole point of the shape: minute seven is back to the top, one round further on.
  eq(at(6).station.name, 'DB THRUSTERS', 'minute seven is round two, station one');
  eq(at(6).round, 1);
  eq(at(29).round, 4, 'the last window is round five');
  eq(at(29).station.name, 'JUMPING SQUATS');
});

test('the clock counts down inside a window and never reads a short minute', () => {
  const b = emmaBlock();
  eq(emomClock(emomAt(b, 0).remainingMs), '1:00', 'a window opens reading a full minute');
  eq(emomClock(emomAt(b, 1).remainingMs), '1:00', 'and one millisecond in, still a full minute');
  eq(emomClock(emomAt(b, 22_000).remainingMs), '0:38');
  eq(emomClock(emomAt(b, 59_500).remainingMs), '0:01');
  // Across a boundary the next window opens full again rather than continuing down.
  eq(emomClock(emomAt(b, 60_000).remainingMs), '1:00');
  eq(emomAt(b, 60_000).stationIndex, 1);
});

test('the block ends and stays on the lift that was actually last', () => {
  const b = emmaBlock();
  const end = emomAt(b, 30 * 60 * 1000);
  ok(end.done);
  eq(end.remainingMs, 0);
  eq(end.station.name, 'JUMPING SQUATS', 'not back at the top of the block');
  eq(end.round, 4);
  eq(emomAt(b, 40 * 60 * 1000).done, true, 'and long past the end it is still done');
  eq(emomAt(b, 40 * 60 * 1000).completed, 30, 'never more windows than the block has');
});

test('a window that has started is not a window that was done', () => {
  const b = emmaBlock();
  eq(emomAt(b, 0).completed, 0, 'standing in minute one is not having finished it');
  eq(emomAt(b, 59_999).completed, 0);
  eq(emomAt(b, 60_000).completed, 1, 'it counts the moment the window closes');
});

test('a clock set backwards does not throw underneath somebody mid workout', () => {
  const b = emmaBlock();
  const back = emomAt(b, -5000);
  eq(back.index, 0);
  eq(back.completed, 0);
  eq(emomClock(back.remainingMs), '1:00');
});

// The property the whole module exists for.
test('what is due depends on the time, never on how often it was asked', () => {
  const b = emmaBlock();
  const fourMinutes = 4 * 60 * 1000;

  // Asked once, four minutes in, having written nothing: all four finished windows come back.
  const inOneGo = emomDue(b, fourMinutes, 0);
  eq(inOneGo.length, 4, 'a locked phone comes back and writes what it missed');
  eq(inOneGo.map((m) => m.station.name).join(', '),
     'DB THRUSTERS, ALT DB SNATCH, TOE TAPS, MOUNTAIN CLIMBERS');

  // Asked every second from the start, writing as it goes: the same four windows, once each.
  const seen = [];
  let written = 0;
  for (let ms = 0; ms <= fourMinutes; ms += 1000) {
    for (const minute of emomDue(b, ms, written)) { seen.push(minute.index); written += 1; }
  }
  eq(seen.join(','), '0,1,2,3', 'no window written twice, none skipped');
  eq(written, inOneGo.length, 'and it lands in the same place as the single call');
});

test('nothing is due again once it is written', () => {
  const b = emmaBlock();
  eq(emomDue(b, 4 * 60 * 1000, 4).length, 0, 'four written, four elapsed, nothing owed');
  eq(emomDue(b, 4 * 60 * 1000, 9).length, 0, 'and more written than elapsed does not go backwards');
});

test('every window of the block is due exactly once across the whole run', () => {
  const b = emmaBlock();
  let written = 0;
  // Deliberately ragged: 7 second steps land inside windows and cross boundaries unevenly. The
  // bound clears the end by a whole window, because a 7 second step lands at 29:59 and the
  // thirtieth window has not closed there.
  for (let ms = 0; ms <= emomDurationMs(b) + b.windowMs; ms += 7000) written += emomDue(b, ms, written).length;
  eq(written, 30, 'thirty windows, thirty rows, whatever the sampling');
});

test('the start time is rebuilt from the rows, so a reload does not restart the clock', () => {
  const b = emmaBlock();
  const begun = Date.parse('2026-08-25T18:00:00.000Z');
  // Minute zero is written when the first window ENDS, so the first row is one window in.
  const rows = [
    { logged_at: '2026-08-25T18:01:00.000Z' },
    { logged_at: '2026-08-25T18:02:00.000Z' },
    { logged_at: '2026-08-25T18:03:00.000Z' },
  ];
  eq(emomStartedAt(b, rows), begun);
  eq(emomStartedAt(b, [...rows].reverse()), begun, 'the earliest row decides, not the first in the array');
});

test('the start time reads a synced timestamp as well as a local one', () => {
  const b = emmaBlock();
  // Postgres renders a space where toISOString writes a T, and six fractional digits where it
  // writes three. Both reach this module. The answer is still one window before the row.
  eq(
    emomStartedAt(b, [{ logged_at: '2026-08-25 18:01:00.048006+00' }]),
    Date.parse('2026-08-25T18:01:00.048Z') - 60_000,
  );
  eq(emomStartedAt(b, []), null, 'nothing written yet, so the caller holds the start');
  eq(emomStartedAt(b, [{ logged_at: 'not a time' }]), null, 'and a junk row does not become the epoch');
});

test('a rebuilt start lands the block back where it was', () => {
  const b = emmaBlock();
  const begun = Date.parse('2026-08-25T18:00:00.000Z');
  const rows = [];
  for (let n = 1; n <= 8; n += 1) rows.push({ logged_at: new Date(begun + n * 60_000).toISOString() });

  // Eight windows written, and it is now eight and a half minutes in.
  const started = emomStartedAt(b, rows);
  const now = begun + 8.5 * 60_000;
  const where = emomAt(b, now - started);
  eq(where.index, 8, 'minute nine, which is round two station three');
  eq(where.round, 1);
  eq(where.station.name, 'TOE TAPS');
  eq(emomDue(b, now - started, rows.length).length, 0, 'and nothing is owed twice after the reload');
});

test('a window longer than a minute still reads and rotates correctly', () => {
  const b = emomBlock(emomDay(3, 90), [station('A', 5), station('B', 5)], (i) => i.reps);
  eq(b.minutes, 6);
  eq(emomLength(b), '3 rounds, 2 stations, 9 min');
  eq(emomClock(emomAt(b, 0).remainingMs), '1:30');
  eq(emomAt(b, 90_000).station.name, 'B');
  eq(emomAt(b, 180_000).round, 1, 'two stations in, so back to the top');
});

test('a window that is not a whole number of minutes says its seconds', () => {
  const b = emomBlock(emomDay(4, 45), [station('A', 5), station('B', 5)], (i) => i.reps);
  eq(emomLength(b), '4 rounds, 2 stations, 6 min');
  const odd = emomBlock(emomDay(3, 50), [station('A', 5)], (i) => i.reps);
  eq(emomLength(odd), '3 rounds, 1 station, 2 min 30 sec');
});

// ------------------------------------------------------------ what the EMOM screen says

const emomUi = () => {
  const host = document.createElement('div');
  return { ui: mountEmomView(host), host };
};

test('the screen names the lift, the reps, the clock and what is coming', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 22_000, new Set());

  eq(ui.lift.textContent, 'DB THRUSTERS');
  eq(ui.reps.textContent, '12 reps');
  eq(ui.time.textContent, '0:38');
  eq(ui.next.textContent, 'Next: ALT DB SNATCH', 'so the last seconds are spent moving, not reading');
  ok(ui.where.textContent.includes('Round 1 of 5'));
  ok(ui.where.textContent.includes('Minute 1 of 30'));
});

test('the position counts the way a person counts', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 6 * 60_000, new Set());
  ok(ui.where.textContent.includes('Round 2 of 5'), 'minute seven is round two');
  ok(ui.where.textContent.includes('Minute 7 of 30'));
  eq(ui.lift.textContent, 'DB THRUSTERS', 'back to the top of the block');
});

test('the track empties as the window runs out', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 0, new Set());
  eq(ui.fill.style.width, '100%');
  drawEmom(ui, b, 30_000, new Set());
  eq(ui.fill.style.width, '50%');
  drawEmom(ui, b, 30 * 60_000, new Set());
  eq(ui.fill.style.width, '0%');
});

test('the last window says so rather than pointing at a station nobody is doing', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 29 * 60_000, new Set());
  eq(ui.next.textContent, 'Last one');
});

test('a finished block stops offering the control and says it is done', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 30 * 60_000, new Set());
  eq(ui.root.dataset.state, 'done');
  eq(ui.time.textContent, 'Done');
  eq(ui.where.textContent, '30 of 30 done');
  ok(ui.missed.hidden, 'nothing left to miss');
  eq(ui.next.textContent, '');
});

test('a window the client flagged keeps saying so while it is on screen', () => {
  const b = emmaBlock();
  const { ui } = emomUi();
  drawEmom(ui, b, 10_000, new Set());
  eq(ui.missed.textContent, 'Missed it');
  drawEmom(ui, b, 20_000, new Set([0]));
  eq(ui.missed.textContent, 'Marked short', 'the flag does not flicker back mid window');
  drawEmom(ui, b, 70_000, new Set([0]));
  eq(ui.missed.textContent, 'Missed it', 'and the next window starts clean');
});

test('the summary counts windows kept and grades nothing', () => {
  const b = emmaBlock();
  eq(emomSummary(b, 0), '5 rounds, all 30 windows');
  eq(emomSummary(b, 4), '5 rounds, 26 of 30 windows');
  // No percentage, no "you missed", no colour word. A shortfall is a count, per the no-guilt rule.
  ok(!/miss|fail|only|%/i.test(emomSummary(b, 4)));
});

test('a station with no rep count does not print an empty reps line', () => {
  const b = emomBlock(emomDay(2, 60), [station('ROW', 0)], (i) => i.reps);
  const { ui } = emomUi();
  drawEmom(ui, b, 0, new Set());
  eq(ui.reps.textContent, '');
});

test('a lift name carrying markup is escaped rather than rendered', () => {
  // Trainers type these, and an importer takes them from somebody else's spreadsheet.
  const b = emomBlock(emomDay(1, 60), [station('<b>SQUAT</b>', 5)], (i) => i.reps);
  const { ui, host } = emomUi();
  drawEmom(ui, b, 0, new Set());
  eq(ui.lift.textContent, '<b>SQUAT</b>');
  ok(!host.querySelector('b'), 'set as text, so markup in a name cannot reach the DOM');
});

// ------------------------------------------------------------------ report

await Promise.all(pending);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

const listEl = document.getElementById('results');
listEl.innerHTML = results
  .map(
    (r) =>
      `<li class="t ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'pass' : 'FAIL'}  ${r.name}${
        r.ok ? '' : `\n      ${r.error}`
      }</li>`,
  )
  .join('');

const summary = document.getElementById('summary');
summary.textContent = failed.length ? `${failed.length} failed, ${passed} passed` : `${passed} passed`;
summary.dataset.state = failed.length ? 'fail' : 'ok';

// Read by the browser tooling so a failure is never something anyone has to eyeball.
window.__testResults = { passed, failed: failed.length, failures: failed };
