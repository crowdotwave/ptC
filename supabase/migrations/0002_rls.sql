-- Row level security. Step 3 of the build order.
--
-- CLAUDE.md: "Every table gets RLS enabled with no permissive default." and "This is enforced
-- at the database with row-level security, not in the UI. UI-level filtering is a bug, not an
-- implementation."
--
-- Deny by default, then grant back exactly what each role needs. A missing policy is a
-- denial, which is how append only is enforced on set_logs: there is no update policy and no
-- delete policy, so there is no update and no delete.

-- ---------------------------------------------------------------- grants
--
-- Supabase hands anon and authenticated broad defaults on the public schema. Take it all back
-- first so nothing is reachable by accident, then grant per table.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- anon gets nothing at all. Every read in this product is somebody's private training data.
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.exercises to authenticated;
grant select, insert, update, delete on public.program_templates to authenticated;
grant select, insert, update, delete on public.template_days to authenticated;
grant select, insert, update, delete on public.template_items to authenticated;
grant select, insert, update, delete on public.assignments to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.payments to authenticated;

-- Append only, stated in the grant as well as in the absent policies below.
grant select, insert on public.set_logs to authenticated;

-- trainers is column level. auth_user_id is readable by nobody through the API, trainer or
-- client. Nothing in the app needs it: a signed in user already knows their own auth.uid(),
-- and the mapping from auth user to trainer is resolved server side by the helpers below.
--
-- Note that a column grant is per role, not per row, and both trainers and clients are the
-- same `authenticated` role. So a grant cannot say "clients see three columns, trainers see
-- seven". That is why the row policy below is trainer only, and why a client reads branding
-- through public.trainer_branding() in 0003 instead of touching this table at all.
grant select (id, created_at, updated_at, display_name, brand_color, logo_url, weight_unit)
  on public.trainers to authenticated;
grant insert on public.trainers to authenticated;
grant update (updated_at, display_name, brand_color, logo_url, weight_unit)
  on public.trainers to authenticated;

-- ---------------------------------------------------------------- ownership helpers
--
-- security definer on purpose. A subquery inside a policy is itself subject to RLS on the
-- table it reads, so resolving "which client am I" by selecting from clients inside a clients
-- policy recurses, and doing it inside a set_logs policy would silently return no rows once
-- the clients policy tightened. Definer functions read the mapping once, outside RLS.
--
-- search_path is pinned on every one of them. An unpinned definer function is an escalation
-- hole in the thing it exists to protect: a caller who can create a function or table in a
-- schema earlier on the path can substitute their own and have it run as the owner.

create schema if not exists ptc;
revoke all on schema ptc from public, anon;
grant usage on schema ptc to authenticated;

create or replace function ptc.current_trainer_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select t.id from public.trainers t where t.auth_user_id = auth.uid() limit 1 $$;

create or replace function ptc.current_client_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select c.id from public.clients c where c.auth_user_id = auth.uid() limit 1 $$;

-- The trainer this client belongs to. This is what lets a client read their own trainer's
-- custom exercises. Without it a trainer adding a lift would silently break that client's
-- steppers, because the logging screen reads increment_kg live from exercises rather than
-- from assignments.snapshot.
create or replace function ptc.current_client_trainer_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select c.trainer_id from public.clients c where c.auth_user_id = auth.uid() limit 1 $$;

