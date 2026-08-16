# Email templates

One body, `sign-in-code.html`, pasted into the dashboard under Authentication, Emails, into both
the Confirm signup template and the Magic Link template. Committed here because it is load bearing
and the dashboard keeps no history of it.

## Why the link had to go

Outlook fetches links in email to scan them. Microsoft calls it Safe Links and outlook.com does
its own version, and neither asks the recipient first.

A Supabase sign in link is a single use `GET /auth/v1/verify?token=...`. The token is spent by
whoever fetches it first. That is the scanner, on delivery, before the phone has even buzzed. The
person taps a link that is already dead and reads `otp_expired`, which the app used to relay as
"Email link is invalid or has expired". So they ask for another one.

That second ask is what turned one client's bad afternoon into an outage for everybody. Supabase's
built in sender allows **two auth emails per hour for the whole project**, and there is a further
60 seconds between sends for one address. Two dead links and the project has nothing left to send,
to anyone.

**The code is not a second token, it is the same token in a form a scanner cannot spend.** This is
the part that is easy to get wrong: adding `{{ .Token }}` while leaving `{{ .ConfirmationURL }}` in
place fixes nothing, because the scanner still fetches the link and the code dies with it. The
confirmation URL has to be absent.

## Setting it up

SMTP comes first, and not for the reason it looks like. Since June 2026 a free tier project
sending through Supabase's own sender cannot edit these templates at all, and configuring any
custom SMTP restores that on any plan. So the sender swap is not just how the two per hour limit
gets lifted, it is how the templates become editable in the first place. Upgrading to Pro is not
required and does not help.

**1. A sender.** Brevo, because its free tier verifies a single sending address without owning a
domain, which the alternatives mostly do not: Resend and Postmark want a verified domain before
they will send to anybody but you. Verify the address, then take an SMTP key from SMTP & API.
Host `smtp-relay.brevo.com`, port `587`, username the SMTP login shown there, password the key
rather than the account password.

Brevo rewrites the visible From when the sender is a free address like gmail, so the first emails
through a new sender can land in junk. Check there before concluding it did not send.

**2. Authentication, SMTP Settings.** Enable custom SMTP and paste those in. The template editors
unlock once this is on, which may need a reload.

**3. Authentication, Rate Limits.** Off the floor of two an hour. The default once SMTP is
configured is 30 an hour and it is adjustable.

**4. Authentication, Emails.** Paste `sign-in-code.html` into **both** Confirm signup and Magic
Link, subject something like `Your ptC sign in code`. Confirm no `{{ .ConfirmationURL }}` survives
in either. Doing only one of the two is the mistake this file exists to prevent: see the note in
the template itself.

**5. Authentication, Sign In / Providers, Email.** Email OTP expiry one hour, which is the
default. The app tells people a code lasts an hour, so shortening this makes the app a liar.

Step 3 is what stops a bad afternoon becoming an outage. Step 4 is what stops the retries being
needed at all, which matters more: a higher ceiling on a broken loop is a slower outage rather than
a fixed one.

## Proving it worked

Sign in with an address nobody depends on, not a client's. What should arrive is an email with six
digits and no link in it.

Then check the half that is easy to skip, because it is the half that breaks silently. The two
templates serve different people: an address that has signed in before exercises Magic Link, and
an address that has never been seen exercises Confirm signup. Test a brand new address too, or the
first thing to exercise Confirm signup will be a real client.

## What the app does with this

`js/auth.js` `verifyCode` sends the typed code to `verifyOtp`, trying `email`, then `signup`, then
`magiclink`, and stopping at the first that is accepted. That is the same split as the templates:
a first sign in carries a signup token and every later one carries a magiclink token, sending the
wrong type is rejected, and a single hardcoded type would fail for whichever kind the project was
not handing out. It gives up the moment an error is about anything other than the token, so a rate
limit costs one request rather than three.

The rest of the handling is in `auth-page.js`, and two parts of it exist because of this failure:

- The code box is reachable before any send and after a refused one. A code lasts an hour and the
  quota resets in an hour, so somebody the quota has cut off is nearly always holding a live code.
  Revealing that box only after a successful send, which is what shipped, meant a rate limit
  presented as a lockout to a person with the key in their pocket.
- The send button counts down locally through the cooldown rather than spending a request to be
  told to wait.

The sign in screen offers a code and nothing else. The box for pasting a link is gone, because
these templates carry no link to paste and an input asking for something no email contains is a
dead end on the one screen nobody can get past. It existed for a home screen app on iOS, where the
installed app has its own storage container and a link tapped in Mail signs you in to Safari
instead. A code fixes that better than the paste box did: six digits typed on the phone land in
whatever container is doing the typing.

`isStandalone`, `tokenFromLink` and `verifyLink` are still in `js/auth.js` and are called by no
screen. They survive one revision because what makes them unnecessary is a dashboard field with no
version history, so a template lost or reverted to the Supabase default puts a link back in the
email, takes the code out, and leaves that the only way in until somebody notices. Delete them once
the template is applied by something that keeps a history, or once that risk is accepted.
