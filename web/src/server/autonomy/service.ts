import "server-only";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db/client";
import { audit } from "../audit";
import { log } from "../log";
import { envStops } from "../ai/controls";
import { DEFAULT_RULES, decide, effectiveLevel, isLevel, normaliseRules, type Action, type Context, type Decision, type Level, type Rules } from "./policy";

/**
 * Autonomy service (docs/AUTONOMY.md). Reads the brand, account, plan and switches, calls the pure
 * policy (policy.ts) and records what it decided in `agent_actions`.
 *
 * AUTONOMOUS_PUBLISHING (the platform switch) is **off** unless set to "on". Off, Autonomous can't
 * be chosen and a brand already set to it behaves as Assisted. For the private beta it stays off
 * until the owner authorises it (docs/PRIVATE_BETA_DECISIONS_REQUIRED.md D-28).
 */
type Env = Record<string, string | undefined>;
type Brand = typeof schema.brands.$inferSelect;
type Post = typeof schema.posts.$inferSelect;
type Account = typeof schema.socialAccounts.$inferSelect;

export class AutonomyError extends Error {}

export function autonomousAllowed(env: Env = process.env) {
  return (env.AUTONOMOUS_PUBLISHING ?? "").trim().toLowerCase() === "on";
}

/** The global AI stop (kill switch scope "all", from the environment or the database). */
export async function globalAiStopped(db?: Pick<DB, "select">, env: Env = process.env) {
  if (envStops(env).some((s) => s === "all" || s.startsWith("invalid:"))) return true;
  const d = db ?? (await getDb());
  const [row] = await d.select({ scope: schema.aiControls.scope }).from(schema.aiControls).where(eq(schema.aiControls.scope, "all")).limit(1);
  return Boolean(row);
}

async function planMax(db: Pick<DB, "select">, workspaceId: string): Promise<Level | null> {
  const [r] = await db.select({ features: schema.plans.features }).from(schema.workspaces).innerJoin(schema.plans, eq(schema.plans.key, schema.workspaces.plan)).where(eq(schema.workspaces.id, workspaceId));
  const v = r?.features?.maxAutonomy;
  return v == null ? null : isLevel(v) ? v : "assisted";
}

export function rulesOf(brand: Pick<Brand, "autonomyRules">): Rules {
  return normaliseRules(brand.autonomyRules);
}

export const contentHash = (p: Pick<Post, "caption" | "title" | "hashtags" | "creativeId">) =>
  crypto.createHash("sha256").update(JSON.stringify([p.title ?? "", p.caption ?? "", p.hashtags ?? [], p.creativeId ?? ""])).digest("hex").slice(0, 32);

/** Counters for one account around `at`: policy-approved posts the same UTC day, in the 7 days up to `at`, the nearest one, and AI posts already published (warm-up). */
async function counters(db: Pick<DB, "select">, accountId: string, at: Date, excludePostId: string) {
  const day0 = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day1 = new Date(day0.getTime() + 86400_000);
  const week0 = new Date(at.getTime() - 7 * 86400_000);
  const live = inArray(schema.posts.status, ["scheduled", "publishing", "published"]);
  const auto = and(eq(schema.posts.socialAccountId, accountId), isNotNull(schema.posts.autoApprovedVersion), live, ne(schema.posts.id, excludePostId));
  const rows = await db
    .select({ at: schema.posts.scheduledAt, publishedAt: schema.posts.publishedAt })
    .from(schema.posts)
    .where(and(auto, gte(schema.posts.scheduledAt, new Date(at.getTime() - 8 * 86400_000)), lt(schema.posts.scheduledAt, new Date(at.getTime() + 8 * 86400_000))));
  const times = rows.map((r) => (r.publishedAt ?? r.at)!).filter(Boolean);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(and(eq(schema.posts.socialAccountId, accountId), eq(schema.posts.origin, "ai"), eq(schema.posts.status, "published"), ne(schema.posts.id, excludePostId)));
  const lastAt = times.length ? times.reduce((best, t) => (Math.abs(t.getTime() - at.getTime()) < Math.abs(best.getTime() - at.getTime()) ? t : best)) : null;
  return {
    today: times.filter((t) => t >= day0 && t < day1).length,
    // Any 7-day window that contains this post: the busier side.
    week: Math.max(times.filter((t) => t > week0 && t <= at).length, times.filter((t) => t >= at && t.getTime() < at.getTime() + 7 * 86400_000).length),
    lastAt,
    autonomousSoFar: Number(n),
  };
}

