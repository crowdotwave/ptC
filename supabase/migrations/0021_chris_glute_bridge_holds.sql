-- Glute bridge holds on Chris's leg day, and his phone is told about it.
--
-- Data only. No table, no policy, no function changes.
--
-- Chris asked Clay about adding glute work to his own leg day, and Clay's answer was glute bridges,
-- starting with isometric holds: push through the glutes, get the hips up high, hold it there, 30
-- to 45 seconds. Single leg is the progression he named, so it goes in the note rather than in the
-- prescription: a first block of holds is two legs, and the note says where it goes next.
--
-- What is written:
--
--   exercises        Glute Bridge Hold, in Clay's library, bodyweight. Owned by Clay because the
--                    program is Clay's and every other lift in it is his. A client reads their own
--                    trainer's rows and nothing else, so a lift in anybody else's library is a lift
--                    Chris's phone could never name.
--   template_items   on "Legs and core", straight after the Bulgarian split squats and before the
--                    L sit, so the legs and glutes run together and the core closes the day. The
--                    two core holds move down one place and one group label. Three sets is not a
--                    number Clay gave; it is this program's own shape for an accessory, and one
--                    field in the builder if it is wrong. target_reps_low 30 and high 45 are what
--                    the hold timer reads: 30 is the opening goal, 45 is the top of the range it
--                    marks on the way past.
--   assignments      a new row carrying the current snapshot, starting today. A client reads their
--                    assignment and never the template, so the item above reaches nobody until this
--                    is written. Same move as the Send update button and as 0018. Sessions already
--                    logged keep pointing at the assignment they were done under.
--
-- deload_weeks carries forward per the rule in CLAUDE.md. It is empty today.
--
-- Checked before writing, against the live rows: the template has not been edited since Chris's
-- current assignment was frozen on 2026-08-05, so the new snapshot differs from his current one by
-- this lift and nothing else. Nobody's unsent edit is being delivered as a side effect.
--
-- Idempotent. The exercise is written only if Clay has none by this slug, the item only if the day
-- does not already carry it, and the assignment only if Chris's current snapshot does not.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_exercise uuid;
  v_after integer;
  v_current record;
  v_snapshot jsonb;
begin
  select id into v_clay from public.trainers where lower(email) = lower('clayh97@outlook.com');
  select id into v_chris from public.clients where lower(email) = lower('chris.merryweather@gmail.com');
  select id into v_template from public.program_templates where name = 'Chris, three day split';

  if v_clay is null then
    raise exception 'No trainers row for clayh97@outlook.com. Nothing changed.';
  end if;
  if v_chris is null then
    raise exception 'No clients row for chris.merryweather@gmail.com. Nothing changed.';
  end if;
  if v_template is null then
    raise exception 'No program_templates row named Chris, three day split. Nothing changed.';
  end if;
  if (select trainer_id from public.program_templates where id = v_template) is distinct from v_clay then
    raise exception 'Chris, three day split is not Clay''s program. Nothing changed.';
  end if;

  select id into v_day
    from public.template_days
   where template_id = v_template and name = 'Legs and core';

  if v_day is null then
    raise exception 'No day called Legs and core on Chris, three day split. Nothing changed.';
  end if;

  -- ---------------------------------------------------------------- the lift

  select id into v_exercise
    from public.exercises
   where trainer_id = v_clay and slug = 'glute-bridge-hold';

  if v_exercise is null then
    v_exercise := gen_random_uuid();
    insert into public.exercises
      (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values
      (v_exercise, v_clay, 'Glute Bridge Hold', 'glute-bridge-hold', 'glutes', 'bodyweight', null, false, 2.5);
    raise notice 'added Glute Bridge Hold to Clay''s library';
  end if;

  -- ---------------------------------------------------------------- on the day

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_exercise) then
    -- After the split squats wherever they sit now, rather than at a hard coded index, so a day
    -- somebody has reordered since this was written still gets the holds after the legs.
    select i.order_index into v_after
      from public.template_items i
      join public.exercises e on e.id = i.exercise_id
     where i.day_id = v_day and e.name = 'Bulgarian Split Squat';

    if v_after is null then
      select coalesce(max(order_index), -1) into v_after from public.template_items where day_id = v_day;
      raise notice 'No Bulgarian Split Squat on Legs and core. The holds go at the end of the day.';
    end if;

    -- Everything after that point moves down one. The group labels on this day are the plain
    -- position, 1 to 4, and they move with it, so the builder still reads 1, 2, 3, 4, 5.
    update public.template_items
       set order_index = order_index + 1,
           group_label = case when group_label ~ '^\d+$' then (group_label::int + 1)::text else group_label end,
           updated_at = now()
     where day_id = v_day and order_index > v_after;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_exercise, v_after + 1, (v_after + 2)::text, null, 3,
       30, 45, '30-45 sec', null, null,
       60,
       'Push through the glutes, get the hips up high and hold it there. When 45 seconds is easy, go single leg.',
       true, 'time_hold', null);
    raise notice 'added Glute Bridge Hold to Legs and core';
  end if;

  -- ---------------------------------------------------------------- to his phone

  -- The snapshot as js/snapshot.js buildSnapshot writes it.
  select jsonb_build_object(
    'template', jsonb_build_object('id', t.id, 'name', t.name, 'notes', t.notes),
    'days', (
      select jsonb_agg(jsonb_build_object(
          'id', d.id, 'day_index', d.day_index, 'name', d.name, 'day_type', d.day_type,
          'split', d.split, 'warmup', d.warmup, 'comments', d.comments, 'emom', d.emom,
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

  if v_snapshot->'days' is null or jsonb_array_length(v_snapshot->'days') = 0 then
    raise exception 'Chris, three day split froze to no days. Nothing assigned.';
  end if;

  -- What his phone is reading now: latest starts_on, ties broken by created_at, which is what
  -- js/snapshot.js currentAssignment does.
  select * into v_current
    from public.assignments
   where client_id = v_chris
   order by starts_on desc, created_at desc
   limit 1;

  if v_current.id is not null
     and v_current.template_id = v_template
     and exists (
       select 1
         from jsonb_array_elements(v_current.snapshot->'days') d
        cross join lateral jsonb_array_elements(d->'items') i
        where i->>'exercise_id' = v_exercise::text
     ) then
    raise notice 'Chris already has the glute bridge holds. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with glute bridge holds on Legs and core';
end $$;

-- Expected after this runs: five lifts on Legs and core, the holds third.
--
--   select i->>'order_index', i->'exercise'->>'name', i->>'target_reps_text', i->>'log_mode'
--     from public.assignments a
--     cross join lateral jsonb_array_elements(a.snapshot->'days') d
--     cross join lateral jsonb_array_elements(d->'items') i
--    where a.client_id = (select id from public.clients where email = 'chris.merryweather@gmail.com')
--      and d->>'name' = 'Legs and core'
--      and a.id = (select id from public.assignments
--                   where client_id = a.client_id order by starts_on desc, created_at desc limit 1)
--    order by (i->>'order_index')::int;
