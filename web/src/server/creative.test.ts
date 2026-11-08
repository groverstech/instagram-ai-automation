import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-creative-"));

const { getDb, schema } = await import("./db/client");
const { generateBrandProfile, approveProfile } = await import("./agents/brand");
const { requireBrandForUser } = await import("./auth/guard");
const { storage } = await import("./storage");
const { llm } = await import("./ai/llm");
const jobs = await import("./creative/jobs");
const { runJob, recoverDueTasks } = await import("./jobs/engine");
const creative = await import("./agents/creative");
const { renderCreativePng, slideCount } = await import("./creative/render");
const { deterministicChecks } = await import("./creative/brand-check");
const { checkOriginality } = await import("./creative/copy");
const store = await import("./strategist/store");
const wf = await import("./strategist/workflow");
const q = await import("@/lib/creative-quality");
const { StrategyInputs, SECTION_KEYS } = await import("@/lib/strategy");
type Brand = import("./db/schema").Brand;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sess = (id: string) => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });
let ownerId = "", otherId = "";
let A: Brand, B: Brand;
const photos: string[] = [];

async function photo(b: Brand, name: string, status: "approved" | "pending" = "approved") {
  const db = await getDb();
  const key = `brands/${b.id}/assets/${name}`;
  await storage.put(key, PNG, "image/png");
  const [a] = await db.insert(schema.brandAssets).values({ brandId: b.id, kind: "product", name, path: key, mime: "image/png", size: PNG.length, status }).returning();
  return a.id;
}
const access = (userId: string, b: Brand) => requireBrandForUser(sess(userId), b.id, "editor");
const req = (over: Partial<import("./agents/creative").CreativeRequest> = {}) => ({ brief: "Winter glaze launch: show the new deep-blue mugs", format: "instagram_post", style: "minimalist_luxury", count: 2, objective: "sales", visualSource: "typographic" as const, ...over });

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ email: "o@x.test", name: "O", passwordHash: "x" }).returning();
  const [x] = await db.insert(schema.users).values({ email: "x@x.test", name: "X", passwordHash: "x" }).returning();
  ownerId = o.id;
  otherId = x.id;
  const [w1] = await db.insert(schema.workspaces).values({ name: "Kora", plan: "agency" }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: w1.id, userId: o.id, role: "owner" },
    { workspaceId: w2.id, userId: x.id, role: "owner" },
  ]);
  [A] = await db.insert(schema.brands).values({ workspaceId: w1.id, name: "Kora Ceramics", industry: "Ceramics", products: "Stoneware", platforms: ["instagram", "pinterest"], colors: ["#2B2620", "#F3EDE4", "#B5643C"] }).returning();
  [B] = await db.insert(schema.brands).values({ workspaceId: w2.id, name: "Rival", platforms: ["instagram"], colors: ["#000000"] }).returning();
  for (const b of [A, B]) {
    const { profile } = await generateBrandProfile({ brandId: b.id, userId: b === A ? o.id : x.id }, b);
    await approveProfile(b.id, profile.id, b === A ? o.id : x.id);
  }
  photos.push(await photo(A, "mug-blue.png"), await photo(A, "bowl.png"), await photo(A, "plate.png"));
});
beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});
afterEach(() => vi.restoreAllMocks());

