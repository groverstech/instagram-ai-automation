import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-deletion-"));

const { getDb, schema } = await import("./db/client");
const { hashPassword } = await import("./auth/password");
const { storage, StorageKeyError } = await import("./storage");
const { enqueue } = await import("./jobs/queue");
const { encrypt } = await import("./crypto");
const { deleteBrandFor, deleteWorkspaceFor, deleteAccountFor, accountDeletionPlan } = await import("./deletion");
const { AccessError } = await import("./auth/guard");
type SessionUser = import("./auth/session").SessionUser;

const PW = "correct horse battery";
const sess = (id: string): SessionUser => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });
let n = 0;

async function user(name: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${n++}@x.test`, name, passwordHash: await hashPassword(PW) }).returning();
  return u;
}
async function org(name: string, members: [string, "owner" | "admin" | "editor" | "viewer", (string[] | null)?][], extra: Partial<typeof schema.workspaces.$inferInsert> = {}) {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name, plan: "agency", ...extra }).returning();
  for (const [userId, role, brandIds] of members) await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId, role, brandIds: brandIds ?? null, status: "active" });
  return w;
}
/** A brand with data in most of its tables and two stored files. */
async function brand(workspaceId: string, name: string, userId: string) {
  const db = await getDb();
  const [b] = await db.insert(schema.brands).values({ workspaceId, name }).returning();
  await storage.put(`brands/${b.id}/assets/logo.png`, Buffer.from("logo"), "image/png");
  await storage.put(`brands/${b.id}/creatives/c1.png`, Buffer.from("img"), "image/png");
  await db.insert(schema.brandAssets).values({ brandId: b.id, kind: "logo", name: "logo", path: `brands/${b.id}/assets/logo.png`, mime: "image/png", size: 4 });
  const [c] = await db.insert(schema.creatives).values({ brandId: b.id, format: "instagram_post", style: "minimalist_luxury", concept: { title: "t" }, visualSource: "typographic" }).returning();
  const [acct] = await db.insert(schema.socialAccounts).values({ brandId: b.id, platform: "instagram", externalId: `ig-${b.id}`, name: "IG", accessTokenEnc: encrypt("t") }).returning();
  await db.insert(schema.accountMetrics).values({ socialAccountId: acct.id, date: "2026-11-20", followers: 10 });
  const [post] = await db.insert(schema.posts).values({ brandId: b.id, platform: "instagram", status: "scheduled", socialAccountId: acct.id, creativeId: c.id, caption: "Hello" }).returning();
  await db.insert(schema.postMetrics).values({ postId: post.id, likes: 3, source: "platform" });
  await db.insert(schema.assistantMessages).values({ brandId: b.id, userId, role: "user", content: "hi" });
  await enqueue("publish_post", { postId: post.id }, new Date(Date.now() + 3600_000));
  await enqueue("sync_metrics", { brandId: b.id });
  await db.insert(schema.usageEvents).values({ workspaceId, brandId: b.id, route: "brand.qa", provider: "anthropic", kind: "text", outcome: "success", costUsd: 0.01 });
  return { brand: b, post, creative: c, account: acct };
}
const count = async (t: Parameters<Awaited<ReturnType<typeof getDb>>["$count"]>[0], where?: Parameters<Awaited<ReturnType<typeof getDb>>["$count"]>[1]) => (await getDb()).$count(t, where);

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});

describe("deleting a brand", () => {
  it("removes every row and file of that brand only, cancels its jobs, and keeps the usage ledger and Security log", async () => {
    const db = await getDb();
    const owner = await user("owner");
    const w = await org("Kora", [[owner.id, "owner"]]);
    const a = await brand(w.id, "Kora Ceramics", owner.id);
    const b = await brand(w.id, "Kora Studio", owner.id);
    await db.insert(schema.sessions).values({ id: "sess-owner", userId: owner.id, activeBrandId: a.brand.id, expiresAt: new Date(Date.now() + 3600_000) });

    await expect(deleteBrandFor(sess(owner.id), a.brand.id, "kora ceramics")).rejects.toThrow(/Type the brand's name exactly/);
    expect(await count(schema.brands, eq(schema.brands.id, a.brand.id))).toBe(1);

    expect(await deleteBrandFor(sess(owner.id), a.brand.id, " Kora Ceramics ")).toEqual({ filesRemoved: true });
    for (const t of [schema.brandAssets, schema.creatives, schema.posts, schema.socialAccounts, schema.assistantMessages] as const) {
      expect(await count(t, eq(t.brandId, a.brand.id))).toBe(0);
    }
    expect(await count(schema.postMetrics, eq(schema.postMetrics.postId, a.post.id))).toBe(0);
    expect(await count(schema.accountMetrics, eq(schema.accountMetrics.socialAccountId, a.account.id))).toBe(0);
    expect(await storage.exists(`brands/${a.brand.id}/assets/logo.png`)).toBe(false);
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, "brands", a.brand.id))).toBe(false);
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.filter((j) => j.payload.postId === a.post.id || j.payload.brandId === a.brand.id)).toEqual([]);
    // The other brand is untouched.
    expect(await count(schema.posts, eq(schema.posts.brandId, b.brand.id))).toBe(1);
    expect(await storage.exists(`brands/${b.brand.id}/assets/logo.png`)).toBe(true);
    expect(jobs.some((j) => j.payload.postId === b.post.id)).toBe(true);
    // Kept: the usage ledger and the Security log; the session no longer points at the brand.
    expect(await count(schema.usageEvents, eq(schema.usageEvents.brandId, a.brand.id))).toBe(1);
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "brand.delete"));
    expect(ev).toMatchObject({ workspaceId: w.id, brandId: a.brand.id, actorUserId: owner.id });
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, "sess-owner"));
    expect(s.activeBrandId).toBeNull();
  });

  it("only owners and admins with access to every brand can delete; running AI jobs and publishing block it", async () => {
    const db = await getDb();
    const owner = await user("o");
    const editor = await user("e");
    const client = await user("c");
    const w = await org("Org", [[owner.id, "owner"], [editor.id, "editor"], [client.id, "admin", []]]);
    const { brand: b } = await brand(w.id, "Brand X", owner.id);
    await db.update(schema.workspaceMembers).set({ brandIds: [b.id] }).where(eq(schema.workspaceMembers.userId, client.id));
    await expect(deleteBrandFor(sess(editor.id), b.id, "Brand X")).rejects.toBeInstanceOf(AccessError);
    await expect(deleteBrandFor(sess(client.id), b.id, "Brand X")).rejects.toBeInstanceOf(AccessError);
    const [task] = await db.insert(schema.aiTasks).values({ brandId: b.id, workspaceId: w.id, userId: owner.id, kind: "creative_batch", status: "running" }).returning();
    await expect(deleteBrandFor(sess(owner.id), b.id, "Brand X")).rejects.toThrow(/AI job is still running for Brand X/);
    await db.update(schema.aiTasks).set({ status: "succeeded" }).where(eq(schema.aiTasks.id, task.id));
    await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.brandId, b.id));
    await expect(deleteBrandFor(sess(owner.id), b.id, "Brand X")).rejects.toThrow(/being published right now/);
    expect(await count(schema.brands, eq(schema.brands.id, b.id))).toBe(1);
  });
});

describe("deleting an organisation", () => {
  it("owners only, with their password; refused while a subscription is active; then everything goes", async () => {
    const db = await getDb();
    const owner = await user("owner");
    const admin = await user("admin");
    const w = await org("Acme", [[owner.id, "owner"], [admin.id, "admin"]], { stripeSubscriptionId: "sub_1", subscriptionStatus: "active" });
    const one = await brand(w.id, "One", owner.id);
    const two = await brand(w.id, "Two", owner.id);
    await expect(deleteWorkspaceFor(sess(admin.id), w.id, PW)).rejects.toBeInstanceOf(AccessError);
    await expect(deleteWorkspaceFor(sess(owner.id), w.id, "wrong")).rejects.toThrow(/password isn't right/);
    await expect(deleteWorkspaceFor(sess(owner.id), w.id, PW)).rejects.toThrow(/active subscription/);
    await db.update(schema.workspaces).set({ subscriptionStatus: "canceled" }).where(eq(schema.workspaces.id, w.id));
    expect(await deleteWorkspaceFor(sess(owner.id), w.id, PW)).toEqual({ brands: 2, filesRemoved: true });
    expect(await count(schema.workspaces, eq(schema.workspaces.id, w.id))).toBe(0);
    expect(await count(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, w.id))).toBe(0);
    expect(await count(schema.brands, eq(schema.brands.workspaceId, w.id))).toBe(0);
    for (const x of [one, two]) expect(await storage.exists(`brands/${x.brand.id}/creatives/c1.png`)).toBe(false);
    expect(await count(schema.users, eq(schema.users.id, admin.id))).toBe(1); // members keep their accounts
    expect(await count(schema.auditEvents, eq(schema.auditEvents.action, "workspace.delete"))).toBeGreaterThan(0);
  });

  it("password guesses are rate-limited", async () => {
    const owner = await user("guesser");
    const w = await org("Guess", [[owner.id, "owner"]]);
    for (let i = 0; i < 10; i++) await expect(deleteWorkspaceFor(sess(owner.id), w.id, `wrong-${i}`)).rejects.toThrow(/password isn't right/);
    await expect(deleteWorkspaceFor(sess(owner.id), w.id, PW)).rejects.toThrow(/Too many/i);
  });
});

describe("deleting your account", () => {
  it("shows the plan, refuses while you're the only owner of a shared organisation, then deletes and leaves as planned", async () => {
    const db = await getDb();
    const me = await user("me");
    const other = await user("other");
    const solo = await org("Solo", [[me.id, "owner"]]);
    const shared = await org("Shared", [[me.id, "admin"], [other.id, "owner"]]);
    const mineShared = await org("Mine shared", [[me.id, "owner"], [other.id, "editor"]]);
    const soloBrand = await brand(solo.id, "Solo brand", me.id);
    const sharedBrand = await brand(shared.id, "Shared brand", other.id);

    const plan = await accountDeletionPlan(me.id);
    expect(plan.deleted.map((w) => w.name)).toEqual(["Solo"]);
    expect(plan.left.map((w) => w.name)).toEqual(["Shared"]);
    expect(plan.blocked.map((w) => w.name)).toEqual(["Mine shared"]);
    await expect(deleteAccountFor(sess(me.id), PW)).rejects.toThrow(/Make another member an owner of Mine shared/);
    expect(await count(schema.users, eq(schema.users.id, me.id))).toBe(1);

    await db.update(schema.workspaceMembers).set({ role: "owner" }).where(eq(schema.workspaceMembers.userId, other.id));
    await expect(deleteAccountFor(sess(me.id), "wrong")).rejects.toThrow(/password isn't right/);
    const done = await deleteAccountFor(sess(me.id), PW);
    expect(done.deleted.map((w) => w.name)).toEqual(["Solo"]);
    expect(await count(schema.users, eq(schema.users.id, me.id))).toBe(0);
    expect(await count(schema.workspaceMembers, eq(schema.workspaceMembers.userId, me.id))).toBe(0);
    expect(await count(schema.workspaces, eq(schema.workspaces.id, solo.id))).toBe(0);
    expect(await storage.exists(`brands/${soloBrand.brand.id}/assets/logo.png`)).toBe(false);
    // Shared organisations stay, with their brands and other members.
    expect(await count(schema.workspaces, eq(schema.workspaces.id, shared.id))).toBe(1);
    expect(await count(schema.workspaces, eq(schema.workspaces.id, mineShared.id))).toBe(1);
    expect(await count(schema.brands, eq(schema.brands.id, sharedBrand.brand.id))).toBe(1);
    const left = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "member.remove"));
    expect(left.map((e) => e.workspaceId)).toEqual(expect.arrayContaining([shared.id, mineShared.id]));
    expect(await count(schema.auditEvents, eq(schema.auditEvents.action, "account.delete"))).toBe(1);
  });
});

describe("storage prefix deletion", () => {
  it("refuses shallow or unsafe prefixes so a mistake can't empty the store", async () => {
    for (const bad of ["brands", "", "/brands/x", "brands/../x", "brands//x", "../outside/x"]) {
      await expect(storage.removePrefix(bad)).rejects.toBeInstanceOf(StorageKeyError);
    }
    await expect(storage.removePrefix("brands/does-not-exist")).resolves.toBeUndefined();
  });
});

