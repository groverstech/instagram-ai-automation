"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { approvePost, publishPost, syncMetrics } from "@/server/social/service";
import { enqueue, cancelJobs } from "@/server/jobs/queue";
import { remember } from "@/server/memory";
import { provider } from "@/server/social/registry";

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
    await requireBrand(brandId, "editor");
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
    const contentChanged = (v.caption !== undefined && v.caption !== p.caption) || v.creativeId !== undefined || v.platform !== undefined;
    // Editing approved content sends it back through approval.
    const status = contentChanged && ["approved", "scheduled", "failed"].includes(p.status) ? "pending_approval" : p.status;
    if (status !== p.status && p.status === "scheduled") await cancelJobs("publish_post", (j) => j.postId === postId);
    await db
      .update(schema.posts)
      .set({ ...v, scheduledAt: v.scheduledAt ? new Date(v.scheduledAt) : undefined, status, ...(status === "pending_approval" ? { approvedAt: null, approvedBy: null } : {}) })
      .where(eq(schema.posts.id, postId));
    if (v.caption && p.caption && v.caption !== p.caption && p.caption.length > 20) {
      await remember(brandId, [{ kind: "feedback", content: `User rewrote an AI caption. Before: "${p.caption.slice(0, 200)}" After: "${v.caption.slice(0, 200)}"`, source: "post:edit", weight: 1.3 }]);
    }
    refresh();
  });
}

export async function movePost(brandId: string, postId: string, isoDate: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const p = await ownPost(brandId, postId);
    if (["publishing", "published"].includes(p.status)) throw new Error("Published posts can't be moved.");
    const target = new Date(isoDate);
    const prev = p.scheduledAt ?? new Date();
    target.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
    const db = await getDb();
    await db.update(schema.posts).set({ scheduledAt: target }).where(eq(schema.posts.id, postId));
    if (p.status === "scheduled") {
      await cancelJobs("publish_post", (j) => j.postId === postId);
      await enqueue("publish_post", { postId }, target);
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

export async function approvePostAction(brandId: string, postId: string) {
  return safe(async () => {
    const { session } = await requireBrand(brandId, "admin");
    const p = await ownPost(brandId, postId);
    if (!p.caption) throw new Error("A post needs a caption before it can be approved.");
    await approvePost(brandId, postId, session.user.id);
    refresh();
  });
}

export async function rejectPost(brandId: string, postId: string, reason: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    await ownPost(brandId, postId);
    const db = await getDb();
    await db.update(schema.posts).set({ status: "draft", approvedAt: null, approvedBy: null }).where(eq(schema.posts.id, postId));
    if (reason.trim()) await remember(brandId, [{ kind: "feedback", content: `Post sent back: ${reason.trim()}`, source: "post:rejected", weight: 1.4 }]);
    refresh();
  });
}

/** Human checkpoint: only admins schedule, only approved posts, only to a connected account. */
export async function schedulePost(brandId: string, postId: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
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
    await requireBrand(brandId, "admin");
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
    await requireBrand(brandId, "admin");
    const db = await getDb();
    await db.delete(schema.socialAccounts).where(and(eq(schema.socialAccounts.id, accountId), eq(schema.socialAccounts.brandId, brandId)));
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
