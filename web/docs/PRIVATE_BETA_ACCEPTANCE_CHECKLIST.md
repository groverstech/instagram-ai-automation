# Private-beta acceptance checklist

> **25 Nov 2026:** the whole stack (#11–#40) and #16 are merged to `main`. Gates whose code was "In review" are now **Pass**; owner, external and infrastructure items are unchanged. The single ordered list of what only the owner can do is [PRIVATE_BETA_OWNER_ACTIONS.md](PRIVATE_BETA_OWNER_ACTIONS.md).

Launch gates for the invite-only private beta, with pass/fail status and evidence. Rules:
- A gate passes only when its work is **merged** and the evidence exists. "In review" means an open PR whose own CI passed; it isn't a pass yet.
- Demo-mode (mock) output is labelled simulated and never counts as live evidence.
- Context: [PRIVATE_BETA_LAUNCH_AUDIT.md](PRIVATE_BETA_LAUNCH_AUDIT.md) (status and evidence) and [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md) (what remains, IDs `R-…` and `O-…`).

Status values:
- **Pass:** merged, with evidence.
- **Pass (pre-merge):** verified on the open PRs, to repeat on `main`.
- **In review:** an open PR.
- **Fail:** work needed.
- **Pending:** waits on an earlier step.
- **Owner:** your decision or account.
- **External:** a third party.

Beta launch requires every P0 gate to pass: all gates except those marked P1 in the roadmap, and those you explicitly accept as risks in writing.

## Security

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| S1 | No secrets in the repository or client bundles | **Pass** | `check:secrets` in CI; `.env*` ignored | — |
| S2 | Secrets in the platform's secret store, rotated after testing | **Owner** | At deployment | Owner |
| S3 | OAuth tokens encrypted at rest; key rotation documented | **Pass** | #23: values carry a key id; `APP_SECRET_PREVIOUS` keeps old values readable during a rotation; `npm run secrets:rotate` re-encrypts and reports what still needs the old key; runbook in DEPLOYMENT §7. Verified end to end: nobody reconnects or loses two-step verification | Code |
| S4 | Rate limits, quotas and spend caps enforced server-side | **Pass** | Rate limits, plan run quota, fail-closed AI ledger and deployment-wide cap (PR 4.1); organisation and brand credit caps with alerts, shadow mode (#19); kill switch and tripwire (#20). Per-request enforcement of organisation and brand caps built in #38 behind `CREDITS_MODE=enforce` (off; D-17) | Code, Owner |
| S5 | Sign-up doesn't reveal registered emails (F1) | **Pass** | Where verification is required, sign-up never signs anyone in and answers a new and an existing address identically (`/verify-email?sent=1`); the existing account's owner gets a rate-limited "someone tried to sign up" email; in invite-only mode a registered address is answered like an uninvited one. `signup-enumeration.test.ts`, lifecycle journey and staging rehearsal | — |
| S6 | Strict Content Security Policy (F2) | **Pass** | PR #16: per-request nonce, `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline`; every script carries the nonce, no violations, full regression passes | Code |
| S7 | MFA for owners and admins (F3) | **Pass** | #17 (F3a): TOTP with recovery codes, required for owners and admins in staging and production. #18 (F3b): a fresh second factor (15 minutes) for member, billing, social-connection and credit-cap changes; sign out everywhere else. Security notification emails built in #39 (delivery needs D-7). **Gap found and fixed:** required MFA wasn't enforced on server actions and API routes (audit F-A9); #27 enforces it in the access guards and step-up | Code |
| S8 | Row-level security pilot and independent isolation check (F8) | **Pass** | #25: policies on brands, posts and creatives behind `RLS_PILOT`; randomised cross-tenant tests as an ordinary role; cost measured (no measurable query overhead; 3 round trips per `withTenant`); findings and recommendation in `docs/RLS_PILOT.md`; a campaign-page filter gap found and fixed. Production needs an ordinary DB role (owner); the independent review remains (external). #32: staging and production refuse to start with `RLS_PILOT=on` and a role that bypasses RLS. #36: `publish_attempts` covered; #37, #38: `agent_actions` and `credit_grants` covered | Code, Owner, External |
| S9 | Penetration test with findings fixed or accepted (F9) | **Not started** | After the beta build is feature-complete | Owner, External |
| S11 | Account recovery: password reset and audited operator recovery for lost two-step factors (audit F-A2) | **Pass** | #30: forgot/reset flow (no enumeration, hashed single-use 30-minute tokens, sessions ended, MFA kept), `npm run users` operator recovery; 6 tests, browser check 7/7. Email delivery needs O3 | Code, Owner |
| S13 | Sign-up limited to invited people (invitation-only beta) | **Pass** | #29: `SIGNUP_MODE=invite_only` by default in staging and production; beta list (`npm run beta:invite`) or a pending organisation invitation; one refusal message for every uninvited email | Code, Owner (the list) |
| S12 | Integrated stack (all PRs plus #16) passes tests, build, regression and CSP feature checks | **Pass** | Merged to `main` 25 Nov 2026 (#11–#40, then #16); the tree on `main` is identical to the locally validated integration (565/565 on PG16, lifecycle journey 16/16 under strict CSP) | — |
| S10 | Egress firewall and metadata protection (F7) | **Not started** | With the hosting platform | Owner |

## Data

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| D1 | Postgres backups with PITR; restore drill passed | **Owner** | Procedure in DEPLOYMENT §9; needs managed Postgres | Owner |
| D2 | Object storage with versioning and lifecycle (R2) | **Not started** | PR 4.2: **not authorised yet** | Owner |
| D3 | Account and brand deletion end to end | **Pass** | PR #13 (4.3b): Settings → Delete data for brands, organisations and accounts; tests and browser checks pass | Code |
| D4 | Tenant data export | **Pass** | #22: owners download a ZIP of the organisation's data and files (secrets stripped by column name; step-up; 3 an hour; audited). Pointing the privacy notice at it is an owner (legal text) change | Code, Owner |
| D6 | Organisation export can't exhaust server memory (audit F-A3) | **Pass** | #31: one export at a time per process; 100 MB default file budget (`EXPORT_FILE_BUDGET_MB`) | Code |
| D5 | Audit-log retention and export (F4) | **Pass** | #21: Security log export (CSV, JSON; same access, scope and allow-list; step-up; audited) and retention (`AUDIT_RETENTION_DAYS`, default 400, purged daily). The retention period is an owner setting | Code, Owner |

## Platforms

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| P1 | Public privacy, terms and data-deletion pages; Meta data-deletion and deauthorise callbacks | **Pass** | PR #12 (4.3a). Legal text comes from the owner's counsel (O5); until then the pages are marked draft and must not be submitted | Code, Owner |
| P2 | Capabilities match what the publishers implement (plan defect D2) | **Pass** | PR #12. Before it, Instagram and Facebook claim carousel and video support, but only single images are published | Code |
| P3 | Instagram receives JPEG media (plan defect D1) | **Pass** | PR #12 serves the publish media as JPEG. Public hosting at scale comes with R2 (PR 4.2) | Code |
| P4 | Meta app approved for production permissions (or beta users added as app testers) | **External** | Pack, checklist and reviewer account ready (#14, `docs/submissions/META.md`). Submit once a public domain, the final legal text and your Meta app are in place. **It doesn't need R2:** single-image publishing works through the app's signed media links on a single instance | Owner, External |
| P8 | Platform reviewer can sign in with mandatory MFA (audit F-A1) | **Pass** | #28: MFA pre-enrolled, recovery codes printed for the review form | Code |
| P5 | Publish ledger, idempotency, reconciliation and token health; carousel and Reels | **Pass** (4.4a) | #33 (session B): `publish_attempts` ledger (0019), check-before-retry reconciliation, token health. Carousels, Reels and video (4.4b) need PR 4.2 | Code |
| P6 | Live publish tests to test accounts on every enabled platform | **Not started** | After PR 4.4 and Meta access | Owner |
| P7 | LinkedIn and YouTube marked "coming soon" until approved | **Pass** | PR #12 labels them; a test checks the wording | Code |

## AI

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| A1 | Real-provider validation with archived `test:live` report (F10) | **Owner** | Needs keys in the validation environment and approval of the paid run (USD 10 budget) | Owner |
| A2 | Estimated costs reconciled with provider exports within 5% | **Owner** | After A1; tooling exists (`npm run ai:billing -- reconcile`); provider data supports per-model and per-day comparison only | Owner |
| A3 | Demo mode impossible in production | **Pass** | Config check and tests (PR 4.0, 4.1) | — |
| A4 | Organisation and brand AI limits, alerts, kill switch (F12) | **Pass** | #19: organisation and brand monthly credit caps with alerts at 70, 90 and 100% (shadow: alerted, not enforced). #20: kill switch (`npm run ai:controls`, `AI_STOP`) and per-provider spending tripwire, checked before sending. Production `AI_TRIPWIRE_USD` value is an owner setting | Code, Owner |

## Operations

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| O1 | Hosting platform and deployment pipeline (F6) | **Owner** | Decision pending; container image is built and smoke-tested in CI | Owner |
| O2 | Error tracking and tracing (plan defect D9) | **Code pass; owner** | Built-in Sentry reporter (envelope API, no SDK): set `SENTRY_DSN`; redacted context only; tested with a stubbed endpoint (`monitoring-sentry.test.ts`). The Sentry project is the owner's (D-8) | Owner |
| O3 | Transactional email (plan defect D8) | **Code ready; owner** | #39: Postmark and Resend adapters (tested against stubs), file/memory drivers for development and tests, verification, invitations, notifications. Provider account, DNS and key: D-7 (`docs/EMAIL.md`) | Owner |
| O4 | Uptime checks, alert routing, dead-job alerting | **Partial** | #26: dead jobs reported through `captureError` (`jobs.dead`); `GET /api/health/jobs` (cron secret) returns 503 when work is overdue or stuck. Routing to an error tracker and uptime monitor needs O1 and O2 | Owner, then code |
| O5 | Status page | **Not started** | Third-party service | Owner |
| O7 | Dependency audit clean | **Pass** | #24: npm override points Next.js 15.5 at the project's patched postcss 8.5.32; `npm audit --omit=dev` 0 vulnerabilities; compiled CSS byte-identical. The Next.js 16 upgrade stays a separate decision | Code |
| O6 | Scaling beyond one instance (F5) | **Owner** | A single-instance beta needs the owner's approval; otherwise R2 and shared rate limits first | Owner |

## Legal and product

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| L1 | Privacy policy, terms and DPA published | **Owner** | Text from counsel; pages from PR 4.3 | Owner |
| L2 | Platform terms reviewed | **Owner** | — | Owner |
| R1 | Human approval before every publish | **Pass** | `schedulePost` and `publishNow` refuse unapproved posts; only admins schedule (`src/app/actions/posts.ts`) | — |
| R2 | Emergency pause of all publishing for a brand | **Pass** | PR #15: pause (editors and above) cancels queued publishes and blocks every publishing path; resume (admins) re-queues future posts and returns missed ones to approved; tests and browser checks pass | Code |
| R3 | Plans and limits configurable, credits in shadow mode (plan defect D5) | **Pass** | #19: plans table (seeded from today's values), credits from the usage ledger, `npm run credits`. Enforcement built in #38 (off); turned on after one shadow period (D-17) | Code, Owner |

## Quality and process

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| Q1 | Automated lifecycle journey: account → brand → strategy → content → visual → approve → schedule → publish → metrics (sandbox platform, labelled simulated) | **Pass** | #34: `npm run e2e:lifecycle`, a production build with Postgres; runs in CI after the build. #39 extends it: email verification, publish history, autonomy settings, organisation export, invitation accepted after verification (17/17 locally). Simulated platforms and demo AI: not evidence of real integrations (P6, A1) | Code |
| Q2 | Every PR reviewed by the owner or an independent reviewer | **Owner-authorised** | The owner authorised merging the stack (25 Nov 2026). An independent adversarial review covered the stack (findings H1, M1–M5, L1–L8) and #40 (H-1, M-1, M-2, M-3, all fixed). GitHub reviews weren't recorded on the PRs | Owner (accepted) |
| Q3 | `main` CI green after the merges, migrations applied on staging | **Code pass; staging owner** | `main` CI green after the merges; migrations 0000–0025 apply in strict staging mode as part of `npm run e2e:staging` (CI). Applying them on the real staging needs the staging database (owner) | Owner |
| Q4 | Live AI validation passed and reconciled | **Pending** | Same as A1 and A2 | Owner |

## Added 23 Nov 2026 (full completion mandate)

| ID | Gate | Status | Evidence | Owner |
|---|---|---|---|---|
| AU1 | Three autonomy levels with safe beta defaults; emergency pause overrides every level | **Pass** | #37: policy engine, three gates, safeguards, `agent_actions`; Assisted default; Autonomous unavailable (`AUTONOMOUS_PUBLISHING` off). Tests: decision table, pause property, end to end on the simulated platform. Activation: D-28 | Code, Owner |
| AU2 | Credit enforcement implemented but disabled | **Pass** | #38: reserve, settle and release under the ledger lock; parallel-request test; reconciliation; off by default (D-17) | Code, Owner |
| E1 | Email verification and invitation emails | **Pass** | #39: hashed single-use links, required in staging and production and enforced in the guards; invitations pending until accepted; tested with the memory and file outboxes. Delivery needs D-7 | Code, Owner |
| D7 | Publish history isolated and exported | **Pass** | #36: RLS policy on `publish_attempts`; included in the organisation export without idempotency keys | Code |

## Added 24 Nov 2026 (adversarial review and hardening)

| ID | Gate | Status | Evidence | Owner |
|---|---|---|---|---|
| H1 | What's published is exactly what a person approved | **Pass** | Content-hash approval; edits withdraw it; the publish claim refuses on any difference; per-field negative tests (editor and client editor); creative, brand and legacy cases; browser step | Code |
| M1 | The calendar time and the scheduler agree | **Pass** | Job replaced on time change; stale jobs refuse; concurrent edits; paused | Code |
| M4 | Emergency stop: audited, recoverable, rehearsed | **Code pass; owner steps open** | `npm run publishing:stop`; pause re-checked before the final send. **Owner:** name the operators and rehearse on staging before invitations | Code, Owner |
| L1–L6, L8 | Invitations, export completeness, spend-control paths, append-only decision log, journey HTTP checks | **Pass** | `pre-beta-hardening.test.ts` (28), journey 16/16 | Code |

## Added 25 Nov 2026 (merge and release completion)

| ID | Gate | Status | Evidence | Owner |
|---|---|---|---|---|
| H-1, M-1, M-2, M-3 | Reused Instagram containers, bound media links, reviewed-version approval, operator stop a brand admin can't lift | **Pass** | Merged in #40; regression and mutation tests (37 of 40 protections caught; the 3 survivors are redundant layers) | Code |
| ST1 | Strict staging mode works as an ordinary database role under RLS | **Pass** | Found and fixed: an app role without access to the migration journal was reported as "0 migrations applied" forever. `deploy/app-role-grants.sql`, a clear readiness message, a real-Postgres test; `npm run e2e:staging` in CI | Code |
| ST2 | Staging configuration complete and validated | **Pass (template)** | `deploy/staging.env.example` passes the strict staging check with dummy owner values; filling the real values is the owner's | Owner |
| UX1 | Every page works for owners and editors at desktop and phone width | **Pass** | Exploratory pass over 15 pages × 2 roles × 2 widths: fixed sideways scroll on the Dashboard (and the same pattern on 9 more screens), unlabelled Security-log events, plural text; no page errors or 4xx/5xx | Code |
