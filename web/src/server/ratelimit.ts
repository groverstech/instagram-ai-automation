import "server-only";
import { and, eq, gt, lt, sql, count } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { log } from "./log";
import type { PlanId } from "@/lib/plans";

/**
 * Rate limiting and AI concurrency control.
 *
 * Counters live in Postgres (fixed windows, atomic upsert), so limits hold across all app
 * instances. Concurrency uses short-lived leases guarded by a per-organisation advisory lock.
 * A coarse per-IP limiter in middleware.ts sits in front of everything and answers HTTP 429.
 */

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfter: number,
  ) {
    super(message);
  }
}

export type LimitKind = "ai" | "ai_heavy" | "upload" | "render" | "login" | "cron_auth";
type Scope = "user" | "org" | "key";
type Rule = { scope: Scope; limit: number; windowSec: number };

/** Requests per window. "ai_heavy" = brand analysis, campaigns, strategy, asset analysis. */
export const RULES: Record<LimitKind, Rule[]> = {
  ai: [
    { scope: "user", limit: 30, windowSec: 60 },
    { scope: "user", limit: 300, windowSec: 3600 },
    { scope: "org", limit: 90, windowSec: 60 },
  ],
  ai_heavy: [
    { scope: "user", limit: 6, windowSec: 600 },
    { scope: "org", limit: 20, windowSec: 600 },
  ],
  upload: [
    { scope: "user", limit: 20, windowSec: 600 },
    { scope: "org", limit: 60, windowSec: 600 },
  ],
  render: [{ scope: "user", limit: 600, windowSec: 60 }],
  login: [{ scope: "key", limit: 10, windowSec: 900 }],
  /** Failed cron authentications per client IP (successful calls are not counted). */
  cron_auth: [{ scope: "key", limit: 10, windowSec: 900 }],
};

/** Simultaneously running AI tasks. */
export const CONCURRENCY = {
  perUser: 2,
  perOrg: { starter: 2, growth: 4, agency: 10 } as Record<PlanId, number>,
  leaseSec: 600,
};

export type Subject = { userId?: string; workspaceId?: string; key?: string };

const MESSAGES: Record<LimitKind, string> = {
  ai: "You're sending AI requests too quickly.",
  ai_heavy: "Too many brand analyses or campaign generations in a short time.",
  upload: "Too many uploads in a short time.",
  render: "Too many image renders in a short time.",
  login: "Too many sign-in attempts.",
  cron_auth: "Too many failed cron authentication attempts.",
};

function retryText(sec: number) {
  return sec < 90 ? `${sec} seconds` : `${Math.ceil(sec / 60)} minutes`;
}

/** Count this request against every rule for `kind`; throws RateLimitError when any is exceeded. */
export async function enforce(kind: LimitKind, subject: Subject, now = new Date()) {
  const db = await getDb();
  for (const rule of RULES[kind]) {
    const id = rule.scope === "user" ? subject.userId : rule.scope === "org" ? subject.workspaceId : subject.key;
    if (!id) continue;
    const windowMs = rule.windowSec * 1000;
    const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const key = `${kind}:${rule.scope}:${rule.windowSec}:${id}`;
    const [row] = await db
      .insert(schema.rateLimitBuckets)
      .values({ key, windowStart: start, count: 1 })
      .onConflictDoUpdate({
        target: [schema.rateLimitBuckets.key, schema.rateLimitBuckets.windowStart],
        set: { count: sql`${schema.rateLimitBuckets.count} + 1` },
      })
      .returning({ count: schema.rateLimitBuckets.count });
    if (row.count > rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000));
      log.warn("ratelimit.exceeded", { kind, scope: rule.scope, windowSec: rule.windowSec, limit: rule.limit, subject: rule.scope === "key" ? "redacted" : id });
      throw new RateLimitError(`${MESSAGES[kind]} Please try again in ${retryText(retryAfter)}.`, retryAfter);
    }
  }
  if (Math.random() < 0.01) {
    await db.delete(schema.rateLimitBuckets).where(lt(schema.rateLimitBuckets.windowStart, new Date(now.getTime() - 86_400_000))).catch(() => {});
  }
}

/**
 * Take a concurrency lease. Throws RateLimitError when the user or the organisation already has
 * the maximum number of AI tasks running. Release it with releaseAiSlot; long background work
 * renews it with renewAiSlot so a crashed worker's lease still expires.
 */
export async function acquireAiSlot(subject: { userId: string; workspaceId: string; plan: PlanId }, kind: string, leaseSec: number = CONCURRENCY.leaseSec): Promise<string> {
  const db = await getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    // Serialise lease checks per organisation so concurrent requests can't both slip through.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"ai-lease:" + subject.workspaceId}))`);
    await tx.delete(schema.aiTaskLeases).where(and(eq(schema.aiTaskLeases.workspaceId, subject.workspaceId), lt(schema.aiTaskLeases.expiresAt, now)));
    const active = and(eq(schema.aiTaskLeases.workspaceId, subject.workspaceId), gt(schema.aiTaskLeases.expiresAt, now));
    const [{ n: orgN }] = await tx.select({ n: count() }).from(schema.aiTaskLeases).where(active);
    const [{ n: userN }] = await tx.select({ n: count() }).from(schema.aiTaskLeases).where(and(active, eq(schema.aiTaskLeases.userId, subject.userId)));
    const orgMax = CONCURRENCY.perOrg[subject.plan] ?? CONCURRENCY.perOrg.starter;
    if (userN >= CONCURRENCY.perUser || orgN >= orgMax) {
      log.warn("ratelimit.concurrency", { workspaceId: subject.workspaceId, userId: subject.userId, userN, orgN, orgMax });
      throw new RateLimitError(
        userN >= CONCURRENCY.perUser
          ? "You already have AI tasks running. Wait for them to finish, then try again."
          : "Your organisation already has the maximum number of AI tasks running. Please try again shortly.",
        15,
      );
    }
    const [lease] = await tx
      .insert(schema.aiTaskLeases)
      .values({ workspaceId: subject.workspaceId, userId: subject.userId, kind, expiresAt: new Date(now.getTime() + leaseSec * 1000) })
      .returning({ id: schema.aiTaskLeases.id });
    return lease.id;
  });
}

export async function renewAiSlot(leaseId: string, leaseSec: number = CONCURRENCY.leaseSec) {
  const db = await getDb();
  await db.update(schema.aiTaskLeases).set({ expiresAt: new Date(Date.now() + leaseSec * 1000) }).where(eq(schema.aiTaskLeases.id, leaseId)).catch(() => {});
}

export async function releaseAiSlot(leaseId: string) {
  const db = await getDb();
  await db.delete(schema.aiTaskLeases).where(eq(schema.aiTaskLeases.id, leaseId)).catch(() => {});
}

/** Run an AI task inside a concurrency lease (see acquireAiSlot). */
export async function withAiSlot<T>(subject: { userId: string; workspaceId: string; plan: PlanId }, kind: string, fn: () => Promise<T>): Promise<T> {
  const leaseId = await acquireAiSlot(subject, kind);
  try {
    return await fn();
  } finally {
    await releaseAiSlot(leaseId);
  }
}
