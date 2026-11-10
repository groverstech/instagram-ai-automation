/**
 * Creative Studio on the REAL provider paths: the real Anthropic SDK and the real OpenAI images
 * HTTP client send their requests; only the network is intercepted. Verifies request shapes,
 * storage, the cost ledger (priced and unpriced images, usage-unknown on network loss), friendly
 * refusals and the Claude vision request carrying the rendered PNG. It does not verify image or
 * review quality (that needs live keys).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.AI_RETRY_BASE_MS = "5";
process.env.AI_PROVIDER = "";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;
process.env.IMAGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "sk-openai-test-not-a-real-key";
delete process.env.IMAGE_PRICE_USD;
process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-cprov-"));

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const calls: Call[] = [];
let openai: (body: Record<string, unknown>) => Response | Promise<Response> = () => new Response("{}", { status: 500 });
let anthropic: (body: Record<string, unknown>) => Response = () => new Response("{}", { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.openai.com/") && !url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const body = JSON.parse(String(init?.body ?? "{}"));
  calls.push({ url, headers, body });
  return url.startsWith("https://api.openai.com/") ? openai(body) : anthropic(body);
}) as typeof fetch;

const okImage = () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG_1x1 }], usage: { input_tokens: 60, output_tokens: 4160 } }), { status: 200, headers: { "content-type": "application/json" } });
const claude = (obj: unknown) =>
  new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3_000, output_tokens: 500 } }), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req" },
  });

const { getDb, schema } = await import("./db/client");
const { generateVisual } = await import("./creative/visuals");
const { runBrandCheck } = await import("./creative/brand-check");
const { storage } = await import("./storage");
type Brand = import("./db/schema").Brand;
type Creative = import("./db/schema").Creative;

let brand: Brand;
let userId = "";
const CONCEPT = { title: "Blue hour", headline: "Made to last", subline: "Winter glaze, small batches", cta: "Shop now", layout: "hero_overlay", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "Deep-blue stoneware mug on linen, morning light, negative space top", imageTreatment: "Warm", rationale: "r" };

async function newCreative(over: Partial<typeof schema.creatives.$inferInsert> = {}): Promise<Creative> {
  const db = await getDb();
  const [c] = await db.insert(schema.creatives).values({ brandId: brand.id, format: "instagram_post", style: "minimalist_luxury", concept: CONCEPT, visualSource: "ai", ...over }).returning();
  return c;
}
const runsFor = async (creativeId: string) => (await getDb()).select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, brand.id)).then((r) => r.filter((x) => (x.input as { creativeId?: string } | null)?.creativeId === creativeId));

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "p@x.test", name: "P", passwordHash: "x" }).returning();
  const [ws] = await db.insert(schema.workspaces).values({ name: "WS", plan: "agency" }).returning();
  [brand] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Kora", colors: ["#2B2620", "#F3EDE4", "#B5643C"] }).returning();
  userId = u.id;
  await db.insert(schema.brandProfiles).values({ brandId: brand.id, version: 1, status: "approved", schemaVersion: 2, data: { summary: "Kora makes small-batch stoneware for everyday rituals.", identity: { archetype: "Creator", personality: [], positioning: { statement: "The modern heirloom", category: "Ceramics", source: "provided", evidence: "" }, values: [], usps: [], differentiation: [] }, audience: { personas: [], interests: [], painPoints: [], motivations: [] }, communication: { voice: { text: "Warm", source: "provided", evidence: "" }, tone: { text: "Precise", source: "provided", evidence: "" }, style: { text: "", source: "inferred", evidence: "" }, vocabulary: [], avoid: [], do: [], dont: [], sampleLines: [] }, visual: { palette: [], typography: { heading: "Serif", body: "Sans", characteristics: "", source: "inferred" }, imagery: { text: "Natural light", source: "observed", evidence: "" }, designPreferences: [], logoUsage: { text: "", source: "inferred", evidence: "" }, creativeDirection: "Quiet", preferredStyles: [] }, marketing: { objectives: [], contentPillars: [], campaignOpportunities: [], platforms: [], contentOpportunities: [] }, competitors: [], openQuestions: [], rationale: "" } });
});
beforeEach(() => {
  calls.length = 0;
  delete process.env.IMAGE_PRICE_USD;
  delete process.env.IMAGE_PRICE_USD_1024X1536;
});

describe("AI image generation (OpenAI images API)", () => {
  it("sends a well-formed request, stores the image and records an unpriced image when no price is configured", async () => {
    openai = () => okImage();
    const c = await newCreative();
    await generateVisual({ brandId: brand.id, userId }, brand, c);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://api.openai.com/v1/images/generations");
    expect(call.headers.authorization).toBe("Bearer sk-openai-test-not-a-real-key");
    expect(call.body).toMatchObject({ model: "gpt-image-1", size: "1024x1536", quality: "high", n: 1 }); // portrait 1080×1350
    expect(String(call.body.prompt)).toContain("Deep-blue stoneware mug");
    expect(String(call.body.prompt)).toMatch(/no text, letters, numbers, logos or watermarks/);
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect(after.imagePath).toMatch(new RegExp(`^brands/${brand.id}/creatives/${c.id}-`));
    expect((await storage.get(after.imagePath!)).subarray(1, 4).toString()).toBe("PNG");
    expect(after.imageProvider).toBe("openai:gpt-image-1");
    const [run] = await runsFor(c.id);
    expect(run).toMatchObject({ agent: "design_generation", status: "succeeded", costUsd: 0 });
    expect(run.usage).toMatchObject({ images: 1, unpricedImages: 1, imageModel: "gpt-image-1" });
  });

  it("prices images from configuration", async () => {
    process.env.IMAGE_PRICE_USD_1024X1536 = "0.25";
    openai = () => okImage();
    const c = await newCreative();
    await generateVisual({ brandId: brand.id, userId }, brand, c);
    const [run] = await runsFor(c.id);
    expect(run.usage).toMatchObject({ images: 1, imageCostUsd: 0.25 });
    expect(run.usage).not.toHaveProperty("unpricedImages");
    expect(run.costUsd).toBe(0.25);
  });

  it("turns a content-policy refusal into a friendly error without retrying", async () => {
    openai = () => new Response(JSON.stringify({ error: { code: "content_policy_violation", message: "Your request was rejected as a result of our safety system." } }), { status: 400 });
    const c = await newCreative();
    await expect(generateVisual({ brandId: brand.id, userId }, brand, c)).rejects.toThrow(/declined this prompt under its content policy/);
    expect(calls).toHaveLength(1);
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect(after.imageError).toMatch(/content policy/);
    const [run] = await runsFor(c.id);
    expect(run).toMatchObject({ status: "failed", attempts: 1, usage: null });
  });

  it("doesn't retry an image request whose outcome is unknown (it may already be created and charged)", async () => {
    let n = 0;
    openai = () => {
      n++;
      throw new TypeError("socket hang up");
    };
    const c = await newCreative();
    await expect(generateVisual({ brandId: brand.id, userId }, brand, c)).rejects.toThrow();
    expect(n).toBe(1); // not retried: a second request could pay for a second image
    const [run] = await runsFor(c.id);
    expect(run).toMatchObject({ status: "failed", attempts: 1 });
    expect(run.usage).toMatchObject({ unknownUsageAttempts: 1 });
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect(after.imageError).toMatch(/Couldn't reach the image service/);
    const events = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, run.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ route: "image.generate", provider: "openai", outcome: "unknown", errorKind: "network", costUsd: null, priceSource: "unknown" });
  }, 20_000);

  it("retries a server error (nothing was created) and records both attempts", async () => {
    let n = 0;
    openai = () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: { message: "boom", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json", "x-request-id": "req_img_500" } });
      return okImage();
    };
    const c = await newCreative();
    await generateVisual({ brandId: brand.id, userId }, brand, c);
    expect(n).toBe(2);
    const [run] = await runsFor(c.id);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(run.usage).toMatchObject({ images: 1 });
    const db = await getDb();
    const events = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, run.id));
    expect(events.map((e) => [e.attempt, e.outcome, e.httpStatus, e.providerRequestId])).toEqual([
      [1, "retried", 500, "req_img_500"],
      [2, "success", null, null],
    ]);
    expect(events[1].units).toMatchObject({ images: 1, inputTokens: 60, outputTokens: 4160 });
  }, 20_000);

  it("generates slide images for carousels when asked, each logged", async () => {
    openai = () => okImage();
    const c = await newCreative({ kind: "carousel", slides: [{ headline: "One", body: "b", imagePrompt: "Hands at the wheel" }, { headline: "Two", body: "b" }, { headline: "Three", body: "b", imagePrompt: "Kiln glow" }] });
    await generateVisual({ brandId: brand.id, userId }, brand, c, { slideVisuals: true });
    expect(calls).toHaveLength(3); // cover + 2 slides with art direction
    const db = await getDb();
    const [after] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect(after.slides.map((s) => Boolean(s.imagePath))).toEqual([true, false, true]);
    expect((await runsFor(c.id)).every((r) => r.status === "succeeded")).toBe(true);
  });
});

describe("brand check: Claude vision review of the rendered creative", () => {
  it("sends the rendered PNG and the approved profile, stores the review", async () => {
    openai = () => okImage();
    anthropic = (b) => {
      const keys = Object.keys((b.output_config as { format: { schema: { properties: object } } }).format.schema.properties);
      expect(keys).toEqual(expect.arrayContaining(["score", "issues", "strengths"]));
      return claude({ score: 82, summary: "On-brand overall.", issues: [{ severity: "warning", area: "typography", issue: "Headline weight heavier than brand serif.", fix: "Use the lighter weight." }], strengths: ["Palette matches"] });
    };
    const c = await newCreative();
    await generateVisual({ brandId: brand.id, userId }, brand, c);
    const db = await getDb();
    const [withImage] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    calls.length = 0;
    const check = await runBrandCheck({ brandId: brand.id, userId }, brand, withImage);
    const req = calls.find((x) => x.url.startsWith("https://api.anthropic.com/"))!;
    const content = (req.body.messages as { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }[])[0].content;
    const img = content.find((b) => b.type === "image")!;
    expect(img.source!.media_type).toBe("image/png");
    expect(Buffer.from(img.source!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(Buffer.from(img.source!.data, "base64").length).toBeGreaterThan(5_000); // the full rendered creative, not a stub
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    expect(text).toContain("Kora makes small-batch stoneware");
    expect(text).toContain('Headline: "Made to last"');
    expect(check.mode).toBe("full");
    expect(check.review!.score).toBe(82);
    expect(check.review!.issues[0].severity).toBe("warning");
    expect(check.checks.filter((x) => x.status === "fail")).toEqual([]);
    expect(check.blocking).toBe(false);
    const [stored] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, c.id));
    expect((stored.brandCheck as { score: number }).score).toBe(check.score);
  });

  it("can be limited to deterministic checks by configuration", async () => {
    process.env.CREATIVE_BRAND_CHECK = "off";
    const c = await newCreative({ visualSource: "typographic", imageProvider: "none" });
    const check = await runBrandCheck({ brandId: brand.id, userId }, brand, c);
    delete process.env.CREATIVE_BRAND_CHECK;
    expect(calls).toHaveLength(0);
    expect(check.mode).toBe("deterministic_only");
    expect(check.review).toBeNull();
  });
});
