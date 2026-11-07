# BrandPilot — Architecture

BrandPilot is a multi-tenant SaaS that works as an AI social media marketing team for a brand.
It learns the brand first, keeps that knowledge as persistent memory, and uses it in every
strategy, creative, caption, campaign and analysis it produces.

---

## 1. Product requirements, condensed

| Area | What it must do | MVP status |
|---|---|---|
| Onboarding | Collect business, audience, positioning, voice, goals, platforms, competitors; upload logo, guidelines, product photos, past creatives | ✅ |
| Brand Intelligence | Turn inputs + uploaded images (vision) into a Brand Intelligence Profile; user reviews, edits, approves; saved as versioned memory | ✅ |
| Strategist | Content pillars, cadence, monthly plan, seasonal/festival moments, platform-specific playbooks, collab ideas, explained reasoning | ✅ |
| Creative Studio | Brand-locked creatives in 10 formats × 8 styles; variations, regenerate, edit, resize, download | ✅ (AI imagery when an image provider is configured; typographic layouts otherwise) |
| Content Studio | Primary/alt/short/long captions, hooks, CTAs, hashtags, keywords, per-platform copy, by objective | ✅ |
| Campaigns | Concept → theme → timeline → posts → creatives → schedule; grouped and tracked | ✅ |
| Calendar | Month/week views, drag-and-drop, approve, replace, edit | ✅ |
| Social accounts | OAuth for Instagram, Facebook, LinkedIn, YouTube, Pinterest, TikTok; publish where APIs allow; never fake success | ✅ architecture + OAuth + publishers for IG / FB / LinkedIn / Pinterest; YouTube + TikTok declare video-only / audit-gated capabilities |
| Analytics | Real metrics from connected accounts, AI insights, real vs estimate clearly labeled | ✅ (Instagram + Facebook insights sync; others pluggable) |
| Competitors | Public web research (Claude web search + site fetch), positioning, gaps, differentiation | ✅ |
| Agents | Nine specialized agents sharing a brand knowledge base through an orchestrator; human approval gates | ✅ |
| Assistant | Chat that runs real workflows (campaign, creatives, calendar, analysis) | ✅ |
| Multi-tenant | Workspaces → brands; roles; isolation on every query | ✅ |
| Agency / billing | Multiple brands, teams, invites, plans | ✅ teams + roles + plan limits; payments in Phase 8 |

---

## 2. System architecture

```
┌──────────────────────────── Next.js 15 (App Router) ────────────────────────────┐
│  UI (React 19, Tailwind 4, shadcn-style primitives, Motion)                      │
│   Dashboard · My Brand · Strategist · Creative Studio · Content Studio ·         │
│   Campaigns · Calendar · Competitors · Analytics · Social Accounts · Settings    │
│   + Assistant panel (chat that triggers workflows)                               │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Server Actions / Route Handlers (all auth-guarded, brand-scoped)                │
│   auth · brands · onboarding · agents · creatives(render) · posts · oauth · cron │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Domain services (src/server)                                                    │
│   ┌─────────── Agent Orchestrator ───────────┐   ┌── Social Integration Layer ──┐│
│   │ BrandContext ← Knowledge Base (profile,  │   │ Provider registry + caps     ││
│   │   memories via pgvector, feedback)       │   │ OAuth (state, PKCE), tokens  ││
│   │ Agents: BrandIntel · Strategist ·        │   │  encrypted AES-256-GCM       ││
│   │   ContentStrategist · CreativeDirector · │   │ Publishers: IG, FB, LinkedIn,││
│   │   Designer · Copywriter · Campaign ·     │   │  Pinterest (+YT/TikTok caps) ││
│   │   Analytics · CompetitorResearch         │   │ Insights fetchers            ││
│   │ Workflows (multi-agent pipelines)        │   └──────────────────────────────┘│
│   │ Run log (agent_runs) = activity feed     │   ┌── Jobs ──────────────────────┐│
│   └──────────────────────────────────────────┘   │ Postgres-backed queue        ││
│   ┌── AI Provider Layer ─────────────────────┐   │ worker / cron tick: publish  ││
│   │ LLM: Anthropic (Claude) | mock           │   │ scheduled, sync metrics      ││
│   │ Embeddings: Voyage | local hashing       │   └──────────────────────────────┘│
│   │ Images: OpenAI gpt-image-1 | none        │   ┌── Storage ───────────────────┐│
│   └──────────────────────────────────────────┘   │ local disk | (S3/Supabase)   ││
│                                                  │ signed public URLs           ││
├──────────────────────────────────────────────────┴──────────────────────────────┤
│  PostgreSQL + pgvector (Supabase in prod; PGlite embedded for local dev)          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

* **One deployable first.** A Next.js app holds UI, API and domain services. AI work runs
  through a provider interface, so a Python/FastAPI worker can take over heavy jobs later
  without UI changes; the job queue is already a separate process (`npm run worker`).
* **Postgres everywhere.** Drizzle ORM against PGlite locally (real Postgres in WASM, with
  pgvector), postgres-js against Supabase/Postgres in production. Same SQL, same migrations.
* **Brand-locked creative rendering.** AI image models make the *imagery*; layout, logo,
  palette and typography are composited deterministically by our renderer (Satori via
  `next/og`). Brand rules can't drift, any format can be re-rendered from the same concept,
  and download, resize and preview all come from one render path.
* **Honest integrations.** Each platform declares a capability matrix. Publishing is only
  attempted where the official API supports it, needs an approved post and a connected
  account, and records the platform's real response (id/permalink or error). No simulated success.
* **Secrets stay on the server.** Keys live only in env vars. OAuth tokens are encrypted at
  rest. Public media links (needed by Instagram/Pinterest to fetch images) are HMAC-signed and
  scoped to one creative.

---

## 3. Multi-tenancy and access control

```
users ─┬─< workspace_members >─ workspaces ─< brands ─< (everything brand-scoped)
       └─< sessions
