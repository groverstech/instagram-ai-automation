import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { log } from "../log";
import { provider } from "./registry";
import type { AccountForUse } from "./types";
import { isTokenError } from "./types";

/**
 * Publish-attempt ledger, reconciliation and token health (PR 4.4a; docs/plan/PHASE4_PLAN.md WS3).
 *
 * Every attempt to publish a post gets a `publish_attempts` row before anything is sent. If the
 * platform's answer never arrives (timeout, network, server error, or the worker stops), the attempt
 * stays `sending` or becomes `unknown`, and the post can't be published again until a check settles
 * it: `reconcilePost` reads the platform (`findRecentPost`) and either finds the post (published) or
 * confirms it isn't there (safe to publish again). Platforms without that read are settled by a
 * person ("It went out" / "It didn't go out"). So a post is never sent twice by BrandPilot.
 */

export type Attempt = typeof schema.publishAttempts.$inferSelect;

/** An attempt that may have gone out and hasn't been checked. */
export const isUnsettled = (a: Pick<Attempt, "status"> | null | undefined) => a?.status === "sending" || a?.status === "unknown";

/** Prefix of an attempt error written when a check found the post isn't on the platform. */
export const CHECKED_ABSENT = "Checked: not on the platform";

/**
 * How long after an attempt started before a check is meaningful: the platform may still be
 * processing a request that arrived. Interrupted attempts are found by the worker after 10 minutes.
 */
export const RECONCILE_DELAY_MS = 2 * 60 * 1000;

export async function latestAttempt(postId: string): Promise<Attempt | null> {
  const db = await getDb();
  const [a] = await db.select().from(schema.publishAttempts).where(eq(schema.publishAttempts.postId, postId)).orderBy(desc(schema.publishAttempts.attempt)).limit(1);
  return a ?? null;
}

/** For the calendar: which of these posts need a check before they can be published again, and how. */
export async function checksNeeded(posts: { id: string; platform: string }[]): Promise<Record<string, "auto" | "manual">> {
  if (!posts.length) return {};
  const db = await getDb();
  const rows = await db
    .select({ postId: schema.publishAttempts.postId, attempt: schema.publishAttempts.attempt, status: schema.publishAttempts.status })
    .from(schema.publishAttempts)
    .where(inArray(schema.publishAttempts.postId, posts.map((p) => p.id)));
  const latest = new Map<string, { attempt: number; status: Attempt["status"] }>();
  for (const r of rows) if ((latest.get(r.postId)?.attempt ?? 0) < r.attempt) latest.set(r.postId, r);
  const out: Record<string, "auto" | "manual"> = {};
  for (const p of posts) {
    const a = latest.get(p.id);
    if (a && isUnsettled(a)) out[p.id] = provider(p.platform).findRecentPost ? "auto" : "manual";
  }
  return out;
}

/** The platform rejected this account's token (or it expired): show "Reconnect", fail fast. */
export async function markNeedsReconnect(accountId: string, reason: string) {
  const db = await getDb();
  await db
    .update(schema.socialAccounts)
    .set({ status: "expired", health: { status: "needs_reconnect", reason: reason.slice(0, 300), at: new Date().toISOString() }, lastCheckedAt: new Date() })
    .where(eq(schema.socialAccounts.id, accountId));
  log.warn("social.needs_reconnect", { accountId, reason: reason.slice(0, 200) });
}

export function reconnectMessage(platformLabel: string) {
  return `${platformLabel} no longer accepts BrandPilot's access to this account (it expired or was revoked). Reconnect it in Social Accounts, then publish again.`;
}

export type CheckResult =
  | { state: "published"; externalId: string; url: string | null }
  | { state: "not_published" }
  | { state: "nothing_to_check" }
  | { state: "manual" }
  | { state: "too_soon"; retryAfterSec: number }
  | { state: "error"; error: string };

