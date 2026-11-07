# Phase 1 — Brand Intelligence Agent

## 1. Technical assessment (before this phase)

| Area | Found | Decision |
|---|---|---|
| Frontend | Next.js 15 App Router, React 19, Tailwind 4, shadcn-style primitives in `src/components/ui`, Motion | Kept |
| Backend | Server actions + route handlers in the same app; domain services in `src/server` | Kept |
| Database | PostgreSQL via Drizzle (PGlite + pgvector locally, `DATABASE_URL` in production), SQL migrations in `drizzle/` | Extended with migration `0002` |
| Auth & tenancy | Cookie sessions, workspaces → brands, owner/admin/editor/viewer, `requireBrand()` guard on every brand-scoped call | Kept; every new action uses it |
| AI | Claude via `src/server/ai/llm.ts` (structured outputs, refusal fallbacks, mock provider for tests); agents log to `agent_runs` | Kept; the agent was rebuilt on top of it |
| Memory | `brand_memories` with 256-d pgvector embeddings (Voyage or local hashing) | Kept; fixed duplication and added always-on instructions |
| Brand features already present | 7-step onboarding, image/PDF uploads, a flat profile with draft/approve, memory notes, a workflow assistant | Upgraded (see gaps) |

**Gaps and limitations found:**
- No business-description field.
- Uploads trusted the browser's MIME type and accepted only images and PDF.
- One failed asset analysis aborted the whole run.
- The profile wasn't organised into the five requested areas and didn't separate facts from AI guesses.
- No per-section review.
- Re-approving duplicated memories.
- Instructions were retrieved only by similarity.
- No brand Q&A assistant.
- No completeness score.
- No lint configuration.

## 2. What was built

### Onboarding
- Adds a **business description** field.
- Accepts **presentations** and **marketing documents** as well as logo, guidelines, product images, social creatives, marketing creatives and reference designs.
- Formats: PNG, JPG, WebP, GIF, SVG, PDF, DOCX, PPTX, TXT and MD; up to 15 MB each, 20 files and 50 MB per upload.
- The browser pre-checks the extension; the server validates each file by its **content** (magic bytes / ZIP structure) and rejects scripted SVGs and zip bombs.
- Users who belong to several organisations choose which one the new brand belongs to; the server verifies they are an admin or owner of it.
- Files are validated **before anything is written**, so a rejected upload never leaves a partial brand.
- The form stays mounted during submission, so a rejected submission never loses the user's answers.

### Brand Intelligence Agent (`src/server/agents/brand.ts`)
1. **Asset analysis**, one asset at a time:
   - Images go to Claude vision, downscaled first (longest edge 1568 px) when they exceed Claude's size limits.
   - PDFs are sent as native documents.
   - DOCX, PPTX, TXT and SVG are converted to text first (`src/server/assets.ts`).
   - Each result stores a description, palette, typography, aesthetic, notable elements and **facts stated in the asset**.
   - A problem with a file is recorded on that asset (`analysis_error`) and the run continues. AI-service problems (missing key, rate limits, outages) stop the run without marking assets, and re-analysis retries previously failed assets.
2. **Profile generation** from labelled inputs: onboarding answers (*provided*), the public website (*observed*), asset analyses (*observed*) and brand instructions.
3. **Output schema v2** (`src/lib/brand-profile.ts`) has five sections:
   - **A. Identity:** archetype, personality, positioning, values, USPs, differentiation.
   - **B. Audience:** personas with demographics, interests, pain points and motivations.
   - **C. Communication:** voice, tone, style, vocabulary, words to avoid, do/don't, sample lines.
   - **D. Visual:** palette with roles, typography, imagery, design preferences, logo usage, creative direction, preferred styles.
   - **E. Marketing:** objectives, content pillars, campaign opportunities, platform recommendations, content opportunities.
   - Also: competitors, **open questions** and a rationale.
4. **Provenance on every finding:** `provided` / `observed` / `inferred`, plus evidence. The UI shows these as "You said", "Observed" and "AI suggestion". Downstream prompts mark inferred items as `[unconfirmed AI suggestion]`. Demographics default to "Not specified" rather than being guessed.

### Review, approval and memory
- **Per section:** each section can be edited, **confirmed** or reopened.
  - Confirming a section turns its findings into user-confirmed facts.
  - Editing keeps the provenance of unchanged items and marks new or changed ones as *provided*.
- **Approval** makes the profile the source of truth for all agents. Older approved versions are superseded.
- **Memory sync** (`syncProfileMemory`) rebuilds the profile-derived memories from the **approved profile's confirmed sections**.
  - Idempotent: replaces, never duplicates.
  - Unconfirmed AI suggestions never enter long-term memory.
- **Brand instructions** are a dedicated memory kind, included in **every** agent prompt regardless of the retrieval score.
- **Assets** can be approved or rejected. Approved assets are listed as references in every agent's context, and both actions are recorded as feedback.
- **v1 compatibility:** profiles created before this phase are read through `readProfile()`, which upgrades them to v2 with everything marked as unconfirmed. They're rewritten as v2 on first save.

### Retrieval before generation (`src/server/agents/context.ts`)
Before generating anything, every agent gets the following through `buildContext()`, always scoped to one brand:
- The onboarding answers.
- The brand instructions.
- The profile, rendered with provenance and section-review state.
- The approved assets.
- The top-k pgvector memories for the task.

### Brand Intelligence dashboard (`/brand`)
- **Brand Intelligence Score:** 0–100, with a breakdown and next-step tips. It's an indicative completeness measure (inputs, key assets, profile, confirmed sections, approval and learning), labelled as not a quality rating.
- **Overview:** summary, archetype, review progress, and a provenance legend.
- **Tabs:**
  - *Brand profile:* the five sections, open questions, competitive landscape, reasoning and version history.
  - *Ask your brand*
  - *Assets:* filter, approve or reject, retry analysis, extracted facts and palette.
  - *Business details:* every onboarding field, editable.
  - *Memory & instructions*
