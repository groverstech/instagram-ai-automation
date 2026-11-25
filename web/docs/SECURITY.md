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
| Two-step verification (F3) | Authenticator-app codes (TOTP, RFC 6238: SHA-1, 30 s, 6 digits, ±1 step) with ten one-time recovery codes. The TOTP secret is encrypted at rest (AES-256-GCM); recovery codes are stored only as HMAC-SHA256 hashes keyed with `APP_SECRET`. After the password, the session is **pending** (10 minutes) and can only complete sign-in at `/login/mfa`. A code can't be reused: the last accepted step is stored with a compare-and-set, and so is recovery-code consumption. Attempts are rate-limited like sign-in (10 per 15 minutes per user). Owners and admins must use it when `MFA_REQUIRED_FOR_ADMINS` is true (default in staging and production): until they enrol, every app page and onboarding sends them to Account → Security, and the access guards (`requireBrand…`, `requireWorkspaceRole…`) refuse their server actions and API routes with `MfaEnrolmentRequired`, so a password alone can't use the account. Security log: `mfa.enable`, `mfa.disable`, `mfa.recovery_used`, `mfa.recovery_regenerated`, `auth.mfa_failed`, and `auth.login` records which factor completed sign-in. |
| Account recovery (S11) | **Forgot password** (`/forgot-password`): the answer is the same whether or not the email has an account, and the timing is evened out. Rate-limited per email and per IP. The token is 256-bit random, stored only as SHA-256, valid 30 minutes and single use (claimed atomically); a new one voids older ones. Resetting ends every session and **doesn't turn off two-step verification**. The link goes through the email hook (provider pending, O3). **Operator recovery** (`npm run users`): `reset-link` gives a 24-hour link handed over directly, and `reset-mfa` clears two-step verification for someone who lost the authenticator and the recovery codes, and ends their sessions. Both need `--by` and a `--reason` saying how identity was confirmed. Security log: `auth.password_reset_requested`, `auth.password_reset_issued`, `auth.password_reset`, `mfa.reset_by_operator`. |
| Step-up for sensitive actions (F3b) | For people with two-step verification on, sensitive actions need a second factor verified **in this session within the last 15 minutes** (the sign-in verification counts): inviting, removing and changing members' roles or brand access, starting checkout or opening the billing portal, connecting a social account (the OAuth start) and disconnecting one. Without it the server refuses with `StepUpRequired`; server actions surface it as a dialog that asks for a code and then retries the action, and the OAuth start goes through `/account/verify`, which only continues to same-site paths (`safeNext`). People without MFA aren't asked, unless MFA is required for them and they haven't set it up: then the action is refused (`MfaEnrolmentRequired`). Deleting a brand, an organisation or your account needs a recent second factor too. Codes follow the same replay protection and rate limits as sign-in. "Sign out everywhere else" (Account → Security) ends every other session of the user and needs a fresh factor too. Security log: `mfa.step_up`, `auth.logout_all`, and failed step-up codes as `auth.mfa_failed` `{during: "step_up"}`. |
| CSRF | Server actions use Next's origin check. Cookies are `SameSite=Lax`. OAuth flows use a signed `state` plus a nonce cookie. |

### Row-level security (pilot, S8)

Postgres policies on `brands`, `posts` and `creatives` restrict rows to one organisation when a transaction sets `app.org_id` (`withTenant`, `RLS_PILOT=on`). They're a second layer under the application's scoping.

- Superusers and `BYPASSRLS` roles ignore policies, so the app must connect as an ordinary role. In staging and production with `RLS_PILOT=on`, the app **refuses to start** with such a role; elsewhere it logs a warning.
- Results, cost and recommendation: [RLS_PILOT.md](RLS_PILOT.md).

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
- **Key rotation (S3):**
  - Encrypted values are stored as `v1.<key id>.<…>`.
  - `APP_SECRET_PREVIOUS` lets reads, signature checks and recovery-code checks accept the old secret during a rotation; writes always use the new one.
  - `npm run secrets:rotate` re-encrypts stored tokens and two-step secrets, then reports what still depends on an old key.
  - Runbook: DEPLOYMENT.md §7.
