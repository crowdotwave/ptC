-- The last lift on Chris's shoulder day is the seated dumbbell lateral raise, not the cable one.
--
-- Data only. No table, no policy, no function changes.
--
-- 0024 wrote that slot as Seated Cable Lateral Raise with the dumbbell version as the alternative in
-- the note. Chris does it with dumbbells, so the dumbbell version is the lift and the slot says so.
-- Same prescription: 3 x 12-20, 1-2 RIR, 90s rest.
--
-- A new exercise rather than a rename of the cable row, because a cable and a dumbbell are different
-- equipment with different increments and a chart that joined them would be drawing the machine.
--
-- The cable exercise is removed from Clay's library, and only because nothing anywhere points at it:
-- 0024 created it hours before this, no set was ever logged against it, and no template item holds
-- it once the slot is swapped. The guard below refuses rather than assumes. The 0024 assignment
-- keeps its frozen copy inline, which is what a snapshot is for.
--
-- Then a new assignment carrying the current snapshot, starting today, deload_weeks carried: the same
-- move as 0018, 0021 and 0024. Checked before writing: nothing in the template has been edited since
-- the 0024 assignment, so this sends the swap and nothing else.
--
-- Idempotent. The swap is keyed on the slot still holding the cable lift, and the assignment is
-- written only when Chris's current snapshot does not already carry the dumbbell raise.

do $$
declare
  v_clay uuid;
  v_chris uuid;
  v_template uuid;
  v_day uuid;
  v_cable uuid;
  v_raise uuid;
  v_current record;
  v_snapshot jsonb;
begin
  select id into v_clay from public.trainers where lower(email) = lower('clayh97@outlook.com');
  select id into v_chris from public.clients where lower(email) = lower('chris.merryweather@gmail.com');
  select id into v_template from public.program_templates where name = 'Chris, three day split';

  if v_clay is null or v_chris is null or v_template is null then
    raise exception 'Missing Clay, Chris, or Chris, three day split. Nothing changed.';
  end if;

  select id into v_day from public.template_days where template_id = v_template and name = 'Shoulders';
  if v_day is null then
    raise exception 'No day called Shoulders on Chris, three day split. Nothing changed.';
  end if;

  select id into v_cable from public.exercises where trainer_id = v_clay and slug = 'seated-cable-lateral-raise';

  select id into v_raise from public.exercises where trainer_id = v_clay and slug = 'seated-dumbbell-lateral-raise';
  if v_raise is null then
    v_raise := gen_random_uuid();
    insert into public.exercises (id, trainer_id, name, slug, primary_muscle, equipment, media_url, is_global, increment_kg)
    values (v_raise, v_clay, 'Seated Dumbbell Lateral Raise', 'seated-dumbbell-lateral-raise', 'shoulders', 'dumbbell', null, false, 2.5);
    raise notice 'added Seated Dumbbell Lateral Raise to Clay''s library';
  end if;

  if v_cable is not null then
    update public.template_items
       set exercise_id = v_raise,
           notes = 'Seated, back on the bench. When you hit 20 on every set, add weight.',
           updated_at = now()
     where day_id = v_day and exercise_id = v_cable;

    if not exists (select 1 from public.template_items where exercise_id = v_cable)
       and not exists (select 1 from public.set_logs where exercise_id = v_cable) then
      delete from public.exercises where id = v_cable;
      raise notice 'removed the unused Seated Cable Lateral Raise';
    else
      raise notice 'Seated Cable Lateral Raise is still referenced. Left in the library.';
    end if;
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
        where i->>'exercise_id' = v_raise::text
     ) then
    raise notice 'Chris already has the seated dumbbell lateral raise. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_chris, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Chris, three day split with the seated dumbbell lateral raise';
end $$;
