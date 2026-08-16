// The sign in screen.
//
// It has one job and it is allowed to be slow, so it is the one page that talks to the network
// before showing anything useful. Everything else in the app is the opposite.
//
// The code is the way in, and the link is the fallback. That is the reverse of how this started,
// and the reason is Outlook. Outlook fetches every link it delivers, to scan it. A Supabase sign
// in link is spent by whoever fetches it first, so the scanner spends it and the person taps a
// link that is already dead. They send another. The built in sender allows two auth emails an
// hour for the whole project, so the second dead link locks out every account, not just theirs.
//
// Two rules fall out of that and neither is cosmetic:
//
//   1. The code box is reachable before any email is sent and after a send fails. A code lasts an
//      hour and the send limit is an hour, so somebody who has been cut off is almost always
//      holding a live code. Hiding the box behind a successful send, which is what this file used
//      to do, turned a rate limit into a lockout with the key already in their pocket.
//   2. The send button refuses locally during the cooldown. Spending a request to be told to wait
//      is how the quota went in the first place.

import { getSupabase, hasConfig } from './js/supabase.js';
import {
  currentSession, sendSignInEmail, verifyCode, describeAuthError, cooldownLeft,
  isStandalone, tokenFromLink, verifyLink, RESEND_COOLDOWN_S,
} from './js/auth.js';

const emailForm = document.getElementById('email-form');
const codeForm = document.getElementById('code-form');
const emailInput = document.getElementById('email');
const codeInput = document.getElementById('code');
const sendButton = document.getElementById('send');
const verifyButton = document.getElementById('verify');
const note = document.getElementById('note');
const lede = document.getElementById('lede');
const showCode = document.getElementById('show-code');
const linkForm = document.getElementById('link-form');
const linkInput = document.getElementById('link');
const verifyLinkButton = document.getElementById('verify-link');

// Survives the reload that follows tapping a dead link, which is the exact moment somebody needs
// their address remembered and the code box open. localStorage rather than sessionStorage because
// that trip leaves and re-enters the tab.
const REMEMBER = 'ptc.signin';

function remembered() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) || '{}') || {};
  } catch {
    return {};
  }
}

function remember(patch) {
  try {
    localStorage.setItem(REMEMBER, JSON.stringify({ ...remembered(), ...patch }));
  } catch {
    // Private mode, or a full disk. Losing the memory costs a retype, not a sign in.
  }
}

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

let sending = false;
let ticker = null;

/**
 * Opens the code box and puts the cursor in it. Called on a successful send, on a refused one,
 * and from the disclosure, because all three are moments when somebody has a code to type.
 */
function revealCode({ focus = true } = {}) {
  showCode.hidden = true;
  codeForm.hidden = false;
  // The link path only exists for a home screen app, where a tapped link lands in another
  // browser's storage. Elsewhere it is noise.
  if (isStandalone()) linkForm.hidden = false;
  if (focus) codeInput.focus();
}

/**
 * The send button says what it will do and when it can do it. A dead button with no explanation
 * on the one screen nobody can get past is the failure this whole file is about.
 */
function paintSend() {
  const left = cooldownLeft(remembered().lastSentAt, Date.now());
  if (sending) {
    sendButton.disabled = true;
    sendButton.textContent = 'Sending';
    return left;
  }
  sendButton.disabled = left > 0;
  sendButton.textContent = left > 0 ? `Send again in ${left}s` : 'Send me a code';
  return left;
}

function runTicker() {
  if (ticker) clearInterval(ticker);
  if (paintSend() <= 0) return;
  ticker = setInterval(() => {
    if (paintSend() <= 0) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 1000);
}

function busy(on) {
  sending = on;
  verifyButton.disabled = on;
  verifyLinkButton.disabled = on;
  paintSend();
}

/** Signed in. Everything below this line is done. */
function land() {
  remember({ lastSentAt: 0 });
  location.replace(destination());
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
    land();
    return;
  }

  const saved = remembered();
  if (saved.email) emailInput.value = saved.email;

  // The link path can also come back as an error in the fragment, for an expired or reused
  // link. This is the Outlook case landing: the scanner spent the link, the person tapped it,
  // and they are back here. Saying so, and opening the code box, is the whole fix.
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('error_description')) {
    say(
      `${fragment.get('error_description').replace(/\+/g, ' ')}. ` +
        'Some mail providers open links to scan them, which uses the link up before you tap it. ' +
        'Type the code from that same email instead.',
      'fail',
    );
    revealCode({ focus: false });
  }

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    if (cooldownLeft(remembered().lastSentAt, Date.now()) > 0) return;

    busy(true);
    say('Sending.');
    try {
      await sendSignInEmail(client, email, new URL(location.pathname, location.href).href);
      // Deliberately not "if that address is on file". The trainer creates the client row, so a
      // person who typed the wrong address needs to find that out now, not after waiting for an
      // email that is never coming.
      remember({ email, lastSentAt: Date.now() });
      lede.textContent = 'Check your email.';
      say(`Sent to ${email}. Type the six digit code from that email.`, 'ok');
      revealCode();
    } catch (error) {
      // A refusal is where the code box matters most, so it opens here too. The address is worth
      // remembering either way: the send failing says nothing about the address being wrong.
      const { message, waitSeconds } = describeAuthError(error);
      remember({ email });
      if (waitSeconds > 0) {
        remember({ lastSentAt: Date.now() - (RESEND_COOLDOWN_S - waitSeconds) * 1000 });
      }
      say(message, 'fail');
      revealCode({ focus: false });
    } finally {
      busy(false);
      runTicker();
    }
  });

  showCode.addEventListener('click', () => {
    revealCode();
    say('Type the code from the most recent sign in email. A code is good for an hour.', '');
  });

  // Everything is wired now, so both controls can mean what they say. The disclosure is unhidden
  // here rather than in the markup so it is never on screen without its handler, and it is left
  // alone if the fragment error above already opened the code box.
  sendButton.disabled = false;
  if (codeForm.hidden) showCode.hidden = false;
  runTicker();

  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const parsed = tokenFromLink(linkInput.value);
    if (!parsed) {
      say('That does not look like the sign in link. Copy the whole thing from the email.', 'fail');
      return;
    }
    busy(true);
    say('Checking.');
    try {
      await verifyLink(client, parsed);
      land();
    } catch (error) {
      say(describeAuthError(error).message, 'fail');
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
      land();
    } catch (error) {
      say(describeAuthError(error).message, 'fail');
      busy(false);
    }
  });
}

main();
