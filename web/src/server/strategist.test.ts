import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";

const { getDb, schema } = await import("./db/client");
const { generateBrandProfile, approveProfile } = await import("./agents/brand");
const { requireBrandForUser, listAccessibleBrands, AccessError, inBrandScope } = await import("./auth/guard");
const { llm, AIOutputError } = await import("./ai/llm");
const { RateLimitError, acquireAiSlot, releaseAiSlot, RULES } = await import("./ratelimit");
const { preflight } = await import("./strategist/preflight");
const store = await import("./strategist/store");
const wf = await import("./strategist/workflow");
const agents = await import("./strategist/agents");
const { askAdvisor, advisorHistory } = await import("./strategist/advisor");
const { brandChatHistory } = await import("./agents/brand-qa");
const { summarizeStrategy, StrategyInputs, SECTION_KEYS, compareDocs, downstreamOf, calendarIssues, PILLAR_MAX } = await import("@/lib/strategy");
type SessionUser = import("./auth/session").SessionUser;
type Brand = import("./db/schema").Brand;

const session = (id: string): SessionUser => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@example.com`, name: id } });
const inputs = (over: Record<string, unknown> = {}) =>
  StrategyInputs.parse({ accountType: "agency", businessObjectives: ["Grow online sales", "Build awareness in Lisbon"], platforms: ["instagram", "linkedin"], startDate: "2027-01-04", postsPerWeek: 6, campaignKinds: ["seasonal", "launch"], ...over });

let ownerId = "", editorId = "", clientId = "", outsiderId = "";
let A1: Brand, A2: Brand, B1: Brand;
let A1profile = { id: "", version: 0 };

async function user(name: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}@example.com`, name, passwordHash: "x" }).returning();
  return u.id;
}
async function brand(workspaceId: string, name: string, extra: Partial<typeof schema.brands.$inferInsert> = {}) {
  const db = await getDb();
  const [b] = await db.insert(schema.brands).values({ workspaceId, name, industry: "Ceramics", products: "Handmade tableware", targetAudience: "Design-minded home cooks", geography: "Portugal", platforms: ["instagram", "linkedin"], competitors: ["ClayCo"], ...extra }).returning();
  return b;
}
async function approvedProfile(b: Brand, userId: string) {
  const { profile } = await generateBrandProfile({ brandId: b.id, userId }, b);
  await approveProfile(b.id, profile.id, userId);
  return { id: profile.id, version: profile.version };
}
const access = (userId: string, b: Brand, min: "viewer" | "editor" | "admin" = "editor") => requireBrandForUser(session(userId), b.id, min);
const actor = (userId: string, role: "owner" | "admin" | "editor" | "viewer") => ({ userId, role });

async function fullStrategy(b: Brand, userId: string, over: Record<string, unknown> = {}) {
  const pf = await preflight(b);
  const row = await store.createStrategy(b.id, userId, inputs(over), [], pf.profile);
  const taskId = await wf.startTask(await access(userId, b), row.id, { sections: [...SECTION_KEYS], inline: true });
  return { row: (await store.getStrategy(b.id, row.id))!, taskId };
}

beforeAll(async () => {
  const db = await getDb();
  ownerId = await user("owner");
  editorId = await user("editor");
  clientId = await user("client");
  outsiderId = await user("outsider");
  const [wsA] = await db.insert(schema.workspaces).values({ name: "Agency", type: "agency", plan: "agency" }).returning();
  const [wsB] = await db.insert(schema.workspaces).values({ name: "Other", plan: "agency" }).returning();
  A1 = await brand(wsA.id, "Kora Ceramics");
  A2 = await brand(wsA.id, "Northwind Coffee", { industry: "Coffee", competitors: ["BeanCo"] });
  B1 = await brand(wsB.id, "Other Co");
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: wsA.id, userId: ownerId, role: "owner" },
    { workspaceId: wsA.id, userId: editorId, role: "editor" },
    { workspaceId: wsA.id, userId: clientId, role: "editor", brandIds: [A1.id] },
    { workspaceId: wsB.id, userId: outsiderId, role: "owner" },
  ]);
  A1profile = await approvedProfile(A1, ownerId);
  await approvedProfile(A2, ownerId);
  await approvedProfile(B1, outsiderId);
});

// The rate limiter is real (Postgres-backed); reset its counters so tests don't throttle each other.
beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preflight & context retrieval", () => {
  it("blocks generation until the Brand Intelligence Profile is approved", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Fresh", plan: "agency" }).returning();
    const b = await brand(ws.id, "Fresh Co", { targetAudience: null, geography: null, products: null });
    expect((await preflight(b)).blocked).toMatch(/no Brand Intelligence Profile/);
    const { profile } = await generateBrandProfile({ brandId: b.id, userId: ownerId }, b);
    const pf = await preflight(b);
    expect(pf.blocked).toMatch(/hasn't been approved/);
    expect(pf.profile).toBeNull();
    // Missing critical info turns into questions with explicit assumptions.
    expect(pf.questions.filter((q) => q.critical).map((q) => q.id)).toEqual(expect.arrayContaining(["market"]));
    expect(pf.questions.every((q) => q.assumption.length > 0)).toBe(true);
    // Agents themselves refuse to run on an unapproved profile.
    const row = await store.createStrategy(b.id, ownerId, inputs(), [], null);
    await expect(agents.runResearch({ scope: { brandId: b.id, userId: ownerId }, brand: b, doc: store.docOf(row), strategyId: row.id })).rejects.toThrow(/approved Brand Intelligence Profile/);
    await approveProfile(b.id, profile.id, ownerId);
    expect((await preflight(b)).profile).toMatchObject({ id: profile.id });
  });

  it("uses the approved profile even when a newer draft exists, and maps account type from the workspace", async () => {
    const pf = await preflight(A1);
    expect(pf.profile).toEqual(A1profile);
    expect(pf.defaults.accountType).toBe("agency");
    const { profile: draft } = await generateBrandProfile({ brandId: A1.id, userId: ownerId }, A1);
    const pf2 = await preflight(A1);
    expect(pf2.profile).toEqual(A1profile);
    expect(pf2.newerDraft?.id).toBe(draft.id);
    const { buildContext } = await import("./agents/context");
    const ctx = await buildContext(A1, "strategy");
    expect(ctx.profileStatus).toBe("approved");
  });
});

