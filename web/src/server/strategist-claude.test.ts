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
let respond: (body: Record<string, unknown>, n: number) => Response | Promise<Response> = () => new Response("{}", { status: 500 });

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

  it("retries an API outage automatically with backoff, never re-runs finished steps, then fails cleanly", async () => {
    respond = (b) => {
      if (!isStructured(b)) return researchResponse();
      if (schemaKeys(b).includes("findings")) return structuredResearch();
      return apiError(500, "api_error");
    };
    const db = await getDb();
    const row = await store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "s@example.com", name: "S" } }, brandId, "editor");
    const taskId = await wf.startTask(access, row.id, { sections: ["research", "audience"], inline: true });
    let [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    // Attempt 1: research done, audience hit a 5xx → queued for an automatic retry, slot released.
    expect(t.status).toBe("queued");
    expect(t.attempts).toBe(1);
    expect(t.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(t.error).toMatch(/temporarily unavailable.*Retrying automatically \(attempt 2 of 3\)/);
    expect(t.steps.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
    expect(await store.activeTask(brandId, row.id)).not.toBeNull(); // still blocks edits / duplicate starts
    // Attempts 2 and 3 (backoff skipped for the test).
    for (const expected of ["retrying", "failed"]) {
      await db.update(schema.aiTasks).set({ runAfter: new Date() }).where(eq(schema.aiTasks.id, taskId));
      expect(await wf.runTask(taskId)).toBe(expected);
    }
    [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("failed");
    expect(t.attempts).toBe(3);
    expect(t.error).toBe("The AI service is temporarily unavailable. Please try again shortly.");
    expect(t.steps.map((s) => s.status)).toEqual(["done", "failed"]);
    // Research ran exactly once across three attempts: no duplicate AI spend.
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));
    expect(runs.filter((r) => r.agent === "market_research")).toHaveLength(2); // web call + structuring call, once each
    expect(runs.filter((r) => r.agent === "audience_intelligence").map((r) => [r.status, r.attempts, r.usage])).toEqual([
      ["failed", 2, null],
      ["failed", 2, null],
      ["failed", 2, null],
    ]); // 5xx responses carry no usage: nothing billed, nothing counted
    expect(t.inputTokens).toBe(20_000);
    expect(t.costUsd).toBeCloseTo(runs.reduce((s, r) => s + (r.costUsd ?? 0), 0), 6);
    const doc = store.docOf((await store.getStrategy(brandId, row.id))!);
    expect(doc.sections.research?.data.mode).toBe("web_search");
    expect(doc.sections.research?.taskId).toBe(taskId);
    expect(doc.sections.audience).toBeUndefined();
    expect(await db.select().from(schema.aiTaskLeases)).toHaveLength(0);
    expect(JSON.stringify(t)).not.toContain("api_error (test)");
  }, 30_000);
});

