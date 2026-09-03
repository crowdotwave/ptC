// Signing in. A thin layer over supabase-js so that no page has to know how auth is spelled.
//
// There is exactly one way in: an email that Supabase turns into either a link or a six digit
// code. No password, because a password is one more thing to lose on a gym floor and one more
// thing for us to be responsible for storing badly. No social login, because it hands a third
// party the fact that a person trains here.

/**
 * Supabase makes one address wait this long between sends. Mirrored here so the button can
 * refuse locally instead of spending a send to be told no.
 *
 * Mirrored, so it can drift: this is a dashboard setting and nothing checks that the two agree.
 * Too high is the worse direction, because the button then refuses a send Supabase would have
 * accepted, on the one screen nobody can get past. describeAuthError reads the real wait out of
 * the refusal when one comes back, so a send that goes out anyway still reports the truth.
 */
export const RESEND_COOLDOWN_S = 60;

/**
 * How long a code stays good, matching Supabase's default email OTP expiry.
 *
 * This number is why a rate limit is not a lockout. The quota window and the code lifetime are
 * both an hour, whatever the quota itself is set to, so somebody who has been cut off almost
 * always has a live code already sitting in their inbox. The screen has to let them type it.
 */
export const CODE_LIFETIME_S = 3600;

/** The session, or null. Reads the local cache, so this answers offline. */
export async function currentSession(client) {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}

/**
 * Sends the email. Supabase creates the auth user on first request, which is what fires the
 * trigger in 0003 that decides whether this person is a client or a trainer.
 *
 * shouldCreateUser stays true on purpose. Turning it off would mean a client the trainer
 * invited cannot get in until somebody creates their auth user separately, and the whole point
 * of matching on clients.email is that the trainer can set the person up before they exist.
 *
 * emailRedirectTo is still sent, because it is what the link in the email is built from and a
 * project whose template still carries a link needs that link to come back here. Once the
 * template is code only it is inert, and harmless.
 */
export async function sendSignInEmail(client, email, redirectTo) {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
  });
  if (error) throw error;
}

/**
 * What an auth failure means, in words the person on the gym floor can act on.
 *
 * Supabase reports these as a message string, sometimes a code, sometimes a status. Reading the
 * raw message out to the client was how "we keep getting rate limited" became a dead end: "Email
 * rate limit exceeded" tells somebody a fact about our project and nothing about what to do,
 * while the thing to do is nearly always to use the code they already have.
 *
 * Pure, so the wording is under test rather than under a rate limit.
 */
export function describeAuthError(error) {
  const raw = (error?.message ?? '').toString();
  const code = (error?.code ?? '').toString();
  const status = Number(error?.status ?? 0);

  // "For security purposes, you can only request this after 51 seconds."
  const countdown = raw.match(/after (\d+) seconds?/i);
  if (countdown) {
    const waitSeconds = Number(countdown[1]);
    return {
      kind: 'wait',
      waitSeconds,
      message: `Another email can go out in ${waitSeconds}s. If the last one arrived, its code still works.`,
    };
  }

  if (code === 'over_email_send_rate_limit' || /email rate limit exceeded/i.test(raw)) {
    return {
      kind: 'quota',
      waitSeconds: RESEND_COOLDOWN_S,
      message:
        'This project has sent all the email it can this hour. Do not wait for another one. ' +
        'Open the most recent sign in email and type its code below: a code is good for an hour.',
    };
  }

  if (code === 'otp_expired' || /expired|invalid/i.test(raw)) {
    return {
      kind: 'expired',
      waitSeconds: 0,
      message:
        'That code has been used or has run out. Codes last an hour, so use the newest email you ' +
        'have, or send a fresh one.',
    };
  }

  if (status === 429 || code === 'over_request_rate_limit') {
    return {
      kind: 'quota',
      waitSeconds: RESEND_COOLDOWN_S,
      message: 'Too many tries from this connection. Wait a minute, then type the code from your email.',
    };
  }

  return { kind: 'unknown', waitSeconds: 0, message: raw || 'That did not work. Try again.' };
}

/**
 * Seconds left before another email may be requested, or 0.
 *
 * The clock guard is not decoration. `lastSentAt` is written by a browser, and a device whose
 * clock jumps forward and back would otherwise leave the button dead for as long as the jump,
 * on the one screen with nothing behind it.
 */
export function cooldownLeft(lastSentAt, now, seconds = RESEND_COOLDOWN_S) {
  if (!lastSentAt) return 0;
  const left = Math.ceil((lastSentAt + seconds * 1000 - now) / 1000);
  if (left > seconds) return 0;
  return left > 0 ? left : 0;
}

/**
 * The typed code path, and now the path rather than the fallback.
 *
 * A scanner can follow a URL. It cannot type six digits into this form. Outlook fetches every
 * link it delivers, and a Supabase sign in link is spent by the fetch, so the link arrives
 * already dead and the resends that follow are what exhaust the sending quota. The code is the
 * same secret delivered in a form no scanner can spend.
 *
 * This needs the Supabase email template to carry {{ .Token }} and, critically, to carry no
 * confirmation link at all. The link and the code are one token: leave the link in the template
 * and the scanner still spends it, taking the code with it. See supabase/email-templates.
 */
export const CODE_TYPES = ['email', 'signup', 'magiclink'];

/**
 * True when a failure is about this particular token rather than about how often we are asking.
 * Retrying another type is only ever worth a request in the first case: a rate limit answers the
 * same way to every type, and burning the verify allowance to hear it three times is how a person
 * ends up locked out for five minutes instead of one.
 */
function worthAnotherType(error) {
  return describeAuthError(error).kind === 'expired';
}

export async function verifyCode(client, email, token) {
  const address = email.trim().toLowerCase();
  const code = token.trim();
  let last = null;

  // Supabase does not issue one kind of email code. A person who has never signed in gets the
  // Confirm signup template and a signup token, and everybody after that gets Magic Link and a
  // magiclink token. Sending the wrong type is rejected, so a single hardcoded 'email' works for
  // whichever kind the project happens to be handing out and silently fails for the other. That
  // failure lands entirely on people signing in for the first time, which is every new client,
  // and it looks like the code being wrong rather than the type being wrong.
  for (const type of CODE_TYPES) {
    try {
      const { data, error } = await client.auth.verifyOtp({ email: address, token: code, type });
      if (error) throw error;
      return data.session ?? null;
    } catch (error) {
      last = error;
      if (!worthAnotherType(error)) throw error;
    }
  }
  throw last;
}

export async function signOut(client) {
  if (!client) return;
  await client.auth.signOut();
}
