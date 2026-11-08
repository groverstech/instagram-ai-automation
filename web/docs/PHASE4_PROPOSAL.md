# Phase 4 proposal: from AI tools to an AI marketing operation

**Status:** proposal for review. Nothing here is implemented, and Phase 4 starts only after
explicit approval.

## Goal

Phases 1–3 gave BrandPilot the pieces:
- brand intelligence;
- a strategist;
- a creative studio;
- a calendar, campaigns, competitor research, publishers and analytics.

Each piece mostly runs when a person presses a button. Phase 4 joins them into one closed loop
that keeps running, with people approving what matters:

```
  strategy ──► calendar ──► creatives + copy ──► approval ──► schedule & publish
     ▲                                                              │
     └──── optimise ◄── insights ◄── analytics & competitor signals ◄┘
```

The aim is a brand team that sets goals and guardrails, reviews a short approval queue, and lets
the agents plan, produce, publish, measure and adjust within those rules. Every action is visible,
reversible where possible, and attributable to an agent or a person.

## Where each area stands today

| Area | What exists (Phases 1–3) | Gap for a complete platform |
|---|---|---|
| AI content strategy | Strategist: research, personas, pillars, campaigns, 30-day calendar, versions, approvals | Strategy isn't refreshed from performance; no rolling monthly re-plan |
| AI creative generation | Creative Studio (Phase 3): background jobs, photos, carousels, copy, brand check | **Real-provider validation pending** (see `CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`); no video or Reels; no A/B variant testing |
| Content calendar | Drag-to-reschedule, draft → approval → scheduled → published | Approval workflow is single-step (no comments, no client sign-off, no SLAs); no bulk actions |
| Campaign management | Campaign pipeline (concept, timeline, creatives, draft posts) | No budgets, goals or KPI roll-up per campaign; no campaign retrospective |
| Competitor intelligence | On-demand competitor analysis (web search + site fetch) | No scheduled monitoring, change detection or alerts; no share-of-voice trend |
| Scheduling & publishing | OAuth, token vault, publishers for Instagram, Facebook, LinkedIn and Pinterest; YouTube and TikTok declared only; worker and cron | Video publishing; carousels on every platform; publish reconciliation and retries per attempt; best-time scheduling; token-expiry monitoring; public media on a CDN |
| Analytics | Instagram and Facebook post and account metrics; AI performance analysis | LinkedIn, Pinterest and YouTube insights; per-pillar, per-campaign and per-creative attribution; benchmarks |
| Autonomous agents | Assistant that runs workflows via tool use; scheduled jobs | No goal-driven autonomous planner; no autonomy levels, budgets, kill switch or audit trail for agent actions |

## Proposed modules

| # | Module | What it delivers |
|---|---|---|
| **P4-0** | **Production readiness (prerequisite)** | Run the Creative Studio real-provider plan with real keys; S3/Supabase storage adapter and CDN for rendered media (publishers need public image URLs); invite emails; prompt caching of the brand context; per-agent evals |
| P4-1 | Publishing reliability | A `publish_attempts` table (one row per try, with the platform response); idempotency keys so a post is never published twice; retries with backoff; reconciliation that reads back the platform post; token-expiry alerts; carousel publishing where the platform supports it; per-platform capability checks before scheduling |
| P4-2 | Smart scheduling | Best time to post per platform and pillar, from the brand's own history (falling back to stated defaults, labelled as such); platform rate limits and quiet hours; time zones per brand |
| P4-3 | Analytics and attribution | Insights fetchers for LinkedIn, Pinterest and YouTube; daily metric snapshots; performance per pillar, campaign, creative style, format and visual source; campaign KPI roll-ups against strategy objectives |
| P4-4 | Competitor monitoring | Scheduled competitor snapshots; change detection (new campaigns, offers, posting cadence); weekly digest; every claim linked to its source, and unverified findings labelled |
| P4-5 | Optimisation loop | A weekly "performance review" agent that proposes concrete changes (pillar mix, formats, posting times, creative styles, A/B variants) as a **change set** the brand approves. Approved changes update the strategy version and the next calendar. |
| P4-6 | Autonomous marketing agents | Goal-driven agents (planner, producer, publisher, analyst) on the job engine, each acting only through the same audited server actions people use, under a per-brand **autonomy policy** (below) |
| P4-7 | Approvals and collaboration | Multi-step approval (editor → brand admin → client), comments on posts and creatives, an approval inbox with SLAs and reminders, bulk approve and reject |
| P4-8 | Operations and governance | Audit log of every agent and human action; AI spend budgets per brand with hard stops; a kill switch; an agent activity timeline; OpenTelemetry traces |

### Autonomy policy (per brand, off by default)

| Level | Agents may… | People must… |
|---|---|---|
| L0 Advise | Suggest only | Do everything |
| L1 Draft (default) | Plan, generate creatives and copy, fill the calendar as drafts | Approve every post |
| L2 Schedule | Schedule approved-template posts into open slots | Approve each post before it publishes (the publish gate remains) |
| L3 Auto-publish | Publish within explicit rules (pillars, formats, posting caps, a minimum brand-check score, no blocking issues, a budget cap) | Opt in per brand and platform; review the daily digest; can pause instantly |

