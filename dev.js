// Adapter check page. Not the app. Its job is to prove the storage adapter opens, migrates,
// seeds, writes, reads back, and refuses what CLAUDE.md says it must refuse.

import { openStorage, makeRecord, newId, getDeviceId } from './js/storage.js';
import { TABLE_NAMES } from './js/schema.js';
import { seed, isSeeded, getDefaultClientId } from './js/seed.js';
import { activeSetLogs, epley1rm } from './js/history.js';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('adapter-status');
const countsEl = document.getElementById('counts');
const buttons = ['run-test', 'reseed', 'sync'].map((id) => document.getElementById(id));

const escapeHtml = (value) =>
  String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function line(text, kind = '') {
  const tag = { pass: 'b', fail: 'i', dim: 'em' }[kind];
  const body = escapeHtml(text);
  logEl.insertAdjacentHTML('beforeend', tag ? `<${tag}>${body}</${tag}>\n` : `${body}\n`);
  logEl.scrollTop = logEl.scrollHeight;
}

const pass = (text) => line(`pass  ${text}`, 'pass');
const fail = (text) => line(`FAIL  ${text}`, 'fail');
const note = (text) => line(`      ${text}`, 'dim');

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setBusy(busy) {
  for (const button of buttons) button.disabled = busy;
}

function assert(condition, description) {
  if (condition) pass(description);
  else fail(description);
  return Boolean(condition);
}

async function renderCounts(storage) {
  const counts = await storage.counts();
  const pending = (await storage.pending()).length;
  countsEl.innerHTML = [...TABLE_NAMES.map((table) => [table, counts[table]]), ['outbox', pending]]
    .map(([label, value]) => `<div class="dev__tile"><b>${value}</b><span>${label}</span></div>`)
    .join('');
}

async function runAdapterCheck(storage) {
  logEl.innerHTML = '';
  setBusy(true);
  setStatus('Checking', 'busy');
  let ok = true;

  try {
    const trainer = (await storage.query('trainers', {}, { limit: 1 }))[0];
    ok = assert(Boolean(trainer), 'read a seeded trainer through query') && ok;

    const probe = makeRecord('exercises', {
      trainer_id: trainer.id,
      name: 'Adapter probe',
      slug: `adapter-probe-${Date.now()}`,
      primary_muscle: 'none',
      equipment: 'none',
      media_url: null,
      is_global: false,
      increment_kg: 2.5,
    });
    await storage.put('exercises', probe);
    const readBack = await storage.get('exercises', probe.id);
    ok = assert(readBack && readBack.name === 'Adapter probe', 'put then get returns the same row') && ok;

    await storage.put('exercises', { ...probe, name: 'Adapter probe, edited' });
    const edited = await storage.get('exercises', probe.id);
    const probeMatches = await storage.query('exercises', { slug: probe.slug });
    ok = assert(edited.name === 'Adapter probe, edited', 'put with a known id upserts in place') && ok;
    ok = assert(probeMatches.length === 1, 'upsert did not create a duplicate row') && ok;

    const trainerOwned = await storage.query('exercises', { trainer_id: trainer.id });
    ok = assert(trainerOwned.length === 1, 'query filters on an indexed column') && ok;

    await storage.delete('exercises', probe.id);
    ok = assert((await storage.get('exercises', probe.id)) === null, 'delete removes the row') && ok;

    const existingLog = (await storage.query('set_logs', {}, { limit: 1 }))[0];
    if (existingLog) {
      ok = assert(existingLog.is_void === false, 'migration backfilled set_logs.is_void') && ok;
      ok = assert(existingLog.is_extra === false, 'migration backfilled set_logs.is_extra') && ok;

      let refusedUpdate = false;
      try {
        await storage.put('set_logs', { ...existingLog, reps: existingLog.reps + 5 });
      } catch {
        refusedUpdate = true;
      }
      ok = assert(refusedUpdate, 'set_logs refuses an update, corrections use supersedes_id') && ok;

      let refusedDelete = false;
      try {
        await storage.delete('set_logs', existingLog.id);
      } catch {
        refusedDelete = true;
      }
      ok = assert(refusedDelete, 'set_logs refuses a delete') && ok;

      let replayed = true;
      try {
        await storage.put('set_logs', existingLog);
      } catch {
        replayed = false;
      }
      ok = assert(replayed, 'replaying an identical set_log is idempotent') && ok;

      // The path undo takes. A retraction supersedes the row and marks itself void, so both
      // rows survive and neither counts.
      const retraction = makeRecord('set_logs', {
        session_id: existingLog.session_id,
        exercise_id: existingLog.exercise_id,
        set_index: existingLog.set_index,
        weight_kg: existingLog.weight_kg,
        reps: existingLog.reps,
        rpe: null,
        is_warmup: existingLog.is_warmup,
        logged_at: new Date().toISOString(),
        supersedes_id: existingLog.id,
        is_void: true,
        is_extra: existingLog.is_extra === true,
        device_id: getDeviceId(),
      });
      await storage.put('set_logs', retraction);
      const sameSession = await storage.query('set_logs', { session_id: existingLog.session_id });
      const live = activeSetLogs(sameSession);
      ok =
        assert(
          !live.some((row) => row.id === existingLog.id) && !live.some((row) => row.id === retraction.id),
          'a retraction voids the original and does not count itself',
        ) && ok;
      ok =
        assert(
          sameSession.some((row) => row.id === existingLog.id),
          'the retracted row is still on disk for the audit trail',
        ) && ok;
    }

    let rejectedStrayColumn = false;
    try {
      await storage.put('clients', {
        id: newId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        trainer_id: trainer.id,
        auth_user_id: null,
        display_name: 'Stray',
        invite_code: 'STRAY123',
        status: 'active',
        weight_unit: 'kg',
        weight_lb: 185,
      });
    } catch {
      rejectedStrayColumn = true;
    }
    ok = assert(rejectedStrayColumn, 'a column outside the schema is rejected') && ok;

    const result = await storage.sync();
    ok = assert(result.remote === false, 'sync reports no remote, IndexedDB only for now') && ok;
    note(`${result.pending} local writes waiting in the outbox for a backend`);

    await reportHistory(storage);
    await renderCounts(storage);

    setStatus(ok ? 'Adapter check passed' : 'Adapter check failed', ok ? 'ok' : 'fail');
  } catch (error) {
    fail(error.message);
    setStatus('Adapter check failed', 'fail');
  } finally {
    setBusy(false);
  }
}

