# AI Marketing Strategist (Phase 2)

The strategist turns a brand's **approved** Brand Intelligence Profile into a complete, versioned
marketing strategy: market research, audience personas, objectives, a 13-part strategy, 4–8 content
pillars, campaign concepts and a 30-day content calendar. A Marketing Advisor answers questions about
it. Everything is editable, every section can be regenerated on its own, and approved strategies
are locked.

## Workflow

| Step | Where | What happens |
|---|---|---|
| 1. Select organisation & brand | Wizard step 1 | Agencies can switch client here; the account type defaults from the workspace (creator → influencer, agency → agency client, else business). |
| 2. Retrieve the profile | Wizard step 2, server preflight | Generation is **blocked** without an approved profile. A newer unapproved draft is ignored and the user is told. |
| 3. Review objectives | Wizard step 3 | Business objectives, goals/targets, platforms, start date, cadence, campaign types. |
| 4. Collect missing info | Wizard step 4 | Gaps (offer, audience, market, differentiation, targets, conversion, competitors) become questions. Critical ones must be answered or explicitly assumed; assumptions are stored and shown. |
| 5–10. Generate | Background task | Research → audience → objectives → strategy → pillars → campaigns → calendar, each step saved as it finishes. |
| 11. Review | Workspace | Edit, regenerate sections, approve personas/pillars/campaigns, submit for review, request revisions. |
| 12. Save approved strategy | Approve | Locks the version; earlier approved versions are archived (superseded). The calendar can then be added to the content calendar as drafts. |

## Agents (`src/server/strategist/agents.ts`)

All agents read the brand context first (`buildContext`: approved profile, standing instructions,
approved assets, retrieved memories) plus the user's brief and the earlier sections. Each returns
Zod-validated structured output; ids, approval flags and verification are added server-side.

