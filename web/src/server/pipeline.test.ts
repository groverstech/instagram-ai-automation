import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";

const { getDb, schema } = await import("./db/client");
const { generateBrandProfile, approveProfile } = await import("./agents/brand");
const { planCalendar } = await import("./agents/strategy");
const { createStrategy, getStrategy, docOf } = await import("./strategist/store");
const { startTask } = await import("./strategist/workflow");
const { requireBrandForUser } = await import("./auth/guard");
const { SECTION_KEYS, StrategyInputs } = await import("@/lib/strategy");
const { createCampaign } = await import("./agents/campaign");
const { generateCreatives, setCreativeStatus } = await import("./agents/creative");
const { recall } = await import("./memory");
const { summarize } = await import("./agents/analytics");
const { publishPost, approvePost } = await import("./social/service");
const { encrypt, decrypt, sign, verify } = await import("./crypto");
const { hashEmbed } = await import("./ai/embeddings");

let brandId = "";
let userId = "";

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "t@example.com", name: "T", passwordHash: "x" }).returning();
  const [ws] = await db.insert(schema.workspaces).values({ name: "WS" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: "owner" });
  const [b] = await db
    .insert(schema.brands)
    .values({ workspaceId: ws.id, name: "Kora Ceramics", industry: "Home goods", products: "Mugs, bowls", platforms: ["instagram", "pinterest"], colors: ["#2B2620", "#F3EDE4", "#B5643C"], competitors: ["ClayCo"] })
    .returning();
  brandId = b.id;
  userId = u.id;
});

describe("agent pipeline (mock provider)", () => {
  it("generates, approves a brand profile and seeds memory", async () => {
    const db = await getDb();
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const { profile: p } = await generateBrandProfile({ brandId, userId }, brand);
    expect(p.status).toBe("draft");
    expect(p.version).toBe(1);
    await approveProfile(brandId, p.id, userId);
    const { setSectionStatus } = await import("./agents/brand");
    await setSectionStatus(brandId, p.id, "communication", "confirmed");
    const mem = await recall(brandId, "voice tone copy rules", 5);
    expect(mem.length).toBeGreaterThan(0);
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, brandId));
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("builds strategy, calendar and a campaign with drafts only", async () => {
    const db = await getDb();
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "t@example.com", name: "T" } }, brandId, "editor");
    const inputs = StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow online sales"], platforms: ["instagram", "pinterest"], startDate: "2026-12-01", postsPerWeek: 5 });
    const created = await createStrategy(brandId, userId, inputs, [], null);
    await startTask(access, created.id, { sections: [...SECTION_KEYS], inline: true });
    const s = (await getStrategy(brandId, created.id))!;
    expect(s.month).toBe("2026-12");
    expect(Object.keys(docOf(s).sections).sort()).toEqual([...SECTION_KEYS].sort());
    const cal = await planCalendar({ brandId, userId }, brand, { start: new Date("2026-12-01"), days: 14 });
    expect(cal.postIds.length).toBeGreaterThan(3);
    const camp = await createCampaign({ brandId, userId }, brand, { brief: "Winter glaze launch", type: "launch", objective: "awareness", start: new Date("2026-12-05"), days: 10, produceFirst: 2 });
    const posts = await db.select().from(schema.posts).where(eq(schema.posts.campaignId, camp.campaignId));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.status === "draft")).toBe(true);
    expect(posts.filter((p) => p.creativeId && p.caption).length).toBe(2);
  });

  it("generates creative variations and records feedback", async () => {
    const db = await getDb();
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const ids = await generateCreatives({ brandId, userId }, brand, { brief: "Holiday gift set", format: "instagram_story", style: "luxury_lifestyle", count: 3 });
    expect(ids).toHaveLength(3);
    const c = await setCreativeStatus(brandId, ids[0], "approved");
    expect(c?.status).toBe("approved");
    const { renderCreativePng } = await import("./creative/render");
    const all = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, brandId));
    for (const cr of all.slice(0, 6)) {
      const png = await renderCreativePng(cr, brand, "instagram_square");
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
  });

  it("refuses to publish unapproved posts and fails honestly without an account", async () => {
    const db = await getDb();
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.brandId, brandId)).limit(1);
    await expect(publishPost(post.id)).rejects.toThrow(/approved/);
    await approvePost(brandId, post.id, userId);
    const r = await publishPost(post.id);
    expect(r.ok).toBe(false);
    const [after] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(after.status).toBe("failed");
    expect(after.externalId).toBeNull();
  });
});

describe("utilities", () => {
  it("encrypts and signs", () => {
    expect(decrypt(encrypt("token-123"))).toBe("token-123");
    const t = sign({ c: "abc", exp: Date.now() + 1000 });
    expect(verify<{ c: string }>(t)?.c).toBe("abc");
    expect(verify(t.slice(0, -2) + "xx")).toBeNull();
    expect(verify(sign({ exp: Date.now() - 1 }))).toBeNull();
  });
  it("hash embeddings rank lexical overlap", () => {
    const q = hashEmbed("warm minimal ceramic mugs");
    const a = hashEmbed("minimal ceramic mugs in warm light");
    const b = hashEmbed("quarterly B2B SaaS pricing update");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(q, a)).toBeGreaterThan(dot(q, b));
  });
  it("aggregates performance by pillar", () => {
    const base = { platform: "instagram", objective: null, style: null, layout: null, captionLength: 100, publishedAt: null, hour: 19, campaign: null, impressions: null, likes: null, comments: null, shares: null, saves: null, videoViews: null };
    const s = summarize([
      { ...base, postId: "1", pillar: "A", reach: 100, engagementRate: 0.05 },
      { ...base, postId: "2", pillar: "A", reach: 300, engagementRate: 0.07 },
      { ...base, postId: "3", pillar: "B", reach: 200, engagementRate: 0.02 },
    ]);
    expect(s.byPillar[0].key).toBe("A");
    expect(s.byPillar[0].avgReach).toBe(200);
    expect(s.byPillar[0].avgEngagementRate).toBeCloseTo(0.06);
  });
});

describe("tenant isolation", () => {
  it("denies brand access to users outside the workspace and enforces roles", async () => {
    const { requireBrandForUser } = await import("./auth/guard");
    const db = await getDb();
    const [outsider] = await db.insert(schema.users).values({ email: "o@example.com", name: "O", passwordHash: "x" }).returning();
    const sess = (id: string) => ({ sessionId: "s", activeBrandId: null, user: { id, email: "", name: "" } });
    await expect(requireBrandForUser(sess(outsider.id), brandId, "viewer")).rejects.toThrow();
    const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    await db.insert(schema.workspaceMembers).values({ workspaceId: b.workspaceId, userId: outsider.id, role: "viewer" });
    await expect(requireBrandForUser(sess(outsider.id), brandId, "viewer")).resolves.toBeTruthy();
    await expect(requireBrandForUser(sess(outsider.id), brandId, "editor")).rejects.toThrow(/editor/);
  });
});
