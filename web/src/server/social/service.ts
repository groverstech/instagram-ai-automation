import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { decrypt, encrypt, sign } from "../crypto";
import { provider } from "./registry";
import { sandboxOn } from "./sandbox";
import { PlatformError, PublishNotSupported, isTokenError, type AccountForUse, type DiscoveredAccount, type PublishContext } from "./types";
import { CHECKED_ABSENT, isUnsettled, latestAttempt, markNeedsReconnect, reconnectMessage } from "./publish-ledger";
import { log } from "../log";
import { renderCreativePng } from "../creative/render";
import { remember } from "../memory";
import { pausedMessage } from "../publishing-paused";

export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function isPublicAppUrl() {
  try {
    const u = new URL(appUrl());
    return u.protocol === "https:" && !["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Signed URL platforms can fetch the rendered creative from, as sRGB JPEG (valid 24h). */
export function publicMediaUrl(creativeId: string, format?: string) {
  const token = sign({ c: creativeId, f: format ?? null, exp: Date.now() + 24 * 3600 * 1000 });
  // JPEG: Instagram's content publishing API accepts JPEG images only (plan defect D1).
  return `${appUrl()}/api/public/media/${token}.jpg`;
}

export async function saveAccounts(brandId: string, userId: string, accounts: DiscoveredAccount[]) {
  const db = await getDb();
  for (const a of accounts) {
    const values = {
      brandId,
      platform: a.platform,
      externalId: a.externalId,
      name: a.name,
      handle: a.handle ?? null,
      avatarUrl: a.avatarUrl ?? null,
      accessTokenEnc: encrypt(a.token.accessToken),
      refreshTokenEnc: a.token.refreshToken ? encrypt(a.token.refreshToken) : null,
      expiresAt: a.token.expiresAt ?? null,
      scopes: a.token.scopes ?? null,
      status: "active" as const,
      meta: a.meta ?? {},
      connectedBy: userId,
      platformUserId: a.token.platformUserId ?? null,
      deauthorizedAt: null,
      // Reconnecting clears a "needs reconnect" flag (token health, PR 4.4a).
      health: {},
      lastCheckedAt: new Date(),
    };
    await db
      .insert(schema.socialAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.socialAccounts.brandId, schema.socialAccounts.platform, schema.socialAccounts.externalId],
        set: values,
      });
  }
}

/** The text published for a post: caption, then hashtags. Reconciliation compares against the same. */
export function captionOf(post: { caption: string | null; hashtags: string[] }) {
  return [post.caption ?? "", post.hashtags.length ? post.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ") : ""].filter(Boolean).join("\n\n");
}

export function toUsable(a: typeof schema.socialAccounts.$inferSelect): AccountForUse {
  return { id: a.id, platform: a.platform, externalId: a.externalId, accessToken: decrypt(a.accessTokenEnc), meta: a.meta };
}

/**
 * Publish a post. Preconditions (enforced here, not just in the UI):
 * approved or scheduled status, a creative, and an active account on the same platform.
 * The platform's real response is stored; failures are recorded, never masked.
 */
export async function publishPost(postId: string) {
  const db = await getDb();
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
  if (!post) throw new Error("Post not found");
  if (!["approved", "scheduled", "failed"].includes(post.status)) throw new Error(`Post must be approved before publishing (current status: ${post.status}).`);
  if (!post.approvedAt) throw new Error("Post has no recorded approval.");
  // Emergency pause: refuse without changing the post, so resuming can pick it up again.
  const [owner] = await db.select({ name: schema.brands.name, publishingPausedAt: schema.brands.publishingPausedAt }).from(schema.brands).where(eq(schema.brands.id, post.brandId));
  if (owner?.publishingPausedAt) return { ok: false as const, error: pausedMessage(owner), paused: true as const };

  const fail = async (msg: string) => {
    await db.update(schema.posts).set({ status: "failed", publishError: msg }).where(eq(schema.posts.id, postId));
    return { ok: false as const, error: msg };
  };

  if (!post.creativeId) return fail("Attach a creative before publishing.");
  if (!post.socialAccountId) return fail("Choose a connected account for this post.");
  const [acct] = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.id, post.socialAccountId), eq(schema.socialAccounts.brandId, post.brandId)));
  if (acct?.status === "expired") return fail(reconnectMessage(provider(acct.platform).label));
  if (!acct || acct.status !== "active") return fail("The selected account is disconnected. Reconnect it in Social Accounts.");
  if (acct.platform !== post.platform) return fail("The selected account is on a different platform than the post.");
  const p = provider(acct.platform);
  // Token health: an expired token fails now, not at the platform (PR 4.4a).
  if (acct.expiresAt && acct.expiresAt.getTime() <= Date.now()) {
    await markNeedsReconnect(acct.id, "The access token expired.");
    return fail(reconnectMessage(p.label));
  }
  // An earlier attempt may have gone out (interrupted or no answer): it must be checked first, so
  // the post is never sent twice (publish ledger, PR 4.4a).
  const last = await latestAttempt(postId);
  if (isUnsettled(last)) {
    return { ok: false as const, error: `BrandPilot doesn't know whether the last attempt reached ${p.label}. Check ${p.label} first (in the post's panel), then publish again if it isn't there.`, needsCheck: true as const };
  }
  if (!p.publish || p.capabilities.publishImage === "unsupported") return fail(`${p.label} doesn't support publishing image posts through its API.`);
  if (["instagram", "pinterest", "facebook", "tiktok"].includes(p.id) && !isPublicAppUrl() && !sandboxOn()) {
    return fail(`${p.label} downloads the image from a public URL. Set APP_URL to your public https domain before publishing.`);
  }

  const [creative] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, post.creativeId));
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, post.brandId));
  // Claim the post atomically: only one caller (scheduled job or "publish now") can move it to
  // "publishing", so concurrent attempts can't both publish.
  const [claimed] = await db
    .update(schema.posts)
    .set({ status: "publishing", publishError: null })
    .where(and(eq(schema.posts.id, postId), inArray(schema.posts.status, ["approved", "scheduled", "failed"])))
    .returning({ id: schema.posts.id });
  if (!claimed) return { ok: false as const, error: "This post is already being published." };

  const caption = captionOf(post);
  // The attempt is recorded before anything is sent. If it can't be, nothing is sent.
  const attemptNo = (last?.attempt ?? 0) + 1;
  // A container from an attempt that a check found unpublished can be reused (Instagram).
  const resume = last && last.status === "failed" && (last.error ?? "").startsWith(CHECKED_ABSENT) ? last.progress : {};
  let attemptId: string;
  try {
    const [row] = await db
      .insert(schema.publishAttempts)
      .values({ postId, socialAccountId: acct.id, platform: acct.platform, attempt: attemptNo, idempotencyKey: `post:${postId}:${attemptNo}` })
      .returning({ id: schema.publishAttempts.id });
    attemptId = row.id;
  } catch (e) {
    log.error("publish.attempt_write_failed", { postId, error: e instanceof Error ? e.message : String(e) });
    await db.update(schema.posts).set({ status: post.status, publishError: post.publishError }).where(eq(schema.posts.id, postId));
    return { ok: false as const, error: "BrandPilot couldn't record the publish attempt, so nothing was sent. Try again." };
  }
  let progress: Record<string, unknown> = {};
  let finalSent = false;
  const ctx: PublishContext = {
    resume,
    async progress(data) {
      progress = { ...progress, ...data };
      await db.update(schema.publishAttempts).set({ progress }).where(eq(schema.publishAttempts.id, attemptId));
    },
    finalSend() {
      finalSent = true;
    },
  };
  // Providers without a check (findRecentPost) don't report the final send: treat every request
  // as possibly final, so an unanswered one is "unknown" rather than assumed to have failed.
  if (!p.findRecentPost) finalSent = true;
  try {
    const res = await p.publish(
      toUsable(acct),
      {
        caption,
        title: post.title ?? undefined,
        imageUrl: publicMediaUrl(creative.id, post.format),
        image: () => renderCreativePng(creative, brand, post.format),
      },
      ctx,
    );
    await db.update(schema.publishAttempts).set({ status: "succeeded", externalId: res.externalId, finishedAt: new Date() }).where(eq(schema.publishAttempts.id, attemptId));
    await db
      .update(schema.posts)
      .set({ status: "published", externalId: res.externalId, externalUrl: res.url ?? null, publishedAt: new Date(), publishError: null })
      .where(eq(schema.posts.id, postId));
    return { ok: true as const, ...res };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (isTokenError(e)) await markNeedsReconnect(acct.id, detail);
    // Definitely not published: refused before the final request, refused by the platform (4xx
    // other than timeout and rate limit), or not supported. Anything else may have gone out.
    const refused = e instanceof PlatformError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
    const definite = !finalSent || refused || e instanceof PublishNotSupported;
    await db
      .update(schema.publishAttempts)
      .set({ status: definite ? "failed" : "unknown", error: detail.slice(0, 1000), finishedAt: new Date() })
      .where(eq(schema.publishAttempts.id, attemptId));
    if (!definite) {
      log.warn("publish.outcome_unknown", { postId, attempt: attemptNo, platform: p.id });
      return fail(`BrandPilot sent this post to ${p.label} but didn't get an answer (${detail.slice(0, 200)}). It may have gone out. Check ${p.label} before publishing again.`);
    }
    if (isTokenError(e)) return fail(reconnectMessage(p.label));
    return fail(e instanceof PublishNotSupported ? e.message : `Publishing failed: ${detail}`);
  }
}

