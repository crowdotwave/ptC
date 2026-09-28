// Builds the shared exercise library, migrations/0019_exercise_library.sql, from free-exercise-db.
//
//   curl -sL -o free-exercise-db.json \
//     https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json
//   node supabase/library/build.mjs free-exercise-db.json
//
// Why a library at all: a client who swaps bench press for machine press needs somewhere to pick
// machine press from, and a trainer should not have to type every lift into a program before anybody
// can train on it. The rows are `is_global` with no trainer, which the exercises_select policy
// already lets every trainer and client read, and which exercises_trainer_write refuses to let
// anybody edit. So the library is only ever changed by a migration like this one.
//
// free-exercise-db is Unlicense (see CLAUDE.md, licensing). Only names, muscles and equipment are
// taken. The images are not: their provenance is an open question upstream.
//
// What this does to the source, and why:
//   - Stretches and foam rolling are left out. Nothing about them is logged as weight and reps, and
//     123 of them would bury the lifts. Cardio, plyometrics and strongman stay in.
//   - Names are tidied where the source reads like an index rather than like a gym ("Rowing,
//     Stationary", "Pullups", "Barbell Bench Press - Medium Grip"). RENAMES is every one of those.
//   - Lifts people program every day that the source does not have are added. ADDITIONS is the list.
//   - Ids are derived from the slug, so running the migration twice, or rebuilding it after a name
//     elsewhere changes, never makes a second copy of a lift.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source) throw new Error('Pass the path to free-exercise-db exercises.json.');
const here = new URL('./', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

// The source's name on the left, the name a client reads on the right.
const RENAMES = {
  'Barbell Bench Press - Medium Grip': 'Barbell Bench Press',
  'Barbell Incline Bench Press - Medium Grip': 'Barbell Incline Bench Press',
  'Rowing, Stationary': 'Rowing Machine',
  'Running, Treadmill': 'Treadmill Run',
  'Jogging, Treadmill': 'Treadmill Jog',
  'Walking, Treadmill': 'Treadmill Walk',
  'Bicycling, Stationary': 'Stationary Bike',
  Bicycling: 'Cycling',
  Stairmaster: 'Stair Climber',
  'Rope Jumping': 'Jump Rope',
  'Trail Running/Walking': 'Trail Run',
  'Box Jump (Multiple Response)': 'Box Jump',
  Pullups: 'Pull-Up',
  Pushups: 'Push-Up',
  'Weighted Pull Ups': 'Weighted Pull-Up',
  Crunches: 'Crunch',
  'Hammer Curls': 'Hammer Curl',
  'Leg Extensions': 'Leg Extension',
  'Lying Leg Curls': 'Lying Leg Curl',
  'Seated Cable Rows': 'Seated Cable Row',
  'Standing Calf Raises': 'Standing Calf Raise',
  'Donkey Calf Raises': 'Donkey Calf Raise',
  'Hyperextensions (Back Extensions)': 'Back Extension',
  'Thigh Abductor': 'Hip Abduction Machine',
  'Thigh Adductor': 'Hip Adduction Machine',
  Butterfly: 'Pec Deck Fly',
  'Dips - Chest Version': 'Chest Dip',
  'Dips - Triceps Version': 'Triceps Dip',
  'Triceps Pushdown - Rope Attachment': 'Rope Triceps Pushdown',
  'Triceps Pushdown - V-Bar Attachment': 'V-Bar Triceps Pushdown',
  'Cable Hammer Curls - Rope Attachment': 'Cable Rope Hammer Curl',
  'One-Arm Kettlebell Swings': 'One-Arm Kettlebell Swing',
  'Tricep Dumbbell Kickback': 'Dumbbell Triceps Kickback',
  'Front Squat (Clean Grip)': 'Front Squat',
  'Front Squats With Two Kettlebells': 'Double Kettlebell Front Squat',
  'Split Squat with Dumbbells': 'Dumbbell Split Squat',
  'Dumbbell Lunges': 'Dumbbell Lunge',
  'Concentration Curls': 'Concentration Curl',
  'Machine Preacher Curls': 'Machine Preacher Curl',
  'Reverse Barbell Preacher Curls': 'Reverse Barbell Preacher Curl',
  'Narrow Stance Hack Squats': 'Narrow Stance Hack Squat',
  'Narrow Stance Squats': 'Narrow Stance Squat',
  'Zercher Squats': 'Zercher Squat',
  'Speed Squats': 'Speed Squat',
  'Jefferson Squats': 'Jefferson Squat',
  'One-Arm Overhead Kettlebell Squats': 'One-Arm Overhead Kettlebell Squat',
};

// Programmed every day and absent from the source. [name, primary muscle, equipment, category]
const ADDITIONS = [
  ['Kettlebell Swing', 'hamstrings', 'kettlebells', 'strength'],
  ['Burpee', 'quadriceps', 'body only', 'cardio'],
  ['Wall Ball', 'quadriceps', 'medicine ball', 'strength'],
  ['Ski Erg', 'lats', 'machine', 'cardio'],
  ['Assault Bike', 'quadriceps', 'machine', 'cardio'],
  ['Sled Pull', 'hamstrings', 'other', 'strongman'],
  ['Incline Treadmill Walk', 'calves', 'machine', 'cardio'],
  ['Walking Lunge', 'quadriceps', 'dumbbell', 'strength'],
  ['Bulgarian Split Squat', 'quadriceps', 'dumbbell', 'strength'],
  ['Lat Pulldown', 'lats', 'cable', 'strength'],
  ['Leg Curl', 'hamstrings', 'machine', 'strength'],
  ['Hip Thrust Machine', 'glutes', 'machine', 'strength'],
  ['Chest Supported Row', 'middle back', 'dumbbell', 'strength'],
  ['Seated Machine Row', 'middle back', 'machine', 'strength'],
  ['Machine Chest Press', 'chest', 'machine', 'strength'],
  ['Machine Shoulder Press', 'shoulders', 'machine', 'strength'],
  ['Cable Lateral Raise', 'shoulders', 'cable', 'strength'],
  ['Cable Glute Kickback', 'glutes', 'cable', 'strength'],
  ['Dumbbell Romanian Deadlift', 'hamstrings', 'dumbbell', 'strength'],
  ['Dumbbell Hip Thrust', 'glutes', 'dumbbell', 'strength'],
  ['Incline Dumbbell Row', 'middle back', 'dumbbell', 'strength'],
  ['Pendlay Row', 'middle back', 'barbell', 'strength'],
  ['Dead Hang', 'forearms', 'body only', 'strength'],
  ['Hollow Body Hold', 'abdominals', 'body only', 'strength'],
  ['L-Sit', 'abdominals', 'body only', 'strength'],
  ['Pistol Squat', 'quadriceps', 'body only', 'strength'],
  ['Nordic Hamstring Curl', 'hamstrings', 'body only', 'strength'],
  ['Copenhagen Plank', 'adductors', 'body only', 'strength'],
  ['Medicine Ball Slam', 'abdominals', 'medicine ball', 'strength'],
  ['Devil Press', 'shoulders', 'dumbbell', 'strength'],
];

// The source's equipment words in the app's vocabulary. `barbell` is the one the app acts on: a
// first set with no starting weight opens on the empty bar. An EZ bar is not that bar.
const EQUIPMENT = {
  barbell: 'barbell',
  'e-z curl bar': 'ez bar',
  dumbbell: 'dumbbell',
  kettlebells: 'kettlebell',
  cable: 'cable',
  machine: 'machine',
  bands: 'band',
  'body only': 'bodyweight',
  'medicine ball': 'medicine ball',
  'exercise ball': 'exercise ball',
  other: 'other',
};

// The smallest change each can actually make, in kilograms. The stepper reads it, so this is the
// difference between offering a weight the gym has and one it does not. A trainer's own lift can
// always say otherwise.
const INCREMENT_KG = { barbell: 2.5, 'ez bar': 2.5, dumbbell: 2.5, kettlebell: 4, cable: 2.5, machine: 5 };

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// A name based uuid (version 5 layout) under a namespace of this library's own, so an id is a pure
// function of the slug and never collides with the random ones the app writes.
function idOf(slug) {
  const h = createHash('sha1').update('ptc-exercise-library:' + slug).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const raw = JSON.parse(readFileSync(source, 'utf8'));
const kept = raw
  .filter((e) => e.category !== 'stretching' && e.equipment !== 'foam roll')
  .map((e) => ({
    name: RENAMES[e.name] ?? e.name,
    muscle: e.primaryMuscles?.[0] ?? 'unspecified',
    equipment: e.equipment ?? 'other',
    category: e.category,
  }));
const added = ADDITIONS.map(([name, muscle, equipment, category]) => ({ name, muscle, equipment, category }));

const unusedRenames = Object.keys(RENAMES).filter((from) => !raw.some((e) => e.name === from));
if (unusedRenames.length) throw new Error('Renames that match nothing in the source: ' + unusedRenames.join(', '));

const rows = [];
const seen = new Map();
for (const e of [...kept, ...added]) {
  const slug = slugOf(e.name);
  if (seen.has(slug)) throw new Error(`Two lifts would read "${e.name}" (slug ${slug}), from "${seen.get(slug)}"`);
  seen.set(slug, e.name);
  const equipment = EQUIPMENT[e.equipment] ?? 'other';
  rows.push({
    id: idOf(slug),
    name: e.name,
    slug,
    primary_muscle: e.muscle,
    equipment,
    increment_kg: INCREMENT_KG[equipment] ?? 2.5,
  });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const values = rows.map((r) => `  (${q(r.name)}, ${q(r.primary_muscle)}, ${q(r.equipment)})`).join(',\n');
const increments = Object.entries(INCREMENT_KG).map(([eq, kg]) => `when ${q(eq)} then ${kg}`).join(' ');

// The slug, the id and the increment are derived in SQL by the same rules slugOf, idOf and
// INCREMENT_KG apply above, so the file carries only what a person would read and check. The script
// computes them too, and prints a fingerprint of every row to compare against the database after.
const sql = `-- The shared exercise library. Generated by supabase/library/build.mjs from free-exercise-db
-- (Unlicense), and not to be edited by hand: change the script and run it again.
--
-- ${rows.length} lifts, cardio included, stretches left out. Global rows carry no trainer, so every
-- trainer and client can read them (exercises_select) and nobody can edit them over the API
-- (exercises_trainer_write requires a trainer). A trainer's own lift of the same name is theirs and
-- is unaffected: the builder resolves a typed name to the trainer's own row first.
--
-- Each id is a name based uuid of the slug, so this is safe to run again: a lift already here is
-- left alone, and the same lift always lands on the same id.

with lib (name, primary_muscle, equipment) as (values
${values}
), slugged as (
  select name, primary_muscle, equipment,
         trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) as slug
  from lib
), hashed as (
  select *, extensions.digest('ptc-exercise-library:' || slug, 'sha1') as h from slugged
)
insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
select encode(substring(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128) from 1 for 16), 'hex')::uuid,
       null, name, slug, primary_muscle, equipment, null, true,
       case equipment ${increments} else 2.5 end
from hashed
on conflict (id) do nothing;
`;

const fingerprint = createHash('sha256')
  .update(
    [...rows]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => [r.id, r.name, r.slug, r.primary_muscle, r.equipment, String(r.increment_kg)].join('|'))
      .join('\n'),
  )
  .digest('hex');

writeFileSync(here + '../migrations/0019_exercise_library.sql', sql.replace(/\n/g, '\r\n'));
const byEquipment = rows.reduce((m, r) => ((m[r.equipment] = (m[r.equipment] || 0) + 1), m), {});
console.log(`${rows.length} lifts (${kept.length} from the source, ${added.length} added)`, byEquipment);
console.log(`fingerprint ${fingerprint}`);