/** Builds the policy context for a post, reading everything it needs. */
export async function contextFor(db: Pick<DB, "select">, brand: Brand, post: Post | null, account: Account | null, extra: Partial<Context> = {}, env: Env = process.env): Promise<Context> {
  const rules = rulesOf(brand);
  const at = post?.scheduledAt ?? undefined;
  return {
    platformAllowsAutonomous: autonomousAllowed(env),
    brandLevel: brand.autonomyLevel,
    accountLevel: account?.autonomyLevel ?? null,
    planMax: await planMax(db, brand.workspaceId),
    suspended: Boolean(brand.autonomySuspendedAt),
    paused: Boolean(brand.publishingPausedAt),
    aiStopped: await globalAiStopped(db, env),
    rules,
    rulesVersion: brand.autonomyRulesVersion,
    competitors: brand.competitors,
    origin: post?.origin,
    content: post ? { caption: post.caption ?? "", title: post.title, pillar: post.pillar, hashtags: post.hashtags } : undefined,
    complete: Boolean(post?.caption?.trim() && post?.creativeId && post?.socialAccountId && account && account.status === "active"),
    at,
    counters: account && post && at ? await counters(db, account.id, at, post.id) : undefined,
    approval: post ? (post.autoApprovedVersion != null ? "policy" : post.approvedAt ? "person" : "none") : undefined,
    ...extra,
  };
}

export async function record(
  db: Pick<DB, "insert">,
  e: { brand: Pick<Brand, "id" | "workspaceId">; post?: Post | null; accountId?: string | null; actorType: "user" | "agent" | "system"; actorUserId?: string | null; action: string; decision: Decision["result"] | "changed"; level: Level; reasons: string[]; policyVersion: number; details?: Record<string, unknown> },
) {
  await db.insert(schema.agentActions).values({
    workspaceId: e.brand.workspaceId,
    brandId: e.brand.id,
    postId: e.post?.id ?? null,
    socialAccountId: e.accountId ?? e.post?.socialAccountId ?? null,
    actorType: e.actorType,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    decision: e.decision,
    level: e.level,
    reasons: e.reasons.slice(0, 20).map((r) => r.slice(0, 500)),
    policyVersion: e.policyVersion,
    contentHash: e.post ? contentHash(e.post) : null,
    details: e.details ?? {},
  });
}

/** Thrown before the AI saves posts under Advisor, or while AI is stopped. */
export async function assertAiMayDraft(brandId: string, what: string) {
  const db = await getDb();
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
  if (!brand) throw new AutonomyError("Brand not found.");
  const d = decide("ai_draft", await contextFor(db, brand, null, null));
  if (d.result !== "allow") {
    await record(db, { brand, actorType: "agent", action: "ai_draft", decision: d.result, level: d.level, reasons: [...d.reasons, what], policyVersion: d.policyVersion });
    throw new AutonomyError(d.level === "advisor" ? `${brand.name} is set to Advisor: the AI suggests, and people create posts. Change the level in Settings → Autonomy to let the AI add drafts.` : d.reasons.join("; "));
  }
}

/**
 * The publish gate, called by publishPost inside the claim transaction (after the account row is
 * locked), immediately before anything is sent. A post the policy approved is checked again here:
 * a rule change, a lower level or a pause since scheduling stops it, and it goes back to a person.
 */
