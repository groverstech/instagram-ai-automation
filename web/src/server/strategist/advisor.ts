import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { runAgent, type RunScope } from "../agents/orchestrator";
import { buildContext, renderContext } from "../agents/context";
import { EVIDENCE_RULES } from "../agents/registry";
import type { Brand } from "../db/schema";
import { SECTION_KEYS, SECTION_META, type StrategyDoc } from "@/lib/strategy";
import { currentStrategy, docOf } from "./store";

export const AdvisorAnswer = z.object({
  answer: z.string().describe("Plain text; short paragraphs or '- ' bullets"),
  basis: z.enum(["approved_strategy", "draft_strategy", "brand_profile", "general_guidance"]),
  referencedSections: z.array(z.enum(SECTION_KEYS)),
  usesUnverifiedResearch: z.boolean(),
  suggestedActions: z.array(z.object({ label: z.string(), section: z.enum(SECTION_KEYS) })).describe("Optional next steps in the strategist, e.g. regenerate the calendar"),
  followUps: z.array(z.string()),
});
export type AdvisorAnswer = z.infer<typeof AdvisorAnswer>;

const SYSTEM = `You are the Marketing Advisor for one specific brand: a senior strategist the team can talk to. You answer using the brand's intelligence profile, instructions, memory and its marketing strategy.

Rules:
- Prefer the APPROVED strategy. If only a draft exists, say your advice is based on a draft that hasn't been approved.
- Ground answers in the brand and strategy; name the section you're drawing on. If the strategy doesn't cover the question, say so, then give clearly labelled general guidance.
- Research findings marked verified=false are hypotheses; say so when you rely on them and set usesUnverifiedResearch=true.
- You give advice; you don't change the strategy. If a change would help, suggest it as an action (e.g. regenerate the calendar with a new focus) for the user to run.
- Be concise and concrete. No headings.
${EVIDENCE_RULES}`;

export async function advisorHistory(brandId: string, limit = 40) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.assistantMessages)
    .where(and(eq(schema.assistantMessages.brandId, brandId), eq(schema.assistantMessages.channel, "strategy")))
    .orderBy(desc(schema.assistantMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

function renderStrategy(doc: StrategyDoc) {
  return SECTION_KEYS.filter((k) => doc.sections[k])
    .map((k) => {
      const data = k === "calendar" ? { ...doc.sections.calendar!.data, entries: doc.sections.calendar!.data.entries.slice(0, 60).map((e) => `${e.date} ${e.platform} [${e.pillar}] ${e.hook}${e.campaign ? ` (${e.campaign})` : ""}`) } : doc.sections[k]!.data;
      return `<${k} label="${SECTION_META[k].label}">${JSON.stringify(data, (kk, v) => (kk === "id" || kk === "unmatchedUrls" ? undefined : v))}</${k}>`;
    })
    .join("\n");
}

export async function askAdvisor(scope: RunScope, brand: Brand, question: string) {
  const db = await getDb();
  const history = await db
    .select({ role: schema.assistantMessages.role, content: schema.assistantMessages.content })
    .from(schema.assistantMessages)
    .where(and(eq(schema.assistantMessages.brandId, brand.id), eq(schema.assistantMessages.channel, "strategy")))
    .orderBy(asc(schema.assistantMessages.createdAt));
  const ctx = await buildContext(brand, question);
  const row = await currentStrategy(brand.id);
  const doc = row && row.schemaVersion === 2 ? docOf(row) : null;
  const strategyBlock = doc
    ? `<marketing_strategy version="${row!.version}" status="${row!.status}">\n${renderStrategy(doc)}\n</marketing_strategy>`
    : "(No marketing strategy has been created yet. Say so and suggest creating one in the Strategist.)";

  const [asked] = await db.insert(schema.assistantMessages).values({ brandId: brand.id, userId: scope.userId, role: "user", channel: "strategy", content: question, meta: { strategyId: row?.id ?? null } }).returning({ id: schema.assistantMessages.id });
  const prompt = `<brand_knowledge>\n${renderContext(ctx)}\n</brand_knowledge>\n${strategyBlock}\n${
    history.length ? `<conversation_so_far>\n${history.slice(-8).map((m) => `${m.role === "user" ? "User" : "Advisor"}: ${m.content}`).join("\n")}\n</conversation_so_far>\n` : ""
  }Question: ${question}`;

  let result: { runId: string; data: AdvisorAnswer };
  try {
    result = await runAgent(scope, "marketing_advisor", `Advisor: ${question.slice(0, 60)}`, { question }, () =>
      llm().structured({
        system: SYSTEM,
        prompt,
        schema: AdvisorAnswer,
        effort: "medium",
        mock: () => ({
          answer: doc ? `[Demo] Based on strategy v${row!.version} (${row!.status}): focus on your pillars ${doc.sections.pillars?.data.pillars.map((p) => p.name).join(", ") ?? ""}.` : "[Demo] There's no strategy yet. Create one in the Strategist first.",
          basis: doc ? (row!.status === "approved" ? "approved_strategy" : "draft_strategy") : "brand_profile",
          referencedSections: doc?.sections.pillars ? ["pillars"] : [],
          usesUnverifiedResearch: false,
          suggestedActions: [],
          followUps: ["Which pillar should we post more of?"],
        }),
      }),
    );
  } catch (e) {
    await db.delete(schema.assistantMessages).where(eq(schema.assistantMessages.id, asked.id));
    throw e;
  }
  const meta = { ...result.data, answer: undefined, strategyId: row?.id ?? null, strategyVersion: row?.version ?? null, strategyStatus: row?.status ?? null, runId: result.runId };
  const [saved] = await db.insert(schema.assistantMessages).values({ brandId: brand.id, userId: scope.userId, role: "assistant", channel: "strategy", content: result.data.answer, meta }).returning({ id: schema.assistantMessages.id });
  return { id: saved.id, answer: result.data.answer, meta };
}

export async function clearAdvisor(brandId: string) {
  const db = await getDb();
  await db.delete(schema.assistantMessages).where(and(eq(schema.assistantMessages.brandId, brandId), eq(schema.assistantMessages.channel, "strategy")));
}
