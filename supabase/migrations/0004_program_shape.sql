-- What a real trainer's program actually contains.
--
-- 0001 through 0003 are already applied, so this is a new file rather than an edit in place.
--
-- Everything here came from counting one trainer's real workbook: 61 exercise rows across 10
-- day blocks, all using an identical seven column layout. The counts below are the reason each
-- change exists, and they should be read before anything here is tightened again.
--
-- The governing finding: that trainer prescribes effort, never load. Zero of 61 rows named a
-- weight. Load was RIR on 37 rows, and BW or MODERATE or a duration on the rest. The weight a
-- client actually lifted appears nowhere in the program, which is exactly the gap the logging
-- screen fills.

-- ---------------------------------------------------------------- template_days
--
-- The header above every block, and the three warm up columns beside it. Shown to the client,
-- never logged. Nobody is ticking off a tibia raise, so this is instruction, not data.

alter table public.template_days
  add column day_type text,
  add column split text,
  add column warmup jsonb not null default '{"mobility": [], "general": [], "specific": []}'::jsonb,
  add column comments text not null default '';

-- ---------------------------------------------------------------- template_items

alter table public.template_items
  -- The trainer's own set number. '1', '2', but also '1A', '1B', '2C' where a superset or a
  -- circuit groups rows. Rows sharing a leading number belong together.
  add column group_label text,
  -- The Adjust column. Twenty distinct values in one workbook: BARBELL, CABLE, MED GRIP,
  -- SIT/STAND, TREAD, SPEED, HEIGHT. A modifier for this program, not a property of the
  -- exercise, so it cannot live on exercises.
  add column variation text,
  -- Whatever the trainer typed in Reps, kept verbatim: '8', '6-8', '50 FT', '500M', '10 MINS'.
  -- The numeric columns stay for the 45 rows that parse, and this carries all 61.
  add column target_reps_text text,
  -- Whatever the trainer typed in Load. target_rpe is derived from it where RIR appears,
  -- as ten minus the reps in reserve, and stays null for BW and MODERATE and the rest.
  add column target_load text,
  -- Whether the client logs this row at all. False for cardio intervals, where any number
  -- would be invented rather than measured.
  add column is_logged boolean not null default true,
  -- How it is logged when it is:
  --   weight_reps   the normal case
  --   weight_only   a carry or a sled push, where the load is the point and reps do not apply
  --   rounds        an AMRAP, where the client records rounds completed and the load used
  add column log_mode text not null default 'weight_reps'
    check (log_mode in ('weight_reps', 'weight_only', 'rounds'));

-- 14 of 61 rows have no set count, and 16 have a Reps cell that is a distance or a duration.
-- A NOT NULL here would reject two of the trainer's five days outright.
alter table public.template_items
  alter column target_sets drop not null,
  alter column target_reps_low drop not null,
  alter column rest_seconds drop not null;

-- ---------------------------------------------------------------- set_logs
--
-- Widening only. Every row already on disk stays valid, and append only is untouched: there is
-- still no update policy and no delete policy on this table.

alter table public.set_logs
  -- Null on a carry or a sled, where the load matters and there are no reps to count.
  alter column reps drop not null,
  -- Rounds completed in an AMRAP block, alongside the weight used. Null everywhere else.
  add column rounds integer check (rounds is null or rounds > 0);

-- The old constraint assumed reps was always present and always positive.
alter table public.set_logs drop constraint if exists set_logs_reps_check;
alter table public.set_logs add constraint set_logs_reps_check
  check (reps is null or reps > 0);

-- ---------------------------------------------------------------- grants
--
-- Nothing to add. The three tables touched here are granted at table level in 0002, so new
-- columns are covered automatically. Only clients and trainers carry column level grants, and
-- neither changed.
