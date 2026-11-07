import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import { addDays, format as fmt, parseISO, startOfDay } from "date-fns";
import { z } from "zod";
import { getDb, schema } from "../db/client";
import { anthropicClient, MODEL } from "../ai/llm";
import { buildContext, renderContext } from "./context";
import { createCampaign } from "./campaign";
import { generateCreatives } from "./creative";
import { analyzePerformance } from "./analytics";
import { generateStrategy, planCalendar, suggestIdeas, writeCopy } from "./strategy";
import { analyzeCompetitor } from "./competitor";
import { runAgent, type RunScope } from "./orchestrator";
import type { Brand } from "../db/schema";
import { CAMPAIGN_TYPES, FORMAT_IDS, OBJECTIVES, PLATFORM_IDS, STYLE_IDS } from "@/lib/domain";

type Action = { label: string; href: string };
type ToolOutcome = { summary: unknown; actions: Action[] };

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "create_campaign",
    description: "Plan a full campaign (concept, phases, dated draft posts) and produce creatives + captions for the first posts. Use for campaign requests.",
    input_schema: {
      type: "object",
      properties: {
        brief: str,
        type: { type: "string", enum: [...CAMPAIGN_TYPES] },
        objective: { type: "string", enum: [...OBJECTIVES] },
        start_date: { type: "string", description: "YYYY-MM-DD; default tomorrow" },
        days: int,
        platforms: { type: "array", items: { type: "string", enum: [...PLATFORM_IDS] } },
      },
      required: ["brief", "type", "objective", "start_date", "days", "platforms"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "generate_creatives",
    description: "Generate on-brand creative concepts and images in the Creative Studio.",
    input_schema: {
      type: "object",
      properties: {
        brief: str,
        format: { type: "string", enum: [...FORMAT_IDS] },
        style: { type: "string", enum: [...STYLE_IDS] },
        count: int,
      },
      required: ["brief", "format", "style", "count"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "plan_calendar",
    description: "Populate the content calendar with draft posts based on the brand strategy.",
    input_schema: {
      type: "object",
      properties: {
        start_date: str,
        days: int,
        platforms: { type: "array", items: { type: "string", enum: [...PLATFORM_IDS] } },
        posts_per_week: int,
        note: str,
      },
      required: ["start_date", "days", "platforms", "posts_per_week", "note"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "analyze_performance",
    description: "Analyse real metrics from connected accounts for the last N days and produce insights.",
    input_schema: { type: "object", properties: { days: int }, required: ["days"], additionalProperties: false },
    strict: true,
  },
  {
    name: "suggest_content_ideas",
    description: "Suggest specific content ideas for a goal.",
    input_schema: { type: "object", properties: { goal: str }, required: ["goal"], additionalProperties: false },
    strict: true,
  },
  {
    name: "generate_strategy",
    description: "Generate a monthly social media strategy.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" }, focus: str }, required: ["month", "focus"], additionalProperties: false },
    strict: true,
  },
  {
    name: "write_caption",
    description: "Write a caption pack (captions, hooks, CTA, hashtags) for a post idea.",
    input_schema: {
      type: "object",
      properties: { brief: str, platform: { type: "string", enum: [...PLATFORM_IDS] }, objective: { type: "string", enum: [...OBJECTIVES] } },
      required: ["brief", "platform", "objective"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "research_competitor",
    description: "Research a competitor from public information and save the analysis.",
    input_schema: { type: "object", properties: { name: str, url: str }, required: ["name", "url"], additionalProperties: false },
    strict: true,
  },
];

const Inputs = {
  create_campaign: z.object({ brief: z.string(), type: z.string(), objective: z.string(), start_date: z.string(), days: z.number(), platforms: z.array(z.string()) }),
  generate_creatives: z.object({ brief: z.string(), format: z.string(), style: z.string(), count: z.number() }),
  plan_calendar: z.object({ start_date: z.string(), days: z.number(), platforms: z.array(z.string()), posts_per_week: z.number(), note: z.string() }),
  analyze_performance: z.object({ days: z.number() }),
  suggest_content_ideas: z.object({ goal: z.string() }),
  generate_strategy: z.object({ month: z.string(), focus: z.string() }),
  write_caption: z.object({ brief: z.string(), platform: z.string(), objective: z.string() }),
  research_competitor: z.object({ name: z.string(), url: z.string() }),
};
type ToolName = keyof typeof Inputs;

function dateOr(s: string, fallback: Date) {
  const d = parseISO(s);
  return Number.isNaN(d.getTime()) ? fallback : startOfDay(d);
}

async function runTool(scope: RunScope, brand: Brand, name: ToolName, raw: unknown): Promise<ToolOutcome> {
  const tomorrow = startOfDay(addDays(new Date(), 1));
  switch (name) {
    case "create_campaign": {
      const i = Inputs.create_campaign.parse(raw);
      const r = await createCampaign(scope, brand, { brief: i.brief, type: i.type, objective: i.objective, start: dateOr(i.start_date, tomorrow), days: i.days, platforms: i.platforms });
      return { summary: { campaignId: r.campaignId, draftPosts: r.postIds.length }, actions: [{ label: "Open campaign", href: `/campaigns/${r.campaignId}` }, { label: "View calendar", href: "/calendar" }] };
    }
    case "generate_creatives": {
      const i = Inputs.generate_creatives.parse(raw);
      const ids = await generateCreatives(scope, brand, { ...i, count: Math.min(Math.max(i.count, 1), 6) });
      return { summary: { creatives: ids.length }, actions: [{ label: `Review ${ids.length} creatives`, href: "/creative-studio" }] };
    }
    case "plan_calendar": {
      const i = Inputs.plan_calendar.parse(raw);
      const r = await planCalendar(scope, brand, { start: dateOr(i.start_date, tomorrow), days: Math.min(Math.max(i.days, 1), 60), platforms: i.platforms, postsPerWeek: i.posts_per_week || undefined, note: i.note });
      return { summary: { draftPosts: r.postIds.length, rationale: r.rationale }, actions: [{ label: "Open calendar", href: "/calendar" }] };
    }
    case "analyze_performance": {
      const i = Inputs.analyze_performance.parse(raw);
      const r = await analyzePerformance(scope, brand, Math.min(Math.max(i.days, 7), 180));
      return { summary: { postsWithRealMetrics: r.posts, insights: r.data }, actions: [{ label: "Open analytics", href: "/analytics" }] };
    }
    case "suggest_content_ideas": {
      const i = Inputs.suggest_content_ideas.parse(raw);
      const r = await suggestIdeas(scope, brand, i.goal);
      return { summary: r.data, actions: [{ label: "Open Content Studio", href: "/content-studio" }] };
    }
    case "generate_strategy": {
      const i = Inputs.generate_strategy.parse(raw);
      const s = await generateStrategy(scope, brand, /^\d{4}-\d{2}$/.test(i.month) ? i.month : fmt(new Date(), "yyyy-MM"), i.focus);
      return { summary: { strategyId: s.id, month: s.month }, actions: [{ label: "Review strategy", href: "/strategist" }] };
    }
    case "write_caption": {
      const i = Inputs.write_caption.parse(raw);
      const r = await writeCopy(scope, brand, i);
      return { summary: r.data, actions: [{ label: "Open Content Studio", href: "/content-studio" }] };
    }
    case "research_competitor": {
      const i = Inputs.research_competitor.parse(raw);
      const db = await getDb();
      const [c] = await db.insert(schema.competitors).values({ brandId: brand.id, name: i.name, url: i.url || null }).returning();
      const a = await analyzeCompetitor(scope, brand, c.id);
      return { summary: { summary: a.summary, gaps: a.contentGaps }, actions: [{ label: "Open competitor intelligence", href: "/competitors" }] };
    }
  }
}

export async function assistantHistory(brandId: string, limit = 30) {
  const db = await getDb();
  const rows = await db.select().from(schema.assistantMessages).where(and(eq(schema.assistantMessages.brandId, brandId), eq(schema.assistantMessages.channel, "workflow"))).orderBy(desc(schema.assistantMessages.createdAt)).limit(limit);
  return rows.reverse();
}

export async function chat(scope: RunScope, brand: Brand, message: string): Promise<{ text: string; actions: Action[] }> {
  const db = await getDb();
  const history = await db
    .select()
    .from(schema.assistantMessages)
    .where(and(eq(schema.assistantMessages.brandId, brand.id), eq(schema.assistantMessages.channel, "workflow")))
    .orderBy(asc(schema.assistantMessages.createdAt));
  await db.insert(schema.assistantMessages).values({ brandId: brand.id, userId: scope.userId, role: "user", content: message });

  const { data } = await runAgent(scope, "assistant", message.slice(0, 80), { message }, async (runId) => {
    const sub = { ...scope, parentId: runId };
    const out = process.env.AI_PROVIDER === "mock" ? await mockChat(sub, brand, message) : await claudeChat(sub, brand, history.slice(-12), message);
    return { data: out, provider: process.env.AI_PROVIDER === "mock" ? "mock" : `anthropic:${MODEL}` };
  });
  await db.insert(schema.assistantMessages).values({ brandId: brand.id, userId: scope.userId, role: "assistant", content: data.text, actions: data.actions });
  return data;
}

async function claudeChat(scope: RunScope, brand: Brand, history: (typeof schema.assistantMessages.$inferSelect)[], message: string) {
  const ctx = await buildContext(brand, message);
  const system = `You are BrandPilot, the AI marketing manager for ${brand.name}. You lead a team of specialist agents (strategist, content strategist, creative director, designer, copywriter, campaign manager, analyst, competitor researcher) and you act through tools.

When the user asks for work that a tool can do, call the tool rather than describing what you would do. Fill tool inputs with sensible defaults instead of asking clarifying questions, unless something essential is truly ambiguous. Today is ${fmt(new Date(), "yyyy-MM-dd")}.

Everything you create is a draft. You cannot publish, schedule, spend money or contact anyone; tell the user what to review and approve. Never state performance numbers that did not come from a tool result. After tools finish, reply in 2-5 short sentences: what was created, the key idea, and what to review next. No markdown headings.

${renderContext(ctx)}`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.Beta.BetaMessageParam),
    { role: "user", content: message },
  ];
  // Keep alternation valid if history ends on a user turn (e.g., an earlier failed request).
  const merged: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === "string" && typeof m.content === "string") prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }

  const actions: Action[] = [];
  for (let step = 0; step < 6; step++) {
    const res = await anthropicClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system,
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages: merged,
    });
    if (res.stop_reason === "refusal") return { text: "I can't help with that request. Try rephrasing what you need.", actions };
    merged.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) {
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "Done.", actions: dedupe(actions) };
    }
    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        if (!(u.name in Inputs)) return { type: "tool_result", tool_use_id: u.id, content: `Unknown tool ${u.name}`, is_error: true };
        try {
          const out = await runTool(scope, brand, u.name as ToolName, u.input);
          actions.push(...out.actions);
          return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out.summary).slice(0, 20000) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
        }
      }),
    );
    merged.push({ role: "user", content: results });
  }
  return { text: "I ran several steps; review the results using the links below.", actions: dedupe(actions) };
}