/** Proves the seeded history is chart shaped, not just row shaped. */
async function reportHistory(storage) {
  const client = await storage.get('clients', await getDefaultClientId(storage));
  const sessions = await storage.query('sessions', { client_id: client.id }, { orderBy: 'started_at' });
  if (!sessions.length) return;

  const sessionIds = new Set(sessions.map((s) => s.id));
  const squat = (await storage.query('exercises', { slug: 'barbell-back-squat' }))[0];
  const rows = activeSetLogs(await storage.query('set_logs', { exercise_id: squat.id })).filter(
    (row) => sessionIds.has(row.session_id) && !row.is_warmup,
  );

  note('');
  note(
    `${client.display_name}: ${sessions.length} sessions, ${sessions[0].started_at.slice(0, 10)} to ${sessions[
      sessions.length - 1
    ].started_at.slice(0, 10)}`,
  );

  const byDay = new Map();
  for (const row of rows) {
    const day = row.logged_at.slice(0, 10);
    byDay.set(day, Math.max(byDay.get(day) ?? 0, epley1rm(row.weight_kg, row.reps)));
  }
  const series = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  note(`squat estimated 1RM, ${series.length} points: ${series.map(([, v]) => v.toFixed(1)).join(', ')} kg`);

  if (series.length > 1) {
    const first = series[0][1];
    const last = series[series.length - 1][1];
    note(`block gain on the top set: ${(((last - first) / first) * 100).toFixed(1)} percent`);
    note(`lowest point in the block: ${Math.min(...series.map(([, v]) => v)).toFixed(1)} kg`);
  }

  const superseded = (await storage.query('set_logs', { supersedes_id: { ne: null } })).length;
  note(`${superseded} superseding row(s) in set_logs, originals kept for the audit trail`);
}

async function main() {
  let storage;
  try {
    storage = await openStorage();
  } catch (error) {
    setStatus('Could not open IndexedDB', 'fail');
    line(error.message, 'fail');
    note('Serve this folder over http. ES modules and IndexedDB both refuse a file:// origin.');
    setBusy(true);
    return;
  }

  setStatus('Database open', 'ok');

  if (!(await isSeeded(storage))) {
    setStatus('Seeding', 'busy');
    const summary = await seed(storage);
    line(`Seeded ${summary.set_logs} set logs across ${summary.sessions} sessions.`, 'dim');
  }

  await renderCounts(storage);
  await runAdapterCheck(storage);

  document.getElementById('run-test').addEventListener('click', () => runAdapterCheck(storage));

  document.getElementById('reseed').addEventListener('click', async () => {
    setBusy(true);
    setStatus('Reseeding', 'busy');
    logEl.innerHTML = '';
    const summary = await seed(storage, { force: true });
    line(`Reseeded ${summary.set_logs} set logs across ${summary.sessions} sessions.`, 'dim');
    setBusy(false);
    await runAdapterCheck(storage);
  });

  document.getElementById('sync').addEventListener('click', async () => {
    const result = await storage.sync();
    line(
      `sync: remote=${result.remote} pushed=${result.pushed} pulled=${result.pulled} pending=${result.pending}`,
      'dim',
    );
    await renderCounts(storage);
  });
}

main();
