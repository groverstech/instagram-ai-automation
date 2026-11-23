# Private-beta roadmap

What remains between the current state ([PRIVATE_BETA_LAUNCH_AUDIT.md](PRIVATE_BETA_LAUNCH_AUDIT.md)) and an invite-only private beta. Gates and evidence are in [PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md).

Priorities:
- **P0:** mandatory before the beta: security, isolation, data integrity, essential journeys, spending control, operability.
- **P1:** needed for the complete approved first release (Phase 4 plan, PRs 4.0–4.9), but it can follow the first invitations if you accept that.
- **P2:** after the beta, or outside the approved scope.

Effort is in engineering days for one engineer, including tests and review.

## 1. P0: before inviting anyone

### Engineering (authorised; done without waiting)

| ID | Work | Why | Acceptance criteria | Effort | Depends on |
|---|---|---|---|---|---|
| R-P0-0 | **Owner review of PRs #11–#26**, merge in order (audit §3) | Nothing is on `main` yet | All merged; `main` CI green; migrations `0011`–`0016` applied on staging | Owner time | — |
| R-P0-1 | Reviewer account works with mandatory MFA (finding F-A1) | Meta review would stall at MFA enrolment | `reviewer:setup` enrols TOTP and prints recovery codes; a reviewer signs in with password + recovery code in production mode; test | 0.5 | #14, #17 |
| R-P0-2 | **Account recovery** (F-A2) | Locked-out users have no path back; support-driven recovery is a takeover risk | Forgot-password page (no account enumeration; rate-limited); single-use, hashed, 30-minute reset tokens; reset ends all sessions; audited. Operator CLI issues a reset link and resets two-step verification after identity checks; audited. Email via the hook (delivery waits for O3) | 2 | #17 (sessions, MFA) |
| R-P0-3 | Organisation export memory bound (F-A3) | Up to 500 MB per request held in memory | Lower file budget and one export at a time per instance; test | 0.5 | #22 |
| R-P0-4 | **Lifecycle E2E with a sandbox platform** (F-A4) | No automated proof the journey works through publish and metrics | `SANDBOX` social provider, refused in staging and production, labelled "Simulated". Browser journey: account → organisation → brand → profile → strategy → calendar → content → visual → submit → approve → schedule → publish (job) → metrics → analytics. Runs in CI | 2–3 | R-P0-0 not needed (stack) |

### Owner (approval or vendor needed)

| ID | Decision or action | Why it blocks | Brief |
|---|---|---|---|
| O-P0-1 | **Hosting, managed Postgres with PITR, secrets store, egress firewall** (O1, D1, S2, S10) | No production environment | §4 |
| O-P0-2 | **Production database role** (ordinary, no superuser, no `BYPASSRLS`) and **staging trial of `RLS_PILOT=on`** | RLS is ignored for superusers | §4 |
| O-P0-3 | **Email provider** (O3) | Password reset and invitation delivery need it; S5 needs it | §4 |
| O-P0-4 | **Error tracking and uptime monitoring** (O2, O4) | Dead jobs, tripwire and scheduler health need somewhere to page | §4 |
| O-P0-5 | **Legal text** (L1, P1): privacy, terms, data deletion, DPA | Required for Meta review and for inviting users | Counsel |
| O-P0-6 | **Meta app, business verification, test accounts; then submission** (P4) | Instagram and Facebook publishing is the beta's core | `docs/submissions/META.md` |
| O-P0-7 | **Live AI validation** (A1, A2), with the plan in §5 | Real providers unverified beyond one connectivity call | §5 |
| O-P0-8 | **Spending settings:** `AI_TRIPWIRE_USD`, `AI_MONTHLY_COST_LIMIT_USD` (or per plan), provider-side budgets | Controls exist but have no production values | §4 |
| O-P0-9 | Single-instance beta acceptable? (F5) | Without R2, only one instance | §4 |
| O-P0-10 | Independent tenant-isolation review (F8); penetration test timing (F9) | External assurance | §4 |
| O-P0-11 | Confirm the beta definition and this priority list | Scope | LAUNCH_READINESS §2 |

## 2. P1: complete approved first release

| ID | Work | Approved in | Can start now? | Effort |
|---|---|---|---|---|
| R-P1-1 | **PR 4.4a: publish-attempt ledger, idempotency keys, read-back reconciliation before retry, token-health tracking and reconnect prompts** for the existing single-image publishers | Plan WS3 (4.4) | **Yes:** none of it needs R2 | 3–4 |
| R-P1-2 | PR 4.4b: carousels, Reels, Stories, Facebook multi-photo and video | Plan WS3 (4.4) | No: needs PR 4.2 public media | 3 |
| R-P1-3 | PR 4.2: R2 storage and CDN | Plan WS2 | **No: not authorised** | 4–5 |
| R-P1-4 | PR 4.6: credit enforcement, grants on `invoice.paid`, top-up packs | Plan WS4 | Code yes, behind a flag. Activation needs one shadow billing period and your credit values | 4–5 |
| R-P1-5 | PR 4.7: LinkedIn organisations | Plan WS3 | No: needs LinkedIn API approval | 4 |
| R-P1-6 | PR 4.8: YouTube | Plan WS3 | No: needs Google approvals and 4.2 | 5 |
| R-P1-7 | PR 4.9 remainder: load test, OWASP ASVS L2 review, DR drill | Plan WS5 | Load test and ASVS review: yes (local). DR drill: needs hosting | 3 |
| R-P1-8 | Email verification and invitation emails | Plan P4-0 (invite emails) | Code yes; delivery needs O3 | 1.5 |
| R-P1-9 | Sign-up enumeration fix (S5/F1) | FOLLOW_UPS F1 | Needs O3 | 1 |