describe("creative jobs (concepts → visual → copy → brand check)", () => {
  it("produces creatives with a copy pack and a brand check, all steps done", async () => {
    const taskId = await jobs.startCreativeBatch(await access(ownerId, A), [req()], { inline: true });
    const db = await getDb();
    const [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("succeeded");
    // concepts:0, then visual/copy/check per creative
    expect(t.steps.map((s) => s.id.split(":")[0])).toEqual(["concepts", "visual", "copy", "check", "visual", "copy", "check"]);
    expect(t.steps.every((s) => s.status === "done")).toBe(true);
    const rows = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    expect(rows).toHaveLength(2);
    for (const c of rows) {
      expect(c).toMatchObject({ visualSource: "typographic", imageProvider: "none", kind: "single", logoPlacement: "top_left" });
      expect((c.copy as { primary: string; platform: string }).primary.length).toBeGreaterThan(10);
      expect((c.copy as { platform: string }).platform).toBe("instagram");
      const check = c.brandCheck as { score: number; checks: { id: string }[]; review: unknown; mode: string };
      expect(check.mode).toBe("full");
      expect(check.checks.map((x) => x.id)).toEqual(expect.arrayContaining(["contrast_headline", "palette", "logo", "headline_length", "cta", "visual"]));
      expect(check.score).toBeGreaterThan(0);
      expect(check.review).toBeTruthy();
    }
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
  });

  it("renders JPEG and WebP brand photos into the creative (not just the layout)", async () => {
    const { default: sharp } = await import("sharp");
    const db = await getDb();
    for (const [mime, ext] of [["image/jpeg", "jpg"], ["image/webp", "webp"]] as const) {
      const red = sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 230, g: 20, b: 20 } } });
      const buf = await (ext === "jpg" ? red.jpeg() : red.webp()).toBuffer();
      const key = `brands/${A.id}/assets/red.${ext}`;
      await storage.put(key, buf, mime);
      const [asset] = await db.insert(schema.brandAssets).values({ brandId: A.id, kind: "product", name: `red.${ext}`, path: key, mime, size: buf.length, status: "approved" }).returning();
      const taskId = await jobs.startCreativeBatch(await access(ownerId, A), [req({ brief: `Photo render check (${ext})`, count: 1, visualSource: "brand_photo", sourceAssetIds: [asset.id] })], { inline: true });
      let [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
      expect(c.sourceAssetId).toBe(asset.id);
      expect(c.imagePath).toMatch(ext === "jpg" ? /\.jpg$/ : /\.png$/); // WebP is converted for the renderer
      await creative.updateConcept(A.id, c.id, { layout: "split" });
      [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
      const { data, info } = await sharp(await renderCreativePng(c, A)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let redPx = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] > 190 && data[i + 1] < 70 && data[i + 2] < 70) redPx++;
      expect(redPx / (info.width * info.height)).toBeGreaterThan(0.1);
      // Leave no trace for later tests (their originality checks read this brand's captions).
      await db.delete(schema.creatives).where(eq(schema.creatives.id, c.id));
      await db.delete(schema.brandAssets).where(eq(schema.brandAssets.id, asset.id));
    }
  });

  it("builds carousels from approved brand photos and renders every slide", async () => {
    const taskId = await jobs.startCreativeBatch(await access(ownerId, A), [req({ kind: "carousel", slideCount: 5, count: 1, visualSource: "brand_photo" })], { inline: true, slideVisuals: true });
    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    expect(c.kind).toBe("carousel");
    expect(c.slides).toHaveLength(4);
    expect(slideCount(c)).toBe(5);
    expect(c.imageProvider).toBe("brand_photo");
    expect(photos).toContain(c.sourceAssetId);
    expect(c.imagePath).toMatch(new RegExp(`^brands/${A.id}/creatives/`)); // copied into creative storage
    expect(c.slides.filter((s) => s.imagePath).length).toBeGreaterThan(0); // other photos on slides
    for (let i = 0; i < 5; i++) {
      const png = await renderCreativePng(c, A, undefined, i);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
    // A resize to a story still renders the cover and a slide.
    expect((await renderCreativePng(c, A, "instagram_story", 2)).subarray(1, 4).toString()).toBe("PNG");
  });

  it("renders every logo placement", async () => {
    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, A.id)).limit(1);
    for (const logoPlacement of ["top_left", "top_right", "bottom_left", "bottom_right", "none"] as const) {
      const png = await renderCreativePng({ ...c, logoPlacement }, A);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
  });
});

