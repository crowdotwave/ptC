# Email templates

One template, `magic-link.html`, pasted into the dashboard under Authentication, Emails, Magic
Link. Committed here because it is load bearing and the dashboard keeps no history of it.

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

## The dashboard settings this depends on

Three, and the first is the only one that is not optional.

1. **Authentication, Emails, Magic Link.** Body is `magic-link.html`. Subject line something like
   `Your ptC sign in code`. Confirm no `{{ .ConfirmationURL }}` survives anywhere in it.
2. **Authentication, Sign In / Providers, Email.** Email OTP expiry, one hour, which is the
   default. The app tells people a code lasts an hour, so shortening this makes the app a liar.
3. **Authentication, SMTP Settings.** The built in sender is for testing and its two per hour is
   the reason a couple of retries locked the project. Any real sender lifts it, and the limit then
   moves to Authentication, Rate Limits, which starts at 30 an hour and is adjustable.

Item 3 is the one that stops this recurring. Items 1 and 2 stop the retries being necessary in the
first place, which matters more: a higher ceiling on a broken loop is a slower outage, not a fixed
one.

## What the app does with this

`js/auth.js` `verifyCode` sends the typed code to `verifyOtp` with `type: 'email'`. The rest of the
handling is in `auth-page.js`, and two parts of it exist because of this failure:

- The code box is reachable before any send and after a refused one. A code lasts an hour and the
  quota resets in an hour, so somebody the quota has cut off is nearly always holding a live code.
  Revealing that box only after a successful send, which is what shipped, meant a rate limit
  presented as a lockout to a person with the key in their pocket.
- The send button counts down locally through the cooldown rather than spending a request to be
  told to wait.

`tokenFromLink` and `verifyLink` stay. They are for pasting a link on a home screen app, where iOS
gives the installed app its own storage container and a tapped link signs you in to Safari instead.
That path is unreachable from this template, which carries no link, and it is kept because the
paste box also accepts a bare token and because a project that has not yet applied this template
still needs it.