```

* A **workspace** is the tenant (a creator, business or agency). Plans attach here.
* **Roles** per workspace: `owner` > `admin` > `editor` > `viewer`.
  * viewer: read · editor: create/edit drafts, run agents · admin: approve, publish, connect
    accounts, manage brands · owner: billing, members, delete workspace.
* Every brand-scoped call goes through `requireBrand(brandId, minRole)`. It resolves the
  brand → workspace → membership for the session user, and nothing below it trusts a
  client-supplied workspace id.
* Brand memory, assets, campaigns, posts, creatives, accounts and metrics all carry `brand_id`
  and are only queried through that guard.

---

## 4. Database schema (PostgreSQL)

Defined in `src/server/db/schema.ts`; migrations in `drizzle/`.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Accounts | email (unique), name, password_hash (scrypt) |
| `sessions` | Cookie sessions | id = SHA-256(token), user_id, expires_at |
| `workspaces` | Tenants | name, type (creator/business/agency), plan, Stripe customer/subscription, status, period end |
| `stripe_events` | Webhook idempotency | Stripe event id, type |
| `workspace_members` | RBAC + invites | workspace_id, user_id?, invited_email, role, status |
| `brands` | Onboarding inputs | name, website, industry, products, audience, geography, positioning, personality, tone, objectives[], platforms[], competitors[], colors[], fonts[] |
| `brand_assets` | Uploaded files | kind (logo/guideline/product/creative/reference/post), path, mime, AI analysis |
| `brand_profiles` | Brand Intelligence Profile, versioned | version, status (draft/approved), data (jsonb) |
| `brand_memories` | Semantic memory | kind (fact/preference/feedback/approval/insight), content, weight, embedding vector(256) |
| `strategies` | Monthly strategies | month, data (pillars, cadence, moments, playbooks, …), status |
| `campaigns` | Campaigns | name, type, objective, dates, status, brief (jsonb) |
| `creatives` | Creative concepts and images | format, style, concept (jsonb), image_path, image_provider, parent_id (variations), status |
| `posts` | Calendar items | platform, pillar, objective, scheduled_at, status, caption + variants, hashtags, creative_id, campaign_id, social_account_id, external id/url, error, approval fields |
| `social_accounts` | Connected accounts | platform, external_id, encrypted tokens, scopes, status |
| `post_metrics` | Per-post metrics | reach, impressions, likes, comments, shares, saves, views, clicks, engagement_rate, **source** (platform/estimate) |
| `account_metrics` | Daily account metrics | followers, profile_visits, reach, impressions, source |
| `competitors` | Competitor research | name, url, handles, analysis (jsonb), analyzed_at |
| `agent_runs` | Agent activity and audit | agent, task, status, input, output, error, usage, parent_id |
| `jobs` | Background queue | type, payload, status, run_at, attempts, locked_at |
| `assistant_messages` | Assistant history | brand_id, user_id, role, content |

**Post lifecycle** (approval checkpoint built in):
`draft → pending_approval → approved → scheduled → publishing → published | failed`.
Only `approved` posts can be scheduled, and only `admin`/`owner` can approve or schedule.
The assistant and agents can only create `draft` posts.

---

## 5. AI agent architecture

```
                     ┌───────────────────────────────┐
                     │   Brand Knowledge Base         │
                     │  approved profile (versioned)  │
                     │  memories (pgvector top-k)     │
                     │  feedback & approvals          │
                     │  recent performance summary    │
                     └──────────────┬────────────────┘
                                    │ BrandContext (built per task)
            ┌───────────────────────┼─────────────────────────┐
            ▼                       ▼                         ▼
     Orchestrator.run(agent, task, input) — logs agent_runs, writes memory
            │
  Workflows (multi-agent pipelines):
   • onboardBrand:    BrandIntelligence(vision on assets) → profile draft
   • monthlyStrategy: Strategist → ContentStrategist(calendar draft) → Copywriter
   • campaign:        CampaignManager(concept+timeline) → CreativeDirector(concepts)
                      → Copywriter(captions) → Designer(images) → draft posts
   • creatives:       CreativeDirector → Designer (+ Copywriter)
   • analyze:         Analytics(real metrics only) → memory(insights)
   • competitor:      CompetitorResearch(web search + site fetch) → memory
