/**
 * The Marketing Strategist on the REAL Anthropic provider path: the actual SDK builds and sends
 * each request; only the network is intercepted. This verifies request shape (web search tool,
 * structured outputs), that the approved profile reaches the prompt, server-side source
 * verification, cost tracking, retries and failure handling. It does NOT verify the quality of
 * real model output; that needs a live API key (see docs/STRATEGIST.md).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.STRATEGIST_WEB_SEARCH;
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";

type Captured = { body: Record<string, unknown> };
const captured: Captured[] = [];
let respond: (body: Record<string, unknown>, n: number) => Response = () => new Response("{}", { status: 500 });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  captured.push({ body });
  return respond(body, captured.length);
}) as typeof fetch;

const msg = (content: unknown[], usage: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10_000, output_tokens: 2_000, ...usage } }), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });
const json = (v: unknown) => msg([{ type: "text", text: JSON.stringify(v) }]);
const apiError = (status: number, type: string) => new Response(JSON.stringify({ type: "error", error: { type, message: `${type} (test)` } }), { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
const isStructured = (b: Record<string, unknown>) => Boolean((b.output_config as { format?: unknown } | undefined)?.format);
const schemaKeys = (b: Record<string, unknown>) => Object.keys((b.output_config as { format: { schema: { properties: object } } }).format.schema.properties);
const promptOf = (b: Record<string, unknown>) => JSON.stringify(b.messages);

const { getDb, schema } = await import("./db/client");
const { requireBrandForUser } = await import("./auth/guard");
const store = await import("./strategist/store");
const wf = await import("./strategist/workflow");
const agents = await import("./strategist/agents");
const { estimateCost } = await import("./ai/pricing");
const { StrategyInputs } = await import("@/lib/strategy");

const f = (text: string, source = "provided") => ({ text, source, evidence: "onboarding" });
const PROFILE = {
  summary: "Kora makes small-batch stoneware for everyday rituals.",
  identity: { archetype: "Creator", personality: [f("calm")], positioning: { statement: "The modern heirloom", category: "Ceramics", source: "provided", evidence: "onboarding" }, values: [f("craft")], usps: [f("Small batches")], differentiation: [f("Made in Porto")] },
  audience: { personas: [{ name: "Host", snapshot: "Design-conscious host", demographics: "Not specified", interests: [], painPoints: [], motivations: [], channels: ["instagram"], source: "inferred" }], interests: [], painPoints: [], motivations: [] },
  communication: { voice: f("Warm"), tone: f("Precise"), style: f("Short sentences"), vocabulary: [], avoid: [], do: [], dont: [], sampleLines: [] },
  visual: { palette: [], typography: { heading: "Serif", body: "Sans", characteristics: "", source: "inferred" }, imagery: f("Natural light"), designPreferences: [], logoUsage: f("Clear space"), creativeDirection: "Quiet", preferredStyles: [] },
  marketing: { objectives: [f("awareness")], contentPillars: [], campaignOpportunities: [], platforms: [], contentOpportunities: [] },
  competitors: [{ name: "ClayCo", positioning: "Mass-market", howWeDiffer: "Handmade", source: "provided" }],
  openQuestions: [],
  rationale: "test",
};

const SEARCH_URL = "https://www.example-news.com/ceramics-trends-2026";
const researchResponse = () =>
  msg(
    [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "handmade ceramics trends Portugal 2026" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          { type: "web_search_result", url: SEARCH_URL, title: "Ceramics trends 2026", page_age: "March 3, 2026", encrypted_content: "x" },
          { type: "web_search_result", url: "https://clayco.example/about", title: "About ClayCo", page_age: null, encrypted_content: "y" },
        ],
      },
      { type: "text", text: "Handmade tableware demand is growing.", citations: [{ type: "web_search_result_location", url: SEARCH_URL, title: "Ceramics trends 2026", encrypted_index: "z", cited_text: "demand for handmade tableware grew" }] },
    ],
    { server_tool_use: { web_search_requests: 2 } },
  );
const structuredResearch = () =>
  json({
    summary: "Growing interest in handmade tableware.",
    industryOverview: "Overview",
    findings: [
      { category: "trend", title: "Handmade demand up", detail: "Demand for handmade tableware grew in 2026.", basis: "sourced", sourceUrls: [SEARCH_URL], evidence: "Trend article", confidence: "medium" },
      { category: "industry", title: "Market size", detail: "The market is worth $4 billion.", basis: "sourced", sourceUrls: ["https://invented.example/report"], evidence: "made up", confidence: "high" },
      { category: "content_opportunity", title: "Care guides", detail: "Few brands publish care content.", basis: "hypothesis", sourceUrls: [], evidence: "Reasoning", confidence: "low" },
    ],
    competitors: [{ name: "ClayCo", positioning: "Mass-market", strengths: ["Range"], weaknesses: ["Generic"], contentApproach: "Promos", opportunity: "Own craft", basis: "sourced", sourceUrls: ["https://clayco.example/about"] }],
    openQuestions: ["Price range?"],
  });

let brandId = "";
let userId = "";
beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "s@example.com", name: "S", passwordHash: "x" }).returning();
  const [ws] = await db.insert(schema.workspaces).values({ name: "WS", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: "owner" });
  const [b] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Kora", industry: "Ceramics", products: "Stoneware", targetAudience: "Hosts", geography: "Portugal", competitors: ["ClayCo"], platforms: ["instagram"] }).returning();
  await db.insert(schema.brandProfiles).values({ brandId: b.id, version: 1, status: "approved", schemaVersion: 2, data: PROFILE });
  brandId = b.id;
  userId = u.id;
});
beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
  captured.length = 0;
});

const ctxFor = async () => {
  const db = await getDb();
  const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
  const row = await store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);
  return { scope: { brandId, userId }, brand: b, doc: store.docOf(row), strategyId: row.id };
};

describe("Market research agent on the real provider path", () => {
  it("searches the web, then verifies every finding against the actual search results", async () => {
    respond = (b) => (isStructured(b) ? structuredResearch() : researchResponse());
    const out = await agents.runResearch(await ctxFor());
    expect(captured).toHaveLength(2);

    // 1) Web research request: server-side web search tool, no structured format.
    const r1 = captured[0].body;
    expect(r1).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" } });
    expect(r1.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 8 }]);
    expect(promptOf(r1)).toContain("Kora makes small-batch stoneware"); // approved profile retrieved first
    expect(promptOf(r1)).toContain("Market: Portugal");
    // 2) Structuring request: JSON schema output with the real search results listed.
    const r2 = captured[1].body;
    expect(schemaKeys(r2)).toEqual(expect.arrayContaining(["findings", "competitors", "openQuestions"]));
    expect(promptOf(r2)).toContain(SEARCH_URL);
    expect(promptOf(r2)).toContain("published March 3, 2026");

    const d = out.data;
    expect(d.mode).toBe("web_search");
    expect(d.webSearches).toBe(2);
    expect(d.sources.map((s) => [s.url, s.publishedAt])).toEqual([
      [SEARCH_URL, "March 3, 2026"],
      ["https://clayco.example/about", null],
    ]);
    expect(d.findings[0]).toMatchObject({ verified: true, sourceUrls: [SEARCH_URL] });
    // The model claimed a source it never received: downgraded, URL stripped, figure flagged.
    expect(d.findings[1]).toMatchObject({ verified: false, basis: "hypothesis", sourceUrls: [], unmatchedUrls: ["https://invented.example/report"], unsourcedFigure: true });
    expect(d.findings[2]).toMatchObject({ verified: false, basis: "hypothesis" });
    expect(d.competitors[0]).toMatchObject({ verified: true, sourceUrls: ["https://clayco.example/about"] });

    // Tokens, web searches and estimated cost are tracked per agent run.
    expect(out.usage).toMatchObject({ inputTokens: 20_000, outputTokens: 4_000, webSearches: 2 });
    expect(out.costUsd).toBeCloseTo(estimateCost({ inputTokens: 20_000, outputTokens: 4_000, webSearches: 2, model: "claude-opus-5-5" }), 6);
    expect(out.costUsd).toBeGreaterThan(0);
    const db = await getDb();
    const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.brandId, brandId), eq(schema.agentRuns.agent, "market_research")));
    expect(runs.every((r) => r.status === "succeeded" && r.model === "claude-opus-5-5" && (r.costUsd ?? 0) > 0)).toBe(true);
  });

  it("falls back to clearly-labelled hypotheses when web search isn't available", async () => {
    respond = (b) => (isStructured(b) ? structuredResearch() : apiError(400, "invalid_request_error"));
    const out = await agents.runResearch(await ctxFor());
    expect(out.data.mode).toBe("no_search");
    expect(out.data.modeNote).toMatch(/Web search wasn't available/);
    expect(out.data.sources).toEqual([]);
    expect(out.data.findings.every((x) => !x.verified && x.sourceUrls.length === 0)).toBe(true);
    expect(promptOf(captured.at(-1)!.body)).toContain("No web search results are available");
  });

  it("can be switched off by configuration without pretending research happened", async () => {
    process.env.STRATEGIST_WEB_SEARCH = "off";
    respond = (b) => (isStructured(b) ? structuredResearch() : researchResponse());
    const out = await agents.runResearch(await ctxFor());
    delete process.env.STRATEGIST_WEB_SEARCH;
    expect(captured).toHaveLength(1);
    expect(captured[0].body.tools).toBeUndefined();
    expect(out.data.mode).toBe("no_search");
    expect(out.data.modeNote).toMatch(/turned off/);
  });
});

describe("workflow failure handling on the real provider path", () => {
  it("retries a truncated structured response once and succeeds", async () => {
    let audienceCalls = 0;
    respond = (b) => {
      if (!isStructured(b)) return researchResponse();
      const keys = schemaKeys(b);
      if (keys.includes("findings")) return structuredResearch();
      if (keys.includes("personas")) {
        audienceCalls++;
        if (audienceCalls === 1) return msg([{ type: "text", text: '{"overview":"cut' }], {});
        return json({ overview: "o", segments: [], personas: [{ name: "Host", summary: "s", demographics: "Not established", demographicsBasis: "assumption", interests: [], needs: [], painPoints: [], motivations: [], objections: [], contentPreferences: [], platforms: ["instagram", "tiktok"], engagementOpportunities: [] }], insights: [] });
      }
      return apiError(500, "api_error");
    };
    const ctx = await ctxFor();
    const out = await agents.runAudience({ ...ctx, doc: { ...ctx.doc, sections: {} } });
    expect(audienceCalls).toBe(2);
    expect(out.data.personas[0].platforms).toEqual(["instagram"]); // unselected platform removed
    expect(out.data.personas[0].approved).toBe(false);
  });

  it("fails the task with a friendly message on an API outage, keeps completed work and releases the lease", async () => {
    respond = (b) => {
      if (!isStructured(b)) return researchResponse();
      if (schemaKeys(b).includes("findings")) return structuredResearch();
      return apiError(500, "api_error");
    };
    const db = await getDb();
    const row = await store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "s@example.com", name: "S" } }, brandId, "editor");
    const taskId = await wf.startTask(access, row.id, { sections: ["research", "audience"], inline: true });
    const t = await wf.taskStatus(brandId, taskId);
    expect(t.status).toBe("failed");
    expect(t.error).toBe("The AI service is temporarily unavailable. Please try again shortly.");
    expect(t.steps.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(t.inputTokens).toBe(20_000);
    expect(t.costUsd).toBeGreaterThan(0);
    const doc = store.docOf((await store.getStrategy(brandId, row.id))!);
    expect(doc.sections.research?.data.mode).toBe("web_search");
    expect(doc.sections.audience).toBeUndefined();
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
    // Error text stored for users never contains raw API payloads.
    expect(JSON.stringify(t)).not.toContain("api_error (test)");
  }, 20_000);
});
