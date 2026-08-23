# CLAUDE.md

Context file for this repo. Read fully before writing code.

## What this is

A two-sided workout logging app. A personal trainer builds a program, assigns it to a
client, and the client logs sets against it with near-zero friction. The trainer sees every
client's progression. Clients see only their own.

The product thesis: clients quit training because they cannot see it working. This app
exists to make progress visible and undeniable. Logging is the cost of entry, not the
product. The product is the evidence.

## Non-goals (do not build these without being asked)

- Nutrition tracking, macros, meal plans
- Messaging or chat between trainer and client
- Scheduling, calendars, booking
- Social feed, following, public leaderboards, client-to-client visibility of any kind
- Video upload or form review
- Anything that requires a native app store submission

## Roles and visibility rules

There are exactly two roles.

**Trainer.** Creates clients, builds program templates, assigns programs, views all of their
own clients' data, exports data, logs payments.

**Client.** Sees the program assigned to them, logs sets, sees their own history and charts.

Hard rule: a client can never see another client's data, another client's existence, or the
trainer's own training data. This is enforced at the database with row-level security, not
in the UI. UI-level filtering is a bug, not an implementation.

## Architecture

- Plain HTML, CSS, and vanilla JS. No build step, no bundler, no npm install required to run.
- Libraries load from CDN via `<script type="module">` imports.
- Supabase for Postgres, auth, and row-level security. `supabase-js` from CDN.
- IndexedDB for local-first writes. Every write lands locally first and syncs in the
  background. The app must be fully usable with no network.
- Deployed as static files. GitHub Pages is fine.
- `sw.js` is a service worker, and its only job is making the page itself load with no network.
  Network first, cache as the fallback, nothing precached, so a deploy is picked up on the next
  load and there is no version constant for anyone to forget to bump. It does **not** sync in the
  background: the Background Sync API is not implemented in WebKit, so on the phones this app is
  used on there is no such thing as flushing the outbox while the app is closed. Getting sets off
  the phone sooner is `push()` and the listeners in `js/boot.js`, which run in the page.

**Offline is not signed out, and getting that wrong deletes somebody's training.** `getSupabase()`
answers null when the CDN cannot be fetched, and reading a session needs the library, so with no
network there is no session to find and it looks exactly like a sign out. The branch that used to
follow aligned the database to `local`, and `alignIdentity` wipes on a change of person: a client
who logged a session in a basement would open the app, still offline, to somebody else's seeded
history with their own sets gone, and nothing had reached the server. `staysSignedIn` in
`js/boot.js` answers it from disk instead, off the stored identity and actor, and returns a mode of
`offline`. That path was unreachable while the app needed a network to load at all, which is the
kind of thing adding a service worker does: it makes the offline paths real.

### Storage adapter

All persistence goes through a single adapter interface so the local and remote layers stay
swappable. Never call Supabase or IndexedDB directly from UI code.

```
storage.get(table, id)
storage.query(table, filters)
storage.put(table, record)        // upsert, idempotent by id
storage.delete(table, id)
storage.push()                    // flush local queue to remote, and nothing else
storage.sync()                    // flush local queue to remote, pull remote changes
```

**`push()` is what runs while somebody is training, and `sync()` is not.** A pull reconciles: it
rewrites local rows from the server and removes rows the server no longer has. Underneath a live
logging screen that means changing the program, the day, or the session out from under somebody
mid set, and that screen holds all three in memory and would never notice. Getting this client's
own sets off the phone needs no pull at all. Both flushes are serialised against each other, since
they drain one outbox and two in the air at once would send the same entries twice.

### Offline sync rules

- All record IDs are UUIDs generated client-side with `crypto.randomUUID()`. Never use
  database auto-increment integers. This is what makes offline writes idempotent.
- Every record carries `created_at` (when the row was written) and, where meaningful,
  a separate domain timestamp such as `logged_at` (when the thing actually happened).
  These differ when a client logs offline and syncs hours later.
- `set_logs` is append-only. Never update or delete a set row. A correction writes a new row
  with `supersedes_id` pointing at the old one. This makes sync trivially conflict-free and
  gives a free audit trail.
- Conflict resolution elsewhere is last-write-wins on `updated_at`.

### Throwing a session away

Append-only is not negotiable, and it is enforced in three independent places: 0002 grants only
`select, insert` on `set_logs` and writes no update or delete policy, 0001 declares
`set_logs.session_id references sessions on delete restrict`, and the adapter refuses `delete()`
against any table marked `appendOnly`. A change that relaxes one of these to make deletion simpler
is a proposal to make a client's logged history editable by whoever holds the session row. Read it
that way before agreeing to it.

So a client throwing away a session is not a delete. It is undo applied to a whole session: a
retraction row per set that still counts, then `sessions.discarded_at`. `js/session.js`
`discardSession` does it, retractions first and the marker last, so a device that dies halfway
leaves a live session with some sets retracted rather than a vanished session still feeding every
chart.

**`discarded_at` exists because two things read session rows rather than set rows.** Everything
that reads `set_logs` through `activeSetLogs` already ignores a retracted session for free. The
day rotation in `pickDay` and the consistency grid do not: one would keep advancing the day picker
past a workout nobody did, the other would keep drawing a filled cell for it. So every read of
`sessions` goes through `js/session.js`, `live()` or `loadSessions()`, and a call site that queries
the table directly is a bug. It will present as a discarded session quietly counting again on one
screen and not on the others.

Discard is offered to the client and to nobody else, including the trainer reading with `?client=`.
That is not a UI decision, it is what the policies allow.

## Schema

All tables have `id uuid primary key` and `created_at timestamptz not null default now()`.