export async function publishGate(tx: DB, post: Post, account: Account | null, env: Env = process.env): Promise<Decision> {
  const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, post.brandId));
  if (!brand) return { result: "deny", reasons: ["Brand not found"], level: "assisted", policyVersion: 0 };
  const d = decide("publish", await contextFor(tx, brand, post, account, {}, env));
  if (post.autoApprovedVersion != null || d.result !== "allow") {
    await record(tx, { brand, post, accountId: account?.id, actorType: "agent", action: "publish", decision: d.result, level: d.level, reasons: d.reasons, policyVersion: d.policyVersion });
  }
  return d;
}

/**
 * One autonomy pass (from the scheduler tick): for brands whose effective level is Autonomous, the
 * AI's own complete draft posts are either scheduled by the policy (within the rules) or sent to a
 * person (pending approval, with the reasons). Nothing here sends anything: publishing is the
 * publish job, which checks again. Returns what it did.
 */
export async function autonomyTick(now = new Date(), env: Env = process.env) {
  if (!autonomousAllowed(env)) return { scheduled: 0, toPerson: 0 };
  const db = await getDb();
  const brands = await db.select().from(schema.brands).where(and(eq(schema.brands.autonomyLevel, "autonomous"), sql`${schema.brands.autonomySuspendedAt} is null`, sql`${schema.brands.publishingPausedAt} is null`));
  let scheduled = 0;
  let toPerson = 0;
  const { enqueue } = await import("../jobs/queue");
  for (const brand of brands) {
    const candidates = await db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.brandId, brand.id), eq(schema.posts.origin, "ai"), eq(schema.posts.status, "draft"), gte(schema.posts.scheduledAt, new Date(now.getTime() + 5 * 60_000))))
      .orderBy(schema.posts.scheduledAt)
      .limit(50);
    for (const post of candidates) {
      if (!post.caption?.trim() || !post.creativeId || !post.socialAccountId) continue; // not ready yet: leave as a draft
      const r = await db.transaction(async (tx) => {
        // Lock the account so parallel passes can't both use the last slot under a cap.
        await tx.execute(sql`select id from social_accounts where id = ${post.socialAccountId} for update`);
        const [acct] = await tx.select().from(schema.socialAccounts).where(and(eq(schema.socialAccounts.id, post.socialAccountId!), eq(schema.socialAccounts.brandId, brand.id)));
        const [fresh] = await tx.select().from(schema.posts).where(and(eq(schema.posts.id, post.id), eq(schema.posts.status, "draft")));
        if (!fresh) return null;
        const d = decide("auto_approve", await contextFor(tx as unknown as DB, brand, fresh, acct ?? null, {}, env));
        if (d.result === "allow") {
          await tx.update(schema.posts).set({ status: "scheduled", approvedAt: now, approvedBy: null, autoApprovedVersion: d.policyVersion }).where(eq(schema.posts.id, fresh.id));
        } else {
          await tx.update(schema.posts).set({ status: "pending_approval", rationale: [fresh.rationale, `Needs a person: ${d.reasons.join("; ")}`].filter(Boolean).join("\n") }).where(eq(schema.posts.id, fresh.id));
        }
        await record(tx, { brand, post: fresh, accountId: acct?.id, actorType: "agent", action: "auto_approve", decision: d.result, level: d.level, reasons: d.reasons, policyVersion: d.policyVersion });
        return { d, post: fresh };
      });
      if (!r) continue;
      if (r.d.result === "allow") {
        await enqueue("publish_post", { postId: r.post.id }, r.post.scheduledAt! < now ? now : r.post.scheduledAt!);
        scheduled++;
      } else toPerson++;
    }
  }
  if (scheduled || toPerson) log.info("autonomy.tick", { scheduled, toPerson });
  return { scheduled, toPerson };
}

/**
 * Automatic safeguard (§6.6): Autonomous falls back to Assisted for the brand, and policy-scheduled
 * posts that haven't gone out go back to a person. Owners re-enable it in Settings → Autonomy.
 */