Guardrails at every level:
- AI spend caps per brand and month;
- a posting cap per day;
- a required brand-check score;
- a banned-topics list;
- nothing new published to an account in its first 7 days at L3;
- every action logged and attributable;
- one-click pause for the brand or the whole workspace.

## Architecture

- **Agent runtime:** built on the existing job engine (`src/server/jobs/engine.ts`): persistent,
  claim and heartbeat, recovery, idempotent steps. Agents get a small tool surface that calls the
  existing server actions, so the same role checks, brand isolation and rate limits apply to
  agents and people.
- **Policy engine:** a pure function `may(agent, action, brandPolicy, context)`, evaluated before
  every agent action and unit-tested exhaustively. Denials are logged with the reason.
- **Event bus:** domain events (`post.published`, `metrics.synced`, `competitor.changed`,
  `creative.approved`) written to a table and consumed by agents. There is no new infrastructure
  until the volume needs it.
- **Storage:** a `StorageProvider` adapter for S3 or Supabase, with signed or public CDN URLs for
  publishing.

## Database changes (indicative)

| Table | Purpose |
|---|---|
| `publish_attempts` | Every publish try: idempotency key, request, platform response, status |
| `metric_snapshots` | Daily metrics per post and account (time series) |
| `competitor_snapshots` | Captured competitor state and detected changes, with sources |
| `agent_policies` | Autonomy level, caps, rules per brand and platform |
| `agent_actions` | Audit log: agent or user, action, inputs, outcome, cost, policy decision |
| `change_sets` | Optimisation proposals, approval state, and the strategy version they produced |
| `approvals`, `comments` | Multi-step approvals and threaded comments |
| `experiments` | A/B variants, allocation, results |

All changes are additive migrations with upgrade tests, in the same style as 0004–0006.

## External APIs and dependencies

| Integration | Use | Note |
|---|---|---|
| Meta Graph API (Instagram, Facebook) | Publishing (image, carousel, Reels), insights | Reels and some insights need app review and permissions |
| LinkedIn Marketing / Community Management API | Organisation posts, analytics | Partner-program approval for some scopes |
| Pinterest API v5 | Pins, analytics | Standard access review |
| YouTube Data and Analytics API | Shorts and video upload, analytics | Google OAuth verification for the sensitive scopes |
| TikTok Content Posting API | Video publishing | App audit is required before public posting |
| OpenAI Images, Anthropic Claude | Creatives, copy, agents | Real-provider validation (P4-0) first |
| Web search (existing) | Competitor monitoring | Results stay labelled as verified or unverified |
| S3 or Supabase Storage plus a CDN | Media for publishing | New infrastructure dependency |

**Platform app reviews take weeks.** They should be started at the beginning of Phase 4, in
parallel with development.

## Security

- **Agents** act only through server actions with role and brand checks. They hold no keys, and
  their tool inputs are validated with the same schemas.
- **Prompt injection:** competitor pages, comments and documents are passed to agents as data. Any
  tool call that publishes or spends money needs a policy decision, not just model output.
- **Tokens:** OAuth tokens stay in the token vault (encrypted), with least-privilege scopes,
  refresh monitoring and revocation on disconnect.
- **Webhooks:** platform webhooks have their signatures verified and are replay-protected.
- **Audit:** the audit log is append-only and can be exported.
- **Spend:** caps are enforced before a call, not after.

## Testing and acceptance (summary)

- **Policy engine:** a full decision-table test for every level and rule.
- **Publishing:** idempotency under concurrent workers and crashes (no double posts), with a mock
  platform server; reconciliation after timeouts.
- **Live checks per platform:** a sandbox or test account, run manually like `test:live`, never in
  CI.
- **End to end:** goal → plan → drafts → approval → scheduled publish to a test account → metrics
  sync → weekly change set → approved → next calendar updated.
- **Regression:** all existing suites, plus desktop, mobile and PWA browser runs.

**Acceptance:** one brand runs at L1, and a test brand at L2, for 2 weeks on test accounts, with:
- zero duplicate posts;
- zero unapproved publishes;
- metrics in the dashboard reconciled with the platforms;
- AI spend within the configured caps.

## Suggested order

1. **P4-0** production readiness: real providers, storage and CDN, emails. Start the platform
   app reviews at the same time.
2. **P4-1** publishing reliability and **P4-7** approvals. Trust comes first.
3. **P4-3** analytics and attribution, then **P4-2** smart scheduling.
4. **P4-4** competitor monitoring and **P4-5** the optimisation loop.
5. **P4-6** autonomous agents, rolled out L0 → L1 → L2, with L3 last and opt-in, plus **P4-8**
   governance before any L2 rollout.

## Decisions needed before starting

1. Which platforms matter first (this decides which app reviews to start now)?
2. The storage and CDN provider: S3, Supabase or another.
3. Is L3 auto-publishing in scope for Phase 4, or should Phase 4 stop at L2 (scheduled, with a
   human publish gate)?
4. AI spend cap defaults per plan.
5. Will provider API keys be available for P4-0's real-provider validation? It's the prerequisite
   for calling the creative side production-ready.
