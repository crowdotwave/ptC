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

export async function signOut(client) {
  if (!client) return;
  await client.auth.signOut();
}