create or replace function ptc.client_trainer_id(p_client uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select c.trainer_id from public.clients c where c.id = p_client $$;

create or replace function ptc.template_trainer_id(p_template uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select t.trainer_id from public.program_templates t where t.id = p_template $$;

create or replace function ptc.day_trainer_id(p_day uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select t.trainer_id
  from public.template_days d
  join public.program_templates t on t.id = d.template_id
  where d.id = p_day
$$;

-- One hop instead of two nested calls, for the set_logs trainer policy.
create or replace function ptc.session_trainer_id(p_session uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select c.trainer_id
  from public.sessions s
  join public.clients c on c.id = s.client_id
  where s.id = p_session
$$;

-- Set returning helpers for the two hot paths. A policy written as
-- `client_id in (select ptc.my_client_ids())` evaluates the set once as an InitPlan and then
-- hashes it, instead of calling a function once per row.
create or replace function ptc.my_client_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select c.id from public.clients c where c.trainer_id = (select ptc.current_trainer_id()) $$;

create or replace function ptc.my_session_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select s.id from public.sessions s where s.client_id = (select ptc.current_client_id()) $$;

revoke all on all functions in schema ptc from public, anon;
grant execute on all functions in schema ptc to authenticated;

-- `revoke on all functions` only covers what exists right now. Without this, any function
-- added by a later migration would default to execute for public.
alter default privileges in schema ptc revoke execute on functions from public;

-- ---------------------------------------------------------------- enable

alter table public.trainers enable row level security;
alter table public.clients enable row level security;
alter table public.exercises enable row level security;
alter table public.program_templates enable row level security;
alter table public.template_days enable row level security;
alter table public.template_items enable row level security;
alter table public.assignments enable row level security;
alter table public.sessions enable row level security;
alter table public.set_logs enable row level security;
alter table public.payments enable row level security;

-- force, so the table owner is held to the same policies as everybody else. A role with
-- bypassrls still gets through, which is what lets the isolation test build its fixtures.
alter table public.trainers force row level security;
alter table public.clients force row level security;
alter table public.exercises force row level security;
alter table public.program_templates force row level security;
alter table public.template_days force row level security;
alter table public.template_items force row level security;
alter table public.assignments force row level security;
alter table public.sessions force row level security;
alter table public.set_logs force row level security;
alter table public.payments force row level security;

-- ---------------------------------------------------------------- a note on (select fn())
--
-- Every zero argument helper below is wrapped in a scalar subquery. Postgres hoists that into
-- an InitPlan and evaluates it once per statement rather than once per row. Unwrapped, a
-- trainer scanning a year of set_logs calls the function once for every row examined.
--
-- Helpers that take a column as an argument cannot be hoisted, because their result depends on
-- the row. Those are used only where the alternative is worse, and each is a primary key
-- lookup.

-- ---------------------------------------------------------------- trainers
--
-- Trainer only. A client never selects from this table. Branding reaches them through
-- public.trainer_branding() in 0003, which returns three columns and no auth_user_id.

create policy trainers_select on public.trainers for select to authenticated
  using (id = (select ptc.current_trainer_id()));

create policy trainers_insert on public.trainers for insert to authenticated
  with check (auth_user_id = (select auth.uid()));

create policy trainers_update on public.trainers for update to authenticated
  using (id = (select ptc.current_trainer_id()))
  with check (id = (select ptc.current_trainer_id()));

-- ---------------------------------------------------------------- clients

create policy clients_trainer_all on public.clients for all to authenticated
  using (trainer_id = (select ptc.current_trainer_id()))
  with check (trainer_id = (select ptc.current_trainer_id()));

-- A client sees exactly one row in this table: their own. Never a sibling, never a count,
-- never the existence of anybody else.
create policy clients_self_select on public.clients for select to authenticated
  using (id = (select ptc.current_client_id()));

create policy clients_self_update on public.clients for update to authenticated
  using (id = (select ptc.current_client_id()))
  with check (id = (select ptc.current_client_id()));

-- ---------------------------------------------------------------- exercises
--
-- The third clause is load bearing. The logging screen reads increment_kg live from this
-- table, so without it a trainer adding a custom lift would leave that client stepping by a
-- default the gym cannot make.

create policy exercises_select on public.exercises for select to authenticated
  using (
    is_global
    or trainer_id = (select ptc.current_trainer_id())
    or trainer_id = (select ptc.current_client_trainer_id())
  );

create policy exercises_trainer_write on public.exercises for all to authenticated
  using (trainer_id is not null and trainer_id = (select ptc.current_trainer_id()))
  with check (trainer_id is not null and trainer_id = (select ptc.current_trainer_id()));

-- ---------------------------------------------------------------- program templates
--
-- Trainer only, all three tables. A client never reads these. What a client is meant to do
-- reaches them through assignments.snapshot, which is exactly why the snapshot is mandatory.

create policy program_templates_trainer_all on public.program_templates for all to authenticated
  using (trainer_id = (select ptc.current_trainer_id()))
  with check (trainer_id = (select ptc.current_trainer_id()));

create policy template_days_trainer_all on public.template_days for all to authenticated
  using (ptc.template_trainer_id(template_id) = (select ptc.current_trainer_id()))
  with check (ptc.template_trainer_id(template_id) = (select ptc.current_trainer_id()));

create policy template_items_trainer_all on public.template_items for all to authenticated
  using (ptc.day_trainer_id(day_id) = (select ptc.current_trainer_id()))
  with check (ptc.day_trainer_id(day_id) = (select ptc.current_trainer_id()));

-- ---------------------------------------------------------------- assignments

create policy assignments_trainer_all on public.assignments for all to authenticated
  using (client_id in (select ptc.my_client_ids()))
  with check (client_id in (select ptc.my_client_ids()));

create policy assignments_client_select on public.assignments for select to authenticated
  using (client_id = (select ptc.current_client_id()));

-- ---------------------------------------------------------------- sessions

create policy sessions_trainer_select on public.sessions for select to authenticated
  using (client_id in (select ptc.my_client_ids()));

create policy sessions_client_all on public.sessions for all to authenticated
  using (client_id = (select ptc.current_client_id()))
  with check (client_id = (select ptc.current_client_id()));

-- ---------------------------------------------------------------- set_logs
--
-- Select and insert only. The absence of an update policy and a delete policy is what makes
-- this table append only at the database rather than a convention the client is trusted with.
--
-- The client path is the hot one, so it goes through the InitPlan set. The trainer path uses a
-- per row primary key lookup, which is the right trade while a trainer has tens of clients: a
-- set of every session id across all of them would be materialised on every query, including
-- the common one that already filters to a single session.

create policy set_logs_client_select on public.set_logs for select to authenticated
  using (session_id in (select ptc.my_session_ids()));

create policy set_logs_client_insert on public.set_logs for insert to authenticated
  with check (session_id in (select ptc.my_session_ids()));

create policy set_logs_trainer_select on public.set_logs for select to authenticated
  using (ptc.session_trainer_id(session_id) = (select ptc.current_trainer_id()));

-- ---------------------------------------------------------------- payments
--
-- Trainer only. A client has no read of their own payments either, because CLAUDE.md lists
-- payments alongside program_templates as out of reach, and a payment row carries the
-- trainer's whole billing relationship rather than just this client's side of it.

create policy payments_trainer_all on public.payments for all to authenticated
  using (trainer_id = (select ptc.current_trainer_id()))
  with check (trainer_id = (select ptc.current_trainer_id()));
