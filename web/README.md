# BrandPilot — AI social media marketing manager

A multi-tenant SaaS that works as an AI marketing team for a brand. It learns the brand
first (Brand Intelligence Profile + pgvector memory), then plans strategy, generates
on-brand creatives and copy, builds campaigns and a calendar, publishes through official
platform APIs after human approval, and analyses real performance.

**Architecture, schema, agent design and roadmap:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Quick start

```bash
cd web
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY for imagery)
npm run dev                    # http://localhost:3000
```

There is no database to install. Without `DATABASE_URL`, the app runs embedded Postgres
(PGlite + pgvector) in `./.data/pg` and applies migrations on boot. For production, point
`DATABASE_URL` at Supabase/Postgres with the `vector` extension available.

Sign up, complete onboarding, and the Brand Intelligence agent builds your profile.

### Without API keys

- `AI_PROVIDER=mock` runs every agent with deterministic stand-in output, for UI work and
  tests. A banner in the app marks mock mode.
- Without an image provider, creatives render as typographic brand layouts. Set
  `OPENAI_API_KEY` to generate imagery (`gpt-image-1`).

## What's in the box

| Area | Where |
|---|---|
| Multi-tenant auth, workspaces, roles (owner/admin/editor/viewer) | `src/server/auth`, `src/app/actions/settings.ts` |
| Agents (Brand Intelligence, Strategist, Content Strategist, Creative Director, Design Generation, Copywriter, Campaign Manager, Analytics, Competitor Research) | `src/server/agents` |
| Orchestrator + activity log, brand knowledge base, pgvector memory | `src/server/agents/orchestrator.ts`, `context.ts`, `src/server/memory` |
| Assistant that runs workflows via Claude tool use | `src/server/agents/assistant.ts` |
| Brand-locked creative renderer (preview/resize/download/publish) | `src/server/creative/render.tsx` |
| Social providers with capability matrices + OAuth + publishers + insights | `src/server/social` |
| Job queue, scheduler, worker | `src/server/jobs`, `src/instrumentation.ts` |
| UI (Next.js App Router, Tailwind 4, Motion) | `src/app`, `src/components` |

## Human approval and honest integrations

- Agents and the assistant only create **drafts**. An admin approves, then schedules or
  publishes. Editing approved content sends it back for approval.
- A platform is only published to where its official API supports the action (see
  Social Accounts for each platform's capability matrix). Publishing records the
  platform's real post ID/permalink or its error. Success is never simulated.
- Analytics show only metrics synced from platform APIs (`source = platform`). AI
  insights are labeled and use only those numbers.

## Connecting social platforms

Create an app with each platform and set the env vars in `.env.example`. Register
`{APP_URL}/api/oauth/{platform}/callback` as the redirect URI. Instagram, Facebook,
Pinterest and TikTok fetch media from a public URL, so `APP_URL` must be a public
https domain when publishing.

## Billing (Stripe)

1. In Stripe, create two recurring monthly Prices for the Growth and Agency plans.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY`.
3. Add a webhook endpoint at `{APP_URL}/api/billing/webhook` for `checkout.session.completed`
   and `customer.subscription.created|updated|deleted|paused|resumed`, then set
   `STRIPE_WEBHOOK_SECRET` to its signing secret. For local testing:
   `stripe listen --forward-to localhost:3000/api/billing/webhook`.
4. Enable the Customer Portal (plan switching, cancellation, payment methods, invoices).

Owners upgrade from **Settings → Billing** (Stripe Checkout) and manage the subscription in
the Stripe Customer Portal. The workspace plan changes **only** when a signature-verified
webhook confirms it. Each event is processed once, and subscription state is re-read from
Stripe so out-of-order deliveries can't apply stale data. `past_due` keeps the paid plan while
Stripe retries the payment; cancellation drops to Starter at period end. Downgrades never delete
data, they only block adding beyond the new limits.

## Android app

The app is installable as a PWA and packages as an Android Trusted Web Activity (APK/AAB) with
Bubblewrap. Step-by-step guide: [`docs/ANDROID.md`](docs/ANDROID.md).

## Jobs

With embedded PGlite, the web server runs scheduled publishing and metric syncs every 30s.
With Postgres, set `RUN_JOBS_IN_PROCESS=false` and run `npm run worker`, or call
`GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` from a scheduler.

## Scripts

```bash
npm run dev         # development server
npm run build       # production build (type-checks)
npm test            # integration tests: full agent pipeline on in-memory Postgres + pgvector
npm run typecheck
```
