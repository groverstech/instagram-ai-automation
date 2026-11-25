/**
 * Autonomy policy engine (docs/plan/06-autonomous-publishing-security.md §6.3).
 *
 * Pure and deterministic: no model output and no I/O decide a policy question. A model can propose
 * content; only `decide` says whether it may be published without a person. It fails closed: any
 * missing data or unknown value gives `require_approval` (or `deny` where publishing is refused).
 *
 * Levels (per brand; an account can be held lower, never higher):
 *   advisor     the AI analyses and suggests; it never creates posts and never publishes.
 *   assisted    the AI creates drafts; a person approves every post (the default).
 *   autonomous  the AI may schedule and publish its own posts **only** within the brand's rules,
 *               and only when the platform switch (AUTONOMOUS_PUBLISHING) allows it.
 * The emergency pause and the AI kill switch override every level.
 */

export const LEVELS = ["advisor", "assisted", "autonomous"] as const;
export type Level = (typeof LEVELS)[number];
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);
const rank: Record<Level, number> = { advisor: 0, assisted: 1, autonomous: 2 };
export const minLevel = (...ls: Level[]): Level => ls.reduce((a, b) => (rank[b] < rank[a] ? b : a));

/** Content that always needs a person, at every level (§6.2). */
export const RESTRICTED = ["prices_promotions", "giveaways", "health_legal_claims", "competitor_mentions", "sensitive_topics", "banned_topics", "links"] as const;
export type Restricted = (typeof RESTRICTED)[number];

export type Rules = {
  /** Autonomous posts per account per UTC day and per rolling 7 days. */
  maxPerDay: number;
  maxPerWeek: number;
  /** Minimum hours between autonomous posts on one account. */
  minGapHours: number;
  /** UTC hours (0–23) and weekdays (0 = Sunday) when autonomous posts may go out. */
  allowedHours: number[];
  allowedDays: number[];
  /** The first N autonomous-eligible posts per account still need a person (warm-up). */
  warmup: number;
  /** Pillars allowed for autonomous posts; empty means any pillar. */
  allowedPillars: string[];
  /** Words or phrases that always need a person, in addition to the restricted categories. */
  bannedTopics: string[];
  /** Link domains that may appear in autonomous captions; any other link needs a person. */
  linkDomains: string[];
};

export const DEFAULT_RULES: Rules = {
  maxPerDay: 1,
  maxPerWeek: 5,
  minGapHours: 4,
  allowedHours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  allowedDays: [1, 2, 3, 4, 5],
  warmup: 5,
  allowedPillars: [],
  bannedTopics: [],
  linkDomains: [],
};

const ints = (v: unknown, lo: number, hi: number) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isInteger(x) && x >= lo && x <= hi))].sort((a, b) => a - b) : null);
const strs = (v: unknown, max = 50) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, max) : null);
const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Stored rules merged over the defaults; anything malformed falls back to the (strict) default. */
export function normaliseRules(raw: unknown): Rules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    maxPerDay: int(r.maxPerDay, 0, 10) ?? DEFAULT_RULES.maxPerDay,
    maxPerWeek: int(r.maxPerWeek, 0, 50) ?? DEFAULT_RULES.maxPerWeek,
    minGapHours: int(r.minGapHours, 0, 168) ?? DEFAULT_RULES.minGapHours,
    allowedHours: ints(r.allowedHours, 0, 23) ?? DEFAULT_RULES.allowedHours,
    allowedDays: ints(r.allowedDays, 0, 6) ?? DEFAULT_RULES.allowedDays,
    warmup: int(r.warmup, 0, 50) ?? DEFAULT_RULES.warmup,
    allowedPillars: strs(r.allowedPillars) ?? DEFAULT_RULES.allowedPillars,
    bannedTopics: strs(r.bannedTopics, 200) ?? DEFAULT_RULES.bannedTopics,
    linkDomains: strs(r.linkDomains) ?? DEFAULT_RULES.linkDomains,
  };
}