describe("brand consistency check & approval gate", () => {
  it("computes WCAG contrast and palette distance correctly", () => {
    expect(q.contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(q.contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
    expect(q.deltaE("#B5643C", "#B5643C")).toBe(0);
    expect(q.paletteDistance("#B5653D", ["#B5643C"])).toBeLessThan(2);
    expect(q.paletteDistance("#00FF00", ["#B5643C", "#2B2620"])).toBeGreaterThan(50);
    expect(q.paletteDistance("#FFFFFF", ["#B5643C"])).toBe(0); // neutrals allowed
  });

  it("fails illegible text, flags off-palette colours, and blocks approval unless forced", async () => {
    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.brandId, A.id), eq(schema.creatives.kind, "single"))).limit(1);
    await creative.updateConcept(A.id, c.id, { palette: { background: "#FFFFFF", foreground: "#EEEEEE", accent: "#00FF00" }, layout: "split" });
    const [edited] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect((edited.brandCheck as { stale?: boolean }).stale).toBe(true); // edit marks the check stale
    const checks = deterministicChecks(edited, A, false);
    expect(checks.find((x) => x.id === "contrast_headline")).toMatchObject({ status: "fail" });
    expect(checks.find((x) => x.id === "palette")).toMatchObject({ status: "warn" });
    expect(checks.find((x) => x.id === "logo")).toMatchObject({ status: "warn" }); // no logo asset uploaded
    const { runBrandCheck } = await import("./creative/brand-check");
    const check = await runBrandCheck({ brandId: A.id, userId: ownerId }, A, edited);
    expect(check.blocking).toBe(true);
    await expect(creative.setCreativeStatus(A.id, c.id, "approved")).rejects.toThrow(/blocking brand issues: .*contrast/i);
    const forced = await creative.setCreativeStatus(A.id, c.id, "approved", { force: true });
    expect(forced?.status).toBe("approved");
  });

  it("rejects malformed edits", async () => {
    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, A.id)).limit(1);
    await expect(creative.updateConcept(A.id, c.id, { palette: { background: "red", foreground: "#000", accent: "#000" } })).rejects.toThrow();
    await expect(creative.updateConcept(A.id, c.id, { headline: "x".repeat(500) })).rejects.toThrow();
    await expect(creative.updateConcept(A.id, c.id, { brandId: B.id } as never)).resolves.toBeUndefined(); // unknown keys stripped
    const [same] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect(same.brandId).toBe(A.id);
  });
});

describe("copy originality guard", () => {
  it("flags clichés and near-duplicate captions", () => {
    const r = checkOriginality("Elevate your mornings with our seamless new mug collection, made slowly in our studio", ["Elevate your mornings with our seamless new mug collection, made with care"]);
    expect(r.cliches).toEqual(expect.arrayContaining(["elevate", "seamless"]));
    expect(r.similar[0].score).toBeGreaterThan(q.SIMILARITY_LIMIT);
    expect(checkOriginality("Forty hours for one bowl.", ["A completely different caption about glaze tests"]).similar).toEqual([]);
  });

  it("retries once with feedback when a caption repeats a recent one, and flags what remains", async () => {
    const db = await getDb();
    const rows = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, A.id));
    const packs = rows.map((r) => r.copy as { originality: { retried: boolean; similar: unknown[] } } | null).filter(Boolean);
    // The mock copywriter writes identical captions for the same brief: the second creative's caption
    // repeated the first, so the guard retried with feedback, and the revised caption no longer matches.
    const retried = packs.filter((p) => p!.originality.retried);
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((p) => p!.originality.similar.length === 0)).toBe(true);
    const db2 = await getDb();
    const agentCalls = await db2.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.brandId, A.id), eq(schema.agentRuns.agent, "copywriter")));
    expect(agentCalls.length).toBeGreaterThan(rows.filter((r) => r.copy).length); // the retry was a real extra call
  });
});

