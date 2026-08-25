-- Emma's EMOM day becomes a clock, and her phone is told about it.
--
-- Data only. 0017 added the column; this is the first day in the database to use it.
--
-- CARDIO, EMOM 5 MIN ROUNDS: six stations, one minute each, five rounds. Thirty windows, half an
-- hour. Minute one is twelve DB thrusters, minute two is twelve alternating snatches, and minute
-- seven is back to thrusters one round further on.
--
-- The rounds count is five because that is what the items already say. Every one of the six carries
-- target_sets 5, which on a clock-led day means the block goes round five times: each station is
-- performed five times, once per round. The day's NAME says "5 MIN ROUNDS", which reads as rounds
-- of five minutes and would give a different answer, but six stations cannot make a five minute
-- round and the sets column is the number the trainer actually typed per row. If five was the wrong
-- read, it is one field in the builder and the day is not yet trained against.
--
-- rest_seconds stays 60 on every row and is now simply unread on this day: the rest is whatever is
-- left of the window once the reps are done, which is the whole shape of the thing. Left rather
-- than nulled so that turning the clock back off restores an ordinary day with its rests intact.
--
-- The second half is the part that matters, and it is the snapshot rule doing its job. A client
-- reads their assignment and never the template, so switching the day on above reaches nobody: it
-- would sit there looking correct in the builder while Emma's phone ran six lifts as an ordinary
-- list. The way through is a new assignment carrying the current snapshot, which is exactly what
-- the Send update button in the builder writes, and exactly what 0016 did when it first put her on
-- this program. Written here rather than left for Clay to press because the day is being changed
-- from underneath him by this migration, not by him.
--
-- deload_weeks carries forward from whatever she is on, per the rule in CLAUDE.md. It is empty
-- today and the carry still belongs here: the next person to copy this file will not be so lucky.
--
-- Idempotent. The update is keyed on the day still being an ordinary one OR already carrying these
-- exact settings, and the assignment is written only when Emma's current snapshot does not already
-- have the clock in it.

do $$
declare
  v_template uuid;
  v_day uuid;
  v_emma uuid;
  v_current record;
  v_snapshot jsonb;
begin
  select id into v_template from public.program_templates where name = 'Emma Brown 2';
  select id into v_emma from public.clients where lower(email) = lower('emmairenebrown@gmail.com');

  if v_template is null then
    raise exception 'No program_templates row named Emma Brown 2. Nothing changed.';
  end if;
  if v_emma is null then
    raise exception 'No clients row for emmairenebrown@gmail.com. Nothing changed.';
  end if;

  select id into v_day
    from public.template_days
   where template_id = v_template and split = 'EMOM 5 MIN ROUNDS';

  if v_day is null then
    raise exception 'No day called EMOM 5 MIN ROUNDS on Emma Brown 2. Nothing changed.';
  end if;

  -- Six stations is what makes five rounds thirty minutes. If somebody has added or removed a lift
  -- since this was written, the block is a different length and a person should look at it.
  if (select count(*) from public.template_items where day_id = v_day) <> 6 then
    raise notice 'The EMOM day no longer has six stations. The clock is still set to 5 rounds.';
  end if;

  update public.template_days
     set emom = jsonb_build_object('rounds', 5, 'window_seconds', 60), updated_at = now()
   where id = v_day
     and emom is distinct from jsonb_build_object('rounds', 5, 'window_seconds', 60);

  -- The snapshot as js/snapshot.js buildSnapshot writes it, now carrying the day's clock.
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
    raise exception 'Emma Brown 2 froze to no days. Nothing assigned.';
  end if;

  -- The block she is on now: latest starts_on, ties broken by created_at, which is what
  -- js/snapshot.js currentAssignment does and therefore what her phone is actually reading.
  select * into v_current
    from public.assignments
   where client_id = v_emma
   order by starts_on desc, created_at desc
   limit 1;

  if v_current.id is null then
    raise exception 'Emma is on no program at all. Run 0016 first.';
  end if;

  -- Already carrying a clock on that day, so this has run before and there is nothing to send.
  if v_current.template_id = v_template
     and exists (
       select 1 from jsonb_array_elements(v_current.snapshot->'days') d
        where d->>'split' = 'EMOM 5 MIN ROUNDS' and d->'emom' is not null and d->'emom' <> 'null'::jsonb
     ) then
    raise notice 'Emma already has the clock. Nothing sent.';
    return;
  end if;

  insert into public.assignments (id, client_id, template_id, snapshot, starts_on, ends_on, deload_weeks)
  values (
    gen_random_uuid(), v_emma, v_template, v_snapshot, current_date, null,
    case when v_current.template_id = v_template then coalesce(v_current.deload_weeks, '[]'::jsonb) else '[]'::jsonb end
  );
  raise notice 'sent Emma Brown 2 with the clock on the EMOM day';
end $$;

-- Expected after this runs: one row, 5 rounds, 60 second window, six stations.
--
--   select d->>'split', d->'emom', jsonb_array_length(d->'items')
--     from public.assignments a
--     cross join lateral jsonb_array_elements(a.snapshot->'days') d
--    where a.client_id = (select id from public.clients where email = 'emmairenebrown@gmail.com')
--      and d->'emom' is not null
--    order by a.created_at desc limit 1;