```
trainers
  auth_user_id uuid unique
  display_name text
  brand_color text            -- hex, used on export cards
  logo_url text null
  weight_unit text            -- 'kg' | 'lb', display preference only

clients
  trainer_id uuid -> trainers.id
  auth_user_id uuid null      -- null until they accept. Set only by the auth trigger,
                              -- never writable over the API, so a binding is one way
  display_name text
  email text unique           -- the binding key. Supabase invites here and the trigger
                              -- matches on it, so a client can be created, programmed,
                              -- and assigned before that person has ever signed up
  status text                 -- 'invited' | 'active' | 'archived'
  weight_unit text

exercises
  trainer_id uuid null        -- null means global/shared library
  name text
  slug text
  primary_muscle text
  equipment text
  media_url text null
  is_global boolean

program_templates
  trainer_id uuid -> trainers.id
  name text
  notes text
  archived_at timestamptz null

template_days
  template_id uuid -> program_templates.id
  day_index int
  name text                   -- 'Push A', 'Lower Body', etc

template_items
  day_id uuid -> template_days.id
  exercise_id uuid -> exercises.id
  order_index int
  target_sets int
  target_reps_low int
  target_reps_high int null
  target_rpe numeric null
  rest_seconds int
  notes text

assignments
  client_id uuid -> clients.id
  template_id uuid -> program_templates.id
  snapshot jsonb              -- frozen copy of the full program at assign time
  starts_on date
  ends_on date null

sessions
  client_id uuid -> clients.id
  assignment_id uuid null
  day_index int
  started_at timestamptz
  completed_at timestamptz null
  client_note text null
  discarded_at timestamptz null  -- thrown away by the client. set_logs cannot be deleted, so a
                                 -- discard retracts every set and marks the session here

set_logs                      -- APPEND ONLY
  session_id uuid -> sessions.id
  exercise_id uuid -> exercises.id
  set_index int
  weight_kg numeric
  reps int
  rpe numeric null
  is_warmup boolean
  logged_at timestamptz
  supersedes_id uuid null
  device_id text

payments
  trainer_id uuid -> trainers.id
  client_id uuid null
  client_name_text text        -- denormalized, survives client deletion
  paid_on date
  amount_cents int
  currency text                -- default 'CAD'
  method text                  -- 'e-transfer' | 'cash' | 'cheque' | 'other'
  note text null
```

### Schema rules that are expensive to get wrong later

- **Weight is always stored in kilograms** as `weight_kg`. Pounds are a display conversion
  only, and pounds are what the app SHOWS unless somebody says otherwise: `weight_unit` defaults to
  `lb` in the column, in `js/units.js` before a viewer row has been read, and in the seed. Never store a unit alongside a number in the same table. All conversion lives in
  `js/units.js` and nothing else may format a weight: the progress and trainer screens each
  hardcoded `kg` for a while, so a client set to pounds read pounds while logging and kilograms
  everywhere else.
- **`weight_unit` belongs to the viewer, never to the person being viewed.** A trainer reading a
  client's progress reads it in the trainer's own unit and cannot reach the unit that client's
  phone shows. `progress.html` renders somebody else's data whenever a trainer opens it with
  `?client=`, so resolving the preference from the row on screen would let one person's tap
  change an app on another person's phone. Resolve it from the actor. Somebody who holds both a
  clients row and a trainers row gets one preference, taken from the clients row.
- **`assignments.snapshot` is mandatory.** When a trainer edits a template, it must not
  retroactively rewrite what a client was already told to do. The snapshot freezes the
  program as assigned. History stays truthful.
  **The way through it is a new row, never an edit to the old one.** A trainer who fixes a rest time
  on a live program can send it, and what that does is write a fresh assignment per client carrying
  the current snapshot, starting today. Sessions already logged keep pointing at the assignment they
  were logged under, so history stays attached to the program it was actually done against, and
  `currentAssignment` picks the new row up for the next session. `deload_weeks` carries forward,
  because a back off week is marked from the client's chart months later and losing it as a side
  effect of a rest time edit would be a silent change to somebody's training. Before this the rule
  was enforced and unexplained: the builder warned that edits reach new assignments only and said
  nothing about assigning again being the mechanism, so a fix looked applied and the client's phone
  went on showing the old number.
- **`payments.client_name_text` is denormalized on purpose.** Tax records must survive a
  client being deleted.
- Money is `amount_cents` as an integer. Never floats.

## Row-level security

Every table gets RLS enabled with no permissive default. Policies:

- Trainers can read and write rows where the row resolves to their own `trainer_id`.
- Clients can read and write rows where the row resolves to their own `client_id`.
- Clients have no read access to `clients` other than their own row, and no access to
  `program_templates`, `payments`, or any other client's `sessions` or `set_logs`.
- Write a test that logs in as client A and attempts to read client B's set_logs. It must
  return zero rows. This test runs before any release.

## The write map

Every write the app performs, who performs it, and the policy that has to allow it. Keep this
current. A new `storage.put` against a table not listed here needs a row adding, and if you
cannot name the policy that permits it, that is the finding rather than a formality.

| table | written from | acting as | policy that must allow it |
| --- | --- | --- | --- |
| `sessions` | logging screen | the client | `sessions_client_all` |
| `set_logs` | logging screen | the client | `set_logs_client_insert`, insert only |
| `sessions` | logging screen, the session note | the client | `sessions_client_all` |
| `sessions` | progress screen, on discard | the client | `sessions_client_all` |
| `set_logs` | progress screen, on discard | the client | `set_logs_client_insert`, insert only |
| `program_templates` | builder, importer | the trainer | `program_templates_trainer_all` |
| `template_days` | builder, importer | the trainer | `template_days_trainer_all` |
| `template_items` | builder, importer | the trainer | `template_items_trainer_all` |
| `exercises` | builder, on a new lift | the trainer | `exercises_trainer_write` |
| `assignments` | builder on assign, trainer view on deload | the trainer | `assignments_trainer_all` |
| `clients` | builder, on creating a client | the trainer | `clients_trainer_all` |
| `clients` | unit switch | **the client, their own row** | `clients_self_update`, update only |
| `trainers` | unit switch | **the trainer, their own row** | `trainers_update`, update only |

The two `clients`/`trainers` unit switch rows are why this table exists. Everything else has one
writer and one policy. Those two are written by a second person under a second policy, and both of
those policies permit an update and nothing else.

The session note row adds no policy and no grant either. It is an update to a row the client
already owns, written through the one function in `app.js` that touches that row, which exists
because the in-memory copy of it does not carry `completed_at`: a second writer spreading that
stale copy would have reopened a finished session as a side effect of saving a note, and the
session would then have offered itself up for resume for six hours.

The two discard rows are the second reason to keep reading it. They add no policy and no grant:
discarding a session is an update to a row the client already owns and an insert of set rows the
client is already allowed to insert. A trainer holds `sessions_trainer_select`, which is select
only, so a trainer cannot discard a client's session. The one person who can throw away the record
of a workout is the person who did it, and that is enforced by the absence of a policy rather than
by the absence of a button.

**So `clients` and `trainers` may never be written with an upsert.** PostgREST sends an upsert as
`INSERT ... ON CONFLICT DO UPDATE`, and Postgres validates the insert policy's `with check` before
it ever reaches the update path. On `clients` that check is `clients_trainer_all`, so somebody who
is both a trainer and a client of a different coach is refused on their own row. On `trainers` it
is `auth_user_id = auth.uid()`, and the adapter is required to strip `auth_user_id` from every
write, so the check reads a null that cannot legally be sent. `js/remote.js` updates these two
first and inserts only when nothing was there.

