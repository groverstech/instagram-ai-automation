# AI Creative Studio and Content Generator

The Creative Studio turns a brief, or an entry in the approved strategy's calendar, into on-brand
social creatives: a concept, a visual, platform copy and a brand consistency check. Nothing is
published automatically. Every creative is a draft until someone approves it.

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

## Visual sources

| Source | What it does | When available |
|---|---|---|
| AI image | Generates an image from the concept's art direction (`gpt-image-1`) | `OPENAI_API_KEY` set and `IMAGE_PROVIDER` not `none` |
| Brand photo | Uses the brand's **approved** product/reference/creative/post photos (PNG, JPEG, WebP), chosen or rotated | At least one approved photo in My Brand → Assets |
| Type-led | Brand colours and typography, no photo | Always |

The studio shows an unavailable source as disabled, with the reason. Brand photos are copied into
the creative's storage and normalised: EXIF orientation is applied, the size is capped at 2048 px,
and WebP is stored as PNG, because the renderer can't decode WebP. A photo from another brand, or
one that isn't approved, is refused.

## Rendering

`src/server/creative/render.tsx` composes the creative with Satori (`next/og`) from the brand's
fonts, palette and logo:
- **Layouts:** hero overlay, split, frame, typographic, editorial column and product badge.
- **Logo:** placed in a chosen corner inside a safe area of 72 px at 1080 px (≈6.7% of the short side), or hidden. When no logo asset is
  uploaded, the brand name is set as text.
- **Text colour:** text on brand colours picks a contrast-safe colour.
- **Carousels:** the cover plus 2–7 inner slides, with a slide counter, "Swipe" on the inner
  slides and the CTA on the last one.
- **Routes:**
  - `GET /api/creatives/:id/image?format=&slide=&download=1` renders one slide in any format.
  - `GET /api/creatives/:id/zip?format=` returns every slide plus `caption.txt`.

  Both need viewer access to the brand and count against the render rate limit.

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
- **Visual:** the visual exists and didn't fail. For carousels, 3–8 slides.

**Vision review:** Claude looks at the rendered PNG against the approved profile, palette and
fonts, and returns a score, a summary, issues (blocking, warning or info, each with a fix) and
strengths. `CREATIVE_BRAND_CHECK=off` skips the review, and the UI then says that only automated
checks ran.

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
- **Images:** counted per generation (`images`, `imageModel`). Their price comes from
  configuration, never from a guess: `IMAGE_PRICE_USD_1024X1024`, `_1024X1536` and `_1536X1024`,
  or `IMAGE_PRICE_USD` for every size.
- **Unpriced images:** without a configured price, images are counted as `unpricedImages`.
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

## Configuration

| Variable | Purpose |
|---|---|
| `IMAGE_PROVIDER` | `openai` (default) or `none` |
| `OPENAI_API_KEY` | Enables AI images (server-only) |
| `OPENAI_IMAGE_MODEL` | Image model, default `gpt-image-1` |
| `IMAGE_PRICE_USD`, `IMAGE_PRICE_USD_<SIZE>` | Price per image, used for cost reporting |
| `CREATIVE_BRAND_CHECK` | `off` runs deterministic checks only |

## Tests

| File | Covers |
|---|---|
| `src/server/creative.test.ts` | jobs, carousels, JPEG/WebP brand photos rendered into the output, logo placement, quality maths, the approval gate, malformed edits, originality, recovery without duplicates, racing starts, strategy → post, isolation, and the 0006 upgrade |
| `src/server/creative-providers.test.ts` | the real OpenAI and Anthropic request paths (intercepted) and usage accounting |
| `src/server/creative-routes.test.ts` | image and ZIP routes with real sessions |
