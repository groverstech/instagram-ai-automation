"use server";
import { audit } from "@/server/audit";
import { assertPublishingAllowed } from "@/server/publishing-paused";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { AccessError, requireBrand } from "@/server/auth/guard";
import { getSession } from "@/server/auth/session";
import { requireRecentSecondFactor } from "@/server/auth/step-up";
import { pausePublishingFor, resumePublishingFor } from "@/server/publishing-pause";
import { safe } from "@/server/action";
import { approvePost, publishPost, syncMetrics } from "@/server/social/service";
import { enqueue, cancelJobs } from "@/server/jobs/queue";
import { remember } from "@/server/memory";
import { provider } from "@/server/social/registry";
import { attemptsForPost, reconcilePost, settleManually } from "@/server/social/publish-ledger";
import { CLEARED_APPROVAL, changedPublishedFields } from "@/server/social/approval";
import { withTenant } from "@/server/db/tenant";
import { UserFacingError } from "@/server/jobs/engine";

async function ownPost(brandId: string, postId: string) {
  const db = await getDb();
  const [p] = await db.select().from(schema.posts).where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId)));
  if (!p) throw new Error("Post not found");
  return p;
}

const refresh = () => {
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
};

const Patch = z.object({
  title: z.string().optional(),
  caption: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  platform: z.string().optional(),
  format: z.string().optional(),
  pillar: z.string().optional(),
  objective: z.string().optional(),
  scheduledAt: z.string().optional(),
  socialAccountId: z.string().nullable().optional(),
  creativeId: z.string().nullable().optional(),
});

export async function updatePost(brandId: string, postId: string, patch: z.infer<typeof Patch>) {
  return safe(async () => {
    const { session, brand } = await requireBrand(brandId, "editor");
    const p = await ownPost(brandId, postId);
    if (["publishing", "published"].includes(p.status)) throw new Error("Published posts can't be edited.");
    const v = Patch.parse(patch);
    const db = await getDb();
    if (v.socialAccountId) {
      const [a] = await db.select().from(schema.socialAccounts).where(and(eq(schema.socialAccounts.id, v.socialAccountId), eq(schema.socialAccounts.brandId, brandId)));
      if (!a) throw new Error("Account not found");
    }
    if (v.creativeId) {
      const [c] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, v.creativeId), eq(schema.creatives.brandId, brandId)));
      if (!c) throw new Error("Creative not found");
    }
    // Approval integrity (H1): any change to what gets published (caption, hashtags, title,
    // platform, format, creative, target account) withdraws the approval. The approver isn't shown
    // against content they didn't see; queued publishing stops; a person approves again.
    const changed = changedPublishedFields(p, { ...v, scheduledAt: undefined } as Parameters<typeof changedPublishedFields>[1]);
    // The last attempt may have gone out and hasn't been checked (review H-1): the post's content
    // stays as sent until a check settles it, so the record matches what's on the platform.
    if (changed.length) {
      const { isUnsettled, latestAttempt } = await import("@/server/social/publish-ledger");
      if (isUnsettled(await latestAttempt(postId))) throw new UserFacingError("This post may already be on the platform. Check it first (in the post's panel), then edit it.");
    }
    const hadApproval = ["approved", "scheduled", "failed"].includes(p.status) || p.approvedAt != null;
    const invalidate = changed.length > 0 && hadApproval;
    const status = invalidate ? "pending_approval" : p.status;
    const when = v.scheduledAt ? new Date(v.scheduledAt) : undefined;
    if (when && Number.isNaN(when.getTime())) throw new Error("Invalid date");
    const timeChanged = when !== undefined && when.getTime() !== p.scheduledAt?.getTime();
    // A person editing the AI's draft makes it human content: the autonomy policy may only approve
    // the AI's own text (review M2).
    const humanEditedAi = p.origin === "ai" && changed.some((f) => f !== "socialAccountId" && f !== "format");
    // Only apply if the post is still as read: a publish claim in between wins, and nothing is
    // overwritten behind its back.
    const [updated] = await db
      .update(schema.posts)
      .set({ ...v, scheduledAt: when, status, ...(invalidate ? CLEARED_APPROVAL : {}), ...(humanEditedAi ? { origin: "ai_edited" } : {}) })
      .where(and(eq(schema.posts.id, postId), eq(schema.posts.status, p.status)))
      .returning();
    if (!updated) throw new Error("The post changed while you were editing it (it may be publishing). Reload and try again.");
    if (p.status === "scheduled" && (invalidate || timeChanged)) {
      // M1: the queued job follows the post. The old one is cancelled; a new one is queued at the
      // new time (not while publishing is paused: resuming queues it). A job that already started
      // at the old time refuses itself (jobs/handlers.ts), and the claim prevents a double publish.
      await cancelJobs("publish_post", (j) => j.postId === postId);
      if (!invalidate && updated.scheduledAt && !brand.publishingPausedAt) {
        await enqueue("publish_post", { postId }, updated.scheduledAt < new Date() ? new Date() : updated.scheduledAt);
        await keepOnlyCurrentJob(postId);
      }
    }
    if (invalidate) {
      await audit({ action: "post.approval_invalidated", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "post", targetId: postId, details: { at: "edit", fields: changed.join(","), previousApprover: p.approvedBy, from: p.status } });
    }
    if (v.caption && p.caption && v.caption !== p.caption && p.caption.length > 20) {
      await remember(brandId, [{ kind: "feedback", content: `User rewrote an AI caption. Before: "${p.caption.slice(0, 200)}" After: "${v.caption.slice(0, 200)}"`, source: "post:edit", weight: 1.3 }]);
    }
    refresh();
    return { approvalWithdrawn: invalidate, changed };
  });
}

