import "server-only";
import { addDays, format as fmt, parseISO } from "date-fns";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, recentPerformanceSummary, renderContext } from "./context";
import { CalendarPlan, ContentIdeas, Copy, type PlannedPost } from "./schemas";
import { currentStrategy } from "../strategist/store";
import { isDocV2 } from "@/lib/strategy";
import type { Brand } from "../db/schema";
import { FORMAT_IDS, PLATFORM_IDS, objectiveLabel, platformLabel } from "@/lib/domain";

function brandPlatforms(brand: Brand) {
  const ps = brand.platforms.filter((p) => (PLATFORM_IDS as readonly string[]).includes(p));
  return ps.length ? ps : ["instagram"];
}

/** The strategy agents build on: approved first, else the latest non-archived version. */
export async function latestStrategy(brandId: string) {
  return currentStrategy(brandId);
}

/** Compact, prompt-ready view of a strategy (v1 or v2) for other agents. */
export function strategyPromptBlock(row: { version: number; status: string; month: string; data: unknown; schemaVersion: number }) {
  if (!isDocV2(row.data, row.schemaVersion)) return `<strategy month="${row.month}" status="${row.status}">\n${JSON.stringify(row.data)}\n</strategy>`;
  const d = row.data;
  const s = d.sections;
  const body = {
    positioning: s.strategy?.data.positioning,
    channels: s.strategy?.data.channels,
    contentStrategy: s.strategy?.data.contentStrategy,
    pillars: s.pillars?.data.pillars.map((p) => ({ name: p.name, sharePercent: p.sharePercent, objective: p.objective, topics: p.topics, formats: p.formats })),
    personas: s.audience?.data.personas.map((p) => ({ name: p.name, summary: p.summary, painPoints: p.painPoints })),
    campaigns: s.campaigns?.data.campaigns.map((c) => ({ name: c.name, kind: c.kind, startDate: c.startDate, durationDays: c.durationDays, keyMessage: c.keyMessage })),
  };
  return `<strategy version="${row.version}" status="${row.status}">\n${JSON.stringify(body)}\n</strategy>`;
}

/** Content Strategist: turn the strategy into dated draft posts on the calendar. */
export async function planCalendar(
  scope: RunScope,
  brand: Brand,
  opts: { start: Date; days: number; platforms?: string[]; postsPerWeek?: number; note?: string },
) {
  const strategy = await latestStrategy(brand.id);
  const ctx = await buildContext(brand, `content calendar ${opts.note ?? ""}`);
  const platforms = opts.platforms?.length ? opts.platforms : brandPlatforms(brand);
  const end = addDays(opts.start, opts.days - 1);
  const prompt = `${renderContext(ctx)}

${strategy ? strategyPromptBlock(strategy) : "(No strategy yet: infer sensible pillars from the brand profile.)"}

Plan the content calendar from ${fmt(opts.start, "yyyy-MM-dd")} to ${fmt(end, "yyyy-MM-dd")} for: ${platforms.join(", ")}.
${opts.postsPerWeek ? `Target about ${opts.postsPerWeek} posts per week in total.` : "Follow the strategy's cadence."}
${opts.note ? `User request: "${opts.note}"` : ""}
Balance pillars and objectives, avoid the same pillar twice in a row on one platform, use platform-appropriate formats (${FORMAT_IDS.join(", ")}), and place relevant moments on their dates.`;

  const { runId, data } = await runAgent(scope, "content_strategist", `Plan calendar ${fmt(opts.start, "MMM d")}–${fmt(end, "MMM d")}`, opts, () =>
    llm().structured({ route: "content.calendar", system: AGENTS.content_strategist.system, prompt, schema: CalendarPlan, effort: AGENTS.content_strategist.effort, mock: () => mockCalendar(opts.start, opts.days, platforms) }),
  );
  const ids = await insertPlannedPosts(brand.id, data.posts, { runId });
  return { runId, postIds: ids, rationale: data.rationale };
}

export async function insertPlannedPosts(
  brandId: string,
  planned: (PlannedPost & { campaignId?: string | null })[],
  meta: { runId: string; campaignId?: string },
) {
  if (!planned.length) return [];
  const db = await getDb();
  const rows = await db
    .insert(schema.posts)
    .values(
      planned.map((p) => ({
        brandId,
        campaignId: meta.campaignId ?? p.campaignId ?? null,
        platform: p.platform,
        format: p.format,
        pillar: p.pillar,
        objective: p.objective,
        title: p.title,
        scheduledAt: toDate(p.date, p.time),
        status: "draft" as const,
        copy: { brief: p.brief, runId: meta.runId },
        rationale: p.rationale,
      })),
    )
    .returning({ id: schema.posts.id });
  return rows.map((r) => r.id);
}

