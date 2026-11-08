# Creative Studio: real AI provider integration and test plan

**Goal:** before production, validate the Creative Studio against the **real** providers: OpenAI for
images and Anthropic Claude for concepts, copy and the vision review. Validate generation, quality,
brand consistency, error handling, retries, and cost and usage tracking.

**Status (8 Nov 2026):**
- Only the invalid-key checks have run against the real APIs. Both passed.
- Everything else in this plan is **not yet run**: no provider keys were available in the test
  environment.

Mock (demo-mode) results never count towards this plan.

## 1. Preconditions

| Item | Detail |
|---|---|
| Keys | `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, set as server environment variables or secrets. Never in client code, never in the repository, never pasted into chats or tickets. |
| OpenAI access | The organisation can use `gpt-image-1` (OpenAI may require organisation verification). |
| Network | Outbound HTTPS to `api.openai.com` and `api.anthropic.com`. Behind an HTTPS proxy without direct DNS, run Node with `NODE_USE_ENV_PROXY=1`. |
| Pricing config | `IMAGE_PRICE_USD_1024X1024`, `_1024X1536` and `_1536X1024`, from the current OpenAI price sheet for the quality the app requests (`high`). |
| Mode | `AI_PROVIDER` unset (not `mock`); `IMAGE_PROVIDER=openai`. |
| Budget | Set a monthly spend limit on both provider dashboards before testing. The full plan uses roughly 40 images and 150 Claude calls; check the actual cost against the dashboards (§6). |
| Data | A test workspace and brand with: an approved brand profile, 3 brand colours, heading and body fonts, a logo, and 3 approved product photos. |

## 2. Automated live suite (`npm run test:live`)

`src/server/live/real-providers.live.ts`, run with `vitest.live.config.ts`. It is never part of
`npm test` or CI.

```bash
cd web
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… IMAGE_PRICE_USD_1024X1536=… \
LIVE_REPORT_DIR=./live-report npm run test:live
```

**Guarantees:**
- It refuses to run with `AI_PROVIDER=mock`.
- A provider without a key is reported `not_run`, never passed.
- After the run, every output file is scanned for the key values, and the run fails if one
  appears.

| ID | Test | Pass criteria | Last result |
|---|---|---|---|
| L1 | Real AI creative via the background job (Claude concept → OpenAI image) | Job `succeeded`; `image_provider` = `openai:gpt-image-1`; the stored image is 1024×1536 for a 4:5 post; `agent_runs` records `images ≥ 1`, `imageModel`, and a cost or an unpriced count; the dominant colour's ΔE to the brand palette is reported | not_run (no keys) |
| L2 | The real image rendered in all 12 formats | Each PNG is exactly the format's size; files are written to the report | not_run (no keys) |
| L3 | Claude vision review of the rendered creative | `reviewer.provider = anthropic`; no "[Demo]"; input tokens > 500 (the image is included); cost > 0 | not_run (no key) |
| L4 | Claude copy pack | Real text (no "[Demo]"), more than 40 characters, hashtags present, cost > 0, originality result recorded | not_run (no key) |
| L5 | OpenAI with an invalid key | HTTP 401 → "The image service rejected the API key…"; not treated as a temporary outage; no image usage | **passed** (real API) |
| L6 | Anthropic with an invalid key | HTTP 401 → "The AI service rejected the API key…" | **passed** (real API) |

## 3. Manual end-to-end runs in the app (browser)

Run on a production build (`npm run build && npm start`) with real keys, on desktop and on a
phone or the installed PWA. Capture screenshots, and check that no key appears in any screenshot,
page source, network response or server log (§7).

| ID | Scenario | Expected |
|---|---|---|
| M1 | Studio → AI image, 2 variations, Instagram post, sales objective | Job progress; 2 creatives with real images; copy and a brand check on each; cost shown on the job panel |
| M2 | AI carousel, 5 slides, "A visual on every slide" | 5 images (1 cover + 4 slides); ZIP contains 5 PNGs and `caption.txt` |
| M3 | Brand photo creative, then switch the visual source to AI image | The old photo file is removed; the new AI image is stored; the brand check is marked stale |
| M4 | Regenerate image ×2 | Two more image runs recorded and priced; the previous files are removed |
| M5 | Each of the 12 formats: Resize → PNG download | Exact size, sensible crop of the subject, logo inside the safe area, text legible |
| M6 | Calendar → Produce creatives (3 entries, AI image) | 3 linked creatives; the calendar shows the links; "Add to content calendar" carries the creative and its copy |
| M7 | Variation with a direction ("warmer light, closer crop") | A new image that visibly follows the direction |
| M8 | Brand check with the real review | Specific issues and fixes that refer to the actual image; the model name is shown; no "demo" label |
| M9 | Client (viewer) user | Can view and download; can't generate (actions refused server-side) |

## 4. Image quality and brand consistency evaluation

For a sample of **12 AI creatives** (3 styles × 4 briefs, 2 of them carousels), two reviewers
score each one from 1 to 5:

| Criterion | What "5" means |
|---|---|
| Brief fidelity | Shows the product or scene the brief describes |
| Brand palette | The image's colour mood matches the brand colours (also measured: the dominant colour's ΔE to the palette, reported by L1) |
| Style fidelity | Matches the chosen style (e.g. premium editorial vs bold and vibrant) |
| Composition for the layout | Leaves room for text where the layout puts it; the subject isn't cropped by the format |
| Artefacts | No text, letters or fake logos in the image; no distorted products, hands or faces |
| Legibility on the final render | The headline, subline and CTA read clearly over the image (WCAG checks pass) |
| Overall on-brand | "Would publish with minor or no edits" |

**Pass:** average ≥ 3.5 per criterion, and no creative with artefacts at 1. Compare the reviewers'
overall score with the vision review's score: they should agree within ±15 points on at least 9
of the 12.

**Brand typography and logo** aren't produced by the image model. The renderer sets them from the
brand's fonts and logo asset. Check them visually on every format in M5.

## 5. Error handling and retries

| ID | Inject | Expected |
|---|---|---|
| E1 | Invalid OpenAI key | Clear message; creative `image_error` set; no image usage (**verified by L5**) |
| E2 | Invalid Anthropic key | Clear message (**verified by L6**) |
| E3 | Content-policy refusal (a prompt the provider declines) | "The image service declined this prompt…" shown on the creative; not retried; no image usage |
| E4 | OpenAI 429 (rate limit) | Retried once in the call, then the job retries with backoff (30 s·2ⁿ, up to 3 attempts); the user sees "Retrying automatically" |
| E5 | Network drop mid-request (block the host during a generation) | No HTTP status → the call is counted as `unknownUsageAttempts` (possibly billed), never as free; the job retries |
| E6 | Kill the server during a batch | After about 2 minutes the job resumes; finished creatives and visuals aren't regenerated; costs equal the sum of the runs |
| E7 | Request timeout (180 s) | Treated like E5 |
| E8 | Very long brief, or text in other languages and scripts | Valid output; the image has no rendered text |

E4, E5 and E7 can be forced against the real API with an HTTPS proxy that drops or delays
connections. The code paths are also covered by intercepted-request tests
(`creative-providers.test.ts`).

## 6. Costs and usage reconciliation

1. Before the run, note the provider dashboards' usage for the test project (or use a dedicated
   key).
2. Run L1–L4 and M1–M8.
3. Compare:
   - **Claude:** the sum of `agent_runs.usage` input and output tokens against the Anthropic
     console's tokens for the key and period. They should match within the console's rounding.
   - **Images:** the count of `usage.images` against OpenAI's image count, and the sum of
     `imageCostUsd` against OpenAI's billed amount.
   - **Retries:** the per-job cost (`ai_tasks.cost_usd`) equals the sum of its runs. Failed and
     retried attempts that the provider billed are included; unknown-usage attempts are listed
     separately.
4. Record any difference over 5% and its cause.

## 7. Security checks

- `npm run check:secrets` passes on the production build: no key names or values in client
  bundles.
- Keys are visible in no page source, network response, screenshot, ZIP, `report.json` or job
  error message. The live suite scans its own outputs for the key values.
- Server logs at the default level contain no request headers. Search the logs for the first 8
  characters of each key: no hits.
- Provider error bodies are never shown to users; only the mapped messages are
  (`friendlyAIError`).
- Rotate both keys after the test campaign if they were shared with testers.

## 8. Exit criteria for production

- L1–L6 pass with production keys, and `report.json` is archived.
- M1–M9 pass on desktop and mobile, with screenshots archived.
- The quality evaluation (§4) meets its pass bar.
- Costs reconcile within 5% (§6).
- E3–E7 behave as specified.
- Security checks pass (§7).
