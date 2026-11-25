# Autonomy levels: Advisor, Assisted, Autonomous

This implements product decision 3 (8 Nov) and the design in [plan/06-autonomous-publishing-security.md](plan/06-autonomous-publishing-security.md).

**Private-beta defaults:**
- Every brand starts at **Assisted**, so a person approves every post.
- **Autonomous is off** (`AUTONOMOUS_PUBLISHING` unset). It can't be chosen, and a brand stored at Autonomous works as Assisted.
- Turning it on needs the owner's explicit authorisation: decision **D-28**.

## Levels

| Level | The AI may | A person must |
|---|---|---|
| **Advisor** | Analyse, recommend and suggest (Strategist, Advisor chat, AI copy suggestions) | Create, approve, schedule and publish. The AI planners refuse to add posts (calendar planning, campaign planning, "add the strategy's calendar") |
| **Assisted** (default) | Plan and create drafts | Approve every post before it is scheduled or published |
| **Autonomous** | Schedule and publish **its own** posts (`origin = ai`), but only within the brand's rules | Opt in (owner, with step-up). Review the decision log. Can pause instantly |

**What caps the level:**
- Each social account can be held **below** the brand's level, never above it.
- The plan can cap the level through `plans.features.maxAutonomy`.
- With the platform switch off, or while Autonomous is suspended, the effective level is at most Assisted.

**What always wins:**
- The **emergency pause** overrides every level.
- The **AI kill switch** (`all` scope) does too: the AI creates nothing and approves nothing.

## The policy engine

`src/server/autonomy/policy.ts`:
- `decide(action, context)` returns `allow`, `require_approval` or `deny`, with reasons and the rules version.
- It is pure and deterministic: no model output decides whether something is published.
- It fails closed: missing counters, time or content give `require_approval`.

**Restricted content always needs a person, at every level.** It is detected by deterministic keyword rules:
- prices and promotions;
- giveaways;
- health or legal claims;
- competitor mentions (from the brand's competitor list);
- sensitive topics;
- the brand's banned topics;
- links outside the allowed domains.

**Brand rules** (versioned; every decision records the version):
- posts per account per day and per week;
- the minimum gap between posts;
- allowed UTC hours and weekdays;
- warm-up: the first N AI posts per account need a person (default 5);
- allowed pillars;
- banned topics;
- link domains.

The defaults are strict: 1 a day, 5 a week, 4 hours apart, weekdays 08:00–19:00 UTC, warm-up 5.

## Where it is checked

1. **AI drafting** (`assertAiMayDraft`):
   - Calendar planning, campaign planning and applying a strategy's calendar are refused under Advisor or while AI is stopped.
   - The check runs before any AI call, so nothing is spent.
2. **Scheduler tick** (`autonomyTick`, from the jobs tick):
   - It looks at brands whose effective level is Autonomous and at the AI's own **complete** drafts: caption, creative and active account.
   - Each draft is either scheduled by the policy (`auto_approved_version` set, publish job queued) or sent to a person (`pending_approval`, with the reasons in the post's rationale).
   - The account row is locked, so parallel passes can't exceed a cap.
3. **Publish claim** (`publishGate`, inside `publishPost`):
   - It runs in the same transaction that claims the post, with the account row locked, immediately before anything is sent.
   - A post the policy approved is checked again in full: level, rules, content, caps and pause. If it no longer qualifies, it goes back to a person, unsent.
   - A post a person approved is allowed unless paused.

## Safeguards and audit

- **Automatic suspension** (`suspendAutonomy`):
  - Triggers: a failed autonomous publish, a rejected token, or an expired token.
  - Effect: the brand falls back to Assisted, policy-scheduled posts return to a person, and their jobs are cancelled.
  - It is audited as `autonomy.suspended`. Choosing the level again (owner) clears it.
- **Changing the level, rules or account levels:**
  - Owner only, with a recent second factor.
  - The before and after values are recorded in `agent_actions` and audited as `autonomy.changed`.
  - A new rules version, or a level below Autonomous, returns policy-scheduled posts to a person.
- **`agent_actions`** (migration 0021):
  - Append-only by the application.
  - Records every AI drafting refusal, auto-approval decision, publish-gate decision of a policy-approved post, suspension and settings change, with the content hash, reasons and rules version.
  - It is under the RLS pilot policy.
  - It is shown in Settings → Autonomy → Decision log (owners and admins).
- **Calendar:** a post approved by the policy says so in its panel ("Approved by this brand's autonomy rules (version N), not by a person"). AI-planned posts are labelled.

## Tests

- **`autonomy-policy.test.ts`:**
  - the decision table (levels, caps, restricted content, schedule, warm-up, pillars, fail-closed);
  - a property check: 600 combinations and 500 random contexts, and nothing is ever allowed to publish while paused.
- **`autonomy.test.ts`:** end to end on the **simulated platform** (`SOCIAL_SANDBOX`):
  - the switch off;
  - Advisor refusals;
  - Assisted drafts waiting;
  - Autonomous scheduling and publishing allowed content through the ledger, while restricted content and people's posts wait;
  - pause overriding a scheduled post;
  - rule changes at publish time;
  - caps under three parallel passes;
  - warm-up;
  - an account held at Assisted;
  - suspension on an expired token;
  - the decision log.

## Not built (owner decision or later)

- Daily digest email to owners (needs the email provider, D-7).
- Org-wide pause (the brand pause exists).
- Four-eyes approval.
- Engagement-drop and sentiment auto-pause (needs comment access).
- The two-week acceptance run on test accounts (needs real test accounts and D-28).
