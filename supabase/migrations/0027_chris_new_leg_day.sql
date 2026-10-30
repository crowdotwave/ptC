-- Chris's leg day goes back to lifting: four loaded lifts, the leg curl and leg extension as a
-- superset, then the back extension hold and the single leg bridge hold to finish.
--
-- Data only. No table, no policy, no function changes.
--
-- 0023 cut Legs and core to three holds while a back recovering from sciatic pain settled. Chris has
-- now written the day he wants to train, as he asked for it:
--
--   1   Goblet squat                3 x 8-12
--   2   Bench hip thrust            3 x 10-15
--   3A  Lying leg curl              3 x 10-15    superset, 3 rounds
--   3B  Leg extension               3 x 12-15    (he wrote 2-3, then asked for 3 rounds)
--   4   Back extension hold         3 x 20-30 sec
--   5   Single leg bridge hold      2 x 20-30 sec per side, optional
--
-- And asked for it set up for coming back to it, not for where he was. So:
--
--   Every loaded lift is RPE 7 (target_rpe, and target_load is what the screen shows), three reps in
--   the tank, and the note says to stay at the bottom of the range for the first two weeks. The
--   ranges are his and stay his: progress is the rule already on his other days, top of the range on
--   every set, then add weight.
--
--   Starting weights, for lifts with no history (starting_weight_kg, stored in kg, shown in lb):
--   hip thrust 45 lb, the empty bar; lying leg curl 30 lb; leg extension 40 lb. Picked against what
--   he moves now on his other days (35 lb dumbbells for 12 on the seated press, 40 lb on the row),
--   light on purpose. The goblet squat already has two sets of history, 8.8 lb in August, and
--   history beats a starting weight in the prefill, so its 20 lb is in the note instead.
--
--   The holds open at the bottom of their range, 20 seconds.
--
-- Which rows these land on:
--
--   Goblet squat is Clay's Kettlebell Goblet Squat, the lift 0023 took off this day, so the two sets
--   already logged against it stay on one chart line. Bench hip thrust is Clay's BARBELL HIP THRUST
--   with the bench in the variation, since a trainer's own lift beats the library's of the same name
--   (js/library.js). Lying leg curl is the library's Lying Leg Curl: Clay's own Leg Curl does not say
--   lying or seated, and those are different strengths. Leg extension is Clay's Leg Extension.
--
--   The superset is 3A and 3B (parseGroup in js/program.js), so the program view brackets it as one.
--   The logging screen still walks every curl before every extension, so the curl's rest is the walk
--   to the next machine, 15 seconds, and the round's rest sits on the extension, 90. Until the
--   screen alternates on its own, the workout panel is how to hop between the two.
--
--   The bridge hold is two sides of two sets, four rows of one leg each, alternating, the same shape
--   0022 gave it, and optional: skip is one tap with no failure state. The two leg Glute Bridge Hold
--   comes off the day. The exercise stays in Clay's library.
--
-- Then a new assignment carrying the current snapshot, starting today, deload_weeks carried: the same
-- move as 0018 and 0021 to 0026. Checked before writing: nothing in the template has been edited
-- since the 0026 assignment, so this sends the leg day and nothing else.
--
-- Idempotent. The day is rebuilt only while it does not already carry the lying leg curl, and the
-- assignment is written only when Chris's current snapshot does not.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_squat uuid;
  v_thrust uuid;
  v_curl uuid;
  v_extension uuid;
  v_back_hold uuid;
  v_bridge uuid;
  v_single_bridge uuid;
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

  select id into v_day from public.template_days where template_id = v_template and name = 'Legs and core';
  if v_day is null then
    raise exception 'No day called Legs and core on Chris, three day split. Nothing changed.';
  end if;

  select id into v_squat from public.exercises where trainer_id = v_clay and slug = 'kettlebell-goblet-squat';
  select id into v_thrust from public.exercises where trainer_id = v_clay and slug = 'barbell-hip-thrust';
  select id into v_curl from public.exercises where is_global and trainer_id is null and slug = 'lying-leg-curl';
  select id into v_extension from public.exercises where trainer_id = v_clay and slug = 'leg-extension';
  select id into v_back_hold from public.exercises where trainer_id = v_clay and slug = 'back-extension-hold';
  select id into v_bridge from public.exercises where trainer_id = v_clay and slug = 'glute-bridge-hold';
  select id into v_single_bridge from public.exercises where trainer_id = v_clay and slug = 'single-leg-glute-bridge-hold';

  if v_squat is null or v_thrust is null or v_curl is null or v_extension is null
     or v_back_hold is null or v_single_bridge is null then
    raise exception 'One of the six lifts is missing from Clay''s library or the shared one. Nothing changed.';
  end if;

  -- ---------------------------------------------------------------- the day

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_curl) then
    if (select count(*) from public.template_items
         where day_id = v_day and exercise_id in (v_back_hold, v_single_bridge)) <> 2 then
      raise exception 'Legs and core does not carry both holds. Run 0022 and 0023 first. Nothing changed.';
    end if;

    delete from public.template_items where day_id = v_day and exercise_id = v_bridge;

    -- Out of the way first so no two rows share a position mid update.
    update public.template_items set order_index = order_index + 10000 where day_id = v_day;

    update public.template_items
       set order_index = 4, group_label = '4',
           target_reps_low = 20, target_reps_high = 30, target_reps_text = '20-30 sec',
           updated_at = now()
     where day_id = v_day and exercise_id = v_back_hold;

    update public.template_items
       set order_index = 5, group_label = '5',
           target_sets = 4, target_reps_low = 20, target_reps_high = 30,
           target_reps_text = '20-30 sec per side',
           notes = 'Optional. One leg per set: left, right, left, right. Hips level, no twist.',
           updated_at = now()
     where day_id = v_day and exercise_id = v_single_bridge;

    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_squat, 0, '1', null, 3,
       8, 12, '8-12', 'RPE 7', 7,
       120, 'Coming back: start around 20 lb and stay at 8 reps for the first two weeks, three left in the tank. Then build to 12 on every set before adding weight. Stop if pain runs down the leg.',
       true, 'weight_reps', null),
      (gen_random_uuid(), v_day, v_thrust, 1, '2', 'Back on a bench', 3,
       10, 15, '10-15', 'RPE 7', 7,
       90, 'Upper back on the bench, ribs down, no arch at the top. Coming back: the empty bar, 10 reps for the first two weeks. Then build to 15 on every set before adding weight. Stop if pain runs down the leg.',
       true, 'weight_reps', 20.412),
      (gen_random_uuid(), v_day, v_curl, 2, '3A', null, 3,
       10, 15, '10-15', 'RPE 7', 7,
       15, 'Superset with leg extension: straight to it, rest after the extension. Hips down on the pad. Coming back: 10 reps for the first two weeks, then build to 15 before adding weight.',
       true, 'weight_reps', 13.608),
      (gen_random_uuid(), v_day, v_extension, 3, '3B', null, 3,
       12, 15, '12-15', 'RPE 7', 7,
       90, 'Superset with leg curl, rest after this one. Coming back: 12 reps for the first two weeks, then build to 15 before adding weight.',
       true, 'weight_reps', 18.144);

    if (select count(*) from public.template_items where day_id = v_day) <> 6 then
      raise notice 'Legs and core carries something besides the six. It stays; a person should look.';
    end if;
    raise notice 'rebuilt Legs and core as the new leg day';
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
        where i->>'exercise_id' = v_curl::text
     ) then
    raise notice 'Chris already has the new leg day. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with the new leg day';
end $$;

-- Expected after this runs: six lifts on Legs and core.
--
--   0  1   Kettlebell Goblet Squat          3  8-12       RPE 7  (history prefills; note says 20 lb)
--   1  2   BARBELL HIP THRUST (bench)       3  10-15      RPE 7  opens at 45 lb
--   2  3A  Lying Leg Curl                   3  10-15      RPE 7  opens at 30 lb, 15s rest
--   3  3B  Leg Extension                    3  12-15      RPE 7  opens at 40 lb, 90s rest
--   4  4   Back Extension Hold              3  20-30 sec
--   5  5   Single Leg Glute Bridge Hold     4  20-30 sec per side
