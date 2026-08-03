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