export async function suspendAutonomy(brandId: string, reason: string) {
  const db = await getDb();
  const [brand] = await db
    .update(schema.brands)
    .set({ autonomySuspendedAt: new Date(), autonomySuspendedReason: reason.slice(0, 500) })
    .where(and(eq(schema.brands.id, brandId), eq(schema.brands.autonomyLevel, "autonomous"), sql`${schema.brands.autonomySuspendedAt} is null`))
    .returning();
  if (!brand) return false;
  const back = await db
    .update(schema.posts)
    .set({ status: "pending_approval", approvedAt: null, autoApprovedVersion: null })
    .where(and(eq(schema.posts.brandId, brandId), eq(schema.posts.status, "scheduled"), isNotNull(schema.posts.autoApprovedVersion)))
    .returning({ id: schema.posts.id });
  if (back.length) {
    const { cancelJobs } = await import("../jobs/queue");
    const ids = new Set(back.map((b) => b.id));
    await cancelJobs("publish_post", (j) => ids.has(String(j.postId)));
  }
  await record(db, { brand, actorType: "system", action: "suspend", decision: "changed", level: "assisted", reasons: [reason], policyVersion: brand.autonomyRulesVersion, details: { postsReturned: back.length } });
  await audit({ action: "autonomy.suspended", actorType: "system", workspaceId: brand.workspaceId, brandId, targetType: "brand", targetId: brandId, details: { reason, postsReturned: back.length } });
  log.warn("autonomy.suspended", { brandId, reason, postsReturned: back.length });
  return true;
}

export type AutonomySettings = { level: Level; rules: Rules; accounts: { id: string; level: Level | null }[] };

/** The settings view for a brand: levels, effective level, rules, switches and recent decisions. */
export async function autonomyView(brandId: string, env: Env = process.env) {
  const db = await getDb();
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
  if (!brand) throw new AutonomyError("Brand not found.");
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, brandId));
  const ctx = await contextFor(db, brand, null, null, {}, env);
  const recent = await db.select().from(schema.agentActions).where(eq(schema.agentActions.brandId, brandId)).orderBy(desc(schema.agentActions.createdAt)).limit(50);
  return {
    level: isLevel(brand.autonomyLevel) ? brand.autonomyLevel : ("assisted" as Level),
    effective: effectiveLevel(ctx),
    platformAllowsAutonomous: ctx.platformAllowsAutonomous,
    planMax: await planMax(db, brand.workspaceId),
    suspended: brand.autonomySuspendedAt ? { at: brand.autonomySuspendedAt.toISOString(), reason: brand.autonomySuspendedReason ?? "" } : null,
    paused: ctx.paused,
    aiStopped: Boolean(ctx.aiStopped),
    rules: rulesOf(brand),
    rulesVersion: brand.autonomyRulesVersion,
    accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, level: isLevel(a.autonomyLevel) ? a.autonomyLevel : null, effective: effectiveLevel({ ...ctx, accountLevel: a.autonomyLevel }) })),
    recent: recent.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), action: r.action, decision: r.decision, level: r.level, actorType: r.actorType, reasons: r.reasons, postId: r.postId, policyVersion: r.policyVersion })),
  };
}

/**
 * Changes the level, rules or account levels. Owner role and a recent second factor are checked by
 * the caller (autonomy action). Autonomous can't be chosen while the platform switch is off or the
 * plan doesn't allow it. Rules bump the version; before and after values are recorded and audited.
 */