describe("full strategy workflow (mock provider)", () => {
  it("generates every section in order with tracked steps and revisions", async () => {
    const { row, taskId } = await fullStrategy(A1, ownerId);
    const doc = store.docOf(row);
    expect(row.schemaVersion).toBe(2);
    expect(row.status).toBe("draft");
    expect(Object.keys(doc.sections).sort()).toEqual([...SECTION_KEYS].sort());
    const t = await wf.taskStatus(A1.id, taskId);
    expect(t.status).toBe("succeeded");
    expect(t.steps.map((s) => [s.id, s.status])).toEqual(SECTION_KEYS.map((k) => [k, "done"]));
    expect(doc.profileRef).toEqual(A1profile);

    // Research in mock mode never claims sources.
    const r = doc.sections.research!.data;
    expect(r.mode).toBe("no_search");
    expect(r.modeNote).toMatch(/mock/i);
    expect(r.sources).toEqual([]);
    expect(r.findings.every((f) => !f.verified && f.basis === "hypothesis" && f.sourceUrls.length === 0)).toBe(true);

    // Pillars 4–8 summing to 100; personas start unapproved.
    const pillars = doc.sections.pillars!.data.pillars;
    expect(pillars.length).toBeGreaterThanOrEqual(4);
    expect(pillars.length).toBeLessThanOrEqual(8);
    expect(pillars.reduce((s, p) => s + p.sharePercent, 0)).toBe(100);
    expect(doc.sections.audience!.data.personas.every((p) => !p.approved && p.id)).toBe(true);

    // Strategy covers the selected channels only.
    expect(doc.sections.strategy!.data.channels.map((c) => c.platform).sort()).toEqual(["instagram", "linkedin"]);

    // 30-day calendar: inside the window, selected platforms, no repeated content.
    const cal = doc.sections.calendar!.data;
    expect(cal.days).toBe(30);
    expect(cal.entries.length).toBeGreaterThan(15);
    expect(cal.entries.every((e) => e.date >= "2027-01-04" && e.date <= "2027-02-02" && ["instagram", "linkedin"].includes(e.platform))).toBe(true);
    expect(calendarIssues(cal.entries, { startDate: cal.startDate, days: 30, platforms: cal.platforms, pillars: pillars.map((p) => p.name) })).toEqual([]);

    const revs = await store.revisions(A1.id, row.id);
    expect(revs.filter((x) => x.source === "ai")).toHaveLength(7);
    // Costs are tracked per run (mock = 0) and every agent run is logged.
    const db = await getDb();
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, A1.id));
    expect(runs.filter((x) => ["market_research", "audience_intelligence", "content_pillars", "campaign_ideation", "content_planner"].includes(x.agent)).length).toBeGreaterThanOrEqual(5);
    expect(runs.filter((x) => x.agent === "content_planner").every((x) => x.status === "succeeded" && x.attempts === 1)).toBe(true);
    // The concurrency lease is released.
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
  });

  it("regenerates one section without touching the others and flags downstream sections as stale", async () => {
    const { row } = await fullStrategy(A1, ownerId);
    const before = store.docOf(row);
    await wf.startTask(await access(ownerId, A1), row.id, { sections: ["pillars"], instruction: "More education", inline: true });
    const after = store.docOf((await store.getStrategy(A1.id, row.id))!);
    expect(after.sections.research).toEqual(before.sections.research);
    expect(after.sections.pillars!.generatedAt).not.toBe(before.sections.pillars!.generatedAt);
    expect(after.sections.pillars!.stale).toBe(false);
    for (const k of downstreamOf("pillars")) expect(after.sections[k]!.stale).toBe(true);
    expect(after.sections.strategy!.stale).toBe(false);
  });
});