- **Logs:** secret-looking fields are redacted and key-shaped values masked.
- **Audit log:** IPs are stored as keyed hashes and email addresses of failed sign-ins only as keyed
  hashes.
- **Errors:** database, network and filesystem error messages are never shown to users. They see a
  reference ID that maps to the server log.

### Organisation data export (D4)

Owners can download a ZIP of the organisation from Settings → Delete data → **Export all data** (`src/server/tenant-export.ts`).

- **Contents:**
  - `data.json`: the organisation, its members, and every brand's data (profiles, memory, strategies, campaigns, creatives, posts and metrics, competitors, assistant history, AI tasks and usage, credit caps and alerts);
  - `files/`: uploaded assets and AI-generated images;
  - `README.txt`.
- **Never included:** passwords, two-step secrets, sessions, social-account tokens, embeddings, claim tokens, and the raw AI prompts and responses. These are stripped by column name (`…Enc`, `…Hash`, `…Token`, `…Secret`), so a new secret column named that way is excluded too.
- **Size:** the archive is built in memory, so peak use is about twice the file budget. Files beyond the budget (`EXPORT_FILE_BUDGET_MB`, default 100, range 10–1000) are listed as `over_budget` rather than bundled; missing files are listed as `missing`. **Only one export runs at a time per server process**; another request gets 503 with `Retry-After: 60`.
- **Controls:**
  - owners only;
  - a recent second factor;
  - 3 exports per person per hour;
  - recorded as `workspace.export`.

The Security log has its own export (see Audit log).

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

**Export and retention (F4):**
- **Export:** owners and admins can download the Security log as CSV or JSON (Settings → Security log), for the organisation's records or an auditor.
  - It has the same authorisation, brand scope and detail allow-list as the screen.
  - It covers the last 365 days and up to 50,000 events.
  - It needs a recent second factor (step-up).
  - Each export is recorded as `audit.export`.
  - In CSV, values a spreadsheet would run as a formula (`= + - @`) get a leading quote.
- **Retention:** events older than `AUDIT_RETENTION_DAYS` (default 400, minimum 90) are deleted once a day by the scheduler tick, in batches. Each purge is recorded as `audit.retention_purge`.

**Who sees what (Settings → Security log):**
- Only active **owners and admins** of the workspace. Editors, viewers, client users and people
  outside the organisation are refused, and the refusal is recorded.
- **Scope comes from the membership, not the role.** Whole-organisation access sees the
  organisation's events plus its current members' sign-in events, **only from when each member
  joined** (so another organisation can't see someone's earlier activity). Brand-scoped access
  sees only events about those brands: no organisation-wide events or sign-ins. Today admins
  can't be brand-scoped (the member rules refuse it); the log enforces the scope regardless.
- People outside the organisation appear as "Not a current member", never by name.
- **Enforced on the server.** The log is read only by the Settings page, through `auditTrailFor`,
  which re-checks the membership and scope itself. No API route or server action returns it.
- **What it never shows:** passwords, tokens and secrets are redacted before storage. IPs and
  failed-sign-in emails are stored only as keyed hashes, and those hashes are never sent to the
  browser. The browser receives only allow-listed detail fields (role, plan, platform, reason,
  counts), never user or platform account ids, and actor names only for current members.
- **Bounded volume:** refused access and failed sign-ins record at most 20 events per source per
  10 minutes, then one marker; the request itself is still refused.

## AI providers (PR 4.1)

- **Keys:** `BRANDPILOT_ANTHROPIC_API_KEY` (or the fallback `ANTHROPIC_API_KEY`) and `OPENAI_API_KEY` are server environment variables only. They're
  never logged, sent to the browser (Settings shows only "key configured") or included in error
  messages; client bundles are scanned in CI.