- Responsive down to phone width, with sideways-scrolling tabs and stacked cards.

### AI Brand Assistant (`src/server/agents/brand-qa.ts`)
- Answers questions using **only** the retrieved brand knowledge, with the seven suggested prompts from the spec.
- Each answer reports:
  - its **basis**: brand knowledge, mixed, or general guidance, shown as a badge;
  - the sections used;
  - whether it relied on unconfirmed suggestions;
  - what information is missing;
  - follow-up questions.
- With no profile, it says so rather than inventing a brand.
- History is stored in `assistant_messages` (`channel = 'brand'`), separate from the workflow assistant.

## 3. Database changes (migration `drizzle/0002_brand_intelligence.sql`)

All additive with defaults, so existing rows remain valid.

| Table | Column | Purpose |
|---|---|---|
| `brands` | `description` | Business description |
| `brand_assets` | `status` (`pending`/`approved`/`rejected`) | Approved reference set |
| `brand_assets` | `analysis_error` | Per-asset failure, retryable |
| `brand_assets` | `extracted_text` | Text from DOCX/PPTX/TXT/SVG |
| `brand_profiles` | `schema_version` | 1 = legacy flat profile, 2 = sectioned with provenance |
| `brand_profiles` | `section_status` | `{ identity: "confirmed" \| "needs_review", … }` |
| `assistant_messages` | `channel` (`workflow`/`brand`) | Separates Brand Q&A from the workflow assistant |
| `assistant_messages` | `meta` | Q&A basis, sections used, missing info |
| `brand_memories.kind` | new value `instruction` | Always-included brand rules |

## 4. Security, tenancy and reliability
- **Authorization:** every action calls `requireBrand(brandId, minRole)`.
  - Viewers can read and ask.
  - Editors can upload, edit, confirm, approve assets and add instructions.
  - Admins can approve the profile.
- **Tenant scoping:** queries filter by `brand_id` from the verified access, never from client input alone. Asset downloads are guarded the same way; another tenant gets 403 (tested end to end).
- **Secrets:** AI calls run server-side only, and keys come from env vars.
- **Logging:** structured JSON logs (`src/server/log.ts`) for uploads, profile generation, approval and asset-analysis failures. Every AI call is also recorded in `agent_runs`.
- **Website reading** is SSRF-guarded: http(s) on standard ports only, public addresses only, every redirect re-validated, responses capped at 400 KB. Residual risk: DNS rebinding between check and connect, so also block internal egress at the network layer in production.
- **Prompt injection:** text from uploads and web pages is fenced and labelled as untrusted data in every prompt.
- **Mock provider:** ignored in production unless `AI_ALLOW_MOCK_IN_PRODUCTION=true`.
- **AI failures:**
  - A refusal, truncated or malformed output, rate limit, outage or rejected key surfaces as a readable message; raw API payloads are never shown.
  - Failed asset analyses are kept, and retried with **Analyse pending**.
  - An unreadable profile row is logged and shown with a "re-analyse" prompt instead of crashing.
- **Plan quota:** AI runs are checked before each agent call.

## 5. How to test

```bash
cd web
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

Manual test with real AI (requires `ANTHROPIC_API_KEY`):
1. `npm run dev`, then sign up.
2. Onboard with real details and a logo, guidelines (PDF or DOCX) and a deck (PPTX or PDF).
3. On **My Brand**, check that every finding has a provenance chip. Edit a section, confirm it, then approve the profile.
4. Under **Assets**, approve the logo. Under **Memory & instructions**, add an instruction.
5. Under **Ask your brand**, try the suggested prompts. Each answer should show "From your brand profile" and the sections used.
6. Go to **Content Studio** and write a caption. It should follow the confirmed voice and your instruction.

Without a key, set `AI_PROVIDER=mock`. Mock output only echoes the onboarding answers and is labelled as mock: it doesn't simulate analysis.

## 6. Environment variables

No new variables. This phase uses the existing ones:

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | Brand analysis, asset vision/document analysis, Brand Q&A (required for real use) |
| `ANTHROPIC_MODEL` | Optional model override (default `claude-opus-5-5`) |
| `AI_PROVIDER` / `AI_ALLOW_MOCK_IN_PRODUCTION` | Development/testing only: `AI_PROVIDER=mock` uses deterministic output; production builds ignore it unless the second is `true` |
| `VOYAGE_API_KEY` | Optional semantic embeddings for memory (local hashing otherwise) |
| `DATABASE_URL` | Postgres with pgvector in production (embedded PGlite otherwise) |
| `APP_SECRET` | Required in production (sessions, signing) |

## 7. Known limitations
- **Real Claude output not yet verified.** No API key was available in the build environment, so all AI paths were tested with the mock provider. The schemas, prompts and SDK calls typecheck against the installed SDK.
- **Legacy formats:** `.doc`, `.ppt` and `.key` aren't supported; export to DOCX, PPTX or PDF.
- **Visual content of documents:** slide and document images inside DOCX/PPTX aren't analysed, only their text. PDFs are analysed natively, visuals included.
- **Website reading:** only the homepage is read, as plain text. JavaScript-rendered sites may yield little.
- **Assets per run:** asset analysis processes up to 12 pending assets per run; run **Analyse pending** again for more.
- **No rate limiting** on AI actions beyond the plan's monthly AI-run quota.
- **Score:** the Brand Intelligence Score measures completeness, not brand or output quality.
