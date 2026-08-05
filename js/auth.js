// Signing in. A thin layer over supabase-js so that no page has to know how auth is spelled.
//
// There is exactly one way in: an email that Supabase turns into either a link or a six digit
// code. No password, because a password is one more thing to lose on a gym floor and one more
// thing for us to be responsible for storing badly. No social login, because it hands a third
// party the fact that a person trains here.

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
 */
export async function sendSignInEmail(client, email, redirectTo) {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
  });
  if (error) throw new Error(error.message);
}

/**
 * The typed code path. Present because the link path opens whatever browser the mail app
 * prefers, which on a phone is often not the one the person started in, and a session landing
 * in a different browser looks exactly like a broken app.
 *
 * This only works if the Supabase magic link email template includes {{ .Token }}. The default
 * template does not. If the code is always rejected, that is the reason.
 */
export async function verifyCode(client, email, token) {
  const { data, error } = await client.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.trim(),
    type: 'email',
  });
  if (error) throw new Error(error.message);
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
  if (error) throw new Error(error.message);
  return data.session ?? null;
}

export async function signOut(client) {
  if (!client) return;
  await client.auth.signOut();
}
