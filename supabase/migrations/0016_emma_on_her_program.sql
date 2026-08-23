-- Emma Brown 2 belongs to Clay, and Emma is the one person on it.
--
-- Data only. No table, no policy, no function changes.
--
-- 0014 made Clay the only trainer and left Chris's trainers row in place owning nothing. This
-- undoes a drift back across that line: Emma Brown 2 was imported under Chris's trainers row, and
-- a testclient was created under it to try assigning against, because Chris-as-trainer could not
-- assign to Emma. He could not, and the policy is right to refuse him: assignments_trainer_all
-- wants client_id in my_client_ids(), Emma is Clay's client, and a program handed out by somebody
-- who does not coach the person is not a thing this app should allow.
--
-- So the testclient was a workaround for owning the program from the wrong side, and moving the
-- program is what removes the need for it. What it left behind:
--
--   five assignments   one per press of a button that said nothing back. Four carry rest_seconds 0
--                      on BICYCLE CRUNCHES and JUMPING SQUATS, from an edit later reverted to 60,
--                      and the newest of those is the one currentAssignment picks. Emma must not
--                      inherit that, which is why the row written below is frozen from the
--                      template as it stands rather than copied from any of them.
--   one clients row    testtest@test.com, invited, never accepted, nothing logged against it.
--
-- The exercises are already Clay's, all twenty one of them. Chris could read them only through
-- exercises_staff_select, so the program was owned by one person and built out of another's
-- library the whole time. Moving the template is what makes those agree.
--
-- What this does NOT touch, deliberately:
--
--   set_logs, sessions    testclient has none, and the guard below refuses rather than assumes.
--                         Nothing here is capable of removing a logged set: set_logs has no delete
--                         grant and sessions is on delete restrict.
--   exercises             already correct. 0014 moved them and nothing has moved them back.
--   Chris's trainers row  left owning nothing, which is exactly what 0014 decided and said why:
--                         deleting it would risk a cascade for no gain. Admin sight comes from
--                         ptc.staff, not from that row.
--
-- Idempotent. The delete is keyed on an email that will not exist the second time, the move is
-- keyed on the old owner, and the assignment is written only if Emma has none for this program.
--
-- Reversing it is not symmetric and is not meant to be: the testclient rows are gone. The move
-- back is the same update with the two trainer ids swapped.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_emma uuid;
  v_test uuid;
  v_template uuid;
  v_snapshot jsonb;
  v_removed integer;
begin
  select id into v_clay from public.trainers where lower(email) = lower('clayh97@outlook.com');
  select id into v_chris from public.trainers where lower(email) = lower('chris.merryweather@gmail.com');
  select id into v_emma from public.clients where lower(email) = lower('emmairenebrown@gmail.com');
  select id into v_test from public.clients where lower(email) = lower('testtest@test.com');
  select id into v_template from public.program_templates where name = 'Emma Brown 2';

  -- Loud rather than clever, the way 0014 is. A null trainer id here would null out an owner
  -- column and surface as a constraint error about something other than what went wrong.
  if v_clay is null then
    raise exception 'No trainers row for clayh97@outlook.com. Nothing moved.';
  end if;
  if v_emma is null then
    raise exception 'No clients row for emmairenebrown@gmail.com. Nothing moved.';
  end if;
  if v_template is null then
    raise exception 'No program_templates row named Emma Brown 2. Nothing moved.';
  end if;
  if (select trainer_id from public.clients where id = v_emma) is distinct from v_clay then
    raise exception 'Emma is not Clay''s client. Assigning would be refused by policy anyway.';
  end if;

  -- The one thing worth refusing outright. A client who has trained has rows that cannot be
  -- deleted and must not be: set_logs is append only by grant, and sessions is on delete restrict.
  -- If this ever fires, the row is not a test account any more and somebody has to look.
  if v_test is not null and exists (select 1 from public.sessions where client_id = v_test) then
    raise exception 'testtest@test.com has logged sessions. Nothing removed.';
  end if;
  if v_test is not null and exists (select 1 from public.payments where client_id = v_test) then
    raise exception 'testtest@test.com has payments against it. Nothing removed.';
  end if;

  if v_test is not null then
    delete from public.assignments where client_id = v_test;
    get diagnostics v_removed = row_count;
    delete from public.clients where id = v_test;
    raise notice 'removed testclient and % assignment rows', v_removed;
  end if;

  -- The program moves to the trainer who coaches the person it is for, and who owns every exercise
  -- in it.
  if v_chris is not null then
    update public.program_templates
       set trainer_id = v_clay, updated_at = now()
     where id = v_template and trainer_id = v_chris;
  end if;

  -- Frozen here in the shape js/snapshot.js buildSnapshot writes: template, then days in
  -- day_index order, each carrying its items in order_index order with the exercise inline.
  -- Inline because a client can read their own assignment and nothing else, so a lift whose name
  -- is not in here is a lift Emma's phone could never name.
  select jsonb_build_object(
    'template', jsonb_build_object('id', t.id, 'name', t.name, 'notes', t.notes),
    'days', (
      select jsonb_agg(jsonb_build_object(
          'id', d.id, 'day_index', d.day_index, 'name', d.name, 'day_type', d.day_type,
          'split', d.split, 'warmup', d.warmup, 'comments', d.comments,
          'items', coalesce((
            select jsonb_agg(to_jsonb(i) || jsonb_build_object('exercise',
                     jsonb_build_object('id', e.id, 'name', e.name, 'slug', e.slug,
                                        'equipment', e.equipment, 'increment_kg', e.increment_kg))
                   order by i.order_index)
            from public.template_items i
            join public.exercises e on e.id = i.exercise_id
            where i.day_id = d.id), '[]'::jsonb))
        order by d.day_index)
      from public.template_days d where d.template_id = t.id))
  into v_snapshot
  from public.program_templates t where t.id = v_template;

  -- The failure buildSnapshot raises rather than a snapshot with a hole in it. A blank lift name
  -- on a phone mid gym is frozen forever; an error here is an afternoon at a desk.
  if v_snapshot->'days' is null or jsonb_array_length(v_snapshot->'days') = 0 then
    raise exception 'Emma Brown 2 froze to no days. Nothing assigned.';
  end if;
  if exists (
    select 1 from public.template_items i
     join public.template_days d on d.id = i.day_id
     left join public.exercises e on e.id = i.exercise_id
    where d.template_id = v_template and e.id is null
  ) then
    raise exception 'An item names an exercise that is not in the library. Nothing assigned.';
  end if;

  -- deload_weeks is empty and not carried from anywhere. A back off week is marked from the
  -- client's own chart months later, and Emma has not trained a session yet.
  if not exists (select 1 from public.assignments where client_id = v_emma and template_id = v_template) then
    insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
    values (gen_random_uuid(), v_emma, v_template, v_snapshot, current_date, null, '[]'::jsonb);
    raise notice 'assigned Emma Brown 2 to Emma, starting today';
  end if;
end $$;

-- Expected after this runs:
--
--   select pt.name, tr.display_name as trainer, c.display_name as client
--     from public.program_templates pt
--     join public.trainers tr on tr.id = pt.trainer_id
--     left join public.assignments a on a.template_id = pt.id
--     left join public.clients c on c.id = a.client_id
--    where pt.name = 'Emma Brown 2';
--
--   Emma Brown 2   Clay Harding   Emma
--
-- and exactly one row.
