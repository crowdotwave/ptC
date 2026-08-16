# Supabase setup

Step 3 of the build order: schema, RLS policies, isolation test. The app does not talk to any
of this yet. Swapping the storage adapter over is step 4, and nothing in `js/` imports
`config.js` until then, so applying these files changes nothing about the running app.

The project already exists. `config.js` holds its URL and publishable key.

## Order

Run these in the Supabase dashboard under SQL Editor, one at a time, top to bottom. Each one
depends on the one before it.

1. `migrations/0001_schema.sql` creates the ten tables and their indexes.
2. `migrations/0002_rls.sql` takes back the default grants, adds the ownership helpers, enables
   and forces row level security, and adds the policies.
3. `migrations/0003_rpc.sql` adds the auth trigger that decides what a new signup is, and
   `trainer_branding`.
4. `tests/rls_isolation.sql` proves the policies actually isolate. It checks that 0003 ran, so
   it fails fast rather than confusingly if the order slipped.

Then `email-templates/`, which is not SQL and is not optional. The magic link template has to be
replaced with the code only one there before anybody signs in from an Outlook address. Outlook
fetches links to scan them, and a sign in link is spent by whoever fetches it first, so the default
template delivers a dead link and the retries that follow exhaust the sending quota for the whole
project. That README has the reasoning and the three dashboard settings it depends on.

The SQL editor runs as `postgres`, which has `bypassrls`. That is what lets the test build its
fixtures while the policies stay in force for the parts being tested.

## The isolation test

CLAUDE.md: "Write a test that logs in as client A and attempts to read client B's set_logs. It
must return zero rows. This test runs before any release."

A pass prints one row:

```
RLS isolation: all checks passed
```

A failure raises, naming the check that broke, for example
`ISOLATION FAILURE: client A read 1 of client B set_logs`.

The whole file runs inside a transaction that ends in `rollback`, and a raised exception aborts
the transaction anyway, so it is safe to run against a database with real data in it. It
leaves nothing behind either way.

Every denial is paired with a positive control on purpose. A policy set that denied everything
would pass the negative half perfectly while shipping an app where no client can see their own
training, so "zero rows" is only ever asserted next to a matching non-zero.

What it covers beyond the required case:

- client A reads their own set_logs, filtered and unfiltered
- client A reads client B's set_logs, and client C's, who belongs to a different trainer
- client A sees exactly one row in `clients`, their own, so a sibling's existence never leaks
- client A gets nothing from `program_templates` or `payments`
- client A reads the shared library **and their own trainer's custom exercise**, and zero of
  another trainer's, which is what keeps `increment_kg` reaching the stepper
- client A reads zero rows from `trainers`, and selecting `trainers.auth_user_id` is refused
  at the column grant
- client A still gets their trainer's name and brand colour from `trainer_branding()`
- client A cannot insert a set into another client's session, and can into their own
- client A cannot update or delete any set_log, which is append only enforced at the database
- trainer One sees all three of their clients and none of trainer Two's, and cannot select
  `auth_user_id` either
- trainer Two sees none of trainer One's clients, payments, templates, set_logs, or custom
  exercises
- a program assigned before signup is waiting, and reaches the client once they accept
- a signup on a matching address binds the client row, case insensitively, and creates no
  trainer for them
- running the handler twice for the same person produces exactly the same rows
- an already accepted client row is never rebound, so a second signup on that address becomes
  a trainer instead of taking over the row
- a signup with no pending invite becomes exactly one trainer, and a repeat creates no
  duplicate
- a signup with no email address creates nothing at all
- a trainer can correct a client's email and cannot write auth_user_id at all
- created_at and updated_at ignore whatever the client sent, and logged_at does not
- anon reads nothing at all and cannot reach the auth binding function

## Decisions worth knowing

**A client cannot read the `trainers` table at all.** They get `display_name`, `brand_color`,
and `logo_url` from `public.trainer_branding()`, and nothing else. This is an RPC rather than a
column grant because grants are per role, and both trainers and clients are the same
`authenticated` role, so no grant can say "clients see three columns, trainers see seven".
`auth_user_id` is additionally left out of the column grant entirely, so it is unreadable
through the API by anyone, trainer included. Nothing needs it: a signed in user already knows
their own `auth.uid()`, and the mapping is resolved server side by the helpers.

**There are no invite codes. Supabase auth is the only way in.** A trainer creates a client row
with a name and an email. The row sits there with `auth_user_id` null, and can be programmed
and assigned in that state. When that person signs up, a trigger on `auth.users` binds them on
the email match.

