-- What the sync adapter needs from the database. Step 4 of the build order.
--
-- 0001 through 0004 are applied, so this is a new file rather than an edit in place.
--
-- Two things: a way for a signed in browser to ask what it is, and the column grants an upsert
-- actually requires. Both were discovered by writing the adapter against the real grants rather
-- than by reading them.

-- ---------------------------------------------------------------- whoami
--
-- A browser holding a session knows its auth.uid() and nothing else. It cannot read
-- trainers.auth_user_id or clients.auth_user_id, because 0002 withholds that column from every
-- role on purpose, so it cannot work out which row is its own by querying.
--
-- It could infer: RLS already means a trainer sees exactly one trainers row and a client sees
-- exactly one clients row, so "did anything come back" is technically an answer. That inference
-- is silently wrong whenever a query fails for an unrelated reason, and it costs a full table
-- pull before the app knows who is looking. One round trip that says so directly is better.
--
-- Returns 'none' for a signed in user who is neither, which happens if the auth trigger has not
-- run or was skipped for a user with no email. The app treats that as a real state and says so,
-- rather than showing an empty program as though it were a program with nothing in it.

create or replace function public.whoami()
  returns table (actor_role text, trainer_id uuid, client_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select
    case
      when (select ptc.current_trainer_id()) is not null then 'trainer'
      when (select ptc.current_client_id()) is not null then 'client'
      else 'none'
    end,
    (select ptc.current_trainer_id()),
    (select ptc.current_client_id())
$$;

revoke all on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;

-- ---------------------------------------------------------------- upsert needs update grants
--
-- The adapter writes with a PostgREST upsert, which compiles to
-- `insert ... on conflict (id) do update set <every column in the payload>`. Postgres checks
-- the update privilege on every column in that SET list, not just the ones whose value changed.
--
-- So a table whose insert grant is wider than its update grant cannot be upserted at all. That
-- is exactly the shape of clients and trainers in 0002, where the narrow update grant exists to
-- protect auth_user_id. The fix is to widen the update grant to everything the insert grant
-- already allows, and keep auth_user_id out of both. The adapter strips auth_user_id from every
-- outgoing payload for these two tables, which is the note 0002 left for step 4.
--
-- created_at is safe to grant because ptc.stamp_row() assigns new.created_at := old.created_at
-- on every update. A client may send it and it is discarded.

grant update (created_at, trainer_id) on public.clients to authenticated;
grant update (created_at) on public.trainers to authenticated;

-- id is granted for the same reason and no other. PostgREST may or may not include the conflict
-- target in the generated SET list, and which it does is a property of the version deployed in
-- front of this database rather than of anything in this repo. Granting it makes the write work
-- either way instead of failing on a detail nobody can see from here.
--
-- Nothing dangerous follows from it. On trainers the update policy checks
-- `id = ptc.current_trainer_id()` in its with check, so a changed id fails the policy outright.
-- On clients a trainer could re-id one of their own client rows, which crosses no tenant
-- boundary and is rejected by the foreign keys from sessions and assignments the moment that
-- client has any history, because neither declares on update cascade.
--
-- set_logs needs none of this. It is written with on conflict do nothing, which requires no
-- update privilege at all, which is also why it stays append only through this path.

grant update (id) on public.clients to authenticated;
grant update (id) on public.trainers to authenticated;

-- ---------------------------------------------------------------- and one hole that opens with it
--
-- Granting update on clients.trainer_id is only safe once every policy that permits an update on
-- clients constrains that column. clients_trainer_all already does, through its with check. But
-- clients_self_update, the policy that lets a person edit their own display name and unit,
-- checks only that the row is theirs:
--
--   with check (id = (select ptc.current_client_id()))
--
-- Policies are OR'd. With the grant above and that check unchanged, a client could set their own
-- trainer_id to any uuid and hand their entire training history to a different trainer, which is
-- the precise thing CLAUDE.md says the database is responsible for preventing. The grant was
-- harmless before only because no update grant on the column existed.
--
-- So the check gains the column. ptc.current_client_trainer_id() is stable and reads the
-- statement snapshot, so inside a with check it returns the row's trainer as it was before this
-- update. The condition is therefore "the trainer you already had", and a client can never
-- reassign themselves.

drop policy clients_self_update on public.clients;

create policy clients_self_update on public.clients for update to authenticated
  using (id = (select ptc.current_client_id()))
  with check (
    id = (select ptc.current_client_id())
    and trainer_id = (select ptc.current_client_trainer_id())
  );
