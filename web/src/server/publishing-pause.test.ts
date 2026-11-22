import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-pause-"));
process.env.APP_URL = "https://app.example.com";

const { getDb, schema } = await import("./db/client");
const { encrypt } = await import("./crypto");
const { enqueue } = await import("./jobs/queue");
const { pausePublishingFor, resumePublishingFor, assertNotPaused, PublishingPausedError } = await import("./publishing-pause");
const { publishPost } = await import("./social/service");
const { AccessError } = await import("./auth/guard");
type SessionUser = import("./auth/session").SessionUser;

const sess = (id: string): SessionUser => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });
const ids: Record<string, string> = {};
const HOUR = 3600_000;

beforeAll(async () => {
  const db = await getDb();
  for (const n of ["owner", "admin", "editor", "viewer"]) [{ id: ids[n] }] = await db.insert(schema.users).values({ email: `${n}@x.test`, name: n, passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "Kora", plan: "agency" }).returning();
  for (const n of ["owner", "admin", "editor", "viewer"] as const) await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: ids[n], role: n, status: "active" });
  [{ id: ids.brand }] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora Ceramics" }).returning();
  [{ id: ids.other }] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Other brand" }).returning();
  [{ id: ids.creative }] = await db.insert(schema.creatives).values({ brandId: ids.brand, format: "instagram_post", style: "minimalist_luxury", concept: { title: "t", headline: "h" }, visualSource: "typographic" }).returning();
  [{ id: ids.account }] = await db.insert(schema.socialAccounts).values({ brandId: ids.brand, platform: "instagram", externalId: "ig-1", name: "IG", accessTokenEnc: encrypt("t") }).returning();
});

async function post(brandId: string, status: "scheduled" | "approved", at: Date) {
  const db = await getDb();
  const [p] = await db
    .insert(schema.posts)
    .values({ brandId, platform: "instagram", status, scheduledAt: at, approvedAt: new Date(), approvedBy: ids.admin, caption: "Hi", creativeId: brandId === ids.brand ? ids.creative : null, socialAccountId: brandId === ids.brand ? ids.account : null })
    .returning();
  if (status === "scheduled") await enqueue("publish_post", { postId: p.id }, at);
  return p;
}
const queuedFor = async (postId: string) => (await (await getDb()).select().from(schema.jobs).where(and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")))).filter((j) => j.payload.postId === postId);

describe("emergency pause", () => {
  it("viewers can't pause; editors can; queued publishes of that brand only are cancelled; publishing refuses without touching the post", async () => {
    const future = await post(ids.brand, "scheduled", new Date(Date.now() + 2 * HOUR));
    ids.future = future.id;
    const elsewhere = await post(ids.other, "scheduled", new Date(Date.now() + 2 * HOUR));
    await expect(pausePublishingFor(sess(ids.viewer), ids.brand, "")).rejects.toBeInstanceOf(AccessError);

    const r = await pausePublishingFor(sess(ids.editor), ids.brand, "Checking the campaign");
    expect(r).toEqual({ alreadyPaused: false, cancelledJobs: 1 });
    expect(await queuedFor(future.id)).toEqual([]);
    expect(await queuedFor(elsewhere.id)).toHaveLength(1); // other brands keep publishing
    const db = await getDb();
    const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, ids.brand));
    expect(b).toMatchObject({ publishingPausedBy: ids.editor, publishingPauseReason: "Checking the campaign" });
    expect(() => assertNotPaused(b)).toThrow(PublishingPausedError);
    expect(await pausePublishingFor(sess(ids.admin), ids.brand, "")).toEqual({ alreadyPaused: true, cancelledJobs: 0 });

    // Even a job that slipped through (or "publish now") is refused, and no platform is called.
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      throw new Error("no platform call expected");
    }) as typeof fetch;
    try {
      expect(await publishPost(future.id)).toMatchObject({ ok: false, paused: true, error: expect.stringMatching(/Publishing is paused for Kora Ceramics/) });
    } finally {
      globalThis.fetch = real;
    }
    expect(called).toBe(0);
    const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, future.id));
    expect(p.status).toBe("scheduled"); // unchanged, so resuming can pick it up
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "publishing.pause"));
    expect(ev).toMatchObject({ brandId: ids.brand, actorUserId: ids.editor, details: { cancelledJobs: 1, reason: "given" } });
  });

  it("only admins resume; future posts are queued again at their time, missed ones go back to approved", async () => {
    const db = await getDb();
    const now = new Date();
    const missed = await post(ids.brand, "scheduled", new Date(now.getTime() - HOUR));
    await db.delete(schema.jobs).where(eq(schema.jobs.type, "publish_post")); // as if cancelled by the pause
    const [future] = await db.select().from(schema.posts).where(eq(schema.posts.id, ids.future));
    await expect(resumePublishingFor(sess(ids.editor), ids.brand)).rejects.toBeInstanceOf(AccessError);

    expect(await resumePublishingFor(sess(ids.admin), ids.brand, now)).toEqual({ requeued: 1, unscheduled: 1 });
    const jobs = await queuedFor(future.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.getTime()).toBe(future.scheduledAt!.getTime());
    const [m] = await db.select().from(schema.posts).where(eq(schema.posts.id, missed.id));
    expect(m.status).toBe("approved");
    expect(await queuedFor(missed.id)).toEqual([]);
    const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, ids.brand));
    expect(b).toMatchObject({ publishingPausedAt: null, publishingPausedBy: null, publishingPauseReason: null });
    expect(await resumePublishingFor(sess(ids.admin), ids.brand)).toEqual({ requeued: 0, unscheduled: 0 });
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "publishing.resume"));
    expect(ev).toMatchObject({ actorUserId: ids.admin, details: { requeued: 1, unscheduled: 1 } });
  });
});
