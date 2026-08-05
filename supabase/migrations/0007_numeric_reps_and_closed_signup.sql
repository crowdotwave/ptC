-- Half reps, and closing open signup.
--
-- 0001 through 0006 are applied, so this is a new file rather than an edit in place.

-- ---------------------------------------------------------------- reps is not an integer
--
-- From a real training log kept by hand over months:
--
--   pushups      14 - 14 - 12 - 10.5
--   pullups      6 - 6.5 - 5.5 - 6
--   shoulder fly 15 - 15 - 14.5 - 15
--
-- A half is not sloppy record keeping. It is the rep that got most of the way up, and it is the
-- difference between a session that improved and one that did not. Rounding it away would throw
-- out the exact signal the log was kept for, and rounding it up would invent a rep that was not
-- completed, which is worse.
--
-- Nothing downstream needs to change. Epley is weight times one plus reps over thirty, which does
-- not care whether reps is whole, and volume is a product. Integers already stored stay valid,
-- because every integer is a numeric.
--
-- rounds stays an integer. A round is a lap of a circuit, and half a lap is not a thing anybody
-- has written down.

alter table public.set_logs alter column reps type numeric using reps::numeric;

-- The constraint is unchanged in meaning and restated because the column type moved under it.
alter table public.set_logs drop constraint if exists set_logs_reps_check;
alter table public.set_logs add constraint set_logs_reps_check
  check (reps is null or reps > 0);

-- ---------------------------------------------------------------- signing up gets you nothing
--
-- 0003 made anyone who signed up without a pending invite into a trainer. That was right for a
-- self serve product with no public client signup, and it is wrong the moment the app is served
-- from a public URL: anybody who finds it gets an account.
--
-- The exposure was never a data leak. A stranger is not staff, belongs to no trainer, and owns
-- no clients, so every policy returns nothing for them, which was verified before this change.
-- What they did get was a trainer row and a permanent account on somebody else's project.
--
-- So an unmatched email now creates nothing and says so. The app already has a state for it:
-- boot() reports 'unbound' and the screen reads "no trainer has added this email as a client
-- yet", which is exactly true.
--
-- The cost, stated plainly because it will be surprising later: a new coach can no longer create
-- their own account. Somebody with database access has to insert a trainers row carrying their
-- email first, and the binding in 0006 picks it up on their first sign in. That is how Clay and
-- Alejandra were set up, so it is the path already in use rather than a new one. Revisit this
-- when there is a real signup page with something in front of it.

create or replace function ptc.handle_new_auth_user(
  p_user_id uuid,
  p_email text,
  p_meta jsonb default '{}'::jsonb
) returns text
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_client integer := 0;
  v_trainer integer := 0;
  v_had_client boolean;
  v_had_trainer boolean;
begin
  if p_user_id is null or coalesce(p_email, '') = '' then
    return 'skipped';
  end if;

  v_had_client  := exists (select 1 from public.clients  where auth_user_id = p_user_id);
  v_had_trainer := exists (select 1 from public.trainers where auth_user_id = p_user_id);

  -- Case insensitive, because an email address is. Both tables carry a unique index on
  -- lower(email), so each of these matches at most one row.
  if not v_had_client then
    update public.clients
       set auth_user_id = p_user_id, status = 'active'
     where lower(email) = lower(p_email) and auth_user_id is null;
    get diagnostics v_client = row_count;
  end if;

  if not v_had_trainer then
    update public.trainers
       set auth_user_id = p_user_id
     where lower(email) = lower(p_email) and auth_user_id is null;
    get diagnostics v_trainer = row_count;
  end if;

  if v_had_client or v_had_trainer then
    if v_client > 0 or v_trainer > 0 then return 'bound_additional'; end if;
    return case when v_had_trainer then 'trainer_exists' else 'client_exists' end;
  end if;

  if v_client > 0 and v_trainer > 0 then return 'both'; end if;
  if v_client > 0 then return 'client'; end if;
  if v_trainer > 0 then return 'trainer'; end if;

  -- Nobody was expecting them. The auth user still exists, because Supabase created it before
  -- this ran and raising here would turn a stranger's typo into a failed signup for everybody
  -- who mistypes their own address. They simply own nothing.
  return 'none';
end $$;

revoke all on function ptc.handle_new_auth_user(uuid, text, jsonb) from public, anon, authenticated;
