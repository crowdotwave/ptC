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

### Storage adapter

All persistence goes through a single adapter interface so the local and remote layers stay
swappable. Never call Supabase or IndexedDB directly from UI code.

```
storage.get(table, id)
storage.query(table, filters)
storage.put(table, record)        // upsert, idempotent by id
storage.delete(table, id)
storage.sync()                    // flush local queue to remote, pull remote changes
```

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
  only. Never store a unit alongside a number in the same table. All conversion lives in
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
- **That fence is a claim, not a token count, and it now covers two places.** The emerald also
  faces slot 2 of the consistency grid, because a filled cell there IS a finished session: same
  claim, drawn as a calendar square rather than as a card. It replaced a moss green at 88 degrees,
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
- The header's right edge holds the kg/lb switch, not a menu. There was a circular menu button
  there carrying a name and a sign out link, which did not earn a permanent control on every
  screen and which overlapped the resume bar, because an absolutely positioned element cannot see
  a sticky sibling in flow. Sign out now sits in the page footer, in the quietest type on the
  screen, on the scrolling screens only. The logging screen must never scroll and so has none.
- The switch sits on the line below the lift name, not beside it. Beside it was tried and
  measured: the name is 32px at the mid set tier, so a 90px neighbour wraps almost every barbell
  lift to two lines, which pushed the logging screen to 831 against a viewport of 812 and put the
  log action under the tab bar. Nothing goes on that row unless it is under about 40px wide.
- Anything pinned beside a scrolling chooser goes in the row, never floated over it, and a global
  setting does not go in that row at all. Position absolute against the padded content area
  cannot account for the resume bar, so a floating control will collide with it again the moment
  somebody re-adds one.
- Raised controls are lit, not outlined. Every pressable thing catches light along its top inside
  edge and drops a shadow from its bottom one, at one of two strengths shared by the whole app
  (`--edge-lit`, `--edge-lit-strong`, `--shade-drop`), mixed from `--text-primary` and
  `--surface-base` rather than from raw white and black. Pressed drops the lit edge and takes an
  inner shadow, so a press reads as physical rather than merely recoloured. A 1px neutral outline
  around a coloured slab reads as an unfinished border, which is what the steppers looked like
  with a `--muted` edge on violet.
- Respect `prefers-reduced-motion`
- Visible keyboard focus states
- Responsive down to a 360px viewport, designed mobile first, desktop is the trainer view

### Encoding rules

**No hue-only encoding.** Mid-set, under exertion and glare and with sweat on the glass, fine
hue discrimination degrades. Every state that carries meaning also carries a shape, a weight,
a position, or a word.

**Selected means filled.** Any row that chooses between things, the day picker and the lift
picker today, is a row of pill chips: unselected is a hollow outline on pitch black, selected
is filled with the raised surface gradient plus its rim, a 700 weight label, and a glow. Fill
against no fill is the signal that survives colour blindness, glare, and a glance from arm's
length, so it is the one carrying the state. Colour is reinforcement and never the whole
signal. The workout panel is the same rule at a different size: the lift being done fills with
the same gradient and rim while the rest are hollow, and the word "Now" carries it a second time.
Filling is also what separates pressable from not there, since a lift with every set logged has
nowhere to go and so gets no fall of light at all. Both chip rows share one rule in `styles.css`
under "chooser chips" so they cannot drift:
they were previously styled apart, and one of them shipped with no visible selected state at
all while the other encoded it in two colours and nothing else.

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

They are fenced the way `--done` is fenced: the grid and its legend, and nowhere else. Never a
chart, never a control, never text.

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
   which is why it holds the h1 and the lift name below it is an h2.
7. Payment log and CSV export.
8. Export cards.

Do not start step 5 until step 2 has been used by a real person for a real workout.