describe("editing, approvals and calendar operations", () => {
  it("validates edits strictly and keeps server-owned fields", async () => {
    const { row } = await fullStrategy(A1, ownerId);
    const doc = store.docOf(row);
    const personas = doc.sections.audience!.data.personas;
    let r = await store.setItemApproval(A1.id, row.id, actor(ownerId, "owner"), "audience", personas[0].id, true, row.rev);
    r = await store.setItemApproval(A1.id, row.id, actor(ownerId, "owner"), "audience", personas[1].id, true, r.rev);
    await expect(store.setItemApproval(A1.id, row.id, actor(editorId, "editor"), "audience", personas[0].id, false, r.rev)).rejects.toThrow(/admin/);

    // Edit persona 0 only: it loses approval, persona 1 keeps it, a new persona gets an id.
    const a = store.docOf(r).sections.audience!.data;
    const edited = { ...a, personas: [{ ...a.personas[0], summary: "Edited summary" }, a.personas[1], { ...a.personas[1], id: undefined, name: "New persona" }] };
    r = await store.editSection(A1.id, row.id, actor(editorId, "editor"), "audience", edited, r.rev);
    const out = store.docOf(r).sections.audience!;
    expect(out.origin).toBe("mixed");
    expect(out.data.personas.map((p) => p.approved)).toEqual([false, true, false]);
    expect(out.data.personas[2].id).toBeTruthy();
    expect(out.data.personas[0].id).toBe(personas[0].id);

    // Stale revision → rejected (someone else changed it).
    await expect(store.editSection(A1.id, row.id, actor(editorId, "editor"), "audience", edited, r.rev - 1)).rejects.toThrow(/changed by someone else/);
    // Viewers can't edit.
    await expect(store.editSection(A1.id, row.id, actor(editorId, "viewer"), "audience", edited, r.rev)).rejects.toThrow(/editor/);
    // Research edits can reword but never mark something verified or add sources.
    const res = store.docOf(r).sections.research!.data;
    r = await store.editSection(A1.id, row.id, actor(editorId, "editor"), "research", { ...res, findings: res.findings.slice(1).map((f) => ({ id: f.id, title: f.title, detail: f.detail, verified: true, sourceUrls: ["https://fake.example"] })) }, r.rev);
    const res2 = store.docOf(r).sections.research!.data;
    expect(res2.findings).toHaveLength(res.findings.length - 1);
    expect(res2.findings.every((f) => !f.verified && f.sourceUrls.length === 0)).toBe(true);
    // Pillar limits and uniqueness.
    const p = store.docOf(r).sections.pillars!.data;
    const nine = Array.from({ length: PILLAR_MAX + 1 }, (_, i) => ({ ...p.pillars[0], id: undefined, name: `P${i}` }));
    await expect(store.editSection(A1.id, row.id, actor(editorId, "editor"), "pillars", { ...p, pillars: nine }, r.rev)).rejects.toThrow();
    await expect(store.editSection(A1.id, row.id, actor(editorId, "editor"), "pillars", { ...p, pillars: [p.pillars[0], { ...p.pillars[0], id: undefined }] }, r.rev)).rejects.toThrow(/unique/);
    // Oversized / malformed input is rejected by the edit schema.
    await expect(store.editSection(A1.id, row.id, actor(editorId, "editor"), "strategy", { executiveSummary: "x".repeat(10_000) }, r.rev)).rejects.toThrow();
  });

  it("edits, reschedules, adds, deletes and regenerates calendar entries with guards", async () => {
    const { row } = await fullStrategy(A1, ownerId);
    const cal = store.docOf(row).sections.calendar!.data;
    const e = cal.entries[0];
    const { id: _id, ...edit } = e;
    void _id;
    let r = await store.upsertEntry(A1.id, row.id, actor(editorId, "editor"), e.id, { ...edit, date: "2027-01-20", time: "08:15", hook: "A brand-new hook" }, row.rev);
    let entry = store.docOf(r).sections.calendar!.data.entries.find((x) => x.id === e.id)!;
    expect(entry).toMatchObject({ date: "2027-01-20", time: "08:15", hook: "A brand-new hook" });
    await expect(store.upsertEntry(A1.id, row.id, actor(editorId, "editor"), e.id, { ...edit, date: "2027-03-01" }, r.rev)).rejects.toThrow(/30-day window/);
    await expect(store.upsertEntry(A1.id, row.id, actor(editorId, "editor"), e.id, { ...edit, platform: "tiktok" }, r.rev)).rejects.toThrow(/platform/);
    const other = cal.entries[1];
    await expect(store.upsertEntry(A1.id, row.id, actor(editorId, "editor"), null, { ...edit, platform: "linkedin", hook: other.hook, creativeConcept: "different" }, r.rev)).rejects.toThrow(/own angle/);
    r = await store.upsertEntry(A1.id, row.id, actor(editorId, "editor"), null, { ...edit, hook: "Totally new", creativeConcept: "Totally new concept" }, r.rev);
    expect(store.docOf(r).sections.calendar!.data.entries).toHaveLength(cal.entries.length + 1);
    r = await store.deleteEntry(A1.id, row.id, actor(editorId, "editor"), other.id, r.rev);
    expect(store.docOf(r).sections.calendar!.data.entries.some((x) => x.id === other.id)).toBe(false);
    r = await wf.regenerateCalendarEntry(A1, editorId, row.id, e.id, "warmer", r.rev);
    entry = store.docOf(r).sections.calendar!.data.entries.find((x) => x.id === e.id)!;
    expect(entry.hook).not.toBe("A brand-new hook");
    expect(entry.date).toBe("2027-01-20");
  });

  it("runs the review → revisions → approval workflow and never overwrites an approved strategy", async () => {
    const { row } = await fullStrategy(A1, ownerId);
    let r = await store.submitForReview(A1.id, row.id, actor(editorId, "editor"), row.rev);
    expect(r.status).toBe("under_review");
    await expect(store.approveStrategy(A1.id, row.id, actor(editorId, "editor"), r.rev)).rejects.toThrow(/admin/);
    r = await store.requestRevisions(A1.id, row.id, actor(ownerId, "owner"), "Tone down the discounts", r.rev);
    expect(r.status).toBe("draft");
    expect(r.revisionNote).toBe("Tone down the discounts");
    r = await store.approveStrategy(A1.id, row.id, actor(ownerId, "owner"), r.rev);
    expect(r.status).toBe("approved");
    expect(r.approvedBy).toBe(ownerId);

    // Locked: edits, entry changes and regeneration are refused.
    const doc = store.docOf(r);
    await expect(store.editSection(A1.id, row.id, actor(ownerId, "owner"), "strategy", doc.sections.strategy!.data, r.rev)).rejects.toThrow(/approved and locked/);
    await expect(store.deleteEntry(A1.id, row.id, actor(ownerId, "owner"), doc.sections.calendar!.data.entries[0].id, r.rev)).rejects.toThrow(/approved and locked/);
    await expect(wf.startTask(await access(ownerId, A1), row.id, { sections: ["pillars"], inline: true })).rejects.toThrow(/approved and locked/);

    // New version: a draft copy; the approved one stays approved until the new one is approved.
    const v2 = await store.newVersionFrom(A1.id, row.id, actor(editorId, "editor"));
    expect(v2.status).toBe("draft");
    expect(v2.parentId).toBe(row.id);
    expect(v2.version).toBeGreaterThan(r.version);
    expect((await store.currentStrategy(A1.id))!.id).toBe(row.id);
    let v = await store.editSection(A1.id, v2.id, actor(editorId, "editor"), "strategy", { ...store.docOf(v2).sections.strategy!.data, executiveSummary: "Version two summary" }, v2.rev);
    const diff = await store.compare(A1.id, { strategyId: row.id }, { strategyId: v2.id });
    expect(diff.find((d) => d.section === "strategy")!.changes.some((c) => c.path === "executiveSummary" && c.after === "Version two summary")).toBe(true);
    expect(diff.find((d) => d.section === "research")!.status).toBe("same");

    // Restore an earlier revision of v2 (before the edit).
    const revs = await store.revisions(A1.id, v2.id);
    const first = revs.find((x) => x.rev === 1)!;
    v = await store.restoreRevision(A1.id, v2.id, actor(editorId, "editor"), first.id, v.rev);
    expect(store.docOf(v).sections.strategy!.data.executiveSummary).toBe(doc.sections.strategy!.data.executiveSummary);
    expect((await store.revisions(A1.id, v2.id))[0]).toMatchObject({ source: "restore", action: "Restored revision 1" });

    // Approving v2 archives (supersedes) v1.
    v = await store.approveStrategy(A1.id, v2.id, actor(ownerId, "owner"), v.rev);
    expect((await store.getStrategy(A1.id, row.id))!.status).toBe("archived");
    expect((await store.currentStrategy(A1.id))!.id).toBe(v2.id);
    const a = await store.archiveStrategy(A1.id, v2.id, actor(ownerId, "owner"), v.rev);
    expect(a.status).toBe("archived");
  });

  it("puts an approved calendar on the content calendar as drafts, idempotently", async () => {
    const { row } = await fullStrategy(A2, ownerId);
    await expect(store.applyCalendar(A2.id, row.id, actor(editorId, "editor"))).rejects.toThrow(/Approve the strategy/);
    const r = await store.approveStrategy(A2.id, row.id, actor(ownerId, "owner"), row.rev);
    const n = store.docOf(r).sections.calendar!.data.entries.length;
    const first = await store.applyCalendar(A2.id, row.id, actor(editorId, "editor"));
    expect(first).toEqual({ added: n, replaced: 0, kept: 0 });
    const db = await getDb();
    const posts = (await db.select().from(schema.posts).where(eq(schema.posts.brandId, A2.id))).filter((p) => (p.copy as { strategyId?: string }).strategyId === row.id);
    expect(posts).toHaveLength(n);
    expect(posts.every((p) => p.status === "draft")).toBe(true);
    await db.update(schema.posts).set({ status: "approved" }).where(eq(schema.posts.id, posts[0].id));
    const again = await store.applyCalendar(A2.id, row.id, actor(editorId, "editor"));
    expect(again).toEqual({ added: n - 1, replaced: n - 1, kept: 1 });
    expect(store.docOf((await store.getStrategy(A2.id, row.id))!).sections.calendar!.data.appliedAt).toBeTruthy();
  });
});

