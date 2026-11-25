# Email: verification, invitations, notifications

## Provider-ready transport (`src/server/email.ts`)

| `EMAIL_PROVIDER` | Where | What it does |
|---|---|---|
| `log` (default) | Development | Records that an email *would* be sent: recipient domain and subject only. Reports not delivered |
| `file` | Development, local browser journeys | Writes each message as JSON to `EMAIL_OUTBOX_DIR` (default `.data/outbox`) |
| `memory` | Unit tests | Keeps messages in the process (`memoryOutbox()`) |
| `postmark` | Staging, production | Postmark email API (`EMAIL_API_KEY` = server token; optional `EMAIL_POSTMARK_STREAM`) |
| `resend` | Staging, production | Resend email API (`EMAIL_API_KEY`) |

**Rules for staging and production:**
- `log`, `file` and `memory` are refused there: config validation reports an error, and sending throws.
- `postmark` and `resend` need `EMAIL_API_KEY` and `EMAIL_FROM`.
- Provider errors never include the key or the recipient.
- Adding another provider means one adapter of about 10 lines.

**Not done (owner decision D-7):** no provider account exists and no real email has been sent. Both adapters are tested against a stubbed API only.

## What you need to do to go live

1. **Choose Postmark or Resend.** Indicative cost: USD 0–20 a month at beta volume.
2. **Verify the sending domain:** add the SPF, DKIM and return-path DNS records the provider gives you. Add DMARC (`p=none` at first) for the domain.
3. **Create a server token or API key** with send-only permission.
4. **Store the key in the hosting secret store** as `EMAIL_API_KEY`. Never put it in the repository or chat.
5. **Set the sender and provider:** for example `EMAIL_FROM="BrandPilot <no-reply@yourdomain>"` and `EMAIL_PROVIDER=postmark`.
6. **Allow outbound HTTPS** to `api.postmarkapp.com` or `api.resend.com` in the egress firewall (F7).
7. **Send yourself one verification email on staging** before inviting anyone.

## Email verification (`src/server/auth/verify-email.ts`)

**At sign-up:**
- A new account is sent a link.
- The token is random (256 bits) and stored only as a SHA-256.
- It's valid for 24 hours and works once.
- It's bound to the address it was sent to: changing the address voids it.
- A newer link voids older ones.
- Sending the link again is rate-limited to 5 an hour per account.

**Confirming is a button on `/verify-email?token=…`, not the page load.** Email security scanners that open links would otherwise use up the single-use token.

**`EMAIL_VERIFICATION`:**
- `required` is the default in staging and production, and the only allowed value there. An unverified account sees only "Check your inbox". The access guards also refuse every brand and organisation action for it, so it isn't enforced by pages alone.
- `optional` is the default in development: nothing is blocked.

**Existing accounts:** migration 0023 marks accounts created before verification existed as verified. No beta users exist yet, and the reviewer and demo accounts keep working.

## Invitations (`src/server/members.ts`)

**Sending:**
- Admins invite people, with a recent second factor.
- An invitation is **always pending until accepted**, even for an existing account. Nobody is added to an organisation silently.
- Each invitation gets a single-use link: a hashed token valid for 7 days, emailed to the invited address.

**Two ways to accept:**
1. Open `/invite?token=…` while signed in with the **invited address**. Opening the link proves access to that inbox, so the address also counts as verified. If the person isn't signed in, they go to sign-in and come back (`next`, through two-step verification too).
2. Verify the invited address after signing up with it.

**Closed hole:** signing up with someone else's address no longer claims their invitations. Previously, invitations were accepted at sign-up without proof of the address.

**Managing invitations:**
- **Resend** replaces the link, so the old one stops working.
- **Withdraw** removes the invitation.
- **Expired** invitations can't be accepted.
- **Duplicates** are refused.
- **Rate limits:** 30 invitations an hour per organisation, and 20 an hour per person.

**Audit events:** `member.invite`, `member.invite_resend`, `member.invite_revoke` and `member.invite_accept` (via link or verified email).

**Pages:** Settings → Team shows pending and expired invitations, with Resend and Withdraw.

## Security notifications (`src/server/auth/notify.ts`, ASVS 2.2.3)

The account holder gets an email after any of these:
- a password reset;
- two-step verification turned on or off;
- a recovery code used to sign in;
- recovery codes regenerated.

## Tests

`email-verification.test.ts` covers:
- provider selection and config validation;
- the Postmark and Resend request shapes and error hygiene;
- the verification requirement defaults;
- single-use, newest-only, expiring and address-bound links;
- the rate limit on sending again;
- guard enforcement when verification is required;
- invitations:
  - pending until the address is verified;
  - accepting with the link (other addresses refused; once only);
  - resend, expiry, withdrawal and duplicates;
  - admin-only;
  - rate limits;
- security notifications.

`members.test.ts` accepts the client invitation through the emailed link.