describe("AI usage accounting for failed and retried requests", () => {
  const AUD = { overview: "o", segments: [], personas: [{ name: "Host", summary: "s", demographics: "Not established", demographicsBasis: "assumption", interests: [], needs: [], painPoints: [], motivations: [], objections: [], contentPreferences: [], platforms: ["instagram"], engagementOpportunities: [] }], insights: [] };
  const run = async (sections: ("research" | "audience")[]) => {
    const row = await store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "s@example.com", name: "S" } }, brandId, "editor");
    const taskId = await wf.startTask(access, row.id, { sections, inline: true });
    const db = await getDb();
    const [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));
    return { t, runs, row };
  };

  it("bills a rejected (truncated) response and the successful retry, each exactly once", async () => {
    let n = 0;
    respond = (b) => {
      if (!isStructured(b) || !schemaKeys(b).includes("personas")) return apiError(400, "invalid_request_error");
      n++;
      return n === 1 ? msg([{ type: "text", text: '{"overview":"cut' }], { input_tokens: 7_000, output_tokens: 16_000 }) : json(AUD);
    };
    const { t, runs, row } = await run(["audience"]);
    expect(t.status).toBe("succeeded");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    // 7k + 10k input, 16k + 2k output: the truncated attempt was billed by the provider, so it counts.
    expect(runs[0].usage).toMatchObject({ inputTokens: 17_000, outputTokens: 18_000 });
    expect(runs[0].costUsd).toBeCloseTo(estimateCost({ inputTokens: 17_000, outputTokens: 18_000, model: "claude-opus-5-5" }), 6);
    expect(t).toMatchObject({ inputTokens: 17_000, outputTokens: 18_000 });
    expect(t.costUsd).toBeCloseTo(runs[0].costUsd!, 6);
    expect((await wf.strategyCost(brandId, row.id)).costUsd).toBeCloseTo(runs[0].costUsd!, 6);
  });

  it("bills a step that failed on every attempt (refusal, invalid output) and shows it in task and strategy totals", async () => {
    let n = 0;
    respond = (b) => {
      if (!isStructured(b)) return apiError(400, "invalid_request_error");
      n++;
      return n === 1
        ? msg([{ type: "text", text: "{}" }], { input_tokens: 6_000, output_tokens: 900 }) // valid JSON, wrong shape → retried
        : new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 5_000, output_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } }); // refusal → not retried
    };
    const { t, runs, row } = await run(["audience"]);
    expect(t.status).toBe("failed"); // not a service error: no automatic retry of the task
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", attempts: 2, model: "claude-opus-5-5" });
    expect(runs[0].usage).toMatchObject({ inputTokens: 11_000, outputTokens: 1_000 });
    expect(runs[0].costUsd).toBeGreaterThan(0);
    expect(t).toMatchObject({ inputTokens: 11_000, outputTokens: 1_000 });
    expect((await wf.strategyCost(brandId, row.id)).inputTokens).toBe(11_000);
  });

  it("does not double count when a recovered task reuses finished work", async () => {
    respond = (b) => (isStructured(b) ? (schemaKeys(b).includes("findings") ? structuredResearch() : json(AUD)) : researchResponse());
    const { t, runs } = await run(["research", "audience"]);
    expect(t.status).toBe("succeeded");
    const before = { in: t.inputTokens, cost: t.costUsd, runs: runs.length };
    // Simulate a crash right after the last section was written: task looks abandoned mid-run.
    const db = await getDb();
    await db.update(schema.aiTasks).set({ status: "running", heartbeatAt: new Date(Date.now() - 5 * 60_000), steps: t.steps.map((s) => (s.id === "audience" ? { ...s, status: "running" as const } : s)) }).where(eq(schema.aiTasks.id, t.id));
    captured.length = 0;
    await wf.recoverDueTasks({ wait: true });
    const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(after.status).toBe("succeeded");
    expect(after.attempts).toBe(2);
    expect(captured).toHaveLength(0); // audience was already saved by this task: no new AI call
    expect((await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, t.id))).length).toBe(before.runs);
    expect(after.inputTokens).toBe(before.in);
    expect(after.costUsd).toBeCloseTo(before.cost, 6);
  });
});

// ---------------------------------------------------------------------------
// All seven agents + the advisor, end to end, on the real provider path.
// Each structured request is answered with a schema-valid fixture chosen by the
// request's own JSON schema, so this also proves every agent sends the schema
// it expects to receive.
// ---------------------------------------------------------------------------

