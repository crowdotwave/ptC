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
  isBodyweightLoad,
} from './js/program.js';
import { buildSnapshot, pickDay, sortedDays, sortedItems, dayTitle } from './js/snapshot.js';
import { renderProgram, dayLoad, loadLine, groupItems } from './js/program-view.js';
import { toWire, fromWire, batchQueue, collapseDuplicates } from './js/remote.js';
import { readSheet, mapColumns, dayName, summarise } from './js/import-program.js';
import { can } from './js/boot.js';
import { tokenFromLink } from './js/auth.js';
import { validate } from './js/schema.js';
import { isoDate, localDayOf, monthKey, localMidnight } from './js/dates.js';
import { buildConsistency, splitGlyphs, SPLIT_SLOTS } from './js/consistency.js';
import { planForItem, setCountOf, countOf } from './js/plan.js';
import { openSession, replaySession, RESUME_WINDOW_MS } from './js/session.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
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
     { isLogged: true, logMode: 'weight_reps' });
});

// A carry or a sled: the load is the whole point and there are no reps to count.
test('a distance with a load logs weight only', () => {
  eq(inferLogging({ repsText: '50 FT', loadText: '2 PLATES', sets: 3 }),
     { isLogged: true, logMode: 'weight_only' });
  eq(inferLogging({ repsText: '400M', loadText: 'N/A', sets: 3 }),
     { isLogged: true, logMode: 'weight_only' });
});

// A running interval has no sets, no reps, and a duration in the Load cell. There is nothing
// to measure, so nothing is asked for.
test('a cardio interval is not logged at all', () => {
  eq(inferLogging({ repsText: 'N/A', loadText: '3 MINS', sets: null }),
     { isLogged: false, logMode: 'weight_reps' });
  eq(inferLogging({ repsText: 'N/A', loadText: '1 MINUTE', sets: null }),
     { isLogged: false, logMode: 'weight_reps' });
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
  const history = new Map([['squat', { weightKg: 100, reps: 5, on: '2026-07-27T18:00:00.000Z' }]]);
  const html = renderProgram(view(), 0, history);
  ok(/Top set last time 100 kg for 5, Jul 27/.test(html), html);
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
     { isLogged: true, logMode: 'time_hold' });
  eq(inferLogging({ repsText: '45 SEC', loadText: 'BW', sets: 3 }),
     { isLogged: true, logMode: 'time_hold' });
  eq(inferLogging({ repsText: '10 MINS', loadText: '5-7 SPEED', sets: null }).logMode,
     'weight_only', 'a ten minute block is not a hold');
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
     { isLogged: true, logMode: 'bodyweight_reps' });
  eq(inferLogging({ repsText: '12', loadText: '1 RIR', sets: 3 }),
     { isLogged: true, logMode: 'weight_reps' });
});

// AMRAP in the Reps column is one exercise taken to failure, so it is a rep count the client
// discovers. It is not the rounds mode, which is a circuit.
test('AMRAP is a rep count to discover, not a circuit', () => {
  eq(inferLogging({ repsText: 'AMRAP', loadText: 'BODY WEIGHT', sets: 1 }),
     { isLogged: true, logMode: 'bodyweight_reps' });
  eq(inferLogging({ repsText: 'AMRAP', loadText: '1 RIR', sets: 1 }),
     { isLogged: true, logMode: 'weight_reps' });
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

// ------------------------------------------------------------------ signing in on a home screen
//
// On iOS a home screen web app has its own storage container, separate from Safari's. A magic
// link tapped in Mail opens Safari, so the session is created there and the app the person
// actually trains with is still signed out. Nothing in the web platform routes a link into that
// container, so the link is pasted in instead and its token exchanged here.

test('a token is pulled out of a pasted sign in link', () => {
  const link = 'https://abc.supabase.co/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=https%3A%2F%2Fexample.com%2F';
  eq(tokenFromLink(link), { tokenHash: 'pkce_abc123', type: 'magiclink' });
});

// The type is read from the link rather than assumed, because a first sign in is a signup and a
// later one is a magiclink, and sending the wrong one is rejected.
test('the link carries its own type and that is what is used', () => {
  eq(tokenFromLink('https://abc.supabase.co/auth/v1/verify?token=h&type=signup').type, 'signup');
  eq(tokenFromLink('https://abc.supabase.co/auth/v1/verify?token=h&type=email').type, 'email');
  eq(tokenFromLink('https://abc.supabase.co/auth/v1/verify?token=h').type, 'email', 'a sane default');
});

test('the newer token_hash spelling works alongside the older token one', () => {
  eq(tokenFromLink('https://x.test/auth/confirm?token_hash=abc&type=email').tokenHash, 'abc');
  eq(tokenFromLink('https://x.test/auth/confirm?token=abc&type=email').tokenHash, 'abc');
});

// A redirect can leave the parameters in the fragment rather than the query.
test('a token in the fragment is found too', () => {
  eq(tokenFromLink('https://x.test/auth/confirm#token_hash=frag123&type=magiclink'),
     { tokenHash: 'frag123', type: 'magiclink' });
});

test('a bare hash pasted without its url still works', () => {
  eq(tokenFromLink('pkce_abc123'), { tokenHash: 'pkce_abc123', type: 'email' });
});

test('anything that is not a sign in link is refused rather than half read', () => {
  eq(tokenFromLink(''), null);
  eq(tokenFromLink('   '), null);
  eq(tokenFromLink(null), null);
  eq(tokenFromLink('https://example.com/no/token/here'), null, 'a url with no token is not a link');
  eq(tokenFromLink('not a url at all?'), null);
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

test('a skipped lift stays skipped', () => {
  const back = replaySession(planOf(), [
    done({ id: 'a', exercise_id: 'bench', set_index: 0, logged_at: '2026-08-09T18:20:00.000Z' }),
  ]);
  eq(back.cursor, 4, 'squat was passed over, so the cursor is on the second set of bench');
  eq(back.plan[back.cursor].item.exercise_id, 'bench');
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

// ------------------------------------------------------------------ report

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
