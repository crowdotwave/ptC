-- Chris's leg day becomes the three holds and nothing else, and his phone is told about it.
--
-- Data only. No table, no policy, no function changes.
--
-- 0022 put a back extension hold and two glute bridge holds at the front of Legs and core for a back
-- recovering from sciatic pain and a possible lumbar disc herniation. Chris then took the rest of
-- the day off it: the goblet squat, the Bulgarian split squat, the L sit and the hollow body. Loaded
-- squatting and the L sit's hip flexion under load are the lifts on that day most likely to argue
-- with a disc, and the day is now what he can train through while it settles.
--
-- What is removed is the template rows and nothing else. The lifts stay in Clay's library, since
-- other programs and other people's history name them. Every set Chris logged against them stays
-- exactly where it is: set_logs point at the exercise, which is untouched, and at a template item
-- only as a plain uuid with no reference, because slots live in frozen snapshot JSON. His earlier
-- assignments still carry the old day, so history reads as the program he actually did.
--
-- The three holds are renumbered 1 to 3 in case anything shifted, and a new assignment carries the
-- current snapshot, starting today, the same move as the Send update button, 0018, 0021 and 0022.
-- deload_weeks carries forward per the rule in CLAUDE.md.
--
-- Idempotent. The delete matches nothing the second time, and the assignment is written only when
-- Chris's current snapshot still has something on Legs and core besides the holds.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_keep uuid[];
  v_removed integer;
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

  -- The holds are what stays. All three have to exist, or removing everything else would leave the
  -- day emptier than anybody asked for.
  select array_agg(id) into v_keep
    from public.exercises
   where trainer_id = v_clay
     and slug in ('back-extension-hold', 'glute-bridge-hold', 'single-leg-glute-bridge-hold');

  if coalesce(array_length(v_keep, 1), 0) <> 3 then
    raise exception 'Clay is missing one of the three holds. Run 0021 and 0022 first. Nothing changed.';
  end if;
  if (select count(*) from public.template_items where day_id = v_day and exercise_id = any(v_keep)) <> 3 then
    raise exception 'Legs and core does not carry all three holds. Run 0022 first. Nothing changed.';
  end if;

  -- ---------------------------------------------------------------- off the day

  delete from public.template_items
   where day_id = v_day
     and exercise_id <> all(v_keep)
     and exercise_id in (
       select id from public.exercises
        where trainer_id = v_clay
          and name in ('Kettlebell Goblet Squat', 'Bulgarian Split Squat', 'L Sit Hold', 'Hollow Body Hold')
     );
  get diagnostics v_removed = row_count;
  raise notice 'removed % lifts from Legs and core', v_removed;

  if (select count(*) from public.template_items where day_id = v_day) <> 3 then
    raise notice 'Legs and core still carries something besides the holds. It stays; a person should look.';
  end if;

  -- Shifted out of the way first so no two rows share a position mid update.
  update public.template_items set order_index = order_index + 10000 where day_id = v_day;

  with ranked as (
    select i.id, row_number() over (order by i.order_index) - 1 as pos
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
     and not exists (
       select 1
         from jsonb_array_elements(v_current.snapshot->'days') d
        cross join lateral jsonb_array_elements(d->'items') i
        where d->>'name' = 'Legs and core'
          and not ((i->>'exercise_id')::uuid = any(v_keep))
     ) then
    raise notice 'Chris''s leg day is already the holds alone. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with Legs and core as the three holds';
end $$;

-- Expected after this runs: three lifts on Legs and core, the back extension hold first.
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
