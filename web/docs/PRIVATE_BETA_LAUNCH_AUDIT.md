# Private-beta launch audit

Reconciled status of BrandPilot against the approved first-release scope, as of **23 Nov 2026**. Companion documents:
- [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md): what remains, by priority, with the critical path;
- [PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md): launch gates with pass/fail status and evidence;
- [LAUNCH_READINESS.md](LAUNCH_READINESS.md): the index, the owner decisions and the session checkpoints.

**Approved scope:** the merged Phases 1–3 plus the [Phase 4 plan](plan/PHASE4_PLAN.md), PRs 4.0–4.9. Items from the earlier [Phase 4 proposal](PHASE4_PROPOSAL.md) that the plan didn't adopt aren't in scope; examples are client sign-off approvals, autonomous agents, and smart scheduling. They're listed as owner decisions, not as gaps.

Evidence levels used below:

| Label | Meaning |
|---|---|
| **Merged** | On `main`, with CI on that commit |
| **Verified (stack)** | In an open PR. Its own CI passed on the PR head, **and** this audit reproduced it on the integrated stack: all PRs plus #16 (§4) |
| **Unit/integration only** | Automated tests, but no browser journey |
| **Simulated** | Exercised with mocks or a demo provider; no real third party |
| **Unverified** | Needs a real provider, account or approval that hasn't happened |
| **Not built** | — |

## 1. How this was verified

Everything in this section was re-checked in this audit; reported results weren't taken on trust.

