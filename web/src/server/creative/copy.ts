import "server-only";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db/client";
import { writeCopy } from "../agents/strategy";
import type { RunScope } from "../agents/orchestrator";
import type { CreativeConcept } from "../agents/schemas";
import type { Brand, Creative } from "../db/schema";
import { remember } from "../memory";
import { UserFacingError } from "../jobs/engine";
import { formatById } from "@/lib/domain";
import { SIMILARITY_LIMIT, findCliches, similarity } from "@/lib/creative-quality";

export type Originality = { cliches: string[]; similar: { text: string; score: number }[]; retried: boolean };
export type CopyPack = {
  primary: string;
  alternatives: string[];
  short: string;
  long: string;
  hooks: string[];
  cta: string;
  hashtags: string[];
  keywords: string[];
  platformVariants: { platform: string; copy: string }[];
  rationale: string;
  platform: string;
  generatedAt: string;
  runId: string | null;
  taskId: string | null;
  editedAt: string | null;
  originality: Originality;
};

/** The brand's recent captions (published/scheduled posts and other creatives' copy), newest first. */
export async function recentCaptions(brandId: string, excludeCreativeId?: string, limit = 60) {
  const db = await getDb();
  const posts = await db
    .select({ caption: schema.posts.caption })
    .from(schema.posts)
    .where(and(eq(schema.posts.brandId, brandId), isNotNull(schema.posts.caption)))
    .orderBy(desc(schema.posts.createdAt))
    .limit(limit);
  const creatives = await db
    .select({ copy: schema.creatives.copy })
    .from(schema.creatives)
    .where(and(eq(schema.creatives.brandId, brandId), isNotNull(schema.creatives.copy), excludeCreativeId ? ne(schema.creatives.id, excludeCreativeId) : undefined))
    .orderBy(desc(schema.creatives.updatedAt))
    .limit(limit);
  return [...posts.map((p) => p.caption ?? ""), ...creatives.map((c) => String((c.copy as { primary?: string } | null)?.primary ?? ""))].filter((t) => t.trim().length > 20);
}

export function checkOriginality(primary: string, others: string[]): Omit<Originality, "retried"> {
  const similar = others
    .map((text) => ({ text: text.slice(0, 160), score: similarity(primary, text) }))
    .filter((x) => x.score >= SIMILARITY_LIMIT)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { cliches: findCliches(primary), similar };
}

/**
 * Copywriter for one creative: a full copy pack for the creative's platform and objective, in
 * the brand voice. The originality guard retries once with feedback when the caption uses
 * clichés or repeats a recent caption, and flags whatever remains.
 */
export async function writeCreativeCopy(scope: RunScope, brand: Brand, creative: Creative) {
  const c = creative.concept as CreativeConcept & { brief?: string; objective?: string | null };
  const platform = formatById(creative.format).platform;
  const slides = creative.kind === "carousel" ? (creative.slides ?? []).map((s, i) => `Slide ${i + 2}: ${s.headline} — ${s.body}`).join("\n") : "";
  const brief = `${c.brief ?? c.title}${slides ? `\nCarousel slides:\n${slides}` : ""}`;
  const others = await recentCaptions(brand.id, creative.id);
  const first = await writeCopy(scope, brand, { brief, platform, objective: c.objective ?? "engagement", creative: { headline: c.headline, subline: c.subline } });
  let data = first.data;
  let runId = first.runId;
  let report = checkOriginality(data.primary, others);
  let retried = false;
  if (report.cliches.length || report.similar.length) {
    retried = true;
    const feedback = [
      report.cliches.length ? `Avoid these clichés: ${report.cliches.join(", ")}.` : "",
      report.similar.length ? `The primary caption is too close to recent captions; take a clearly different angle and wording than: ${report.similar.map((s) => `"${s.text}"`).join(" / ")}.` : "",
    ].join(" ");
    const second = await writeCopy(scope, brand, { brief: `${brief}\n\nRevision note: ${feedback}`, platform, objective: c.objective ?? "engagement", creative: { headline: c.headline, subline: c.subline } });
    data = second.data;
    runId = second.runId;
    report = checkOriginality(data.primary, others);
  }
  const pack: CopyPack = { ...data, platform, generatedAt: new Date().toISOString(), runId, taskId: scope.taskId ?? null, editedAt: null, originality: { ...report, retried } };
  const db = await getDb();
  await db.update(schema.creatives).set({ copy: pack, updatedAt: new Date() }).where(and(eq(schema.creatives.id, creative.id), eq(schema.creatives.brandId, brand.id)));
  return pack;
}

const S = (max: number) => z.string().trim().max(max);
export const CopyEdit = z.object({
  primary: S(2200).min(1),
  alternatives: z.array(S(2200)).max(6),
  short: S(300),
  long: S(2200),
  hooks: z.array(S(200)).max(8),
  cta: S(200),
  hashtags: z.array(z.string().trim().min(1).max(60).transform((h) => h.replace(/^#/, ""))).max(30),
  keywords: z.array(S(60)).max(20),
});

/** User edits to a creative's copy pack (validated; originality re-checked; edits teach brand memory). */
export async function editCreativeCopy(brandId: string, creativeId: string, raw: unknown) {
  const db = await getDb();
  const [cur] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!cur) throw new UserFacingError("Creative not found.");
  const prev = cur.copy as CopyPack | null;
  if (!prev) throw new UserFacingError("Write the copy first.");
  const edit = CopyEdit.parse(raw);
  const report = checkOriginality(edit.primary, await recentCaptions(brandId, creativeId));
  const next: CopyPack = { ...prev, ...edit, editedAt: new Date().toISOString(), originality: { ...report, retried: prev.originality?.retried ?? false } };
  await db.update(schema.creatives).set({ copy: next, updatedAt: new Date() }).where(eq(schema.creatives.id, creativeId));
  if (edit.primary !== prev.primary) {
    await remember(brandId, [{ kind: "feedback", content: `User rewrote a caption. Before: "${prev.primary.slice(0, 200)}" After: "${edit.primary.slice(0, 200)}"`, source: "creative:copy_edit", weight: 1.2 }]).catch(() => {});
  }
  return next;
}
