-- Chris's shoulder day becomes back friendly, and his phone is told about it.
--
-- Data only. No table, no policy, no function changes.
--
-- The day as Chris asked for it:
--
--   1  Seated DB shoulder press, bench at 75 to 85 degrees   3-4 x 8-12            2 min rest
--   2  Incline side lying lateral raise                      4 x 12-15 per arm     60-90s rest
--   3  Chest supported reverse fly                           4 x 12-15             90s rest
--   4  Seated cable lateral raise (or seated DB, back on     3 x 12-20             60-90s rest
--      the bench)
--
--   When you hit the top of the rep range on every set, add weight. Stop each set 1 to 2 reps short
--   of failure.
--
-- It replaces the four lifts that were on the day: lateral raise, rear delt reverse fly, pike
-- pushup, dumbbell shoulder press. Every one of the new lifts is supported, seated or lying, which is
-- what makes the day back friendly, so each is a new exercise rather than a rename of the old one.
-- That is deliberate: a seated press with the back on a pad and a press done without one are not
-- the same strength, and charting them as one line would draw a jump that is the bench and not the
-- shoulders. The old exercises stay in the library with their history on them, untouched.
--
-- Where the prescription is a range and a column wants one number:
--
--   3-4 sets      target_sets 3. A fourth is Add set, which the app records as beyond the plan, and
--                 that is exactly what "3 to 4" means. The note says so.
--   60-90s rest   rest_seconds 90. The timer says when the longest rest is over; starting before it
--                 is always allowed.
--   2 min rest    rest_seconds 120.
--   1-2 reps      target_load '1-2 RIR' and target_rpe 9, which is how every other RIR row in this
--   short         database is written and what the importer would have made of it.
--
-- Per arm: a set of the side lying raise is both arms, and the reps logged are one arm's. One row
-- per arm would double the sets and halve nothing useful.
--
-- No foreign key points at template_items, so removing the old rows touches nothing logged. Logged
-- sets point at exercises, and the old exercises are kept.
--
-- The assignment is the same move as 0018 and 0021: a new row carrying the current snapshot,
-- starting today, deload_weeks carried. Checked before writing: the template had not been edited
-- since Chris's current assignment was frozen on 2026-09-30, and its other two days match that
-- snapshot row for row, so this sends the shoulder day and nothing else.
--
-- Idempotent. The day is rebuilt only while it does not already carry the seated press, and the
-- assignment is written only when Chris's current snapshot does not.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_press uuid;
  v_side uuid;
  v_fly uuid;
  v_cable uuid;
  v_current record;
  v_snapshot jsonb;
  v_removed integer;
  v_progress constant text := 'When you hit the top of the rep range on every set, add weight. '
                              'Stop each set 1 to 2 reps short of failure.';
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
   where template_id = v_template and name = 'Shoulders';

  if v_day is null then
    raise exception 'No day called Shoulders on Chris, three day split. Nothing changed.';
  end if;

  -- ---------------------------------------------------------------- the lifts
  --
  -- Found by slug in Clay's library, written only when missing, so a second run reuses the first
  -- run's rows rather than making twins.

  select id into v_press from public.exercises where trainer_id = v_clay and slug = 'seated-dumbbell-shoulder-press';
  if v_press is null then
    v_press := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_press, v_clay, 'Seated Dumbbell Shoulder Press', 'seated-dumbbell-shoulder-press', 'shoulders', 'dumbbell', null, false, 2.5);
  end if;

  select id into v_side from public.exercises where trainer_id = v_clay and slug = 'incline-side-lying-lateral-raise';
  if v_side is null then
    v_side := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_side, v_clay, 'Incline Side Lying Lateral Raise', 'incline-side-lying-lateral-raise', 'shoulders', 'dumbbell', null, false, 2.5);
  end if;

  select id into v_fly from public.exercises where trainer_id = v_clay and slug = 'chest-supported-reverse-fly';
  if v_fly is null then
    v_fly := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_fly, v_clay, 'Chest Supported Reverse Fly', 'chest-supported-reverse-fly', 'shoulders', 'dumbbell', null, false, 2.5);
  end if;

  select id into v_cable from public.exercises where trainer_id = v_clay and slug = 'seated-cable-lateral-raise';
  if v_cable is null then
    v_cable := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_cable, v_clay, 'Seated Cable Lateral Raise', 'seated-cable-lateral-raise', 'shoulders', 'cable', null, false, 2.5);
  end if;

  -- ---------------------------------------------------------------- the day

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_press) then
    delete from public.template_items where day_id = v_day;
    get diagnostics v_removed = row_count;
    raise notice 'removed % lifts from Shoulders', v_removed;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_press, 0, '1', 'Bench at 75-85°', 3,
       8, 12, '8-12', '1-2 RIR', 9, 120,
       'Bench at 75 to 85 degrees, back on the pad. 3 to 4 sets: Add set for the fourth when you have it. '
         || 'When you hit 12 on every set, add weight.',
       true, 'weight_reps', null),
      (gen_random_uuid(), v_day, v_side, 1, '2', null, 4,
       12, 15, '12-15 per arm', '1-2 RIR', 9, 90,
       'Lying on your side on an incline bench. Do both arms each set and log the reps for one. '
         || 'When you hit 15 on every set, add weight.',
       true, 'weight_reps', null),
      (gen_random_uuid(), v_day, v_fly, 2, '3', null, 4,
       12, 15, '12-15', '1-2 RIR', 9, 90,
       'Chest on an incline bench. When you hit 15 on every set, add weight.',
       true, 'weight_reps', null),
      (gen_random_uuid(), v_day, v_cable, 3, '4', null, 3,
       12, 20, '12-20', '1-2 RIR', 9, 90,
       'Or seated with dumbbells, back on the bench. When you hit 20 on every set, add weight.',
       true, 'weight_reps', null);

    update public.template_days
       set comments = 'Back friendly: every lift is seated or supported. ' || v_progress,
           updated_at = now()
     where id = v_day;
    raise notice 'rebuilt Shoulders as the back friendly day';
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
        where i->>'exercise_id' = v_press::text
     ) then
    raise notice 'Chris already has the back friendly shoulder day. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with the back friendly shoulder day';
end $$;

-- Expected after this runs: four lifts on Shoulders, the seated press first.
--
--   select i->>'order_index', i->'exercise'->>'name', i->>'target_sets', i->>'target_reps_text',
--          i->>'rest_seconds'
--     from public.assignments a
--     cross join lateral jsonb_array_elements(a.snapshot->'days') d
--     cross join lateral jsonb_array_elements(d->'items') i
--    where a.client_id = (select id from public.clients where email = 'chris.merryweather@gmail.com')
--      and d->>'name' = 'Shoulders'
--      and a.id = (select id from public.assignments
--                   where client_id = a.client_id order by starts_on desc, created_at desc limit 1)
--    order by (i->>'order_index')::int;