/**
 * After concurrent edits of one post's time, drop queued jobs that aren't at the time the post now
 * has. (Two jobs at the same time are harmless: the publish claim lets one through.)
 */
async function keepOnlyCurrentJob(postId: string) {
  const db = await getDb();
  const [p] = await db.select({ status: schema.posts.status, at: schema.posts.scheduledAt }).from(schema.posts).where(eq(schema.posts.id, postId));
  const queued = (await db.select().from(schema.jobs).where(and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")))).filter((j) => (j.payload as { postId?: string }).postId === postId);
  const target = p?.status === "scheduled" && p.at ? Math.max(p.at.getTime(), 0) : null;
  const stale = queued.filter((j) => target === null || Math.abs(j.runAt.getTime() - target) > 1000);
  // Keep one if every queued job is "stale" only because the post was due in the past (queued for now).
  const keep = target !== null && target < Date.now() && stale.length === queued.length ? stale.slice(0, 1) : [];
  const drop = stale.filter((j) => !keep.includes(j));
  if (drop.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, drop.map((j) => j.id)));
}

export async function movePost(brandId: string, postId: string, isoDate: string) {
  return safe(async () => {
    const { brand } = await requireBrand(brandId, "editor");
    const p = await ownPost(brandId, postId);
    if (["publishing", "published"].includes(p.status)) throw new Error("Published posts can't be moved.");
    const target = new Date(isoDate);
    const prev = p.scheduledAt ?? new Date();
    target.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
    const db = await getDb();
    await db.update(schema.posts).set({ scheduledAt: target }).where(eq(schema.posts.id, postId));
    if (p.status === "scheduled") {
      await cancelJobs("publish_post", (j) => j.postId === postId);
      // While publishing is paused, resuming re-queues scheduled posts (publishing-pause.ts).
      if (!brand.publishingPausedAt) await enqueue("publish_post", { postId }, target);
    }
    refresh();
  });
}

export async function submitForApproval(brandId: string, postId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const p = await ownPost(brandId, postId);
    if (!p.caption) throw new Error("Add a caption before submitting.");
    const db = await getDb();
    await db.update(schema.posts).set({ status: "pending_approval" }).where(eq(schema.posts.id, postId));
    refresh();
  });
}