function toDate(date: string, time: string) {
  const t = /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : "10:00";
  const d = parseISO(`${date}T${t}:00`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Copywriter: full copy pack for a brief. */
export async function writeCopy(
  scope: RunScope,
  brand: Brand,
  req: { brief: string; platform: string; objective: string; pillar?: string; creative?: { headline?: string; subline?: string } },
) {
  const ctx = await buildContext(brand, `caption copy ${req.platform} ${req.objective} ${req.brief}`);
  const prompt = `${renderContext(ctx)}

Write the copy pack for one ${platformLabel(req.platform)} post.
Objective: ${objectiveLabel(req.objective)}${req.pillar ? ` · Pillar: ${req.pillar}` : ""}
Brief: ${req.brief}
${req.creative?.headline ? `The creative says: "${req.creative.headline}"${req.creative.subline ? ` / "${req.creative.subline}"` : ""}. The caption should complement it, not repeat it.` : ""}
- primary: the recommended caption, ready to post.
- alternatives: 2 genuinely different angles.
- short: one or two lines. long: a richer storytelling version.
- hooks: 4 opening lines in different styles (question, bold claim, micro-story, specific detail).
- hashtags: tailored to the platform (no # needed; mix of niche and mid-size, none generic like #love).
- platformVariants: adapt the primary for each of: ${brandPlatforms(brand).join(", ")}.`;

  return runAgent(scope, "copywriter", `Copy for ${platformLabel(req.platform)}: ${req.brief.slice(0, 60)}`, req, () =>
    llm().structured({ route: "content.copy", system: AGENTS.copywriter.system, prompt, schema: Copy, effort: AGENTS.copywriter.effort, mock: () => mockCopy(brand, req.brief) }),
  );
}

export async function suggestIdeas(scope: RunScope, brand: Brand, goal: string) {
  const ctx = await buildContext(brand, `content ideas ${goal}`);
  const perf = await recentPerformanceSummary(brand.id);
  const prompt = `${renderContext(ctx)}
${perf.length ? `<recent_platform_metrics>${JSON.stringify(perf.slice(0, 30))}</recent_platform_metrics>` : ""}
Suggest 8 specific content ideas. Goal: ${goal || "improve engagement"}. Platforms: ${brandPlatforms(brand).join(", ")}. Each needs a concrete hook and why it fits this brand.`;
  return runAgent(scope, "content_strategist", `Content ideas: ${goal.slice(0, 60)}`, { goal }, () =>
    llm().structured({ route: "content.ideas", system: AGENTS.content_strategist.system, prompt, schema: ContentIdeas, effort: "medium", mock: () => mockIdeas(brand) }),
  );
}

// ---------- mocks (AI_PROVIDER=mock only) ----------

function mockCalendar(start: Date, days: number, platforms: string[]): CalendarPlan {
  const pillars = ["Craft & Making", "Education", "Product Spotlight", "Community"];
  const posts: PlannedPost[] = [];
  for (let i = 0; i < days; i += 2) {
    const platform = platforms[(i / 2) % platforms.length] as PlannedPost["platform"];
    posts.push({
      date: fmt(addDays(start, i), "yyyy-MM-dd"),
      time: i % 4 === 0 ? "19:00" : "12:30",
      platform,
      format: platform === "linkedin" ? "linkedin_post" : platform === "pinterest" ? "pinterest_pin" : "instagram_post",
      pillar: pillars[(i / 2) % pillars.length],
      objective: (["awareness", "engagement", "education", "sales"] as const)[(i / 2) % 4],
      title: `${pillars[(i / 2) % pillars.length]} — day ${i + 1}`,
      brief: "Show one concrete detail and invite a reply.",
      rationale: "Keeps pillars rotating.",
    });
  }
  return { posts, rationale: "Mock provider: alternating pillars every other day." };
}

function mockCopy(brand: Brand, brief: string): Copy {
  return {
    primary: `${brief}\n\nMade by ${brand.name}, for the everyday moments that matter.`,
    alternatives: ["The small detail you'll notice on day 300.", "Less noise, more of what you'll actually use."],
    short: "Made slowly, so it lasts.",
    long: `Every piece starts with a question: will this still feel right in five years? ${brief}`,
    hooks: ["What makes something last?", "We spent 40 hours on this edge.", "It started with a sketch on a napkin.", "One stitch every 3mm."],
    cta: "Tap to see the full story",
    hashtags: ["slowmade", "consciousliving", "designdetails"],
    keywords: ["handmade", "quality"],
    platformVariants: brandPlatforms(brand).map((platform) => ({ platform: platform as Copy["platformVariants"][number]["platform"], copy: `${brief} — ${brand.name}` })),
    rationale: "Mock provider.",
  };
}

function mockIdeas(brand: Brand): ContentIdeas {
  return {
    ideas: ["Studio morning ritual", "Material close-up series", "Customer's first week", "Care guide carousel"].map((title, i) => ({
      title,
      platform: (brandPlatforms(brand)[i % brandPlatforms(brand).length] ?? "instagram") as ContentIdeas["ideas"][number]["platform"],
      format: "instagram_post" as const,
      pillar: "Craft & Making",
      objective: "engagement" as const,
      hook: "You've never seen this part of the process.",
      why: "Mock provider idea.",
    })),
  };
}

