-- Half reps, removed after real use.
--
-- 0001 through 0008 are applied, so this is a new file rather than an edit in place. It reverses
-- the reps change made in 0007, and the reversal is worth recording rather than quietly undoing,
-- because the argument that justified halves is still a good argument and somebody will make it
-- again.
--
-- What was true: a hand kept training log really does carry halves, in roughly a quarter of its
-- sets, and a half really is the rep that got most of the way up. Rounding it away really does
-- lose information somebody chose to write down.
--
-- What beat it: the reps stepper is the control touched most, under fatigue, one handed, every
-- set of every session. Halving the step doubles the taps for everybody, permanently, to capture
-- something that fits in the session note. Tried in a real session and it did not survive.
--
-- The general rule this is an instance of: a cost paid every set outweighs information captured
-- occasionally, even when the information is real.

-- Floor rather than round to nearest. 10.5 means ten completed reps and a partial, so rounding
-- it up writes down an eleventh rep nobody finished. greatest() guards the one case floor breaks,
-- a value under 1, which the check constraint would otherwise reject.
alter table public.set_logs
  alter column reps type integer using greatest(1, floor(reps))::integer;

alter table public.set_logs drop constraint if exists set_logs_reps_check;
alter table public.set_logs add constraint set_logs_reps_check
  check (reps is null or reps > 0);

-- hold_seconds stays numeric on purpose. A hold that broke at 12.5 seconds is a single
-- observation rather than half of anything, and recording it costs no extra taps: the seconds
-- stepper moves in fives and the fraction only ever arrives by typing.
