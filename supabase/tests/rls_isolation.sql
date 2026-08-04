-- Row level security isolation test. Runs before any release, per CLAUDE.md.
--
-- The rule this exists to prove: "Write a test that logs in as client A and attempts to read
-- client B's set_logs. It must return zero rows."
--
-- Every denial below is paired with a positive control. A policy set that denied everything
-- would pass the negative half of this test perfectly, and would also ship an app where no
-- client can see their own training. Zero rows is only meaningful next to a non-zero.
--
-- Safe to run against a live database. Everything happens inside one transaction that ends in
-- a rollback, and any failure raises, which aborts the transaction anyway. Nothing persists
-- either way. The fixture uuids are fixed and obviously synthetic, so a collision with real
-- data fails loudly rather than corrupting anything.
--
-- How to run: paste the whole file into the Supabase SQL editor and execute. A pass prints one
-- row saying so. A failure raises with the name of the check that broke.

begin;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise exception 'auth.uid() is missing. Run this against a Supabase database, not a bare Postgres.';
  end if;
  if to_regprocedure('ptc.handle_new_auth_user(uuid,text,jsonb)') is null then
    raise exception '0003_rpc.sql has not been run yet.';
  end if;
end $$;

-- ---------------------------------------------------------------- fixtures
-- Built as the owner, which has bypassrls, so the policies are not in the way while setting up.

insert into public.trainers (id, auth_user_id, display_name, brand_color, weight_unit) values
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Trainer One', '#FF8A45', 'kg'),
  ('10000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Trainer Two', '#6DD0E4', 'kg');

-- A and B share a trainer, which is the case that actually matters. C belongs to a different
-- trainer, which catches a policy that isolates by trainer but not by client. D has never
-- accepted, which is the state a client row sits in between being created and being claimed.
insert into public.clients (id, trainer_id, auth_user_id, display_name, email, status, weight_unit) values
  ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Client A', 'client.a@example.com', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Client B', 'client.b@example.com', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Client C', 'client.c@example.com', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000d', '10000000-0000-4000-8000-000000000001', null,                                   'Client D', 'client.d@example.com', 'invited', 'kg');

-- One shared library lift, plus a custom lift for each trainer. The custom pair is what proves
-- a client can read their own trainer's exercises and none of anybody else's, which is what
-- keeps increment_kg reaching the steppers.
insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, is_global, increment_kg) values
  ('30000000-0000-4000-8000-000000000001', null, 'Barbell Back Squat', 'barbell-back-squat', 'quadriceps', 'barbell', true, 2.5),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Trap Bar Deadlift', 'trap-bar-deadlift', 'hamstrings', 'barbell', false, 5),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Belt Squat', 'belt-squat', 'quadriceps', 'machine', false, 10);

insert into public.program_templates (id, trainer_id, name, notes) values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Foundations', '');

-- Assigned to client D, who has never signed up. The trainer built this and handed it over
-- before that person had an account, which is the flow the whole email binding exists for.
insert into public.assignments (id, client_id, template_id, snapshot, starts_on) values
  ('80000000-0000-4000-8000-00000000000d', '20000000-0000-4000-8000-00000000000d',
   '60000000-0000-4000-8000-000000000001', '{"days":[]}'::jsonb, current_date);

insert into public.sessions (id, client_id, day_index, started_at) values
  ('40000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', 0, now()),
  ('40000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b', 0, now()),
  ('40000000-0000-4000-8000-00000000000c', '20000000-0000-4000-8000-00000000000c', 0, now());

insert into public.set_logs (id, session_id, exercise_id, set_index, weight_kg, reps, is_warmup, logged_at, is_void, device_id) values
  ('50000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001', 0, 100, 5, false, now(), false, 'dev-a'),
  ('50000000-0000-4000-8000-00000000000b', '40000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-000000000001', 0, 140, 3, false, now(), false, 'dev-b'),
  ('50000000-0000-4000-8000-00000000000c', '40000000-0000-4000-8000-00000000000c', '30000000-0000-4000-8000-000000000001', 0, 60, 8, false, now(), false, 'dev-c');

insert into public.payments (id, trainer_id, client_id, client_name_text, paid_on, amount_cents, method) values
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000a', 'Client A', current_date, 8000, 'e-transfer');