- **Outbound:** AI calls go only to the configured provider hosts (public APIs by default;
  `*_BASE_URL` overrides must be https in staging and production).
- **OpenAI** requests carry a keyed hash of the organisation as `safety_identifier`, never our raw
  IDs or user details.
- **Usage and cost data** is organisation-wide: only owners and admins with access to every brand
  see it, re-checked on the server, with refusals audited. The usage ledger is attributed per
  organisation and brand, and summaries never mix organisations (tested).
- **Spend protection:**
  - per-user and per-organisation AI rate limits and concurrency leases;
  - the plan's monthly run limit;
  - an optional monthly spending limit;
  - the AI executor never retries an image request whose outcome is unknown (e.g. a timeout); a
    background creative job can still be re-queued after such a failure (up to 3 attempts), so the
    same image may be requested and charged for again. Each attempt is reserved before it is sent
    and its reported usage settled to the ledger; the reserve is an estimate, not a guaranteed
    maximum, and the settled cost can exceed it.
- **Prompt injection:** brand material is passed to models as labelled data, never as instructions
  (existing agent prompts).
- **Real-provider validation is pending** (FOLLOW_UPS F10).

## Background jobs and publishing

- **One publish per post:** the move to "publishing" is atomic, so concurrent attempts (scheduler
  plus "publish now") publish once. This is tested; before the fix, the same race published
  3 times.
- **Interrupted publishes** are never re-sent automatically: the post is flagged so a person checks
  the platform first.
- **Approval integrity (reviews H1, H-1, M-1, M-2):**
  - **What the approval covers.** An approval records a hash of exactly what will be published:
    - the post's caption, hashtags, title, platform, format, creative and target account;
    - the creative's content and image;
    - the brand name, colours, fonts and logos drawn on it.
  - **The version the approver saw.** The Content Calendar sends the hash of the version it showed. If the post, its creative or the brand's look changed since, nothing is approved and the approver gets a 409 conflict and a reload. The check and the write happen in one transaction with the post row locked, so a concurrent edit either lands first (and the approval is refused) or is refused itself.
  - **Edits after approval.** Editing any covered field withdraws the approval:
    - the post goes back to "awaiting approval";
    - queued jobs are cancelled;
    - `post.approval_invalidated` is audited with the fields and the previous approver.
  - **At publish.** The claim recomputes the hash and refuses on any difference, so changes made elsewhere (the Creative Studio, the brand profile) are caught too. Nothing is sent.
    - The rows hashed at the claim are the ones published: there's no second read.
    - Edits are refused while a post is publishing.
  - **The image a platform fetches (M-1).** It's bound to the approval: the signed media link names the post and its approval hash.
    - The link serves the image only while the post still carries that approval and its content still hashes to it, checked before and after rendering.
    - Otherwise it answers 409 and serves nothing, so a change made while Instagram or Facebook is fetching can't reach them.
    - The same check guards in-process renders (LinkedIn, Pinterest, the sandbox). A change caught there sends the post back to a person, unsent.
    - Links without the binding are refused; responses are never cached.
  - **Retries (H-1).** Each publish attempt records the approval hash it carried and the exact text it sent.
    - An Instagram container from an earlier attempt is reused only for the same approval. After an edit and a new approval, a fresh container is created from the new version, and the old container is never published.
    - A check after an uncertain attempt looks for the text that attempt sent.
    - Content edits are refused until that check is done.
  - **Legacy posts.** Posts approved before hashes existed need a fresh approval.
  - **Not covered:** the scheduled time.
  - **Limits:**
    - The hash covers what the renderer reads today; a renderer change that reads more must extend it.
    - A creative or brand change made after an approval but before publish isn't flagged until the publish claim. It's caught there, and nothing is sent.
