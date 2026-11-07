import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { recall } from "../memory";
import type { Brand } from "../db/schema";
import { readProfile, renderProfileForPrompt, type BrandProfileV2, type SectionStatus } from "@/lib/brand-profile";
import { log } from "../log";

export type BrandContext = {
  brand: Brand;
  profile: BrandProfileV2 | null;
  profileStatus: "approved" | "draft" | "none";
  sectionStatus: SectionStatus;
  /** Standing instructions from the brand; always included, never subject to retrieval ranking. */
  instructions: string[];
  /** Approved reference assets and what was learned from them. */
  assets: { kind: string; name: string; summary: string }[];
  /** Semantically retrieved memories relevant to the task. */
  memories: { kind: string; content: string }[];
};

export async function latestProfile(brandId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.brandProfiles)
    .where(eq(schema.brandProfiles.brandId, brandId))
    .orderBy(desc(schema.brandProfiles.version))
    .limit(10);
  const approved = rows.find((r) => r.status === "approved");
  return { latest: rows[0] ?? null, approved: approved ?? null };
}

/** Parse a stored profile row into v2, or null if it can't be read (logged, never thrown). */
export function profileOf(row: typeof schema.brandProfiles.$inferSelect | null | undefined): BrandProfileV2 | null {
  if (!row) return null;
  try {
    return readProfile(row.data, row.schemaVersion);
  } catch (e) {
    log.warn("profile.unreadable", { profileId: row.id, version: row.version, error: (e as Error).message });
    return null;
  }
}

/** Assemble the slice of the brand knowledge base an agent needs for a task. Always brand-scoped. */
export async function buildContext(brand: Brand, task: string): Promise<BrandContext> {
  const db = await getDb();
  const { latest, approved } = await latestProfile(brand.id);
  const chosen = approved ?? latest;
  const [memories, instructions, assets] = await Promise.all([
    recall(brand.id, `${task}\n${brand.name} ${brand.industry ?? ""}`, 14),
    db
      .select({ content: schema.brandMemories.content })
      .from(schema.brandMemories)
      .where(and(eq(schema.brandMemories.brandId, brand.id), eq(schema.brandMemories.kind, "instruction")))
      .orderBy(desc(schema.brandMemories.createdAt))
      .limit(30),
    db
      .select({ kind: schema.brandAssets.kind, name: schema.brandAssets.name, analysis: schema.brandAssets.analysis })
      .from(schema.brandAssets)
      .where(and(eq(schema.brandAssets.brandId, brand.id), eq(schema.brandAssets.status, "approved")))
      .orderBy(desc(schema.brandAssets.createdAt))
      .limit(12),
  ]);
  return {
    brand,
    profile: profileOf(chosen),
    profileStatus: approved ? "approved" : latest ? "draft" : "none",
    sectionStatus: (chosen?.sectionStatus ?? {}) as SectionStatus,
    instructions: instructions.map((i) => i.content),
    assets: assets.map((a) => ({
      kind: a.kind,
      name: a.name,
      summary: a.analysis ? [a.analysis.description, a.analysis.aesthetic].filter(Boolean).join(" — ") : "",
    })),
    memories: memories.filter((m) => m.kind !== "instruction").map((m) => ({ kind: m.kind, content: m.content })),
  };
}

/** Render context as a stable, prompt-ready block. Stable ordering keeps it cache-friendly. */
export function renderContext(ctx: BrandContext): string {
  const b = ctx.brand;
  const lines: string[] = [
    `<brand name="${b.name}">`,
    field("Website", b.website),
    field("Business description", b.description),
    field("Industry", [b.industry, b.category].filter(Boolean).join(" / ")),
    field("Products & services", b.products),
    field("Target audience", b.targetAudience),
    field("Geographic markets", b.geography),
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
  if (ctx.instructions.length) {
    lines.push(
      `<brand_instructions note="standing rules from the brand; always follow them">`,
      ...ctx.instructions.map((i) => `- ${i}`),
      `</brand_instructions>`,
    );
  }
  if (ctx.profile) {
    lines.push(
      `<brand_intelligence_profile status="${ctx.profileStatus}" note="items marked [unconfirmed AI suggestion] are tentative; prefer confirmed facts and the owner's own words">`,
      renderProfileForPrompt(ctx.profile, ctx.sectionStatus),
      `</brand_intelligence_profile>`,
    );
  }
  if (ctx.assets.length) {
    lines.push(`<approved_brand_assets>`, ...ctx.assets.map((a) => `- ${a.kind} "${a.name}"${a.summary ? `: ${a.summary}` : ""}`), `</approved_brand_assets>`);
  }
  if (ctx.memories.length) {
    lines.push(
      `<brand_memory note="learned from approvals, edits, feedback and performance; prefer these over generic best practice">`,
      ...ctx.memories.map((m) => `- [${m.kind}] ${m.content}`),
      `</brand_memory>`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

function field(label: string, v: string | null | undefined) {
  return v && v.trim() ? `${label}: ${v.trim()}` : "";
}

export async function recentPerformanceSummary(brandId: string) {
  const db = await getDb();
  return db
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
}
