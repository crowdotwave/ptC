// DEV ONLY. The whole role switch lives in this file.
//
// There is no auth yet and one browser, so both sides of the product have to be reachable
// somehow. This is that somehow, and it is deliberately not part of the app: no page imports
// it, it renders its own banner, and js/actor.js is the only thing that loads it, from a
// single block marked as its only entry point.
//
// When Supabase auth lands at step 4, delete this file and that block. Nothing else changes.
//
// It is off unless the URL says otherwise, so a client never meets it. It is gated on a URL
// parameter rather than on localhost, because the app is reviewed on GitHub Pages and a
// localhost guard would mean the trainer view could never be looked at on a real deployment.
//
// Worth saying plainly: switching roles here proves nothing about isolation. The filtering is
// client side, and CLAUDE.md calls a client side filter a bug rather than an implementation.
// It shows the shape. supabase/tests/rls_isolation.sql is what makes it true.

import { setActorOverride } from './actor.js';

const CHOICE_KEY = 'ptc.dev.actor';

function readChoice() {
  try {
    const raw = sessionStorage.getItem(CHOICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeChoice(actor) {
  try {
    sessionStorage.setItem(CHOICE_KEY, JSON.stringify(actor));
  } catch {
    // Private mode. The switch still works for this page load.
  }
}

export async function mount(storage) {
  const trainers = await storage.query('trainers', {}, { orderBy: 'display_name' });
  const clients = await storage.query('clients', {}, { orderBy: 'display_name' });
  const trainerById = new Map(trainers.map((t) => [t.id, t]));

  // trainerId means "the trainer you are", never "the trainer you train under". That is what
  // public.whoami() returns, and a client used to be given their coach's id here, which would now
  // hand every client the coaching navigation.
  const options = [
    ...trainers.map((t) => ({
      key: `trainer:${t.id}`,
      label: `Trainer, ${t.display_name}`,
      actor: { role: 'trainer', trainerId: t.id, clientId: null, isStaff: false },
    })),
    ...clients.map((c) => ({
      key: `client:${c.id}`,
      label: `Client, ${c.display_name}, of ${trainerById.get(c.trainer_id)?.display_name ?? 'unknown'}`,
      actor: { role: 'client', trainerId: null, clientId: c.id, isStaff: false },
    })),
  ];

  // The dual role case, which is the one real people are in: somebody who is coached by another
  // trainer and also coaches. Without an entry for it the seeded data cannot exercise the
  // navigation that person sees, and that navigation is the whole point of holding both.
  if (clients.length && trainers.length) {
    const self = clients[0];
    const own = trainers.find((t) => t.id !== self.trainer_id) ?? trainers[0];
    options.unshift({
      key: 'both',
      label: `Both, ${self.display_name} as a client and ${own.display_name} as a coach, staff`,
      actor: { role: 'both', trainerId: own.id, clientId: self.id, isStaff: true },
    });
  }

  const stored = readChoice();
  let current = options.find((o) => o.key === stored?.key) ?? null;

  if (!current) {
    // Default to whoever the app would have opened as anyway, so turning the switch on does
    // not silently change what you were looking at.
    const { getDefaultClientId } = await import('./seed.js');
    const defaultId = await getDefaultClientId(storage);
    current = options.find((o) => o.key === `client:${defaultId}`) ?? options[0];
  }

  if (current) {
    setActorOverride(current.actor);
    writeChoice({ key: current.key });
  }

  render(options, current);
}

function render(options, current) {
  const bar = document.createElement('div');
  bar.className = 'devbar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Development role switch');

  const label = document.createElement('span');
  label.className = 'devbar__tag';
  label.textContent = 'DEV';

  const select = document.createElement('select');
  select.className = 'devbar__select';
  select.setAttribute('aria-label', 'Act as');
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.key;
    el.textContent = option.label;
    if (current && option.key === current.key) el.selected = true;
    select.appendChild(el);
  }
  select.addEventListener('change', () => {
    const picked = options.find((o) => o.key === select.value);
    if (!picked) return;
    writeChoice({ key: picked.key });
    // A full reload, because every page loads its data once for one identity. Re-resolving in
    // place would mean every screen learning to tear itself down for a thing that is going to
    // be deleted.
    location.reload();
  });

  const off = document.createElement('a');
  off.className = 'devbar__off';
  off.href = `${location.pathname}?dev=0`;
  off.textContent = 'Turn off';

  bar.append(label, select, off);
  document.body.prepend(bar);
  document.body.classList.add('has-devbar');
}
