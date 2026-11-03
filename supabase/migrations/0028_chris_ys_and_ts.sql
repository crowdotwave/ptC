-- Weighted Ys and Ts on Chris's back day, straight after the horizontal row.
--
-- Data only. No table, no policy, no function changes.
--
-- As Chris asked for it: 2 to 3 sets each, light, slow reps, shoulders pulled down first. The reverse
-- fly on Shoulders stays as it is, a regular chest supported reverse fly for rear delt size, so this
-- touches Back and chest only.
--
--   6   Incline Y Raise   2 x 10-15   60s   opens at 5 lb
--   7   Incline T Raise   2 x 10-15   60s   opens at 5 lb
--
-- Two sets prescribed and the third in the note, the way the seated press on Shoulders carries its
-- fourth: Add set when it is there. A third set prescribed would read as a skipped set every time it
-- was not done. 10-15 because none was given and light with slow reps is a high rep job; it is the
-- number to change if it is wrong.
--
-- Two new lifts in Clay's library, because neither exists in it or in the shared one. Two lifts and
-- not one, because a Y and a T are different raises and one chart for both would draw whichever came
-- first. Dumbbell, shoulders, chest on an incline bench like the reverse fly. Two rows numbered 6 and
-- 7, not 6A and 6B: a letter makes them a superset (parseGroup in js/program.js), and these are done
-- one after the other. 5 lb is starting_weight_kg, stored in kg, since neither has any history.
--
-- Then a new assignment carrying the current snapshot, starting today, deload_weeks carried: the same
-- move as 0026 and 0027. Checked before writing: nothing in the template has been edited since the
-- 0027 assignment, so this sends the Ys and Ts and nothing else.
--
-- Idempotent. Each lift is added only while the day does not already carry it, and the assignment is
-- written only when Chris's current snapshot does not carry both.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_row int;
  v_y uuid;
  v_t uuid;
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

  select id into v_y from public.exercises where trainer_id = v_clay and slug = 'incline-y-raise';
  if v_y is null then
    v_y := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_y, v_clay, 'Incline Y Raise', 'incline-y-raise', 'shoulders', 'dumbbell', null, false, 2.5);
    raise notice 'added Incline Y Raise to Clay''s library';
  end if;

  select id into v_t from public.exercises where trainer_id = v_clay and slug = 'incline-t-raise';
  if v_t is null then
    v_t := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_t, v_clay, 'Incline T Raise', 'incline-t-raise', 'shoulders', 'dumbbell', null, false, 2.5);
    raise notice 'added Incline T Raise to Clay''s library';
  end if;

  select i.order_index into v_row
    from public.template_items i
    join public.exercises e on e.id = i.exercise_id
   where i.day_id = v_day and e.slug = 'horizontal-row';
  if v_row is null then
    raise exception 'No Horizontal Row on Back and chest. Nothing changed.';
  end if;

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_y) then
    -- Make room after the row, so the Ys sit straight after it whatever comes later in the day.
    update public.template_items
       set order_index = order_index + 1,
           group_label = (order_index + 2)::text,
           updated_at = now()
     where day_id = v_day and order_index > v_row;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_y, v_row + 1, (v_row + 2)::text, 'Chest on an incline bench', 2,
       10, 15, '10-15', null, null,
       60, 'Light. Pull the shoulders down and back first, then raise the arms in a Y, thumbs up. Slow up and slow down. 2 to 3 sets: Add set for the third.',
       true, 'weight_reps', 2.268);

    raise notice 'added Incline Y Raise after the row on Back and chest';
  end if;

  select i.order_index into v_row
    from public.template_items i
   where i.day_id = v_day and i.exercise_id = v_y;

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_t) then
    update public.template_items
       set order_index = order_index + 1,
           group_label = (order_index + 2)::text,
           updated_at = now()
     where day_id = v_day and order_index > v_row;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_t, v_row + 1, (v_row + 2)::text, 'Chest on an incline bench', 2,
       10, 15, '10-15', null, null,
       60, 'Light. Pull the shoulders down and back first, then raise the arms straight out to the sides in a T. Slow up and slow down. 2 to 3 sets: Add set for the third.',
       true, 'weight_reps', 2.268);

    raise notice 'added Incline T Raise after the Ys on Back and chest';
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
     and (
       select count(distinct i->>'exercise_id')
         from jsonb_array_elements(v_current.snapshot->'days') d
        cross join lateral jsonb_array_elements(d->'items') i
        where i->>'exercise_id' in (v_y::text, v_t::text)
     ) = 2 then
    raise notice 'Chris already has the Ys and Ts. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with Ys and Ts on Back and chest';
end $$;

-- Expected after this runs: seven lifts on Back and chest.
--
--   0  1  Pushup               4  9-15
--   1  2  Pullup (wide)        2  5-8
--   2  3  Close Grip Pull-Up   2  6-10
--   3  4  Chest Fly            4  8-12
--   4  5  Horizontal Row       4  8-12
--   5  6  Incline Y Raise      2  10-15   opens at 5 lb
--   6  7  Incline T Raise      2  10-15   opens at 5 lb
