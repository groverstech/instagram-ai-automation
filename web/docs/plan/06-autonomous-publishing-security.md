# 6. Autonomous publishing security architecture

**Decision:**
- Three autonomy levels: **Advisor**, **Assisted** and **Autonomous**.
- **Human approval stays the default.**
- The brand owner controls publishing permissions, content categories, frequency, schedules,
  budget and an emergency pause.

## 6.1 Autonomy levels

| Level | The AI may… | A human must… | Default |
|---|---|---|---|
| **Advisor** | Analyse, recommend and draft suggestions (not saved as posts) | Create, approve, schedule and publish | — |
| **Assisted** | Create creatives and copy, and fill the calendar and schedule as **drafts awaiting approval** | Approve each post; nothing publishes unapproved | **Yes, for every new brand** |
| **Autonomous** | Publish without per-post approval, **only** for content matching the brand's rules (§6.2), on allowed accounts, within caps | Opt in explicitly (owner); review the daily digest; can pause instantly | Off; opt-in per brand **and** per social account |

The level is set per brand. A social account can be held below the brand's level (for example,
Autonomous on Instagram but Assisted on LinkedIn). An account can never be set above the brand's
level, and a brand never above what the organisation's plan allows (document 5).

## 6.2 Brand rules (owner-controlled)

| Control | Options |
|---|---|
| Publishing permissions | Who can approve (roles or named users); which accounts allow Autonomous; whether client users must also approve |
| Content categories | Allowed pillars and campaigns. **Restricted categories always need human approval, at any level:** prices and promotions, legal or health claims, competitor mentions, crisis or sensitive topics, giveaways. Plus the brand's own banned-topics list. |
| Frequency | Maximum autonomous posts per account per day and per week; a minimum gap between posts |
| Schedules | Allowed time windows and days; blackout dates (holidays, launches, incidents) |
| Quality gates | Minimum brand-check score; no blocking issues; originality pass; only approved brand assets; a link domain allow-list |
| Budget | Maximum credits per month for autonomous work; it stops at the cap (document 5) |
| Warm-up | The first N posts per account under Autonomous still need approval (default 5) |
| Emergency pause | Brand-level and organisation-level switches (§6.5) |

Rules are versioned. Every decision records the rule version it used.

## 6.3 Policy engine

```
decide(action, context) → { result: allow | require_approval | deny, reasons[], policyVersion }
  action:  generate | schedule | publish | edit_published | delete_published
  context: org/brand/account, autonomy levels, rules, content (category, scores, links, assets),
           counters (posts today, credits used), pause flags, time, actor (user | agent)
```

- **Pure and deterministic.** No model output decides a policy question. A model can propose
  content; only this function decides whether it may be published.
- **Evaluated at every gate:**
  1. when an agent proposes content;
  2. when it's scheduled;
  3. **again in the publish worker immediately before the platform API call**, inside the same
     transaction that claims the publish attempt.

  The third check closes the gap between check and use: a rule change or a pause after
  scheduling still stops the publish.
- **Fails closed.** Any error, missing data or unknown category results in `require_approval`, or
  `deny` for publish when paused.
- **Agents act through the same server actions as people,** with the same role checks, tenant
  scoping, rate limits and credit reservations. An agent identity is a service principal bound to
  one brand, with the minimum role needed (editor). It can never change rules, roles, billing or
  connections.

## 6.4 Threat model and mitigations

| Threat | Mitigation |
|---|---|
| **Prompt injection** (competitor pages, comments or documents steer an agent to post something harmful) | External text is passed as data; the policy engine, not the model, gates publishing; restricted categories need a human; a link domain allow-list; a moderation check on outgoing copy |
| **Hallucinated claims** (wrong price, false product claim) | Prices, promotions and claims are restricted categories (always human); a brand facts allow-list for numbers; the brand check flags unverifiable claims |
| **Runaway posting** (loop or bug) | Frequency caps checked in the publish transaction; a global per-account rate limit; anomaly auto-pause (§6.6) |
| **Double publish** (retry or crash) | Publish-attempt ledger with an idempotency key per post and account; reconciliation reads the platform before retrying (P4-3) |
| **Compromised user session** | Changing autonomy or rules needs the **owner** role plus **step-up re-authentication**; owners are emailed on every change; changes are audited |
| **Malicious insider (editor)** | Editors can't raise autonomy or edit rules; the approver can't be the same user as the creator when "four-eyes" is enabled |
| **Token theft** | Platform tokens are encrypted (AES-256-GCM) and decrypted only in the publish worker; least-privilege scopes; revoked on disconnect; key rotation |
| **Cross-tenant action** | Every action is scoped by organisation and brand server-side; the agent principal is bound to one brand; storage prefix checks (document 4) |
| **Cost runaway** | Credit reservations and hard caps (document 5); the autonomous budget cap |
| **Platform penalties** (spam, policy strikes) | Platform rate limits respected (headers); platform content policies in moderation checks; auto-pause on a platform error spike |
| **Webhook spoofing** | Signature verification and replay windows for platform and Stripe webhooks |

## 6.5 Emergency pause

- **Where:** a one-click **Pause publishing** for the brand or the whole organisation, from the
  header and on mobile. The platform admin also has a global kill switch.
- **Effect, immediate:**
  - the pause flag is set and checked in the publish transaction, so in-flight workers stop before
    the API call;
  - scheduled posts move to `paused` (not deleted);
  - agents stop proposing publishes.
- **Resume:** owner only, with the list of what will publish next shown first.
- **Optional retract:** for already-published posts, a human can delete or archive them where the
  platform allows. It is never automatic.

## 6.6 Monitoring and automatic safeguards

**Auto-pause Autonomous** for a brand (fall back to Assisted) and notify owners when:
- the platform returns policy or permission errors;
- the publish failure rate spikes;
- engagement drops sharply against the baseline, or negative comment sentiment spikes (when
  comment access is enabled);
- the credit cap is reached;
- the social account token expires.

**Daily digest to owners:** what was published autonomously, why it was allowed (rule version and
reasons), and its results.

## 6.7 Audit

**`agent_actions`** (append-only) records, for every action:
- actor (user or agent principal) and action;
- target, content hash and inputs summary;
- the policy decision, reasons and policy version;
- credits, outcome and timestamps.

**Visibility:** owners and admins can see and export it; retention is configurable (default
2 years). Rule and autonomy changes are logged with before and after values.

## 6.8 Tests and acceptance

- **Decision table:** every level × action × category × pause × caps combination has an expected
  result. A property test checks that nothing is ever `allow` for publish while paused.
- **Check in the worker:** change the rules or pause between schedule and publish, and nothing
  publishes.
- **Concurrency:** parallel workers never exceed the frequency caps or double-publish.
- **End to end:** Autonomous on a test account publishes allowed content only; restricted content
  waits for approval; pause stops an in-flight batch.
- **Acceptance:** 2 weeks on test accounts (one brand Assisted, one Autonomous) with **zero**
  unapproved restricted posts, zero duplicates and zero cap overruns.
