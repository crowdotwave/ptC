-- The program slot a set was done for, which after a swap is not the same fact as the lift.
--
-- A client who swaps bench press for machine press logs machine press, so the set counts toward
-- machine press's history and records rather than bench's. This column is what still says it was
-- done in bench's place: the template item's id in the assignment snapshot. The logging screen uses
-- it to put a swapped set back in its seat after an interrupted session, and anyone reading a
-- session later can see a swap happened by comparing it with the snapshot.
--
-- Nullable and unreferenced. Every row written before this is null and means what it always
-- meant, that the set was the slot's own lift. There is no foreign key because template items live
-- in frozen snapshot JSON, not only in template_items, and a trainer deleting a template row must
-- not be able to reach into a client's logged history.
--
-- No policy or grant changes: 0002 grants insert on set_logs at table level, so the column is
-- insertable by the same client policy as every other column, and there is still no update or
-- delete path. set_logs stays append only.

alter table public.set_logs add column if not exists template_item_id uuid;
