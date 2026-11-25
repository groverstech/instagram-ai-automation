# 8. Estimated development effort and external costs

> **Estimates, not quotes.** Third-party prices are list prices as understood in Nov 2026 and
> change often. Confirm each one on the vendor's pricing page before budgeting.

## 8.1 Engineering effort

| Package | Eng-weeks | Notes |
|---|---|---|
| P4-0a App-review prerequisites | 1–1.5 | Legal text is supplied by you or your counsel |
| P4-0b Operations baseline | 2 | |
| P4-0c Real-provider validation | 0.5 | Once credentials are configured |
| P4-1 Storage and CDN (R2) | 2.5–3 | |
| P4-2 Plans, credits, spend controls | 3–4 | Includes the admin cost dashboard |
| P4-3a Publishing core + Instagram + Facebook | 3–4 | Includes carousel, Reels and Stories |
| P4-3b LinkedIn organisations | 1.5–2 | After approval |
| P4-3c YouTube | 2 | After the video pipeline and approvals |
| P4-4 Approvals and collaboration | 2–3 | |
| P4-5 Analytics and attribution | 3 | |
| P4-6 Autonomy and policy engine | 3–4 | |
| P4-7 Learn and optimise | 3–4 | |
| P4-8 Video pipeline | 3–4 | Plus a provider pilot |
| P4-9 Scale and launch hardening | 2–3 | |
| **Total** | **31–39** | About 3½–4½ months with 3 engineers; plus about 15% for reviews, fixes and platform feedback |

Engineering cost is effort × your blended rate. That rate isn't set here.

**Calendar risk** comes from platform reviews, not engineering:
- Meta: typically 2–6 weeks including business verification.
- LinkedIn Community Management API: weeks.
- Google OAuth verification plus the YouTube audit: weeks to months.

They overlap with development if submitted early (P4-0a first).

## 8.2 External costs: one-off

| Item | Estimate | Notes |
|---|---|---|
| Legal: privacy policy, terms, DPA, AI and data disclosures | $2k–10k | Depends on jurisdictions served |
| Penetration test before launch | $5k–25k | Scope: web app, API, OAuth flows, tenant isolation |
| Platform developer accounts and reviews (Meta, LinkedIn, Google) | $0 in fees *(verify)* | Staff time for verification and screencasts |
| Google CASA assessment | Not expected | Only needed for *restricted* scopes; the YouTube scopes used are *sensitive* *(verify at submission)* |
| Video provider pilot | $100–1,000 | Generation credits for the evaluation |

## 8.3 External costs: monthly (early production, about 100–500 organisations)

| Service | Estimate per month | Basis |
|---|---|---|
| App and worker hosting (containers) | $100–600 | 2–4 app instances plus 2–4 workers (render, publish, AI jobs) |
| Managed Postgres with pgvector, pooling and PITR | $50–400 | Grows with metrics and ledger volume (document 9) |
| Cloudflare R2 | Storage ≈ $0.015 per GB-month; Class A ops ≈ $4.50/M; Class B ≈ $0.36/M; **egress $0** *(verify)* | 1 TB ≈ $15/month storage |
| Cloudflare CDN | Included with the domain; paid plans if WAF or advanced rules are needed | |
| Image transformations (optional) | Per unique transformation after a free allowance *(verify)* | Can be done with sharp in workers instead |
| Video (if managed) | Per minute stored and delivered (e.g. Cloudflare Stream) *(verify)* | Or FFmpeg in workers (compute only) |
| Transactional email | $0–100 | |
| Error tracking and tracing | $0–200 | Free tiers at first |
| Uptime and status page | $0–50 | |
| Stripe | Card processing about 2.9% + $0.30 (US; varies by country) plus Stripe Billing fees *(verify)* | On revenue, not fixed |
| **Fixed subtotal (excluding AI)** | **About $300–1,500 per month** | |

## 8.4 AI provider costs (variable; controlled by credits)

- **Target:** AI provider cost of about **15–20% of subscription revenue**. Enforced by the credit
  allowances (document 5, §5.7), the per-organisation USD hard caps, and the admin margin
  dashboard.
- **Unit economics on Claude Opus 5.5** at list price ($4 input / $20 output per MTok; cache reads
  $0.20; Batch API 50% off):
  - copy pack ≈ $0.05–0.07;
  - brand-check review ≈ $0.03–0.06;
  - full strategy run ≈ $1–3.
- **Images (`gpt-image-1`):** priced per image by size and quality. Check OpenAI's current price
  sheet; high-quality portrait images have historically been around $0.25 each. Image quality per
  plan is the main lever.
- **Video:** depends on the chosen provider (P4-8); priced per second generated.

**Illustration only.** A plan at price P with a 18% target funds P × 0.18 of provider cost per
month. The allowance is converted to credits at the configured credit value. Real allowances should
come from measured averages after the first month of `usage_events`.

## 8.5 Later platforms

| Platform | Cost note |
|---|---|
| TikTok | No API fee expected; an audit is required *(verify)* |
| X | Paid API tiers with changing prices and limits *(verify before committing)* |