-- ================================================================ as client A

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

do $$
declare n bigint; blocked boolean; v_name text; v_color text;
begin
  -- positive control first. If this is zero the app is broken even though the denials pass.
  select count(*) into n from public.set_logs where session_id = '40000000-0000-4000-8000-00000000000a';
  if n <> 1 then raise exception 'client A cannot read their own set_logs (got %), policies are too tight', n; end if;

  -- THE RULE. Client A reads client B's set_logs. Must be zero.
  select count(*) into n from public.set_logs where session_id = '40000000-0000-4000-8000-00000000000b';
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read % of client B set_logs', n; end if;

  -- and unfiltered, in case the policy only leaks when the where clause is absent
  select count(*) into n from public.set_logs;
  if n <> 1 then raise exception 'ISOLATION FAILURE: an unfiltered set_logs select returned % rows for client A', n; end if;

  select count(*) into n from public.set_logs where session_id = '40000000-0000-4000-8000-00000000000c';
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read another trainer client set_logs'; end if;

  select count(*) into n from public.sessions;
  if n <> 1 then raise exception 'ISOLATION FAILURE: client A sees % sessions, expected only their own', n; end if;

  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'ISOLATION FAILURE: client A sees % client rows, expected only their own', n; end if;

  select count(*) into n from public.program_templates;
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read % program_templates', n; end if;

  select count(*) into n from public.payments;
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read % payments', n; end if;

  -- ---- exercises. The steppers depend on this, so both halves are asserted.
  select count(*) into n from public.exercises where id = '30000000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'client A cannot read the shared exercise library'; end if;

  -- their own trainer's custom lift, which carries increment_kg for the stepper
  select count(*) into n from public.exercises where id = '30000000-0000-4000-8000-000000000002';
  if n <> 1 then
    raise exception 'client A cannot read their own trainer custom exercise, so increment_kg never reaches the stepper';
  end if;

  select count(*) into n from public.exercises where id = '30000000-0000-4000-8000-000000000003';
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read another trainer custom exercise'; end if;

  select count(*) into n from public.exercises;
  if n <> 2 then raise exception 'client A sees % exercises, expected the global one plus their trainer one', n; end if;

  -- ---- trainers. No row access at all, and the auth_user_id column is not even granted.
  select count(*) into n from public.trainers;
  if n <> 0 then raise exception 'ISOLATION FAILURE: client A read % trainer rows', n; end if;

  blocked := false;
  begin
    perform auth_user_id from public.trainers;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'ISOLATION FAILURE: client A can select trainers.auth_user_id'; end if;

  -- branding still reaches them, through the rpc, three columns and no more
  select display_name, brand_color into v_name, v_color from public.trainer_branding();
  if v_name is distinct from 'Trainer One' or v_color is distinct from '#FF8A45' then
    raise exception 'client A cannot read their trainer branding (got %, %)', v_name, v_color;
  end if;

  -- ---- writes
  blocked := false;
  begin
    insert into public.set_logs (id, session_id, exercise_id, set_index, weight_kg, reps, is_warmup, logged_at, is_void, device_id)
    values ('5f000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-000000000001', 9, 999, 1, false, now(), false, 'dev-a');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'ISOLATION FAILURE: client A wrote a set into client B session'; end if;

  insert into public.set_logs (id, session_id, exercise_id, set_index, weight_kg, reps, is_warmup, logged_at, is_void, device_id)
  values ('5f000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001', 1, 100, 5, false, now(), false, 'dev-a');

  -- append only, enforced at the database rather than trusted to the client
  blocked := false;
  begin
    update public.set_logs set reps = 99 where id = '50000000-0000-4000-8000-00000000000a';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'APPEND ONLY FAILURE: client A updated a set_log'; end if;

  blocked := false;
  begin
    delete from public.set_logs where id = '50000000-0000-4000-8000-00000000000a';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'APPEND ONLY FAILURE: client A deleted a set_log'; end if;
end $$;

reset role;

-- ================================================================ as trainer One

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

