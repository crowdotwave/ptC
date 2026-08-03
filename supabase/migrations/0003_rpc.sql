-- The two things a client needs that a policy cannot express.
--
-- Both live in public rather than ptc, because PostgREST only exposes functions in schemas it
-- is configured to serve, and these are called over the wire as /rest/v1/rpc/<name>.

-- ---------------------------------------------------------------- claiming an invite
--
-- The bootstrap problem: nothing binds a signed in user to a clients row until auth_user_id is
-- set, and no policy can grant "read the row whose invite_code you happen to know" without
-- also granting the ability to fish for other people's rows one code at a time.
--
-- So the claim never reads through RLS at all. The caller hands over a code and gets back an
-- id or an error. They never see a row they do not already own.
--
-- The update carries `and auth_user_id is null` in its own where clause rather than trusting
-- the check above it. Two devices submitting the same code at the same moment both pass the
-- check, and only one of them updates a row.
--
-- One failure message covers both a bad code and an already claimed one, on purpose. Distinct
-- messages would turn this into an oracle that tells an attacker which codes are real.

create or replace function public.claim_invite(p_invite_code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_client_id uuid;
  v_claimed integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- One auth user maps to at most one client row. Without this, a client who already accepted
  -- an invite could claim a second one and end up with two identities.
  if exists (select 1 from public.clients where auth_user_id = auth.uid()) then
    raise exception 'this account is already linked to a client' using errcode = '23505';
  end if;

  update public.clients
     set auth_user_id = auth.uid(),
         status = 'active',
         updated_at = now()
   where invite_code = p_invite_code
     and auth_user_id is null
  returning id into v_client_id;

  get diagnostics v_claimed = row_count;
  if v_claimed <> 1 then
    raise exception 'that invite code is not valid' using errcode = '22023';
  end if;

  return v_client_id;
end $$;

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

revoke all on function public.claim_invite(text) from public, anon;
revoke all on function public.trainer_branding() from public, anon;
grant execute on function public.claim_invite(text) to authenticated;
grant execute on function public.trainer_branding() to authenticated;

-- Same guard as ptc: anything added to public later starts closed rather than open.
alter default privileges in schema public revoke execute on functions from public;
