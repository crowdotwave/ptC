-- Binding gets more than one attempt.
--
-- 0001 through 0011 are applied, so this is a new file rather than an edit in place.
--
-- 0003 binds a person to their row from on_auth_user_created, an after insert trigger on
-- auth.users. It fires exactly once, when the row appears, which is when somebody REQUESTS a sign
-- in link rather than when they click it. 0010 measured that gap at seventy four seconds.
--
-- Firing once is what makes the ordering strict, and the ordering is the trap. The address on the
-- clients row is the binding key, so it has to be correct before that first request, and the
-- reasons it might not be are all ordinary:
--
--   a client row carrying a placeholder, because clients.email is not null and the trainer did
--   not have the real address yet
--   a typo in the address the trainer entered
--   somebody finding the app and signing in before any trainer has added them
--
-- In every one of those the trigger runs, matches nothing, binds nothing, and returns 'none'.
-- What makes it a trap rather than a retryable mistake is that nothing fires again. Correcting
-- the address afterwards updates a row no trigger will ever read a second time, so the person is
-- on the unbound screen permanently while a trainer looks at a clients row that appears correct.
-- The only way out is somebody with database access setting clients.auth_user_id by hand, which
-- is a fix that requires the one person who is not in the room.
--
-- So binding is attempted again on every sign in. handle_new_auth_user is already written for
-- this: it tests whether each side is already bound and updates only the unbound one, matching on
-- a null auth_user_id, so running it against somebody fully bound is a pair of updates that hit
-- no rows. It is safe to call on every sign in for the rest of this app's life.
--
-- What this does NOT do is widen who can bind. The match is still lower(email) against a row a
-- trainer created, an unmatched address still creates nothing per 0007, and a bind still claims
-- only a row whose auth_user_id is null. A second attempt at a match that was always allowed is
-- not a new grant.

-- ---------------------------------------------------------------- and status catches up with it
--
-- 0010 moved 'invited' to 'active' from on_auth_user_confirmed, an after update trigger keyed on
-- email_confirmed_at, so that active means somebody actually arrived rather than that somebody
-- typed their address.
--
-- That trigger also fires once, and in the out of order case it fires at the wrong moment: the
-- person confirms while still unbound, the update matches no clients row, and by the time a late
-- bind finally attaches them there is no confirmation left to happen. Without the flip below they
-- would be bound, training, and reading 'invited' on the trainer's list forever.
--
-- Gated on email_confirmed_at rather than assumed from the sign in. Every sign in this app has is
-- a magic link, so a row with last_sign_in_at set is confirmed, but that is a fact about the auth
-- providers turned on today rather than about this schema, and the gate costs nothing.
--
-- Only ever forwards, invited to active, which is 0010's rule unchanged. An archived client who
-- signs in stays archived, because a returning sign in is not a decision to un-archive somebody.

create or replace function ptc.on_auth_user_signed_in() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform ptc.handle_new_auth_user(new.id, new.email, coalesce(new.raw_user_meta_data, '{}'::jsonb));

  if new.email_confirmed_at is not null then
    update public.clients
       set status = 'active'
     where auth_user_id = new.id
       and status = 'invited';
  end if;

  return new;
end $$;

-- Keyed on last_sign_in_at, which is the one column that moves on every sign in and on nothing
-- else. A trigger on the whole row would fire on every token refresh, and this calls a security
-- definer function that writes to two tables.
--
-- The is distinct from test is what keeps a repeated write of an unchanged value from counting as
-- a sign in. The not null test is for the insert side: 0003's trigger already covers the first
-- bind, and a row arriving with last_sign_in_at still null has not signed in at all.

drop trigger if exists on_auth_user_signed_in on auth.users;

create trigger on_auth_user_signed_in
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is not null and new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function ptc.on_auth_user_signed_in();

revoke all on function ptc.on_auth_user_signed_in() from public, anon, authenticated;

-- ---------------------------------------------------------------- what is deliberately left alone
--
-- Nothing is backfilled. An auth user sitting unbound right now is somebody no trainer has added,
-- and inventing a clients row for them here would be this migration deciding who somebody's coach
-- is. They bind on their next sign in, once a trainer has created the row, which is the whole
-- point of the trigger above.