**Binding is one way.** `ptc.handle_new_auth_user` only ever binds a row whose `auth_user_id`
is still null, and the column grant in 0002 means no client of the API can write that column at
all, so a bound row cannot be unbound and handed to somebody else. A trainer can still fix a
typo'd email, which they need, but fixing it after acceptance changes nothing about who the row
belongs to.

**A trigger, not an RPC.** It fires on every path into `auth.users`, including the admin invite
path where our own code is not running because the person is clicking a link in an email and
setting a password on a hosted page. It also leaves no window in which an authenticated user
exists with neither a trainer nor a client row, which would be an account that cannot repair
itself because it has no row and therefore no permissions. The cost is that a bug here breaks
signup outright, which is why the logic sits in `handle_new_auth_user` taking plain arguments,
so the test can call it without fabricating an `auth.users` row.

**Anyone who signs up without a pending invite becomes a trainer.** Correct for a product with
no public client signup, and the thing to revisit if one ever appears.

**`clients.email` is globally unique, case insensitively.** `ptc.current_client_id()` resolves
one auth user to one client row, so a second match would make "which client am I"
nondeterministic. The cost is that one person cannot be a client of two trainers here.
Reversing it means dropping the index, adding `unique (trainer_id, lower(email))`, and teaching
the resolver to return a set.

**Timestamps are the server's.** `created_at` and `updated_at` are stamped by a trigger and
whatever arrived is discarded, because a browser clock is attacker controlled and conflict
resolution is last write wins on `updated_at`. A client sending a year from now would otherwise
win every future conflict on that row permanently. This does change what last write wins means:
the last write to reach the server, not the last edit made on a device. `logged_at` stays
client supplied, because it records when a set actually happened and offline logging is the
entire reason it exists separately.

**A client can read their own trainer's custom exercises.** This is `exercises_select`'s third
clause and it is load bearing rather than convenience: the logging screen reads `increment_kg`
live from `exercises`, not from `assignments.snapshot`, so without it a trainer adding a
custom lift would leave that client's stepper moving by a default the gym cannot make. The
isolation test asserts both halves, that the client reads their trainer's custom lift and none
of another trainer's.

**A client cannot read `program_templates` at all**, not even the one assigned to them. What
they are meant to do reaches them through `assignments.snapshot`. That is the mandatory
snapshot doing a second job beyond freezing history, and it is why the snapshot cannot become
optional later.

**A client cannot read their own payments.** CLAUDE.md lists payments alongside templates as
out of reach, and a payment row carries the trainer's billing relationship rather than just
this client's side of it.

**`auth_user_id` is a plain uuid, not a foreign key to `auth.users`.** CLAUDE.md specifies a
plain uuid. It also means the isolation test can run without fabricating auth rows. The cost is
no cascade when a user is deleted, which needs handling whenever account deletion gets built.

**The ownership helpers in the `ptc` schema are `security definer` and executable by
`authenticated`.** That is not optional: a policy expression runs as the querying role, so the
role has to be able to call them. It does mean a logged in user who already knows a session
uuid could learn which client it belongs to. Version 4 uuids are not guessable, so this is
accepted rather than solved, but it is the reason those functions take an id and return a
single id instead of returning rows.

**No `updated_at` trigger.** Conflict resolution is last write wins on `updated_at`, and the
value that has to win is the one written on the device when the edit happened, possibly hours
before it synced. A trigger stamping `now()` on arrival would make every sync look like the
newest edit and silently reverse the rule.

**Every zero argument helper is called as `(select fn())` inside a policy.** Postgres hoists a
scalar subquery into an InitPlan and evaluates it once per statement. Unwrapped, a trainer
scanning a year of `set_logs` calls the function once per row examined. Helpers that take a
column as an argument cannot be hoisted, because the answer depends on the row, so those are
used only where the alternative is worse and each is a primary key lookup.

**Every column a policy filters on is indexed.** All eighteen of them, verified against
`0001_schema.sql`: primary keys, the two unique `auth_user_id` columns, `clients.email`,
and the explicit indexes on `trainer_id`, `client_id`, `session_id`, `template_id`, `day_id`,
and `is_global`. No extra index migration was needed.

**`alter default privileges` on both `ptc` and `public`.** `revoke on all functions` only
covers functions that exist at the moment it runs, and a newly created function defaults to
`execute` for `public`. Without this, the next migration to add a helper would quietly ship it
world callable.

## Not done here

Step 4 is the adapter swap: a Supabase backend behind the same five methods, wired in through
`storage.setRemote()`, plus magic link auth. `storage.sync()` already reports
`{ remote: false }` and holds the outbox intact, waiting for it.