describe("organisation isolation & agency multi-client access", () => {
  it("never exposes one brand's strategy to another brand or workspace", async () => {
    const { row } = await fullStrategy(A1, ownerId);
    await expect(access(outsiderId, A1, "viewer")).rejects.toBeInstanceOf(AccessError);
    expect(await store.getStrategy(B1.id, row.id)).toBeNull();
    expect(await store.getStrategy(A2.id, row.id)).toBeNull();
    await expect(store.editSection(B1.id, row.id, actor(outsiderId, "owner"), "strategy", {}, row.rev)).rejects.toThrow();
    await expect(store.approveStrategy(B1.id, row.id, actor(outsiderId, "owner"), row.rev)).rejects.toThrow(/not found/);
    await expect(store.compare(B1.id, { strategyId: row.id }, { strategyId: row.id })).rejects.toThrow(/not found/);
    const revs = await store.revisions(B1.id, row.id);
    expect(revs).toEqual([]);
  });

  it("limits client users to their brands while agency users switch between clients", async () => {
    expect(inBrandScope(null, "x")).toBe(true);
    expect(inBrandScope(["a"], "b")).toBe(false);
    const clientBrands = await listAccessibleBrands(clientId);
    expect(clientBrands.map((b) => b.brand.id)).toEqual([A1.id]);
    await expect(access(clientId, A2, "viewer")).rejects.toBeInstanceOf(AccessError);
    expect((await access(clientId, A1, "editor")).brand.id).toBe(A1.id);
    const agency = await listAccessibleBrands(ownerId);
    expect(agency.map((b) => b.brand.id).sort()).toEqual([A1.id, A2.id].sort());

    // Each client's strategies, tasks and advisor history stay separate.
    const s2 = await fullStrategy(A2, ownerId);
    const a1 = await store.listVersions(A1.id);
    const a2 = await store.listVersions(A2.id);
    expect(a1.some((x) => x.id === s2.row.id)).toBe(false);
    expect(a2.every((x) => x.id !== a1[0].id)).toBe(true);
    await expect(wf.taskStatus(A1.id, s2.taskId)).rejects.toThrow(/not found/);
    await askAdvisor({ brandId: A2.id, userId: ownerId }, A2, "Which pillar first?");
    expect((await advisorHistory(A2.id)).length).toBe(2);
    expect((await advisorHistory(A1.id)).every((m) => m.brandId === A1.id)).toBe(true);
    expect(await brandChatHistory(A2.id)).toEqual([]);
  });
});