const PATTERNS: [Restricted, RegExp][] = [
  ["prices_promotions", /[$€£¥₹]\s?\d|\d\s?(%|percent)|\b(sale|discount|promo(tion)?|coupon|voucher|deal|offer|price[sd]?|pricing|free shipping|bogo|clearance|black friday|cyber monday)\b/i],
  ["giveaways", /\b(giveaway|give away|contest|competition|sweepstakes?|raffle|win (a|an|the)|winner)\b/i],
  ["health_legal_claims", /\b(cure[sd]?|heal[s]?|treat(s|ment)?|prevent[s]?|clinically|proven|guarantee[sd]?|fda|medical|doctor|diagnos\w*|weight loss|lose weight|legal(ly)?|lawsuit|certified|risk[- ]free|100% safe)\b/i],
  ["sensitive_topics", /\b(politic\w*|election|vote|religio\w*|war|tragedy|disaster|shooting|crisis|death|died|suicide|abortion|racis\w*|lawsuit)\b/i],
];

export type Content = { caption: string; title?: string | null; pillar?: string | null; hashtags?: string[] };

/** Restricted categories found in the content (deterministic keyword rules; unknown → nothing). */
export function classify(content: Content, ctx: { competitors?: string[]; rules: Rules }): { restricted: Restricted[]; detail: string[] } {
  const text = [content.title ?? "", content.caption, ...(content.hashtags ?? [])].join("\n");
  const lower = text.toLowerCase();
  const restricted = new Set<Restricted>();
  const detail: string[] = [];
  for (const [cat, re] of PATTERNS) {
    const m = text.match(re);
    if (m) {
      restricted.add(cat);
      detail.push(`${cat}: "${m[0]}"`);
    }
  }
  for (const c of ctx.competitors ?? []) {
    const name = c.trim().toLowerCase();
    if (name.length >= 3 && lower.includes(name)) {
      restricted.add("competitor_mentions");
      detail.push(`competitor_mentions: "${c}"`);
    }
  }
  for (const t of ctx.rules.bannedTopics) {
    if (t && lower.includes(t)) {
      restricted.add("banned_topics");
      detail.push(`banned_topics: "${t}"`);
    }
  }
  const links = [...text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?/gi)].map((m) => m[1].toLowerCase()).filter((d) => !/\.(png|jpe?g|gif)$/.test(d));
  for (const d of links) {
    const ok = ctx.rules.linkDomains.some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
    if (!ok) {
      restricted.add("links");
      detail.push(`links: ${d}`);
    }
  }
  return { restricted: [...restricted], detail };
}

export type Action =
  /** The AI saves posts to the calendar (planning, strategy → calendar). */
  | "ai_draft"
  /** The AI moves its own post to scheduled without a person's approval. */
  | "auto_approve"
  /** The publish worker is about to send a post (re-checked immediately before the API call). */
  | "publish";

export type Context = {
  /** AUTONOMOUS_PUBLISHING: the platform switch. Off, Autonomous behaves as Assisted. */
  platformAllowsAutonomous: boolean;
  brandLevel: Level | string | null | undefined;
  /** Null: follow the brand. */
  accountLevel?: Level | string | null;
  /** The plan's highest level, if it sets one. */
  planMax?: Level | string | null;
  /** Autonomous suspended automatically (token error, failures): behaves as Assisted until an owner re-enables it. */
  suspended: boolean;
  paused: boolean;
  aiStopped?: boolean;
  rules: Rules;
  rulesVersion: number;
  competitors?: string[];
  /** For publish: who approved. "person": a human approval is recorded; "policy": auto-approved. */
  approval?: "person" | "policy" | "none";
  content?: Content;
  /** Autonomous posts on this account: published today (UTC), in the last 7 days, the last one's time. */
  counters?: { today: number; week: number; lastAt: Date | null; autonomousSoFar: number };
  /** When the post would go out. */
  at?: Date;
  /** For publish: the post has a creative, an account and a caption. */
  complete?: boolean;
  origin?: "ai" | "human" | string | null;
};

export type Decision = { result: "allow" | "require_approval" | "deny"; reasons: string[]; level: Level; policyVersion: number };