This cost three days of a completely silent outage: a rejected preference write sat at the head of
the outbox, a blocked push used to skip the pull entirely, and no screen said a word. Two of those
three are now fixed in code. The third is this table.

## The logging screen

This is the only screen where execution quality decides whether the product gets used.
Treat it as the core of the app, not a form.

Requirements:

- One thumb, one hand, screen at arm's length, possibly with chalk on hands.
- The next set to perform is always the largest target on screen.
- Last session's weight and reps for that exact exercise and set index are pre-filled.
  Logging an identical set is a single tap.
- Adjusting weight or reps is a tap on a stepper, not a keyboard. Keyboard is the fallback,
  never the default.
- **An adjustment survives the next tap.** A number the client moved this session carries to the
  rest of that lift; a number they left alone steps to whatever the plan asked for next, so a ramp
  from last session still repeats in one tap a set. Taking the next entry's number unconditionally
  meant a correction lasted exactly one set: measured on a real workout, a first ever lift logged
  40 lb, then 5.5, 5.5, 5.5, because with no history every set opens at the deliberately light
  fallback and only the first one got fixed. The carry stops at the lift, and at the boundary
  between warmups and working sets, since carrying a warmup's load into the first working set is
  the app talking somebody down off their working weight. `nextSteppers` in `js/plan.js` owns it,
  and the resume path goes through the same function so a locked phone does not undo the
  adjustment the way logging a set used to.
- Rest timer starts automatically on set completion and is visible without scrolling. It does not
  survive the end of the session: the summary card replaces it rather than sharing a screen with
  it, because a countdown next to "Session logged" is telling somebody to get ready for a set that
  does not exist. Undo brings the set back and the timer with it.
- A set is logged optimistically. The UI never blocks on the network.
- **How many sets there are comes from `target_sets`. What is on them comes from history.** These
  look like one question and are not. Building the plan out of last session's rows answers both
  from history, and then a session cut short rewrites the program: four sets prescribed, one
  logged, and the next visit reads "Set 1 of 1", closes itself after that single log because a
  single set was the whole plan, and hands one set of history to the visit after that. A
  prescription that decays every time somebody is interrupted is not a prescription. Where history
  is short of the count, the remaining sets are prefilled from the last working set of that lift
  and say `Carried from your last set`, never `Last time`, because there is no row at that index
  and claiming one is the screen inventing a history it does not have. `js/plan.js` owns both
  rules. Warmups do not count against the prescription.
- **An interrupted session is picked back up, not started over.** This screen's whole state is one
  object in one tab, and a locked phone or a discarded tab loses it. Nothing logged is ever lost,
  because the rows are on disk and `set_logs` is append only, so the rows are enough to rebuild
  where the cursor was, what is in the undo stack, and which extra sets had been added.
  `js/session.js` does it and both this screen and Progress read the answer from there, so the
  offer to resume and the ability to resume cannot disagree. An unfinished session stays resumable
  for six hours, which is longer than any session and shorter than the gap to the next one:
  without a bound, `completed_at is null` is also what an abandoned session looks like forever.
  The screen says so on arrival, naming the day and the count, because the failure this fixes was
  not only landing on the wrong day, it was having no way to tell whether the session was still
  going.
- `pickDay` advances the rotation from the last session, and a session exists the moment the first
  set is logged. So anything that reloads mid workout has to check for an open session first, or
  back and chest becomes shoulders.
- **The order of the lifts is the trainer's intent, not a queue.** A rack is taken or somebody is
  sitting on the machine, so the lift that comes next is routinely not the lift that can be done
  next. The whole day is one tap from the logging screen, from a chip top left carrying the day's
  name and the position in it, and any lift with sets owed is one tap from there. The panel is a
  state of the screen rather than a layer over it: no focus trap, no z-index, no outside click
  handler, and the rest timer stays where it is, because a countdown you have to dismiss something
  to read has stopped doing its job. `js/workout-view.js` builds the list and `app.js` owns the
  moving.
- **So a cursor walking forward is not the model any more.** Every planned set carries a status,
  a session ends when nothing is pending rather than when the cursor runs off the end of the plan,
  and the undo stack holds the entries themselves rather than their positions, because adding a set
  to a lift somebody came back to shifts every position after it. `js/session.js` `replaySession`
  matches each row to its own seat wherever that sits: it used to search forward from the cursor,
  which meant bench before squat and then a locked phone came back with two copies of every squat
  set and the real ones reading as never done.
- Undo the last logged set is always available for the duration of the session, including after a
  reload, and including for sets logged before it.
- Adding a set is one tap and appends to the lift the client is on, prefilled from wherever the
  steppers already sit. The added set is written with `set_logs.is_extra` true, recorded at log
  time rather than inferred later from the assignment snapshot, because the trainer needs
  prescribed and actual separated on every row a chart reads.
- The first ever set on a lift prefills from `template_items.starting_weight_kg`, which the
  trainer sets when building the program. When it is blank, and it will be for a client nobody
  has watched lift, the app does not guess a working weight. It falls back to a fact about the
  equipment: the empty bar, or the lightest load a stack or rack can hold. Both are obviously
  too light on purpose. Erring light costs a few taps on the stepper. Erring heavy costs a
  failed rep, or an injury, and a client who stops trusting the numbers.
- Skipping an exercise is one tap and moves straight to the next lift. A skipped exercise
  writes no set rows, because nothing was performed and absence is the truthful record.
  It is not a failure state: no warning colour, no badge, no running count of what was
  missed, no prompt asking why, and no offer to reschedule it. The acknowledgement names the
  lift the client is now on, not the one they left. **Skip means move me on now, not never.** It
  was permanent for the length of a session only because a cursor could not turn round, and a lift
  that was skipped reads on the list exactly like one nobody has reached, because that is the only
  difference between them a client would ever need told. Tapping it puts those sets back.
- **A lift stepped away from carries its own way back**, named and counted, for as long as it still
  owes sets. It shares the notice band and outranks anything neutral being said there, because two
  stacked rows is what pushes this screen into scrolling on a short phone, and the header is
  already saying what a neutral message would confirm. A refused write outranks both: that one is
  the only place the app says a set is on this device alone.
