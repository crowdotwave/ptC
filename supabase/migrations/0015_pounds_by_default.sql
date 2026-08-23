-- Pounds by default, for anybody who arrives from here on.
--
-- weight_unit is a display preference and nothing else. Weight is stored in kilograms everywhere
-- and always, per CLAUDE.md, so this changes no stored number, converts no set_log, and is
-- reversible by one tap in the app's footer.
--
-- Why: the column has defaulted to kilograms since 0001 and the app's own fallback matched it.
-- Nobody using this reads kilograms. The trainer and every client are in Canadian gyms with pound
-- plates and pound stacks, so the default meant a first run showing the wrong numbers on every
-- screen until somebody found the switch, which until now lived in the corner of the header and is
-- now a line in the page footer. A default everybody changes is not a neutral default, it is a
-- chore with an opinion.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH, and the second one is the reason to read before writing.
--
-- Existing rows. Everybody already in here has a preference, whether they set it or accepted the
-- old default, and a migration that rewrites a display preference underneath somebody is the same
-- class of mistake as a trainer's tap changing the unit on a client's phone, which the column
-- grants in 0002 exist to prevent. New rows only.
--
-- ptc.handle_new_auth_user. An earlier draft of this file restated that function to move a
-- weight_unit fallback inside it. That fallback is not there any more: 0003 and 0006 created a
-- trainers row for an unrecognised email, 0007 closed self signup, and 0010 is the version that is
-- live. It binds an existing row and returns 'none' for anybody it does not recognise, and it
-- inserts nothing. Restating it to change a default would have quietly reopened public signup as a
-- side effect of a unit preference. The function is left alone.

alter table public.clients alter column weight_unit set default 'lb';
alter table public.trainers alter column weight_unit set default 'lb';