const PILLARS = ["Studio Craft", "Care & Use", "Hosting Rituals", "Community Table", "New Glazes"];
const fixtures: Record<string, (b: Record<string, unknown>) => unknown> = {
  personas: () => ({
    overview: "Hosts who buy fewer, better things.",
    segments: [{ name: "Considered hosts", description: "Entertain at home", priority: "primary" }],
    personas: [
      { name: "The Weekend Host", summary: "Hosts friends most weekends.", demographics: "Not established", demographicsBasis: "assumption", interests: ["Cooking"], needs: ["Durable serveware"], painPoints: ["Chipped plates"], motivations: ["Pride in the table"], objections: ["Price"], contentPreferences: ["Table styling reels"], platforms: ["instagram"], engagementOpportunities: ["Ask for table photos"] },
      { name: "The Gifter", summary: "Buys meaningful gifts.", demographics: "Not established", demographicsBasis: "assumption", interests: ["Gifting"], needs: ["Gift-ready packaging"], painPoints: ["Generic gifts"], motivations: ["Being remembered"], objections: ["Delivery time"], contentPreferences: ["Gift guides"], platforms: ["instagram"], engagementOpportunities: ["Save-able gift lists"] },
    ],
    insights: ["Saves signal purchase intent."],
  }),
  marketingObjectives: () => ({
    businessObjectives: [{ objective: "Grow sales", measure: "Monthly online revenue" }],
    marketingObjectives: [{ objective: "Drive site visits", category: "sales", supports: "Grow sales", metric: "Link clicks", target: "Baseline first", targetBasis: "suggested", timeframe: "30 days" }],
  }),
  executiveSummary: () => ({
    executiveSummary: "Lead with craft, convert with care content.",
    positioning: { statement: "The modern heirloom", pointsOfDifference: ["Small batches"], proofPoints: ["Made in Porto"] },
    differentiation: [{ point: "Process transparency", versus: "ClayCo", howToShow: "Studio reels" }],
    channels: [
      { platform: "instagram", role: "Discovery", audience: "Hosts", formats: ["reel"], postsPerWeek: 4, bestTimes: ["Tue 19:00"], approach: "Calm, visual" },
      { platform: "tiktok", role: "Should be filtered out", audience: "-", formats: [], postsPerWeek: 1, bestTimes: [], approach: "-" },
    ],
    contentStrategy: { approach: "Teach and show", toneGuidance: "Warm", mix: [{ type: "Education", sharePercent: 60 }, { type: "Product", sharePercent: 40 }], avoid: ["Discount spam"] },
    campaignStrategy: { approach: "One hero campaign a month", rhythm: "Tease, launch, sustain" },
    engagementStrategy: { approach: "Reply fast", tactics: ["Question stickers"], communityGuidelines: ["Thank customers"] },
    leadGeneration: { approach: "Newsletter", tactics: ["Care guide download"], offers: ["Care guide"], notApplicableReason: "" },
    kpis: [{ name: "Saves", metric: "Saves per post", target: "Baseline first", targetBasis: "suggested", frequency: "Weekly", objective: "Drive site visits" }],
    roadmap: [{ phase: "Foundation", timing: "Week 1", focus: "Baseline", milestones: ["Baseline recorded"] }],
    accountTypeNotes: "Business account.",
    assumptions: [],
    risks: [],
  }),
  pillars: () => ({ pillars: PILLARS.map((name, i) => ({ name, description: `${name} content`, purpose: "Trust", audience: "The Weekend Host", formats: ["reel"], topics: [`${name} topic`], frequency: "1 / week", sharePercent: 25, objective: (["awareness", "education", "community", "engagement", "sales"] as const)[i] })), rationale: "Five distinct pillars." }),
  campaigns: () => ({ campaigns: [{ name: "Made to Last", kind: "awareness", objective: "awareness", audience: "Hosts", concept: "Longevity stories", keyMessage: "Things worth keeping", creativeDirection: "Hands at work", formats: ["reel"], platforms: ["instagram", "tiktok"], startDate: "2027-01-06", durationDays: 10, cta: "Shop the edit", metrics: ["Reach"] }] }),
  entries: (b) => {
    const m = promptOf(b).match(/Plan entries from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/)!;
    const from = Date.parse(`${m[1]}T00:00:00Z`);
    const day = (n: number) => new Date(from + n * 864e5).toISOString().slice(0, 10);
    return {
      entries: Array.from({ length: 8 }, (_, i) => ({ date: day(i), time: "19:00", platform: "instagram", pillar: PILLARS[i % 5], objective: "engagement", format: "instagram_post", creativeConcept: `Concept ${m[1]}-${i}`, hook: `Hook ${m[1]}-${i}`, captionDirection: "Short", cta: "Save it", hashtags: ["#slowmade"], campaign: i === 2 ? "made to last" : "" })),
      notes: "Balanced.",
    };
  },
  creativeConcept: () => ({ date: "2027-01-05", time: "08:30", platform: "instagram", pillar: "Studio Craft", objective: "engagement", format: "instagram_post", creativeConcept: "Brand new angle", hook: "A completely new hook", captionDirection: "Short", cta: "Save", hashtags: ["glaze"], campaign: "" }),
  referencedSections: () => ({ answer: "Lead with Studio Craft this week.", basis: "draft_strategy", referencedSections: ["pillars"], usesUnverifiedResearch: false, suggestedActions: [], followUps: [] }),
};
const route = (b: Record<string, unknown>) => {
  if (!isStructured(b)) return researchResponse();
  const keys = schemaKeys(b);
  if (keys.includes("findings")) return structuredResearch();
  for (const k of Object.keys(fixtures)) if (keys.includes(k)) return json(fixtures[k](b));
  return apiError(400, "invalid_request_error");
};