- Ending a session early is always available and closes the session with whatever was logged.
  The summary reports what was done and never what was not. A session with two lifts in it is
  a session, not a partial one. It sits in the workout panel rather than in the row of secondary
  actions: it is used once, it was a thumb's width from Undo, and that row has no confirmation
  anywhere in it by design.
- No confirmation dialogs anywhere in the logging flow. That includes skip and end session:
  both are reachable by undo or by simply training again, so neither is worth a dialog.
- **Finishing is a submit, and it has an answer.** The summary card carries a Done button. How it
  felt and the note are held in memory until it is pressed, so ending a session is a deliberate act
  the app confirms rather than something that quietly happened while chips were tapped. The chips
  used to write on every tap, which meant there was no moment of completion to confirm; the loss
  that holding reintroduces is answered by keeping the unsent answer in `sessionStorage`, so a
  reload during the summary comes back with it. **The SETS are never held this way.** They are
  written the instant they are logged and always have been: a phone that dies between the last set
  and the Done button costs an unsent note and never a workout, and that ordering is why `set_logs`
  is append only in the first place. A submit that gated the sets would put a whole session behind
  a button somebody might not reach.
- **How it felt is asked once, at the end, and never per set.** `sessions.client_note` was in the
  schema from 0001 and nothing wrote to it for months: the objective half of a workout was recorded
  to the rep and the subjective half was not recorded at all. For a calisthenics block that is most
  of what a coach needs, since a max hold that felt easy and a max hold that nearly failed are the
  same row of numbers. It sits on the summary card, on a session that has something in it, as four
  effort words plus an optional sentence, and both compose into that one text column. `js/feel.js`
  owns the composing and the taking apart, so a note can be redrawn as a selected chip after a
  reload without a second column to migrate. A prompt after every set is a confirmation dialog
  wearing different clothes, and this screen has none of those: it exists to make an identical set
  one tap, and "and how was that?" after a max hold takes that back. The words are an effort ladder
  and carry no failure state, per the no-guilt rule below.

Deliberately absent: no streak pressure, no guilt messaging for missed days, no
notifications nagging the client to train.

## Metrics and framing

Default headline metrics are **performance and consistency**, never body composition:

- Estimated 1RM trend per lift (Epley, and state the formula in the UI)
- Total volume, computed as sets by reps by weight
- Session count and consistency grid
- Personal records with dates

Body weight and body measurements are opt-in per client, off by default, and never appear
on a shareable export card. This is both an ethical requirement and the product
differentiator against every incumbent that leads with weight loss.

## Design direction

Dark UI only. Before writing CSS, define a token set and stick to it. Do not reach for the
default near-black background with a single acid-green accent, which is the generic answer.
Derive the palette from the subject: this is a gym floor tool, read under bad lighting,
mid-effort, at arm's length.

Constraints:

- Contrast ratio at least 7:1 for the between-sets tier, meaning any text at 14px or 17px,
  and at least 4.5:1 for anything 28px and above. The mid-set tier is 28px to 64px at weight
  600 to 700, which is large text by WCAG, where large means 24px and up or 18.66px and up at
  bold weight. 7:1 is the AAA threshold for normal text, not for large text, and applying it
  to 64px numerals over-constrains the palette for no legibility gain.
- On `--surface-raised`, text is `--text-primary` only. This is the cost of widening the
  surface separation to 2.51:1, which is what makes two surfaces tell apart under glare.
  Lifting the raised surface lifted its luminance, and every other text token fell under the
  floor on it: `--text-secondary` measures 4.49, missing both the 7:1 and the 4.5:1 rules.
  Anything that needs a second text colour needs a different surface, not a different token.
- The palette is three legs of a near triad: action orange at 22 degrees, data cyan at 190,
  ground violet at 272. The ground is a saturated colour, never a near neutral grey. It is also
  never within about 40 degrees of the data axis: a teal ground at 196 was tried and had to be
  abandoned because a surface that close to `--accent-data` reads as a dim member of it and
  starts competing for the meaning cyan owns. Violet sits 82 degrees off cyan and 110 off
  orange, and it holds chroma at low luminance because blue carries 7% of the luminance sum
  against green's 72%, which is what keeps it vibrant on OLED instead of muddy.
- The raised surface's luminance is fixed. `--text-primary` clears the 7:1 floor on it by about
  a quarter point, so hue and chroma are open to change and lightness is not. This has now
  survived grey, teal, and violet without another token moving.
- There is exactly one green MEANING, `--done`, and it marks a finished session. Emerald
  as normally drawn sits near 158 degrees, which is 32 off `--accent-data` and identical to it in
  luminance, so this is pulled to 147 for 43 degrees of separation and then fenced in: never the
  rest timer, never a chart, never the record. Even where it does share a screen with cyan, what
  separates them is size, position, a bordered card and the word "logged", not the hue. A session
  that ended empty is not a success and keeps the neutral card. Before adding a fifth hue, check
  what it will sit next to and measure it, which is the step that was skipped when the ground
  went teal.
- **That fence is a claim, not a token count, and it now covers three places.** The emerald also
  faces slot 2 of the consistency grid, because a filled cell there IS a finished session: same
  claim, drawn as a calendar square rather than as a card. The third is the feelings row inside
  that same card, where the selected chip takes an emerald border, rim and glow. **Every option
  takes the same green.** Letting it vary with the answer is the one move that would break this:
  an emerald "Easy" beside a neutral "All out" turns the app's one green into a verdict on how the
  workout went, which is a second meaning and, on a product that refuses to grade anybody, the
  wrong one. The green there says recorded, exactly as it does in the word "logged" above it. It
  also stops at the chip's edges rather than entering its face, and that part is measured:
  `--surface-raised` is Y 0.0755 against a 7:1 boundary of Y 0.0801, so a 22 percent mix of
  `--done` into the face lands at Y 0.1222 and drops `--text-primary` to 5.58, under the floor for
  14px. Anything small enough to be legal there is too small to see. It replaced a moss green at 88 degrees,
  which was the only hue the split palette had left in the greens and which lands on olive at the
  luminance ceiling those faces live under. The two greens never share a screen, since the summary
  card is on the logging screen and the grid is on progress. What is still barred is unchanged:
  no green on a chart, on the rest timer, or on a record. The arithmetic is under `--split-2-face`.
- Raised surfaces carry a fall of light, top lit, via `--surface-raised-shade` and
  `--surface-raised-rim`. A gradient on a surface that holds mid set text always runs downward
  from the token value, never upward, because the token value is already the contrast ceiling.
  Pressed states drop the gradient and go flat: that is what makes a press read as depressed.
