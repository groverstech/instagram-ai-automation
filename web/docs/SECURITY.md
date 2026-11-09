# Security model

This document covers how BrandPilot protects tenants, accounts, credentials and outbound access.
It also lists what's been verified by tests and what remains open. Deployment-side controls
(network egress, secrets storage) are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Tenancy and authorisation

**Model:** an organisation (workspace) owns its brands, and everything else belongs to a brand.
Roles are owner, admin, editor and viewer. Members can be **brand-scoped** (client access) and see
only their brands.

**How it's enforced:**
- Every server action and route checks the role and brand access on the server
  (`src/server/auth/guard.ts`).
- Queries are scoped by `brand_id`, and membership is re-checked on every request, so removing a
  member takes effect immediately.
- Organisation-wide data (billing, usage, integrations, the security log) is never sent to
  brand-scoped users.

- Refused access (another organisation's brand or workspace, a brand outside the member's scope,
  an insufficient role) is recorded in the audit log of the organisation that owns the resource.

**Tests:** isolation tests (other organisation: 403; client users: their brands only), member and
scope tests, and Security log isolation (`audit-access.test.ts`: other organisations' events,
brand scope, members' sign-ins only from joining, refusals and their audit records).

**Planned:** Postgres Row-Level Security as defence in depth (pilot in PR 4.9).

## Authentication

| Area | How it works |
|---|---|
| Passwords | scrypt with self-describing parameters (`scrypt2$N$r$p$…`, OWASP's 16 MiB option). Older hashes still verify and are **re-hashed transparently** at the next successful login. Length capped at 256 characters. |
| Sign-in | The same hashing work runs whether or not the email exists (no timing oracle). Rate-limited per email and per IP (hashed keys). Every attempt is audited, failures with a reason. After a failed attempt the form keeps the email (never the password). |
| Sessions | Random 256-bit tokens; only their SHA-256 is stored. `httpOnly`, `SameSite=Lax`, `Secure` in production; 30-day expiry; logout deletes the session server-side. |
| CSRF | Server actions use Next's origin check. Cookies are `SameSite=Lax`. OAuth flows use a signed `state` plus a nonce cookie. |

## Client IPs and rate limits

- **Client IP:** taken from the hop added by the proxies we control (`TRUSTED_PROXY_HOPS`) or an
  edge header (`CLIENT_IP_HEADER`). The leftmost `X-Forwarded-For` entry, which the client can
  forge, is no longer used.
- **Limits:**
  - per user and per organisation in Postgres (shared across instances);
  - a per-IP flood limit at the edge;
  - AI concurrency leases and monthly quotas.

## Outbound requests (SSRF and token leakage)

**User-supplied URLs** (brand or competitor websites, `src/server/web.ts`):
- http/https on ports 80 and 443 only;
- DNS resolved once, with all addresses checked to be public and the connection pinned to the
  checked IP (no DNS rebinding);
- cloud metadata and internal hostnames blocked;
- redirects re-validated per hop; time and size limits.

**Everything else goes to fixed provider hosts**, with two content-derived URLs under allowlists:
- font files only from `https://fonts.gstatic.com`;
- LinkedIn upload URLs (which carry the account's bearer token) only to LinkedIn's own HTTPS
  hosts; redirects aren't followed.

**Deployment:** block private ranges and metadata endpoints at the network layer too (DEPLOYMENT
§8).

## Secrets and data protection

- **Secrets:**
  - server-only environment configuration, separate per environment;
  - never in the repository, the image, logs or chat;
  - CI's `check:secrets` scans client bundles;
  - the configuration validator reports variable names only.
- **OAuth tokens:** AES-256-GCM encrypted at rest with `APP_SECRET`, and decrypted only when
  calling the platform.
- **Logs:** secret-looking fields are redacted and key-shaped values masked.
- **Audit log:** IPs are stored as keyed hashes and email addresses of failed sign-ins only as keyed
  hashes.
- **Errors:** database, network and filesystem error messages are never shown to users. They see a
  reference ID that maps to the server log.

## HTTP headers

HSTS (2 years), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` (camera,
microphone, geolocation, payment, USB off), `Cross-Origin-Opener-Policy: same-origin`, and a CSP
of `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. No
`X-Powered-By`.

## Audit log

An append-only `audit_events` table records:
- sign-in, sign-in failures (with reason), sign-up and sign-out;
- member invites, role changes, brand-scope changes and removals;
- workspace updates and brand creation;
- social connect and disconnect;
- billing checkout and plan changes (Stripe webhook, recorded as a system actor);
- creative approvals that override blocking brand checks;
- refused access (`access.denied`) and viewing the Security log (`audit.view`, at most hourly per
  viewer).

**Who sees what (Settings → Security log):**
- Only active **owners and admins** of the workspace. Editors, viewers, client users and people
  outside the organisation are refused, and the refusal is recorded.
- **Scope comes from the membership, not the role.** Whole-organisation access sees the
  organisation's events plus its current members' sign-in events, **only from when each member
  joined** (so another organisation can't see someone's earlier activity). Brand-scoped access
  sees only events about those brands: no organisation-wide events or sign-ins. Today admins
  can't be brand-scoped (the member rules refuse it); the log enforces the scope regardless.
- People outside the organisation appear as "Not a current member", never by name.

## Background jobs and publishing

- **One publish per post:** the move to "publishing" is atomic, so concurrent attempts (scheduler
  plus "publish now") publish once. This is tested; before the fix, the same race published
  3 times.
- **Interrupted publishes** are never re-sent automatically: the post is flagged so a person checks
  the platform first.

## Verified by automated tests (PR 4.0)

In CI, the full suite also runs against real Postgres 16 with pgvector.

- **Configuration:**
  - strict-mode refusal (and that local, demo and E2E runs aren't refused);
  - variable names reported without values;
  - effective AI mode.
- **Client IP:** trusted-hop selection, the edge header, and rejection of junk values.
- **Passwords:** the new format, legacy verification plus the re-hash flag, tampered parameters,
  dummy verification.
- **Storage:** key traversal rejection, atomic concurrent writes, the health round trip.
- **Health:** readiness checks with no values exposed.
- **Audit log:** IP hashing, detail redaction, real member operations recorded; organisation and
  brand isolation, membership-scoped visibility, members' sign-ins only from joining, refusals
  recorded against the owning organisation, log views recorded (mutation-checked: removing the
  brand filter or the joined-at condition fails the tests).
- **Sign-in and sign-up forms:** an error keeps what was typed, never the password.
- **Production safeguards:** no migrations at start-up in staging or production (also on real
  Postgres: a production start leaves an empty database untouched and not ready); local-disk
  storage refused without the opt-in, at boot and when storage is created; unknown `DEPLOY_ENV`
  and invalid values refused.
- **Outbound allowlists:** fonts and LinkedIn upload URLs.
- **Errors:** database and system errors hidden behind a reference; intentional messages kept.
- **Request IDs** and the **email interface** (never claims delivery; refused in strict
  environments).
- **Jobs:** single publish under a concurrent race; an interrupted publish isn't re-sent; one
  interrupted before it started runs again and publishes once; a post that already went out
  isn't published again; idempotent jobs still retry.
- **Real Postgres:** concurrent migrations apply once; the app client, readiness and audit work on
  the production driver.
- **Container:**
  - migrate, web (strict staging) and worker roles;
  - graceful `SIGTERM`, exit 0;
  - `HEALTHCHECK` healthy;
  - strict refusal of unsafe configuration.

## Known gaps and accepted risks

| Item | Status |
|---|---|
| Sign-up reveals whether an email is registered ("account already exists") | Accepted for now (sign-up is rate-limited per IP). The fix needs email verification, which needs an email provider. |
| CSP `script-src` | Not set: Next's inline scripts need per-request nonces. Follow-up. |
| Multi-factor authentication | Not implemented. Recommended for owners and admins before agency launch. |
| "Sign out everywhere" and session revocation on password change | No password-change flow exists yet; add both together. |
| Row-Level Security | Defence in depth planned (PR 4.9 pilot). Application-level isolation is tested. |
| Hot rate-limit counters in Postgres | Fine at current scale; move to Redis per the scalability plan (PR 4.9). |
| Audit-log retention and export | Not yet configurable (PR 4.9). |
| Penetration test | Planned before launch (PR 4.9). |