/** Pull real metrics for published posts and accounts. Writes source='platform'. */
export async function syncMetrics(brandId: string) {
  const db = await getDb();
  const accounts = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.brandId, brandId), eq(schema.socialAccounts.status, "active")));
  const today = new Date().toISOString().slice(0, 10);
  const report = { accounts: 0, posts: 0, errors: [] as string[] };
  for (const acct of accounts) {
    const p = provider(acct.platform);
    const usable = toUsable(acct);
    if (p.accountMetrics) {
      try {
        const m = await p.accountMetrics(usable);
        await db
          .insert(schema.accountMetrics)
          .values({ socialAccountId: acct.id, date: today, followers: m.followers ?? null, profileVisits: m.profileVisits ?? null, reach: m.reach ?? null, impressions: m.impressions ?? null })
          .onConflictDoUpdate({
            target: [schema.accountMetrics.socialAccountId, schema.accountMetrics.date],
            set: { followers: m.followers ?? null, profileVisits: m.profileVisits ?? null, reach: m.reach ?? null, impressions: m.impressions ?? null },
          });
        report.accounts++;
      } catch (e) {
        report.errors.push(`${p.label} account: ${(e as Error).message}`);
        // Token health: a rejected token stops this account's sync and shows "Reconnect".
        if (isTokenError(e)) {
          await markNeedsReconnect(acct.id, (e as Error).message);
          continue;
        }
      }
    }
    if (!p.postMetrics) continue;
    const published = await db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.socialAccountId, acct.id), eq(schema.posts.status, "published")));
    for (const post of published) {
      if (!post.externalId) continue;
      try {
        const m = await p.postMetrics(usable, post.externalId);
        const interactions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
        const denom = m.reach ?? m.impressions ?? null;
        await db.insert(schema.postMetrics).values({
          postId: post.id,
          reach: m.reach ?? null,
          impressions: m.impressions ?? null,
          likes: m.likes ?? null,
          comments: m.comments ?? null,
          shares: m.shares ?? null,
          saves: m.saves ?? null,
          videoViews: m.videoViews ?? null,
          linkClicks: m.linkClicks ?? null,
          engagementRate: denom ? interactions / denom : null,
          source: "platform",
        });
        report.posts++;
      } catch (e) {
        report.errors.push(`${p.label} post ${post.id.slice(0, 8)}: ${(e as Error).message}`);
        if (isTokenError(e)) {
          await markNeedsReconnect(acct.id, (e as Error).message);
          break;
        }
      }
    }
  }
  return report;
}

