# Private-beta readiness tracker

> **Snapshot, superseded (25 Nov 2026):** every PR named here is merged to `main`. Current state: [PRIVATE_BETA_PROGRESS.md](PRIVATE_BETA_PROGRESS.md) and [PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md); what only the owner can do: [PRIVATE_BETA_OWNER_ACTIONS.md](PRIVATE_BETA_OWNER_ACTIONS.md).

**The index for BrandPilot's private-beta readiness.** The beta definition is here; everything else is in the five documents listed in §3. Every PR that
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
  - autonomous publishing: the three levels are built (#37), but the beta runs at Assisted (a
    person approves every post); Autonomous stays off until the owner authorises it (D-28);
  - credit enforcement: built (#38) but off; it is turned on after a shadow period (D-17);
  - TikTok and X.

## 3. Launch gates, roadmap and audit

Since 23 Nov 2026 these live in five documents, which replace the gate tables, work queue, decision list and checkpoints that used to be here:
- **[PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md):** every launch gate with pass/fail status and evidence.
- **[PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md):** remaining work by priority (P0, P1, P2), owner decision briefs, the live-validation plan and the critical path.
- **[PRIVATE_BETA_OWNER_DECISION_PACK.md](PRIVATE_BETA_OWNER_DECISION_PACK.md):** the current owner decision pack: merge order with exact commits, the single register of open decisions (A–G) with recommendations, the deployment sequence, beta blockers and the safety defaults. (The older [PRIVATE_BETA_DECISIONS_REQUIRED.md](PRIVATE_BETA_DECISIONS_REQUIRED.md) is superseded.)
- **[PRIVATE_BETA_PROGRESS.md](PRIVATE_BETA_PROGRESS.md):** open PRs, SHAs, CI, active work, known problems, how to resume, checkpoints.
- **[PRIVATE_BETA_LAUNCH_AUDIT.md](PRIVATE_BETA_LAUNCH_AUDIT.md):** verified status of `main` and PRs #11–#26, the dependency graph, merge order and retargeting, the integrated-stack verification, the product inventory, findings and the security risk register.

## 4. Work queue

See [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md) §1–§2.

## 5. Decisions and inputs needed from the owner

Moved to [PRIVATE_BETA_OWNER_DECISION_PACK.md](PRIVATE_BETA_OWNER_DECISION_PACK.md) §4.

## 6. Checkpoints

Moved to [PRIVATE_BETA_PROGRESS.md §5](PRIVATE_BETA_PROGRESS.md#5-checkpoints).
