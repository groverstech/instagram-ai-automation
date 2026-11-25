import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { decrypt, encrypt, sign } from "../crypto";
import { provider } from "./registry";
import { sandboxOn } from "./sandbox";
import { PlatformError, PublishNotSupported, isTokenError, type AccountForUse, type DiscoveredAccount, type PublishContext } from "./types";
import { CHECKED_ABSENT, isUnsettled, latestAttempt, markNeedsReconnect, reconnectMessage } from "./publish-ledger";
import { log } from "../log";
import { remember } from "../memory";
import { operatorStopFor, pausedMessage, PublishingPausedError, stoppedMessage } from "../publishing-paused";
import { CLEARED_APPROVAL, NotApprovedContentError, approvalSnapshot, renderApproved } from "./approval";
import { audit } from "../audit";
import { publishGate, suspendAutonomy } from "../autonomy/service";

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

/**
 * Signed URL platforms fetch the post's image from, as sRGB JPEG (valid 24h). It's bound to one
 * approved version of one post (review M-1): the route serves the image only while the post still
 * carries that approval and its content still matches it (social/approval.ts renderApproved).
 */
export function publicMediaUrl(postId: string, approvalHash: string) {
  const token = sign({ p: postId, h: approvalHash, exp: Date.now() + 24 * 3600 * 1000 });
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
  const [owner] = await db.select({ name: schema.brands.name, publishingPausedAt: schema.brands.publishingPausedAt, workspaceId: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, post.brandId));
  const brandWorkspace = owner?.workspaceId ?? null;
  if (owner?.publishingPausedAt) return { ok: false as const, error: pausedMessage(owner), paused: true as const };
  // Operator emergency stop (review M-3): separate from the brand's own pause.
  const stopNow = brandWorkspace ? await operatorStopFor(db, brandWorkspace) : null;
  if (stopNow) return { ok: false as const, error: stoppedMessage(stopNow), paused: true as const };

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
    await suspendAutonomy(post.brandId, `The ${p.label} access token expired.`).catch(() => {});
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

  // Set inside the claim transaction (a holder object, so the values survive the closure).
  const claim: { invalidated?: { workspaceId: string | null; hadHash: boolean }; post?: typeof post; creative?: typeof schema.creatives.$inferSelect | null; hash?: string } = {};
  // Claim the post atomically: only one caller (scheduled job or "publish now") can move it to
  // "publishing", so concurrent attempts can't both publish. In the same transaction, with the
  // account row locked: the emergency pause and the autonomy policy are checked again immediately
  // before anything is sent (docs/AUTONOMY.md), so a pause or a rule change since scheduling wins.
  const gate = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from social_accounts where id = ${acct.id} for update`);
    const [fresh] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId));
    if (!fresh) return { ok: false as const, error: "Post not found" };
    // Operator emergency stop (review M-3), checked again under the claim.
    const stop = brandWorkspace ? await operatorStopFor(tx as unknown as typeof db, brandWorkspace) : null;
    if (stop) return { ok: false as const, error: stoppedMessage(stop), paused: true as const };
    // Approval integrity (H1): what's about to be published must be exactly what was approved:
    // the post, its creative and the brand identity drawn on the image. Otherwise it goes back to
    // a person, unsent. A post approved before hashes existed has none and needs a fresh approval.
    // The rows hashed here are the ones published (review M-1): no second read.
    const snap = await approvalSnapshot(tx as unknown as typeof db, fresh);
    const hash = snap.hash;
    if (!fresh.approvedContentHash || fresh.approvedContentHash !== hash) {
      await tx
        .update(schema.posts)
        .set({ status: "pending_approval", ...CLEARED_APPROVAL, publishError: "The post, its creative or the brand's look changed after it was approved, so it needs a new approval. Nothing was sent." })
        .where(eq(schema.posts.id, postId));
      claim.invalidated = { workspaceId: brandWorkspace, hadHash: Boolean(fresh.approvedContentHash) };
      return { ok: false as const, error: "This post changed after it was approved, so it needs a new approval. Nothing was sent.", toPerson: true as const };
    }
    const d = await publishGate(tx as unknown as typeof db, fresh, acct);
    if (d.result === "deny") return { ok: false as const, error: d.reasons[0] === "Publishing is paused for this brand" && owner ? pausedMessage(owner) : d.reasons.join("; "), paused: d.reasons[0] === "Publishing is paused for this brand" };
    if (d.result === "require_approval") {
      // A post the policy approved no longer qualifies: it goes back to a person, unsent.
      await tx.update(schema.posts).set({ status: "pending_approval", ...CLEARED_APPROVAL, publishError: `Needs a person's approval: ${d.reasons.join("; ")}` }).where(eq(schema.posts.id, postId));
      return { ok: false as const, error: `Needs a person's approval: ${d.reasons.join("; ")}`, toPerson: true as const };
    }
    const [claimed] = await tx
      .update(schema.posts)
      .set({ status: "publishing", publishError: null })
      .where(and(eq(schema.posts.id, postId), inArray(schema.posts.status, ["approved", "scheduled", "failed"])))
      .returning({ id: schema.posts.id });
    if (!claimed) return { ok: false as const, error: "This post is already being published." };
    // Publish exactly the version checked above (edits are refused while it's publishing).
    claim.post = fresh;
    claim.creative = snap.creative;
    claim.hash = hash;
    return null;
  });
  if (claim.invalidated) {
    await audit({ action: "post.approval_invalidated", workspaceId: claim.invalidated.workspaceId, brandId: post.brandId, actorType: "system", targetType: "post", targetId: postId, details: { at: "publish", reason: claim.invalidated.hadHash ? "content_changed" : "approved_before_integrity_checks" } });
  }
  if (gate) return gate;
  if (!claim.post || !claim.creative || !claim.hash) return { ok: false as const, error: "The post or its creative is missing." };
  const snapshot = claim.post;
  const approved = claim.hash;

  const caption = captionOf(snapshot);
  // The attempt is recorded before anything is sent. If it can't be, nothing is sent.
  const attemptNo = (last?.attempt ?? 0) + 1;
  // A container from an attempt that a check found unpublished can be reused (Instagram), but only
  // for the same approved content (review H-1): a container holds the caption and image it was
  // created with, so after an edit and a new approval a fresh one is made from the new version.
  const lastProgress = (last?.progress ?? {}) as Record<string, unknown>;
  const resume = last && last.status === "failed" && (last.error ?? "").startsWith(CHECKED_ABSENT) && lastProgress.approvalHash === approved ? lastProgress : {};
  let attemptId: string;
  try {
    const [row] = await db
      .insert(schema.publishAttempts)
      // What this attempt sends is recorded with it: the approval it carries (container reuse) and the
      // exact text (a later check looks for this text, not the post's current one).
      .values({ postId, socialAccountId: acct.id, platform: acct.platform, attempt: attemptNo, idempotencyKey: `post:${postId}:${attemptNo}`, progress: { approvalHash: approved, caption } })
      .returning({ id: schema.publishAttempts.id });
    attemptId = row.id;
  } catch (e) {
    log.error("publish.attempt_write_failed", { postId, error: e instanceof Error ? e.message : String(e) });
    await db.update(schema.posts).set({ status: post.status, publishError: post.publishError }).where(eq(schema.posts.id, postId));
    return { ok: false as const, error: "BrandPilot couldn't record the publish attempt, so nothing was sent. Try again." };
  }
  let progress: Record<string, unknown> = { approvalHash: approved, caption };
  let finalSent = false;
  const ctx: PublishContext = {
    resume,
    async progress(data) {
      progress = { ...progress, ...data };
      await db.update(schema.publishAttempts).set({ progress }).where(eq(schema.publishAttempts.id, attemptId));
    },
    // Immediately before the request that makes the post public, the emergency pause is checked
    // once more (M4): a pause that arrives while the post is being prepared still stops it, and
    // nothing has been sent. After this point the request is out and can't be recalled.
    async finalSend() {
      const [b] = await db.select({ name: schema.brands.name, publishingPausedAt: schema.brands.publishingPausedAt, workspaceId: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, post.brandId));
      if (b?.publishingPausedAt) throw new PublishingPausedError(pausedMessage(b));
      const stop = b ? await operatorStopFor(db, b.workspaceId) : null;
      if (stop) throw new PublishingPausedError(stoppedMessage(stop));
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
        title: snapshot.title ?? undefined,
        // Both are bound to the approved version (review M-1): the link refuses, and the in-process
        // render throws, if the post, creative or brand no longer match the approval.
        imageUrl: publicMediaUrl(postId, approved),
        image: () => renderApproved(db, postId, approved),
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
    if (e instanceof PublishingPausedError && !finalSent) {
      // Paused while it was being prepared: nothing was sent. The post keeps its approval and
      // status, so resuming publishes it as planned (publishing-pause.ts).
      await db.update(schema.publishAttempts).set({ status: "failed", error: `Stopped by the emergency pause before sending: ${detail}`.slice(0, 1000), finishedAt: new Date() }).where(eq(schema.publishAttempts.id, attemptId));
      await db.update(schema.posts).set({ status: post.status, publishError: null }).where(and(eq(schema.posts.id, postId), eq(schema.posts.status, "publishing")));
      return { ok: false as const, error: detail, paused: true as const };
    }
    if (e instanceof NotApprovedContentError) {
      // The content changed after the claim (review M-1): the image wasn't sent; a person approves again.
      await db.update(schema.publishAttempts).set({ status: "failed", error: `Not sent: ${detail}`.slice(0, 1000), finishedAt: new Date() }).where(eq(schema.publishAttempts.id, attemptId));
      await db.update(schema.posts).set({ status: "pending_approval", ...CLEARED_APPROVAL, publishError: "The post, its creative or the brand's look changed while it was being published, so it needs a new approval. Nothing was sent." }).where(eq(schema.posts.id, postId));
      await audit({ action: "post.approval_invalidated", workspaceId: brandWorkspace, brandId: post.brandId, actorType: "system", targetType: "post", targetId: postId, details: { at: "publish_render", reason: "content_changed" } });
      return { ok: false as const, error: "This post changed while it was being published, so it needs a new approval. Nothing was sent.", toPerson: true as const };
    }
    if (isTokenError(e)) await markNeedsReconnect(acct.id, detail);
    // Automatic safeguard (docs/AUTONOMY.md): a failed autonomous publish, or a rejected token,
    // drops the brand from Autonomous to Assisted until an owner has looked.
    if (post.autoApprovedVersion != null || isTokenError(e)) await suspendAutonomy(post.brandId, `${isTokenError(e) ? "Token rejected" : "Autonomous publish failed"} on ${p.label}: ${detail.slice(0, 200)}`).catch(() => {});
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

/** A refusal whose message is safe to show (kept local: this module is also loaded by the worker). */
export class UserFacingErrorLike extends Error {}

/** The post changed between review and approval (review M-2): the approver reloads and reviews it. */
export class ApprovalConflictError extends UserFacingErrorLike {}

/**
 * Approval checkpoint: records who approved, and exactly what, and teaches brand memory.
 *
 * `reviewedHash` is the approval hash of the version the approver was shown (review M-2). In one
 * transaction, with the post row locked (a concurrent edit waits, then finds it approved and is
 * refused), the current hash is recomputed and must equal it; otherwise nothing is approved. A
 * change to the creative or brand that lands after this still can't publish: the publish claim
 * compares against the hash recorded here.
 */
export async function approvePost(brandId: string, postId: string, userId: string, reviewedHash: string) {
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from posts where id = ${postId} and brand_id = ${brandId} for update`);
    const [cur] = await tx.select().from(schema.posts).where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId)));
    if (!cur) return undefined;
    if (["publishing", "published"].includes(cur.status)) throw new UserFacingErrorLike("This post has already been published.");
    const { hash } = await approvalSnapshot(tx as unknown as typeof db, cur);
    if (!reviewedHash || hash !== reviewedHash) throw new ApprovalConflictError("This post, its creative or the brand's look changed since you opened it. Nothing was approved: reload and review it again.");
    const [p] = await tx
      .update(schema.posts)
      .set({ status: "approved", approvedBy: userId, approvedAt: new Date(), approvedContentHash: hash, autoApprovedVersion: null, publishError: null })
      .where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId), eq(schema.posts.status, cur.status)))
      .returning();
    if (!p) throw new ApprovalConflictError("The post changed while you were approving it. Reload and review it again.");
    return { p, hash, from: cur.status };
  });
  if (!result) return undefined;
  const { p, hash, from } = result;
  const [b] = await db.select({ workspaceId: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, brandId));
  await audit({ action: "post.approved", workspaceId: b?.workspaceId ?? null, brandId, actorUserId: userId, targetType: "post", targetId: postId, details: { contentHash: hash.slice(0, 16), from } });
  if (p.caption) {
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