**PR 4.6 isn't mandatory for an invite-only beta.** Hard limits already exist without it:
- the plan's monthly AI-run quota (enforced);
- `AI_MONTHLY_COST_LIMIT_USD` per organisation (enforced, from estimated cost);
- the tripwire, the kill switch and the deployment cap.

PR 4.6 matters for **paid** plans. Recommendation: run the beta with credits in shadow mode, compare with `npm run credits -- shadow`, and build 4.6 behind `CREDITS_MODE=enforce` during the beta.

## 3. P2: after the beta, or not in the approved scope (owner decision)

These come from the Phase 4 proposal; the approved plan didn't adopt them:
- client sign-off approvals and comments (P4-7);
- smart scheduling (P4-2);
- cross-platform analytics and attribution (P4-3);
- competitor monitoring (P4-4);
- the optimisation loop (P4-5);
- autonomous agents (P4-6);
- cross-brand agency reporting;
- the Next.js 16 upgrade;
- RLS on all tenant tables with "no organisation means no rows" (RLS_PILOT.md recommendation 2);
- TikTok and X.

## 4. Owner decision briefs

| Decision | Options | Recommendation | Indicative cost | Blocks beta? |
|---|---|---|---|---|
| Hosting (O1) | A: container platform (Fly.io, Render, Railway) + managed Postgres. B: AWS (ECS, RDS) | A for the beta: one web and one worker instance, Postgres with PITR | ~USD 50–150 a month at beta scale (verify current pricing) | Yes |
| Production DB role and RLS | Ordinary role now; `RLS_PILOT=on` on staging, then production | Both, before inviting | None | Role: yes. RLS activation: recommended, not strictly blocking |
| Email (O3) | Postmark, Resend, SES | Postmark or Resend (transactional, simple domain setup) | ~USD 0–20 a month at beta volume | Yes (password reset) |
| Error tracking and uptime (O2, O4) | Sentry plus an uptime service (Better Stack, UptimeRobot) | Sentry free/team tier; an uptime check on `/api/health/ready` and `/api/health/jobs` | ~USD 0–30 a month | Yes |
| Spending settings | Tripwire per 15 minutes; monthly organisation limit; provider budgets | Tripwire ≈ 3–5× normal 15-minute spend; organisation limit per plan; provider budget at the monthly total | Protective | Yes (values) |
| Single instance (F5) | Accept for beta, or authorise 4.2 first | Accept for beta if you're comfortable with a scheduled restore drill | — | No, if accepted |
| Audit retention | 400 days (default) or your policy | 400 | — | No |
| Credit values and allowances | Margin model (`05-credits-billing.md` §5.7) | Set before paid plans, not before the beta | — | No |
| Penetration test timing | Before beta, or before public launch | Before public launch, with an independent isolation review before beta | External quote | Your call |
| Client sign-off, cross-brand reporting | Add to scope, or keep for after the beta | After the beta | Engineering time | No |

## 5. Controlled live-validation plan (A1, A2), for your approval

| Step | Request | Max spend | Stop condition |
|---|---|---|---|
| 1 | `npm run ai:check-anthropic`: one minimal Anthropic message | < USD 0.01 | Any authentication error |
| 2 | `npm run test:live` with **only** the Anthropic key set: the suite's Anthropic text and vision tests run, and the image tests are reported as not run | ≤ USD 3 | Spending cap reached; any refused or failed call |
| 3 | Only after step 2 is reconciled: `npm run test:live` with the OpenAI key added. It runs the image tests (generation and edit) on the fixed concept | ≤ USD 4 | Any error |
| 4 | Reconcile with `npm run ai:billing -- log` and `-- reconcile` against each provider's console export for the run day | — | Estimate differs from the provider data by more than 5% |

- **Hard caps:** `AI_SPEND_CAP_USD=10` with `AI_SPEND_CAP_SINCE` set to the run start; `AI_SPEND_CAP_REQUIRED=true`; dedicated validation keys with provider-side budgets of USD 10 or less; no auto-reload.
- **Not allowed without your approval:** any of these steps; buying credits; raising limits.

## 6. Critical path and parallel work

```
Owner review + merge #11–#26 ──┐
Hosting + DB role + secrets ───┼─► staging deploy ─► RLS on staging ─► live AI validation ─► invite
Email + Sentry + uptime ───────┘          ▲                                   ▲
Legal text ─► Meta app + test accounts ───┴─► Meta review (weeks) ────────────┘ (publishing)
Engineering in parallel: R-P0-1 → R-P0-2 → R-P0-3 → R-P0-4 → R-P1-1 → R-P1-7
```

- **Longest pole:** Meta app review (external, typically weeks). Start the Meta app and legal text first.
- **Engineering P0:** about 5–6 days. It doesn't wait for any decision.
