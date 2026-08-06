// Fake data generator for step 1 of the build order: storage adapter plus seeded fake data,
// no backend. Everything here is invented. Nothing in this file ships to a real trainer.
//
// It produces one trainer, three clients, a shared exercise library, one program template
// with two days, an assignment per client with a frozen snapshot, and eight weeks of session
// and set_log history with enough shape that a progression chart has something to draw.
//
// Seed rows are written with the bulk path, which skips the outbox on purpose: fake data must
// never be pushed to a real remote once Supabase is attached.

import { makeRecord, newId, getDeviceId } from './storage.js';
import { epley1rm } from './history.js';
import { parseReps, parseRest, parseLoad, parseSets, inferLogging } from './program.js';
import { buildSnapshot } from './snapshot.js';

// Bump when the shape of the generated data changes, so devices holding the old fixture
// replace it instead of stacking a second one on top.
const SEED_VERSION = 6;
const SEED_META_KEY = 'seed';
const WEEKS = 8;
const SESSIONS_PER_WEEK = 2;

// Deterministic PRNG so two runs on the same day produce the same numbers. Record ids are
// still real crypto.randomUUID() values, as the schema requires.
function mulberry32(a) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRNG_SEED = 20260802;
let rand = mulberry32(PRNG_SEED);
const between = (lo, hi) => lo + rand() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));
const roundTo = (value, step) => Math.round(value / step) * step;

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function atTime(date, hours, minutes) {
  const next = new Date(date.getTime());
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function mostRecentMonday(from) {
  const date = new Date(from.getTime());
  date.setHours(0, 0, 0, 0);
  const shift = (date.getDay() + 6) % 7; // Sunday is 0, we want Monday as 0
  return addDays(date, -shift);
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const iso = (date) => date.toISOString();

// Fake but well formed, and on a domain reserved by RFC 2606 so a stray invite from a
// development database cannot reach a real inbox.
function fakeEmail(name) {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
}

// name, slug, primary_muscle, equipment, working weight for a reference lifter in kg,
// smallest load change the gym can actually make on this lift in kg, whether the lift gets a
// warmup set logged. That middle number is now stored on the exercise as increment_kg and is
// what the stepper moves by, so the app never offers a weight the equipment cannot hold.
const EXERCISE_LIBRARY = [
  ['Barbell Back Squat', 'barbell-back-squat', 'quadriceps', 'barbell', 80, 2.5, true],
  ['Barbell Bench Press', 'barbell-bench-press', 'chest', 'barbell', 60, 2.5, true],
  ['Barbell Deadlift', 'barbell-deadlift', 'hamstrings', 'barbell', 100, 2.5, true],
  ['Overhead Press', 'overhead-press', 'shoulders', 'barbell', 35, 2.5, true],
  ['Barbell Row', 'barbell-row', 'lats', 'barbell', 55, 2.5, true],
  ['Romanian Deadlift', 'romanian-deadlift', 'hamstrings', 'barbell', 70, 2.5, true],
  ['Lat Pulldown', 'lat-pulldown', 'lats', 'cable', 45, 5, false],
  ['Seated Cable Row', 'seated-cable-row', 'lats', 'cable', 45, 5, false],
  ['Dumbbell Incline Press', 'dumbbell-incline-press', 'chest', 'dumbbell', 22.5, 2.5, false],
  ['Leg Press', 'leg-press', 'quadriceps', 'machine', 130, 10, false],
  ['Face Pull', 'face-pull', 'rear delts', 'cable', 20, 2.5, false],
  ['Walking Lunge', 'walking-lunge', 'glutes', 'dumbbell', 16, 2, false],
];

// Written the way the trainer writes it, as spreadsheet cells, so the seed exercises the same
// parsing the builder and the importer use. Columns match their sheet exactly:
//   number, slug, adjust, sets, reps, load, rest, notes
const DAY_ONE = [
  ['1', 'barbell-bench-press', 'BARBELL', '3', '5-8', '1-2 RIR', '180 SEC', 'Elbows tucked about 45 degrees. Pause on the chest.'],
  ['2', 'barbell-row', 'BARBELL', '3', '6-10', '1-2 RIR', '150 SEC', 'Chest stays down. Pull to the bottom of the ribcage.'],
  ['3', 'overhead-press', 'BARBELL', '3', '6-10', '1-2 RIR', '150 SEC', 'Squeeze the glutes, ribs down.'],
  ['4', 'lat-pulldown', 'MED GRIP', '3', '8-12', '1 RIR', '90 SEC', 'Last set to two reps in reserve.'],
];

const DAY_TWO = [
  ['1', 'barbell-back-squat', 'BARBELL', '3', '5-8', '1-2 RIR', '210 SEC', 'Full depth or stop the set. Depth over load.'],
  ['2', 'romanian-deadlift', 'DUMBELL', '3', '6-10', '1-2 RIR', '150 SEC', 'Stop when the hamstrings run out, not when the bar hits the floor.'],
  ['3', 'leg-press', 'MACHINE', '3', '10-15', '1 RIR', '120 SEC', 'Slow on the way down, three seconds.'],
  ['4', 'face-pull', 'CABLE', '3', '12-15', '1 RIR', '60 SEC', 'Light. This is for the shoulders staying healthy.'],
];

// The two day headers, matching the shape of a real sheet.
const DAY_META = [
  {
    day_type: 'STRENGTH',
    split: 'UPPER A',
    warmup: {
      mobility: ['BANDED ARM CIRCLES X10', 'MAX DEAD HANG X2'],
      general: ['BANDED PULL APARTS X15', 'INCLINE PUSH UPS X10'],
      specific: ['STRETCH/PRIME MUSCLES', 'PREPARE JOINTS', 'INCREASE BODY TEMP'],
    },
  },
  {
    day_type: 'STRENGTH',
    split: 'LOWER A',
    warmup: {
      mobility: ['DEEP SQUAT HOLD 30 SEC', 'HIP WIPERS X10'],
      general: ['BANDED WALKS X20', 'STANDING CALF RAISE X20'],
      specific: ['PREPARE JOINTS', 'INCREASE BODY TEMP'],
    },
  },
];

// Two trainers, each with their own clients and their own program. The second one exists so
// the trainer view has a neighbour to be isolated from, and so that isolation is something a
// person can see rather than only something the RLS test asserts.
//
// profile picks the progression model in prescribe(). novice moves the bar every week,
// intermediate holds it and earns reps. isDefault is the client the logging screen opens as.
const TRAINERS = [
  {
    name: 'Robin Sayers',
    brandColor: '#ff8a45',
    isDefault: true,
    clients: [
      {
        name: 'Dana Whitfield',
        profile: 'intermediate',
        strength: 1.15,
        adherence: 0.9,
        weeks: 8,
        unit: 'kg',
        blockGain: 0.03, // estimated 1RM across the whole eight weeks, not per week
        stallWeek: 4,
        deloadWeek: 6,
        isDefault: true,
      },
      { name: 'Marcus Bell', profile: 'novice', strength: 0.95, adherence: 0.81, weeks: 8, weeklyGain: 0.013, unit: 'lb' },
      { name: 'Priya Raman', profile: 'novice', strength: 0.68, adherence: 0.88, weeks: 5, weeklyGain: 0.022, unit: 'kg' },
    ],
  },
  {
    name: 'Nadia Okonkwo',
    brandColor: '#6dd0e4',
    isDefault: false,
    clients: [
      {
        name: 'Theo Marchetti',
        profile: 'intermediate',
        strength: 1.35,
        adherence: 0.95,
        weeks: 8,
        unit: 'kg',
        blockGain: 0.02,
        stallWeek: 3,
        deloadWeek: 6,
      },
      { name: 'Aisha Fournier', profile: 'novice', strength: 0.72, adherence: 0.86, weeks: 6, weeklyGain: 0.019, unit: 'kg' },
    ],
  },
];

// How many weeks have actually moved by the end of a given week. The stall week and the
// deload week contribute nothing, which is what makes the curve flatten in the right places.
function progressIndex(spec, week) {
  let moved = 0;
  for (let w = 1; w <= week; w += 1) {
    if (w !== spec.stallWeek && w !== spec.deloadWeek) moved += 1;
  }
  return moved;
}

/**
 * What the client is actually going to do this week for one exercise.
 *
 * The novice model moves the bar every week with noise on top, which is roughly true for
 * someone in their first months and produces the flattering curve.
 *
 * The intermediate model is the one worth designing against. A lifter at a 105 kg estimated
 * squat 1RM gaining 3 percent over eight weeks earns about 3 kg. The smallest jump available
 * on the rack is 2.5 kg, which is more than half of that, so almost all of the progress shows
 * up as reps at an unchanged load. That is the hard case for a chart: the number on the bar
 * does not move for weeks at a time, and the client still has to see that something happened.
 * So the load is held and the target reps are solved backwards out of Epley to hit the block
 * gain, stepping the bar up only when reps top out the prescribed range.
 */
function prescribe(spec, config, item, week) {
  const low = item.target_reps_low;
  const high = item.target_reps_high ?? low;
  const baseWeight = Math.max(config.step, roundTo(config.base * spec.strength, config.step));

  if (spec.profile !== 'intermediate') {
    const target = config.base * spec.strength * (1 + spec.weeklyGain) ** week;
    return {
      weight: Math.max(config.step, roundTo(target * between(0.97, 1.03), config.step)),
      topReps: intBetween(low, high),
      phase: 'work',
    };
  }

  // Planned back off week. Load drops to 80 percent, reps stay easy, RPE stays low.
  if (week === spec.deloadWeek) {
    return {
      weight: Math.max(config.step, roundTo(baseWeight * 0.8, config.step)),
      topReps: low + 1,
      phase: 'deload',
    };
  }

  const total = progressIndex(spec, WEEKS - 1);
  const fraction = total ? progressIndex(spec, week) / total : 0;
  const targetE1rm = epley1rm(baseWeight, low) * (1 + spec.blockGain * fraction);

  // Hold the bar and let reps climb. Take one step up only once reps run past the range.
  let weight = baseWeight;
  let reps = Math.round(30 * (targetE1rm / weight - 1));
  while (reps > high) {
    weight += config.step;
    reps = Math.round(30 * (targetE1rm / weight - 1));
  }

  return {
    weight,
    topReps: Math.max(low, Math.min(high, reps)),
    phase: week === spec.stallWeek ? 'stall' : 'work',
  };
}

export async function isSeeded(storage) {
  const meta = await storage.getMeta(SEED_META_KEY);
  return Boolean(meta && meta.version === SEED_VERSION);
}

/** The client the logging screen opens as. The intermediate, on purpose. */
export async function getDefaultClientId(storage) {
  const meta = await storage.getMeta(SEED_META_KEY);
  return meta ? meta.default_client_id : null;
}

/**
 * Writes the full fixture. Pass { force: true } to wipe the database first.
 * Returns a summary of what was written.
 */
export async function seed(storage, { force = false } = {}) {
  if (await isSeeded(storage)) {
    if (!force) return { skipped: true };
    await storage._clearAll();
  } else {
    // Either empty, or holding a fixture from an older seed version. Both want a clean slate.
    await storage._clearAll();
  }

  // Rewind the generator so a reseed inside one page load matches a reseed after a reload.
  rand = mulberry32(PRNG_SEED);

  const deviceId = getDeviceId();
  const today = new Date();
  // Eight complete weeks ending last Sunday. Anchoring the block on today instead would cut
  // the final week in half, and whichever day fell after today would silently vanish from the
  // chart, which is how you end up designing against a block that ends on a deload.
  const week0Monday = addDays(mostRecentMonday(today), -7 * WEEKS);
  const seededAt = iso(addDays(week0Monday, -1));

  const trainers = [];
  const clients = [];
  const templates = [];
  const days = [];
  const items = [];
  const assignments = [];
  const sessions = [];
  const setLogs = [];

  // Shared exercise library. trainer_id null and is_global true means anyone can use it.
  const exercises = EXERCISE_LIBRARY.map(([name, slug, muscle, equipment, , step]) =>
    makeRecord(
      'exercises',
      {
        trainer_id: null,
        name,
        slug,
        primary_muscle: muscle,
        equipment,
        media_url: null,
        is_global: true,
        increment_kg: step,
      },
      { created_at: seededAt },
    ),
  );

  const bySlug = Object.fromEntries(exercises.map((row) => [row.slug, row]));
  const configBySlug = Object.fromEntries(
    EXERCISE_LIBRARY.map(([, slug, , , base, step, warmup]) => [slug, { base, step, warmup }]),
  );

  // Everything below is per trainer. Each gets their own template, their own clients, and
  // their own history, so one trainer's view has a neighbour it must never reach into.
  for (const tspec of TRAINERS) {
  const trainer = makeRecord(
    'trainers',
    {
      auth_user_id: null,
      display_name: tspec.name,
      brand_color: tspec.brandColor,
      logo_url: null,
      weight_unit: 'kg',
    },
    { created_at: seededAt },
  );
  trainers.push(trainer);

  const trainerClients = tspec.clients.map((spec) =>
    makeRecord(
      'clients',
      {
        trainer_id: trainer.id,
        auth_user_id: null,
        display_name: spec.name,
        email: fakeEmail(spec.name),
        status: 'active',
        weight_unit: spec.unit,
      },
      { created_at: seededAt },
    ),
  );
  clients.push(...trainerClients);

  const template = makeRecord(
    'program_templates',
    {
      trainer_id: trainer.id,
      name: 'Foundations, two days',
      notes: 'Two full body days with an upper bias and a lower bias. Add load before adding sets.',
      archived_at: null,
    },
    { created_at: seededAt },
  );
  templates.push(template);

  const trainerDays = [0, 1].map((dayIndex) =>
    makeRecord(
      'template_days',
      {
        template_id: template.id,
        day_index: dayIndex,
        name: DAY_META[dayIndex].split,
        day_type: DAY_META[dayIndex].day_type,
        split: DAY_META[dayIndex].split,
        warmup: DAY_META[dayIndex].warmup,
        comments: '',
      },
      { created_at: seededAt },
    ),
  );
  days.push(...trainerDays);

  const trainerItems = [];
  [DAY_ONE, DAY_TWO].forEach((plan, dayIndex) => {
    plan.forEach(([number, slug, adjust, sets, reps, load, rest, notes], orderIndex) => {
      // Parsed the same way a pasted spreadsheet row would be, so the seed and the importer
      // cannot drift apart.
      const parsedReps = parseReps(reps);
      const parsedLoad = parseLoad(load);
      const parsedSets = parseSets(sets);
      const logging = inferLogging({ repsText: reps, loadText: load, sets: parsedSets });

      trainerItems.push(
        makeRecord(
          'template_items',
          {
            day_id: trainerDays[dayIndex].id,
            exercise_id: bySlug[slug].id,
            order_index: orderIndex,
            group_label: number,
            variation: adjust,
            target_sets: parsedSets,
            target_reps_low: parsedReps.low,
            target_reps_high: parsedReps.high,
            target_reps_text: parsedReps.text,
            target_load: parsedLoad.text,
            target_rpe: parsedLoad.rpe,
            rest_seconds: parseRest(rest),
            notes,
            // Blank on purpose almost everywhere, because a real trainer prescribes effort and
            // never a weight. js/prefill.js answers for the first session and history answers
            // after that.
            starting_weight_kg: null,
            is_logged: logging.isLogged,
            log_mode: logging.logMode,
          },
          { created_at: seededAt },
        ),
      );
    });
  });
  items.push(...trainerItems);

  // The snapshot freezes the program as assigned. Editing the template later must not rewrite
  // what a client was already told to do. Built by the same function a real assignment will use,
  // so the fake data cannot drift into a shape the app never actually sees.
  const snapshot = buildSnapshot({
    template,
    days: trainerDays,
    items: trainerItems,
    exercises,
  });

  trainerClients.forEach((client, clientIndex) => {
    const spec = tspec.clients[clientIndex];
    const firstWeek = WEEKS - spec.weeks;
    const startsOn = addDays(week0Monday, firstWeek * 7);

    assignments.push(
      makeRecord(
        'assignments',
        {
          client_id: client.id,
          template_id: template.id,
          snapshot,
          starts_on: isoDate(startsOn),
          ends_on: null,
          // The generator already produces a real deload at this week, so the trainer marking
          // describes something that actually happened rather than inventing a label.
          deload_weeks: spec.deloadWeek === undefined ? [] : [spec.deloadWeek - firstWeek],
        },
        { created_at: iso(atTime(startsOn, 8, 5)) },
      ),
    );
    const assignment = assignments[assignments.length - 1];

    for (let week = firstWeek; week < WEEKS; week += 1) {
      for (let dayIndex = 0; dayIndex < SESSIONS_PER_WEEK; dayIndex += 1) {
        // A missed session is normal. No streak logic anywhere, this is just realistic data.
        if (rand() > spec.adherence) continue;

        const dayOffset = dayIndex === 0 ? 0 : 3; // Monday and Thursday
        const date = addDays(week0Monday, week * 7 + dayOffset);
        if (date > today) continue;

        const startedAt = atTime(date, intBetween(17, 18), intBetween(0, 55));
        // A session logged in a basement with no signal is written locally right away and
        // reaches the outbox later. created_at then trails logged_at by hours.
        const offlineSession = rand() < 0.15;
        const writeDelayMs = offlineSession ? intBetween(3, 9) * 3600 * 1000 : 0;

        const dayItems = trainerItems
          .filter((item) => item.day_id === trainerDays[dayIndex].id)
          .sort((a, b) => a.order_index - b.order_index);

        let cursorMs = startedAt.getTime();
        const sessionId = newId();
        const sessionLogs = [];

        for (const item of dayItems) {
          const exercise = exercises.find((ex) => ex.id === item.exercise_id);
          const config = configBySlug[exercise.slug];

          const plan = prescribe(spec, config, item, week);
          const working = plan.weight;

          let setIndex = 0;
          if (config.warmup) {
            cursorMs += intBetween(60, 120) * 1000;
            sessionLogs.push({
              session_id: sessionId,
              exercise_id: exercise.id,
              set_index: setIndex,
              weight_kg: Math.max(config.step, roundTo(working * 0.55, config.step)),
              reps: 8,
              rpe: null,
              is_warmup: true,
              logged_at: iso(new Date(cursorMs)),
              supersedes_id: null,
              is_void: false,
              is_extra: false,
              rounds: null,
              hold_seconds: null,
              device_id: deviceId,
            });
            setIndex += 1;
          }

          for (let s = 0; s < item.target_sets; s += 1, setIndex += 1) {
            // The top set carries the prescription. Later sets bleed a rep as fatigue builds,
            // which is why a progression chart reads the best set of a session, not the last.
            const reps = Math.max(1, plan.topReps - (s === 0 ? 0 : intBetween(0, 1)));
            const rpe =
              plan.phase === 'deload'
                ? Math.min(10, roundTo(between(5.5, 6.5) + s * 0.25, 0.5))
                : Math.min(10, roundTo(between(6.5, 8) + s * 0.5, 0.5));

            cursorMs += (item.rest_seconds + intBetween(30, 70)) * 1000;
            sessionLogs.push({
              session_id: sessionId,
              exercise_id: exercise.id,
              set_index: setIndex,
              weight_kg: working,
              reps,
              rpe,
              is_warmup: false,
              logged_at: iso(new Date(cursorMs)),
              supersedes_id: null,
              is_void: false,
              is_extra: false,
              rounds: null,
              hold_seconds: null,
              device_id: deviceId,
            });
          }
        }

        const completedAt = new Date(cursorMs + intBetween(60, 240) * 1000);

        sessions.push(
          makeRecord(
            'sessions',
            {
              client_id: client.id,
              assignment_id: assignment.id,
              day_index: dayIndex,
              started_at: iso(startedAt),
              completed_at: iso(completedAt),
              client_note: rand() < 0.2 ? pickNote() : null,
            },
            { id: sessionId, created_at: iso(new Date(startedAt.getTime() + writeDelayMs)) },
          ),
        );

        for (const log of sessionLogs) {
          setLogs.push(
            makeRecord('set_logs', log, {
              created_at: iso(new Date(Date.parse(log.logged_at) + writeDelayMs)),
            }),
          );
        }
      }
    }
  });
  }

  // One correction, so the append only path has a worked example in the data. The original
  // row stays. The correction is a new row pointing at it. Anything that reads set_logs has
  // to exclude rows that have been superseded.
  const correctable = setLogs.filter((log) => !log.is_warmup);
  if (correctable.length) {
    const original = correctable[Math.floor(correctable.length * 0.4)];
    setLogs.push(
      makeRecord(
        'set_logs',
        {
          session_id: original.session_id,
          exercise_id: original.exercise_id,
          set_index: original.set_index,
          weight_kg: original.weight_kg,
          reps: original.reps + 1, // miscounted a rep in the moment
          rpe: original.rpe,
          is_warmup: false,
          logged_at: original.logged_at,
          supersedes_id: original.id,
          is_void: false, // a correction, not a retraction: the set happened, the count was wrong
          is_extra: false,
          rounds: null,
          hold_seconds: null,
          device_id: deviceId,
        },
        { created_at: iso(new Date(Date.parse(original.created_at) + 90 * 1000)) },
      ),
    );
  }

  await storage._bulkPut('trainers', trainers);
  await storage._bulkPut('exercises', exercises);
  await storage._bulkPut('clients', clients);
  await storage._bulkPut('program_templates', templates);
  await storage._bulkPut('template_days', days);
  await storage._bulkPut('template_items', items);
  await storage._bulkPut('assignments', assignments);
  await storage._bulkPut('sessions', sessions);
  await storage._bulkPut('set_logs', setLogs);

  // The logging screen renders against the intermediate by default. Designing the chart and the
  // set prefill against the flattering novice curve is how you ship something that looks great
  // in dev and underwhelms the client who needs it most.
  const defaultTrainerIndex = Math.max(0, TRAINERS.findIndex((t) => t.isDefault));
  const defaultTrainer = trainers[defaultTrainerIndex];
  const defaultClientSpecs = TRAINERS[defaultTrainerIndex].clients;
  const defaultClientName = (defaultClientSpecs.find((c) => c.isDefault) ?? defaultClientSpecs[0]).name;
  const defaultClient = clients.find(
    (c) => c.trainer_id === defaultTrainer.id && c.display_name === defaultClientName,
  );

  await storage.setMeta(SEED_META_KEY, {
    version: SEED_VERSION,
    seeded_at: iso(new Date()),
    trainer_ids: trainers.map((t) => t.id),
    default_trainer_id: defaultTrainer.id,
    client_ids: clients.map((c) => c.id),
    default_client_id: defaultClient.id,
  });

  return {
    skipped: false,
    trainers: trainers.length,
    clients: clients.length,
    exercises: exercises.length,
    program_templates: templates.length,
    template_days: days.length,
    template_items: items.length,
    assignments: assignments.length,
    sessions: sessions.length,
    set_logs: setLogs.length,
  };
}

const NOTES = [
  'Left shoulder felt tight on the first set, fine after.',
  'Short on sleep, kept the load the same.',
  'Best that bar has ever felt.',
  'Gym was packed, cut rest short on the last lift.',
];

function pickNote() {
  return NOTES[intBetween(0, NOTES.length - 1)];
}

