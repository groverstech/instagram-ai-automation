import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { recall } from "../memory";
import type { Brand } from "../db/schema";
import type { BrandProfile } from "./schemas";

export type BrandContext = {
  brand: Brand;
  profile: BrandProfile | null;
  profileStatus: "approved" | "draft" | "none";
  memories: { kind: string; content: string }[];
};

export async function latestProfile(brandId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.brandProfiles)
    .where(eq(schema.brandProfiles.brandId, brandId))
    .orderBy(desc(schema.brandProfiles.version))
    .limit(5);
  const approved = rows.find((r) => r.status === "approved");
  return { latest: rows[0] ?? null, approved: approved ?? null };
}

/** Assemble the slice of the brand knowledge base an agent needs for a task. */
export async function buildContext(brand: Brand, task: string): Promise<BrandContext> {
  const { latest, approved } = await latestProfile(brand.id);
  const chosen = approved ?? latest;
  const memories = await recall(brand.id, `${task}\n${brand.name} ${brand.industry ?? ""}`, 14);
  return {
    brand,
    profile: (chosen?.data as BrandProfile | undefined) ?? null,
    profileStatus: approved ? "approved" : latest ? "draft" : "none",
    memories: memories.map((m) => ({ kind: m.kind, content: m.content })),
  };
}

/** Render context as a stable, prompt-ready block. Stable ordering keeps it cache-friendly. */
export function renderContext(ctx: BrandContext): string {
  const b = ctx.brand;
  const lines: string[] = [
    `<brand name="${b.name}">`,
    field("Website", b.website),
    field("Industry", [b.industry, b.category].filter(Boolean).join(" / ")),
    field("Products & services", b.products),
    field("Target audience", b.targetAudience),
    field("Geographic market", b.geography),
    field("Positioning (owner's words)", b.positioning),
    field("Personality (owner's words)", b.personality),
    field("Tone of voice (owner's words)", b.tone),
    field("Business objectives", b.objectives.join(", ")),
    field("Marketing goals", b.marketingGoals),
    field("Priority platforms", b.platforms.join(", ")),
    field("Named competitors", b.competitors.join(", ")),
    field("Brand colours", b.colors.join(", ")),
    field("Typography", [b.fonts.heading && `headings: ${b.fonts.heading}`, b.fonts.body && `body: ${b.fonts.body}`].filter(Boolean).join("; ")),
    `</brand>`,
  ];
  if (ctx.profile) {
    lines.push(`<brand_intelligence_profile status="${ctx.profileStatus}">`, JSON.stringify(ctx.profile, null, 1), `</brand_intelligence_profile>`);
  }
  if (ctx.memories.length) {
    lines.push(
      "<brand_memory note=\"learned from approvals, edits, feedback and performance; prefer these over generic best practice\">",
      ...ctx.memories.map((m) => `- [${m.kind}] ${m.content}`),
      "</brand_memory>",
    );
  }
  return lines.filter(Boolean).join("\n");
}

function field(label: string, v: string | null | undefined) {
  return v && v.trim() ? `${label}: ${v.trim()}` : "";
}

export async function recentPerformanceSummary(brandId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      platform: schema.posts.platform,
      pillar: schema.posts.pillar,
      reach: schema.postMetrics.reach,
      engagementRate: schema.postMetrics.engagementRate,
    })
    .from(schema.postMetrics)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.postMetrics.postId))
    .where(and(eq(schema.posts.brandId, brandId), eq(schema.postMetrics.source, "platform")))
    .orderBy(desc(schema.postMetrics.capturedAt))
    .limit(60);
  return rows;
}