- **Schedule consistency (review M1):**
  - Changing a scheduled post's time replaces its queued job.
  - A job left over from an earlier time refuses to publish before the post's time.
  - The publish claim prevents a double publish.
- **Emergency pause and operator stop (reviews M4, M-3):**
  - A brand's own pause is checked at the claim, and again immediately before the request that makes a post public (Instagram after image processing, Facebook before its single request).
  - The operator emergency stop is a separate record (`publishing_stops`) that brand admins can't lift. Every publishing path checks it at the same points, and only the operator command `publishing:stop -- resume` lifts it. Both directions are audited.
  - **A request already sent can't be recalled.** The runbook is in DEPLOYMENT §9.
  - **Residual:** anyone with the production database credentials can delete the stop row (the same limit as the decision log below).
- **The autonomy decision log (`agent_actions`) is append-only for the application (review L6):** a database trigger refuses direct `UPDATE` and `DELETE`. Deleting a post, brand or organisation still works through foreign keys. **It isn't tamper-proof against the database owner or a superuser,** who can disable the trigger. Tamper evidence against them needs a separate, restricted application role, or log shipping to external storage (an infrastructure decision).

## Public platform callbacks (PR 4.3)

`/api/platforms/meta/data-deletion` and `/api/platforms/meta/deauthorize` take no session. They act
only on a `signed_request` that verifies against `META_APP_SECRET`:
- HMAC-SHA256 compared in constant time;
- the algorithm must be HMAC-SHA256;
- the user ID must be numeric;
- requests older than 24 hours, or dated in the future, are refused.

An invalid request changes nothing and records nothing (400). The deletion status page shows only
status and dates for a 12-character confirmation code. Details are in
[PLATFORM_READINESS.md](PLATFORM_READINESS.md).

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

Follow-up requirements for these gaps (sign-up privacy, strict CSP, MFA, audit-log retention and
export) are recorded in [FOLLOW_UPS.md](FOLLOW_UPS.md). **None is implemented yet.**

| Item | Status |
|---|---|
| Sign-up reveals whether an email is registered ("account already exists") | Accepted for now (sign-up is rate-limited per IP). The fix needs email verification, which needs an email provider. |
| CSP `script-src` | Not set: Next's inline scripts need per-request nonces. Follow-up. |
| Multi-factor authentication | **Two-step verification (TOTP) in review (F3a, F3b)**: enrolment, sign-in challenge, one-time recovery codes, required for owners and admins in staging and production (F3a); a fresh second factor for sensitive actions and "sign out everywhere else" (F3b). Still open: security notification emails (with PR 4.6's email provider) and WebAuthn/passkeys (not in the first-release scope). Originally: **not implemented, a known security enhancement.** Recommended stage: its own PR after PR 4.6 (which brings the email provider needed for recovery and security notifications) and **before the first external agency or paying customer is onboarded**, so before the PR 4.9 penetration test. Scope: TOTP with hashed one-time recovery codes; required for owners and admins and optional for others; a fresh second factor for sensitive actions (role and member changes, billing, social connections); "sign out everywhere"; every MFA event in the audit log. |
| "Sign out everywhere" and session revocation on password change | No password-change flow exists yet; add both together. |
| Row-Level Security | Defence in depth planned (PR 4.9 pilot). Application-level isolation is tested. |
| Hot rate-limit counters in Postgres | Fine at current scale; move to Redis per the scalability plan (PR 4.9). |
| Audit-log retention and export | Not yet configurable (PR 4.9). |
| Security-event volume | Refused access and failed sign-ins are capped at 20 records per source (user, or IP when anonymous) per 10 minutes, then one "further attempts not recorded" marker. Requests are still refused, and counted, every time. Unknown brand or workspace ids are never recorded. Retention and export: PR 4.9. |
| Public readiness output | `/api/health/ready` shows error, warning and migration counts (never values). Restrict it at the load balancer if preferred. |
| Penetration test | Planned before launch (PR 4.9). |
