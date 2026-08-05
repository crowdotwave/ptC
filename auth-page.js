// The sign in screen.
//
// It has one job and it is allowed to be slow, so it is the one page that talks to the network
// before showing anything useful. Everything else in the app is the opposite.

import { getSupabase, hasConfig } from './js/supabase.js';
import { currentSession, sendSignInEmail, verifyCode } from './js/auth.js';

const emailForm = document.getElementById('email-form');
const codeForm = document.getElementById('code-form');
const emailInput = document.getElementById('email');
const codeInput = document.getElementById('code');
const sendButton = document.getElementById('send');
const verifyButton = document.getElementById('verify');
const note = document.getElementById('note');
const lede = document.getElementById('lede');

/** Where to land after signing in. Same origin only, so a crafted next cannot send anyone off. */
function destination() {
  const raw = new URLSearchParams(location.search).get('next') || 'index.html';
  const target = new URL(raw, location.href);
  return target.origin === location.origin ? target.href : new URL('index.html', location.href).href;
}

function say(text, kind = '') {
  note.textContent = text;
  note.dataset.kind = kind;
}

function busy(on) {
  sendButton.disabled = on;
  verifyButton.disabled = on;
}

async function main() {
  if (!hasConfig()) {
    lede.textContent = 'This build has no backend configured.';
    say('Add a project to config.js, or open the app with ?local=1 to use seeded data.', 'fail');
    emailForm.hidden = true;
    return;
  }

  const client = await getSupabase();
  if (!client) {
    lede.textContent = 'Could not load the sign in library.';
    say('Check the connection and reload. Nothing you have already logged is affected.', 'fail');
    emailForm.hidden = true;
    return;
  }

  // A magic link lands back here with its tokens in the URL, and supabase-js exchanges them on
  // load. So the first thing to check is whether that already happened.
  if (await currentSession(client)) {
    location.replace(destination());
    return;
  }

  // The link path can also come back as an error in the fragment, for an expired or reused
  // link. Saying so beats an unexplained sign in form.
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('error_description')) {
    say(fragment.get('error_description').replace(/\+/g, ' '), 'fail');
  }

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    busy(true);
    say('Sending.');
    try {
      await sendSignInEmail(client, email, new URL(location.pathname, location.href).href);
      // Deliberately not "if that address is on file". The trainer creates the client row, so a
      // person who typed the wrong address needs to find that out now, not after waiting for an
      // email that is never coming.
      say(`Sent to ${email}. Open it on this device, or paste the code below.`, 'ok');
      codeForm.hidden = false;
      codeInput.focus();
    } catch (error) {
      say(error.message, 'fail');
    } finally {
      busy(false);
    }
  });

  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    busy(true);
    say('Checking.');
    try {
      await verifyCode(client, emailInput.value, code);
      location.replace(destination());
    } catch (error) {
      say(error.message, 'fail');
      busy(false);
    }
  });
}

main();
