-- Throwing away a session that should not have happened.
--
-- 0001 through 0010 are applied, so this is a new file rather than an edit in place.
--
-- The need is ordinary: a session started by a mis-tap, a session logged twice, a test run on a
-- real account. The client asking for it is also the person whose training it is, and there is no
-- honest reason to make somebody live with a workout they did not do.
--
-- What is not ordinary is that this database will not let anybody delete it. set_logs is append
-- only and that is enforced in three independent places, on purpose:
--
--   0002  grants only select and insert, and writes no update or delete policy
--   0001  set_logs.session_id references sessions on delete restrict
--   the adapter refuses delete() against any table marked appendOnly
--
-- All three still stand after this migration. None of them is being relaxed, and a future change
-- that relaxes one to make deletion "simpler" should be read as a proposal to make a client's
-- logged history editable by whoever holds the session row.
--
-- So a discard is not a delete. It is the same move undo already makes, applied to a whole
-- session: every set that still counts gets a retraction row written against it, which is a new
-- row carrying supersedes_id and is_void, and then the session itself is marked discarded. The
-- rows stay on disk and stay attributable. Nothing that reads set_logs through activeSetLogs
-- counts them, which is every chart, every record and every prefill in the app.
--
-- The column is what the session rows themselves need, because a session emptied of sets is not
-- the same thing as a session that was discarded, and two places have to tell them apart:
-- pickDay advances the rotation from the last session, and the consistency grid draws a cell for
-- one. An emptied session with no marker would keep pushing the day picker forward and keep
-- drawing a filled square for a workout nobody did.

-- ---------------------------------------------------------------- the column

alter table public.sessions add column if not exists discarded_at timestamptz;

comment on column public.sessions.discarded_at is
  'When the client threw this session away. Non null means every set in it has been retracted '
  'and no screen should count it. The set_logs rows remain: this table has no delete path.';

-- Every read outside the history list filters on this, and a client with a year of training has
-- a few hundred session rows, so a partial index on the live ones keeps those reads on an index
-- rather than a scan as the discarded pile grows.
create index if not exists sessions_client_live_idx
  on public.sessions (client_id, started_at)
  where discarded_at is null;

-- ---------------------------------------------------------------- who may set it
--
-- Nobody new. sessions_client_all already covers select, insert, update and delete for the client
-- who owns the row, and this is an update to a column on that row. The trainer keeps
-- sessions_trainer_select, which is select only, so a trainer cannot discard a client's session.
--
-- That asymmetry is deliberate and worth stating. A trainer can read every session their client
-- logged and cannot make one disappear. The one person who can throw away the record of a workout
-- is the person who did it.

-- ---------------------------------------------------------------- nothing to backfill
--
-- Null means live, and every existing row is live. Adding a nullable column leaves them correct
-- without an update, which also means this migration takes no lock worth naming on a table that
-- is written to mid workout.