export async function updateAutonomy(brandId: string, actor: { userId: string }, input: { level?: string; rules?: unknown; accounts?: { id: string; level: string | null }[] }, env: Env = process.env) {
  const db = await getDb();
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
  if (!brand) throw new AutonomyError("Brand not found.");
  const max = await planMax(db, brand.workspaceId);
  const wants = (l: Level) => l === "autonomous";
  const check = (l: Level) => {
    if (wants(l) && !autonomousAllowed(env)) throw new AutonomyError("Autonomous publishing isn't available yet: it stays off for the private beta until the platform owner enables it.");
    if (wants(l) && max && max !== "autonomous") throw new AutonomyError("Your plan doesn't include Autonomous publishing.");
  };
  const before = { level: brand.autonomyLevel, rules: rulesOf(brand), version: brand.autonomyRulesVersion, accounts: {} as Record<string, string | null> };
  const patch: Partial<typeof schema.brands.$inferInsert> = {};
  if (input.level !== undefined) {
    if (!isLevel(input.level)) throw new AutonomyError("Choose Advisor, Assisted or Autonomous.");
    check(input.level);
    patch.autonomyLevel = input.level;
    // Choosing a level again clears an automatic suspension (an owner has looked).
    patch.autonomySuspendedAt = null;
    patch.autonomySuspendedReason = null;
  }
  let rules: Rules | undefined;
  if (input.rules !== undefined) {
    rules = normaliseRules(input.rules);
    if (JSON.stringify(rules) !== JSON.stringify(before.rules)) {
      patch.autonomyRules = rules as unknown as Record<string, unknown>;
      patch.autonomyRulesVersion = brand.autonomyRulesVersion + 1;
    }
  }
  const accountChanges: { id: string; from: string | null; to: string | null }[] = [];
  if (input.accounts?.length) {
    const own = await db.select().from(schema.socialAccounts).where(and(eq(schema.socialAccounts.brandId, brandId), inArray(schema.socialAccounts.id, input.accounts.map((a) => a.id))));
    for (const a of input.accounts) {
      const acct = own.find((o) => o.id === a.id);
      if (!acct) throw new AutonomyError("That account isn't connected to this brand.");
      if (a.level !== null && !isLevel(a.level)) throw new AutonomyError("Choose a level for the account.");
      if (a.level) check(a.level);
      if ((acct.autonomyLevel ?? null) !== a.level) accountChanges.push({ id: a.id, from: acct.autonomyLevel ?? null, to: a.level });
    }
  }
  let returnedIds: string[] = [];
  const after = await db.transaction(async (tx) => {
    const [b] = Object.keys(patch).length ? await tx.update(schema.brands).set(patch).where(eq(schema.brands.id, brandId)).returning() : [brand];
    for (const c of accountChanges) await tx.update(schema.socialAccounts).set({ autonomyLevel: c.to }).where(and(eq(schema.socialAccounts.id, c.id), eq(schema.socialAccounts.brandId, brandId)));
    // Lowering below Autonomous: posts the policy scheduled go back to a person.
    let returned = 0;
    if (b.autonomyLevel !== "autonomous" || patch.autonomyRulesVersion) {
      const back = await tx
        .update(schema.posts)
        .set({ status: "pending_approval", approvedAt: null, autoApprovedVersion: null })
        .where(and(eq(schema.posts.brandId, brandId), eq(schema.posts.status, "scheduled"), isNotNull(schema.posts.autoApprovedVersion)))
        .returning({ id: schema.posts.id });
      returned = back.length;
      returnedIds = back.map((x) => x.id);
    }
    const changes = { level: [before.level, b.autonomyLevel], rulesVersion: [before.version, b.autonomyRulesVersion], accounts: accountChanges, postsReturned: returned };
    await record(tx, { brand: b, actorType: "user", actorUserId: actor.userId, action: "settings", decision: "changed", level: isLevel(b.autonomyLevel) ? b.autonomyLevel : "assisted", reasons: ["Changed by an owner"], policyVersion: b.autonomyRulesVersion, details: { before, after: { level: b.autonomyLevel, rules: rulesOf(b), version: b.autonomyRulesVersion }, ...changes } });
    return { brand: b, changes };
  });
  // Their publish jobs are cancelled after the commit (the queue uses its own connection); the
  // publish claim would refuse them anyway, since they're no longer scheduled.
  if (returnedIds.length) {
    const { cancelJobs } = await import("../jobs/queue");
    const ids = new Set(returnedIds);
    await cancelJobs("publish_post", (j) => ids.has(String(j.postId)));
  }
  await audit({ action: "autonomy.changed", workspaceId: brand.workspaceId, brandId, actorUserId: actor.userId, targetType: "brand", targetId: brandId, details: { level: `${before.level} → ${after.brand.autonomyLevel}`, rulesVersion: `${before.version} → ${after.brand.autonomyRulesVersion}`, accounts: accountChanges.length, postsReturned: after.changes.postsReturned } });
  return after.changes;
}

export { DEFAULT_RULES };
export type { Action };
