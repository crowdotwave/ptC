-- The pullups on Chris's back day become two lifts: two sets wide, then two sets close.
--
-- Data only. No table, no policy, no function changes.
--
-- The day had one Pullup row, 4 x 5-8, 150s rest. As Chris asked for it:
--
--   Sets 1-2   wide overhand              5-8 reps
--   Sets 3-4   close grip or chin-up      6-10 reps
--
-- The wide sets keep the Pullup exercise, with the variation saying wide overhand. The prescription
-- is the same 5-8 the row always had, and the 28 sets already logged against it stay on the one
-- chart line rather than ending where a new exercise would begin. The close sets are a new lift,
-- Close Grip Pull-Up, because a closer grip is a different strength and a chart that joined the two
-- would draw the grip and not the back. Chin-up is the alternative in its note, the same way 0024
-- wrote the cable or dumbbell raise.
--
-- Both are bodyweight_reps at 150s rest, as the row was. Two rows numbered 2 and 3, not 2A and 2B:
-- a letter makes them a superset (parseGroup in js/program.js), and these are done one after the
-- other. The fly and the row move down to 4 and 5.
--
-- Then a new assignment carrying the current snapshot, starting today, deload_weeks carried: the same
-- move as 0018, 0021, 0024 and 0025. Checked before writing: nothing in the template has been edited
-- since the 0025 assignment, so this sends the split and nothing else.
--
-- Idempotent. The day is changed only while it does not already carry the close grip lift, and the
-- assignment is written only when Chris's current snapshot does not.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_wide uuid;
  v_close uuid;
  v_current record;
  v_snapshot jsonb;
begin
  select id into v_clay from public.trainers where lower(email) = lower('clayh97@outlook.com');
  select id into v_chris from public.clients where lower(email) = lower('chris.merryweather@gmail.com');
  select id into v_template from public.program_templates where name = 'Chris, three day split';

  if v_clay is null or v_chris is null or v_template is null then
    raise exception 'Missing Clay, Chris, or Chris, three day split. Nothing changed.';
  end if;
  if (select trainer_id from public.program_templates where id = v_template) is distinct from v_clay then
    raise exception 'Chris, three day split is not Clay''s program. Nothing changed.';
  end if;

  select id into v_day from public.template_days where template_id = v_template and name = 'Back and chest';
  if v_day is null then
    raise exception 'No day called Back and chest on Chris, three day split. Nothing changed.';
  end if;

  select i.exercise_id into v_wide
    from public.template_items i
    join public.exercises e on e.id = i.exercise_id
   where i.day_id = v_day and e.slug = 'pullup';

  select id into v_close from public.exercises where trainer_id = v_clay and slug = 'close-grip-pull-up';
  if v_close is null then
    v_close := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_close, v_clay, 'Close Grip Pull-Up', 'close-grip-pull-up', 'lats', 'bodyweight', null, false, 2.5);
    raise notice 'added Close Grip Pull-Up to Clay''s library';
  end if;

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_close) then
    if v_wide is null then
      raise exception 'No Pullup on Back and chest. Nothing changed.';
    end if;

    -- Make room: everything after the pullups moves down one, in order.
    update public.template_items
       set order_index = order_index + 1,
           group_label = (order_index + 2)::text,
           updated_at = now()
     where day_id = v_day
       and order_index > (select order_index from public.template_items where day_id = v_day and exercise_id = v_wide);

    update public.template_items
       set target_sets = 2,
           variation = 'Wide overhand',
           notes = 'Sets 1 and 2 of the pullups. Wide grip, palms away. Close grip is next.',
           updated_at = now()
     where day_id = v_day and exercise_id = v_wide;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    select gen_random_uuid(), v_day, v_close, w.order_index + 1, (w.order_index + 2)::text, null, 2,
           6, 10, '6-10', null, null,
           150, 'Sets 3 and 4 of the pullups. Close grip, or a chin-up with palms facing you.',
           true, 'bodyweight_reps', null
      from public.template_items w
     where w.day_id = v_day and w.exercise_id = v_wide;

    raise notice 'split the pullups on Back and chest into wide and close grip';
  end if;

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
        where i->>'exercise_id' = v_close::text
     ) then
    raise notice 'Chris already has the close grip pullups. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with wide and close grip pullups';
end $$;

-- Expected after this runs: five lifts on Back and chest.
--
--   0  1  Pushup               4  9-15
--   1  2  Pullup (wide)        2  5-8
--   2  3  Close Grip Pull-Up   2  6-10
--   3  4  Chest Fly            4  8-12
--   4  5  Horizontal Row       4  8-12