```

* Each agent = role prompt + output schema (Zod → JSON Schema, enforced through Claude
  structured outputs) + the `BrandContext` slice it needs. Agents don't call each other
  directly. The orchestrator passes typed outputs along, so the pipelines are testable and
  every step is logged.
* **Memory loop:** approving a profile, editing a caption, approving or rejecting a post, and
  analytics insights each write a `brand_memory` with an embedding. Later tasks retrieve the
  top-k memories relevant to the task, so the brand model improves with feedback.
* **Explainability:** every strategic output includes a `rationale` that the UI shows.
* **Human checkpoints:** agents never publish, spend money or contact third parties
  (competitor research is read-only public web). Publishing requires an approved post plus
  an explicit schedule action by an admin.
* **Assistant:** a Claude tool-use loop whose tools map 1:1 onto workflows
  (`create_campaign`, `generate_creatives`, `plan_calendar`, `analyze_performance`,
  `suggest_content_ideas`, `research_competitor`). Tool results link to the produced objects.

**Model choice:** `claude-opus-5-5` for every agent, adaptive thinking, effort `medium` by
default, server-side refusal `fallbacks: "default"`. Effort is set per agent in one place
(`src/server/agents/registry.ts`) so it can be tuned.

---

## 6. External APIs

| Need | API | Notes |
|---|---|---|
| Reasoning / copy / vision | Anthropic Messages API (`@anthropic-ai/sdk`) | structured outputs, tool use, web search server tool |
| Embeddings | Voyage AI `voyage-3.5-lite` (256-d) | local hashing fallback |
| Images | OpenAI Images `gpt-image-1` | swappable `ImageProvider` |
| Instagram | Instagram Graph API via Facebook Login (Business/Creator accounts) | publish image (container → publish), insights |
| Facebook | Graph API Pages | photo posts, page insights |
| LinkedIn | OAuth 2 + Posts API + Images API | member posts (w_member_social) |
| YouTube | Google OAuth + Data API v3 | video upload only → images not publishable |
| Pinterest | API v5 | create pin from image URL |
| TikTok | Login Kit + Content Posting API | requires app audit; disabled until approved |

---

## 7. Folder structure

```
web/
  docs/ARCHITECTURE.md
  drizzle/                    SQL migrations
  src/
    app/
      (auth)/login, signup
      onboarding/             multi-step brand onboarding
      (app)/                  authenticated shell (sidebar + assistant)
        dashboard, brand, strategist, creative-studio, content-studio,
        campaigns, campaigns/[id], calendar, competitors, analytics,
        accounts, settings
      api/
        assets/[id]           guarded asset download
        creatives/[id]/image  brand renderer (preview/download/resize)
        public/media/[token]  signed public media for platform fetchers
        oauth/[platform]/start|callback
        assistant             tool-use chat
        cron/tick             job runner trigger
      actions/                server actions per domain
    components/               UI primitives + feature components
    lib/                      shared client/server utilities, constants
    server/
      db/                     schema, client, migrate, seed
      auth/                   passwords, sessions, guards
      ai/                     llm provider, embeddings, image providers
      agents/                 registry, context, agents, orchestrator, assistant
      memory/                 brand knowledge base
      creative/               formats, styles, renderer
      social/                 provider registry, oauth, publishers, insights
      jobs/                   queue, worker
      storage/                storage provider
```

---

## 8. Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 Foundation | Auth, workspaces, RBAC, onboarding, brand profile, dashboard shell | ✅ |
| 2 Brand intelligence | Vision analysis of assets, profile generation/approval, pgvector memory, feedback loop | ✅ |
| 3 Strategy + content | Strategist, Content Studio (captions/hooks/hashtags per platform/objective) | ✅ |
| 4 Creative Studio | Formats, styles, concepts, image generation, brand renderer, variations, resize, download | ✅ |
| 5 Campaigns + calendar | Campaign pipeline, calendar autopopulate, drag/drop, approvals | ✅ |
| 6 Integrations | OAuth, token vault, publishers, scheduler/worker, status tracking | ✅ IG/FB/LinkedIn/Pinterest · YT/TikTok declared |
| 7 Analytics + competitors | Insights sync, AI analysis, competitor research | ✅ IG/FB metrics |
| 8 Agency + scale | Invites/roles ✅, plan limits ✅, Stripe billing ✅ · SSO, audit export, S3/Supabase storage adapter, OpenTelemetry, rate limiting, Python AI worker | next |

### Next up, in order
1. Invite emails (transactional email provider).
2. Supabase Storage / S3 adapter for `StorageProvider`; CDN for rendered creatives.
3. Insights fetchers for LinkedIn, Pinterest and YouTube analytics; Reels/video publishing.
4. Brand consistency scoring: compare uploaded or generated creatives against the profile with vision.
5. Per-agent evals and an effort sweep; prompt caching of the BrandContext prefix.