| Agent | Output | Notes |
|---|---|---|
| A. Market Research | industry overview, findings, competitors, open questions | Two calls: Claude with the `web_search` server tool (max 8 searches), then a structured pass listing the actual search results. See *Evidence* below. |
| B. Audience Intelligence | segments, 2–4 personas, insights | Demographics carry a basis (brand data / research / assumption). Personas start unapproved. |
| Objectives | business → marketing objectives | Targets are marked `user_target` or `suggested`. |
| C. Marketing Strategy | executive summary, positioning, differentiation, channels, content, campaign, engagement and lead-gen strategy, KPIs, roadmap, assumptions, risks | Adapted to the account type. Channels limited to selected platforms. |
| D. Content Pillars | 4–8 pillars | Count validated (retry if outside the range); shares normalised to 100%. |
| E. Campaign Ideation | 3–5 concepts | Seasonal, launch, promotional, awareness, engagement, evergreen. |
| F. Content Planning | 30-day calendar | Generated in two halves (output-size limits). Entries outside the window or on unselected platforms are dropped, and repeated hooks/concepts across platforms are rejected; the notes say how many were removed. |
| G. Marketing Advisor | chat | Uses the approved strategy (or says it's using a draft), the profile and memory. Stored in `assistant_messages` channel `strategy`. |

The 13 strategy parts map to sections: 1, 5–13 in *strategy*; 2–3 in *objectives*; 4 in *audience*.

## Evidence: verified research vs hypotheses

- A finding is **verified** only if it cites a URL that the web search tool actually returned in
  that run. The server checks this (`verifyResearch`). The model's own label isn't trusted.
- Cited URLs that weren't in the results are stripped and counted (`unmatchedUrls`).
- Unverified findings containing figures (%, currency, "million"…) are flagged in the UI.
- Sources keep URL, title, the search result's `page_age` (publication date when available) and
  the retrieval time.
- If web search is off (`STRATEGIST_WEB_SEARCH=off`), unavailable for the API key, or the mock
  provider is active, research runs in `no_search` mode. Every finding is then a hypothesis, and the
  UI says plainly that no web research was performed.
- Users can reword or remove findings but cannot mark anything verified or add sources.

## Data model (migration `0004_ai_marketing_strategist`)

- `strategies` (extended): `schema_version` (1 = legacy monthly, 2 = strategist), per-brand
  `version`, `status` (`draft` · `under_review` · `approved` · `archived`), `rev` (optimistic
  concurrency), `parent_id`, `revision_note`, `created_by` / `submitted_by` / `approved_by` /
  `approved_at` / `archived_at`, `updated_at`. Existing rows are backfilled with version numbers.
- `strategy_revisions`: append-only history. Each AI generation, edit, status change and restore
  stores the source, action, sections touched, actor and a full restorable snapshot.
- `ai_tasks`: background work with per-step status, heartbeat, tokens, web searches, estimated
  cost and error.
- `agent_runs`: adds `model`, `cost_usd`, `attempts`.
- `workspace_members.brand_ids`: null = all brands; otherwise a client user's brand scope.

The document (`src/lib/strategy.ts`) stores each section in an envelope:
`{ data, origin: ai|user|mixed, generatedAt, runId, provider, editedAt, editedBy, stale }`.
Regenerating or editing a section flags its downstream sections as possibly stale.

## Approval and versions

- Every write goes through `mutate()` (`store.ts`): row lock, brand check, status check, `rev`
  check, then a revision row.
- Approved and archived strategies are read-only. *Revise as new version* copies the approved
  version into a new draft; the approved version stays active until the new one is approved.
- Editing an approved persona, pillar or campaign removes its approval.
- User edits are blocked while an AI task is running on the strategy.
- Compare: field-level diff between any two versions or revisions. Restore: put an earlier
  revision back into an editable version (recorded as a new revision).
- Roles: viewer reads and asks the advisor; editor generates, edits and submits; admin/owner
  approves items and strategies, requests revisions and archives.

## Background processing, retries, costs, limits

- `startTask` admits work synchronously (plan quota → `ai_heavy` rate limit → concurrency lease
  held for the task, 15 min, renewed by heartbeats), then runs it after the response with
  Next.js `after()`.
- Each step re-reads the strategy and saves its section when done. A failed step stops the task.
  Completed sections are kept, and **Resume** generates only what's missing.
- A task with no heartbeat for 10 minutes (server restart) is reported as interrupted.
- Retries: one retry with backoff on unusable output (truncated, invalid JSON, wrong shape,
  invalid pillar count, unusable calendar) and on transient API errors (429/5xx/network). The SDK
  also retries HTTP failures itself. Auth, config and refusal errors are not retried.
- Cost is an **estimate** from token usage and web searches (`src/server/ai/pricing.ts`). It is
  shown per strategy and stored per run and task.
- Logs carry ids, agent names and error messages, never prompts, brand content or keys.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STRATEGIST_WEB_SEARCH` | on | Set `off` to disable web research (findings become hypotheses). |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_PRICE_WEB_SEARCH_PER_1K` | list prices | Override cost estimates. |

Web search runs on Anthropic's side, so it needs no extra egress from the app. It must be
available for the API key's organisation; if it isn't, research degrades to hypotheses and says so.

## Testing

- `src/server/strategist.test.ts` (mock provider, 17 tests): preflight, profile retrieval, full
  workflow, section regeneration and staleness, strict edits, calendar operations, the
  review/approve/version/restore/compare flow, apply-to-calendar, organisation and client-brand
  isolation, agency multi-client, retries and resumable failures, interrupted tasks, rate limits
  and concurrency, research verification, migration upgrade.
- `src/server/strategist-claude.test.ts` (real SDK, network intercepted, 5 tests): web search
  request shape, the approved profile in the prompt, source verification against real result
  blocks, publication dates, token/cost tracking, fallback when web search is unavailable, the
  retry on truncated output, and outage handling.
- **Not verified:** the quality of real Claude output and a live web search. Those need a real
  `ANTHROPIC_API_KEY` (see the go-live checklist in `DEPLOYMENT.md`). Mock output is labelled
  "Demo AI output" in the UI and is never presented as real AI.

## Known limitations

- Background tasks run inside the web process. A restart interrupts a running task; it is then
  shown as interrupted and can be resumed. There is no queue-based worker for strategist tasks yet.
- The calendar is generated in two halves; very high cadences (>~25 posts per half) may be trimmed.
- Client (brand-scoped) access is configured per member with one brand in the UI; the API
  supports several.
- Token usage of failed attempts isn't added to cost estimates.