describe("all seven agents and the advisor on the real provider path", () => {
  it("runs the full workflow with the approved profile, tracks cost, regenerates an entry and answers as the advisor", async () => {
    const db = await getDb();
    // A newer, unapproved draft must never reach the agents.
    await db.insert(schema.brandProfiles).values({ brandId, version: 2, status: "draft", schemaVersion: 2, data: { ...PROFILE, summary: "DRAFT-ONLY SUMMARY that must not be used." } });
    respond = (b) => route(b);
    const row = await store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], { id: "approved", version: 1 });
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "s@example.com", name: "S" } }, brandId, "editor");
    const taskId = await wf.startTask(access, row.id, { sections: ["research", "audience", "objectives", "strategy", "pillars", "campaigns", "calendar"], inline: true });
    const t = await wf.taskStatus(brandId, taskId);
    expect(t.status).toBe("succeeded");

    // 1 web research call + 1 structuring call + 5 agents + 2 calendar halves = 9 requests.
    expect(captured).toHaveLength(9);
    const schemas = captured.filter((c) => isStructured(c.body)).map((c) => schemaKeys(c.body));
    for (const k of ["findings", "personas", "marketingObjectives", "executiveSummary", "pillars", "campaigns", "entries"]) expect(schemas.some((s) => s.includes(k)), k).toBe(true);
    for (const c of captured) {
      expect(c.body.model).toBe("claude-opus-5-5");
      const p = promptOf(c.body);
      expect(p).toContain("Kora makes small-batch stoneware"); // approved profile, every agent
      expect(p).not.toContain("DRAFT-ONLY SUMMARY");
    }
    // Later agents build on earlier sections.
    const pillarReq = captured.find((c) => isStructured(c.body) && schemaKeys(c.body).includes("pillars") && schemaKeys(c.body).includes("rationale"))!;
    expect(promptOf(pillarReq.body)).toContain("The Weekend Host");
    const calReqs = captured.filter((c) => isStructured(c.body) && schemaKeys(c.body).includes("entries"));
    expect(promptOf(calReqs[0].body)).toContain("Plan entries from 2027-01-04 to 2027-01-18");
    expect(promptOf(calReqs[1].body)).toContain("Plan entries from 2027-01-19 to 2027-02-02");
    expect(promptOf(calReqs[1].body)).toContain("Hook 2027-01-04-0"); // second half sees the first

    const doc = store.docOf((await store.getStrategy(brandId, row.id))!);
    expect(doc.sections.research!.data.mode).toBe("web_search");
    expect(doc.sections.audience!.data.personas.map((p) => p.name)).toEqual(["The Weekend Host", "The Gifter"]);
    expect(doc.sections.strategy!.data.channels.map((c) => c.platform)).toEqual(["instagram"]); // tiktok not selected
    expect(doc.sections.pillars!.data.pillars.reduce((s, p) => s + p.sharePercent, 0)).toBe(100);
    expect(doc.sections.campaigns!.data.campaigns[0].platforms).toEqual(["instagram"]);
    const cal = doc.sections.calendar!.data;
    expect(cal.entries).toHaveLength(16);
    expect(cal.entries.find((e) => e.hook === "Hook 2027-01-04-2")!.campaign).toBe("Made to Last"); // normalised to the real campaign name
    expect(cal.entries.every((e) => !e.hashtags.some((h) => h.startsWith("#")))).toBe(true);

    // Token and cost tracking: task totals equal the sum of its agent runs.
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, brandId));
    const mine = runs.filter((r) => (r.input as { strategyId?: string } | null)?.strategyId === row.id);
    expect(mine).toHaveLength(9);
    expect(t.inputTokens).toBe(90_000);
    expect(t.outputTokens).toBe(18_000);
    expect(t.webSearches).toBe(2);
    expect(t.costUsd).toBeCloseTo(mine.reduce((s, r) => s + (r.costUsd ?? 0), 0), 5);
    // 90k in × $4 + 18k out × $20 per MTok + 2 searches × $10/1k
    expect(t.costUsd).toBeCloseTo(0.36 + 0.36 + 0.02, 5);
    expect(await wf.strategyCost(brandId, row.id)).toMatchObject({ inputTokens: 90_000, outputTokens: 18_000, webSearches: 2 });

    // Regenerate one calendar entry (real path), then the advisor.
    captured.length = 0;
    const target = cal.entries[1];
    const after = await wf.regenerateCalendarEntry((await db.select().from(schema.brands).where(eq(schema.brands.id, brandId)))[0], userId, row.id, target.id, "make it warmer", (await store.getStrategy(brandId, row.id))!.rev);
    const regenerated = store.docOf(after).sections.calendar!.data.entries.find((e) => e.id === target.id)!;
    expect(regenerated.hook).toBe("A completely new hook");
    expect(promptOf(captured[0].body)).toContain("make it warmer");

    const { askAdvisor } = await import("./strategist/advisor");
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const a = await askAdvisor({ brandId, userId }, brand, "What should we post first?");
    expect(a.answer).toBe("Lead with Studio Craft this week.");
    expect(a.meta).toMatchObject({ basis: "draft_strategy", strategyId: row.id });
    const advReq = captured.at(-1)!.body;
    expect(schemaKeys(advReq)).toContain("referencedSections");
    expect(promptOf(advReq)).toContain("Studio Craft");
    expect(promptOf(advReq)).not.toContain("DRAFT-ONLY SUMMARY");
  }, 30_000);
});

