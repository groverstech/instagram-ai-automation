import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { fetchPublicText } from "../web";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, renderContext } from "./context";
import { CompetitorAnalysis } from "./schemas";
import type { Brand } from "../db/schema";
import { remember } from "../memory";

/**
 * Two-step research: (1) Claude with the web search tool gathers public information,
 * (2) a structured pass turns the notes into an analysis. Only public pages are used;
 * nothing is scraped behind logins, and platform ToS-restricted data isn't collected.
 */
export async function analyzeCompetitor(scope: RunScope, brand: Brand, competitorId: string) {
  const db = await getDb();
  const [comp] = await db
    .select()
    .from(schema.competitors)
    .where(and(eq(schema.competitors.id, competitorId), eq(schema.competitors.brandId, brand.id)));
  if (!comp) throw new Error("Competitor not found");

  const site = comp.url ? await fetchPublicText(comp.url, 6000) : null;
  const ctx = await buildContext(brand, `competitor ${comp.name} differentiation`);

  const research = await runAgent(scope, "competitor_research", `Research ${comp.name}`, { competitorId }, () =>
    llm().research({ route: "competitor.research",
      system: AGENTS.competitor_research.system,
      prompt: `Research the brand "${comp.name}"${comp.url ? ` (${comp.url})` : ""}${comp.handles.length ? `, social handles: ${comp.handles.join(", ")}` : ""}, a competitor of ${brand.name} in ${brand.industry ?? "its industry"} (${brand.geography ?? "global"}).
Find publicly available information about: positioning and messaging, product focus, content themes and formats on social media, creative style, posting frequency, notable campaigns, and audience reception. Write concise research notes with what you found and where.`,
      maxSearches: 6,
      mock: () => `${comp.name}: promotion-led messaging, frequent discount posts, bright product-on-white imagery.`,
    }).then((r) => ({ data: r, usage: r.usage, provider: r.provider })),
  );

  const prompt = `${renderContext(ctx)}

<competitor name="${comp.name}" url="${comp.url ?? ""}">
${site ? `<website_excerpt>\n${site}\n</website_excerpt>` : ""}
<research_notes>
${research.data.text}
</research_notes>
<sources>${research.data.sources.join("\n")}</sources>
</competitor>

Produce the competitor analysis and 4-6 differentiation moves for ${brand.name}. In confidenceNote, say which parts are observed vs inferred and note any data you couldn't access (e.g. exact engagement figures).`;

  const { data } = await runAgent(scope, "competitor_research", `Analyse ${comp.name}`, { competitorId }, () =>
    llm().structured({ route: "competitor.analysis",
      system: AGENTS.competitor_research.system,
      prompt,
      schema: CompetitorAnalysis,
      effort: AGENTS.competitor_research.effort,
      mock: () => ({
        summary: `${comp.name} competes on price and promotions.`,
        positioning: "Accessible, deal-driven",
        contentThemes: ["Discounts", "New arrivals"],
        creativeStyles: ["Bright product-on-white"],
        postingPatterns: "Daily",
        engagementPatterns: "Not available from public data",
        campaignApproaches: ["Seasonal sales"],
        strengths: ["Frequency"],
        weaknesses: ["Little storytelling"],
        contentGaps: ["Craft and process content"],
        differentiation: [{ move: "Own the making story", why: "Gap in their content" }],
        confidenceNote: "Mock provider.",
      }),
    }),
  );

  await db
    .update(schema.competitors)
    .set({ analysis: { ...data, sources: research.data.sources }, analyzedAt: new Date() })
    .where(eq(schema.competitors.id, comp.id));
  await remember(brand.id, [
    { kind: "competitor", content: `${comp.name}: ${data.positioning}. Gaps we can own: ${data.contentGaps.join("; ")}`, source: "competitor", weight: 1.1 },
  ]);
  return data;
}
