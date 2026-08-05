// Tests for js/history.js.
//
// This module decides every number the app shows: what the steppers prefill to, what counts
// toward a personal record, what a chart would plot. Everything it reads is append only, so
// the truth of a set is never in one row, it is in a chain of rows that supersede each other.
// The cases that matter are the ones where that chain is longer than two.
//
// No build step and no test runner, in line with the rest of the app. Open test.html.

import { activeSetLogs, lastPerformance, bestEstimated1rm, epley1rm } from './js/history.js';
import { holdTicks, nextHoldInterval, HOLD_DELAY_MS, HOLD_FLOOR_MS, HOLD_START_MS } from './js/hold.js';
import { openingWeight, openingCopy, EMPTY_BARBELL_KG } from './js/prefill.js';
import { buildProgression, evidenceLevel, weekIndexOf, MAX_LOAD_LINES, suggestDeloadWeeks } from './js/progression.js';
import { parseReps, parseRest, parseLoad, parseSets, parseGroup, inferLogging, targetLine } from './js/program.js';
import { toWire, fromWire, batchQueue } from './js/remote.js';

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