describe("AI failure handling", () => {
  it("retries unusable output once, then fails the step honestly and resumes only what's missing", async () => {
    const provider = llm();
    const real = provider.structured.bind(provider);
    let pillarCalls = 0;
    vi.spyOn(provider, "structured").mockImplementation(async (req) => {
      if (req.prompt.includes("content pillars (5 is usually right)")) {
        pillarCalls++;
        throw new AIOutputError("The AI returned an incomplete response. Please try again.");
      }
      return real(req);
    });
    const pf = await preflight(A1);
    const row = await store.createStrategy(A1.id, ownerId, inputs(), [], pf.profile);
    const taskId = await wf.startTask(await access(ownerId, A1), row.id, { sections: [...SECTION_KEYS], inline: true });
    const t = await wf.taskStatus(A1.id, taskId);
    expect(t.status).toBe("failed");
    expect(t.error).toBe("The AI returned an incomplete response. Please try again.");
    expect(pillarCalls).toBe(2); // one retry
    expect(Object.fromEntries(t.steps.map((s) => [s.id, s.status]))).toEqual({ research: "done", audience: "done", objectives: "done", strategy: "done", pillars: "failed", campaigns: "skipped", calendar: "skipped" });
    const db = await getDb();
    const failedRun = (await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.brandId, A1.id), eq(schema.agentRuns.agent, "content_pillars"), eq(schema.agentRuns.status, "failed"))))[0];
    expect(failedRun.attempts).toBe(2);
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
    // Completed sections were kept.
    const doc = store.docOf((await store.getStrategy(A1.id, row.id))!);
    expect(Object.keys(doc.sections).sort()).toEqual(["audience", "objectives", "research", "strategy"]);
    expect(await wf.resumeSections(A1.id, row.id)).toEqual(["pillars", "campaigns", "calendar"]);
    vi.restoreAllMocks();
    const t2 = await wf.taskStatus(A1.id, await wf.startTask(await access(ownerId, A1), row.id, { sections: await wf.resumeSections(A1.id, row.id), inline: true }));
    expect(t2.status).toBe("succeeded");
    expect(store.docOf((await store.getStrategy(A1.id, row.id))!).sections.calendar).toBeTruthy();
  });

  it("succeeds after a transient bad response; a task that keeps getting interrupted is failed once attempts run out", async () => {
    const provider = llm();
    const real = provider.structured.bind(provider);
    let n = 0;
    vi.spyOn(provider, "structured").mockImplementation(async (req) => {
      if (req.prompt.includes("Translate the business objectives") && n++ === 0) throw new AIOutputError("bad json");
      return real(req);
    });
    const { taskId } = await fullStrategy(A2, ownerId);
    expect((await wf.taskStatus(A2.id, taskId)).status).toBe("succeeded");
    vi.restoreAllMocks();

    const db = await getDb();
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], null);
    const [stale] = await db
      .insert(schema.aiTasks)
      .values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: ownerId, kind: "strategy_workflow", strategyId: row.id, status: "running", attempts: 3, maxAttempts: 3, steps: [{ id: "research", label: "x", status: "running" }], heartbeatAt: new Date(Date.now() - 20 * 60_000) })
      .returning();
    expect(await store.activeTask(A2.id, row.id)).toBeNull();
    const t = await wf.taskStatus(A2.id, stale.id);
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/interrupted repeatedly/);
  });

  it("blocks user edits while the AI is working on a strategy", async () => {
    const { row } = await fullStrategy(A2, ownerId);
    const db = await getDb();
    await db.insert(schema.aiTasks).values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: ownerId, kind: "regenerate_section", strategyId: row.id, status: "running", steps: [], heartbeatAt: new Date() });
    await expect(store.submitForReview(A2.id, row.id, actor(ownerId, "owner"), row.rev)).rejects.toThrow(/still working/);
    await expect(wf.startTask(await access(ownerId, A2), row.id, { sections: ["pillars"], inline: true })).rejects.toThrow(/already working/);
    await db.update(schema.aiTasks).set({ status: "succeeded" }).where(eq(schema.aiTasks.strategyId, row.id));
  });
});

describe("rate limiting & concurrency for strategist tasks", () => {
  it("enforces the heavy-AI rate limit and the concurrency lease before any work starts", async () => {
    const db = await getDb();
    const u = await user("ratelimited");
    const [ws] = await db.insert(schema.workspaces).values({ name: "RL", plan: "starter" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u, role: "owner" });
    const b = await brand(ws.id, "RL Co");
    const pf = { id: (await approvedProfile(b, u)).id, version: 1 };
    const row = await store.createStrategy(b.id, u, inputs(), [], pf);
    const acc = await access(u, b);

    // Concurrency: the user already has the maximum number of AI tasks running.
    const l1 = await acquireAiSlot({ userId: u, workspaceId: ws.id, plan: "starter" }, "x");
    const l2 = await acquireAiSlot({ userId: u, workspaceId: ws.id, plan: "starter" }, "x");
    await expect(wf.startTask(acc, row.id, { sections: ["research"], inline: true })).rejects.toBeInstanceOf(RateLimitError);
    await releaseAiSlot(l1);
    await releaseAiSlot(l2);
    expect(await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.strategyId, row.id))).toHaveLength(0);

    // Rate limit: ai_heavy allows N per 10 minutes per user.
    const limit = RULES.ai_heavy.find((r) => r.scope === "user")!.limit;
    let err: unknown;
    for (let i = 0; i < limit + 2 && !err; i++) {
      try {
        await wf.startTask(acc, row.id, { sections: ["research"], inline: true });
      } catch (e) {
        err = e;
      }
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).retryAfter).toBeGreaterThan(0);
  });
});

