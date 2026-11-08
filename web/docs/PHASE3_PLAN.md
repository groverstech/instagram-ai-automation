# Phase 3 plan: AI Creative Studio and Content Generator

The roadmap order (`brand intelligence → strategist → creative studio and image generation → campaigns and calendar → …`)
puts the **AI Creative Studio with image generation, plus the per-creative content and caption generator** next
(spec sections 4 and 5). An MVP of both studios exists from the initial build. Phase 3 makes them
production-grade and connects them to the approved strategy from Phase 2.

## 1. Current state, and the gaps this phase closes

| Area | Today (MVP) | Gap against the spec |
|---|---|---|
| Generation | Concepts and images generated inside the HTTP request | No job tracking, recovery, retries or progress; images can time out |
| Image cost | Not recorded | No token, image or cost ledger for image generation |
| Visuals | AI image (gpt-image-1), or a typographic fallback | Can't use the brand's **own product photos**; one provider, hard-wired |
| Carousels | A single image | Multi-slide carousels are missing |
| Captions | A separate Content Studio, not tied to a creative | "For every creative, suggest captions, hooks, CTA, hashtags…" isn't met |
| Brand consistency | None | The spec asks for brand consistency monitoring |
| Strategy link | None | Creatives aren't produced from the approved strategy or calendar |
| Editing | Headline, subline, CTA and status | Per-slide text, layout, palette from brand colours, logo position, resize preview, ZIP download |

## 2. Scope and objectives

1. Generate brand-consistent creatives **reliably**: persistent background jobs with progress, recovery and retries,
   plus a cost ledger. This reuses the Phase 2 job engine.
2. Use real brand visuals where possible (approved product and reference photos). Use AI imagery when chosen, and
   never placeholder graphics presented as final.
3. Support **carousels** (3–8 slides) alongside single creatives.
4. Attach a **copy pack** to every creative, in the brand voice and adapted to the platform, with an originality guard.
5. Run a **Brand Consistency Check** on every creative: deterministic checks, plus a Claude vision review of the
   rendered image against the approved profile.
6. Produce creatives **from the approved strategy**: calendar entries and campaign concepts become briefs, and the
   creatives stay linked to them.
7. A polished, responsive studio for editing, resizing, comparing variations, approving and downloading.

Out of scope (later phases, per the roadmap): video/Reels generation, publishing changes, analytics, and campaign
manager changes beyond linking.

## 3. Features and modules

| Module | Where | What |
|---|---|---|
| M1 Creative jobs | `src/server/jobs/engine.ts` (extracted from the strategist workflow), `src/server/creative/jobs.ts` | The job engine is generalised with handlers by kind (`strategy_*`, `creative_batch`). Steps: concepts → per creative: visual → copy → brand check. Idempotent steps (rows stamped with `task_id`), atomic claim, recovery after restart, retry with backoff, and admission once (quota, rate limit, slot). |
| M2 Visual sources | `src/server/ai/image.ts`, `src/server/creative/visuals.ts` | Provider registry: `openai` (gpt-image-1, existing), `brand_photo` (an approved product or reference asset; no AI image), `typographic`. Image calls are logged as agent runs with `usage.images` and cost from configurable per-image prices. Unconfigured means "unpriced", shown honestly. |
| M3 Carousels | concept schema, renderer, ZIP route | A `slides[]` array (cover + 2–7 slides) with per-slide headline and body text. Cover visual, with optional per-slide visuals. Each slide renders separately (`?slide=n`), and all slides download as one ZIP. |
| M4 Copy pack | `src/server/creative/copy.ts` | The Copywriter agent writes, per creative: primary, alternatives, short, long, hooks, CTA, hashtags, keywords and platform variants. Editable and regenerable. The originality guard checks n-gram similarity against the brand's recent captions and a list of banned clichés, retrying once and flagging what remains. |
| M5 Brand check | `src/server/creative/brand-check.ts` | Deterministic checks: WCAG contrast of text against its background, palette distance from the brand colours, logo present and inside the safe area, text length per format, CTA present. A Claude **vision** review of the rendered PNG against the approved profile returns a score, issues (blocking, warning or info) and suggested fixes. Approving a creative with blocking issues needs an explicit "approve anyway" from an admin. |
| M6 Strategy → creative | strategist calendar and campaigns, studio | "Create creative" on a calendar entry or campaign concept pre-fills the brief (hook, concept, caption direction, pillar, objective, platform → format). "Produce this week" batches up to 7 entries. Creatives keep `strategy_id` and `calendar_entry_id`, and "Add to content calendar" attaches the creative and copy to the draft post. |
| M7 Studio UX | `src/components/creative/*` | A generation form (visual source, slides, logo position), a live job progress panel, a slide navigator, per-slide editing, a layout switcher, brand-palette swatches, logo position, a resize preview across formats, PNG and ZIP download, copy pack and brand check tabs, and a side-by-side variation comparison. Desktop and mobile. |

