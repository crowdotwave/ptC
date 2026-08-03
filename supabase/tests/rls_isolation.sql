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
  if to_regprocedure('public.claim_invite(text)') is null then
    raise exception '0003_rpc.sql has not been run yet.';
  end if;
end $$;

-- ---------------------------------------------------------------- fixtures
-- Built as the owner, which has bypassrls, so the policies are not in the way while setting up.

insert into public.trainers (id, auth_user_id, display_name, brand_color, weight_unit) values
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Trainer One', '#FF8A45', 'kg'),
  ('10000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Trainer Two', '#6DD0E4', 'kg');

-- A and B share a trainer, which is the case that actually matters. C belongs to a different
-- trainer, which catches a policy that isolates by trainer but not by client. D is unclaimed,
-- for the invite tests.
insert into public.clients (id, trainer_id, auth_user_id, display_name, invite_code, status, weight_unit) values
  ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Client A', 'CODE-AAA', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Client B', 'CODE-BBB', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Client C', 'CODE-CCC', 'active', 'kg'),
  ('20000000-0000-4000-8000-00000000000d', '10000000-0000-4000-8000-000000000001', null,                                   'Client D', 'CODE-DDD', 'invited', 'kg');

-- One shared library lift, plus a custom lift for each trainer. The custom pair is what proves
-- a client can read their own trainer's exercises and none of anybody else's, which is what
-- keeps increment_kg reaching the steppers.
insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, is_global, increment_kg) values
  ('30000000-0000-4000-8000-000000000001', null, 'Barbell Back Squat', 'barbell-back-squat', 'quadriceps', 'barbell', true, 2.5),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Trap Bar Deadlift', 'trap-bar-deadlift', 'hamstrings', 'barbell', false, 5),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Belt Squat', 'belt-squat', 'quadriceps', 'machine', false, 10);

insert into public.program_templates (id, trainer_id, name, notes) values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Foundations', '');

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

-- ================================================================ claiming an invite
-- A signed in user with no client row yet. This is the only moment a client touches a row
-- before they own it, so it is the only place the binding can go wrong.

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","role":"authenticated"}', true);

do $$
declare n bigint; v_id uuid; blocked boolean;
begin
  -- before claiming, an unbound user sees nothing at all
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'ISOLATION FAILURE: an unbound user sees % client rows', n; end if;

  -- a valid unclaimed code binds the row
  select public.claim_invite('CODE-DDD') into v_id;
  if v_id is distinct from '20000000-0000-4000-8000-00000000000d' then
    raise exception 'claim_invite returned %, expected client D', v_id;
  end if;

  -- and now they are that client, and only that client
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'ISOLATION FAILURE: after claiming, the client sees % rows, expected 1', n; end if;

  select count(*) into n from public.clients where id = '20000000-0000-4000-8000-00000000000d';
  if n <> 1 then raise exception 'after claiming, the client cannot see their own row'; end if;

  -- claiming did not open a door to anybody else
  select count(*) into n from public.set_logs;
  if n <> 0 then raise exception 'ISOLATION FAILURE: newly claimed client D sees % set_logs', n; end if;

  select count(*) into n from public.trainers;
  if n <> 0 then raise exception 'ISOLATION FAILURE: newly claimed client D read % trainer rows', n; end if;

  -- a second code cannot be claimed by an account that already has a client row
  blocked := false;
  begin
    perform public.claim_invite('CODE-AAA');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'a claimed account claimed a second invite code'; end if;
end $$;

reset role;

-- a different signed in user, on the code that was just taken
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","role":"authenticated"}', true);

do $$
declare n bigint; blocked boolean;
begin
  blocked := false;
  begin
    perform public.claim_invite('CODE-DDD');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'ISOLATION FAILURE: an already claimed invite code was claimed again'; end if;

  blocked := false;
  begin
    perform public.claim_invite('NO-SUCH-CODE');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'an unknown invite code was accepted'; end if;

  -- a failed claim leaves them bound to nothing and seeing nothing
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'ISOLATION FAILURE: a failed claim exposed % client rows', n; end if;
end $$;

reset role;

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

  -- and cannot claim an invite without signing in first
  blocked := false;
  begin
    perform public.claim_invite('CODE-AAA');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'ISOLATION FAILURE: anon claimed an invite code'; end if;
end $$;

reset role;

select 'RLS isolation: all checks passed' as result;

rollback;
