/**
 * Autonomy end to end on the simulated platform (SOCIAL_SANDBOX): the policy in the scheduler
 * tick and again in the publish claim, Advisor refusals, the platform switch, pause, rule changes,
 * caps under parallel passes, automatic suspension and the decision log. Nothing leaves the test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.IMAGE_PROVIDER = "none";
process.env.SOCIAL_SANDBOX = "true";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-autonomy-"));
delete process.env.DEPLOY_ENV;

const { getDb, schema } = await import("./db/client");
const { saveAccounts, publishPost } = await import("./social/service");
const { autonomyTick, updateAutonomy, assertAiMayDraft, AutonomyError, autonomyView, suspendAutonomy } = await import("./autonomy/service");

const day = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
let ws = "";
let brandId = "";
let ownerId = "";
let accountId = "";
let creativeId = "";

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "auto@x.test", name: "Owner", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "Auto" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora", platforms: ["instagram"], competitors: ["Acme Pottery"] }).returning();
  const [c] = await db
    .insert(schema.creatives)
    .values({ brandId: b.id, format: "ig_feed_square", style: "minimalist_luxury", visualSource: "typographic", concept: { title: "T", headline: "Made to last", subline: "", cta: "", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" } })
    .returning();
  await saveAccounts(b.id, u.id, [{ platform: "instagram", externalId: "sandbox-ig", name: "Kora IG", token: { accessToken: "sandbox-token" } }]);
  const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id));
  ws = w.id;
  brandId = b.id;
  ownerId = u.id;
  accountId = a.id;
  creativeId = c.id;
});

beforeEach(async () => {
  const db = await getDb();
  process.env.AUTONOMOUS_PUBLISHING = "on";
  await db.delete(schema.posts).where(eq(schema.posts.brandId, brandId));
  await db.update(schema.brands).set({ autonomyLevel: "assisted", autonomyRules: {}, autonomySuspendedAt: null, autonomySuspendedReason: null, publishingPausedAt: null }).where(eq(schema.brands.id, brandId));
  await db.update(schema.socialAccounts).set({ autonomyLevel: null, expiresAt: null, status: "active" }).where(eq(schema.socialAccounts.id, accountId));
});
afterEach(() => {
  delete process.env.AUTONOMOUS_PUBLISHING;
});

async function aiPost(o: { at: Date; caption?: string; origin?: string }) {
  const db = await getDb();
  const [p] = await db
    .insert(schema.posts)
    .values({ brandId, platform: "instagram", title: "AI post", caption: o.caption ?? "Slow mornings, hand-thrown mugs.", creativeId, socialAccountId: accountId, scheduledAt: o.at, status: "draft", origin: o.origin ?? "ai", pillar: "craft" })
    .returning();
  return p;
}
const get = async (id: string) => (await (await getDb()).select().from(schema.posts).where(eq(schema.posts.id, id)))[0];
const attempts = async (id: string) => (await getDb()).select().from(schema.publishAttempts).where(eq(schema.publishAttempts.postId, id));
const autonomous = (rules: Record<string, unknown> = {}) => updateAutonomy(brandId, { userId: ownerId }, { level: "autonomous", rules: { warmup: 0, ...rules } });

describe("autonomy on the simulated platform", () => {
  it("platform switch off: Autonomous can't be chosen, a brand set to it behaves as Assisted, nothing is auto-approved", async () => {
    process.env.AUTONOMOUS_PUBLISHING = "off";
    await expect(autonomous()).rejects.toThrow(/isn't available yet/);
    const db = await getDb();
    await db.update(schema.brands).set({ autonomyLevel: "autonomous" }).where(eq(schema.brands.id, brandId)); // e.g. set before the switch went off
    const p = await aiPost({ at: day("2027-03-03", 10) });
    expect(await autonomyTick()).toEqual({ scheduled: 0, toPerson: 0 });
    expect((await get(p.id)).status).toBe("draft");
    // Even a post that somehow carries a policy approval doesn't publish: it goes back to a person.
    await db.update(schema.posts).set({ status: "scheduled", approvedAt: new Date(), autoApprovedVersion: 1 }).where(eq(schema.posts.id, p.id));
    const r = await publishPost(p.id);
    expect(r.ok).toBe(false);
    expect((await get(p.id)).status).toBe("pending_approval");
    expect(await attempts(p.id)).toEqual([]); // nothing sent
    expect((await autonomyView(brandId)).effective).toBe("assisted");
  });

  it("Assisted (the default): the AI's drafts wait for a person; Advisor refuses AI drafts outright", async () => {
    const p = await aiPost({ at: day("2027-03-03", 10) });
    await autonomyTick();
    expect((await get(p.id)).status).toBe("draft");
    await expect(assertAiMayDraft(brandId, "plan")).resolves.toBeUndefined();
    await updateAutonomy(brandId, { userId: ownerId }, { level: "advisor" });
    await expect(assertAiMayDraft(brandId, "plan the content calendar")).rejects.toBeInstanceOf(AutonomyError);
    // A person's own approved post still publishes under Advisor (publishing stays a human decision).
    const db = await getDb();
    await db.update(schema.posts).set({ status: "approved", approvedAt: new Date(), approvedBy: ownerId }).where(eq(schema.posts.id, p.id));
    const r = await publishPost(p.id);
    expect(r.ok).toBe(true);
    expect((await get(p.id)).status).toBe("published");
  });

  it("Autonomous: allowed content is scheduled by the policy and published through the simulated platform; restricted content waits", async () => {
    await autonomous();
    const ok = await aiPost({ at: day("2027-03-03", 10) });
    const promo = await aiPost({ at: day("2027-03-04", 10), caption: "20% off all mugs this week" });
    const rival = await aiPost({ at: day("2027-03-05", 10), caption: "Why we're better than Acme Pottery" });
    const human = await aiPost({ at: day("2027-03-08", 10), origin: "human" });
    expect(await autonomyTick()).toEqual({ scheduled: 1, toPerson: 2 });
    const okRow = await get(ok.id);
    expect(okRow).toMatchObject({ status: "scheduled", approvedBy: null });
    expect(okRow.autoApprovedVersion).toBe(2); // rules were changed once (version 1 → 2)
    expect((await get(promo.id)).status).toBe("pending_approval");
    expect((await get(promo.id)).rationale).toMatch(/Needs a person: .*prices_promotions/);
    expect((await get(rival.id)).status).toBe("pending_approval");
    expect((await get(human.id)).status).toBe("draft"); // a person's post is never approved by the policy
    // Publish: checked again in the claim, then sent to the sandbox and recorded in the ledger.
    const r = await publishPost(ok.id);
    expect(r.ok).toBe(true);
    expect(await get(ok.id)).toMatchObject({ status: "published" });
    expect((await attempts(ok.id)).map((a) => a.status)).toEqual(["succeeded"]);
    const db = await getDb();
    const log = await db.select().from(schema.agentActions).where(eq(schema.agentActions.postId, ok.id));
    expect(log.map((l) => [l.action, l.decision]).sort()).toEqual([["auto_approve", "allow"], ["publish", "allow"]]);
    expect(log.every((l) => l.workspaceId === ws && l.policyVersion === 2 && l.contentHash)).toBe(true);
  });

  it("the emergency pause overrides Autonomous: a scheduled post isn't sent, and the tick schedules nothing", async () => {
    await autonomous();
    const p = await aiPost({ at: day("2027-03-03", 10) });
    await autonomyTick();
    expect((await get(p.id)).status).toBe("scheduled");
    const db = await getDb();
    await db.update(schema.brands).set({ publishingPausedAt: new Date() }).where(eq(schema.brands.id, brandId));
    const r = await publishPost(p.id);
    expect(r).toMatchObject({ ok: false, paused: true });
    expect(await attempts(p.id)).toEqual([]);
    const q = await aiPost({ at: day("2027-03-04", 10) });
    expect(await autonomyTick()).toEqual({ scheduled: 0, toPerson: 0 });
    expect((await get(q.id)).status).toBe("draft");
  });

  it("a rule change at publish time sends the post back to a person, unsent; saving new rules returns policy-scheduled posts", async () => {
    await autonomous();
    const p = await aiPost({ at: day("2027-03-03", 10) });
    await autonomyTick();
    const db = await getDb();
    // Rules changed underneath (e.g. hours narrowed) without going through the settings: the claim re-checks.
    await db.update(schema.brands).set({ autonomyRules: { warmup: 0, allowedHours: [18] } }).where(eq(schema.brands.id, brandId));
    const r = await publishPost(p.id);
    expect(r.ok).toBe(false);
    expect(await get(p.id)).toMatchObject({ status: "pending_approval", autoApprovedVersion: null });
    expect(await attempts(p.id)).toEqual([]);
    // Through the settings: a new rules version returns every policy-scheduled post to a person.
    await db.update(schema.brands).set({ autonomyRules: { warmup: 0 } }).where(eq(schema.brands.id, brandId));
    const q = await aiPost({ at: day("2027-03-04", 10) });
    await autonomyTick();
    expect((await get(q.id)).status).toBe("scheduled");
    const changes = await updateAutonomy(brandId, { userId: ownerId }, { rules: { warmup: 0, maxPerDay: 2 } });
    expect(changes.postsReturned).toBe(1);
    expect((await get(q.id)).status).toBe("pending_approval");
    const [audit] = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "autonomy.changed"), eq(schema.auditEvents.brandId, brandId)));
    expect(audit).toBeTruthy();
  });

  it("caps hold under parallel passes: one post per day, never two", async () => {
    await autonomous({ maxPerDay: 1, minGapHours: 0 });
    const posts = await Promise.all([10, 12, 14, 16].map((h) => aiPost({ at: day("2027-03-03", h) })));
    const results = await Promise.all([autonomyTick(), autonomyTick(), autonomyTick()]);
    expect(results.reduce((n, r) => n + r.scheduled, 0)).toBe(1);
    const rows = await Promise.all(posts.map((p) => get(p.id)));
    expect(rows.filter((r) => r.status === "scheduled")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending_approval")).toHaveLength(3);
  });

  it("warm-up: the first posts on an account need a person", async () => {
    await autonomous({ warmup: 1 });
    const p = await aiPost({ at: day("2027-03-03", 10) });
    await autonomyTick();
    expect((await get(p.id)).status).toBe("pending_approval");
    expect((await get(p.id)).rationale).toMatch(/Warm-up/);
  });

  it("an account held at Assisted is never published autonomously", async () => {
    await autonomous();
    await updateAutonomy(brandId, { userId: ownerId }, { accounts: [{ id: accountId, level: "assisted" }] });
    const p = await aiPost({ at: day("2027-03-03", 10) });
    await autonomyTick();
    expect((await get(p.id)).status).toBe("pending_approval");
  });

  it("safeguard: an expired token suspends Autonomous (falls back to Assisted) and returns scheduled posts to a person", async () => {
    await autonomous();
    const a = await aiPost({ at: day("2027-03-03", 10) });
    const b = await aiPost({ at: day("2027-03-04", 10) });
    await autonomyTick();
    const db = await getDb();
    await db.update(schema.socialAccounts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.socialAccounts.id, accountId));
    const r = await publishPost(a.id);
    expect(r.ok).toBe(false);
    const v = await autonomyView(brandId);
    expect(v.suspended?.reason).toMatch(/token expired/);
    expect(v.effective).toBe("assisted");
    expect((await get(b.id)).status).toBe("pending_approval");
    expect(v.recent.some((e) => e.action === "suspend" && e.actorType === "system")).toBe(true);
    // Choosing the level again (an owner has looked) clears the suspension.
    await autonomous();
    expect((await autonomyView(brandId)).suspended).toBeNull();
    expect(await suspendAutonomy(brandId, "test")).toBe(true);
    expect(await suspendAutonomy(brandId, "again")).toBe(false); // once
  });
});
