import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jobs-"));

const { getDb, schema } = await import("./db/client");
const { saveAccounts, publishPost } = await import("./social/service");
const { PROVIDERS } = await import("./social/registry");
const { runDueJobs } = await import("./jobs/queue");
const { handlers, interruptedHooks } = await import("./jobs/handlers");

let brandId = "";
let userId = "";
let creativeId = "";
let accountId = "";

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "j@x.test", name: "J", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "Jobs" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role: "owner" });
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora", platforms: ["linkedin"], colors: ["#2B2620", "#F3EDE4"] }).returning();
  const [c] = await db
    .insert(schema.creatives)
    .values({ brandId: b.id, format: "linkedin_post", style: "minimalist_luxury", visualSource: "typographic", concept: { title: "T", headline: "Made to last", subline: "Stoneware", cta: "Shop", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" } })
    .returning();
  await saveAccounts(b.id, u.id, [{ platform: "linkedin", externalId: "urn:li:person:1", name: "Kora", token: { accessToken: "test-token" } }]);
  const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id));
  brandId = b.id;
  userId = u.id;
  creativeId = c.id;
  accountId = a.id;
});
afterEach(() => vi.restoreAllMocks());

async function approvedPost() {
  const db = await getDb();
  const [p] = await db
    .insert(schema.posts)
    .values({ brandId, platform: "linkedin", format: "linkedin_post", status: "approved", approvedAt: new Date(), approvedBy: userId, creativeId, socialAccountId: accountId, caption: "Hello" })
    .returning();
  return p;
}

/** Count calls to the platform; nothing leaves the test. */
function stubLinkedIn(delayMs = 50) {
  let n = 0;
  vi.spyOn(PROVIDERS.linkedin, "publish").mockImplementation(async () => {
    n++;
    await new Promise((r) => setTimeout(r, delayMs));
    return { externalId: `urn:li:share:${n}`, url: "https://www.linkedin.com/feed/update/x" };
  });
  return () => n;
}

describe("duplicate-publishing protection", () => {
  it("publishes exactly once when 'publish now' and the scheduler race for the same post", async () => {
    const calls = stubLinkedIn();
    const post = await approvedPost();
    const results = await Promise.all([publishPost(post.id), publishPost(post.id), publishPost(post.id)]);
    expect(calls()).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && /already being published/.test(r.error))).toBe(true);
    const db = await getDb();
    const [after] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(after).toMatchObject({ status: "published", externalId: "urn:li:share:1" });
  });

  it("never re-sends a publish whose worker died mid-flight; the post is flagged for a human check", async () => {
    const calls = stubLinkedIn();
    const post = await approvedPost();
    const db = await getDb();
    // The previous worker claimed the job, moved the post to "publishing", then died.
    await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, post.id));
    const [job] = await db
      .insert(schema.jobs)
      .values({ type: "publish_post", payload: { postId: post.id }, status: "running", lockedAt: new Date(Date.now() - 11 * 60 * 1000), attempts: 1, runAt: new Date(Date.now() - 12 * 60 * 1000) })
      .returning();
    const res = await runDueJobs(handlers, 10, interruptedHooks);
    expect(res.find((r) => r.id === job.id)).toMatchObject({ ok: false, error: "interrupted" });
    expect(calls()).toBe(0);
    const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(p.status).toBe("failed");
    expect(p.publishError).toMatch(/interrupted.*Check the account/);
    const [j] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(j.status).toBe("failed");
  });

  it("still retries interrupted jobs that are safe to repeat (metric syncs)", async () => {
    const db = await getDb();
    const sync = vi.spyOn(handlers, "sync_metrics").mockResolvedValue(undefined as never);
    const [job] = await db
      .insert(schema.jobs)
      .values({ type: "sync_metrics", payload: { brandId }, status: "running", lockedAt: new Date(Date.now() - 11 * 60 * 1000), attempts: 1, runAt: new Date(Date.now() - 12 * 60 * 1000) })
      .returning();
    const res = await runDueJobs({ ...handlers, sync_metrics: handlers.sync_metrics }, 10, interruptedHooks);
    expect(res.find((r) => r.id === job.id)?.ok).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("a normal publish job still publishes", async () => {
    const calls = stubLinkedIn(1);
    const post = await approvedPost();
    const db = await getDb();
    const [job] = await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: post.id }, runAt: new Date(Date.now() - 1000) }).returning();
    const res = await runDueJobs(handlers, 10, interruptedHooks);
    expect(res.find((r) => r.id === job.id)?.ok).toBe(true);
    expect(calls()).toBe(1);
  });
});