describe("research source verification", () => {
  const sources = [{ url: "https://news.example.com/ceramics-2026", title: "Ceramics 2026", publishedAt: "2 months ago", retrievedAt: "2026-11-01T00:00:00Z" }];
  const base = { summary: "s", industryOverview: "o", openQuestions: [], competitors: [] };
  it("only marks findings verified when they cite a URL the search actually returned", () => {
    const r = agents.verifyResearch(
      {
        ...base,
        findings: [
          { category: "industry", title: "Real", detail: "Demand rose 12%", basis: "sourced", sourceUrls: ["https://news.example.com/ceramics-2026/"], evidence: "e", confidence: "high" },
          { category: "trend", title: "Invented", detail: "Sales up 40% year on year", basis: "sourced", sourceUrls: ["https://made-up.example/report"], evidence: "e", confidence: "high" },
          { category: "opportunity", title: "Idea", detail: "Care guides", basis: "hypothesis", sourceUrls: [], evidence: "reasoning", confidence: "low" },
        ],
        competitors: [
          { name: "ClayCo", positioning: "p", strengths: [], weaknesses: [], contentApproach: "c", opportunity: "o", basis: "brand_data", sourceUrls: [] },
          { name: "Unknown", positioning: "p", strengths: [], weaknesses: [], contentApproach: "c", opportunity: "o", basis: "brand_data", sourceUrls: [] },
        ],
      },
      sources,
      ["ClayCo"],
      "web_search",
      3,
    );
    expect(r.findings[0]).toMatchObject({ verified: true, basis: "sourced", sourceUrls: ["https://news.example.com/ceramics-2026"], unsourcedFigure: false });
    expect(r.findings[1]).toMatchObject({ verified: false, basis: "hypothesis", sourceUrls: [], unmatchedUrls: ["https://made-up.example/report"], unsourcedFigure: true });
    expect(r.findings[2]).toMatchObject({ verified: false, basis: "hypothesis" });
    expect(r.competitors.map((c) => c.basis)).toEqual(["brand_data", "hypothesis"]);
    expect(r.webSearches).toBe(3);
    // Without web search nothing can be verified, whatever the model claims.
    const none = agents.verifyResearch({ ...base, findings: [{ category: "industry", title: "t", detail: "d", basis: "sourced", sourceUrls: [sources[0].url], evidence: "e", confidence: "high" }] }, sources, [], "no_search", 0);
    expect(none.findings[0].verified).toBe(false);
  });

  it("normalises pillar shares and compares documents", async () => {
    expect(agents.normalizeShares([{ sharePercent: 30 }, { sharePercent: 30 }, { sharePercent: 30 }]).map((p) => p.sharePercent)).toEqual([34, 33, 33]);
    expect(agents.normalizeShares([{ sharePercent: 0 }, { sharePercent: 0 }]).map((p) => p.sharePercent)).toEqual([50, 50]);
    expect(downstreamOf("research")).toEqual(["audience", "objectives", "strategy", "pillars", "campaigns", "calendar"]);
    const { row } = await fullStrategy(A2, ownerId);
    const doc = store.docOf(row);
    expect(compareDocs(doc, doc).every((d) => d.status === "same")).toBe(true);
    // Dashboard/content-studio view works for v1 and v2.
    expect(summarizeStrategy(doc, 2).pillars.length).toBe(doc.sections.pillars!.data.pillars.length);
    expect(summarizeStrategy({ pillars: [{ name: "Old", sharePercent: 100, description: "" }] }, 1).pillars[0].name).toBe("Old");
  });
});

describe("migrations 0004 and 0005 on an existing database", () => {
  it("keeps legacy strategies and backfills per-brand version numbers", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const src = path.join(process.cwd(), "drizzle");
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mig4-"));
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(src, "meta/_journal.json"), "utf8"));
    const before = journal.entries.filter((e: { idx: number }) => e.idx < 4);
    for (const e of before) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
    fs.writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    const client = await PGlite.create({ extensions: { vector } });
    await client.exec("create extension if not exists vector");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    await client.exec(`
      insert into workspaces (id, name) values ('w1', 'Legacy');
      insert into brands (id, workspace_id, name) values ('b1', 'w1', 'Legacy Co');
      insert into workspace_members (id, workspace_id, user_id, role) values ('m1', 'w1', null, 'editor');
      insert into strategies (id, brand_id, month, status, data, created_at) values
        ('s1', 'b1', '2026-10', 'approved', '{"pillars":[{"name":"Old","sharePercent":100,"description":""}]}', now() - interval '2 days'),
        ('s2', 'b1', '2026-11', 'draft', '{"pillars":[]}', now() - interval '1 day');
    `);
    await migrate(db, { migrationsFolder: src });
    const rows = (await client.query<{ id: string; version: number; schema_version: number; rev: number; status: string }>("select id, version, schema_version, rev, status from strategies order by id")).rows;
    expect(rows).toEqual([
      { id: "s1", version: 1, schema_version: 1, rev: 0, status: "approved" },
      { id: "s2", version: 2, schema_version: 1, rev: 0, status: "draft" },
    ]);
    const m = (await client.query<{ brand_ids: unknown }>("select brand_ids from workspace_members where id = 'm1'")).rows[0];
    expect(m.brand_ids).toBeNull();
    const t = await client.query("select table_name from information_schema.tables where table_name in ('strategy_revisions','ai_tasks')");
    expect(t.rows).toHaveLength(2);
    // 0005: persistent-job columns and run → task attribution.
    const cols = await client.query<{ table_name: string; column_name: string; column_default: string | null }>("select table_name, column_name, column_default from information_schema.columns where (table_name = 'ai_tasks' and column_name in ('attempts','max_attempts','claim_token','run_after')) or (table_name = 'agent_runs' and column_name = 'task_id') order by table_name, column_name");
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual(["agent_runs.task_id", "ai_tasks.attempts", "ai_tasks.claim_token", "ai_tasks.max_attempts", "ai_tasks.run_after"]);
    expect(cols.rows.find((r) => r.column_name === "max_attempts")!.column_default).toBe("3");
    await client.close();
  });
});

