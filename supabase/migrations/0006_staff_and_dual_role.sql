-- Two people who can see everything, and one person who is both a trainer and a client.
--
-- 0001 through 0005 are applied, so this is a new file rather than an edit in place.
--
-- This is the migration that was explicitly asked for after the risk was raised, so the shape
-- matters more than usual. Three rules held throughout:
--
--   1. Nothing here bypasses row level security. Every grant below is another policy, evaluated
--      by the database on every row, which is what CLAUDE.md means by "enforced at the database,
--      not in the UI". A bypassrls role, or a UI that fetches everything and filters, would both
--      be the thing this project says is a bug.
--   2. Staff read. Staff never write. Seeing another trainer's program is a debugging need.
--      Editing one is not, and the difference is the entire blast radius.
--   3. The allowlist lives in ptc, which no API role can write to, and it is keyed on auth user
--      id rather than on an email or a flag on a public table. Nothing reachable over PostgREST
--      can add somebody to it.

-- ---------------------------------------------------------------- a trainer can be set up early
--
-- clients already works this way: a row with an email waits, and the auth trigger binds it when
-- that person first signs in. That is what lets a trainer program somebody before they have an
-- account. The same has to be true of a trainer, or the first account on a fresh deployment has
-- to be created by whoever signs up first and hopes to be the right person.
--
-- Partial unique index, because most trainer rows will have no email once this is more than two
-- people, and a plain unique index would collapse every one of those nulls into a conflict.

alter table public.trainers add column email text;

create unique index trainers_email_key on public.trainers (lower(email)) where email is not null;

-- A trainer may read and fix their own address. It is not part of the binding once bound, the
-- way auth_user_id is, so it does not need the same protection.
grant select (email), insert (email), update (email) on public.trainers to authenticated;

-- ---------------------------------------------------------------- the allowlist

create table ptc.staff (
  auth_user_id uuid primary key,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- No policies and no grants at all. ptc is revoked from public and anon in 0002, and usage is
-- granted to authenticated only so the helper functions can be called. Nothing can select from
-- this table over the API, which also means nobody can enumerate who is staff.
revoke all on table ptc.staff from public, anon, authenticated;

create or replace function ptc.is_staff() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from ptc.staff s where s.auth_user_id = auth.uid()) $$;

revoke all on function ptc.is_staff() from public, anon;
grant execute on function ptc.is_staff() to authenticated;

-- ---------------------------------------------------------------- staff read policies
--
-- Additive select policies. Policies are OR'd, so each of these widens what staff can read and
-- changes nothing for anybody else. Every one is wrapped in a scalar subquery so Postgres
-- evaluates it once per statement as an InitPlan rather than once per row, which matters most on
-- set_logs where a trainer scans a year at a time.
--
-- payments is deliberately absent. The ask was to see everyone's program and progress, and a
-- payment row is neither. It carries a billing relationship, which is the one thing here that
-- stays between a trainer and their own client.

create policy trainers_staff_select on public.trainers for select to authenticated
  using ((select ptc.is_staff()));

create policy clients_staff_select on public.clients for select to authenticated
  using ((select ptc.is_staff()));

create policy exercises_staff_select on public.exercises for select to authenticated
  using ((select ptc.is_staff()));

create policy program_templates_staff_select on public.program_templates for select to authenticated
  using ((select ptc.is_staff()));

create policy template_days_staff_select on public.template_days for select to authenticated
  using ((select ptc.is_staff()));

create policy template_items_staff_select on public.template_items for select to authenticated
  using ((select ptc.is_staff()));

create policy assignments_staff_select on public.assignments for select to authenticated
  using ((select ptc.is_staff()));

create policy sessions_staff_select on public.sessions for select to authenticated
  using ((select ptc.is_staff()));

create policy set_logs_staff_select on public.set_logs for select to authenticated
  using ((select ptc.is_staff()));

-- ---------------------------------------------------------------- whoami learns two more things
--
-- A person can now hold both roles, so the two ids were always the real answer and actor_role
-- was a summary of them. It stays for the pages that only care which home to route to, and it
-- reports 'both' rather than picking a winner, because picking one is how somebody ends up
-- unable to reach their own training.

drop function if exists public.whoami();

create or replace function public.whoami()
  returns table (actor_role text, trainer_id uuid, client_id uuid, is_staff boolean)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select
    case
      when (select ptc.current_trainer_id()) is not null
       and (select ptc.current_client_id()) is not null then 'both'
      when (select ptc.current_trainer_id()) is not null then 'trainer'
      when (select ptc.current_client_id()) is not null then 'client'
      else 'none'
    end,
    (select ptc.current_trainer_id()),
    (select ptc.current_client_id()),
    (select ptc.is_staff())
$$;

revoke all on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;

-- ---------------------------------------------------------------- binding, for both roles at once
--
-- Replaces the version in 0003. Two changes.
--
-- A trainer row can now be waiting on an email, the same way a client row can, so somebody can
-- be set up as a coach before they have ever signed in.
--
-- And a person can match both. The old function returned at the first match, which for somebody
-- who is a client of one coach and a coach in their own right would bind whichever was checked
-- first and silently strand the other row forever. Both are bound, and a new trainer is created
-- only when neither matched.
--
-- The idempotency guarantees are unchanged: already bound rows are skipped, binding requires
-- auth_user_id to be null, and running this twice for the same user produces the same rows as
-- running it once.

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
  v_name text;
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
    -- Already known here. Any binding just done is a second role arriving later, which is fine.
    if v_client > 0 or v_trainer > 0 then return 'bound_additional'; end if;
    return case when v_had_trainer then 'trainer_exists' else 'client_exists' end;
  end if;

  if v_client > 0 and v_trainer > 0 then return 'both'; end if;
  if v_client > 0 then return 'client'; end if;
  if v_trainer > 0 then return 'trainer'; end if;

  -- Nobody was expecting them, so they are here to coach. See 0003 for why that is the right
  -- default for a product with no public client signup, and what to revisit if one appears.
  v_name := coalesce(
    nullif(trim(p_meta ->> 'display_name'), ''),
    nullif(split_part(p_email, '@', 1), ''),
    'Trainer'
  );

  insert into public.trainers (id, auth_user_id, email, display_name, brand_color, weight_unit)
  values (
    gen_random_uuid(),
    p_user_id,
    lower(p_email),
    v_name,
    coalesce(nullif(trim(p_meta ->> 'brand_color'), ''), '#ff8a45'),
    case when p_meta ->> 'weight_unit' = 'lb' then 'lb' else 'kg' end
  )
  on conflict (auth_user_id) do nothing;

  return 'trainer';
end $$;

revoke all on function ptc.handle_new_auth_user(uuid, text, jsonb) from public, anon, authenticated;
