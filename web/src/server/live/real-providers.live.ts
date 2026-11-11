/**
 * LIVE real-provider validation for the Creative Studio. Calls the real, paid OpenAI image API
 * and the real Anthropic API. Never part of `npm test` or CI: run with `npm run test:live`.
 *
 * It refuses to run in demo mode (AI_PROVIDER=mock). A provider whose key is missing is reported
 * as NOT RUN, never as passed. Keys are read from the server environment only and are never
 * written to output: the report is scanned for them before the run ends.
 *
 *   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… npm run test:live
 *
 * Each provider can be validated on its own: with only OPENAI_API_KEY, the image tests use a fixed
 * creative concept instead of one written by Claude; with only ANTHROPIC_API_KEY, the text and
 * vision tests run and the image tests are reported as not run.
 *
 * Behind an HTTPS proxy (e.g. a sandbox without direct DNS), also set NODE_USE_ENV_PROXY=1 so
 * Node's fetch uses HTTPS_PROXY.
 *
 * Outputs (PNG per format, the raw AI image, report.json) go to LIVE_REPORT_DIR
 * (default: a new temp directory, printed at the end).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

if (process.env.AI_PROVIDER === "mock") throw new Error("Refusing to run live provider tests in demo mode (AI_PROVIDER=mock).");
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || "openai";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-live-store-"));
const OUT = process.env.LIVE_REPORT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "bp-live-report-"));
fs.mkdirSync(OUT, { recursive: true });

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const { getDb, schema } = await import("../db/client");
const { requireBrandForUser } = await import("../auth/guard");
const { storage } = await import("../storage");
const { mockActive } = await import("../ai/mode");
const { friendlyAIError, aiStatus } = await import("../ai/llm");
const { imageProvider } = await import("../ai/image");
const jobs = await import("../creative/jobs");
const { runBrandCheck } = await import("../creative/brand-check");
const { writeCreativeCopy } = await import("../creative/copy");
const { renderCreativePng } = await import("../creative/render");
const { paletteDistance } = await import("@/lib/creative-quality");
const { FORMATS } = await import("@/lib/domain");
type Brand = import("../db/schema").Brand;
type Creative = import("../db/schema").Creative;

type Result = { status: "passed" | "failed" | "not_run"; reason?: string; metrics?: Record<string, unknown> };
const report: Record<string, Result> = {};
const record = (name: string, r: Result) => (report[name] = r);

let ownerId = "";
let brand: Brand;
let aiCreative: Creative | null = null;
const sess = (id: string) => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });

async function sharpLib() {
  return (await import("sharp")).default;
}

beforeAll(async () => {
  expect(mockActive()).toBe(false);
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ email: "live@x.test", name: "Live", passwordHash: "x" }).returning();
  ownerId = o.id;
  const [w] = await db.insert(schema.workspaces).values({ name: "Live test", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: o.id, role: "owner" });
  [brand] = await db
    .insert(schema.brands)
    .values({
      workspaceId: w.id,
      name: "Kora Ceramics",
      industry: "Handmade ceramics",
      description: "A two-person studio making small-batch stoneware for everyday use.",
      products: "Stoneware mugs, serving bowls, dinner sets",
      targetAudience: "Design-conscious hosts aged 28-45",
      platforms: ["instagram", "pinterest"],
      colors: ["#2E4A3A", "#F3EDE4", "#B5643C"],
      fonts: { heading: "Playfair Display", body: "Inter" },
    })
    .returning();
});

afterAll(() => {
  const out = JSON.stringify({ ranAt: new Date().toISOString(), textModel: aiStatus().model, imageProvider: imageProvider()?.name ?? "none", report }, null, 2);
  fs.writeFileSync(path.join(OUT, "report.json"), out);
  // Never leave a key in any output file.
  const secrets = [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN].filter((s): s is string => Boolean(s && s.length >= 12));
  for (const f of fs.readdirSync(OUT)) {
    const text = fs.readFileSync(path.join(OUT, f)).toString("latin1");
    for (const s of secrets) if (text.includes(s)) throw new Error(`A provider key leaked into ${f}`);
  }
  console.log(`\nLive report: ${path.join(OUT, "report.json")}`);
  for (const [k, v] of Object.entries(report)) console.log(`  ${v.status.toUpperCase().padEnd(8)} ${k}${v.reason ? ` (${v.reason})` : ""}`);
});

/** A fixed concept, for validating OpenAI without Anthropic (normally Claude writes it). */
const FIXED_CONCEPT = { title: "Winter glaze", headline: "Made for slow mornings", subline: "Small-batch stoneware", cta: "Shop the collection", layout: "hero_overlay", palette: { background: "#F3EDE4", foreground: "#2E4A3A", accent: "#B5643C" }, imagePrompt: "Deep forest-green stoneware mugs on a linen table, soft morning window light, negative space at the top", imageTreatment: "Warm, natural", rationale: "Fixed concept for provider validation" };

