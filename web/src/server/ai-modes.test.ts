import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

// Demo mode with an OpenAI key configured: the key must never be used.
process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "sk-test-demo-mode-must-not-use-this";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-modes-"));

const { getDb, schema } = await import("./db/client");
const { generateBrandProfile, approveProfile } = await import("./agents/brand");
const { requireBrandForUser } = await import("./auth/guard");
const jobs = await import("./creative/jobs");
const { imageProvider, imageStatus } = await import("./ai/image");
const { mockActive } = await import("./ai/mode");
type Brand = import("./db/schema").Brand;

let ownerId = "";
let A: Brand;
const sess = (id: string) => ({ sessionId: `s-${id}`, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ email: "m@x.test", name: "M", passwordHash: "x" }).returning();
  ownerId = o.id;
  const [w] = await db.insert(schema.workspaces).values({ name: "Demo", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: o.id, role: "owner" });
  [A] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora", platforms: ["instagram"], colors: ["#2B2620", "#F3EDE4"] }).returning();
  const { profile } = await generateBrandProfile({ brandId: A.id, userId: o.id }, A);
  await approveProfile(A.id, profile.id, o.id);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("demo and production AI modes stay separate", () => {
  it("demo mode makes a labelled placeholder and never calls the paid image API, even with a key set", async () => {
    expect(mockActive()).toBe(true);
    expect(imageProvider()?.name).toBe("mock");
    expect(imageStatus()).toMatchObject({ ready: true, provider: "mock", demo: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const acc = await requireBrandForUser(sess(ownerId), A.id, "editor");
    const taskId = await jobs.startCreativeBatch(acc, [{ brief: "Demo-mode AI image check", format: "instagram_post", style: "minimalist_luxury", count: 1, objective: "awareness", visualSource: "ai" }], { inline: true });
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("openai.com"))).toHaveLength(0);

    const db = await getDb();
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.taskId, taskId));
    expect(c.imageProvider).toBe("mock");
    expect(c.imagePath).toBeTruthy();
    // No image usage is recorded for a placeholder.
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agent, "design_generation"));
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect((r.usage as { images?: number } | null)?.images ?? 0).toBe(0);
    // The brand check never presents demo output as real.
    const check = c.brandCheck as { reviewer: { provider: string }; modeNote?: string; checks: { id: string; status: string; detail: string }[] };
    expect(check.reviewer.provider).toBe("mock");
    expect(check.modeNote).toMatch(/Demo mode/);
    const visual = check.checks.find((x) => x.id === "visual")!;
    expect(visual.status).toBe("warn");
    expect(visual.detail).toMatch(/Demo placeholder/);
  });

  it("IMAGE_PROVIDER=none disables AI images in demo mode too", () => {
    vi.stubEnv("IMAGE_PROVIDER", "none");
    expect(imageProvider()).toBeNull();
    expect(imageStatus()).toMatchObject({ ready: false, demo: false });
  });

  it("production ignores a stray AI_PROVIDER=mock: the real image provider is used", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_ALLOW_MOCK_IN_PRODUCTION", "");
    expect(mockActive()).toBe(false);
    expect(imageProvider()?.name).toMatch(/^openai:/);
    expect(imageStatus().demo).toBe(false);
  });
});
