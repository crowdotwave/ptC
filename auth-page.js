// The sign in screen.
//
// It has one job and it is allowed to be slow, so it is the one page that talks to the network
// before showing anything useful. Everything else in the app is the opposite.
//
// A code is the only way in, and there is no link anywhere, which is the reverse of how this
// started. The reason is Outlook. Outlook fetches every link it delivers, to scan it. A Supabase
// sign in link is spent by whoever fetches it first, so the scanner spent it and the person tapped
// a link that was already dead. They sent another. The project was on Supabase's built in sender
// then, which allowed two auth emails an hour for the whole project, so the second dead link locked
// out every account, not just theirs.
//
// That figure is history, not a current constraint. The project sends through custom SMTP now, so
// the ceiling is whatever Authentication, Rate Limits holds, and this file deliberately does not
// name it: a number written down here is one nobody re-reads when the dashboard moves, which is how
// this comment came to describe a limit the project had already left behind. The shape is what the
// screen depends on and the shape has not changed: a per address wait between sends, a project wide
// ceiling per hour, and a code that outlives both.
//
// The emails now carry six digits and no link at all, because the link and the code are one token
// and a scanner following the link spends the code with it. That lives in the Supabase templates
// rather than here: see supabase/email-templates.
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
  RESEND_COOLDOWN_S,
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

  // Somebody may already be signed in: another tab did it, or supabase-js exchanged tokens off
  // the URL on load, which is still how a link from an email sent before the templates changed
  // would arrive. Either way there is nothing to ask for.
  if (await currentSession(client)) {
    land();
    return;
  }

  const saved = remembered();
  if (saved.email) emailInput.value = saved.email;

  // A tapped link comes back as an error in the fragment. Nothing we send contains a link any
  // more, so anybody landing here did it from an email sent before that changed, and that email
  // holds no code to fall back on. Naming it as old is the useful thing to say: the failure this
  // replaces was somebody reading "invalid or has expired" and concluding the app was broken.
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('error_description')) {
    say(
      'That link came from an older email, and sign in links have been replaced by codes. ' +
        'Send yourself a code and type it in.',
      'fail',
    );
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
  // here rather than in the markup so it is never on screen without its handler.
  sendButton.disabled = false;
  showCode.hidden = false;
  runTicker();

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
