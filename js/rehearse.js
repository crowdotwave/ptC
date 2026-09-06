// Walking a client's program without being that client, and without writing anything down.
//
// A trainer builds a day in a spreadsheet-shaped editor and then has no way to find out what it
// feels like at arm's length: whether the rep target reads at a glance, whether a superset is
// written the way they meant, whether an EMOM's rounds add up to a block anybody can stand. The
// only two things that could answer that were the seeded fake data, which is somebody else's
// program, and assigning the thing to a real person and asking them.
//
// So this opens the REAL logging screen against a real assignment, with the far end of the storage
// adapter replaced by memory. Not a preview, not a copy, not a diagram of the screen: the screen.
// That principle is already written down twice in this repo, once about `?local=1` ("routed exactly
// like a real session, so this exercises the app people use rather than a variant of it") and once
// about the EMOM rehearsal ("a rehearsal that drew its own version of the screen would be a
// rehearsal of something no client ever sees"). This is the same argument a third time.
//
// WHAT IT READS, and why each one is allowed:
//
//   clients        the one row, for the name on the bar and the unit the numbers print in
//   assignments    the current one, whose `snapshot` IS the program on that person's phone
//   exercises      the trainer's library, for equipment and increments
//
// Every one of those is a row the trainer already owns and already holds on this device, so this
// adds no policy, no grant, and no row to the write map in CLAUDE.md. It cannot: nothing here
// writes, and the storage it hands back has no remote to write to.
//
// WHAT IT DELIBERATELY DOES NOT COPY: sessions and set_logs. A rehearsal is not a simulation of
// somebody's history and must not pretend to be one. With no rows, every lift opens at the
// trainer's own `starting_weight_kg` or, where that is blank, at the deliberately light equipment
// fallback, and every set says so rather than claiming a last time. That is the honest answer, and
// it is also the more useful one: the screen a client sees on their FIRST session with a program is
// the screen a trainer has no other way to look at.
//
// The frozen snapshot rather than the live template, deliberately. The question a trainer opens
// this to answer is "what is on her phone", and after an edit that has not been sent those are two
// different programs. See the assignment rules in CLAUDE.md: a template edit reaches a client
// through a new assignment and never by rewriting the old one.

import { createStorage } from './storage.js';
import { createMemoryDriver } from './storage-memory.js';
import { currentAssignment } from './snapshot.js';

/**
 * Which client this load is rehearsing, or null for an ordinary one.
 *
 * Read straight from the query string and NEVER made sticky, which is the one way this differs
 * from `?local=1`. That flag is sticky because it chooses which dataset the whole app is looking
 * at and has to survive moving between screens. This chooses a throwaway, and a throwaway that
 * followed somebody from screen to screen for the rest of a browser session is how a trainer ends
 * up believing they logged something. Leaving the screen ends the rehearsal, which is the same
 * promise as closing the tab.
 */
export function rehearsalTarget(search = location.search) {
  const id = new URLSearchParams(search).get('rehearse');
  return id ? id : null;
}

/**
 * A storage adapter holding one client's current program and nothing else.
 *
 * Returns null when there is nothing to walk through: no such client on this device, or a client
 * with no program yet. The caller falls back to the ordinary boot rather than opening an empty
 * rehearsal, because "nothing assigned" is a real answer the trainer needs, and it belongs on the
 * screen that lists their clients rather than on a logging screen with no plan behind it.
 */
export async function openRehearsal(source, clientId) {
  const client = await source.get('clients', clientId);
  if (!client) return null;

  const assignment = await currentAssignment(source, clientId);
  if (!assignment) return null;

  const exercises = await source.query('exercises', {});

  // Seeded through the driver rather than through `storage.put`, so nothing here is validated,
  // stamped, or queued on the way in. These are rows that already exist and are already on the
  // server; putting them would write an outbox entry describing a change nobody made.
  const storage = createStorage(
    createMemoryDriver({
      clients: [client],
      assignments: [assignment],
      exercises,
    }),
  );

  // No setRemote, and that is the load bearing line in this file. Without a remote every write
  // this screen makes lands in a Map and queues in an outbox that has nowhere to drain to, so a
  // rehearsal cannot reach the server even if something later forgets it is a rehearsal.
  return { storage, client, assignment };
}