| Check | Method | Result |
|---|---|---|
| `main` | `git fetch`; `git rev-parse origin/main` | `b8a83536e2b30878ab9ac0ef410f76310d5606b4`, unchanged since the 22 Nov baseline |
| Open PRs | GitHub API, all PRs | 16 open (#11–#26), none merged, none draft, **no reviews and no comments on any** |
| PR heads and bases | GitHub API compared with `git rev-parse` of every branch | Every local branch equals its remote. Each stacked PR's base SHA equals the previous PR's head SHA |
| CI | GitHub Actions runs matched to each PR's **current** head SHA | All 16 green (run IDs in §2) |
| Working tree | `git status` | Clean. One **local-only** branch: `local/integration-check` (§4) |
| Integrated stack | §4 | Tests, typecheck, lint, audit, build, secret check, regression and feature checks all pass |

## 2. Open PRs

All PRs are in the `groverstech/instagram-ai-automation` repository. Line counts include generated drizzle snapshot files where a migration is added.

| PR | Title (short) | Base → head | Head SHA | CI run (head) | Tests at head | Migration | Gates |
|---|---|---|---|---|---|---|---|
| #11 | Readiness tracker and approved Phase 4 plan | `main` → `claude/ai-social-marketing-platform-n9rlh6` | moves with each checkpoint | green on each push | docs only | — | — |
| #12 | 4.3a legal pages, Meta callbacks, honest capabilities, JPEG media | `main` → `feature/p4-platform-readiness` | `4562fbd` | 45033382749 | 367 | `0011_platform_readiness` | P1, P2, P3, P7 |
| #13 | 4.3b self-service deletion | #12 → `feature/p4-self-service-deletion` | `e5ff264` | 45036146002 | 373 | — | D3 |
| #14 | 4.3c Meta submission pack and reviewer account | #13 → `feature/p4-review-pack` | `7c0e99d` | 45037295205 | 376 | — | P4 (prep) |
| #15 | Emergency publishing pause | #14 → `feature/emergency-pause` | `8ba7657` | 45038847898 | 378 | `0012_publishing_pause` | R2 |
| #16 | Strict CSP with per-request nonces | `main` → `feature/strict-csp` | `3259597` | 45060385217 | 349 | — | S6 |
| #17 | MFA (TOTP, recovery codes) | #15 → `feature/mfa` | `97139f9` | 45062279085 | 386 | `0013_mfa` | S7 |
| #18 | Step-up verification, sign out everywhere | #17 → `feature/mfa-step-up` | `6669d30` | 45065217077 | 391 | — | S7 |
| #19 | 4.5 plans as configuration, credits (shadow), caps and alerts | #18 → `feature/p4-credits-shadow` | `abbb804` | 45067038811 | 400 | `0014_plans_credits` | R3, A4, S4 |
| #20 | AI kill switch and spending tripwire | #19 → `feature/ai-kill-switch` | `c22bb34` | 45108409393 | 407 | `0015_ai_controls` | A4, S4 |
| #21 | Security log export and retention | #20 → `feature/audit-retention-export` | `3f11c01` | 45109461233 | 413 | — | D5 |
| #22 | Organisation data export | #21 → `feature/tenant-export` | `5691c83` | 45110486063 | 418 | — | D4 |
| #23 | `APP_SECRET` rotation | #22 → `feature/secret-rotation` | `f080411` | 45112480510 | 424 | — | S3 |
| #24 | postcss override (`npm audit` clean) | #23 → `fix/postcss-override` | `7526702` | 45113497809 | 424 | — | O7 |
| #25 | RLS pilot (3 tables) and campaign filter fix | #24 → `feature/rls-pilot` | `5f5e220` | 45115332161 | 430 | `0016_rls_pilot` | S8 |
| #26 | Dead-job reporting and `/api/health/jobs` | #25 → `feature/job-alerts` | `55e0d8d` | 45116319604 | 433 | — | O4 |

Every migration from `0011` to `0016` only adds tables, columns, a function or policies. None drops or rewrites data. `0014` seeds plan rows with today's values. `0016` enables row-level security with policies that change nothing unless `app.org_id` is set.

## 3. Dependency graph and merge order

```
main (b8a8353)
 ├─ #11 tracker (docs only, independent)
 ├─ #16 strict CSP (independent)
 └─ #12 → #13 → #14 → #15 → #17 → #18 → #19 → #20 → #21 → #22 → #23 → #24 → #25 → #26
```

- **Hard dependencies (migrations and code):**
  - the migration sequence `0011` (#12) → `0012` (#15) → `0013` (#17) → `0014` (#19) → `0015` (#20) → `0016` (#25);
  - #18, #19, #21, #22 and #26 use #17/#18's step-up;
  - #14 uses #13's purge;
  - #22 follows #21's `audit.ts` refactor.
- **Order-only dependencies:** #24 is independent in content but sits in the stack to keep the lockfile linear.

**Recommended merge sequence:**
1. #11 (docs).
2. #16 (CSP). Small and independent.
3. #12 → #26 in stack order.

Merge #16 before or after the stack, but **not** in the middle of a retarget.

**Retargeting.** Each stacked PR targets the branch of the PR below it:
- Merge #12 into `main` with a merge commit (or squash; see below), **without deleting `feature/p4-platform-readiness` until #13 is retargeted**.
- Then change #13's base to `main`, and repeat up the stack.
- If squash-merging, each next PR shows the previous PR's commits as already applied only after its base is changed to `main`. GitHub's "Update branch" merges `main` into it (no force-push needed).
- Re-run CI on each PR after retargeting. The migration journal must stay in order, so the stack must merge in sequence.

**Known conflict:**
- `web/docs/SECURITY.md`, one table row, when #16 and the stack meet.
- Resolution: keep #16's `CSP script-src` row ("Strict, with per-request nonces (F2)…") **and** the stack's `Multi-factor authentication` row ("Two-step verification (TOTP) in review (F3a, F3b)…").
- No code conflicts.

**Older-branch flake:** the rate-limit test fixed in #20 (`c22bb34`) can fail on #12–#19 if CI re-runs exactly at a 15-minute clock boundary. Re-run once if it happens; the fix lands with #20.

## 4. Integrated-stack verification (stack + #16)

- **Branch:** `local/integration-check`, local only, not pushed. It's `feature/job-alerts` (#26) merged with `origin/feature/strict-csp` (#16), plus the `SECURITY.md` resolution above; commit `cc0e40f`.
- **Purpose:** #16 had only been tested against `main`, never with the stack.

| Check | Result |
|---|---|
| Merge | Code merged cleanly; one docs conflict, resolved as in §3 |
| Typecheck, lint | Pass |
| Tests, PostgreSQL 16 | **434/434** (433 stack + 1 CSP) |
| Tests, PGlite only | 402 pass, 32 skipped (they need real Postgres) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Production build, client-bundle secret check | Pass |
| Browser regression | strategist 19, creative 16, security 10, QA 20, **no page errors** |
| Feature browser checks under the strict CSP | two-step sign-in 5/5, step-up 9/9, credits 6/6, Security log export 7/7, organisation export 4/4; **no CSP violations or page errors** |

**Environment note:** the local test Postgres stops when this session's worker restarts. One run failed on connection refusal before it was restarted. That's an environment issue, not a product one; GitHub CI uses its own service container.

## 5. Product inventory

Status is per customer journey, not per page. "Regression" means the browser suites:
- `strategist`: sign-up, onboarding, brand profile, approval, strategy, calendar;
- `creative`: Creative Studio;
- `security`: headers, sign-in, roles, Security log;
- `qa`: navigation, mobile, empty states, assistant.

All of them run in **demo mode** (`AI_PROVIDER=mock`), so AI output is simulated.

### A. SaaS foundation

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Sign-up, sign-in, sign-out, sessions | Merged | `auth-forms.test.ts`; security regression | — |
| **Password reset / account recovery** | **Not built** | No reset flow; no way back for a user who loses their password, or both their authenticator and recovery codes | **P0** (roadmap R-P0-2) |
| Email verification | Not built | Invitations join by email on sign-up | Needs email provider (O3); P1 |
| Two-step verification, step-up, sign out everywhere | Verified (stack) | #17, #18; feature checks under CSP | Security emails need O3 |
| Organisations, workspace types (creator, business, agency), multiple brands | Merged | `members.test.ts`, `review-hardening.test.ts`, regression | — |
| Roles (owner, admin, editor, viewer) and brand-scoped client users | Merged | `members.test.ts`, `audit-access.test.ts` | — |
| Tenant isolation | Merged (application scoping) + Verified (stack): RLS pilot on 3 tables | Application tests; `rls-pilot.test.ts` | **RLS covers brands, posts and creatives only.** All other tenant tables rely on application checks (§7) |
| Onboarding | Merged | strategist regression | — |
| Billing (Stripe Checkout, portal, webhooks) | Merged, **Simulated** | `billing.test.ts` (signed webhook fixtures) | No live Stripe test; owner's Stripe account |
| Plans as configuration | Verified (stack) | #19 | Commercial values are owner inputs |

### B. Brand intelligence

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Brand creation, assets, guidelines (PDF), profile generation, approval, versions | Merged, Simulated | `brand-intelligence.test.ts`, strategist regression, Claude-path tests with stubbed HTTP | Live Anthropic run only once (connectivity); A1 |
| Brand memory / persistent context | Merged | `review-hardening.test.ts` | — |
| Competitor research | Merged, Simulated | competitor agent; QA regression | Live web research unverified (A1) |

### C. AI content engine

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Strategy (7 agents), calendar, revisions | Merged, Simulated | `strategist*.test.ts`, regression | A1 |
| Captions, hooks, hashtags, copy packs, platform-specific | Merged, Simulated | `pipeline.test.ts`, content studio | A1 |
| Variations, regeneration, editing | Merged, Simulated | `creative.test.ts` | A1 |
| Retries, timeouts, circuit breaker, fallbacks, error messages | Merged | `ai-providers.test.ts`, `claude-integration.test.ts` | — |

### D. Visual creation

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Image generation, editing, variations (OpenAI) | Merged, **Unverified live** | `creative-providers.test.ts` (stubbed) | **OpenAI live validation not authorised** |
| Brand photos, typographic layouts, carousels, formats, logo placement, render, ZIP | Merged | `creative.test.ts`, creative regression | — |
| Asset management | Merged | `assets` route tests | Object storage is local disk until PR 4.2 |
| Usage accounting | Merged | `usage-accounting.test.ts` | — |

### E. Approval and publishing

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Drafts, submit, approve (admins), reject with reason, schedule, unschedule, publish now | Merged | `posts` actions; R1 | Client (brand-scoped) users can submit but not approve: client sign-off isn't in the approved plan (owner decision) |
| Emergency pause | Verified (stack) | #15 | — |
| Publishing: Instagram and Facebook single image; LinkedIn member profile and Pinterest single image (LinkedIn Company Pages "coming soon") | Merged (code), **Unverified live** | `jobs-postgres.test.ts` with stubbed platforms | Meta app and approvals (P4); no live publish allowed yet |
| Duplicate-publish protection | Merged | atomic claim; interrupted publish isn't retried (`jobs-postgres.test.ts`) | **No publish-attempt ledger or read-back reconciliation** (PR 4.4) |
| Token health, expiry, reconnect prompts | Partial | deauthorise callback (#12) | PR 4.4 |
| Carousels, Reels, video | Not built | — | PR 4.4, needs PR 4.2 (not authorised) |
| **End-to-end lifecycle through publish and metrics** | **Not automated** | Pieces are tested separately; no browser journey publishes, because no test platform exists | **P0 test gap** (roadmap R-P0-4) |

### F. Analytics and optimisation

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Instagram and Facebook post and account metrics | Merged, Unverified live | `syncMetrics` with stubbed platforms | Needs a Meta test account |
| Performance dashboards, AI performance analysis | Merged, Simulated | analytics agent, QA regression | — |
| LinkedIn, Pinterest, YouTube insights; attribution per pillar and campaign | Not built | — | Proposal P4-3 isn't in the approved plan |
| Optimisation loop (change sets) | Not built | — | Proposal P4-5 isn't in the approved plan |

### G. Agency functionality

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Agency workspaces, client brands, staff roles, brand-scoped client access, brand switching | Merged | `members.test.ts`, `audit-access.test.ts` | — |
| Agency usage | Verified (stack) | Settings → AI usage and AI credits by brand (#19) | — |
| Cross-brand content reporting | Not built | Analytics are per brand | Not in the approved plan (owner decision) |
| Client approvals (sign-off) | Not built | — | Proposal P4-7, not adopted (owner decision) |

### H. Operations

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| PostgreSQL, migrations (locked runner, deploy step) | Merged | `postgres.test.ts`, CI container job | Managed Postgres and PITR (owner) |
| Workers, cron, scheduler, graceful shutdown | Merged | `jobs-postgres.test.ts`, CI role smoke test | — |
| Job failure alerting, scheduler health | Verified (stack) | #26 | Routing needs vendors (O1, O2) |
| Object storage | Local disk only | storage adapter tests | PR 4.2 not authorised; single instance only |
| Logging, error capture, readiness | Merged | `infra.test.ts` | Vendor for error tracking (O2) |
| Email | Interface + `log` driver only | `email.ts` | Vendor (O3) |
| Backups, restore drill, deployment, rollback, staging | Documented | DEPLOYMENT.md | Hosting decision (O1, D1) |
| Spending controls | Merged + Verified (stack) | deployment cap; run quota; organisation USD limit (`AI_MONTHLY_COST_LIMIT_USD`); credits shadow, caps, alerts (#19); kill switch and tripwire (#20) | Values are owner settings |

## 6. Findings of this audit

| # | Finding | Severity | Action |
|---|---|---|---|
| F-A1 | **Reviewer account vs mandatory MFA.** #14's reviewer is an organisation owner, and #17 requires owners to enrol in two-step verification in production. A Meta reviewer would be stopped at enrolment. | High for the Meta review (P4) | Fix PR: reviewer setup pre-enrols MFA and prints recovery codes for the review form (R-P0-1) |
| F-A2 | **No account recovery:** no password reset, and no operator path for lost two-step factors. | High | R-P0-2 |
| F-A3 | **Organisation export holds up to 500 MB of files in memory** per request (3 per person per hour). On a small instance this risks out-of-memory. | Medium | R-P0-3 |
| F-A4 | **No automated journey through publish and metrics.** | Medium (evidence gap) | R-P0-4: a sandbox platform for dev and CI only, plus the full lifecycle E2E |
| F-A5 | **RLS protects 3 of the 23 tables that hold tenant or user data** (brands, posts, creatives) and is off by default. It must not be described as tenant isolation. | Informational | Documented in RLS_PILOT.md; risk register §7 |
| F-A6 | **No reviews on any PR.** All evidence is from the author and from CI. | Process | Owner review (or an independent reviewer) before merging |
| F-A7 | #16 had never run with the stack. | Closed | §4 |
| F-A8 | Older-branch rate-limit flake. | Low | §3 |

## 7. Security risk register (summary)

| Risk | Current control | Residual | Before beta |
|---|---|---|---|
| Cross-tenant read or write through a missed filter | Application scoping on every query; tests per area; RLS pilot on 3 tables | Medium: 20 of the 23 tenant tables rely on application checks only | Independent isolation review (F8); RLS on staging with an ordinary role |
| App connects as a superuser (RLS bypassed) | Start-up warning `db.role_bypasses_rls` | Owner configuration | Create an ordinary role (owner) |
| Account takeover | scrypt passwords; rate-limited sign-in; MFA for owners and admins; step-up for sensitive actions | No password reset means support-driven recovery, a social-engineering risk | R-P0-2, with audited operator recovery |
| Sign-up email enumeration (F1) | — | Known | Needs email (S5) |
| XSS | Strict CSP (#16); React escaping; safe legal-markdown renderer | Low | — |
| CSRF | Server actions (Next origin checks); `SameSite=Lax` cookies; signed OAuth state with a browser-bound nonce | Low. GET export routes can be triggered cross-site but only download to the victim's own browser | — |
| SSRF | Pinned public-IP fetcher | Egress firewall missing (F7) | Hosting (owner) |
| Secrets | Encrypted tokens; rotation (#23); no secrets in bundles (CI check) | Secret store at deployment | Owner |
| AI overspend | Fail-closed ledger; deployment cap; run quota; organisation USD limit; tripwire; kill switch | Estimates aren't provider-enforced limits | Provider-side budgets (owner); A1, A2 reconciliation |
| Audit integrity | Append-only by the application; noise limits; retention | Same database role can modify rows | Accept for beta, or a separate audit role later |
| Dependencies | `npm audit` clean (#24) | Next.js 16 upgrade later | — |
| Penetration test (F9) | — | Not done | Owner: before beta or before public launch |

**Security tests still required before beta:**
- the independent isolation review;
- the account-recovery tests (R-P0-2);
- RLS on staging, run as an ordinary role, with the full suite;
- the penetration test, if you choose before beta.

## 8. What is unverified and why

| Item | Why unverified | Plan |
|---|---|---|
| Anthropic generation end to end | Only one connectivity call is authorised so far | A1 plan in roadmap §5 |
| OpenAI images | Live validation not authorised | A1 plan in roadmap §5 |
| Meta, LinkedIn and Pinterest publishing and metrics | No developer apps or test accounts; publishing to real accounts needs approval | P4, P6 |
| Stripe live | Owner's account | Test mode after hosting |
| Email delivery | No provider | O3 |
| Production operations (backups, alerts, rollback) | No hosting | O1, D1 |
