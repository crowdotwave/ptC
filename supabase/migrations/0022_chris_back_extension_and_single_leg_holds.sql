-- Chris's leg day opens with holds, for a back that is recovering, and his phone is told about it.
--
-- Data only. No table, no policy, no function changes.
--
-- Chris is working back from sciatic pain and a possible lumbar disc herniation, and asked for his
-- leg day to open with isometric work: a back extension hold on the horizontal bench first, then the
-- glute bridge hold 0021_chris_glute_bridge_holds added, then the single leg version of it. Rest
-- times are an opening guess he will dial in, and each is one field in the builder.
--
-- What is written:
--
--   exercises        Back Extension Hold and Single Leg Glute Bridge Hold, in Clay's library,
--                    bodyweight. Separate lifts rather than the existing Back Extension and the
--                    library's Single Leg Glute Bridge with a hold mode on them, because progress
--                    is charted per lift: Clay's Back Extension already carries weighted sets, and
--                    seconds written against it would be drawn on the same line as kilograms.
--                    Owned by Clay for the reason 0021 gives: a client reads their own trainer's
--                    rows and the shared library, and every other lift in this program is his.
--   template_items   the day is renumbered so the three holds lead it, in that order, and whatever
--                    else is on the day follows in the order it already had. Group labels on this
--                    day are the plain position and move with it.
--
--                    Back Extension Hold    3 x 20-30 sec, 60 sec rest
--                    Glute Bridge Hold      unchanged, 3 x 30-45 sec, 60 sec rest
--                    Single Leg Glute Bridge Hold
--                                           6 x 20-30 sec, 30 sec rest. One side per set,
--                                           alternating, so three holds a leg. The timer times one
--                                           hold and writes one number, so a set that covered both
--                                           legs would have to record one of them or an average,
--                                           and neither is what happened. The short rest is the
--                                           switch; each leg still gets a full minute between its
--                                           own holds.
--
--   assignments      a new row carrying the current snapshot, starting today, the same move as the
--                    Send update button, 0018 and 0021. Sessions already logged keep pointing at
--                    the assignment they were done under.
--
-- deload_weeks carries forward per the rule in CLAUDE.md. It is empty today.
--
-- Checked before writing, against the live rows: nothing on the template has changed since Chris's
-- current assignment was frozen on 2026-09-26, so the new snapshot differs from his current one by
-- these holds and the new order and nothing else.
--
-- Idempotent. Each exercise is written only if Clay has none by that slug, each item only if the
-- day does not already carry it, the renumber lands on the same order every time, and the
-- assignment is written only when Chris's current snapshot does not already open with these holds.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_back uuid;
  v_bridge uuid;
  v_single uuid;
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

  -- The glute bridge hold is 0021's, and this file orders around it rather than adding it again.
  select id into v_bridge
    from public.exercises
   where trainer_id = v_clay and slug = 'glute-bridge-hold';

  if v_bridge is null then
    raise exception 'Clay has no Glute Bridge Hold. Run 0021_chris_glute_bridge_holds first.';
  end if;

  -- ---------------------------------------------------------------- the lifts

  select id into v_back
    from public.exercises
   where trainer_id = v_clay and slug = 'back-extension-hold';

  if v_back is null then
    v_back := gen_random_uuid();
    insert into public.exercises
      (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values
      (v_back, v_clay, 'Back Extension Hold', 'back-extension-hold', 'lower back', 'bodyweight', null, false, 2.5);
    raise notice 'added Back Extension Hold to Clay''s library';
  end if;

  select id into v_single
    from public.exercises
   where trainer_id = v_clay and slug = 'single-leg-glute-bridge-hold';

  if v_single is null then
    v_single := gen_random_uuid();
    insert into public.exercises
      (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values
      (v_single, v_clay, 'Single Leg Glute Bridge Hold', 'single-leg-glute-bridge-hold', 'glutes', 'bodyweight', null, false, 2.5);
    raise notice 'added Single Leg Glute Bridge Hold to Clay''s library';
  end if;

  -- ---------------------------------------------------------------- on the day

  -- Written at the end for now; the renumber below puts them where they belong.
  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_back) then
    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_back, 1000, null, 'Horizontal bench', 3,
       20, 30, '20-30 sec', null, null,
       60,
       'Hips on the pad, body in one straight line from head to heels. Squeeze the glutes and hold level; do not arch above it. Stop if pain runs down the leg.',
       true, 'time_hold', null);
    raise notice 'added Back Extension Hold to Legs and core';
  end if;

  if not exists (select 1 from public.template_items where day_id = v_day and exercise_id = v_single) then
    insert into public.template_items
      (id, day_id, exercise_id, order_index, group_label, variation, target_sets,
       target_reps_low, target_reps_high, target_reps_text, target_load, target_rpe,
       rest_seconds, notes, is_logged, log_mode, starting_weight_kg)
    values
      (gen_random_uuid(), v_day, v_single, 1001, null, null, 6,
       20, 30, '20-30 sec, alternate legs', null, null,
       30,
       'One leg per set: left, right, left, right, left, right. Hips level, no twist, and the same height as the two leg hold.',
       true, 'time_hold', null);
    raise notice 'added Single Leg Glute Bridge Hold to Legs and core';
  end if;

  -- The three holds lead, in that order, and everything else keeps the order it had. Shifted out of
  -- the way first so no two rows ever share a position mid update.
  update public.template_items set order_index = order_index + 10000 where day_id = v_day;

  with ranked as (
    select i.id,
           row_number() over (
             order by case i.exercise_id when v_back then 0 when v_bridge then 1 when v_single then 2 else 3 end,
                      i.order_index
           ) - 1 as pos
      from public.template_items i
     where i.day_id = v_day
  )
  update public.template_items i
     set order_index = r.pos,
         group_label = case when i.group_label is null or i.group_label ~ '^\d+$' then (r.pos + 1)::text else i.group_label end,
         updated_at = now()
    from ranked r
   where r.id = i.id;

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
        where d->>'name' = 'Legs and core'
          and i->>'exercise_id' = v_back::text
          and (i->>'order_index')::int = 0
     ) then
    raise notice 'Chris already opens leg day with the back extension hold. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with the holds leading Legs and core';
end $$;

-- Expected after this runs: seven lifts on Legs and core, the three holds first.
--
--   select i->>'order_index', i->'exercise'->>'name', i->>'target_sets', i->>'target_reps_text',
--          i->>'rest_seconds', i->>'log_mode'
--     from public.assignments a
--     cross join lateral jsonb_array_elements(a.snapshot->'days') d
--     cross join lateral jsonb_array_elements(d->'items') i
--    where a.client_id = (select id from public.clients where email = 'chris.merryweather@gmail.com')
--      and d->>'name' = 'Legs and core'
--      and a.id = (select id from public.assignments
--                   where client_id = a.client_id order by starts_on desc, created_at desc limit 1)
--    order by (i->>'order_index')::int;