describe("persistent creative jobs: recovery and duplicate protection", () => {
  it("recovers a job whose worker died without re-creating concepts or visuals", async () => {
    const provider = llm();
    const real = provider.structured.bind(provider);
    vi.spyOn(provider, "structured").mockImplementation(async (r) => {
      if (r.prompt.includes("Write the copy pack")) throw new Error("process died");
      return real(r);
    });
    const taskId = await jobs.startCreativeBatch(await access(ownerId, A), [req({ count: 2, visualSource: "brand_photo" })], { inline: true });
    vi.restoreAllMocks();
    const db = await getDb();
    const [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("failed");
    const before = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    const pathsBefore = Object.fromEntries(before.map((c) => [c.id, c.imagePath]));
    expect(Object.values(pathsBefore).filter(Boolean)).toHaveLength(1); // first creative's visual done before the crash
    // Make it look like a worker died mid-run.
    await db.update(schema.aiTasks).set({ status: "running", error: null, claimToken: "dead", heartbeatAt: new Date(Date.now() - 5 * 60_000), steps: t.steps.map((s) => (s.status === "skipped" || s.status === "failed" ? { ...s, status: "pending" as const } : s)) }).where(eq(schema.aiTasks.id, taskId));
    await recoverDueTasks({ wait: true });
    const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(after).toMatchObject({ status: "succeeded", attempts: 2 });
    const rows = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    expect(rows.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort()); // no duplicate creatives
    for (const r of rows) if (pathsBefore[r.id]) expect(r.imagePath).toBe(pathsBefore[r.id]); // finished visual not redone
    expect(rows.every((r) => r.imagePath)).toBe(true);
    expect(rows.every((r) => r.copy && r.brandCheck)).toBe(true);
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));
    expect(runs.filter((r) => r.agent === "creative_director" && r.task.includes("×"))).toHaveLength(1); // concepts once
  });

  it("lets exactly one of several racing workers run a creative job", async () => {
    const db = await getDb();
    const acc = await access(ownerId, A);
    const provider = llm();
    const real = provider.structured.bind(provider);
    // Hold the job queued: start it inline but make the first claim lose to the racers.
    const [t] = await db
      .insert(schema.aiTasks)
      .values({ brandId: A.id, workspaceId: acc.brand.workspaceId, userId: ownerId, kind: jobs.BATCH_KIND, steps: [{ id: "concepts:0", label: "c", status: "pending" }], input: { items: [req({ count: 1 })] }, runAfter: new Date(0) })
      .returning();
    void real;
    const results = await Promise.all([runJob(t.id), runJob(t.id), runJob(t.id)]);
    expect(results.filter((r) => r === "succeeded")).toHaveLength(1);
    expect(results.filter((r) => r === "claimed_elsewhere")).toHaveLength(2);
    expect(await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, t.id))).toHaveLength(1);
  });
});

describe("strategy → creative", () => {
  it("produces linked creatives from calendar entries and attaches them to draft posts", async () => {
    const acc = await access(ownerId, A);
    const row = await store.createStrategy(A.id, ownerId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram", "pinterest"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);
    await wf.startTask(acc, row.id, { sections: [...SECTION_KEYS], inline: true });
    const strategy = (await store.getStrategy(A.id, row.id))!;
    const entries = store.docOf(strategy).sections.calendar!.data.entries.slice(0, 2);
    const taskId = await jobs.produceFromCalendar(acc, row.id, entries.map((e) => e.id), { style: "premium_editorial", visualSource: "typographic", inline: true });
    const db = await getDb();
    const made = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    expect(made).toHaveLength(2);
    expect(made.map((c) => c.calendarEntryId).sort()).toEqual(entries.map((e) => e.id).sort());
    expect(made.every((c) => c.strategyId === row.id && c.copy)).toBe(true);
    const formatOf = Object.fromEntries(entries.map((e) => [e.id, e.format]));
    expect(made.every((c) => c.format === formatOf[c.calendarEntryId!])).toBe(true);
    // The creative director saw the strategy context.
    const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.agent, "creative_director")));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // Approve the strategy and apply the calendar: posts carry the creative and its caption.
    const approved = await store.approveStrategy(A.id, row.id, { userId: ownerId, role: "owner" }, strategy.rev);
    void approved;
    await store.applyCalendar(A.id, row.id, { userId: ownerId, role: "owner" });
    const posts = await db.select().from(schema.posts).where(eq(schema.posts.brandId, A.id));
    for (const c of made) {
      const p = posts.find((x) => (x.copy as { entryId?: string }).entryId === c.calendarEntryId)!;
      expect(p.creativeId).toBe(c.id);
      expect(p.caption).toBe((c.copy as { primary: string }).primary);
    }
  });
});