/**
 * Approve exactly the version the approver reviewed (review M-2): `reviewedHash` is the approval
 * hash of the post as the page showed it (calendar/page.tsx). If the post, its creative or the
 * brand's look changed since, nothing is approved and the approver is asked to reload.
 */
export async function approvePostAction(brandId: string, postId: string, reviewedHash: string) {
  return safe(async () => {
    const { session } = await requireBrand(brandId, "admin");
    const p = await ownPost(brandId, postId);
    if (!p.caption) throw new Error("A post needs a caption before it can be approved.");
    await approvePost(brandId, postId, session.user.id, z.string().regex(/^[0-9a-f]{64}$/, "Reload the page and review the post again.").parse(reviewedHash));
    refresh();
  });
}

export async function rejectPost(brandId: string, postId: string, reason: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    await ownPost(brandId, postId);
    const db = await getDb();
    await db.update(schema.posts).set({ status: "draft", ...CLEARED_APPROVAL }).where(eq(schema.posts.id, postId));
    await cancelJobs("publish_post", (j) => j.postId === postId);
    if (reason.trim()) await remember(brandId, [{ kind: "feedback", content: `Post sent back: ${reason.trim()}`, source: "post:rejected", weight: 1.4 }]);
    refresh();
  });
}

/** Human checkpoint: only admins schedule, only approved posts, only to a connected account. */
export async function schedulePost(brandId: string, postId: string) {
  return safe(async () => {
    const { brand } = await requireBrand(brandId, "admin");
    await assertPublishingAllowed(await getDb(), brand);
    const p = await ownPost(brandId, postId);
    if (p.status !== "approved") throw new Error("Approve the post before scheduling it.");
    if (!p.scheduledAt) throw new Error("Pick a date and time.");
    if (!p.creativeId) throw new Error("Attach a creative before scheduling.");
    if (!p.socialAccountId) throw new Error("Choose which connected account to publish to.");
    const db = await getDb();
    const [acct] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, p.socialAccountId));
    if (!acct || acct.status !== "active") throw new Error("That account is disconnected.");
    const cap = provider(acct.platform).capabilities.publishImage;
    if (cap !== "supported") throw new Error(`${provider(acct.platform).label} can't publish image posts via its API${cap === "requires_app_review" ? " until your app is approved" : ""}.`);
    const runAt = p.scheduledAt < new Date() ? new Date() : p.scheduledAt;
    await db.update(schema.posts).set({ status: "scheduled" }).where(eq(schema.posts.id, postId));
    await enqueue("publish_post", { postId }, runAt);
    refresh();
  });
}

export async function unschedulePost(brandId: string, postId: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    const p = await ownPost(brandId, postId);
    if (p.status !== "scheduled") return;
    await cancelJobs("publish_post", (j) => j.postId === postId);
    const db = await getDb();
    await db.update(schema.posts).set({ status: "approved" }).where(eq(schema.posts.id, postId));
    refresh();
  });
}

export async function publishNow(brandId: string, postId: string) {
  return safe(async () => {
    const { brand } = await requireBrand(brandId, "admin");
    await assertPublishingAllowed(await getDb(), brand);
    const p = await ownPost(brandId, postId);
    if (!["approved", "scheduled", "failed"].includes(p.status)) throw new Error("Approve the post first.");
    if (p.status === "scheduled") await cancelJobs("publish_post", (j) => j.postId === postId);
    const r = await publishPost(postId);
    refresh();
    if (!r.ok) throw new Error(r.error);
    return r;
  });
}

export async function deletePost(brandId: string, postId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const p = await ownPost(brandId, postId);
    if (p.status === "published") throw new Error("Published posts stay in history; delete them on the platform.");
    await cancelJobs("publish_post", (j) => j.postId === postId);
    const db = await getDb();
    await db.delete(schema.posts).where(eq(schema.posts.id, postId));
    refresh();
  });
}

