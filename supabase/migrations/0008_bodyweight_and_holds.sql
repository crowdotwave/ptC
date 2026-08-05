-- Exercises with no external load at all.
--
-- 0001 through 0007 are applied, so this is a new file rather than an edit in place.
--
-- Driven by a real three day program: pushups, pullups, and pike pushups carry no weight, and
-- an L sit and a hollow body are measured only in seconds. Five of its twelve exercises could
-- not be recorded honestly before this.

-- ---------------------------------------------------------------- how long a hold lasted
--
-- Numeric rather than an integer, because a hold that broke at 12.5 seconds is a real
-- observation and rounding it is the same mistake as rounding a half rep.

alter table public.set_logs add column hold_seconds numeric
  check (hold_seconds is null or hold_seconds > 0);

-- ---------------------------------------------------------------- two more ways to log
--
-- bodyweight_reps is a separate mode rather than weight_reps with a zero weight, and the
-- difference is not cosmetic. At zero, volume is zero and Epley returns an estimated 1RM of
-- zero, so a client going from 12 pushups to 15 would watch a flat line along the bottom of the
-- chart while getting visibly stronger. The honest series for these is the rep count itself,
-- which is what js/progression.js now leads with when it sees them.
--
-- Recording the client's body weight and multiplying was considered and rejected. CLAUDE.md
-- makes body weight opt in, off by default, and absent from every shareable export, so making
-- it a required input for logging a pushup would put the one number this product refuses to
-- lead with at the centre of the logging screen.
--
-- time_hold has no reps and no load. Seconds are the whole of what happened.

alter table public.template_items drop constraint if exists template_items_log_mode_check;
alter table public.template_items add constraint template_items_log_mode_check
  check (log_mode in ('weight_reps', 'weight_only', 'rounds', 'bodyweight_reps', 'time_hold'));

-- ---------------------------------------------------------------- what stays true
--
-- weight_kg is still not null, and a bodyweight or hold row stores zero in it. That is honest
-- here in a way it would not be as a log_mode: the external load really was zero. What the zero
-- must never do is reach a strength calculation, which is why buildProgression drops rows at or
-- below zero from the estimated 1RM series rather than charting them as nothing.
--
-- Nothing about append only changes. There is still no update policy and no delete policy on
-- set_logs, and the staff select policy added in 0006 is unaffected by a new column.