## 4. Architecture and database changes

- **Job engine:** the strategist's persistent-job code (claim token, heartbeat, recovery, backoff, admission once,
  cost refresh) moves to a generic engine. Strategist behaviour and its tests stay unchanged.
- **Migration `0006_creative_studio`** (additive):
  - `creatives`: `kind` (single|carousel), `slides` jsonb, `copy` jsonb, `brand_check` jsonb, `visual_source`,
    `source_asset_id`, `logo_placement`, `strategy_id`, `calendar_entry_id`, `task_id`, `updated_at`; indexes on
    `task_id` and `strategy_id`.
  - `posts.creative_id` already exists and gets filled from strategy-linked creatives.
- **Cost ledger:** image generation and vision calls go through `runAgent`, so they appear in `agent_runs` with
  `task_id`. Image usage is `{ images, imageModel, imageSize }`. Images are priced from env, or marked unpriced.
- **Renderer:** Satori (`next/og`) as today. Slides, logo placement and safe areas are added. Output stays PNG.
- **Isolation:** every new route, action and job is brand-scoped through `requireBrand` / `requireBrandForUser`. Asset
  sources must belong to the same brand and be approved.

## 5. UI/UX improvements

Creative Studio:
- A grid with status, brand-check score and kind badges, and filters (status, kind, campaign or strategy).
- A detail drawer with tabs: Preview (slides, resize preview) · Edit · Copy · Brand check · Variations.
- A job progress panel that keeps working across navigation and restarts.

Strategist:
- A "Create creative" button on each calendar entry and campaign card, and a "Produce this week" batch action.
- Linked creative thumbnails on calendar entries.

Throughout:
- The existing visual language, explicit labels for AI-generated versus brand-photo visuals, and honest
  states ("No image provider configured", "Unpriced").

## 6. Dependencies and external APIs

- **No new npm dependencies.** `jszip`, `next/og` and `sharp` are already present.
- **Anthropic** (existing): concepts, copy packs and the vision brand check (image input).
- **OpenAI Images** (existing, optional): `gpt-image-1` behind the provider registry.
- New optional env:
  - `IMAGE_PRICE_USD_<SIZE>`: per-image price, for cost estimates.
  - `IMAGE_PROVIDER` (existing).
  - `CREATIVE_BRAND_CHECK=off`: disables the vision check.

## 7. Security considerations

- Keys stay server-side; the client-bundle secret check is extended to the new env names.
- Brand assets used as visuals must be approved and belong to the brand. Uploaded SVG logos are already sanitised
  (scripts rejected); the renderer only embeds stored files, never remote URLs.
- Prompt injection: brand assets, brief text and calendar entries are passed to models as data, with the existing
  guard wording.
- Rate limits: creative jobs are admitted as `ai_heavy`; rendering uses the existing `render` limit; ZIP downloads are
  capped (≤ 8 slides, each format).
- Image provider moderation and refusals become friendly errors, with no raw payloads.
- Downloads and previews require brand access. Signed public media links (the existing mechanism) are only for publishing.
- Client (brand-scoped) users see only their brands' creatives. Viewers can't generate or approve.

## 8. Testing and acceptance criteria

Automated:
- Job engine refactor: all Phase 2 strategist tests stay green.
- Creative batch end to end (mock provider), plus recovery after a dead worker without regenerating finished creatives
  or images, retries, and lost-claim protection.
- Real SDK path with network intercepted:
  - The OpenAI image request shape, and storage of the image.
  - The Claude vision request, which must include the rendered PNG.
  - The copy-pack schema.
  - The ledger: image counts and costs, with unpriced handling.
- Carousel rendering for every slide, and ZIP contents.
- Deterministic brand checks: contrast maths, palette distance, logo safe area.
- The originality guard.
- Strategy → creative linking, and attaching to draft posts.
- Isolation: other brands, other organisations and client scope can't reach creatives, renders or ZIPs.
- The full existing suite stays green; typecheck, lint, build and the secret check pass.

Browser (production build): desktop and Pixel 7, with screenshots of every new feature:
- generate from the studio and from a calendar entry
- the carousel
- edit and resize
- the copy pack
- the brand check
- download
- approve
- a client user's view

Acceptance:
1. A user can produce single and carousel creatives in the brand's colours, fonts and logo placement, using brand
   photos or AI imagery, and download PNG or ZIP.
2. Every creative has an editable copy pack in the brand voice, adapted to its platform.
3. Every creative has a brand check score with actionable issues. Blocking issues prevent a silent approval.
4. Approved strategy calendar entries can be turned into linked creatives, and their posts carry the creative.
5. Generation survives a server restart, with no duplicate creatives or images, and cost is recorded.
6. No regression: all existing tests pass, and the existing pages work on desktop and mobile.