/**
 * Publish ledger (PR 4.4a): check the platform for a post whose last attempt may have gone out, so
 * it's never published twice. Admins, like publishing itself.
 */
export async function checkPublishAction(brandId: string, postId: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    await ownPost(brandId, postId);
    const r = await reconcilePost(postId);
    refresh();
    if (r.state === "error") throw new UserFacingError(r.error);
    if (r.state === "too_soon") throw new UserFacingError(`The platform may still be processing it. Check again in ${Math.ceil(r.retryAfterSec / 60)} minute(s).`);
    if (r.state === "manual") throw new UserFacingError("This platform can't be checked automatically. Look on the account, then mark the post below.");
    return r.state === "published" ? "It was published: BrandPilot found it on the platform." : r.state === "not_published" ? "It isn't on the platform. You can publish it again." : "Nothing to check.";
  });
}

/** A person settles a post's unknown outcome after looking on the platform. Audited. */
export async function markPublishOutcomeAction(brandId: string, postId: string, wentOut: boolean) {
  return safe(async () => {
    const { session, brand } = await requireBrand(brandId, "admin");
    await ownPost(brandId, postId);
    const done = await settleManually(postId, wentOut, session.user.name || session.user.email);
    if (!done) throw new UserFacingError("There's nothing to settle for this post.");
    await audit({ action: "post.publish_outcome_marked", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "post", targetId: postId, details: { wentOut } });
    refresh();
  });
}

/** Publishing history of one post (the publish ledger), for anyone who can see the brand. */
export async function publishHistoryAction(brandId: string, postId: string) {
  return safe(async () => {
    const { brand } = await requireBrand(brandId, "viewer");
    await ownPost(brandId, postId);
    const rows = await withTenant(brand.workspaceId, (t) => attemptsForPost(postId, t));
    return rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null }));
  });
}

export async function syncMetricsAction(brandId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const r = await syncMetrics(brandId);
    revalidatePath("/analytics");
    return r;
  });
}

export async function disconnectAccount(brandId: string, accountId: string) {
  return safe(async () => {
    const { session, brand } = await requireBrand(brandId, "admin");
    await requireRecentSecondFactor(session);
    const db = await getDb();
    const [gone] = await db.delete(schema.socialAccounts).where(and(eq(schema.socialAccounts.id, accountId), eq(schema.socialAccounts.brandId, brandId))).returning({ platform: schema.socialAccounts.platform });
    if (gone) await audit({ action: "social.disconnect", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "social_account", targetId: accountId, details: { platform: gone.platform } });
    await db.update(schema.posts).set({ socialAccountId: null }).where(and(eq(schema.posts.socialAccountId, accountId), eq(schema.posts.brandId, brandId)));
    revalidatePath("/accounts");
  });
}

export async function setAccountBoard(brandId: string, accountId: string, boardId: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    const db = await getDb();
    const [a] = await db.select().from(schema.socialAccounts).where(and(eq(schema.socialAccounts.id, accountId), eq(schema.socialAccounts.brandId, brandId)));
    if (!a) throw new Error("Account not found");
    await db.update(schema.socialAccounts).set({ meta: { ...a.meta, boardId } }).where(eq(schema.socialAccounts.id, accountId));
    revalidatePath("/accounts");
  });
}

/** Emergency pause: stop all publishing for the brand at once (editors and above). */
export async function pausePublishing(brandId: string, reason: string) {
  return safe(async () => {
    const r = await pausePublishingFor(await currentSession(), brandId, reason);
    revalidatePath("/", "layout");
    return r;
  });
}

/** Resume publishing (admins and owners). Missed posts go back to "approved" for rescheduling. */
export async function resumePublishing(brandId: string) {
  return safe(async () => {
    const r = await resumePublishingFor(await currentSession(), brandId);
    revalidatePath("/", "layout");
    return r;
  });
}

async function currentSession() {
  const s = await getSession();
  if (!s) throw new AccessError("Not signed in.");
  return s;
}
