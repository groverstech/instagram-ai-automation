# BrandPilot: production and Phase 4 plan

**Status:** planning only. Nothing in this folder is implemented yet. Phase 4 work starts only
after explicit approval, and each major deliverable ships as its own pull request.

**Start here:** [Phase 4 plan: Production Readiness & Platform Foundation](PHASE4_PLAN.md). It is
the plan awaiting approval: 7 PRs, with dependencies, migrations, testing and acceptance
criteria. Documents 1–9 below are the detailed reference it builds on.

**Product vision (approved):** an AI marketing operating system.

```
Understand Brand → Develop Strategy → Generate Content → Approve → Schedule → Publish → Measure → Learn → Optimise
```

Every AI agent operates with brand-specific memory, permissions, spending limits and autonomy
settings.

## Approved product decisions (8 Nov 2026)

| # | Decision |
|---|---|
| 1 | Platforms in order: **Instagram → Facebook → LinkedIn → YouTube**. TikTok and X come later, through the same modular provider interface. App registration and API approvals start **now**, in parallel with development. |
| 2 | **Cloudflare R2 + CDN.** S3-compatible adapter, private by default, signed URLs, image and video optimisation, tenant isolation, lifecycle management; provider-independent so it can move to AWS S3. |
| 3 | Three autonomy levels (**Advisor, Assisted, Autonomous**); **human approval is the default**. The brand owner controls permissions, categories, frequency, schedules, budget and emergency pause. |
| 4 | **Credit-based AI consumption.** Monthly credits per plan; separate text, image and video tracking; organisation and brand limits; hard caps; alerts at 70/90/100%; paid top-ups; an admin cost dashboard; failed and retried requests tracked. AI cost target ≈15–20% of subscription revenue. **Nothing hardcoded.** |
| 5 | **Anthropic** for brand intelligence, strategy and content; **OpenAI** for images; a modular provider layer. Credentials come through secure environment configuration. Until they are configured, clearly labelled mock mode, and real-provider validation is reported as **pending**. |
| 6 | PR #6 (Phase 3) approved and merged into `main` on 8 Nov 2026 (`f47e245`). |

## Documents

| # | Document | Contents |
|---|---|---|
| 1 | [Production-readiness roadmap](01-production-readiness.md) | Everything between today and a safe production launch, including defects found in this review |
| 2 | [Social platforms and app approval](02-social-platforms.md) | Per-platform permissions, OAuth, review requirements, limitations and dependencies; submission packs; timeline |
| 3 | [AI provider architecture](03-ai-providers.md) | Provider interfaces, routing, metering, failure handling, model choice, adding providers |
| 4 | [Storage and CDN (Cloudflare R2)](04-storage-cdn.md) | Adapter design, key layout, signed URLs, optimisation, lifecycle, migration path |
| 5 | [Subscriptions and AI credits](05-credits-billing.md) | Configurable plans, the credit ledger, caps, alerts, top-ups, the cost dashboard, margin model |
| 6 | [Autonomous publishing security](06-autonomous-publishing-security.md) | Autonomy levels, the policy engine, guard rails, threat model, audit, emergency pause |
| 7 | [Phase 4 breakdown](07-phase4-breakdown.md) | Work packages, dependencies, PR sequence, acceptance criteria |
| 8 | [Effort and external costs](08-effort-and-costs.md) | Engineering estimates and third-party costs |
| 9 | [Scaling to thousands of organisations](09-scalability.md) | Architectural changes for many organisations and many brands per organisation |

## What needs your action (can't be done from code)

1. **Platform developer accounts and app reviews** (see document 2, §7). These need your business
   accounts, business verification documents, legal entity details and domain ownership.
2. **API credentials:** Anthropic, OpenAI, Cloudflare R2, the platform app secrets, Stripe. Set them
   as server environment secrets, never in GitHub or chat.
3. **Legal text:** the privacy policy, terms of service and data processing terms, written or
   reviewed by your counsel. Platform reviews require them, published on your domain.
4. **Commercial inputs:** plan prices, credit allowances and top-up packs. All of these are
   configuration (document 5), so they can be changed without a deployment.