/** Approval checkpoint: records who approved and teaches brand memory. */
export async function approvePost(brandId: string, postId: string, userId: string) {
  const db = await getDb();
  const [p] = await db
    .update(schema.posts)
    .set({ status: "approved", approvedBy: userId, approvedAt: new Date() })
    .where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId)))
    .returning();
  if (p?.caption) {
    await remember(brandId, [{ kind: "approval", content: `Approved ${p.platform} caption (${p.objective ?? "general"}): "${p.caption.slice(0, 280)}"`, source: "post:approved", weight: 1.2 }]);
  }
  return p;
}

/**
 * A publish job whose worker stopped mid-flight (stale lock). The platform may or may not have
 * received the post, so never publish again automatically: mark the post failed with a message
 * telling people to check the account first. Retrying is then an explicit human decision.
 */
export async function markPublishInterrupted(postId: string) {
  const db = await getDb();
  const [post] = await db
    .update(schema.posts)
    .set({ status: "failed", publishError: "The publish attempt was interrupted before BrandPilot heard back from the platform. Check the account to see whether the post went out before you retry." })
    .where(and(eq(schema.posts.id, postId), eq(schema.posts.status, "publishing")))
    .returning({ id: schema.posts.id, brandId: schema.posts.brandId, platform: schema.posts.platform });
  return post ?? null;
}