describe.skipIf(!HAS_OPENAI)("OpenAI image generation (real API; concepts from Claude, or a fixed concept without an Anthropic key)", () => {
  it("generates an on-brand AI visual, stores it, and records image usage and cost", async () => {
    const t0 = Date.now();
    const db = await getDb();
    let task: { status: string; error: string | null; costUsd: number | null } | null = null;
    let taskId: string | null = null;
    if (HAS_ANTHROPIC) {
      const acc = await requireBrandForUser(sess(ownerId), brand.id, "editor");
      taskId = await jobs.startCreativeBatch(
        acc,
        [{ brief: "Winter glaze collection launch: deep forest-green stoneware mugs on a linen table, soft morning window light, cosy weekend hosting.", format: "instagram_post", style: "premium_editorial", count: 1, objective: "sales", visualSource: "ai" }],
        { inline: true },
      );
      [task] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
      [aiCreative] = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
      expect(task!.status, task!.error ?? "").toBe("succeeded");
    } else {
      const { generateVisual } = await import("../creative/visuals");
      const [c] = await db.insert(schema.creatives).values({ brandId: brand.id, format: "instagram_post", style: "premium_editorial", concept: FIXED_CONCEPT, visualSource: "ai" }).returning();
      await generateVisual({ brandId: brand.id, userId: ownerId }, brand, c);
      [aiCreative] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    }
    expect(aiCreative!.imageError).toBeNull();
    expect(aiCreative!.imageProvider).toMatch(/^openai:/);
    const raw = await storage.get(aiCreative!.imagePath!);
    fs.writeFileSync(path.join(OUT, "ai-image-raw.png"), raw);
    const sharp = await sharpLib();
    const meta = await sharp(raw).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1536]); // portrait size for a 4:5 post

    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, brand.id));
    const img = runs.filter((r) => r.agent === "design_generation" && (r.input as { creativeId?: string } | null)?.creativeId === aiCreative!.id);
    const usage = img.map((r) => r.usage as { images?: number; imageModel?: string; imageCostUsd?: number; unpricedImages?: number });
    expect(usage.reduce((n, u) => n + (u.images ?? 0), 0)).toBeGreaterThanOrEqual(1);
    expect(usage[0].imageModel).toBeTruthy();

    // Brand-colour affinity: how close the image's dominant colours are to the brand palette.
    const { dominant } = await sharp(raw).stats();
    const hex = `#${[dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const deltaE = paletteDistance(hex, brand.colors);
    record("openai.image_generation", {
      status: "passed",
      metrics: { seconds: Math.round((Date.now() - t0) / 1000), size: `${meta.width}x${meta.height}`, model: usage[0].imageModel, images: usage.reduce((n, u) => n + (u.images ?? 0), 0), imageCostUsd: usage.reduce((n, u) => n + (u.imageCostUsd ?? 0), 0), unpricedImages: usage.reduce((n, u) => n + (u.unpricedImages ?? 0), 0), taskCostUsd: task?.costUsd ?? null, conceptFrom: HAS_ANTHROPIC ? "claude" : "fixed", dominantColour: hex, dominantDeltaEToPalette: deltaE },
    });
  }, 300_000);

  it("renders the real AI image into every supported format", async () => {
    expect(aiCreative).toBeTruthy();
    const sharp = await sharpLib();
    const sizes: Record<string, string> = {};
    for (const f of FORMATS) {
      const png = await renderCreativePng(aiCreative!, brand, f.id);
      const m = await sharp(png).metadata();
      expect([m.width, m.height]).toEqual([f.w, f.h]);
      fs.writeFileSync(path.join(OUT, `format-${f.id}.png`), png);
      sizes[f.id] = `${m.width}x${m.height}`;
    }
    record("render.all_formats_with_real_image", { status: "passed", metrics: sizes });
  }, 300_000);
});

describe.skipIf(!HAS_ANTHROPIC)("Anthropic vision review and copy (real API)", () => {
  it("reviews the rendered creative with the real model and records token usage and cost", async () => {
    const db = await getDb();
    let c = aiCreative;
    if (!c) {
      // Without an image key, review a type-led creative instead (still a real vision call).
      const acc = await requireBrandForUser(sess(ownerId), brand.id, "editor");
      const taskId = await jobs.startCreativeBatch(acc, [{ brief: "Care guide for handmade stoneware", format: "instagram_post", style: "premium_editorial", count: 1, objective: "education", visualSource: "typographic" }], { inline: true });
      [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    }
    const check = await runBrandCheck({ brandId: brand.id, userId: ownerId }, brand, c!);
    expect(check.mode).toBe("full");
    expect(check.reviewer).toMatchObject({ provider: "anthropic" });
    expect(check.review?.summary ?? "").not.toMatch(/\[Demo\]/);
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, check.runId!));
    const u = run.usage as { inputTokens?: number; outputTokens?: number } | null;
    expect(u?.inputTokens ?? 0).toBeGreaterThan(500); // includes the image
    expect(run.costUsd ?? 0).toBeGreaterThan(0);
    record("anthropic.vision_review", { status: "passed", metrics: { score: check.score, reviewScore: check.review?.score, blocking: check.blocking, issues: check.review?.issues.length, model: check.reviewer?.model, inputTokens: u?.inputTokens, outputTokens: u?.outputTokens, costUsd: run.costUsd } });
  }, 300_000);

  it("writes a real copy pack in the brand voice with originality checks", async () => {
    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.brandId, brand.id)).limit(1);
    const pack = await writeCreativeCopy({ brandId: brand.id, userId: ownerId }, brand, c);
    expect(pack.primary).not.toMatch(/\[Demo\]/);
    expect(pack.primary.length).toBeGreaterThan(40);
    expect(pack.hashtags.length).toBeGreaterThan(0);
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, pack.runId!));
    expect(run.costUsd ?? 0).toBeGreaterThan(0);
    record("anthropic.copy_pack", { status: "passed", metrics: { chars: pack.primary.length, hashtags: pack.hashtags.length, cliches: pack.originality.cliches, retried: pack.originality.retried, costUsd: run.costUsd } });
  }, 300_000);
});

// These make real requests with deliberately invalid keys: they need network access, not a key,
// and cost nothing.
describe("real error handling with invalid keys (no key needed)", () => {
  it("OpenAI rejects an invalid key: clear message, not retried as transient, no image usage", async () => {
    const { ImageProviderError } = await import("../ai/image");
    const { isTransient } = await import("../ai/llm");
    const saved = { key: process.env.OPENAI_API_KEY, provider: process.env.IMAGE_PROVIDER };
    process.env.OPENAI_API_KEY = "sk-invalid-live-test-key";
    process.env.IMAGE_PROVIDER = "openai";
    try {
      const p = imageProvider()!;
      expect(p.name).toMatch(/^openai:/);
      const err = await p.generate("A ceramic mug", "1024x1024").then(() => null, (e) => e);
      expect(err).toBeInstanceOf(ImageProviderError);
      expect((err as InstanceType<typeof ImageProviderError>).status).toBe(401);
      expect(friendlyAIError(err)).toMatch(/rejected the API key/);
      expect(isTransient(err)).toBe(false); // a bad key is not retried as a temporary outage
      record("openai.bad_key_handling", { status: "passed", metrics: { httpStatus: 401, message: friendlyAIError(err) } });
    } finally {
      process.env.OPENAI_API_KEY = saved.key;
      process.env.IMAGE_PROVIDER = saved.provider;
    }
  }, 60_000);

  it("Anthropic rejects an invalid key with a clear message", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const bad = new Anthropic({ apiKey: "sk-ant-invalid-live-test-key" });
    const err = await bad.messages.create({ model: aiStatus().model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(401);
    expect(friendlyAIError(err)).toMatch(/rejected the API key/);
    record("anthropic.bad_key_handling", { status: "passed", metrics: { httpStatus: 401, message: friendlyAIError(err) } });
  }, 60_000);
});

describe("live run preconditions", () => {
  it("reports providers that could not be tested instead of passing them", () => {
    const missing = [!HAS_OPENAI && "OPENAI_API_KEY", !HAS_ANTHROPIC && "ANTHROPIC_API_KEY"].filter(Boolean).join(" and ");
    if (!HAS_OPENAI) for (const k of ["openai.image_generation", "render.all_formats_with_real_image", "openai.image_variation", "openai.image_edit"]) record(k, { status: "not_run", reason: "OPENAI_API_KEY not set" });
    if (!HAS_OPENAI && !HAS_ANTHROPIC) record("ledger.real_request_ids", { status: "not_run", reason: `${missing} not set` });
    if (!HAS_ANTHROPIC) for (const k of ["anthropic.vision_review", "anthropic.copy_pack"]) record(k, { status: "not_run", reason: "ANTHROPIC_API_KEY not set" });
    expect(mockActive()).toBe(false);
  });
});

describe.skipIf(!HAS_OPENAI)("PR 4.1: image variations and precision edits (real API)", () => {
  it("creates a variation of the real AI image through the edits endpoint", async () => {
    if (!aiCreative) return record("openai.image_variation", { status: "not_run", reason: "no AI image was generated earlier in this run" });
    const { aiVariation } = await import("../creative/visuals");
    const before = aiCreative.imagePath;
    await aiVariation({ brandId: brand.id, userId: ownerId }, brand, aiCreative, "closer crop, warmer light");
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, aiCreative.id));
    expect(after.imageError).toBeNull();
    expect(after.imagePath).not.toBe(before);
    fs.writeFileSync(path.join(OUT, "ai-image-variation.png"), await storage.get(after.imagePath!));
    const [ev] = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.route, "image.variation"));
    expect(ev).toMatchObject({ provider: "openai", outcome: "success" });
    expect(ev.providerRequestId).toBeTruthy();
    expect(ev.costUsd).not.toBeNull(); // priced from the token usage OpenAI reported
    record("openai.image_variation", { status: "passed", metrics: { model: ev.model, params: ev.params, requestId: ev.providerRequestId, latencyMs: ev.latencyMs, units: ev.units, costUsd: ev.costUsd, priceSource: ev.priceSource } });
    aiCreative = after;
  }, 600_000);

  it("makes a precision edit of the real AI image (GPT Image 2.6 Sunburst by default)", async () => {
    if (!aiCreative?.imagePath) return record("openai.image_edit", { status: "not_run", reason: "no AI image was generated earlier in this run" });
    const { aiEdit } = await import("../creative/visuals");
    const before = aiCreative.imagePath;
    await aiEdit({ brandId: brand.id, userId: ownerId }, brand, aiCreative, "make the linen tablecloth a warm terracotta colour");
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, aiCreative.id));
    expect(after.imageError).toBeNull();
    expect(after.imagePath).not.toBe(before);
    fs.writeFileSync(path.join(OUT, "ai-image-edit.png"), await storage.get(after.imagePath!));
    const [ev] = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.route, "image.edit"));
    expect(ev).toMatchObject({ provider: "openai", outcome: "success" });
    expect(ev.costUsd).not.toBeNull();
    record("openai.image_edit", { status: "passed", metrics: { model: ev.model, params: ev.params, requestId: ev.providerRequestId, latencyMs: ev.latencyMs, units: ev.units, costUsd: ev.costUsd, priceSource: ev.priceSource } });
  }, 600_000);
});

describe.skipIf(!HAS_OPENAI && !HAS_ANTHROPIC)("PR 4.1: the usage ledger (real APIs)", () => {
  it("records every real request in the usage ledger with the provider's request ID and a price source", async () => {
    const db = await getDb();
    const events = await db.select().from(schema.usageEvents);
    const real = events.filter((e) => e.provider !== "mock");
    expect(real.length).toBeGreaterThan(0);
    const ok = real.filter((e) => e.outcome === "success");
    for (const e of ok) {
      expect(e.providerRequestId, `${e.route} has no request ID`).toBeTruthy();
      expect(e.priceSource).toBeTruthy();
    }
    // Anthropic successes are priced from the list; reconcile totals against the provider console.
    const text = ok.filter((e) => e.provider === "anthropic");
    expect(text.every((e) => e.costUsd !== null)).toBe(true);
    record("ledger.real_request_ids", {
      status: "passed",
      metrics: {
        requests: real.length,
        outcomes: Object.fromEntries([...new Set(real.map((e) => e.outcome))].map((o) => [o, real.filter((e) => e.outcome === o).length])),
        estimatedUsd: real.reduce((s, e) => s + (e.costUsd ?? 0), 0),
        unpriced: real.filter((e) => e.priceSource === "unpriced").length,
        requestIds: ok.map((e) => `${e.provider}:${e.providerRequestId}`),
      },
    });
  });
});