- **The reading screens group into veiled cards. The logging screen does not.** `--veil` is
  `--surface-raised` mixed most of the way to transparent, with `--veil-edge` as a hairline and
  `--veil-lit` as the same fall of light. Over the pitch black base it resolves DARKER than
  `--surface-raised`, never lighter, and that is what keeps it safe: every text token measured
  against `--surface-base` keeps at least the ratio it was measured at, so the "on raised,
  `--text-primary` only" rule does not follow a veil onto a card. A veiled card is a base surface
  wearing a tint. It exists because the progress screen was five things stacked on bare black with
  nothing but a gap holding them apart, and a gap is the first thing that goes when a caption runs
  to two lines. The logging screen is one object read at arm's length and has nothing to group, so
  it stays flat.
- **A veil is a fall of light, not a flat wash, and it ends in the base.** The first version was one
  even tint edge to edge, which made a card the only object in this app with no light direction on
  it while every control on the logging screen is lit along its top and shaded along its bottom. It
  also spent the black: a violet at sixteen percent across half a phone screen is a large grey
  purple rectangle, and on an OLED panel the base is the one surface that costs nothing to draw and
  cannot be imitated. So the wash starts at `--veil` under the lit top edge and falls to
  `--veil-deep`, which is near enough to nothing that the bottom of every card IS `--surface-base`,
  and the hairline goes with it: `--veil-edge` on the top, `--veil-edge-low` on the other three,
  because a line of even weight all the way round is a box drawn on a screen rather than an object
  sitting on one. There is no drop shadow anywhere in this app and there cannot be: a black shadow
  on a black base separates nothing. Objects here are lifted by light on their own edges.
  All three cards take this from one rule in `styles.css`, not three copies of it.
- **`backdrop-filter` earns itself in exactly one place, the tab bar.** Content scrolls under a
  fixed bar, so there is something behind it to frost. Everywhere else the thing behind a veil is
  the black base, and a blur of black is black. It ships behind `@supports` with the opaque bar as
  the declared fallback, and nothing depends on it: the border still draws the edge.
- Minimum touch target 44px, and the primary log action considerably larger
- Navigation is a tab bar fixed to the bottom. Tabs are chosen by capability, never by role name,
  so somebody who coaches and is also coached sees all four. An earlier rule here kept the bottom
  band clear for the log action, on the grounds that a tab bar would sit in the thumb arc it owns.
  That was reversed
  deliberately: the log action stays far larger and keeps a gap beneath it, and the bar is what
  makes this read as an app rather than a page. The cost is a mis-tap risk between two targets
  of very different size, which is a thing to watch in real use
- **The header carries nothing but what the screen is about.** There was a circular menu button in
  the corner once, then the kg/lb switch, and both were wrong in the same way. The menu button
  carried a name and a sign out link, which did not earn a permanent control on every screen, and
  it overlapped the resume bar because an absolutely positioned element cannot see a sticky sibling
  in flow. The unit switch then took that corner and had to be relocated three times to stop
  colliding with things: pinned to the end of the day picker it split 328px with a five day
  rotation, so the thing you pick every session and the thing you set once a year competed for the
  same width; beside the lift name it left a 32px name 241px and wrapped almost every barbell lift
  to two lines, which pushed the logging screen to 831 against a viewport of 812 and put the log
  action under the tab bar; on the line below it worked, and was still 90px of every header in the
  app forever. A control relocated three times is in the wrong band of the screen, not the wrong
  corner of it. **A setting goes with the settings**, which is the page footer, next to sign out,
  in the quietest type on the screen, on the scrolling screens only. The logging screen never
  scrolls and so has neither, which is correct: mid session is not when somebody changes a unit.
  Weights read in **pounds** by default, everywhere, because everyone this is built for is in a
  pound gym and a default everybody changes is a chore with an opinion rather than a neutral start.
- The header's second line still exists and still has a rule: nothing goes on it unless it is under
  about 40px wide, and anything beside a scrolling chooser goes in the row rather than floated over
  it. Position absolute against the padded content area cannot account for the resume bar, so a
  floating control will collide with it again the moment somebody re-adds one.
- **Mid-set controls are lit. Chrome is flat. That line is the whole lighting model.**
  A pressable thing that is read at arm's length, under bad lighting, with sweat on the glass,
  catches light along its top inside edge and drops a shadow from its bottom one, at one of two
  strengths shared by the whole app (`--edge-lit`, `--edge-lit-strong`, `--shade-drop`), mixed
  from `--text-primary` and `--surface-base` rather than from raw white and black. Pressed drops
  the lit edge and takes an inner shadow, so a press reads as physical rather than merely
  recoloured. That is the steppers, the log action, the rest timer and the record celebration, and
  it is not negotiable for them: a 1px neutral outline around a coloured slab reads as an
  unfinished border, which is what the steppers looked like with a `--muted` edge on violet.
  Everything else is chrome, and chrome is flat: `--chrome-face`, no gradient, no lit edge, no
  drop, no rest glow. Menus, list rows, cards, headers, secondary buttons, the tab bar.
  The reason is scale rather than taste. A fall of light is how ONE object reads as liftable from a
  metre away; it is not how a list of forty is drawn. Applying it per row gave the lift picker
  eight bordered, gradient filled, glowing slabs stacked with gaps, which read as clutter at a
  glance even though every row obeyed the rule. Before lighting a new control, ask which side of
  that line it is on.
- **A dimmed screen, not a badly lit gym, is what breaks a control.** This corrects a claim made
  throughout this file. Bad lighting means glare, which is ambient light on the glass ADDING a
  constant to everything: that is the 0.05 flare term in the contrast formula and it is why the
  reading tiers are pinned at 7:1. A phone turned down is the opposite shape of problem. It scales
  every emitted luminance while the flare stays put, so the flare comes to dominate and all ratios
  collapse toward 1. Measured against `--surface-base`:

  | | 100% | 40% | 15% |
  | --- | --- | --- | --- |
  | chrome fill | 1.08 | 1.03 | 1.01 |
  | the old lit edge | 1.50 | 1.20 | 1.07 |
  | a `--text-secondary` label | 11.26 | 5.10 | 2.54 |

  At fifteen percent the only thing left on a secondary button is the word on it, which is what it
  looked like in use: the buttons stopped reading as buttons. So: **a dark fill cannot carry an
  affordance, at any value.** Lifting the chrome fill nearly fourfold still only reaches 1.08 at
  fifteen percent. Only bright pixels survive dimming, so what says "this is a control" is a LIGHT
  hairline, `--chrome-edge`, which holds 4.67 at full brightness and 1.55 at fifteen. The fill
  gives the control a body and is what a press moves; it is not the signal. The same reasoning
  lifted `--divider`, which was a dark line on a dark card and therefore no line at all on a
  dimmed phone.