do $$
declare n bigint; blocked boolean;
begin
  select count(*) into n from public.clients;
  if n <> 3 then raise exception 'trainer One sees % clients, expected 3', n; end if;

  select count(*) into n from public.clients where id = '20000000-0000-4000-8000-00000000000c';
  if n <> 0 then raise exception 'ISOLATION FAILURE: trainer One read another trainer client'; end if;

  select count(*) into n from public.set_logs;
  if n <> 3 then raise exception 'trainer One sees % set_logs across their clients, expected 3', n; end if;

  select count(*) into n from public.set_logs where session_id = '40000000-0000-4000-8000-00000000000c';
  if n <> 0 then raise exception 'ISOLATION FAILURE: trainer One read another trainer set_logs'; end if;

  select count(*) into n from public.payments;
  if n <> 1 then raise exception 'trainer One sees % payments, expected 1', n; end if;

  select count(*) into n from public.program_templates;
  if n <> 1 then raise exception 'trainer One sees % templates, expected 1', n; end if;

  select count(*) into n from public.assignments;
  if n <> 1 then raise exception 'trainer One sees % assignments, expected 1', n; end if;

  select count(*) into n from public.trainers;
  if n <> 1 then raise exception 'trainer One sees % trainer rows, expected only their own', n; end if;

  -- the column grant applies to everyone, trainers included
  blocked := false;
  begin
    perform auth_user_id from public.trainers;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'trainers.auth_user_id is selectable, the column grant did not apply'; end if;

  select count(*) into n from public.exercises;
  if n <> 2 then raise exception 'trainer One sees % exercises, expected the global one plus their own', n; end if;
end $$;

reset role;

-- ================================================================ as trainer Two

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);

do $$
declare n bigint;
begin
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'ISOLATION FAILURE: trainer Two sees % clients, expected only their own 1', n; end if;

  select count(*) into n from public.payments;
  if n <> 0 then raise exception 'ISOLATION FAILURE: trainer Two read % of another trainer payments', n; end if;

  select count(*) into n from public.program_templates;
  if n <> 0 then raise exception 'ISOLATION FAILURE: trainer Two read another trainer templates'; end if;

  select count(*) into n from public.set_logs;
  if n <> 1 then raise exception 'ISOLATION FAILURE: trainer Two sees % set_logs, expected only client C 1', n; end if;

  select count(*) into n from public.exercises where id = '30000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'ISOLATION FAILURE: trainer Two read another trainer custom exercise'; end if;
end $$;

reset role;

-- ================================================================ accepting an invite
--
-- No codes. The trainer creates a row with a name and an email, and it waits. When that person
-- signs up, the auth trigger binds them on the email match. Called here as the plain function
-- rather than by inserting into auth.users, so the test does not depend on the shape of a
-- Supabase internal table.