/** The level that applies after every cap: plan, platform switch, suspension and the account's own setting. */
export function effectiveLevel(ctx: Pick<Context, "platformAllowsAutonomous" | "brandLevel" | "accountLevel" | "planMax" | "suspended">): Level {
  const brand: Level = isLevel(ctx.brandLevel) ? ctx.brandLevel : "assisted"; // unknown → the default
  const caps: Level[] = [brand];
  if (ctx.accountLevel != null) caps.push(isLevel(ctx.accountLevel) ? ctx.accountLevel : "assisted");
  if (ctx.planMax != null) caps.push(isLevel(ctx.planMax) ? ctx.planMax : "assisted");
  if (!ctx.platformAllowsAutonomous || ctx.suspended) caps.push("assisted");
  return minLevel(...caps);
}

export function decide(action: Action, ctx: Context): Decision {
  const policyVersion = Number.isInteger(ctx.rulesVersion) ? ctx.rulesVersion : 0;
  let level: Level;
  try {
    level = effectiveLevel(ctx);
  } catch {
    return { result: action === "publish" ? "deny" : "require_approval", reasons: ["policy error: failing closed"], level: "assisted", policyVersion };
  }
  const out = (result: Decision["result"], ...reasons: string[]): Decision => ({ result, reasons, level, policyVersion });

  if (action === "ai_draft") {
    if (ctx.aiStopped) return out("deny", "AI is stopped (kill switch)");
    if (level === "advisor") return out("deny", "Advisor level: the AI suggests, people create posts");
    return out("allow", `${level} level: the AI may save drafts`);
  }

  // Publishing: the emergency pause overrides every level.
  if (ctx.paused) return out("deny", "Publishing is paused for this brand");

  if (action === "publish") {
    if (ctx.approval === "person") return out("allow", "Approved by a person");
    if (ctx.approval !== "policy") return out("deny", "No recorded approval");
    // Auto-approved earlier: everything is checked again now (rules, level or pause may have changed).
  }

  // auto_approve, or publish of a post the policy approved.
  if (level !== "autonomous") return out("require_approval", `${level} level: a person approves every post`);
  if (ctx.aiStopped) return out("require_approval", "AI is stopped (kill switch)");
  if (ctx.origin !== "ai") return out("require_approval", "Only posts the AI created can be approved by the policy");
  if (!ctx.complete) return out("require_approval", "The post is incomplete (creative, account or caption missing)");
  const c = ctx.content;
  if (!c || !c.caption?.trim()) return out("require_approval", "No caption to check");
  const reasons: string[] = [];
  const { restricted, detail } = classify(c, { competitors: ctx.competitors, rules: ctx.rules });
  if (restricted.length) reasons.push(`Restricted content needs a person: ${detail.join("; ")}`);
  if (ctx.rules.allowedPillars.length && !ctx.rules.allowedPillars.includes((c.pillar ?? "").trim().toLowerCase())) reasons.push(`Pillar "${c.pillar ?? "none"}" isn't allowed for autonomous posts`);
  const at = ctx.at;
  if (!at || Number.isNaN(at.getTime())) reasons.push("No publish time");
  else {
    if (!ctx.rules.allowedHours.includes(at.getUTCHours())) reasons.push(`${at.getUTCHours()}:00 UTC is outside the allowed hours`);
    if (!ctx.rules.allowedDays.includes(at.getUTCDay())) reasons.push("That day isn't allowed for autonomous posts");
  }
  const k = ctx.counters;
  if (!k) reasons.push("Posting counters unavailable");
  else {
    if (k.autonomousSoFar < ctx.rules.warmup) reasons.push(`Warm-up: the first ${ctx.rules.warmup} posts on this account need a person (${k.autonomousSoFar} so far)`);
    // Counters include posts already scheduled by the policy, so caps hold at both gates.
    if (k.today >= ctx.rules.maxPerDay) reasons.push(`Daily cap reached (${k.today}/${ctx.rules.maxPerDay})`);
    if (k.week >= ctx.rules.maxPerWeek) reasons.push(`Weekly cap reached (${k.week}/${ctx.rules.maxPerWeek})`);
    if (k.lastAt && at && Math.abs(at.getTime() - k.lastAt.getTime()) < ctx.rules.minGapHours * 3600_000) reasons.push(`Less than ${ctx.rules.minGapHours} h since another autonomous post`);
  }
  if (reasons.length) return out("require_approval", ...reasons);
  return out("allow", `Within the brand's rules (version ${policyVersion})`);
}
