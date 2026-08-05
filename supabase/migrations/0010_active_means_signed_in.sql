-- 'active' should mean somebody signed in, not that somebody typed their address.
--
-- 0001 through 0009 are applied, so this is a new file rather than an edit in place.
--
-- Supabase creates the auth.users row when a sign in link is requested, not when it is used, and
-- the binding trigger fires on that insert. Measured on a real account: the row appeared at
-- 06:47:13 and confirmed_at landed at 06:48:27, seventy four seconds later when the link was
-- actually clicked.
--
-- Binding at request time is correct and stays. It is what lets a program be waiting the moment
-- somebody arrives, and it leaks nothing: the user is unconfirmed, no session exists, and every
-- policy keys off auth.uid(), which requires one.
--
-- What was wrong is that the same trigger set clients.status = 'active'. Anybody who typed a
-- pending client's address into the sign in box would flip that row to active forever, and
-- 'invited' is the only signal a trainer has for "this person has not opened the app yet".
-- Burning it costs the trainer the one thing the column exists to tell them.

-- ---------------------------------------------------------------- binding stops claiming more
--
-- Identical to 0007 except that the client update no longer touches status. Restated in full
-- rather than patched, because a security definer function that binds identities should be
-- readable in one piece.

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

  -- Binds the person to their row. status is deliberately untouched: that is a statement about
  -- whether they have ever actually arrived, and requesting an email is not arriving.
  if not v_had_client then
    update public.clients
       set auth_user_id = p_user_id
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

  return 'none';
end $$;

revoke all on function ptc.handle_new_auth_user(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- and confirmation claims it
--
-- Keyed on email_confirmed_at rather than confirmed_at. confirmed_at is a generated column,
-- LEAST(email_confirmed_at, phone_confirmed_at), and this product has no phone sign in, so the
-- stored email column is both the thing that actually changes and the one that cannot surprise
-- us by being computed at a different point in the statement.
--
-- Only ever forwards, invited to active. A client the trainer archived is left alone, because a
-- returning sign in is not a decision to un-archive somebody.

create or replace function ptc.on_auth_user_confirmed() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.clients
     set status = 'active'
   where auth_user_id = new.id
     and status = 'invited';
  return new;
end $$;

drop trigger if exists on_auth_user_confirmed on auth.users;

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function ptc.on_auth_user_confirmed();

revoke all on function ptc.on_auth_user_confirmed() from public, anon, authenticated;

-- ---------------------------------------------------------------- nothing to backfill
--
-- Every client row already carrying 'active' belongs to somebody confirmed, and every 'invited'
-- row is genuinely unbound, so the existing data already means what this migration makes it mean.