do $$
declare outcome text; n bigint;
begin
  -- the whole point: a program is waiting before the person has ever signed up
  select count(*) into n from public.assignments where client_id = '20000000-0000-4000-8000-00000000000d';
  if n <> 1 then raise exception 'client D should have an assignment waiting before signup, got %', n; end if;

  select count(*) into n from public.clients
   where id = '20000000-0000-4000-8000-00000000000d' and auth_user_id is null and status = 'invited';
  if n <> 1 then raise exception 'client D should be unclaimed before signup'; end if;

  -- signing up with a matching address binds, case insensitively
  outcome := ptc.handle_new_auth_user('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Client.D@Example.COM', '{}'::jsonb);
  if outcome <> 'client' then raise exception 'expected a client binding, got %', outcome; end if;

  select count(*) into n from public.clients
   where id = '20000000-0000-4000-8000-00000000000d'
     and auth_user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     and status = 'active';
  if n <> 1 then raise exception 'client D did not bind on the email match'; end if;

  -- and no trainer was created for them
  select count(*) into n from public.trainers where auth_user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if n <> 0 then raise exception 'an invited client was also made a trainer'; end if;

  -- running it again changes nothing
  outcome := ptc.handle_new_auth_user('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'client.d@example.com', '{}'::jsonb);
  if outcome <> 'client_exists' then raise exception 'a repeat bind returned %', outcome; end if;
  select count(*) into n from public.clients where auth_user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if n <> 1 then raise exception 'a repeat bind produced % client rows', n; end if;
end $$;

-- everything that was waiting is now theirs, read through the policies as themselves
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","role":"authenticated"}', true);

do $$
declare n bigint;
begin
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'a newly bound client sees % client rows, expected only their own', n; end if;

  select count(*) into n from public.clients where id = '20000000-0000-4000-8000-00000000000d';
  if n <> 1 then raise exception 'a newly bound client cannot see their own row'; end if;

  select count(*) into n from public.assignments;
  if n <> 1 then raise exception 'the program assigned before signup did not reach the client, saw %', n; end if;

  -- and the binding gave them nothing belonging to anybody else
  select count(*) into n from public.set_logs;
  if n <> 0 then raise exception 'ISOLATION FAILURE: a newly bound client reads % set_logs', n; end if;

  select count(*) into n from public.program_templates;
  if n <> 0 then raise exception 'ISOLATION FAILURE: a newly bound client reads program_templates'; end if;
end $$;

reset role;

-- an already accepted row is never rebound, which is what stops a typo from handing months of
-- history to whoever answers the second invite
do $$
declare outcome text; n bigint;
begin
  outcome := ptc.handle_new_auth_user('99999999-9999-4999-8999-999999999999', 'client.a@example.com', '{}'::jsonb);
  select count(*) into n from public.clients
   where id = '20000000-0000-4000-8000-00000000000a' and auth_user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if n <> 1 then raise exception 'BINDING FAILURE: an accepted client row was rebound to a new account'; end if;
  if outcome <> 'trainer' then
    raise exception 'a signup on a taken address should fall through to a trainer, got %', outcome;
  end if;
end $$;

-- ================================================================ signing up as a trainer

do $$
declare outcome text; n bigint; v_name text;
begin
  outcome := ptc.handle_new_auth_user('77777777-7777-4777-8777-777777777777', 'coach@example.com',
                                      '{"display_name":"Coach Iqbal"}'::jsonb);
  if outcome <> 'trainer' then raise exception 'expected a trainer, got %', outcome; end if;

  select count(*), max(display_name) into n, v_name
    from public.trainers where auth_user_id = '77777777-7777-4777-8777-777777777777';
  if n <> 1 then raise exception 'a signup produced % trainer rows, expected exactly 1', n; end if;
  if v_name <> 'Coach Iqbal' then raise exception 'display name came through as %', v_name; end if;

  -- the same person signing up again produces nothing new
  outcome := ptc.handle_new_auth_user('77777777-7777-4777-8777-777777777777', 'coach@example.com', '{}'::jsonb);
  if outcome <> 'trainer_exists' then raise exception 'a repeat signup returned %', outcome; end if;

  select count(*) into n from public.trainers where auth_user_id = '77777777-7777-4777-8777-777777777777';
  if n <> 1 then raise exception 'a repeat signup produced % trainer rows, expected 1', n; end if;

  -- with no display name in the metadata, the address carries it rather than a blank
  outcome := ptc.handle_new_auth_user('88888888-8888-4888-8888-888888888888', 'sam.rivera@example.com', '{}'::jsonb);
  select max(display_name) into v_name from public.trainers where auth_user_id = '88888888-8888-4888-8888-888888888888';
  if v_name <> 'sam.rivera' then raise exception 'fallback display name was %', v_name; end if;

  -- a signup with no address does nothing at all rather than creating a nameless trainer
  outcome := ptc.handle_new_auth_user('66666666-6666-4666-8666-666666666666', null, '{}'::jsonb);
  if outcome <> 'skipped' then raise exception 'a signup with no email returned %', outcome; end if;
  select count(*) into n from public.trainers where auth_user_id = '66666666-6666-4666-8666-666666666666';
  if n <> 0 then raise exception 'a signup with no email created a trainer'; end if;
end $$;

-- ================================================================ the binding is not writable
--
-- A trainer can fix a typo in an email, and cannot touch the binding it produced.

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

do $$
declare blocked boolean; n bigint;
begin
  -- fixing an address is allowed, since a typo has to be repairable
  update public.clients set email = 'fixed@example.com'
   where id = '20000000-0000-4000-8000-00000000000b';
  select count(*) into n from public.clients where email = 'fixed@example.com';
  if n <> 1 then raise exception 'a trainer cannot correct a client email'; end if;

  -- unbinding is not, which is the whole protection
  blocked := false;
  begin
    update public.clients set auth_user_id = null where id = '20000000-0000-4000-8000-00000000000a';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'BINDING FAILURE: a trainer cleared a client auth_user_id'; end if;

  blocked := false;
  begin
    update public.clients set auth_user_id = '11111111-1111-4111-8111-111111111111'
     where id = '20000000-0000-4000-8000-00000000000a';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'BINDING FAILURE: a trainer reassigned a client auth_user_id'; end if;
end $$;

reset role;

-- ================================================================ timestamps are the server's
--
-- A browser clock is attacker controlled and conflict resolution is last write wins on
-- updated_at, so a client that sends a year from now would win every future conflict on that
-- row forever.

do $$
declare v_created timestamptz; v_updated timestamptz;
begin
  insert into public.exercises (id, created_at, updated_at, trainer_id, name, slug, primary_muscle,
                                equipment, is_global, increment_kg)
  values ('3f000000-0000-4000-8000-000000000001', '2099-01-01', '2099-01-01', null,
          'Time Travel Press', 'time-travel-press', 'none', 'none', true, 2.5);

  select created_at, updated_at into v_created, v_updated
    from public.exercises where id = '3f000000-0000-4000-8000-000000000001';

  if v_created > now() then raise exception 'a client supplied created_at of % survived', v_created; end if;
  if v_updated > now() then raise exception 'a client supplied updated_at of % survived', v_updated; end if;

  -- and created_at cannot be rewritten by a later update
  update public.exercises set name = 'Renamed', created_at = '2099-01-01'
   where id = '3f000000-0000-4000-8000-000000000001';
  select created_at into v_created from public.exercises where id = '3f000000-0000-4000-8000-000000000001';
  if v_created > now() then raise exception 'an update rewrote created_at to %', v_created; end if;
end $$;

-- logged_at stays client supplied, because it records when a set actually happened and offline
-- logging is the entire reason it exists separately from created_at.
do $$
declare v_logged timestamptz; v_created timestamptz;
begin
  insert into public.set_logs (id, created_at, session_id, exercise_id, set_index, weight_kg, reps,
                               is_warmup, logged_at, is_void, is_extra, device_id)
  values ('5e000000-0000-4000-8000-000000000001', '2099-01-01', '40000000-0000-4000-8000-00000000000a',
          '30000000-0000-4000-8000-000000000001', 7, 100, 5, false, '2026-01-01T09:00:00Z', false, false, 'dev');

  select logged_at, created_at into v_logged, v_created
    from public.set_logs where id = '5e000000-0000-4000-8000-000000000001';

  if v_logged <> '2026-01-01T09:00:00Z'::timestamptz then
    raise exception 'logged_at was overwritten, offline logging depends on it';
  end if;
  if v_created > now() then raise exception 'created_at on a set log was not stamped by the server'; end if;
end $$;

-- ================================================================ as anon
-- Nobody is logged in. Every read in this product is somebody's private training data.

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare n bigint; blocked boolean;
begin
  -- Reads here fail on the grant rather than the policy, since anon was revoked outright.
  -- Either outcome is a pass, so both are folded into zero.
  begin
    select count(*) into n from public.set_logs;
  exception when insufficient_privilege then n := 0;
  end;
  if n <> 0 then raise exception 'ISOLATION FAILURE: anon read % set_logs', n; end if;

  begin
    select count(*) into n from public.clients;
  exception when insufficient_privilege then n := 0;
  end;
  if n <> 0 then raise exception 'ISOLATION FAILURE: anon read % clients', n; end if;

  begin
    select count(*) into n from public.exercises;
  exception when insufficient_privilege then n := 0;
  end;
  if n <> 0 then raise exception 'ISOLATION FAILURE: anon read % exercises', n; end if;

  -- and cannot reach the function that decides who a new auth user is
  blocked := false;
  begin
    perform ptc.handle_new_auth_user('55555555-5555-4555-8555-555555555555', 'client.d@example.com', '{}'::jsonb);
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'ISOLATION FAILURE: anon called the auth binding function'; end if;
end $$;

reset role;

select 'RLS isolation: all checks passed' as result;

rollback;