/** Deterministic router for AI_PROVIDER=mock (tests and offline UI work). */
async function mockChat(scope: RunScope, brand: Brand, message: string) {
  const m = message.toLowerCase();
  const days = Number(m.match(/(\d+)[- ]day/)?.[1] ?? 7);
  const tomorrow = fmt(addDays(new Date(), 1), "yyyy-MM-dd");
  let tool: ToolName;
  let input: unknown;
  if (m.includes("campaign")) {
    tool = "create_campaign";
    input = { brief: message, type: "launch", objective: "awareness", start_date: tomorrow, days, platforms: brand.platforms };
  } else if (m.includes("creative") || m.includes("design")) {
    tool = "generate_creatives";
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = Number(m.match(/(\d+)/)?.[1] ?? words[m.match(/\b(one|two|three|four|five|six)\b/)?.[1] ?? ""] ?? 3);
    input = { brief: message, format: "instagram_post", style: "premium_editorial", count: n };
  } else if (m.includes("calendar")) {
    tool = "plan_calendar";
    input = { start_date: tomorrow, days, platforms: brand.platforms, posts_per_week: 4, note: message };
  } else if (m.includes("analy") || m.includes("performance")) {
    tool = "analyze_performance";
    input = { days: Number(m.match(/(\d+)/)?.[1] ?? 30) };
  } else {
    tool = "suggest_content_ideas";
    input = { goal: message };
  }
  const out = await runTool(scope, brand, tool, input);
  return { text: `Done — I ran ${tool.replace(/_/g, " ")}. (Mock provider)`, actions: out.actions };
}

function dedupe(a: Action[]) {
  const seen = new Set<string>();
  return a.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
}
