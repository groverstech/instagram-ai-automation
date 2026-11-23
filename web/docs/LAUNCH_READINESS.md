# Private-beta readiness tracker

**The index for BrandPilot's private-beta readiness:** owner decisions and session checkpoints here; gates, roadmap and audit in the three documents in §3. Every PR that
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

## 3. Launch gates, roadmap and audit

Since 23 Nov 2026 these live in three documents, which replace the gate tables and work queue that used to be here:
- **[PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md):** every launch gate with pass/fail status and evidence.
- **[PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md):** remaining work by priority (P0, P1, P2), owner decision briefs, the live-validation plan and the critical path.
- **[PRIVATE_BETA_LAUNCH_AUDIT.md](PRIVATE_BETA_LAUNCH_AUDIT.md):** verified status of `main` and PRs #11–#26, the dependency graph, merge order and retargeting, the integrated-stack verification, the product inventory, findings and the security risk register.

## 4. Work queue

See [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md) §1–§2.

## 5. Decisions and inputs needed from the owner

Decision briefs with options, cost and recommendations: [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md) §4.

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
| 22 Nov 2026 | Opened #16 (strict CSP, F2; from `main`). 349/349 tests; regression 19/16/10/20 under the policy. Next: MFA (F3, S7). |
| 22 Nov 2026 | Opened #17 (MFA F3a; stacked on #15). 386/386 tests; regression 19/16/10/20; browser checks in optional and required modes. Recorded O7 (Next.js postcss advisory). Next: F3b, then PR 4.5 (credits shadow mode). |
| 22 Nov 2026 | Opened #18 (MFA F3b; stacked on #17): 391/391 tests, CI green (45065217077), browser check 9/9, regression 19/16/10/20. Opened #19 (PR 4.5 credits shadow mode; stacked on #18): 400/400 tests, browser check 6/6, regression 19/16/10/20. Next: F12 (AI kill switch and tripwire). |
| 23 Nov 2026 | #19 CI green (45067038811). Opened #20 (F12 kill switch and tripwire; stacked on #19): 407/407 tests, regression 19/16/10/20. Next: F4 (audit-log retention and export) and tenant export. |
| 23 Nov 2026 | #20 CI was red on a pre-existing flaky test (the login limiter's fixed 15-minute window straddled during the run); fixed by pinning the clock (c22bb34), CI green (45108409393). Opened #21 (F4; stacked on #20): 413/413 tests, browser check 7/7, regression 19/16/10/20. Next: tenant data export (D4). |
| 23 Nov 2026 | #21 CI green (45109461233). Opened #22 (D4 organisation data export; stacked on #21): 418/418 tests, browser check 4/4, regression 19/16/10/20. Next: `APP_SECRET` rotation without reconnects (S3). |
| 23 Nov 2026 | #22 CI green (45110486063). Opened #23 (S3 `APP_SECRET` rotation; stacked on #22): 424/424 tests, end-to-end rotation check 6/6, regression 19/16/10/20. O7: npm override points Next.js at the project's patched postcss (audit clean, CSS byte-identical); PR next. Then: RLS pilot (S8). |
| 23 Nov 2026 | #23 and #24 CI green (45112480510, 45113497809). Opened #24 (O7 postcss override) and #25 (S8 RLS pilot; stacked on #24): 430/430 tests, RLS browser check 6/6 as an ordinary role, regression 19/16/10/20. The authorised code queue is now in review; the remaining gates need owner decisions, infrastructure or external parties (see Owner decisions). |
| 23 Nov 2026 | #25 CI green (45115332161). Opened #26 (O4 code part; stacked on #25): 433/433 tests, regression 19/16/10/20. Corrected statuses of S6, D3, P1, P2, P3, P7 and R2 to In review. All authorised code work is now in review; what remains needs owner decisions, infrastructure or external parties. |
| 23 Nov 2026 | Full-mandate reconciliation. Verified all 16 open PRs (heads, bases, CI on head SHAs; no reviews yet) and the stack + #16 integration (434/434, regression 19/16/10/20, CSP feature checks clean). Added PRIVATE_BETA_LAUNCH_AUDIT.md, PRIVATE_BETA_ROADMAP.md and PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md; the gate tables moved to the checklist. New findings: reviewer vs MFA (P8), no account recovery (S11), export memory (D6), no lifecycle E2E (Q1). Next: R-P0-1 to R-P0-4. |