- **That edge is violet, not grey, and the hue is the palette's own.** It began as `--text-primary`
  at 38 percent, which measured correctly and looked like unpainted metal: a neutral line around a
  coloured slab is the same "unfinished border" the steppers were rescued from. 272 degrees is the
  ground hue that `--surface-raised` already belongs to, so it sits 82 degrees off `--accent-data`
  and 110 off `--accent-action` and cannot compete for either meaning. It also measures better than
  the grey in both conditions that matter, 4.67 against 3.09 at full brightness and 1.55 against
  1.31 when dimmed, so striking and legible were the same change rather than a trade.
- **A chrome control is as big as its label needs and no bigger, and the tap target is written
  down separately.** A 44px slab around a 14px word is wasted band on the one screen that must
  never scroll. The ink is about 38px; the 44px minimum is kept by a transparent `::after` centred
  on the button. Tightening how a control looks must never tighten what a thumb has to hit, and
  those two only stay in step if the second one exists in the CSS.
- **A list is one object.** Rows stop being boxes: one card holds them, a hairline `--divider`
  separates them, nothing but the card is rounded, and the row count stops mattering. Shared as
  `.row-card`, `.row` and `.row__body` in `styles.css`, and used by the lift picker, the workout
  panel and the trainer's client list. Where lit-against-flat used to say pressable-against-not,
  a **chevron** says it now, with the row's own state line saying it a second time in words.
- **A `<button>` cannot be sized by its own grid or flex children**, and this is a real bug rather
  than a style preference. A button lays its children out in an anonymous box and its height is not
  computed from that box's rows: measured on the lift picker, the row was 44.98px tall around 51px
  of content, so `min-height` won and the second line printed through the bottom border, in both
  Chromium and WebKit. Every pressable row wraps its content in a real child and puts the layout
  there.
- Respect `prefers-reduced-motion`
- Visible keyboard focus states
- Responsive down to a 360px viewport, designed mobile first, desktop is the trainer view

### Encoding rules

**No hue-only encoding.** Mid-set, under exertion and glare and with sweat on the glass, fine
hue discrimination degrades. Every state that carries meaning also carries a shape, a weight,
a position, or a word.

**Selected means filled.** Anything that chooses between things, wherever it is drawn, marks the
selection by FILLING it: unselected is a flat chrome face, selected is filled with
`--surface-raised` plus its rim and a 700 weight label. The selected chip used to throw a glow as
well, and that went with the rest of the chrome: a row of glowing pills is a lot of light spent
saying what the fill already says. Fill against no fill is the
signal that survives colour blindness, glare, and a glance from arm's length, so it is the one
carrying the state. Colour is reinforcement and never the whole signal. The rule lives once in
`styles.css` under "chooser chips" and the pickers that are still chip rows take it from there,
which is the day picker and the builder's section picker: they were previously styled apart, and
one shipped with no visible selected state at all while the other encoded it in two colours and
nothing else. The workout panel is the same rule at a different size, the lift being done filled
with the same gradient and rim while the rest are hollow, with the word "Now" carrying it a second
time. The lift picker's list rows are the same rule again at list width, with the word "Showing".
Filling is also what separates pressable from not there, since a lift with every set logged has
nowhere to go and so gets no fall of light at all.

**A chip row is a chooser for a handful of options, and never for a library.** The lift picker on
the progress screen and the trainer's client view was one, and it could not survive the number of
lifts a real client accumulates: measured on the seeded client, eight lifts is 1,344px of row
against 390px of phone, so 71 percent of the options were off screen behind a sliced chip, and a
seven day calisthenics split is three or four times that. That is the same failure the chip rule
exists to prevent, arrived at from the other side. So it is now what every training app converges
on for this, because it is the only shape that holds forty options on a phone: one lit control
saying what it does, and behind it a list you can search, grouped by the day of the program each
lift sits on, each row carrying its session count and when it was last trained. It is a state of
the screen and not a layer over it, exactly as the workout panel is: in flow, no focus trap, no
z-index, no outside click handler, escape to close. `js/lift-picker.js` owns it and both screens
render from that one module. The day picker stays a chip row, because a rotation is five options
and the half visible chip at the edge is a useful affordance when there is almost nothing behind
it.

**No intensity-only encoding either.** This one is measured, not assumed. The data axis is
cyan, and cyan clusters at high luminance in sRGB, so an intensity ladder in it has very
little room. Against `--surface-base`, `--accent-data` reads 11.79 and `--pr` reads 13.49,
a ratio of 1.14 between them. `--progress` and `--pr` sit 1 degree apart in hue. On the
logging screen that is fine, because a record also carries glow, animation, a pill, a position
in the top band, and a sentence naming the lift. In a static chart it is not fine: a record
drawn only in `--pr` beside a `--progress` segment is, by measurement, the same line.

So in charts colour only tints. Weight and shape carry the meaning:

| meaning | token | stroke |
| --- | --- | --- |
| history, superseded | `--accent-data-dim` | 1px, dashed |
| planned deload | `--deload` | 2px, dashed, labelled "Planned deload" |
| a week where nothing moved | `--flat` | 2px, solid |
| the series | `--accent-data` | 2px, solid |
| a value that improved | `--progress` | 3px, solid |
| a record | `--pr` | filled dot with a 2px ring, plus the celebration glow |

`--pr` has one home outside a chart: a day on the consistency grid where some lift beat everything
before it. It is drawn as the same ring with the same glow, sitting outside the cell rather than on
its fill, and the word "record" is in the cell's label and under the month. What a record is stays
decided in one place, `js/progression.js`, and the grid is handed the answer rather than working it
out again. A day ringed on the grid and not on the line two screens down would be the app
disagreeing with itself about the one moment this product exists to deliver.

No hue means "planned". `--deload` can only keep a back off week quiet and clearly not an
alarm. The dashed stroke and the words are what make it read as intentional, so neither is
optional.

**Every y axis carries countable rules, and they are chosen in the unit on screen.** The charts
shipped with two numbers, the top of the box and the bottom, and nothing between them. That is
enough to see a direction and not enough to read a value, which is the thing somebody actually came
for: an estimated 1RM two thirds of the way up a box running 96 to 118 has to be worked out rather
than read. So the domain widens to whole steps of 1, 2, 2.5 or 5 times a power of ten, a hairline
rule sits on each, and the latest point prints the number it landed on.

