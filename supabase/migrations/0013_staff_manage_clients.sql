-- Staff can write a client row, not only read one.
--
-- 0001 through 0012 are applied, so this is a new file rather than an edit in place.
--
-- This is a deliberate departure from the rule 0006 set up, and the rule is worth restating
-- before it is broken: staff got nine select policies and a write policy on nothing. The note
-- stored against the staff rows themselves says it in four words, "read everything, write
-- nothing but their own". That separation is what made it safe to be signed in as staff while
-- debugging, because no screen could act on somebody else's client by accident.
--
-- What forced the change is that there is no client management screen in this app at all, and
-- there never has been. Every clients row in the database was inserted by hand, which is what
-- 0007's comment means when it says that is how Clay and Alejandra were set up. A trainer cannot
-- add a client, fix an address they typed wrong, or put away somebody who has left, and since
-- clients.email is the binding key, a typo in it is unfixable from inside the product. That is
-- the gap this and the screen on trainer.html close together.
--
-- clients_trainer_all already lets a trainer do all of this to their own clients, so the policy
-- below is only about the second half of the request: that the accounts building the app can fix
-- another trainer's client rather than only read them.

-- ---------------------------------------------------------------- one policy, replacing the select
--
-- for all rather than three separate policies, and it subsumes clients_staff_select from 0006,
-- which is dropped rather than left to overlap. Two policies both granting select to the same
-- principal is a thing to have to reason about later for no benefit now.
--
-- clients is the only table this happens to. The other eight staff policies from 0006 stay
-- select only, and a proposal to widen another one should have to give a reason as specific as
-- the missing screen above.

drop policy if exists clients_staff_select on public.clients;

create policy clients_staff_all on public.clients for all to authenticated
  using ((select ptc.is_staff()))
  with check ((select ptc.is_staff()));

-- ---------------------------------------------------------------- what this deliberately allows
--
-- Three consequences, written down because each one is a thing somebody could otherwise discover
-- by accident and read as a bug.
--
-- 1. Staff can move a client between trainers. The with check above constrains is_staff() and
--    says nothing about trainer_id, and 0005 grants update on that column. This is the exact
--    shape 0005 had to close on clients_self_update, where an unconstrained check plus that
--    grant would have let a client hand their own history to another coach. It is left open here
--    on purpose: reassigning a client is one of the operations this is being asked for, and
--    staff is a two person allowlist that cannot be joined over the API.
--
-- 2. Staff can delete a client. assignments.client_id and sessions.client_id are both on delete
--    cascade, so a delete takes that client's assignments and sessions with it silently. It does
--    not take their logged sets, because set_logs.session_id is on delete restrict, which means
--    a delete against anybody who has ever logged a set is refused by the database instead.
--    The screen offers delete only where nothing points at the row, and archive everywhere else,
--    which is the rule the program list already follows for the same reason.
--
-- 3. Staff still cannot bind an identity. auth_user_id is excluded from both the insert and the
--    update grant in 0002, so it stays writable only by ptc.handle_new_auth_user. A staff
--    account can create a client row carrying any address and cannot attach it to a person.
--    That is the one part of this nobody should be able to do by hand, and it is unchanged.
