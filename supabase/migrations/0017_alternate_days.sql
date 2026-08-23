-- A day that is an option instead of another day, rather than another day.
--
-- 0001 through 0016 are applied, so this is a new file rather than an edit in place.
--
-- The need came from the trainer, in his own words: he wants to add "A4 option 2", a second
-- cardio workout to be done in place of the cardio day he already has, and to add it without
-- disturbing anything already logged or anything logged from here on.
--
-- The first half of that is already true and needs no column. A template edit never reaches
-- anybody: assignments.snapshot is a frozen copy taken at assign time, sessions carry the
-- assignment_id they were logged under, and every screen that asks which program day a session was
-- reads that session's own snapshot. Adding a day writes new rows with new ids and touches none of
-- the old ones.
--
-- The second half is what this column is for. Without it the only way to add a second cardio
-- workout is a further day of the rotation, and the rotation is what decides which day the app
-- opens on: js/snapshot.js pickDay takes the last session's day and moves one along. A four day
-- program that gains a fifth day made of the same cardio session says "cardio" on the visit after
-- cardio, forever, and the client puts it right by hand every cycle. That is the failure the
-- day picker exists to prevent, arrived at from the other side.
--
-- So an option says which day it stands in for. It sits in the picker, it is one tap, it counts as
-- that day when the rotation moves on, and it takes that day's colour on the consistency grid with
-- a glyph of its own. It is not a second day of the week.

-- ---------------------------------------------------------------- the column

alter table public.template_days
  add column if not exists alternate_of uuid references public.template_days (id) on delete set null;

comment on column public.template_days.alternate_of is
  'The day of the rotation this one is an option instead of, or null for a day of the rotation '
  'itself. Points at another template_days row of the same template.';

-- On delete set null rather than cascade, deliberately. Deleting the cardio day should not take
-- the second cardio workout with it: the option is a whole day of exercises somebody typed, and
-- what it loses is the day it stood in for, not itself. It becomes a day of the rotation, which is
-- visible in the builder and correctable in one control.

-- Read whenever a program is frozen, which is every assign and every preview, so the lookup from a
-- day to its options is an index rather than a scan of the trainer's whole library of days.
create index if not exists template_days_alternate_of_idx
  on public.template_days (alternate_of)
  where alternate_of is not null;

-- ---------------------------------------------------------------- who may set it
--
-- Nobody new. template_days_trainer_all already covers select, insert, update and delete for the
-- trainer who owns the template, and this is a column on that row. A client never reads this table
-- at all: what reaches their phone is the snapshot, which carries the column inline like every
-- other field of a day.

-- ---------------------------------------------------------------- nothing to backfill
--
-- Null means a day of the rotation, and every row already written is one, because until now there
-- was nothing else a day could be. Adding a nullable column leaves them correct without an update.
--
-- Snapshots already handed out do not carry the column and are not rewritten: they are frozen by
-- definition. js/snapshot.js reads a missing alternate_of as null, which is what those programs
-- mean, and sameSnapshot treats an absent field and a null one as the same prescription so that
-- adding this column does not tell every trainer their clients are on an older version.

-- ---------------------------------------------------------------- a self reference, checked
--
-- A day cannot be an option instead of itself. Anything deeper than that (an option of an option,
-- or a cycle between two) is left to the application, which resolves an unknown or non rotation
-- parent by treating the day as a day of the rotation, because a constraint that can only be
-- expressed as a trigger is a worse answer than a read that cannot be confused.
alter table public.template_days
  drop constraint if exists template_days_alternate_not_self;
alter table public.template_days
  add constraint template_days_alternate_not_self check (alternate_of is null or alternate_of <> id);
