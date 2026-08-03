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
3. `migrations/0003_rpc.sql` adds `claim_invite` and `trainer_branding`, the two things a
   client needs that a policy cannot express.
4. `tests/rls_isolation.sql` proves the policies actually isolate. It checks that 0003 ran, so
   it fails fast rather than confusingly if the order slipped.

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
- an unbound signed in user sees nothing, claims a valid unclaimed code, becomes exactly one
  client, and gains no access to anybody else
- the same code cannot be claimed twice, an unknown code is refused, an account that already
  has a client row cannot claim a second, and a failed claim leaves the caller seeing nothing
- anon reads nothing at all and cannot claim an invite

## Decisions worth knowing

**A client cannot read the `trainers` table at all.** They get `display_name`, `brand_color`,
and `logo_url` from `public.trainer_branding()`, and nothing else. This is an RPC rather than a
column grant because grants are per role, and both trainers and clients are the same
`authenticated` role, so no grant can say "clients see three columns, trainers see seven".
`auth_user_id` is additionally left out of the column grant entirely, so it is unreadable
through the API by anyone, trainer included. Nothing needs it: a signed in user already knows
their own `auth.uid()`, and the mapping is resolved server side by the helpers.

**Claiming an invite never reads through RLS.** No policy can grant "read the row whose
`invite_code` you happen to know" without also granting the ability to fish for other people's
rows one code at a time. So `claim_invite(code)` takes a code and returns an id or an error,
and the caller never sees a row they do not already own. The update carries
`and auth_user_id is null` in its own where clause rather than trusting the check above it, so
two devices submitting the same code at the same moment cannot both succeed. A bad code and an
already claimed code produce the same message, so the function is not an oracle for which
codes are real.

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
`0001_schema.sql`: primary keys, the two unique `auth_user_id` columns, `clients.invite_code`,
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