The steps are picked against DISPLAY units and never against kilograms. Round kilograms are not
round pounds: a tidy 5 kg ladder reads 11, 22, 33 on a pound axis, which is a grid of numbers
nobody would say out loud. `js/charts.js` converts the series once, up front, and kilograms do not
appear below that line. Rules are the quietest stroke in the file and solid, because dashed is
already spoken for by `--deload` and by a block boundary.

### Split identity, on the consistency grid

The grid says which program day each session was. That needs a categorical palette, which is a
thing this token set did not have, and the note above caps the cyan ladder at six with a warning
that a seventh forces a real trade. This does not spend that budget, and the reason is worth
stating because it is the whole design: **these are surface faces, not data tokens.** A calendar
cell is a slab in the ground role saying which kind of day this was, never how much of anything
there was, so it cannot compete for the meaning cyan owns. `--split-N-face`, `-shade` and `-rim`
inherit the lit slab treatment unchanged.

They are fenced the way `--done` is fenced, and the fence now names three places rather than two:
the grid, its legend, and the work per session chart directly under it. Never a control, never
text, and never any other chart.

**That third place is a deliberate loosening and the reasoning has to survive it.** The rule exists
so a surface cannot compete for the meaning cyan owns, and the test of it is what a colour is
claiming. On that chart a line's colour says which program day it is, exactly as a cell's face
does; its HEIGHT says how much work was in the session, and height is not a thing hue is being
asked to encode. The chart also sits immediately under the legend that defines those colours, so
painting it in a second palette would make a reader learn the same split twice.

The pair to measure is `--split-2-rim` against `--accent-data`, since the cyan charts are one card
further down: 150 degrees against 190 is 40 apart, which is under the 43 the `--done` note bought
itself. What separates them here is luminance, and by a margin nothing else in this file has.
`--split-2-rim` reads 3.51 against the base and `--accent-data` reads 11.79, a factor of 3.4, where
the pair that forced the no-intensity-only rule differed by 1.14. A dark emerald stroke inside a
labelled card cannot be read as the bright cyan series in the next one.

What would break this is a second chart taking these colours for anything other than program day
identity. There is no third use, and a proposal for one is a proposal to make these data tokens.

**Luminance is a ceiling here, not a fixed point, and that is the one rule these break with
`--surface-raised`.** That token pins luminance for two reasons: `--text-primary` must clear 7:1 on
it, and two surfaces must separate 2.51 from base so they tell apart under glare on the stepper.
Only the first applies to a cell, which is told apart from black by its own rim rather than from a
neighbouring surface. So the rule is `Y <= 0.0801`, the exact 7:1 boundary, with a soft floor near
`Y = 0.030`.

Holding `Y` fixed across these hues was worked out on paper and is wrong, which is worth recording
because the arithmetic looks so clean. sRGB blue's primary is `Y 0.0722` and green's is `0.7152`,
so an isoluminant set at the `--surface-raised` value of `0.0755` gives a near primary blue beside
a near black olive, and Helmholtz-Kohlrausch widens the gap the eye sees beyond the gap the numbers
show. Matching them means capping every face at the chroma the green can reach, which lands back on
the desaturated `#46505C` that read as unpainted chrome. The ceiling buys a 1.27x range instead.

**The palette affords three hues, not six.** After excluding cyan 190 +/- 40, orange 22 +/- 40,
`--deload` at 224 (measured, not the 240 it looks like) and the ground at 272, what survives is
roughly 62 to 150, 297 to 342, and a narrow 230 to 262. Slots 1 and 2 take the two widest apart,
because a two day upper/lower split is the common case. Slot 4 is deliberately
colourless and is also the overflow, so a six day program puts days four through six in it. A near
neutral is what this file rejected for the ground; a single cell meaning "no colour left for this
one" is a different job, and it measures better than the alternative, which was two saturated faces
24 degrees apart.

**Slot 2 sits at 150 and takes `--done`'s hue, which is the one exclusion this section drops.**
The green window here is 62 to 122, and at `Y <= 0.0801` every hue in it is olive: the moss `#365513`
that shipped first is what the arithmetic gives and olive is what it looks like next to a rose and
an indigo that both hold real chroma this low. That is a window this design cannot spend, not a
value that wanted retuning. Taking 147 instead buys slots 1 and 2 a separation of 172 degrees,
the widest pair this palette has ever had, and it does not overload the token, because a filled
cell and a finished session are the same claim. See the note under the `--done` rule above.

**Four channels, and hue is the fourth.** A trained day fills where an untrained one does not,
carries a two letter glyph made unique inside its own program (Upper A and Upper B become UA and
UB, never U and U), carries a lit bar on its top edge at a slot determined position, and only then
carries a colour. Fill against no fill is the signal doing the real work, same as the chooser chips.

**The bar lives inside the flat run of the top edge, and the cell clips.** It used to start 12
percent in with the cell rounded at 10px, which on a 46px phone cell put its left end four pixels
inside the corner curve, where the cell has no top edge yet. It painted a square cornered tab plus
its own glow hanging off the rounded corner, and at that size it read as a second slab offset
behind the first. The trap is that it is invisible at any size you would mock this up at: the same
12 percent clears the radius comfortably on a 300px cell. Two fixes, because one of them is a
percentage and percentages follow whatever the cell size becomes next: the positions are pulled
into the flat run, and `.cal__day` clips its own overflow.

**Tapping a day focuses that session everywhere, and focusing is not filtering.** A cell answers
whether somebody trained. What they actually did is the question the tap asks, and until now the
answer was one line naming the lifts and counting the sets, which is the cell's own answer given
twice. So a tap now does four things at once: the cell takes a white ring, the whole workout opens
under the grid set by set through `js/session-readout.js`, every chart below rings that session,
and the lift picker narrows to the lifts that day held. Tapping the same day again clears all four.

The charts keep drawing the entire history while one session is ringed, and that is the load
bearing part. Redrawing them from that session alone gives one dot per chart with nothing around
it, and comparing is the whole reason somebody tapped a day. The ring is `--text-primary` and never
a hue: every colour in those charts encodes something about the training, and where the reader is
looking is not a fact about the training. It is told from the record ring by size, by being hollow
where that one has a filled dot, and by a hairline dropped to the baseline that nothing else draws.
`focusMark` in `js/charts.js` owns it.