describe("review hardening", () => {
  it("starts at most one task per strategy even under concurrent requests", async () => {
    const pf = await preflight(A2);
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], pf.profile);
    const acc = await access(ownerId, A2);
    const results = await Promise.allSettled([1, 2, 3].map(() => wf.startTask(acc, row.id, { sections: ["research"] })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => /already working|AI tasks running/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    // Let the background run finish before other tests.
    const db = await getDb();
    for (let i = 0; i < 50; i++) {
      const [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.strategyId, row.id));
      if (t.status === "succeeded" || t.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it("frees the concurrency lease and closes the in-flight run of a task that has used all its attempts", async () => {
    const db = await getDb();
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], null);
    const lease = await acquireAiSlot({ userId: ownerId, workspaceId: A2.workspaceId, plan: "agency" }, "strategy_workflow", 900);
    const [t] = await db
      .insert(schema.aiTasks)
      .values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: ownerId, kind: "strategy_workflow", strategyId: row.id, status: "running", attempts: 3, maxAttempts: 3, input: { leaseId: lease }, steps: [{ id: "research", label: "x", status: "running" }], heartbeatAt: new Date(Date.now() - 3 * 60_000) })
      .returning();
    const [orphan] = await db.insert(schema.agentRuns).values({ brandId: A2.id, userId: ownerId, taskId: t.id, agent: "market_research", task: "Web research", input: { strategyId: row.id }, startedAt: new Date(Date.now() - 3 * 60_000) }).returning();
    const st = await wf.taskStatus(A2.id, t.id);
    expect(st.status).toBe("failed");
    expect(st.steps[0]).toMatchObject({ status: "failed", error: "Interrupted" });
    expect(await db.select().from(schema.aiTaskLeases).where(eq(schema.aiTaskLeases.id, lease))).toHaveLength(0);
    const [closed] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, orphan.id));
    expect(closed.status).toBe("failed");
    expect(closed.error).toMatch(/Interrupted/);
  });

  it("never renders non-http research links", async () => {
    const { safeHref } = await import("@/lib/strategy");
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("persistent jobs: recovery after restarts, no duplicate work or billing", () => {
  const db = () => getDb();
  async function strategyWithCrashedTask(b: Brand, crashAfter: "audience" | "written-not-marked") {
    const d = await db();
    const pf = await preflight(b);
    const row = await store.createStrategy(b.id, ownerId, inputs(), [], pf.profile);
    const acc = await access(ownerId, b);
    // Run for real until the objectives step, which "crashes" (a non-retryable error stands in for the
    // process dying), then rewrite the task row to look exactly like a worker that died mid-step.
    const provider = llm();
    const real = provider.structured.bind(provider);
    vi.spyOn(provider, "structured").mockImplementation(async (req) => {
      if (req.prompt.includes("Translate the business objectives")) throw new Error("process died");
      return real(req);
    });
    const taskId = await wf.startTask(acc, row.id, { sections: [...SECTION_KEYS], inline: true });
    vi.restoreAllMocks();
    const [t] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    let steps = t.steps.map((s) => (s.id === "objectives" ? { ...s, status: "running" as const, error: undefined } : s.status === "skipped" ? { ...s, status: "pending" as const } : s));
    if (crashAfter === "written-not-marked") steps = steps.map((s) => (s.id === "audience" ? { ...s, status: "running" as const } : s.id === "objectives" ? { ...s, status: "pending" as const } : s));
    await d.update(schema.aiTasks).set({ status: "running", error: null, finishedAt: null, claimToken: "dead-worker", heartbeatAt: new Date(Date.now() - 5 * 60_000), steps }).where(eq(schema.aiTasks.id, taskId));
    // The dead worker's in-flight agent run.
    await d.update(schema.agentRuns).set({ status: "running", finishedAt: null }).where(and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.agent, "marketing_strategist")));
    return { row, taskId };
  }
  const runsOf = async (taskId: string) => (await db()).select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));

  it("picks up a task whose worker died, finishes only the remaining steps and closes the orphaned run", async () => {
    const { row, taskId } = await strategyWithCrashedTask(A1, "audience");
    const before = await runsOf(taskId);
    const researchBefore = before.filter((r) => r.agent === "market_research").length;
    expect(await store.activeTask(A1.id, row.id)).not.toBeNull(); // recoverable → still counts as active
    await wf.recoverDueTasks({ wait: true });
    const d = await db();
    const [t] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("succeeded");
    expect(t.attempts).toBe(2);
    expect(t.claimToken).toBeNull();
    const after = await runsOf(taskId);
    expect(after.filter((r) => r.agent === "market_research")).toHaveLength(researchBefore); // not re-run
    expect(after.filter((r) => r.agent === "audience_intelligence")).toHaveLength(1);
    expect(after.find((r) => r.error?.startsWith("Interrupted"))).toBeTruthy(); // orphan closed, not left "running"
    expect(after.every((r) => r.status !== "running")).toBe(true);
    const doc = store.docOf((await store.getStrategy(A1.id, row.id))!);
    expect(Object.keys(doc.sections).sort()).toEqual([...SECTION_KEYS].sort());
    expect(await d.select().from(schema.aiTaskLeases)).toHaveLength(0);
  });

  it("does not regenerate a section that was saved just before the crash", async () => {
    const { taskId } = await strategyWithCrashedTask(A1, "written-not-marked");
    const audienceBefore = (await runsOf(taskId)).filter((r) => r.agent === "audience_intelligence").length;
    await wf.recoverDueTasks({ wait: true });
    const [t] = await (await db()).select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("succeeded");
    expect((await runsOf(taskId)).filter((r) => r.agent === "audience_intelligence")).toHaveLength(audienceBefore);
  });

  it("lets exactly one of several racing workers run a task", async () => {
    const d = await db();
    const pf = await preflight(A2);
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], pf.profile);
    const lease = await acquireAiSlot({ userId: ownerId, workspaceId: A2.workspaceId, plan: "agency" }, "strategy_workflow", 900);
    const [t] = await d.insert(schema.aiTasks).values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: ownerId, kind: "strategy_workflow", strategyId: row.id, steps: SECTION_KEYS.map((k) => ({ id: k, label: k, status: "pending" as const })), input: { leaseId: lease }, runAfter: new Date(0) }).returning();
    const results = await Promise.all([wf.runTask(t.id), wf.runTask(t.id), wf.runTask(t.id), wf.recoverDueTasks({ wait: true })]);
    expect(results.slice(0, 3).filter((r) => r === "succeeded")).toHaveLength(1);
    expect(results.slice(0, 3).filter((r) => r === "claimed_elsewhere")).toHaveLength(2);
    const runs = await runsOf(t.id);
    for (const agent of ["audience_intelligence", "content_pillars", "campaign_ideation"]) expect(runs.filter((r) => r.agent === agent), agent).toHaveLength(1);
    const [done] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(done.attempts).toBe(1);
  });

  it("stops without writing when another worker took over the task (lost claim)", async () => {
    const d = await db();
    const pf = await preflight(A2);
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], pf.profile);
    const [t] = await d.insert(schema.aiTasks).values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: ownerId, kind: "strategy_workflow", strategyId: row.id, steps: [{ id: "research", label: "r", status: "pending" }, { id: "audience", label: "a", status: "pending" }], runAfter: new Date(0) }).returning();
    const provider = llm();
    const real = provider.structured.bind(provider);
    vi.spyOn(provider, "structured").mockImplementation(async (req) => {
      // While the audience agent is thinking, another worker steals the task.
      if (req.prompt.includes("Build the audience intelligence")) await d.update(schema.aiTasks).set({ claimToken: "someone-else" }).where(eq(schema.aiTasks.id, t.id));
      return real(req);
    });
    expect(await wf.runTask(t.id)).toBe("lost_claim");
    const doc = store.docOf((await store.getStrategy(A2.id, row.id))!);
    expect(doc.sections.research).toBeTruthy();
    expect(doc.sections.audience).toBeUndefined(); // the losing worker's result was not written
    await d.update(schema.aiTasks).set({ status: "failed" }).where(eq(schema.aiTasks.id, t.id));
  });

  it("waits for a concurrency slot during recovery without using up an attempt", async () => {
    const d = await db();
    const row = await store.createStrategy(A2.id, editorId, inputs(), [], null);
    const l1 = await acquireAiSlot({ userId: editorId, workspaceId: A2.workspaceId, plan: "agency" }, "x");
    const l2 = await acquireAiSlot({ userId: editorId, workspaceId: A2.workspaceId, plan: "agency" }, "x");
    const [t] = await d.insert(schema.aiTasks).values({ brandId: A2.id, workspaceId: A2.workspaceId, userId: editorId, kind: "strategy_workflow", strategyId: row.id, steps: [{ id: "research", label: "r", status: "pending" }], runAfter: new Date(0) }).returning();
    expect(await wf.runTask(t.id)).toBe("waiting_for_slot");
    const [w] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(w).toMatchObject({ status: "queued", attempts: 0, claimToken: null });
    expect(w.runAfter.getTime()).toBeGreaterThan(Date.now());
    await releaseAiSlot(l1);
    await releaseAiSlot(l2);
    await d.update(schema.aiTasks).set({ runAfter: new Date() }).where(eq(schema.aiTasks.id, t.id));
    expect(await wf.runTask(t.id)).toBe("succeeded");
  });

  it("retries transient service errors automatically and gives up after max attempts", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const d = await db();
    const pf = await preflight(A2);
    const row = await store.createStrategy(A2.id, ownerId, inputs(), [], pf.profile);
    const provider = llm();
    const real = provider.structured.bind(provider);
    vi.spyOn(provider, "structured").mockImplementation(async (req) => {
      if (req.prompt.includes("Build the audience intelligence")) throw new Anthropic.APIConnectionError({ message: "socket hang up" });
      return real(req);
    });
    const taskId = await wf.startTask(await access(ownerId, A2), row.id, { sections: ["research", "audience"], inline: true });
    let [t] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("queued");
    expect(t.error).toMatch(/Retrying automatically \(attempt 2 of 3\)/);
    // Backoff doubles: attempt 2 waits ~60s.
    await d.update(schema.aiTasks).set({ runAfter: new Date() }).where(eq(schema.aiTasks.id, taskId));
    expect(await wf.runTask(taskId)).toBe("retrying");
    [t] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.runAfter.getTime() - Date.now()).toBeGreaterThan(50_000);
    await d.update(schema.aiTasks).set({ runAfter: new Date() }).where(eq(schema.aiTasks.id, taskId));
    expect(await wf.runTask(taskId)).toBe("failed");
    vi.restoreAllMocks();
    [t] = await d.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t).toMatchObject({ status: "failed", attempts: 3 });
    expect((await runsOf(taskId)).filter((r) => r.agent === "market_research")).toHaveLength(1);
    // The user can resume; only the missing section runs.
    expect(await wf.resumeSections(A2.id, row.id)).toEqual(["audience", "objectives", "strategy", "pillars", "campaigns", "calendar"]);
  }, 30_000);
});
