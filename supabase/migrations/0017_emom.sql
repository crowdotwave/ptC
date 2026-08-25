-- A day that runs against a clock.
--
-- Every minute on the minute: the client does a fixed number of reps inside a fixed window, the
-- window ends whether or not the work got done, and the next one starts on top of it. Whatever is
-- left of the window after the reps are done is the rest. It is the one shape in this app where
-- the clock leads and the client follows, and nothing in the schema could express it: a day was a
-- list of lifts and a lift was a count of sets, with no way to say how long a set gets or how many
-- times the whole list repeats.
--
-- On the DAY rather than on the items, and that is the decision worth recording. What is being
-- described is the clock, and the clock belongs to the block rather than to any lift inside it.
-- Putting rounds on template_items would let six rows of one day disagree about how many times
-- round the block goes, and there is no sensible reading of that disagreement: a client cannot do
-- station one five times and station two eight times inside one rotation.
--
--   { "rounds": 5, "window_seconds": 60 }
--
-- Null means an ordinary day, which is every day in the database today and almost every day there
-- will ever be. Widening only: nothing already on disk becomes invalid, no policy changes, no
-- grant changes, and append only is untouched. js/emom.js owns what the two numbers mean and
-- refuses a malformed pair rather than letting it reach the logging screen, which is why this
-- column carries no check constraint beyond being an object: a day whose rounds somebody typed as
-- text must degrade to an ordinary day on a phone mid workout, not fail a write months earlier.
--
-- assignments.snapshot is deliberately NOT backfilled. It is frozen by definition, and every
-- snapshot already written was frozen from a day that had no clock on it, so writing one in now
-- would retroactively change what somebody was told to do. Clients pick this up the ordinary way,
-- by their trainer sending the program again, which is what the Send update button on the builder
-- is for. js/emom.js reads a missing key as null, so an old snapshot runs exactly as it did.

alter table public.template_days
  add column if not exists emom jsonb;

comment on column public.template_days.emom is
  'Every minute on the minute: {rounds, window_seconds}. Null for an ordinary day. The clock '
  'belongs to the block, so it lives on the day rather than on any one item in it. See js/emom.js.';

-- An object or nothing. This is the one shape guarantee worth having at the database, because a
-- scalar or an array here would mean js/emom.js reading `.rounds` off something that cannot have
-- one. What is inside the object is checked in the app, on purpose: see above.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.template_days'::regclass and conname = 'template_days_emom_is_object'
  ) then
    alter table public.template_days
      add constraint template_days_emom_is_object
      check (emom is null or jsonb_typeof(emom) = 'object');
  end if;
end $$;
