# Private-beta readiness tracker

**The single source of truth for what remains before BrandPilot's private beta.** Every PR that
changes a gate updates this file in the same PR, with evidence. Status is changed only when the
work is merged **and** its evidence exists; a plan, a PR in review or demo-mode output is not
evidence.

- Approved scope: the [Phase 4 plan](plan/PHASE4_PLAN.md) and its reference documents
  ([plan/](plan/README.md)), approved product direction of 8 Nov 2026. Later decisions recorded in
  merged PRs supersede details in the plan (for example the image models: see
  [AI_PROVIDERS.md](AI_PROVIDERS.md)).
- Detailed requirements for security and operations items: [FOLLOW_UPS.md](FOLLOW_UPS.md) (F-numbers),
  [DEPLOYMENT.md](DEPLOYMENT.md), [SECURITY.md](SECURITY.md).
- The product owner approves every merge, infrastructure change, live provider call, deployment
  and the beta launch itself.

Status values: **Done** (merged, with evidence) · **Partial** · **Not started** · **In progress**
(open PR) · **Owner** (needs a decision, account or action from the owner) · **External** (a third
party, e.g. platform review).

## 1. Baseline (verified 22 Nov 2026)

| Check | Result |
|---|---|
| `main` | `b8a83536e2b30878ab9ac0ef410f76310d5606b4` (PR #10 merged) |
| CI on that commit | Run 45029790227, first attempt: "Typecheck, lint, test, build" and "Container image (build and role smoke test)" passed |
| Independent local run | 348/348 tests on PostgreSQL 16 (26 files), typecheck and lint pass |
| Merged so far | Phases 1–3; PR 4.0 infrastructure baseline (#7); PR 4.1 AI providers (#8); F13 Postgres job queue (#9); R-1 spending-cap test (#10) |

## 2. What "private-beta ready" means here

Proposed working definition, derived from the approved plan and its launch checklist
([plan/01-production-readiness.md §1.4](plan/01-production-readiness.md)). It adds no features.
The owner confirms or adjusts it.

Invited organisations use the approved loop **with real providers**: Understand Brand → Develop
Strategy → Generate Content → Approve → Schedule → Publish (Instagram and Facebook) → Measure. On one
production-grade deployment, with the security, data and operations gates below met.

- **In:** brand intelligence, strategist, creative studio, human approval before every publish,
  scheduling, Instagram and Facebook publishing, metrics, multi-tenant roles, AI usage and spend
  controls.
- **Not in the beta:**
  - LinkedIn and YouTube publishing: they wait for platform approvals and are shown as "coming soon";
  - autonomous publishing: the first release keeps human approval for everything, and the
    Advisor, Assisted and Autonomous levels are not in the Phase 4 plan;
  - paid credit enforcement: PR 4.6 runs after a shadow billing period;
  - TikTok and X.

## 3. Launch gates

### Security

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| S1 | No secrets in the repository or client bundles | **Done** | `check:secrets` in CI; `.env*` ignored | — |
| S2 | Secrets in the platform's secret store, rotated after testing | **Owner** | At deployment | Owner |
| S3 | OAuth tokens encrypted at rest; key rotation documented | **Partial** | AES-256-GCM in place. Rotating `APP_SECRET` today invalidates tokens (DEPLOYMENT §6), and no procedure without reconnects exists. Next: document the procedure (or add key versioning) in PR 4.9 | Code |
| S4 | Rate limits, quotas and spend caps enforced server-side | **Partial** | Rate limits, plan run quota, fail-closed AI ledger and deployment-wide cap (PR 4.1). Missing: organisation and brand limits, kill switch and tripwire (F12) | Code |
| S5 | Sign-up doesn't reveal registered emails (F1) | **Not started** | Needs the email provider (O3) | Owner, then code |
| S6 | Strict Content Security Policy (F2) | **Not started** | Planned security PR (§4) | Code |
| S7 | MFA for owners and admins (F3) | **Not started** | Required "before the first external agency or paying customer". Planned (§4) | Code |
| S8 | Row-level security pilot and independent isolation check (F8) | **Not started** | RLS pilot in PR 4.9; independent review | Code, External |
| S9 | Penetration test with findings fixed or accepted (F9) | **Not started** | After the beta build is feature-complete | Owner, External |
| S10 | Egress firewall and metadata protection (F7) | **Not started** | With the hosting platform | Owner |

### Data

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| D1 | Postgres backups with PITR; restore drill passed | **Owner** | Procedure in DEPLOYMENT §9; needs managed Postgres | Owner |
| D2 | Object storage with versioning and lifecycle (R2) | **Not started** | PR 4.2: **not authorised yet** | Owner |
| D3 | Account and brand deletion end to end | **In progress** | PR #13 (4.3b): Settings → Delete data for brands, organisations and accounts; tests and browser checks pass | Code |
| D4 | Tenant data export | **Not started** | With the F4 export work (§4) | Code |
| D5 | Audit-log retention and export (F4) | **Not started** | Required before customer launch | Code |

### Platforms

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| P1 | Public privacy, terms and data-deletion pages; Meta data-deletion and deauthorise callbacks | **In progress** | PR #12 (4.3a). Legal text comes from the owner's counsel (O5); until then the pages are marked draft and must not be submitted | Code, Owner |
| P2 | Capabilities match what the publishers implement (plan defect D2) | **In progress** | PR #12. Before it, Instagram and Facebook claim carousel and video support, but only single images are published | Code |
| P3 | Instagram receives JPEG media (plan defect D1) | **In progress** | PR #12 serves the publish media as JPEG. Public hosting at scale comes with R2 (PR 4.2) | Code |
| P4 | Meta app approved for production permissions (or beta users added as app testers) | **External** | Pack, checklist and reviewer account ready (#14, `docs/submissions/META.md`). Submit once a public domain, the final legal text and your Meta app are in place. **It doesn't need R2:** single-image publishing works through the app's signed media links on a single instance | Owner, External |
| P5 | Publish ledger, idempotency, reconciliation and token health; carousel and Reels | **Not started** | PR 4.4, which needs PR 4.2 and PR 4.3 | Code |
| P6 | Live publish tests to test accounts on every enabled platform | **Not started** | After PR 4.4 and Meta access | Owner |
| P7 | LinkedIn and YouTube marked "coming soon" until approved | **In progress** | PR #12 labels them; a test checks the wording | Code |

### AI

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| A1 | Real-provider validation with archived `test:live` report (F10) | **Owner** | Needs keys in the validation environment and approval of the paid run (USD 10 budget) | Owner |
| A2 | Estimated costs reconciled with provider exports within 5% | **Owner** | After A1; tooling exists (`npm run ai:billing -- reconcile`); provider data supports per-model and per-day comparison only | Owner |
| A3 | Demo mode impossible in production | **Done** | Config check and tests (PR 4.0, 4.1) | — |
| A4 | Organisation and brand AI limits, alerts, kill switch (F12) | **Not started** | Limits and alerts with PR 4.5; kill switch and tripwire as a separate PR (§4) | Code |

### Operations

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| O1 | Hosting platform and deployment pipeline (F6) | **Owner** | Decision pending; container image is built and smoke-tested in CI | Owner |
| O2 | Error tracking and tracing (plan defect D9) | **Partial** | `captureError` hook with references; vendor pending | Owner, then code |
| O3 | Transactional email (plan defect D8) | **Partial** | Interface and `log` driver; provider pending; refuses in staging and production | Owner, then code |
| O4 | Uptime checks, alert routing, dead-job alerting | **Not started** | Health endpoints exist; alerting needs O1 and O2 | Owner, then code |
| O5 | Status page | **Not started** | Third-party service | Owner |
| O6 | Scaling beyond one instance (F5) | **Owner** | A single-instance beta needs the owner's approval; otherwise R2 and shared rate limits first | Owner |

### Legal and product

| # | Gate | Status | Evidence or next action | Blocker type |
|---|---|---|---|---|
| L1 | Privacy policy, terms and DPA published | **Owner** | Text from counsel; pages from PR 4.3 | Owner |
| L2 | Platform terms reviewed | **Owner** | — | Owner |
| R1 | Human approval before every publish | **Done** | `schedulePost` and `publishNow` refuse unapproved posts; only admins schedule (`src/app/actions/posts.ts`) | — |
| R2 | Emergency pause of all publishing for a brand | **In progress** | PR #15: pause (editors and above) cancels queued publishes and blocks every publishing path; resume (admins) re-queues future posts and returns missed ones to approved; tests and browser checks pass | Code |
| R3 | Plans and limits configurable, credits in shadow mode (plan defect D5) | **Not started** | PR 4.5 | Code |

## 4. Work queue

Ordered by what unblocks the most, highest priority first. Work that needs no owner input is
started without waiting; each item is its own PR.

| Order | Work | Gates | Needs from the owner | Status |
|---|---|---|---|---|
| 1 | **PR 4.3 Platform readiness**, in three stacked PRs: **4.3a** (#12) legal pages, Meta callbacks, honest capabilities, JPEG media; **4.3b** (#13) self-service deletion; **4.3c** (#14) Meta submission pack and reviewer account | P1, P2, P3, P7, D3 | Legal text before any submission; the `business_management` decision | All three in review |
| 2 | Emergency pause | R2 | — | In review (#15) |
| 3 | Strict CSP (F2) | S6 | — | Queued |
| 4 | MFA (F3) | S7 | — | Queued |
| 5 | PR 4.5 Configurable plans and credits, shadow mode; organisation and brand AI limits and alerts | R3, A4 (part) | Commercial inputs can come later: everything is configuration | Queued |
| 6 | AI kill switch and tripwire (F12) | A4 | — | Queued |
| 7 | Audit-log retention and export (F4), tenant export | D4, D5 | — | Queued |
| 8 | PR 4.9 parts: RLS pilot, `APP_SECRET` rotation procedure | S8, S3 | — | Queued |
| — | PR 4.2 R2 storage and CDN | D2, P3, O6 | **Authorisation**, Cloudflare account | Blocked: owner |
| — | PR 4.4 Instagram and Facebook publishing (ledger, idempotency, reconciliation, carousels, Reels) | P5, P6 | PR 4.2 for video and scale; Meta app and test accounts | Blocked: 4.2 and owner. Single-image publishing already works without it on one instance (#14 finding) |
| — | Real-provider validation | A1, A2 | Keys in the validation environment; approval of the paid run | Blocked: owner |
| — | Email, error tracking, hosting, alerting adapters | O1–O4, S5 | Vendor choices | Blocked: owner |

## 5. Decisions and inputs needed from the owner

1. **Confirm the private-beta definition** in §2.
2. **Authorise PR 4.2 (R2)** and create the Cloudflare account. Instagram publishing (PR 4.4) depends on it.
3. **Choose vendors:** hosting, managed Postgres, email, error tracking, status page.
4. **Real-provider validation:** keys in the validation environment and approval of the paid run.
   Anthropic: the key must reach the session as an environment variable
   (`BRANDPILOT_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`). The platform doesn't accept user
   network secrets for Anthropic's hosts.
5. **Legal text** for the privacy policy, terms, data-deletion instructions and DPA.
6. **Meta developer app**, business verification, and test Instagram Business and Facebook Page
   accounts. Submission happens after PR 4.3 is merged and the final legal text is live.
7. Whether a **single-instance beta** is acceptable (F5).
8. Whether the **penetration test** must happen before the beta or before the public launch.

## 6. Checkpoints

Each session appends one line: date, what was merged or opened, gates changed, next item.

| Date | Checkpoint |
|---|---|
| 22 Nov 2026 | Baseline verified (§1). Tracker created; plan documents brought onto `main` with it. Next: PR 4.3 platform readiness. |
| 22 Nov 2026 | Opened #12 (4.3a: legal pages, Meta callbacks, capabilities, JPEG; CI green) and #13 (4.3b: self-service deletion, stacked on #12). Evidence: 373/373 tests on Postgres 16; browser regression 19/16/10/20 passing. Next: 4.3c (reviewer demo workspace, submission packs), then emergency pause (R2). |
| 22 Nov 2026 | Opened #14 (4.3c: Meta submission pack, `reviewer:setup`). Finding: the Meta review and single-image beta publishing don't depend on R2 for a single-instance beta. Next: emergency pause (R2), then strict CSP (F2). |
| 22 Nov 2026 | Opened #15 (emergency pause, R2; stacked on #14 for migration numbering). 378/378 tests; regression 19/16/10/20. Next: strict CSP (F2, S6). |
