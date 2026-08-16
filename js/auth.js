// Signing in. A thin layer over supabase-js so that no page has to know how auth is spelled.
//
// There is exactly one way in: an email that Supabase turns into either a link or a six digit
// code. No password, because a password is one more thing to lose on a gym floor and one more
// thing for us to be responsible for storing badly. No social login, because it hands a third
// party the fact that a person trains here.

/**
 * Supabase makes one address wait this long between sends. Mirrored here so the button can
 * refuse locally instead of spending a send to be told no.
 */
export const RESEND_COOLDOWN_S = 60;

/**
 * How long a code stays good, matching Supabase's default email OTP expiry.
 *
 * This number is why a rate limit is not a lockout. The send limit and the code lifetime are
 * both an hour, so somebody who has been cut off almost always has a live code already sitting
 * in their inbox. The screen has to let them type it.
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
export async function verifyCode(client, email, token) {
  const { data, error } = await client.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.trim(),
    type: 'email',
  });
  if (error) throw error;
  return data.session ?? null;
}

/**
 * True when this is running as a home screen app rather than a browser tab.
 *
 * It matters because on iOS a home screen web app gets its own storage container, separate from
 * Safari's. A magic link tapped in Mail opens Safari, so the session is created in Safari and
 * the home screen app, which is where the person actually trains, is still signed out and asks
 * for their email again. Nothing in the web platform lets a link route into that container.
 */
export function isStandalone() {
  try {
    return (
      window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Pulls the one time token out of a pasted sign in link.
 *
 * This is the way around the storage split that needs nothing bought and nothing installed. The
 * link in the email already carries its own token:
 *
 *   https://<ref>.supabase.co/auth/v1/verify?token=<hash>&type=magiclink&redirect_to=...
 *
 * So instead of tapping it, which lands the session in the wrong browser, the link is copied and
 * pasted into the app, and the token is exchanged here, in the container that will hold it.
 *
 * Also accepts a bare token, so somebody who pasted only part of it still gets in, and accepts
 * the newer token_hash spelling alongside the older token one.
 */
export function tokenFromLink(raw) {
  const value = (raw ?? '').toString().trim();
  if (!value) return null;

  // A bare hash, pasted without the surrounding URL.
  if (!/[?#/]/.test(value)) return { tokenHash: value, type: 'email' };

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Supabase puts them in the query, but a redirect can leave them in the fragment instead.
  const params = new URLSearchParams(url.search || '');
  const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''));
  const pick = (key) => params.get(key) ?? hash.get(key);

  const tokenHash = pick('token_hash') ?? pick('token');
  if (!tokenHash) return null;

  // The email carries its own type, so it is read rather than assumed: a first sign in is
  // 'signup' and a later one is 'magiclink', and sending the wrong one is rejected.
  const type = pick('type') || 'email';
  return { tokenHash, type };
}

/** Exchanges a token hash for a session in this browser context. */
export async function verifyLink(client, { tokenHash, type }) {
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) throw error;
  return data.session ?? null;
}

export async function signOut(client) {
  if (!client) return;
  await client.auth.signOut();
}