/**
 * Check the platform for a post whose last attempt is unsettled, and settle it:
 * found → the post is published (no second send); not found → the attempt is failed and the post
 * can be published again. Callers authorise (the worker, or a brand admin through the action).
 */
export async function reconcilePost(postId: string, now = Date.now()): Promise<CheckResult> {
  const db = await getDb();
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
  const a = await latestAttempt(postId);
  if (!post || !a || !isUnsettled(a)) return { state: "nothing_to_check" };
  const p = provider(a.platform);
  if (!p.findRecentPost) return { state: "manual" };
  const age = now - a.startedAt.getTime();
  if (age < RECONCILE_DELAY_MS) return { state: "too_soon", retryAfterSec: Math.ceil((RECONCILE_DELAY_MS - age) / 1000) };
  const [acct] = a.socialAccountId ? await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, a.socialAccountId)) : [];
  if (!acct) return { state: "error", error: "The account this post was sent to is no longer connected, so BrandPilot can't check. Look on the platform, then mark the post below." };
  const { toUsable, captionOf } = await import("./service");
  let found: Awaited<ReturnType<NonNullable<typeof p.findRecentPost>>>;
  try {
    found = await p.findRecentPost(toUsable(acct) as AccountForUse, { caption: captionOf(post), since: new Date(a.startedAt.getTime() - 60_000) });
  } catch (e) {
    if (isTokenError(e)) {
      await markNeedsReconnect(acct.id, e instanceof Error ? e.message : String(e));
      return { state: "error", error: reconnectMessage(p.label) };
    }
    return { state: "error", error: `${p.label} couldn't be checked right now. Try again in a few minutes.` };
  }
  const finished = new Date(now);
  if (found) {
    await db.update(schema.publishAttempts).set({ status: "reconciled", externalId: found.externalId, finishedAt: finished }).where(eq(schema.publishAttempts.id, a.id));
    await db
      .update(schema.posts)
      .set({ status: "published", externalId: found.externalId, externalUrl: found.url ?? null, publishedAt: finished, publishError: null })
      .where(eq(schema.posts.id, postId));
    log.info("publish.reconciled", { postId, attempt: a.attempt, found: true });
    return { state: "published", externalId: found.externalId, url: found.url ?? null };
  }
  await db.update(schema.publishAttempts).set({ status: "failed", error: `${CHECKED_ABSENT} (${p.label}, ${finished.toISOString()})`, finishedAt: finished }).where(eq(schema.publishAttempts.id, a.id));
  await db
    .update(schema.posts)
    .set({ status: "failed", publishError: `BrandPilot checked ${p.label}: this post isn't there, so it didn't go out. You can publish it again.` })
    .where(and(eq(schema.posts.id, postId), inArray(schema.posts.status, ["failed", "publishing"])));
  log.info("publish.reconciled", { postId, attempt: a.attempt, found: false });
  return { state: "not_published" };
}

/**
 * A person settles an unsettled attempt after looking on the platform (platforms without an
 * automatic check, or when the check isn't possible). Callers authorise and audit.
 */
export async function settleManually(postId: string, wentOut: boolean, by: string) {
  const db = await getDb();
  const a = await latestAttempt(postId);
  if (!a || !isUnsettled(a)) return false;
  const now = new Date();
  if (wentOut) {
    await db.update(schema.publishAttempts).set({ status: "reconciled", error: `Marked as published by ${by}`, finishedAt: now }).where(eq(schema.publishAttempts.id, a.id));
    await db.update(schema.posts).set({ status: "published", publishedAt: now, publishError: null }).where(eq(schema.posts.id, postId));
  } else {
    await db.update(schema.publishAttempts).set({ status: "failed", error: `${CHECKED_ABSENT} (checked by ${by})`, finishedAt: now }).where(eq(schema.publishAttempts.id, a.id));
    await db.update(schema.posts).set({ status: "failed", publishError: "Marked as not published. You can publish it again." }).where(eq(schema.posts.id, postId));
  }
  return true;
}