describe("requests whose response never reaches the app", () => {
  const AUD = { overview: "o", segments: [], personas: [{ name: "Host", summary: "s", demographics: "Not established", demographicsBasis: "assumption", interests: [], needs: [], painPoints: [], motivations: [], objections: [], contentPreferences: [], platforms: ["instagram"], engagementOpportunities: [] }], insights: [] };
  const newStrategy = async () => store.createStrategy(brandId, userId, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow sales"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 4 }), [], null);

  it("server crash after the provider processed the request: run marked 'usage unknown', step re-run once on recovery, estimate excludes the lost call", async () => {
    const db = await getDb();
    const row = await newStrategy();
    const [t] = await db.insert(schema.aiTasks).values({ brandId, workspaceId: (await db.select().from(schema.brands).where(eq(schema.brands.id, brandId)))[0].workspaceId, userId, kind: "strategy_workflow", strategyId: row.id, steps: [{ id: "audience", label: "a", status: "pending" }], runAfter: new Date(0) }).returning();
    let audienceRequests = 0;
    let sawFirst: () => void = () => {};
    const firstSeen = new Promise<void>((r) => (sawFirst = r));
    respond = ((b: Record<string, unknown>) => {
      if (!isStructured(b) || !schemaKeys(b).includes("personas")) return apiError(400, "invalid_request_error");
      audienceRequests++;
      if (audienceRequests === 1) {
        // The provider received (and would bill) this request, then our process "dies":
        // the response never arrives.
        sawFirst();
        return new Promise<Response>(() => {});
      }
      return json(AUD);
    }) as typeof respond;
    void wf.runTask(t.id); // worker 1: never finishes
    await firstSeen;
    // Worker 1 is now dead from the database's point of view: no heartbeat for over 2 minutes.
    await db.update(schema.aiTasks).set({ heartbeatAt: new Date(Date.now() - 3 * 60_000) }).where(eq(schema.aiTasks.id, t.id));
    await wf.recoverDueTasks({ wait: true }); // worker 2 after the "restart"

    const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(after).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(audienceRequests).toBe(2); // the lost request + one re-run: the provider may bill both
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, t.id));
    const lost = runs.find((r) => r.status === "failed")!;
    const good = runs.find((r) => r.status === "succeeded")!;
    expect(runs).toHaveLength(2);
    expect(lost.usage).toEqual({ unknownUsageAttempts: 1 });
    expect(lost.costUsd).toBeNull(); // not priced: we never saw its usage
    expect(lost.error).toMatch(/may have processed and billed it; its usage is unknown/);
    expect(good.usage).toMatchObject({ inputTokens: 10_000, outputTokens: 2_000 });
    // The estimate covers what the app saw; the unknown request is reported separately, never guessed.
    expect(after.costUsd).toBeCloseTo(good.costUsd!, 6);
    const cost = await wf.strategyCost(brandId, row.id);
    expect(cost.unknownUsageCalls).toBe(1);
    expect(cost.costUsd).toBeCloseTo(good.costUsd!, 6);
    // The section was written once, by worker 2; worker 1 can never write it (it lost its claim).
    const revs = await store.revisions(brandId, row.id);
    expect(revs.filter((r) => r.action === "Generated audience & personas")).toHaveLength(1);
  });

  it("connection lost mid-request: the attempt is recorded as usage-unknown and the retry is billed normally", async () => {
    let calls = 0;
    respond = ((b: Record<string, unknown>) => {
      if (!isStructured(b) || !schemaKeys(b).includes("personas")) return apiError(400, "invalid_request_error");
      calls++;
      if (calls <= 3) throw new TypeError("socket hang up"); // first app-level attempt incl. the SDK's own 2 retries
      return json(AUD);
    }) as typeof respond;
    const row = await newStrategy();
    const access = await requireBrandForUser({ sessionId: "s", activeBrandId: null, user: { id: userId, email: "s@example.com", name: "S" } }, brandId, "editor");
    const taskId = await wf.startTask(access, row.id, { sections: ["audience"], inline: true });
    const db = await getDb();
    const [t] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
    expect(t.status).toBe("succeeded");
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));
    expect(run).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(run.usage).toMatchObject({ inputTokens: 10_000, outputTokens: 2_000, unknownUsageAttempts: 1 });
    expect(run.costUsd).toBeCloseTo(estimateCost({ inputTokens: 10_000, outputTokens: 2_000, model: "claude-opus-5-5" }), 6);
    expect((await wf.strategyCost(brandId, row.id)).unknownUsageCalls).toBe(1);
  }, 30_000);
});
