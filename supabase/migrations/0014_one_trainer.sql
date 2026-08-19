-- One trainer, and everybody is his client.
--
-- Data only. No table, no policy, no function changes.
--
-- How it is now, which is nobody's decision and is what two people setting each other up looks
-- like: Chris's trainers row coaches Clay and owns the program Clay trains on plus 84 of the 96
-- exercises. Clay's trainers row coaches Chris and Alejandra and owns the other program and the
-- other 12. The two of them are each other's coach, it is internally consistent, and nothing has
-- ever complained about it.
--
-- How it is meant to be: Clay is the trainer. Everyone is his client, Clay included, because he
-- trains too and logging his own work means holding a clients row like anybody else. Chris keeps
-- admin sight of everything through ptc.staff, which is where that has always come from rather
-- than from holding a trainers row.
--
-- Three moves, and the third is the one with teeth:
--
--   clients           Clay's own row points at Chris. Point it at Clay, and he is his own client.
--   program_templates the program Clay trains on is owned by the wrong trainer.
--   exercises         all 84 of them, and this is the one that must not be skipped.
--
-- exercises_select gives a client the global rows, their own trainer's rows, and nothing else. The
-- moment Clay's clients row points at Clay, every exercise still owned by Chris becomes invisible
-- to the person doing the program built out of them. The logging screen reads increment_kg from
-- that table, so the visible symptom would have been every stepper in his program quietly moving
-- in 2.5 kg instead of the 5 and 20 that were set. There is a fallback to the frozen snapshot now,
-- added after finding this while walking the path for clients who do not exist yet, so a mistake
-- here degrades rather than breaks. That is a reason to be careful, not a reason to relax.
--
-- What this does NOT touch, deliberately:
--
--   assignments.snapshot  frozen by definition and carries its exercises inline. Clay's block
--                         keeps running through this unchanged, which is the whole point of it
--                         being frozen.
--   set_logs, sessions    nobody's training moves. Ownership is a fact about the library and the
--                         program, not about the sets.
--   Chris's trainers row  left in place with nothing hanging off it. Deleting it would be tidier
--                         and would risk a cascade for no gain, and there is no cost to a row that
--                         owns nothing.
--
-- Known consequence, stated because it will be noticed later: after this, Chris can no longer edit
-- an exercise. exercises_trainer_write wants trainer_id = current_trainer_id(), and the staff
-- policies on exercises, templates and assignments are select only. Chris can still read every one
-- of them and can still create and edit clients, which is what clients_staff_all is for. If
-- editing the library from the admin side turns out to be needed, that is a policy change and it
-- should be argued for on its own rather than smuggled in here.
--
-- Idempotent. Every update is keyed on the old owner, so running it twice moves nothing the second
-- time. Reversing it is the same statements with the two ids swapped, which is why they are
-- resolved by email rather than written down.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_clients integer;
  v_templates integer;
  v_exercises integer;
begin
  select id into v_clay from public.trainers where lower(email) = lower('clayh97@outlook.com');
  select id into v_chris from public.trainers where lower(email) = lower('chris.merryweather@gmail.com');

  -- Loud rather than clever. A null here would set trainer_id to null on somebody's whole library,
  -- and the not null constraint would catch it, and the error would be about a constraint rather
  -- than about the thing that actually went wrong.
  if v_clay is null then
    raise exception 'No trainers row for clayh97@outlook.com. Nothing moved.';
  end if;
  if v_chris is null then
    raise exception 'No trainers row for chris.merryweather@gmail.com. Nothing moved.';
  end if;
  if v_clay = v_chris then
    raise exception 'Both addresses resolve to one trainers row. Nothing moved.';
  end if;

  -- Clay becomes his own client. Only his row: Chris and Alejandra already point at Clay, and
  -- keying on the auth user rather than on the email keeps this about the person rather than about
  -- an address that can be edited from the app.
  update public.clients
     set trainer_id = v_clay, updated_at = now()
   where trainer_id = v_chris
     and auth_user_id = (select auth_user_id from public.trainers where id = v_clay);
  get diagnostics v_clients = row_count;

  update public.program_templates
     set trainer_id = v_clay, updated_at = now()
   where trainer_id = v_chris;
  get diagnostics v_templates = row_count;

  update public.exercises
     set trainer_id = v_clay, updated_at = now()
   where trainer_id = v_chris;
  get diagnostics v_exercises = row_count;

  raise notice 'moved: % client row, % templates, % exercises', v_clients, v_templates, v_exercises;

  -- The state this is for. Anything left under the old owner means a partial move, and a partial
  -- move is the one outcome worth refusing: a client pointed at a trainer who no longer owns the
  -- library they train from reads an empty exercise table.
  if exists (select 1 from public.exercises where trainer_id = v_chris) then
    raise exception 'Exercises still owned by the old trainer. Rolled back.';
  end if;
  if exists (select 1 from public.program_templates where trainer_id = v_chris) then
    raise exception 'Templates still owned by the old trainer. Rolled back.';
  end if;
  if exists (select 1 from public.clients where trainer_id = v_chris) then
    raise exception 'Clients still pointed at the old trainer. Rolled back.';
  end if;
end $$;

-- Expected after this runs:
--
--   select t.display_name, count(distinct c.id) as clients, count(distinct e.id) as exercises
--     from public.trainers t
--     left join public.clients c on c.trainer_id = t.id
--     left join public.exercises e on e.trainer_id = t.id
--    group by t.display_name;
--
--   Clay Harding        3 clients   96 exercises
--   Chris Merryweather  0 clients    0 exercises