The readout carries weights, which the line it replaced deliberately did not, and that cost is
paid rather than hidden: it formats nothing itself, the caller hands it `weightLabel`, and the
progress screen redraws it on a unit toggle alongside the charts. A readout of a workout that
cannot say what was on the bar is not a readout of a workout. It carries no total, no score and no
comparison to the session before it: the charts above already hold the comparison, and a grade
under a list of sets is the guilt messaging below arriving through the back door.

**The no-streak rule survives this and is not softened by it.** A consistency grid is not
permission to add a streak. There is no streak count, no adherence ratio, no missed day count, and
no marker for a session that was due and did not happen. A day nobody trained is a numeral on
black, and `buildConsistency` returns no field a caller could render as a failure. The grid opens on
the last month with work in it rather than on an empty current month, which scrolls to work that
was done rather than to space where work was not. The satisfaction is meant to come from cells
accumulating, which is a thing a bad week cannot break.

**A month panel is a whole month or it is nothing.** The scroller carries no horizontal padding and
each panel is exactly its width, so no part of the neighbouring month is ever on screen. It used to
show a 16px window onto the month next door, with a column of cells sliced down the middle against
the screen edge: that is the half visible affordance the lift scroller uses, where half a chip
usefully says there is more, and it does not transfer here. Snapping is mandatory precisely because
half of two months is not a thing anybody wants to look at. The arrows carry the affordance, and
they sit in the card's header beside the session count rather than in a row of their own.

Two things fall out of the grid running the full width of the card, and both are deliberate. The
cells keep the width they had before there was a card, which matters because seven columns and
eight gutters at a 360px viewport clear the 44px tap floor by a quarter of a pixel and a card
paying for its own padding out of them would have taken them to 40. And the cells take an INSET
focus ring, the only one in the app that faces inward, because the outward 6px ring is clipped by
the scroller in the first and last column.

### Glow

Glow applies to fills, borders, container edges, and chart strokes. It never sits on or
behind text read mid-set, because glow spreads light into its surroundings and lowers
effective contrast, and glare is the exact failure mode this palette exists to survive.

Two intensities, `--glow-rest` and `--glow-celebrate`, defined once and shared by the screen
and by charts. The record is the only thing that animates, and under `prefers-reduced-motion`
it keeps the glow and drops the movement, because a glow is light rather than motion.

Copy rules: active voice, sentence case, name things by what the person controls. The button
that says "Log set" produces state that says "Logged." Empty states are invitations to act,
not apologies.

## Licensing constraints discovered during research

- **openGym (DuarteSantos8/openGym) is AGPL-3.0.** Do not copy, adapt, or vendor any of its
  code. Studying its UX is fine. Its exercise media comes from a separate upstream dataset
  with its own terms.
- **free-exercise-db (yuhonas/free-exercise-db)** is Unlicense, roughly 800 exercises with
  JSON and images. The dataset license is clean. Image provenance has an unanswered open
  issue, so treat the images as prototype-only and plan to replace them with
  trainer-recorded demos before charging money.
- Do not scrape exercise GIFs from commercial sources.

## Privacy

Canadian trainer and clients, so PIPEDA applies. Consequences:

- Collect the minimum. No date of birth, no address, no health conditions in v1.
- Client consent is required before any of their data appears on an exported or shared
  graphic. The consent is per client and revocable, stored as a flag.
- Do not build anything that touches clinical or rehab populations without revisiting this.

## Writing conventions

- **Never use em dashes** in code, comments, UI copy, commit messages, or documentation.
  Use commas, colons, parentheses, or restructure the sentence.
- Commit messages: imperative mood, one line, no scope prefixes.

## Development data

There is no role switch and no dev mode. Both accounts hold every capability they need, so
acting as somebody else is a thing to do by signing in as them, not by picking from a dropdown.

`?local=1` runs the app against seeded fake data with no backend, opening as the seeded client.
It exists for one reason: that seed is the only data in this project with enough history to draw
a chart. Real accounts have a handful of sets between them, and will for months. Delete it once
a real client has a few blocks logged and the progress screens can be developed against those.
`?local=0` turns it off. It is sticky for the browser session, so following a link keeps it.

## Build order

1. Storage adapter plus seeded fake data. No backend.
2. Logging screen against fake data. Iterate until it feels right in a real gym.
3. Supabase project, schema, RLS policies, isolation test.
4. Swap adapter to Supabase. Auth via magic link.
5. Trainer view: client list, program builder, per-client progression.
6. Consistency grid and charts. Done. `js/consistency.js` builds it, `js/consistency-view.js`
   draws it, and it leads the progress screen. It is the first client wide thing on that screen,
   which is why it holds the h1 and the lift name below it is an h2. The second and last client
   wide thing is the work per session chart under it, `js/session-volume.js` and
   `renderSessionVolumeChart`: the grid says a session happened, that says how much was in it.
   **It is one line per program day and never one line in total.** A single tonnage line alternates
   the size of an upper day and a lower day, so it encodes the day of the week and a trend drawn
   through it measures nothing. It is not one line per lift either: bench against leg press is not
   a comparison anybody has, the magnitudes differ by an order of magnitude so the small lifts flatten
   onto the axis, and the per lift answer is one card below where the picker puts it.
   Which day a session was is decided once, in `identifySessions`, and both the grid and the chart are
   handed the answer, so a line cannot be painted a colour the cell above it is not.
   **A session still running is not a point, and several sessions of one program day on one day are
   one point.** The first is not a low number, it is a number that does not exist yet: including it
   meant the line dipped every time somebody opened Progress between their first set and their last,
   which is the most likely moment anybody looks at this screen. The second is one visit, which is
   what a client restarting on the right day or picking a dead phone back up produces, and drawn
   apart they are four dots inside one pixel of an eight week axis, so they read as a vertical wall
   rather than as the day's work. They sum, exactly as the grid puts two sessions in one cell. Two
   sessions of DIFFERENT days on one date stay apart: those are different lines.
   Neither rule hides a short session. A finished session holding one set is a point at the height
   of one set and the line drops to meet it, because that is the week somebody did almost nothing.
   No guilt is a rule about words and colour. It is not licence to move the data.
   It counts everything performed, warmups aside, with prescribed sets and added sets in one number.
   That is the one departure from "extra volume is never folded into a number carrying a claim", and
   it is narrow: that rule protects the per lift volume chart, whose claim is that the prescription
   is being met, and where an added set would be inflating the evidence for it. The claim here is how
   much work a session held, and a set somebody chose to add is work they did. The per lift card
   still separates the two, so nothing is hidden, it is only totalled differently.
7. Payment log and CSV export.
8. Export cards.

Do not start step 5 until step 2 has been used by a real person for a real workout.
