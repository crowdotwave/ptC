-- ptC schema. Step 3 of the build order.
--
-- This mirrors js/schema.js exactly. The two move in the same commit or they drift, and a
-- drift here is invisible until a write fails on a real client's phone in a gym.
--
-- Conventions carried over from CLAUDE.md:
--   every id is a client generated uuid, so no column has a default and there are no serials
--   created_at is when the row was written, set by the client, defaulted only as a safety net
--   updated_at exists on every mutable table because conflict resolution is last write wins
--   set_logs is append only and therefore has no updated_at
--   weight is always kilograms, money is always integer cents

-- No extensions are needed. pgcrypto would be the obvious one, and it is deliberately absent:
-- nothing here generates a uuid server side, because every id comes from crypto.randomUUID()
-- on the device. Installing it into public would also collide with the function revoke in
-- 0002_rls.sql and quietly strip execute from whatever it brought with it.

-- ---------------------------------------------------------------- trainers

create table public.trainers (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deliberately not a foreign key to auth.users. CLAUDE.md specifies a plain uuid, and
  -- keeping it plain is what lets the isolation test run without fabricating auth rows.
  auth_user_id uuid unique,
  display_name text not null,
  brand_color text not null,
  logo_url text,
  weight_unit text not null check (weight_unit in ('kg', 'lb'))
);

-- ---------------------------------------------------------------- clients

create table public.clients (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  auth_user_id uuid unique,
  display_name text not null,
  invite_code text not null unique,
  status text not null check (status in ('invited', 'active', 'archived')),
  weight_unit text not null check (weight_unit in ('kg', 'lb'))
);

create index clients_trainer_id_idx on public.clients (trainer_id);
create index clients_status_idx on public.clients (status);

-- ---------------------------------------------------------------- exercises

create table public.exercises (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- null means the shared library, which every trainer and client can read
  trainer_id uuid references public.trainers (id) on delete cascade,
  name text not null,
  slug text not null,
  primary_muscle text not null,
  equipment text not null,
  media_url text,
  is_global boolean not null,
  -- Smallest load change this lift can actually make. The stepper reads this, so a global
  -- constant would offer the client weights the gym cannot make.
  increment_kg numeric not null check (increment_kg > 0)
);

create index exercises_trainer_id_idx on public.exercises (trainer_id);
create index exercises_slug_idx on public.exercises (slug);
create index exercises_is_global_idx on public.exercises (is_global);

-- ---------------------------------------------------------------- program templates

create table public.program_templates (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  name text not null,
  notes text not null default '',
  archived_at timestamptz
);

create index program_templates_trainer_id_idx on public.program_templates (trainer_id);

create table public.template_days (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  template_id uuid not null references public.program_templates (id) on delete cascade,
  day_index integer not null,
  name text not null
);

create index template_days_template_id_idx on public.template_days (template_id);

create table public.template_items (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  day_id uuid not null references public.template_days (id) on delete cascade,
  -- restrict, not cascade: deleting an exercise must not silently rewrite a program
  exercise_id uuid not null references public.exercises (id) on delete restrict,
  order_index integer not null,
  target_sets integer not null check (target_sets > 0),
  target_reps_low integer not null check (target_reps_low > 0),
  target_reps_high integer check (target_reps_high is null or target_reps_high >= target_reps_low),
  target_rpe numeric,
  rest_seconds integer not null check (rest_seconds >= 0),
  notes text not null default '',
  -- What to put on the bar the first time a client does this lift. Used only when they have
  -- no history for the exercise. Null is a real answer, meaning the trainer has not seen this
  -- client lift yet, and the app falls back to a fact about the equipment rather than a guess
  -- about the person. See js/prefill.js.
  starting_weight_kg numeric check (starting_weight_kg is null or starting_weight_kg > 0)
);

create index template_items_day_id_idx on public.template_items (day_id);
create index template_items_exercise_id_idx on public.template_items (exercise_id);

-- ---------------------------------------------------------------- assignments

create table public.assignments (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_id uuid not null references public.clients (id) on delete cascade,
  -- restrict: the template a client was assigned cannot vanish out from under the history
  template_id uuid not null references public.program_templates (id) on delete restrict,
  -- Mandatory. Editing a template must never retroactively rewrite what a client was already
  -- told to do, and this is also the only way a client sees their program, since clients have
  -- no read access to program_templates at all.
  snapshot jsonb not null,
  starts_on date not null,
  ends_on date
);

create index assignments_client_id_idx on public.assignments (client_id);
create index assignments_template_id_idx on public.assignments (template_id);

-- ---------------------------------------------------------------- sessions

create table public.sessions (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_id uuid not null references public.clients (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete set null,
  day_index integer not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  client_note text
);

create index sessions_client_id_idx on public.sessions (client_id);
create index sessions_assignment_id_idx on public.sessions (assignment_id);
create index sessions_started_at_idx on public.sessions (started_at);

-- ---------------------------------------------------------------- set_logs, APPEND ONLY

-- No updated_at, because a row here is never updated. A correction writes a new row with
-- supersedes_id pointing at the original. A retraction does the same and sets is_void.
-- Enforced three ways: no update or delete grant, no update or delete policy, and the
-- restrict foreign key below so a session delete cannot take the audit trail with it.
create table public.set_logs (
  id uuid primary key,
  created_at timestamptz not null default now(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  exercise_id uuid not null references public.exercises (id) on delete restrict,
  set_index integer not null check (set_index >= 0),
  weight_kg numeric not null check (weight_kg >= 0),
  reps integer not null check (reps > 0),
  rpe numeric,
  is_warmup boolean not null,
  logged_at timestamptz not null,
  supersedes_id uuid references public.set_logs (id) on delete restrict,
  is_void boolean not null default false,
  -- True when the client added this set beyond the program. Recorded rather than inferred from
  -- assignments.snapshot, because every chart that separates prescribed volume from extra
  -- volume reads it per row, and because whether a set was asked for is a fact about the
  -- moment it happened.
  is_extra boolean not null default false,
  device_id text not null
);

create index set_logs_session_id_idx on public.set_logs (session_id);
create index set_logs_exercise_id_idx on public.set_logs (exercise_id);
create index set_logs_logged_at_idx on public.set_logs (logged_at);
create index set_logs_supersedes_id_idx on public.set_logs (supersedes_id);

-- ---------------------------------------------------------------- payments

create table public.payments (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  -- set null, not cascade, and paired with the denormalized name below: a tax record has to
  -- outlive the client it refers to
  client_id uuid references public.clients (id) on delete set null,
  client_name_text text not null,
  paid_on date not null,
  amount_cents integer not null,
  currency text not null default 'CAD',
  method text not null check (method in ('e-transfer', 'cash', 'cheque', 'other')),
  note text
);

create index payments_trainer_id_idx on public.payments (trainer_id);
create index payments_client_id_idx on public.payments (client_id);
create index payments_paid_on_idx on public.payments (paid_on);

-- ---------------------------------------------------------------- notes on what is absent
--
-- There is deliberately no updated_at trigger. Conflict resolution is last write wins on
-- updated_at, and the value that has to win is the one the client wrote when the edit actually
-- happened, possibly hours before it synced. A trigger stamping now() on arrival would make
-- every sync look like the newest edit and would quietly reverse the rule.
--
-- There is deliberately no default on any id. Ids come from crypto.randomUUID() on the device,
-- which is what makes an offline write idempotent on replay. A default would paper over a
-- client bug by inventing a second id for a row that already had one.
