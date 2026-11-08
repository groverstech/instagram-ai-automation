# AI Creative Studio and Content Generator

The Creative Studio turns a brief, an entry in the approved strategy's calendar, or a campaign
card into on-brand social creatives: a concept, a visual, platform copy and a brand consistency
check. Nothing is published automatically. Every creative is a draft until someone approves it.

## Status at a glance

| Area | Status |
|---|---|
| Background creative jobs (recovery, retries, no duplicates) | Done; tested |
| Visual sources: brand photo, type-led | Done; verified end to end in the browser |
| Visual source: AI image (OpenAI `gpt-image-1`) | Built. **Real generation not yet verified**: no OpenAI key was available. See [Real-provider status](#real-provider-integration-status). |
| Carousels, logo placement, 12 formats, PNG/ZIP download | Done; verified in the browser and by tests |
| Copy pack with originality guard | Built. Verified in demo mode; **real Claude output not yet verified** |
| Brand check: deterministic checks | Done; verified |
| Brand check: Claude vision review | Built. **Real review not yet verified** (demo stand-in only) |
| Strategy calendar → creatives | Done; verified in the browser |
| Demo and production AI modes kept separate | Done; tested |
| Storage cleanup of replaced and deleted visuals | Done; tested |

## Flow

```
brief / calendar entry / campaign card
        │
        ▼
creative_batch job (persistent, background)          src/server/creative/jobs.ts
  concepts:<i>   Creative Director → 1–6 concepts, or one 3–8 slide carousel
  visual:<id>    AI image | approved brand photo | type-led (no photo)
  copy:<id>      Copywriter → caption, alternatives, hooks, CTA, hashtags, platform variants
  check:<id>     deterministic checks + Claude vision review of the rendered creative
        │
        ▼
Studio: edit, resize, download PNG/ZIP, variations, approve → Add to calendar
```

The job runs on the shared engine (`src/server/jobs/engine.ts`), the same one the Marketing
Strategist uses:
- Admission (quota, rate limit, concurrency slot) happens once, when the job starts.
- An atomic claim with a heartbeat. A job whose worker died is picked up again after
  2 minutes, by the in-process loop, `npm run worker` or `GET /api/cron/tick`.
- Temporary AI service errors are retried automatically with backoff, up to 3 attempts.
- Steps are idempotent:
  - concept rows are stamped with `task_id` and their batch item;
  - copy and brand checks record the `taskId` that wrote them;
  - a visual that already exists is not generated again.

  A recovered job therefore finishes the remaining steps without creating duplicate creatives or
  paying twice for finished work. A provider call that was in flight when the process died may
  have been billed; that call is recorded as "unknown usage", never as free. Exactly-once
  billing is not guaranteed.

## Demo and production AI modes

| | Demo mode (`AI_PROVIDER=mock`) | Production |
|---|---|---|
| Text agents (concepts, copy, review) | Deterministic stand-ins, labelled "[Demo]" | Claude (`ANTHROPIC_API_KEY`) |
| AI image | A watermarked placeholder ("DEMO IMAGE — no AI image provider was called"). **No image API is called, even if `OPENAI_API_KEY` is set.** | OpenAI (`OPENAI_API_KEY`) |
| Usage and cost | No image usage recorded for placeholders | Recorded per call |
| Brand check | The review is marked "demo review (mock AI, not a real review)". The Visual check warns that a placeholder isn't an AI image. | Real review; the model is shown |
| Banner | "Mock AI provider active" on every page | — |

**Guard rails:**
- In production (`NODE_ENV=production`), `AI_PROVIDER=mock` is **ignored** unless `AI_ALLOW_MOCK_IN_PRODUCTION=true` is also set (demos and E2E only). A stray setting can't swap Claude or OpenAI for stand-ins for real users.
- `IMAGE_PROVIDER=none` disables AI images in both modes.

Tests: `src/server/ai-modes.test.ts`.

## Visual sources

| Source | What it does | When available |
|---|---|---|
| AI image | Generates an image from the concept's art direction (`gpt-image-1`) | `OPENAI_API_KEY` set and `IMAGE_PROVIDER` not `none` (demo mode: placeholder) |
| Brand photo | Uses the brand's **approved** product/reference/creative/post photos (PNG, JPEG, WebP), chosen or rotated | At least one approved photo in My Brand → Assets |
| Type-led | Brand colours and typography, no photo | Always |

The studio shows an unavailable source as disabled, with the reason.

Brand photos are copied into the creative's storage and normalised:
- EXIF orientation is applied;
- the size is capped at 2048 px;
- WebP is stored as PNG, because the renderer can't decode WebP.

A photo from another brand, or one that isn't approved, is refused.

**How the AI image follows the brand:** the Creative Director writes each concept's art direction
from the approved brand profile (visual identity, imagery, mood). The image prompt
(`imagePromptFor`) is built from:
- that art direction;
- the chosen style and the concept's image treatment;
- a colour mood taken from the concept's palette, which is drawn from the brand colours;
- "no text, letters, logos or watermarks".

The model only produces the picture. Brand colours, fonts, the logo and all text are composed by
the BrandPilot renderer, never drawn by the image model, so typography and logo are always exact.

## Rendering

`src/server/creative/render.tsx` composes the creative with Satori (`next/og`) from the brand's
fonts, palette and logo:
- **Layouts:** hero overlay, split, frame, typographic, editorial column and product badge.
- **Logo:** placed in a chosen corner inside a safe area of 72 px at 1080 px (≈6.7% of the short
  side), or hidden. When no logo asset is uploaded, the brand name is set as text.
- **Text colour:** text on brand colours picks a contrast-safe colour.
- **Carousels:** the cover plus 2–7 inner slides, with a slide counter, "Swipe" on the inner
  slides and the CTA on the last one.
- **Image types:** detected from the file bytes (PNG, JPEG, WebP), not from the file name.
- **Formats:** 12, each rendered at its exact size: Instagram post 1080×1350, square 1080×1080,
  carousel 1080×1350 and story 1080×1920; Facebook 1200×1200; LinkedIn 1200×1200; banner
  1600×900; product ad 1080×1080; event and festival 1080×1350; YouTube thumbnail 1280×720;
  Pinterest pin 1000×1500.
- **Routes:**
  - `GET /api/creatives/:id/image?format=&slide=&download=1` renders one slide in any format.
    An unknown format or slide returns 400. A download is an attachment named
    `<brand>-<title>[-slide-N]-<w>x<h>.png`.
  - `GET /api/creatives/:id/zip?format=` returns every slide plus `caption.txt`.

  Both need viewer access to the brand and count against the render rate limit.

## Storage

Visuals live under `brands/<brandId>/creatives/<creativeId>-…`. Brand photos are copied there, so
a creative survives deletion of the source asset.
- **Replacing a visual** (regenerating it, choosing another photo or changing the source) deletes
  the files the creative no longer uses. This happens only after the new visual is saved. A file
  that is reused under the same key is kept.
- **Deleting a creative** deletes its files.
- **Scope:** only keys under the creative's own prefix are ever removed. Brand assets and other
  creatives are never touched. A failed delete leaves an orphan file, never a broken creative.

## Copy pack and originality

The copywriter writes in the brand voice from the approved Brand Intelligence Profile. Each
pack has:
- a primary caption, alternatives, and short and long versions;
- hooks, a CTA, hashtags, keywords and variants per platform.

The originality guard checks the primary caption for:
- stock marketing phrases ("elevate your", "game-changer", …);
- similarity to the brand's recent captions (3-gram Jaccard ≥ 0.45).

On a hit it rewrites once, with feedback. Anything that remains is shown in the Copy tab, not
hidden. Edits are validated, re-checked for originality and recorded in brand memory.

## Brand consistency check

Deterministic checks (`deterministicChecks`, reproducible):
- **Contrast (WCAG):**
  - The headline and CTA are large text: at least 3:1, with 4.5:1 recommended.
  - The supporting line is body text: at least 4.5:1.
  - Text over imagery is estimated against the scrim and capped at a warning.
- **Palette:** every concept colour must be within ΔE 25 of a brand colour, or be a neutral.
- **Logo:** present, a real asset, and inside the safe area.
- **Copy:** headline length for the format; a CTA for sales and lead-generation objectives.
- **Visual:** the visual exists, didn't fail, and isn't a demo placeholder. For carousels, 3–8
  slides.

**Vision review:** Claude looks at the rendered PNG against the approved profile, palette and
fonts, and returns a score, a summary, issues (blocking, warning or info, each with a fix) and
strengths.
- The check records which reviewer ran (`reviewer: anthropic | mock`, and the model). The UI
  labels demo reviews.
- `CREATIVE_BRAND_CHECK=off` skips the review, and the UI then says that only automated checks
  ran.

**Score** = the average of the vision score and the deterministic score. A failed check, or a
blocking review issue, sets `blocking`. Approving a blocked creative then needs **Approve anyway**,
which only admins and owners can do; it is recorded in brand memory. Any edit marks the check
**stale** until it is re-run.

## Strategy → creatives

On an **approved** strategy:
- **Create creative** on a calendar entry briefs the team with the entry's concept, hook, caption
  direction, CTA, pillar, objective and format. A carousel entry becomes a 5-slide carousel.
- **Produce creatives** batches up to 7 entries in one job.

Creatives keep `strategy_id` and `calendar_entry_id`. The calendar marks entries that have one,
and the entry dialog links to them. Campaign cards have a **Create creative** shortcut that
pre-fills the studio brief.

**Add to content calendar** (strategist) and **Add to calendar** (studio) attach the creative to
the draft post, with the caption and hashtags from its copy pack. An approved creative is
preferred over a draft.

## Costs

AI calls are recorded per agent run, including failed and retried attempts that the provider
reports usage for.
- **Text:** token usage, priced from `src/server/ai/pricing.ts`.
- **Images:** counted per generation (`images`, `imageModel`). Their price comes from
  configuration, never from a guess: `IMAGE_PRICE_USD_1024X1024`, `_1024X1536` and `_1536X1024`,
  or `IMAGE_PRICE_USD` for every size.
- **Unpriced images:** without a configured price, images are counted as `unpricedImages`.
- **Rejected keys:** a rejected key (401) records no image usage.
- **Job cost:** the job panel shows the cost so far, summed from that job's runs.

## Access and isolation

| Action | Minimum role |
|---|---|
| View the studio, creatives, renders and ZIPs | viewer (client users: only their brands) |
| Generate, edit, write copy, run checks, approve | editor |
| Approve anyway (blocking issues) | admin |

Every query is scoped by `brand_id`, and every action re-checks access on the server. A creative
id from another organisation returns 403 on the image and ZIP routes, and is not found in the
studio. Briefs, brand documents and calendar text are passed to models as data, never as
instructions.

## Real-provider integration status

Last run: 8 Nov 2026. The full plan is in `docs/CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`.

| Check | Status | Evidence |
|---|---|---|
| OpenAI rejects an invalid key: clear message, not retried as an outage, no image usage | **Verified against the real API** | `npm run test:live`: HTTP 401 → "The image service rejected the API key. Check OPENAI_API_KEY on the server." |
| Anthropic rejects an invalid key: clear message | **Verified against the real API** | `npm run test:live`: HTTP 401 → "The AI service rejected the API key. Check ANTHROPIC_API_KEY on the server." |
| OpenAI request format and response handling (`gpt-image-1`) | Verified with an intercepted request only | `creative-providers.test.ts` |
| Anthropic request format (vision review, copy) | Verified with an intercepted request only | `creative-providers.test.ts` |
| Real image generation from brand identity | **Not verified**: no OpenAI key | `test:live` reports `not_run` |
| Real image quality and brand consistency | **Not verified**: no OpenAI key | — |
| Real vision review and copy pack | **Not verified**: no Anthropic key | `test:live` reports `not_run` |
| Real token and image costs | **Not verified**: no keys | — |

Demo-mode results are never reported as real-provider results. The live suite refuses to run with
`AI_PROVIDER=mock` and reports a provider without a key as `not_run`, never as passed.

## Production deployment requirements

**Required:**
- `ANTHROPIC_API_KEY`: concepts, copy and the vision review.
- `APP_SECRET`.
- `DATABASE_URL` (Postgres with pgvector).
- A persistent `STORAGE_DIR`, or an S3/Supabase storage adapter.

**For AI images:**
- `OPENAI_API_KEY` (server-only).
- An OpenAI organisation with access to `gpt-image-1` (OpenAI may require organisation verification for it).
- Outbound HTTPS to `api.openai.com`.
- Set `IMAGE_PRICE_USD_<SIZE>` from your OpenAI price sheet, so image costs aren't shown as
  unpriced.

**Must not be set:** `AI_PROVIDER=mock` and `AI_ALLOW_MOCK_IN_PRODUCTION`. The app ignores the
mock in production without the second one.

**Timeouts:** image generation can take up to about 60–120 s per image. It runs in the background
job, so no request waits on it. The image request timeout is 180 s.

**Before launch:** run `npm run test:live` once with production keys (it costs about one image and
a few Claude calls), and keep its `report.json`.

## Known limitations

- **Real generation unverified:** real AI image generation, the real vision review and real
  copy haven't been run (no keys were available).
- **No offline use:** the PWA has a manifest and icons but no service worker, so the app needs a
  connection.
- **Slow first render:** the first render on a cold server takes several seconds while fonts load.
  The preview shows "Rendering…".
- **Image dimensions:** OpenAI returns 1024×1024, 1024×1536 or 1536×1024 images. The renderer
  crops them to the exact format size, so very wide or tall formats (banner, story, YouTube) crop
  more of the picture.
- **Slide visuals:** each AI slide visual is a separate image call, priced per image.

## Configuration

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `mock` = demo mode (ignored in production without `AI_ALLOW_MOCK_IN_PRODUCTION=true`) |
| `IMAGE_PROVIDER` | `openai` (default) or `none` |
| `OPENAI_API_KEY` | Enables AI images (server-only) |
| `OPENAI_IMAGE_MODEL` | Image model, default `gpt-image-1` |
| `IMAGE_PRICE_USD`, `IMAGE_PRICE_USD_<SIZE>` | Price per image, used for cost reporting |
| `CREATIVE_BRAND_CHECK` | `off` runs deterministic checks only |

## Tests

| File | Covers |
|---|---|
| `src/server/creative.test.ts` | jobs, carousels, JPEG/WebP brand photos rendered into the output, all 12 formats at exact size (single and carousel slides), storage cleanup, logo placement, quality maths, the approval gate, malformed edits, originality, recovery without duplicates, racing starts, strategy → post, isolation, and the 0006 upgrade |
| `src/server/ai-modes.test.ts` | demo mode never calls the image API even with a key; demo labelling; `IMAGE_PROVIDER=none`; production ignores a stray mock |
| `src/server/creative-providers.test.ts` | the OpenAI and Anthropic request paths (intercepted) and usage accounting |
| `src/server/creative-routes.test.ts` | image and ZIP routes with real sessions |
| `src/server/live/real-providers.live.ts` | **live, paid**: real image generation, renders in all formats, real vision review and copy, invalid-key handling. `npm run test:live` only; never in CI. |

Browser E2E (Playwright, desktop 1440 px, Pixel 7, iPad Mini, PWA standalone): screenshots in
`docs/screenshots/creative-studio/`. All of them were taken in **demo mode**, with synthetic
product photos.