describe("validation & isolation", () => {
  it("rejects impossible requests before admitting a job", async () => {
    const acc = await access(ownerId, A);
    await expect(jobs.startCreativeBatch(acc, [req({ visualSource: "ai" })])).rejects.toThrow(/no image provider is configured/);
    await expect(jobs.startCreativeBatch(acc, [req({ count: 6 }), req({ count: 6 }), req({ count: 6 })])).rejects.toThrow(/at most 12/);
    await expect(jobs.startCreativeBatch(acc, [req({ format: "billboard" })])).rejects.toThrow(/Unknown format/);
    const pending = await photo(A, "unapproved.png", "pending");
    await expect(jobs.startCreativeBatch(acc, [req({ visualSource: "brand_photo", sourceAssetIds: [pending] })])).rejects.toThrow(/isn't an approved image asset/);
    const db = await getDb();
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
  });

  it("never lets one brand use another brand's photos, strategy or creatives", async () => {
    const accB = await access(otherId, B);
    await expect(jobs.startCreativeBatch(accB, [req({ visualSource: "brand_photo", sourceAssetIds: [photos[0]] })])).rejects.toThrow(/isn't an approved image asset/);
    await expect(jobs.startCreativeBatch(accB, [req({ visualSource: "brand_photo" })])).rejects.toThrow(/no approved product or reference photos/);
    const db = await getDb();
    const [aStrategy] = await db.select().from(schema.strategies).where(eq(schema.strategies.brandId, A.id));
    await expect(jobs.produceFromCalendar(accB, aStrategy.id, ["x"], { style: "minimalist_luxury", visualSource: "typographic" })).rejects.toThrow(/Strategy not found/);
    const [aCreative] = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, A.id)).limit(1);
    await expect(creative.updateConcept(B.id, aCreative.id, { headline: "hijack" })).rejects.toThrow(/Creative not found/);
    await expect(creative.setCreativeStatus(B.id, aCreative.id, "approved")).rejects.toThrow(/Creative not found/);
    await expect(jobs.creativeTaskStatus(B.id, aCreative.taskId!)).rejects.toThrow(/Task not found/);
    await expect(requireBrandForUser(sess(otherId), A.id, "viewer")).rejects.toThrow();
  });
});

describe("migration 0006 on an existing database", () => {
  it("keeps existing creatives and labels the ones that had no AI image as type-led", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const src = path.join(process.cwd(), "drizzle");
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mig6-"));
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(src, "meta/_journal.json"), "utf8"));
    const before = journal.entries.filter((e: { idx: number }) => e.idx < 6);
    for (const e of before) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
    fs.writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    const client = await PGlite.create({ extensions: { vector } });
    await client.exec("create extension if not exists vector");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    await client.exec(`
      insert into workspaces (id, name) values ('w1', 'Legacy');
      insert into brands (id, workspace_id, name) values ('b1', 'w1', 'Legacy Co');
      insert into creatives (id, brand_id, format, style, concept, image_path, image_provider, status) values
        ('c-ai', 'b1', 'instagram_post', 'premium_editorial', '{"headline":"A"}', 'brands/b1/creatives/c-ai.png', 'openai', 'approved'),
        ('c-type', 'b1', 'instagram_post', 'premium_editorial', '{"headline":"B"}', null, 'none', 'draft'),
        ('c-failed', 'b1', 'instagram_post', 'premium_editorial', '{"headline":"C"}', null, 'openai', 'draft');
    `);
    await migrate(db, { migrationsFolder: src });
    const rows = (await client.query<Record<string, unknown>>("select id, kind, slides, visual_source, logo_placement, status, copy, brand_check, strategy_id from creatives order by id")).rows;
    expect(rows).toEqual([
      { id: "c-ai", kind: "single", slides: [], visual_source: "ai", logo_placement: "top_left", status: "approved", copy: null, brand_check: null, strategy_id: null },
      // A failed AI image stays an AI creative (it can be regenerated); a no-provider one was type-led.
      { id: "c-failed", kind: "single", slides: [], visual_source: "ai", logo_placement: "top_left", status: "draft", copy: null, brand_check: null, strategy_id: null },
      { id: "c-type", kind: "single", slides: [], visual_source: "typographic", logo_placement: "top_left", status: "draft", copy: null, brand_check: null, strategy_id: null },
    ]);
    await client.close();
  });
});
