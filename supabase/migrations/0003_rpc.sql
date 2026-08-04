-- Auth. How a person in auth.users becomes a trainer or a client, and how a client sees their
-- trainer's branding.
--
-- There are no invite codes. Supabase auth is the only path in.

-- ---------------------------------------------------------------- becoming somebody
--
-- One function decides what a new auth user is, because it is one question with one answer and
-- splitting it across two mechanisms invites a user who is somehow both or neither.
--
-- The order matters:
--   1. already a client        nothing to do, this is a repeat
--   2. already a trainer       nothing to do, this is a repeat
--   3. an unclaimed client row matches the email       bind it, they are a client
--   4. otherwise                                       create a trainer
--
-- Step 3 before step 4 is what makes an invited person a client rather than a second trainer.
-- Steps 1 and 2 are what make the whole thing idempotent: running it twice for the same user
-- produces exactly the same rows as running it once.
--
-- Step 4 means anyone who signs up without a pending invite becomes a trainer. That is right
-- for a self serve product with no public client signup, and it is the thing to revisit if a
-- public signup page ever appears.
--
-- Binding requires auth_user_id to be null, so a client row that somebody already accepted can
-- never be rebound to a different account. Combined with the column grant in 0002, which does
-- not let any client of the API write auth_user_id at all, a binding is one way and permanent.

create or replace function ptc.handle_new_auth_user(
  p_user_id uuid,
  p_email text,
  p_meta jsonb default '{}'::jsonb
) returns text
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_bound integer;
  v_name text;
begin
  if p_user_id is null or coalesce(p_email, '') = '' then
    return 'skipped';
  end if;

  if exists (select 1 from public.clients where auth_user_id = p_user_id) then
    return 'client_exists';
  end if;

  if exists (select 1 from public.trainers where auth_user_id = p_user_id) then
    return 'trainer_exists';
  end if;

  -- Case insensitive, because an email address is. clients.email carries a unique index on
  -- lower(email), so this matches at most one row.
  update public.clients
     set auth_user_id = p_user_id,
         status = 'active'
   where lower(email) = lower(p_email)
     and auth_user_id is null;

  get diagnostics v_bound = row_count;
  if v_bound > 0 then
    return 'client';
  end if;

  -- Nobody invited them, so they are here to coach. gen_random_uuid() is core Postgres from
  -- 13 onward, not pgcrypto. Generating this id server side does not break the client side id
  -- rule, which exists so an offline write replays idempotently: a trainer row created by a
  -- signup has no offline origin and is never replayed.
  v_name := coalesce(
    nullif(trim(p_meta ->> 'display_name'), ''),
    nullif(split_part(p_email, '@', 1), ''),
    'Trainer'
  );

  insert into public.trainers (id, auth_user_id, display_name, brand_color, weight_unit)
  values (
    gen_random_uuid(),
    p_user_id,
    v_name,
    coalesce(nullif(trim(p_meta ->> 'brand_color'), ''), '#ff8a45'),
    case when p_meta ->> 'weight_unit' = 'lb' then 'lb' else 'kg' end
  )
  on conflict (auth_user_id) do nothing;

  return 'trainer';
end $$;

-- ---------------------------------------------------------------- the trigger
--
-- A trigger on auth.users rather than an RPC the app calls after signing up, for three
-- reasons.
--
-- It fires on every path in. Supabase creates users from a password signup, a magic link, an
-- admin invite sent by a trainer, and an OAuth callback. An RPC only covers the paths our own
-- code drives, and the invite path is precisely the one where our code is not running: the
-- person clicks a link in an email and sets a password on a hosted page.
--
-- There is no window. With an RPC there is a moment where an authenticated user exists with no
-- trainer and no client row, and if the tab closes in that moment the account is stranded with
-- no way to repair itself, because a stranded user has no row and therefore no permissions.
--
-- It fails loudly. If this function raises, the signup fails and Supabase reports an error,
-- which is better than a half created account that looks fine until the first query returns
-- nothing.
--
-- The cost is that a bug here breaks signup entirely, and the error surfaces as a generic
-- database error. That is why the logic lives in handle_new_auth_user, which takes plain
-- arguments and can be called directly by the test without fabricating an auth.users row.

create or replace function ptc.on_auth_user_created() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform ptc.handle_new_auth_user(new.id, new.email, coalesce(new.raw_user_meta_data, '{}'::jsonb));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function ptc.on_auth_user_created();

-- ---------------------------------------------------------------- trainer branding
--
-- A client needs their trainer's name and brand colour to render an export card, and nothing
-- else. A column grant cannot express that, because grants are per role and both trainers and
-- clients are `authenticated`. So the clients policy on trainers stays trainer only and this
-- returns the three columns, for one trainer, to the one client who belongs to them.
--
-- Returns zero rows for a caller who is not a client, including a trainer.

create or replace function public.trainer_branding()
  returns table (display_name text, brand_color text, logo_url text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select t.display_name, t.brand_color, t.logo_url
  from public.trainers t
  where t.id = (select ptc.current_client_trainer_id())
$$;

-- ---------------------------------------------------------------- grants
--
-- 0002 already revoked execute on everything in public from anon and authenticated, but that
-- ran before these existed, and a new function defaults to execute for public.
--
-- handle_new_auth_user is deliberately not granted to anyone. It is called by the trigger,
-- which runs as the definer, and by the test, which runs as the owner. No client of the API
-- can invoke it, so nobody can bind themselves to a client row by calling it directly.

revoke all on function ptc.handle_new_auth_user(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function ptc.on_auth_user_created() from public, anon, authenticated;

revoke all on function public.trainer_branding() from public, anon;
grant execute on function public.trainer_branding() to authenticated;

-- Same guard as ptc: anything added to public later starts closed rather than open.
alter default privileges in schema public revoke execute on functions from public;
