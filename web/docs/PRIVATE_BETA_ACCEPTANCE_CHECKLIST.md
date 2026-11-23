# Private-beta acceptance checklist

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
| S3 | OAuth tokens encrypted at rest; key rotation documented | **In review** | #23: values carry a key id; `APP_SECRET_PREVIOUS` keeps old values readable during a rotation; `npm run secrets:rotate` re-encrypts and reports what still needs the old key; runbook in DEPLOYMENT §7. Verified end to end: nobody reconnects or loses two-step verification | Code |
| S4 | Rate limits, quotas and spend caps enforced server-side | **In review** | Rate limits, plan run quota, fail-closed AI ledger and deployment-wide cap (PR 4.1); organisation and brand credit caps with alerts, shadow mode (#19); kill switch and tripwire (#20). Per-request enforcement of organisation and brand caps is PR 4.6 | Code |
| S5 | Sign-up doesn't reveal registered emails (F1) | **Not started** | Needs the email provider (O3) | Owner, then code |
| S6 | Strict Content Security Policy (F2) | **In review** | PR #16: per-request nonce, `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline`; every script carries the nonce, no violations, full regression passes | Code |
| S7 | MFA for owners and admins (F3) | **In review** | #17 (F3a): TOTP with recovery codes, required for owners and admins in staging and production. #18 (F3b): a fresh second factor (15 minutes) for member, billing, social-connection and credit-cap changes; sign out everywhere else. Security notification emails wait for the email provider | Code |
| S8 | Row-level security pilot and independent isolation check (F8) | **In review** | #25: policies on brands, posts and creatives behind `RLS_PILOT`; randomised cross-tenant tests as an ordinary role; cost measured (no measurable query overhead; 3 round trips per `withTenant`); findings and recommendation in `docs/RLS_PILOT.md`; a campaign-page filter gap found and fixed. Production needs an ordinary DB role (owner); the independent review remains (external) | Code, Owner, External |
| S9 | Penetration test with findings fixed or accepted (F9) | **Not started** | After the beta build is feature-complete | Owner, External |
| S11 | Account recovery: password reset and audited operator recovery for lost two-step factors (audit F-A2) | **Fail** | Not built. Roadmap R-P0-2 | Code |
| S12 | Integrated stack (all PRs plus #16) passes tests, build, regression and CSP feature checks | **Pass (pre-merge)** | Audit §4: 434/434, regression 19/16/10/20, CSP feature checks clean (local branch `local/integration-check`). Repeat on `main` after merging | — |
| S10 | Egress firewall and metadata protection (F7) | **Not started** | With the hosting platform | Owner |

## Data

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| D1 | Postgres backups with PITR; restore drill passed | **Owner** | Procedure in DEPLOYMENT §9; needs managed Postgres | Owner |
| D2 | Object storage with versioning and lifecycle (R2) | **Not started** | PR 4.2: **not authorised yet** | Owner |
| D3 | Account and brand deletion end to end | **In review** | PR #13 (4.3b): Settings → Delete data for brands, organisations and accounts; tests and browser checks pass | Code |
| D4 | Tenant data export | **In review** | #22: owners download a ZIP of the organisation's data and files (secrets stripped by column name; step-up; 3 an hour; audited). Pointing the privacy notice at it is an owner (legal text) change | Code, Owner |
| D6 | Organisation export can't exhaust server memory (audit F-A3) | **Fail** | Up to 500 MB held per request. Roadmap R-P0-3 | Code |
| D5 | Audit-log retention and export (F4) | **In review** | #21: Security log export (CSV, JSON; same access, scope and allow-list; step-up; audited) and retention (`AUDIT_RETENTION_DAYS`, default 400, purged daily). The retention period is an owner setting | Code, Owner |

## Platforms

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| P1 | Public privacy, terms and data-deletion pages; Meta data-deletion and deauthorise callbacks | **In review** | PR #12 (4.3a). Legal text comes from the owner's counsel (O5); until then the pages are marked draft and must not be submitted | Code, Owner |
| P2 | Capabilities match what the publishers implement (plan defect D2) | **In review** | PR #12. Before it, Instagram and Facebook claim carousel and video support, but only single images are published | Code |
| P3 | Instagram receives JPEG media (plan defect D1) | **In review** | PR #12 serves the publish media as JPEG. Public hosting at scale comes with R2 (PR 4.2) | Code |
| P4 | Meta app approved for production permissions (or beta users added as app testers) | **External** | Pack, checklist and reviewer account ready (#14, `docs/submissions/META.md`). Submit once a public domain, the final legal text and your Meta app are in place. **It doesn't need R2:** single-image publishing works through the app's signed media links on a single instance | Owner, External |
| P8 | Platform reviewer can sign in with mandatory MFA (audit F-A1) | **Fail** | Roadmap R-P0-1 | Code |
| P5 | Publish ledger, idempotency, reconciliation and token health; carousel and Reels | **Not started** | PR 4.4a (ledger, idempotency, reconciliation, token health) doesn't need R2 and can start now (roadmap R-P1-1). PR 4.4b (carousels, Reels, video) needs PR 4.2 | Code |
| P6 | Live publish tests to test accounts on every enabled platform | **Not started** | After PR 4.4 and Meta access | Owner |
| P7 | LinkedIn and YouTube marked "coming soon" until approved | **In review** | PR #12 labels them; a test checks the wording | Code |

## AI

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| A1 | Real-provider validation with archived `test:live` report (F10) | **Owner** | Needs keys in the validation environment and approval of the paid run (USD 10 budget) | Owner |
| A2 | Estimated costs reconciled with provider exports within 5% | **Owner** | After A1; tooling exists (`npm run ai:billing -- reconcile`); provider data supports per-model and per-day comparison only | Owner |
| A3 | Demo mode impossible in production | **Pass** | Config check and tests (PR 4.0, 4.1) | — |
| A4 | Organisation and brand AI limits, alerts, kill switch (F12) | **In review** | #19: organisation and brand monthly credit caps with alerts at 70, 90 and 100% (shadow: alerted, not enforced). #20: kill switch (`npm run ai:controls`, `AI_STOP`) and per-provider spending tripwire, checked before sending. Production `AI_TRIPWIRE_USD` value is an owner setting | Code, Owner |

## Operations

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| O1 | Hosting platform and deployment pipeline (F6) | **Owner** | Decision pending; container image is built and smoke-tested in CI | Owner |
| O2 | Error tracking and tracing (plan defect D9) | **Partial** | `captureError` hook with references; vendor pending | Owner, then code |
| O3 | Transactional email (plan defect D8) | **Partial** | Interface and `log` driver; provider pending; refuses in staging and production | Owner, then code |
| O4 | Uptime checks, alert routing, dead-job alerting | **Partial** | #26: dead jobs reported through `captureError` (`jobs.dead`); `GET /api/health/jobs` (cron secret) returns 503 when work is overdue or stuck. Routing to an error tracker and uptime monitor needs O1 and O2 | Owner, then code |
| O5 | Status page | **Not started** | Third-party service | Owner |
| O7 | Dependency audit clean | **In review** | #24: npm override points Next.js 15.5 at the project's patched postcss 8.5.32; `npm audit --omit=dev` 0 vulnerabilities; compiled CSS byte-identical. The Next.js 16 upgrade stays a separate decision | Code |
| O6 | Scaling beyond one instance (F5) | **Owner** | A single-instance beta needs the owner's approval; otherwise R2 and shared rate limits first | Owner |

## Legal and product

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| L1 | Privacy policy, terms and DPA published | **Owner** | Text from counsel; pages from PR 4.3 | Owner |
| L2 | Platform terms reviewed | **Owner** | — | Owner |
| R1 | Human approval before every publish | **Pass** | `schedulePost` and `publishNow` refuse unapproved posts; only admins schedule (`src/app/actions/posts.ts`) | — |
| R2 | Emergency pause of all publishing for a brand | **In review** | PR #15: pause (editors and above) cancels queued publishes and blocks every publishing path; resume (admins) re-queues future posts and returns missed ones to approved; tests and browser checks pass | Code |
| R3 | Plans and limits configurable, credits in shadow mode (plan defect D5) | **In review** | #19: plans table (seeded from today's values), credits from the usage ledger, `npm run credits`. Enforcement is PR 4.6 after one shadow period | Code |

## Quality and process

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| Q1 | Automated lifecycle journey: account → brand → strategy → content → visual → approve → schedule → publish → metrics (sandbox platform, labelled simulated) | **Fail** | Pieces are tested separately; no single journey. Roadmap R-P0-4 | Code |
| Q2 | Every PR reviewed by the owner or an independent reviewer | **Fail** | No reviews on #11–#26 (audit F-A6) | Owner |
| Q3 | `main` CI green after the merges, migrations applied on staging | **Pending** | After R-P0-0 | Owner, then code |
| Q4 | Live AI validation passed and reconciled | **Pending** | Same as A1 and A2 | Owner |
